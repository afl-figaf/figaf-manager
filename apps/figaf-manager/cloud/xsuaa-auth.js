"use strict";
// figaf-manager v2 XSUAA auth module.
//
// When the operator has run the in-wizard XSUAA upgrade (see auth-gate-
// implementation-plan.md §2), figaf-manager is bound to the figaf-manager-xsuaa
// service instance, and ALL inbound traffic flows through the wizard-scoped
// approuter (packages/manager-approuter). The approuter handles the IAS
// redirect dance, validates the IdP cookie, and forwards each request to
// figaf-manager with an Authorization: Bearer <jwt> header.
//
// This module's job:
//   1. Detect at boot whether XSUAA mode is active (VCAP_SERVICES has a
//      bound xsuaa service).
//   2. Provide an Express middleware that validates the JWT, enforces the
//      FigafManagerOperator scope, and rejects with 401/403 otherwise.
//   3. Provide a parallel WS-upgrade validator that returns a structured
//      result for the upgrade handler in server.js to act on (close code
//      4003 for missing/bad cookie/JWT, 4004 for "JWT valid but scope
//      missing" — distinguishes the client redirect target: 4004 means
//      "you authenticated but don't have the role" → keep on / so the
//      operator sees a 403 page, not a re-login loop).
//
// Test seam: __setVerifier() lets server.test.js inject a synthetic verifier
// without needing a real xsuaa binding. The real path is gated behind
// isXsuaaActive() so the tests can drive both branches deterministically.

const crypto = require("crypto");
// One XSUAA instance for the manager and the apps (figaf-platform decision 0009):
// the shared instance (xsappname figaf-faid, scope FAIDManagerOperator)
// is the rule for new installations; the legacy instance (xsappname
// figaf-manager-xsuaa, scope FigafManagerOperator) keeps working for Alex's
// shipped installations. The bound xsappname decides which scope is checked.
const { isSharedXsappname, isLegacyXsappname, operatorScopeName } = require("@figaf/core/manager-xsuaa");

// ─── Boot-time detection ───────────────────────────────────────────────────

/**
 * Parse VCAP_SERVICES (CF-style JSON env var) and return the first xsuaa
 * service binding, or null. We intentionally do not require @sap/xsenv here:
 * the env-var format is simple, and avoiding xsenv keeps this module testable
 * with a fake VCAP_SERVICES string.
 */
function findXsuaaBinding(envVcap) {
  const raw = envVcap || process.env.VCAP_SERVICES;
  if (!raw) return null;
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return null; }
  const x = parsed && parsed.xsuaa;
  if (!Array.isArray(x) || x.length === 0) return null;
  // If more than one xsuaa is bound, prefer the shared instance, then the
  // legacy one; otherwise take the first.
  const shared = x.find((b) => b && b.credentials && isSharedXsappname(b.credentials.xsappname));
  const legacy = x.find((b) => b && b.credentials && isLegacyXsappname(b.credentials.xsappname));
  return shared || legacy || x[0];
}

function isXsuaaActive() {
  return findXsuaaBinding() !== null;
}

// The required scope for the manager. Constructed from xsappname at validation
// time so it's tied to the actual bound service, not a hardcoded string:
// shared instance -> <xsappname>.FAIDManagerOperator, legacy ->
// <xsappname>.FigafManagerOperator.
function operatorScopeFor(binding) {
  const app = (binding && binding.credentials && binding.credentials.xsappname) || "figaf-manager-xsuaa";
  return app + "." + operatorScopeName(app);
}

// ─── Verifier indirection (test seam) ──────────────────────────────────────

let _verifierImpl = null;

function defaultVerifier(binding) {
  // Lazily require @sap/xssec so this module is loadable in test contexts
  // where xssec isn't installed (e.g., the v1-only test matrix).
  let xssec;
  try { xssec = require("@sap/xssec"); }
  catch (e) {
    // If we're in XSUAA mode but xssec isn't available, fail closed.
    return function () {
      return Promise.resolve({ ok: false, code: "NO_XSSEC", reason: "@sap/xssec module unavailable" });
    };
  }

  // @sap/xssec v4 dropped the v3 callback API:
  //   v3: xssec.createSecurityContext(jwt, credentials, cb)
  //   v4: await xssec.createSecurityContext(service, { token: jwt })
  // Build the XsuaaService once at boot so we don't re-parse credentials on
  // every request. Construction failure (bad credentials) is a fail-closed
  // verifier — any subsequent verify() returns NO_XSSEC rather than crashing.
  let service;
  try {
    service = new xssec.XsuaaService(binding.credentials);
  } catch (e) {
    return function () {
      return Promise.resolve({ ok: false, code: "NO_XSSEC", reason: "XsuaaService init failed: " + (e && e.message) });
    };
  }

  return async function verify(jwt) {
    let ctx;
    try {
      ctx = await xssec.createSecurityContext(service, { token: jwt });
    } catch (e) {
      // Any v4 error (MissingJwtError, InvalidJwtError, NetworkError, etc.)
      // lands here. We collapse to INVALID rather than crashing the process.
      return { ok: false, code: "INVALID", reason: e && e.message ? e.message : "createSecurityContext failed" };
    }
    if (!ctx) {
      return { ok: false, code: "INVALID", reason: "createSecurityContext returned no context" };
    }
    try {
      // ctx.checkLocalScope(name) — name is appended to xsappname. The scope
      // name follows the bound instance (shared vs legacy, decision 0009).
      const scope = operatorScopeName(binding.credentials.xsappname);
      if (!ctx.checkLocalScope(scope)) {
        return { ok: false, code: "NO_SCOPE", reason: `missing ${scope} scope` };
      }
    } catch (e) {
      return { ok: false, code: "INVALID", reason: e.message };
    }
    // Extract identity for audit/log lines. None of these are trusted
    // beyond the JWT itself — they're convenience accessors only.
    let user = null;
    try { user = ctx.getLogonName ? ctx.getLogonName() : null; } catch {}
    let email = null;
    try { email = ctx.getEmail ? ctx.getEmail() : null; } catch {}
    return { ok: true, user, email, ctx };
  };
}

