"use strict";
// figaf-manager v1 auth-gate module.
//
// Two layered mechanisms (see auth-gate-implementation-plan.md §1.1.4):
//   A. cockpit-log setup token — minted at boot, printed once to stdout,
//      consumed once by the operator via /setup/claim.
//   B. signed session cookie — issued by /setup/claim, carries no PII; the
//      cookie's HMAC binds it to the original claiming IP + UA-hash, both
//      of which are recomputed server-side on every request (never stored
//      in the cookie itself).
//
// State is in-memory only. CF restart = fresh token = expected re-claim
// (FIGAF_AUTH_SECRET=per-boot-random by default; cookies do not survive
// restart unless the operator pins FIGAF_AUTH_SECRET in the manifest).

const crypto = require("crypto");

// ─── v2 mode-switch guard ──────────────────────────────────────────────────
// Defense in depth: if VCAP_SERVICES contains an xsuaa binding at module
// init, the wizard is in XSUAA mode and v1 token-gate paths must never
// accept a cookie or mint a token. server.js is responsible for swapping
// the middleware function pointer (see XSUAA_ACTIVE), but a forgotten code
// path calling verifyAuth() / generateSetupToken() in XSUAA mode would
// silently succeed and create a parallel auth surface. We fail closed here.
//
// Computed once at require()-time. Changes to VCAP_SERVICES after boot are
// not supported — the restage that creates the binding is the seam.
function _detectXsuaaAtInit() {
  const raw = process.env.VCAP_SERVICES;
  if (!raw) return false;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed && parsed.xsuaa) && parsed.xsuaa.length > 0;
  } catch { return false; }
}
const _xsuaaModeAtInit = _detectXsuaaAtInit();

// ─── Module-scoped state (single process lifetime) ─────────────────────────

const authState = {
  setupTokenHash: null,   // 32-byte Buffer (SHA-256 of cleartext token); wiped after claim
  claimed: false,
  claimedAt: null,        // epoch ms
  claimantIp: null,       // audit only, not used for re-validation
};

// Cookie-signing key. Per the plan's §1.3.4, default is per-boot random.
// Operators who want sessions to survive restarts set FIGAF_AUTH_SECRET in
// the manifest; otherwise the warning line below is emitted (caller logs it).
const _explicitSecret = process.env.FIGAF_AUTH_SECRET || "";
const _secret = _explicitSecret
  ? Buffer.from(_explicitSecret, "utf8")
  : crypto.randomBytes(32);
const _secretIsEphemeral = !_explicitSecret;

// Cookie + token tuning.
const COOKIE_NAME = "figaf_auth";
const COOKIE_MAX_AGE_SECONDS = 8 * 60 * 60; // 8 hours
const TOKEN_BYTES = 24;                     // → 32 base64url chars → 192 bits entropy
const COOKIE_VERSION = "v1";

// ─── Test seam: clock injection ────────────────────────────────────────────

let _now = () => Date.now();
function __setNow(fn) {
  _now = typeof fn === "function" ? fn : () => Date.now();
}

// ─── Test seam: state reset (for the test runner only) ─────────────────────

function __resetForTests() {
  authState.setupTokenHash = null;
  authState.minted = false;
  authState.claimed = false;
  authState.claimedAt = null;
  authState.claimantIp = null;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function toBase64Url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest();
}

function hashUserAgent(ua) {
  // Short UA fingerprint; we never log the raw UA from this module.
  return sha256(Buffer.from(String(ua || ""), "utf8")).toString("hex").slice(0, 16);
}

