"use strict";
const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const { createOrchestrator, DEPLOYMENT_ZIP_URL, createAuditLogger } = require("@figaf/core");
const { createHost } = require("../host.cloud");
const auth = require("./auth");
// v2: XSUAA mode-switch (auth-gate-implementation-plan.md §2.7).
// Selected once at boot based on whether VCAP_SERVICES contains an xsuaa
// binding; never per-request. The restage that creates that binding is the
// seam — there is no live mode-switching within a single process lifetime.
const xsuaa = require("./xsuaa-auth");
const XSUAA_ACTIVE = xsuaa.isXsuaaActive();

// Installer version — read once at boot from the manager's package.json (CI
// stamps it from the release tag). Injected into the page so the renderer
// displays it instantly, with no dependency on the self-update network check.
const APP_VERSION = (() => {
  try { return require("../package.json").version || null; } catch { return null; }
})();

const PORT = process.env.PORT || 8080;
// Random per-boot secret — all sessions invalidate on container restart (acceptable for wizard use-case).
const SESSION_SECRET = crypto.randomBytes(32).toString("hex");
const SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour idle expiry

// ─── Audit log ─────────────────────────────────────────────────────────────
// JSON Lines to stdout; CF's log drain captures it alongside [SETUP] / [INFO]
// boot lines. FIGAF_LOG_LEVEL (set in manifest.yml) controls verbosity:
//   off | cli (default) | ipc | net
// FIGAF_LOG_TAIL_BYTES — override the per-side stdout/stderr cap (default 2 KB).
//
// This is the parent logger; per-session loggers stamp sessionId via
// withContext() in newSession(). User identity is stamped per RPC because
// state.user is only populated after `cf login`, not at session creation.
const auditParent = createAuditLogger({
  level: process.env.FIGAF_LOG_LEVEL || "cli",
  tailBytes: Number(process.env.FIGAF_LOG_TAIL_BYTES) || undefined,
  sink: (line) => process.stdout.write(line + "\n"),
});

// ─── Session store ─────────────────────────────────────────────────────────────

const sessions = new Map(); // sessionId → { handlers, dispose, wsClients, lastSeen }

function newSession(sessionId) {
  const wsClients = new Set();

  function send(channel, payload) {
    // Defensive downstream redaction layer (auth-gate plan §1.4).
    // cli:line text is scrubbed for base64url-shaped tokens before fan-out.
    // The boot [SETUP] line is printed via console.log (not cli:line), so the
    // operator's only copy of the token never crosses this seam — this is
    // belt-and-braces in case future orchestrator code accidentally echoes it.
    let outPayload = payload;
    if (channel === "cli:line" && payload && typeof payload.text === "string") {
      const redacted = auth.redact(payload.text);
      if (redacted !== payload.text) {
        outPayload = Object.assign({}, payload, { text: redacted });
      }
    }
    const frame = JSON.stringify({ channel, payload: outPayload });
    for (const ws of wsClients) {
      if (ws.readyState === 1 /* OPEN */) ws.send(frame);
    }
  }

  const host = createHost({ sessionId });
  const audit = auditParent.withContext({ sessionId });
  const { handlers, dispose } = createOrchestrator({ host, send, audit });
  const sess = { handlers, dispose, wsClients, lastSeen: Date.now(), audit };
  sessions.set(sessionId, sess);
  return sess;
}

function getOrCreateSession(sessionId) {
  let sess = sessions.get(sessionId);
  if (sess) { sess.lastSeen = Date.now(); return sess; }
  return newSession(sessionId);
}

// Prune idle sessions every 5 minutes
setInterval(() => {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [id, sess] of sessions) {
    if (sess.lastSeen < cutoff) {
      try { sess.dispose(); } catch {}
      sessions.delete(id);
    }
  }
}, 5 * 60 * 1000).unref();

// ─── Signed-cookie helpers ─────────────────────────────────────────────────────
// Mirrors the cookie-signature package (used by cookie-parser) so we can verify
// signed cookies in the WS upgrade handler where middleware doesn't run.

function signCookieValue(val) {
  const mac = crypto
    .createHmac("sha256", SESSION_SECRET)
    .update(val)
    .digest("base64")
    .replace(/=+$/, "");
  return "s:" + val + "." + mac;
}