/**
 * Build (and cache) the verifier function bound to the current xsuaa
 * binding. If isXsuaaActive() is false, returns a fail-closed verifier.
 */
function getVerifier() {
  if (_verifierImpl) return _verifierImpl;
  const binding = findXsuaaBinding();
  if (!binding) {
    _verifierImpl = function () {
      return Promise.resolve({ ok: false, code: "NO_XSUAA_BINDING", reason: "VCAP_SERVICES has no xsuaa binding" });
    };
    return _verifierImpl;
  }
  _verifierImpl = defaultVerifier(binding);
  return _verifierImpl;
}

/** Test seam — replace the verifier with an arbitrary async function. */
function __setVerifier(fn) {
  _verifierImpl = typeof fn === "function" ? fn : null;
}

/** Test seam — reset cached verifier so the next call re-derives from env. */
function __resetForTests() {
  _verifierImpl = null;
}

// ─── JWT extraction helpers ────────────────────────────────────────────────

/**
 * Pull the JWT out of an inbound request. Approuter forwards the validated
 * user JWT via `Authorization: Bearer <jwt>` by default. We additionally
 * accept an `x-jwt` header as a fallback for the WS-upgrade path, in case
 * a future approuter version drops Authorization on websocket upgrades.
 */
function extractJwt(req) {
  const h = req && req.headers;
  if (!h) return null;
  const auth = h["authorization"] || h["Authorization"];
  if (typeof auth === "string") {
    const m = /^Bearer\s+(\S+)$/i.exec(auth);
    if (m) return m[1];
  }
  const xj = h["x-jwt"];
  if (typeof xj === "string" && xj.length > 0) return xj;
  return null;
}

// ─── HTTP middleware (replaces v1 requireAuth when XSUAA active) ───────────

function requireJwt(req, res, next) {
  const jwt = extractJwt(req);
  if (!jwt) {
    res.status(401).json({ ok: false, error: "unauthenticated", reason: "no-jwt" });
    return;
  }
  const verify = getVerifier();
  verify(jwt).then((r) => {
    if (r.ok) {
      // Stash a minimal identity for downstream handlers (audit logs etc).
      req.figafUser = { name: r.user || null, email: r.email || null };
      return next();
    }
    if (r.code === "NO_SCOPE") {
      res.status(403).json({ ok: false, error: "forbidden", reason: r.reason });
      return;
    }
    res.status(401).json({ ok: false, error: "unauthenticated", reason: r.reason || r.code });
  }).catch((e) => {
    res.status(500).json({ ok: false, error: "auth-internal", reason: e && e.message });
  });
}

// ─── WS-upgrade authentication ─────────────────────────────────────────────

/**
 * Returns a promise resolving to { ok, code, reason, user, email }.
 * The caller (server.js upgrade handler) decides whether to respond with
 * HTTP 401 (pre-upgrade) or close the socket with code 4003/4004.
 *
 * Distinguishing codes (per §2.7 reconciliation row 11):
 *   - 4003: "no/invalid JWT" — client should send the user back to the
 *           approuter root (/) which will trigger an IAS re-login.
 *   - 4004: "JWT valid but missing scope" — client should land on a 403
 *           page; re-login won't help.
 */
function verifyWsUpgrade(req) {
  const jwt = extractJwt(req);
  if (!jwt) {
    return Promise.resolve({ ok: false, code: "NO_JWT", wsClose: 4003 });
  }
  return getVerifier()(jwt).then((r) => {
    if (r.ok) return { ok: true, user: r.user || null, email: r.email || null };
    if (r.code === "NO_SCOPE") return { ok: false, code: "NO_SCOPE", wsClose: 4004, reason: r.reason };
    return { ok: false, code: r.code || "INVALID", wsClose: 4003, reason: r.reason };
  });
}

// ─── Exports ───────────────────────────────────────────────────────────────

module.exports = {
  isXsuaaActive,
  findXsuaaBinding,
  operatorScopeFor,
  extractJwt,
  requireJwt,
  verifyWsUpgrade,

  // Test seams (do not call from server.js)
  __setVerifier,
  __resetForTests,
};