function constantTimeEquals(a, b) {
  if (!Buffer.isBuffer(a) || !Buffer.isBuffer(b)) return false;
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ─── 1. Token lifecycle ────────────────────────────────────────────────────

/**
 * Mint a fresh setup token. Stores SHA-256(token) in module state and returns
 * the cleartext to the caller — which MUST be the only caller (server.js boot).
 * Calling generateSetupToken() twice in one process replaces the stored hash;
 * we expose this for test resets but rely on policy at the call site.
 */
function generateSetupToken() {
  // v2 defense: callers in XSUAA mode should never request a fresh token.
  // We throw instead of silently returning a bogus value so a mistake
  // surfaces loudly during testing rather than producing a token that
  // can't actually authenticate anything.
  if (_xsuaaModeAtInit) {
    throw new Error("generateSetupToken called in XSUAA mode (token gate is dormant)");
  }
  const cleartext = toBase64Url(crypto.randomBytes(TOKEN_BYTES));
  authState.setupTokenHash = sha256(Buffer.from(cleartext, "utf8"));
  authState.minted = true;
  authState.claimed = false;
  authState.claimedAt = null;
  authState.claimantIp = null;
  return cleartext;
}

/** Build the single [SETUP]-tagged boot line. Allow-prefix in redact() protects this. */
function formatSetupLogLine(token) {
  const route = process.env.CF_APP_URI || process.env.FIGAF_PUBLIC_URL || "";
  const where = route
    ? ` — visit https://${route.replace(/^https?:\/\//, "")}/setup within 30 minutes to claim.`
    : " — visit https://<this-app-route>/setup within 30 minutes to claim.";
  return (
    "[SETUP] Token: " + token + where +
    " This token is single-use and will not appear in logs again."
  );
}

/**
 * Constant-time verify a submitted token against the stored hash. Returns
 *   { ok: true }                              on match
 *   { ok: false, code: "ALREADY_CLAIMED" }    if a prior claim succeeded
 *   { ok: false, code: "NO_TOKEN" }           if the hash has been wiped (e.g., after claim)
 *   { ok: false, code: "INVALID" }            on mismatch
 */
function verifySetupToken(submitted) {
  if (authState.claimed) return { ok: false, code: "ALREADY_CLAIMED" };
  if (!authState.setupTokenHash) return { ok: false, code: "NO_TOKEN" };
  if (typeof submitted !== "string" || submitted.length === 0) {
    return { ok: false, code: "INVALID" };
  }
  const submittedHash = sha256(Buffer.from(submitted, "utf8"));
  if (!constantTimeEquals(submittedHash, authState.setupTokenHash)) {
    return { ok: false, code: "INVALID" };
  }
  return { ok: true };
}

/** Mark token consumed, wipe hash, stamp audit fields. Idempotent only inasmuch as the hash is gone. */
function recordClaim({ ip, ua }) {
  authState.claimed = true;
  authState.claimedAt = _now();
  authState.claimantIp = ip || null;
  authState.setupTokenHash = null;
  // ua intentionally not stored — we only use a fresh per-request hash for cookie binding.
  return { claimedAt: authState.claimedAt };
}

function isClaimed() {
  return authState.claimed === true;
}

/**
 * True once this process minted a setup token, i.e. the [SETUP] line was
 * printed at boot. Survives the claim (the hash is wiped, this flag is not).
 * Exposed on /health so an operator can tell "the logs lost the line" from
 * "the app never started" - never the token itself.
 */
function isMinted() {
  return authState.minted === true;
}

// ─── 2. Cookie sign/verify ─────────────────────────────────────────────────

/**
 * Build the cookie value: `v1.<hex-mac>.<iat-seconds>`.
 * MAC = HMAC-SHA256 over `<iat>|<ip>|<ua-hash>` keyed by FIGAF_AUTH_SECRET.
 * Neither IP nor UA-hash appears in the cookie — recomputed per request.
 */
function signSession({ ip, ua, iat }) {
  const iatSec = Number.isFinite(iat) ? iat : Math.floor(_now() / 1000);
  const uaHash = hashUserAgent(ua);
  const mac = crypto.createHmac("sha256", _secret)
    .update(String(iatSec) + "|" + String(ip || "") + "|" + uaHash)
    .digest("hex");
  return COOKIE_VERSION + "." + mac + "." + String(iatSec);
}

/** Parse and shape-validate a raw `figaf_auth` cookie value. Returns null on any structural problem. */
function parseAuthCookie(cookieHeader) {
  if (typeof cookieHeader !== "string" || cookieHeader.length === 0) return null;
  // cookieHeader is either the raw "figaf_auth=..." extracted from a Cookie header,
  // or the cookie value itself. We accept both for flexibility.
  let raw = cookieHeader;
  if (raw.indexOf("=") !== -1 && raw.indexOf(COOKIE_NAME + "=") !== -1) {
    // Caller passed a full Cookie header; extract our cookie.
    const cookies = parseCookieHeader(raw);
    raw = cookies[COOKIE_NAME] || "";
    if (!raw) return null;
  }
  const parts = raw.split(".");
  if (parts.length !== 3) return null;
  const [v, mac, iatStr] = parts;
  if (v !== COOKIE_VERSION) return null;
  if (!/^[0-9a-f]{64}$/.test(mac)) return null;
  if (!/^[0-9]+$/.test(iatStr)) return null;
  const iat = parseInt(iatStr, 10);
  if (!Number.isFinite(iat) || iat < 0) return null;
  return { v, mac, iat };
}

/** Lightweight Cookie-header parser (avoids pulling in a dep). */
function parseCookieHeader(header) {
  const out = {};
  if (typeof header !== "string" || header.length === 0) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    let v = part.slice(eq + 1).trim();
    try { v = decodeURIComponent(v); } catch { /* leave as-is */ }
    out[k] = v;
  }
  return out;
}

/**
 * Verify a request's auth state.
 *   - extracts cookie
 *   - recomputes MAC against this request's IP + UA-hash
 *   - constant-time compares
 *   - rejects on expiry (now - iat > COOKIE_MAX_AGE_SECONDS)
 * Returns { ok: true } or { ok: false, reason }.
 */