function unsignCookieValue(signed) {
  if (!signed || !signed.startsWith("s:")) return null;
  const inner = signed.slice(2);
  const dot = inner.lastIndexOf(".");
  if (dot === -1) return null;
  const val = inner.slice(0, dot);
  const mac = inner.slice(dot + 1);
  const expected = crypto
    .createHmac("sha256", SESSION_SECRET)
    .update(val)
    .digest("base64")
    .replace(/=+$/, "");
  if (mac.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  return val;
}

function parseCookieHeader(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

function sessionIdFromReq(req) {
  const cookies = parseCookieHeader(req.headers.cookie);
  const raw = cookies["figaf_session"];
  if (!raw) return null;
  return unsignCookieValue(raw);
}

// ─── Session middleware ────────────────────────────────────────────────────────

function sessionMiddleware(req, res, next) {
  let sessionId = sessionIdFromReq(req);
  if (!sessionId) {
    sessionId = crypto.randomBytes(16).toString("hex");
    const cookieVal = encodeURIComponent(signCookieValue(sessionId));
    const attrs = [
      `figaf_session=${cookieVal}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Lax",
      `Max-Age=${4 * 60 * 60}`,
    ];
    if (process.env.NODE_ENV === "production") attrs.push("Secure");
    res.setHeader("Set-Cookie", attrs.join("; "));
  }
  req.sessionId = sessionId;
  next();
}

// ─── Auth gate ─────────────────────────────────────────────────────────────
// Two middlewares, one selected once at boot.
//
//   v1 (token cookie): verifies the signed figaf_auth cookie via auth.js.
//      On failure, browser-style GETs 302→/setup; RPC gets 401 JSON.
//
//   v2 (XSUAA):        verifies the Authorization: Bearer JWT forwarded by
//      the approuter via xsuaa-auth.js. 401 on missing/invalid, 403 on
//      valid-but-missing-scope. The approuter handles the IAS login flow,
//      so we do not need a 302 fallback here.
//
// See auth-gate-implementation-plan.md §2.7.

function requireAuthV1(req, res, next) {
  const v = auth.verifyAuth(req);
  if (v.ok) return next();
  // Browser-style HTML GETs (anything except /rpc/* and not XHR) get a 302
  // redirect to /setup so the operator lands on the claim page. RPC clients
  // get a structured 401 they can react to.
  const isRpc = req.path.startsWith("/rpc/");
  const accept = String(req.headers["accept"] || "");
  const wantsHtml = !isRpc && (req.method === "GET") && (accept.includes("text/html") || accept === "" || accept.includes("*/*"));
  if (wantsHtml) {
    res.redirect(302, "/setup");
    return;
  }
  res.status(401).json({ ok: false, error: "unauthenticated", reason: v.reason });
}

// Pointer swap. Both apps' bridge calls go through this single name.
const requireAuth = XSUAA_ACTIVE ? xsuaa.requireJwt : requireAuthV1;

// ─── Express app ──────────────────────────────────────────────────────────────

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(sessionMiddleware);

// Shared renderer lives in @figaf/ui (resolved through the workspace symlink in
// node_modules); we keep the public URL prefix /installer so the cloud-mode
// index.html template doesn't need to change.
const installerDir = path.dirname(require.resolve("@figaf/ui/package.json"));

// Static (ungated): installer UI assets (JSX, CSS) — public source code, no
// secrets. Gating them adds friction (Babel-standalone fetches mode.js before
// the auth cookie is set during the post-claim navigation) without security
// benefit.
app.use("/installer", express.static(installerDir));

// Static (ungated): logo
app.get("/figaf-logo.png", (_req, res) => res.sendFile(path.join(installerDir, "figaf-logo.png")));
app.get("/saml-trust-cockpit.png", (_req, res) => res.sendFile(path.join(installerDir, "saml-trust-cockpit.png")));

// Static (ungated): browser shim
app.get("/cloud/client.js", (_req, res) => {
  res.setHeader("Content-Type", "application/javascript; charset=utf-8");
  res.sendFile(path.join(__dirname, "client.js"));
});

// ─── /setup (ungated) ───────────────────────────────────────────────────────
// Operator-facing claim flow. The page is intentionally vanilla HTML; no React,
// no module imports, so it cannot be locked out by the same kind of failure
// that would lock the wizard out.

app.get("/setup", (req, res) => {
  // v2: under XSUAA the token-claim page is dormant AND actively harmful — a
  // stale pre-upgrade tab whose client.js still has xsuaaMode=false will
  // redirect the browser here on any auth-kick (see cloud/client.js line 44),
  // and post-IAS the operator lands on a setup-token prompt they cannot
  // satisfy (the secret hash was wiped at first claim; the POST returns 410).
  //
  // The approuter's catch-all xsuaa route already enforced auth+scope before
  // this handler ran, so an unauthenticated browser cannot reach here under
  // XSUAA — no IAS-loop risk. Bounce to / unconditionally; the wizard root
  // will render with figafXsuaaMode=true and the operator picks up where the
  // upgrade flow left off.
  if (XSUAA_ACTIVE) {
    res.redirect(302, "/");
    return;
  }
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.sendFile(path.join(__dirname, "setup.html"));
});

app.post("/setup/claim", (req, res) => {
  // v2: claim is permanently closed once the wizard is in XSUAA mode (§2.7).
  if (XSUAA_ACTIVE) {
    return res.status(410).json({ ok: false, error: "xsuaa_mode_active" });
  }
  const submitted = (req.body && typeof req.body.token === "string") ? req.body.token.trim() : "";
  const v = auth.verifySetupToken(submitted);
  if (!v.ok) {
    if (v.code === "ALREADY_CLAIMED" || v.code === "NO_TOKEN") {
      // NO_TOKEN here means "hash already wiped post-claim" → semantically Gone.
      return res.status(410).json({ ok: false, error: "already_claimed" });
    }
    return res.status(401).json({ ok: false, error: "invalid_token" });
  }
  const ip = auth.clientIp(req);
  const ua = req.headers["user-agent"] || "";
  auth.recordClaim({ ip, ua });
  // Audit line: token is gone from memory; mark the log boundary.
  console.log("[SETUP] Token redacted post-claim");
  auth.issueCookie(res, { ip, ua });
  res.status(200).json({ ok: true, redirect: "/" });
});

// /health — unauthenticated probe endpoint for the approuter's
// /_manager-health route. Returns the manager's mode-flag too so the
// approuter (and the maintenance page indirectly) can confirm the upgrade
// took effect after restage. Intentionally lightweight; no DB touch.
app.get("/health", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  // Token mode adds two booleans - never the token itself. tokenMinted: this
  // process printed a [SETUP] line at boot; claimed: it has been used. An
  // operator who cannot find the line in the logs can tell "the logs were
  // lost" (minted, not claimed: restart for a new one) from "the app never
  // started" (virgin run #3, finding 3).
  const body = { ok: true, mode: XSUAA_ACTIVE ? "xsuaa" : "token" };
  if (!XSUAA_ACTIVE) {
    body.tokenMinted = auth.isMinted();
    body.claimed = auth.isClaimed();
  }
  res.status(200).json(body);
});

// ─── Gated surface ─────────────────────────────────────────────────────────

// Root: serve templated index.html with mode-flag injection (gated).
app.get("/", requireAuth, (req, res) => {
  const tmpl = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
  // v2: window.figafXsuaaMode lets the client shim (cloud/client.js) and
  // mode.js change behavior — most importantly, redirect targets on 401:
  //   token mode → /setup (claim flow)
  //   xsuaa mode → /     (approuter triggers IAS re-login)
  const injection = [
    "<script>",
    `window.figafMode = "hosted";`,
    `window.figafXsuaaMode = ${XSUAA_ACTIVE ? "true" : "false"};`,
    `window.figafSession = ${JSON.stringify({ sessionId: req.sessionId })};`,
    `window.figafVersion = ${JSON.stringify(APP_VERSION)};`,
    // Console frame flag: on by default, FIGAF_CONSOLE_UI=0 restores the
    // classic wizard frame (mode.js turns this into features.consoleUI).
    `window.figafConsoleUI = ${process.env.FIGAF_CONSOLE_UI === "0" ? "false" : "true"};`,
    "</script>",
  ].join("\n");
  const html = tmpl.replace("<!-- FIGAF_MODE_INJECT -->", injection);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(html);
});

// RPC: POST /rpc/:channel → orchestrator handler (gated).
app.post("/rpc/:channel", requireAuth, async (req, res) => {
  const { channel } = req.params;
  const sess = getOrCreateSession(req.sessionId);
  const handler = sess.handlers[channel];
  // User identity for the audit record: XSUAA mode has it on the JWT-decorated
  // request (xsuaa-auth sets req.figafUser); v1 has no per-user identity, just
  // the session cookie.
  const user = (req.figafUser && (req.figafUser.email || req.figafUser.name)) || null;
  // faid:configure carries connection secrets in body.env, and
  // login:storeManagementUser carries a password — never let their VALUES
  // reach the audit stream (visible in cockpit logs / log drains).
  let auditArgs = req.body || {};
  if (channel === "faid:configure" && auditArgs && typeof auditArgs.env === "object" && auditArgs.env) {
    auditArgs = {
      ...auditArgs,
      env: Object.fromEntries(Object.keys(auditArgs.env).map((k) => [k, "<value hidden>"])),
    };
  }
  if (channel === "login:storeManagementUser" && auditArgs && typeof auditArgs === "object" && "password" in auditArgs) {
    auditArgs = { ...auditArgs, password: "<value hidden>" };
  }
  // connections:saveFigaf / connections:saveSystem carry client secrets (and
  // a pasted service-key JSON) — hide the values, keep the field names.
  if (channel.startsWith("connections:save") && auditArgs && typeof auditArgs === "object") {
    auditArgs = { ...auditArgs };
    for (const k of ["clientSecret", "accessClientSecret", "serviceKeyJson"]) {
      if (k in auditArgs) auditArgs[k] = "<value hidden>";
    }
  }
  const rpcHandle = sess.audit.beginRpc({ channel, args: auditArgs, user, source: "http" });
  if (!handler) {
    rpcHandle.out({ ok: false, error: `Unknown channel: ${channel}` });
    return res.status(404).json({ ok: false, error: `Unknown channel: ${channel}` });
  }
  try {
    const result = await handler(req.body || {});
    const out = result !== undefined ? result : { ok: true };
    rpcHandle.out(out);
    if (out && out.ok === false && out.error) {
      // One plain, readable line per failed action for `cf logs` / the cockpit
      // log view — at EVERY log level. The JSON audit records (cli.exit) hold
      // the full command tails; this is the line an operator can find without
      // parsing JSON. Carries our own error text and CLI tails only, never an
      // argument value (args are not echoed here).
      const where = [out.step ? `at step ${out.step}` : "", out.cfApp ? `(${out.cfApp})` : ""].filter(Boolean).join(" ");
      console.warn(`[action] ${channel} failed${where ? " " + where : ""}: ${String(out.error).slice(0, 600)}`);
    }
    res.json(out);
  } catch (err) {
    rpcHandle.error(err);
    console.error(`[rpc] ${channel} error:`, err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── HTTP + WebSocket server ────────────────────────────────────────────────────

const server = http.createServer(app);
// `noServer: true` — we own the upgrade event so we can authenticate BEFORE
// the WS handshake completes. Once handleUpgrade resolves, we can no longer
// send an HTTP error code; pre-upgrade is the only correct seam (plan Q4).
const wss = new WebSocketServer({ noServer: true });

// Reject the upgrade with a real HTTP 401 (RFC 6455: before upgrade, a real
// HTTP status is the only message the browser will surface usefully). The
// reason header is non-standard but harmless; client.js inspects WS close
// codes (4003/4004) for the post-upgrade case.
function rejectUpgrade(socket) {
  socket.write(
    "HTTP/1.1 401 Unauthorized\r\n" +
    "Connection: close\r\n" +
    "Content-Length: 0\r\n" +
    "\r\n"
  );
  socket.destroy();
}

server.on("upgrade", (req, socket, head) => {
  // Only intercept our /stream path; let other upgrade-able protocols pass.
  const url = req.url || "";
  if (!url.startsWith("/stream")) {
    socket.destroy();
    return;
  }
  if (XSUAA_ACTIVE) {
    // v2 path: validate the approuter-forwarded JWT. We resolve a Promise,
    // so close over (socket, head, req) carefully — by the time the promise
    // resolves the socket may have already been destroyed, in which case
    // handleUpgrade is a no-op.
    xsuaa.verifyWsUpgrade(req).then((r) => {
      if (r.ok) {
        wss.handleUpgrade(req, socket, head, (ws) => {
          // Stash identity for the connection handler if it wants it.
          ws.figafUser = { name: r.user || null, email: r.email || null };
          wss.emit("connection", ws, req);
        });
        return;
      }
      if (r.wsClose === 4004) {
        // NO_SCOPE — same pre-upgrade HTTP signal (401) but client.js can
        // distinguish via the close code on subsequent attempts.
      }
      rejectUpgrade(socket);
    }).catch(() => rejectUpgrade(socket));
    return;
  }
  // v1 path: signed cookie check.
  const v = auth.verifyAuth(req);
  if (!v.ok) { rejectUpgrade(socket); return; }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

wss.on("connection", (ws, req) => {
  const sessionId = sessionIdFromReq(req);
  if (!sessionId) {
    // Should be unreachable: requireAuth on /rpc/* and sessionMiddleware on
    // the upgrade request both run, but defensively close with 4003 (auth)
    // rather than 4001 (no session) so the client redirects to /setup.
    ws.close(4003, "Unauthenticated");
    return;
  }
  const sess = getOrCreateSession(sessionId);
  sess.wsClients.add(ws);
  ws.on("close", () => sess.wsClients.delete(ws));
  ws.on("error", () => sess.wsClients.delete(ws));
  // Simple ping/pong keepalive
  ws.on("message", (data) => {
    try {
      if (JSON.parse(data).ping) ws.send(JSON.stringify({ pong: true }));
    } catch {}
  });
});

// ─── Idle self-destruct (v2 V4 mitigation) ─────────────────────────────────
// Defense in depth: the longer a wizard sits deployed without use, the wider
// the exposure window for the cockpit-log token (v1) or a leaked role
// assignment (v2). After IDLE_TTL_HOURS of no authenticated traffic, the
// wizard tears itself down via the same multi-step uninstall used by the
// "Delete this manager" button.
//
// Controls:
//   FIGAF_IDLE_SELF_DESTRUCT_HOURS  — TTL in hours. Defaults to 0 (DISABLED)
//                                     so an operator who deploys and walks
//                                     away gets no surprises. Set explicitly
//                                     in the manifest to opt in.
//                                     Min sane value: 1 hour.
//   FIGAF_IDLE_SELF_DESTRUCT_GRACE  — minutes to log a warning before the
//                                     teardown actually runs. Default 30.
//
// Activity heuristic: max(lastSeen across active sessions, processStart).
// A session is "active" if any RPC or WS message has bumped its lastSeen.
// No sessions yet → process boot is the anchor.

const IDLE_TTL_HOURS = Number(process.env.FIGAF_IDLE_SELF_DESTRUCT_HOURS || 0);
const IDLE_GRACE_MIN = Number(process.env.FIGAF_IDLE_SELF_DESTRUCT_GRACE  || 30);
const PROCESS_START = Date.now();
let _idleWarned = false;

function lastActivityMs() {
  let max = PROCESS_START;
  for (const sess of sessions.values()) {
    if (sess.lastSeen > max) max = sess.lastSeen;
  }
  return max;
}

async function maybeIdleSelfDestruct() {
  if (!(IDLE_TTL_HOURS > 0)) return;
  const idleMs = Date.now() - lastActivityMs();
  const ttlMs = IDLE_TTL_HOURS * 60 * 60 * 1000;
  const graceMs = Math.max(0, IDLE_GRACE_MIN) * 60 * 1000;
  if (idleMs < ttlMs - graceMs) return;
  if (idleMs < ttlMs) {
    if (!_idleWarned) {
      _idleWarned = true;
      console.log(`[INFO] Idle self-destruct armed: no authenticated traffic in ${(idleMs / 3600000).toFixed(1)}h. Teardown in ${((ttlMs - idleMs) / 60000).toFixed(0)} min unless activity resumes.`);
    }
    return;
  }
  // TTL exceeded. Find any session whose orchestrator we can use, or build a
  // throw-away one with a synthetic id so we can drive cf:uninstallManager.
  console.log("[WARN] Idle self-destruct firing — tearing down figaf-manager (and approuter, if present).");
  const sessId = sessions.keys().next().value || "idle-self-destruct";
  const sess = getOrCreateSession(sessId);
  try {
    await sess.handlers["cf:uninstallManager"]({ deleteRoleCollections: false });
  } catch (e) {
    console.error("[ERR] Idle self-destruct teardown failed:", e.message);
  }
}

// Probe every 5 minutes. unref() so the timer does not prevent shutdown.
setInterval(maybeIdleSelfDestruct, 5 * 60 * 1000).unref();

// ─── Boot: mint setup token + emit [SETUP] line BEFORE app.listen() ────────
// One-shot operation. The cleartext is printed to stdout exactly once; the
// SHA-256 hash lives in cloud/auth.js module state for the lifetime of the
// process. Cockpit operator reads this line from the Logs view to claim.
//
// v2: when XSUAA is active (post-upgrade restage), the entire token-gate
// path is dormant. Emit a single [INFO] line instead so the operator can
// confirm from cockpit logs that the binding took effect.
function bootMintToken() {
  if (XSUAA_ACTIVE) {
    console.log("[INFO] XSUAA mode active — token gate disabled. Authentication is via the figaf-manager-approuter sibling app.");
    return;
  }
  const token = auth.generateSetupToken();
  console.log(auth.formatSetupLogLine(token));
  if (auth.secretIsEphemeral) {
    console.log(
      "[INFO] FIGAF_AUTH_SECRET not set — using ephemeral per-boot secret. " +
      "All sessions will invalidate on restart."
    );
  }
  // T+5min audit boundary marker. If the operator claims earlier, the
  // /setup/claim handler emits the same line; this timer ensures the marker
  // appears even if the operator never claims (token-rotation story is
  // "redeploy the app").
  setTimeout(() => {
    if (auth.isClaimed()) return; // claim handler already emitted the line
    console.log("[SETUP] Token redacted post-claim");
  }, 5 * 60 * 1000).unref();
}

// Only run boot side-effects + .listen() when invoked as the main entry-point
// (e.g., `node server.js`). When the test runner require()s this file, it
// gets the Express app, HTTP server, and WS server without auto-starting.
if (require.main === module) {
  bootMintToken();
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`figaf-manager listening on :${PORT}`);
    console.log(`DEPLOYMENT_ZIP_URL: ${DEPLOYMENT_ZIP_URL}`);
  });

  // A single missed Promise rejection (e.g. an auth library throwing inside
  // an executor we don't await) used to take the entire wizard down — see the
  // v4.13 @sap/xssec API mismatch that returned 502s after XSUAA upgrade.
  // Auth failures must respond 401/403; verifier bugs must respond 500; the
  // dyno must never EOF mid-request just because a Promise was orphaned.
  process.on("unhandledRejection", (reason) => {
    const msg = reason && reason.stack ? reason.stack : String(reason);
    console.error("[FATAL-IGNORED] unhandledRejection: " + msg);
  });
  process.on("uncaughtException", (err) => {
    console.error("[FATAL-IGNORED] uncaughtException: " + (err && err.stack ? err.stack : String(err)));
  });

  // ─── Graceful shutdown (CF SIGTERM) ──────────────────────────────────────
  process.on("SIGTERM", () => {
    for (const sess of sessions.values()) {
      try { sess.dispose(); } catch {}
    }
    server.close(() => process.exit(0));
  });
}

// ─── Test seam ─────────────────────────────────────────────────────────────
// Tests require("./server") and start the server on a random port themselves.
module.exports = {
  app,
  server,
  wss,
  sessions,
  bootMintToken,
  XSUAA_ACTIVE,
  // v2: exposed for the idle-self-destruct test only
  __lastActivityMs: lastActivityMs,
  __maybeIdleSelfDestruct: maybeIdleSelfDestruct,
  __IDLE_TTL_HOURS: IDLE_TTL_HOURS,
};