function verifyAuth(req) {
  // v2 defense: under XSUAA mode the v1 cookie is meaningless. If something
  // calls into verifyAuth(), fail closed so we never accept a stale v1 cookie
  // that was minted before the upgrade.
  if (_xsuaaModeAtInit) return { ok: false, reason: "XSUAA_MODE_ACTIVE" };
  const cookies = parseCookieHeader(req && req.headers && req.headers.cookie);
  const raw = cookies[COOKIE_NAME];
  if (!raw) return { ok: false, reason: "NO_COOKIE" };
  const parsed = parseAuthCookie(raw);
  if (!parsed) return { ok: false, reason: "MALFORMED" };

  const ip = clientIp(req);
  const ua = req && req.headers && req.headers["user-agent"];
  const expectedMac = crypto.createHmac("sha256", _secret)
    .update(String(parsed.iat) + "|" + String(ip || "") + "|" + hashUserAgent(ua))
    .digest("hex");
  if (expectedMac.length !== parsed.mac.length) return { ok: false, reason: "BAD_MAC" };
  if (!constantTimeEquals(Buffer.from(expectedMac, "hex"), Buffer.from(parsed.mac, "hex"))) {
    return { ok: false, reason: "BAD_MAC" };
  }
  const nowSec = Math.floor(_now() / 1000);
  if (nowSec - parsed.iat > COOKIE_MAX_AGE_SECONDS) return { ok: false, reason: "EXPIRED" };
  if (parsed.iat - nowSec > 60) return { ok: false, reason: "FUTURE" }; // clock-skew sanity
  return { ok: true, iat: parsed.iat };
}

/**
 * Centralized client-IP resolution. CF GoRouter terminates TLS and sets
 * X-Forwarded-For with the public client IP as the first value. Falls back
 * to req.socket.remoteAddress (e.g., in tests, or when behind no proxy).
 * Risk R2 in the plan — all auth paths MUST go through this.
 */
function clientIp(req) {
  const fwd = req && req.headers && req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length > 0) {
    const first = fwd.split(",")[0].trim();
    if (first) return first;
  }
  if (req && req.socket && req.socket.remoteAddress) return req.socket.remoteAddress;
  if (req && req.connection && req.connection.remoteAddress) return req.connection.remoteAddress;
  return "";
}

/**
 * Set the auth cookie on a response. Attributes:
 *   HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=28800
 * In non-production (e.g., test env), Secure is omitted so test agents over
 * http:// can still round-trip the cookie.
 */
function issueCookie(res, { ip, ua }) {
  const value = signSession({ ip, ua, iat: Math.floor(_now() / 1000) });
  const attrs = [
    COOKIE_NAME + "=" + value,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    "Max-Age=" + COOKIE_MAX_AGE_SECONDS,
  ];
  if (process.env.NODE_ENV === "production") attrs.push("Secure");
  // Preserve any prior Set-Cookie headers (e.g., the session-id cookie).
  const existing = res.getHeader && res.getHeader("Set-Cookie");
  if (existing) {
    const merged = Array.isArray(existing) ? existing.slice() : [String(existing)];
    merged.push(attrs.join("; "));
    res.setHeader("Set-Cookie", merged);
  } else {
    res.setHeader("Set-Cookie", attrs.join("; "));
  }
}

/**
 * Redaction helper used by server.js to scrub orchestrator output before it
 * fans out over the cli:line WebSocket channel. The [SETUP] allow-prefix is
 * load-bearing: without it, the boot log line's token would be munged before
 * the operator could copy it from the cockpit Logs view.
 */
function redact(line) {
  if (typeof line !== "string") return line;
  if (line.startsWith("[SETUP]")) return line;
  // A minted token is base64url of random bytes: it has uppercase letters
  // (the chance of none in 32 characters is below 1e-7). A kebab-case name
  // such as the CF app `figaf-faid-apps-b2b-archiving-setup` (35 characters)
  // or a GUID has hyphens and no uppercase letter: not a secret, and hiding
  // it made the terminal drawer unreadable (found 2026-09-08 by the install
  // smoke). Everything else in the token shape is still hidden. The
  // lookarounds replace \b: a token that starts or ends with "-" has no word
  // boundary there, and the old rule let about 3 % of minted tokens through.
  return line.replace(/(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{32,44}(?![A-Za-z0-9_-])/g, (m) => (m.includes("-") && !/[A-Z]/.test(m) ? m : "[redacted]"));
}

// ─── Exports ───────────────────────────────────────────────────────────────

module.exports = {
  // Token lifecycle
  generateSetupToken,
  formatSetupLogLine,
  verifySetupToken,
  recordClaim,
  isClaimed,
  isMinted,

  // Per-request auth
  verifyAuth,
  clientIp,
  parseAuthCookie,
  signSession,
  issueCookie,

  // Redaction
  redact,

  // Constants useful at the wiring layer
  COOKIE_NAME,
  COOKIE_MAX_AGE_SECONDS,

  // Whether the cookie secret is per-boot random (caller logs the warning line)
  secretIsEphemeral: _secretIsEphemeral,

  // Test seams
  __setNow,
  __resetForTests,
  // Exposed for the test suite only; do not use from server.js.
  __authState: authState,
  __xsuaaModeAtInit: _xsuaaModeAtInit,
};
