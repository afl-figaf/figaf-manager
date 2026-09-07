"use strict";
// node:test coverage for cloud/xsuaa-auth.js.
//
// We do NOT exercise @sap/xssec end-to-end here — its JWT cryptography needs
// a live signing key, and we shouldn't ship test keys in the repo. Instead
// we use the module's __setVerifier() seam to inject a synthetic verifier
// that returns a deterministic shape, and assert the middleware + WS upgrade
// helpers translate that shape into the right HTTP/WS responses.
//
// Coverage targets (auth-gate-implementation-plan.md §2.12):
//   - isXsuaaActive() / findXsuaaBinding() from VCAP_SERVICES
//   - extractJwt() — Authorization Bearer + x-jwt fallback
//   - requireJwt() — 401 / 403 / 200 paths
//   - verifyWsUpgrade() — wsClose 4003 (NO_JWT/INVALID) vs 4004 (NO_SCOPE)

const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const xa = require("./xsuaa-auth");

beforeEach(() => {
  xa.__resetForTests();
  delete process.env.VCAP_SERVICES;
});

// ─── VCAP_SERVICES detection ───────────────────────────────────────────────

test("isXsuaaActive: false when VCAP_SERVICES absent", () => {
  delete process.env.VCAP_SERVICES;
  assert.equal(xa.isXsuaaActive(), false);
});

test("isXsuaaActive: false when VCAP_SERVICES has no xsuaa key", () => {
  process.env.VCAP_SERVICES = JSON.stringify({ postgresql: [{}] });
  assert.equal(xa.isXsuaaActive(), false);
});

test("isXsuaaActive: false when VCAP_SERVICES is malformed JSON", () => {
  process.env.VCAP_SERVICES = "not-json";
  assert.equal(xa.isXsuaaActive(), false);
});

test("isXsuaaActive: true when VCAP_SERVICES has an xsuaa binding", () => {
  process.env.VCAP_SERVICES = JSON.stringify({
    xsuaa: [{ credentials: { xsappname: "figaf-manager-xsuaa", clientid: "x", clientsecret: "y", url: "https://x.authentication.eu10.hana.ondemand.com" } }],
  });
  assert.equal(xa.isXsuaaActive(), true);
});

test("findXsuaaBinding: prefers binding whose xsappname matches figaf-manager-xsuaa", () => {
  process.env.VCAP_SERVICES = JSON.stringify({
    xsuaa: [
      { credentials: { xsappname: "some-other-app" } },
      { credentials: { xsappname: "figaf-manager-xsuaa", clientid: "x" } },
    ],
  });
  const b = xa.findXsuaaBinding();
  assert.equal(b.credentials.xsappname, "figaf-manager-xsuaa");
});

// ─── extractJwt ────────────────────────────────────────────────────────────

test("extractJwt: pulls Bearer token from Authorization header", () => {
  const req = { headers: { authorization: "Bearer aaa.bbb.ccc" } };
  assert.equal(xa.extractJwt(req), "aaa.bbb.ccc");
});

test("extractJwt: case-insensitive on the scheme", () => {
  const req = { headers: { Authorization: "bearer xxx" } };
  assert.equal(xa.extractJwt(req), "xxx");
});

test("extractJwt: falls back to x-jwt header", () => {
  const req = { headers: { "x-jwt": "alt-token" } };
  assert.equal(xa.extractJwt(req), "alt-token");
});

test("extractJwt: returns null when no token present", () => {
  assert.equal(xa.extractJwt({ headers: {} }), null);
  assert.equal(xa.extractJwt({}), null);
  assert.equal(xa.extractJwt(null), null);
});

test("extractJwt: rejects non-Bearer Authorization", () => {
  const req = { headers: { authorization: "Basic dXNlcjpwYXNz" } };
  assert.equal(xa.extractJwt(req), null);
});

// ─── requireJwt middleware ─────────────────────────────────────────────────

function fakeReqRes({ jwt } = {}) {
  const req = { headers: jwt ? { authorization: "Bearer " + jwt } : {} };
  let statusCode = 200;
  let body = null;
  const res = {
    status(c) { statusCode = c; return res; },
    json(payload) { body = payload; return res; },
  };
  return { req, res, getStatus: () => statusCode, getBody: () => body };
}

test("requireJwt: 401 when no JWT present", async () => {
  const { req, res, getStatus, getBody } = fakeReqRes();
  let nextCalled = false;
  xa.requireJwt(req, res, () => { nextCalled = true; });
  // Synchronous path
  assert.equal(nextCalled, false);
  assert.equal(getStatus(), 401);
  assert.equal(getBody().ok, false);
  assert.equal(getBody().reason, "no-jwt");
});

test("requireJwt: 200/next on valid scope", async () => {
  xa.__setVerifier(() => Promise.resolve({ ok: true, user: "alice@example.com", email: "alice@example.com" }));
  const { req, res, getStatus } = fakeReqRes({ jwt: "ok.token.value" });
  await new Promise((resolve) => xa.requireJwt(req, res, () => { resolve(); }));
  assert.equal(getStatus(), 200);
  assert.equal(req.figafUser.email, "alice@example.com");
});

test("requireJwt: 403 when JWT valid but scope missing", async () => {
  xa.__setVerifier(() => Promise.resolve({ ok: false, code: "NO_SCOPE", reason: "missing scope" }));
  const { req, res, getStatus, getBody } = fakeReqRes({ jwt: "valid.no.scope" });
  await new Promise((resolve) => {
    const _next = () => resolve();
    xa.requireJwt(req, res, _next);
    // Give the verifier a tick to settle if it didn't immediately call next.
    setImmediate(() => { if (getStatus() !== 200) resolve(); });
  });
  assert.equal(getStatus(), 403);
  assert.equal(getBody().error, "forbidden");
});

test("requireJwt: 401 when verifier reports INVALID", async () => {
  xa.__setVerifier(() => Promise.resolve({ ok: false, code: "INVALID", reason: "expired" }));
  const { req, res, getStatus, getBody } = fakeReqRes({ jwt: "bad.jwt" });
  await new Promise((resolve) => {
    xa.requireJwt(req, res, () => resolve());
    setImmediate(() => { if (getStatus() !== 200) resolve(); });
  });
  assert.equal(getStatus(), 401);
  assert.equal(getBody().reason, "expired");
});

test("requireJwt: 500 when verifier throws", async () => {
  xa.__setVerifier(() => Promise.reject(new Error("boom")));
  const { req, res, getStatus, getBody } = fakeReqRes({ jwt: "x" });
  await new Promise((resolve) => {
    xa.requireJwt(req, res, () => resolve());
    setImmediate(() => { if (getStatus() !== 200) resolve(); });
  });
  assert.equal(getStatus(), 500);
  assert.equal(getBody().error, "auth-internal");
});

// ─── verifyWsUpgrade ───────────────────────────────────────────────────────

test("verifyWsUpgrade: wsClose=4003 when no JWT", async () => {
  const r = await xa.verifyWsUpgrade({ headers: {} });
  assert.equal(r.ok, false);
  assert.equal(r.wsClose, 4003);
  assert.equal(r.code, "NO_JWT");
});

test("verifyWsUpgrade: wsClose=4003 when verifier returns INVALID", async () => {
  xa.__setVerifier(() => Promise.resolve({ ok: false, code: "INVALID", reason: "bad sig" }));
  const r = await xa.verifyWsUpgrade({ headers: { authorization: "Bearer x" } });
  assert.equal(r.ok, false);
  assert.equal(r.wsClose, 4003);
});

test("verifyWsUpgrade: wsClose=4004 when verifier returns NO_SCOPE", async () => {
  xa.__setVerifier(() => Promise.resolve({ ok: false, code: "NO_SCOPE", reason: "user lacks role" }));
  const r = await xa.verifyWsUpgrade({ headers: { authorization: "Bearer x" } });
  assert.equal(r.ok, false);
  assert.equal(r.wsClose, 4004);
  assert.equal(r.code, "NO_SCOPE");
});

test("verifyWsUpgrade: ok when verifier returns ok", async () => {
  xa.__setVerifier(() => Promise.resolve({ ok: true, user: "bob", email: "bob@x" }));
  const r = await xa.verifyWsUpgrade({ headers: { authorization: "Bearer x" } });
  assert.equal(r.ok, true);
  assert.equal(r.user, "bob");
});

// ─── operatorScopeFor ──────────────────────────────────────────────────────

test("operatorScopeFor: derives <xsappname>.FigafManagerOperator from binding", () => {
  assert.equal(
    xa.operatorScopeFor({ credentials: { xsappname: "figaf-manager-xsuaa" } }),
    "figaf-manager-xsuaa.FigafManagerOperator"
  );
});

test("operatorScopeFor: defaults to figaf-manager-xsuaa when binding empty", () => {
  assert.equal(xa.operatorScopeFor(null), "figaf-manager-xsuaa.FigafManagerOperator");
  assert.equal(xa.operatorScopeFor({}), "figaf-manager-xsuaa.FigafManagerOperator");
});

// ─── Regression: defaultVerifier must never crash the process ──────────────
// Regression for the @sap/xssec v4 API mismatch that returned 502s after the
// XSUAA upgrade: the verifier called the v3 callback signature on an async
// v4 function, dropped the returned rejected Promise, and crashed the dyno
// via Node's unhandled-rejection-throw policy. These tests exercise the
// REAL defaultVerifier (no __setVerifier seam) so any regression in the
// v3/v4 wiring trips them.

test("defaultVerifier: returns {ok:false,INVALID} for garbage JWT without throwing", async () => {
  process.env.VCAP_SERVICES = JSON.stringify({
    xsuaa: [{
      credentials: {
        xsappname: "figaf-manager-xsuaa",
        clientid: "sb-figaf-manager-xsuaa",
        clientsecret: "secret",
        url: "https://example.authentication.eu10.hana.ondemand.com",
        uaadomain: "authentication.eu10.hana.ondemand.com",
      },
    }],
  });
  const r = await xa.verifyWsUpgrade({ headers: { authorization: "Bearer not.a.real.jwt" } });
  assert.equal(r.ok, false);
  assert.notEqual(r.code, "NO_JWT"); // verifier ran — extractJwt found a token
  assert.ok(r.wsClose === 4003 || r.wsClose === 4004, "must close with auth code, not crash");
});

test("defaultVerifier: malformed Bearer through requireJwt returns 401 (never 5xx, never throw)", async () => {
  process.env.VCAP_SERVICES = JSON.stringify({
    xsuaa: [{
      credentials: {
        xsappname: "figaf-manager-xsuaa",
        clientid: "sb-figaf-manager-xsuaa",
        clientsecret: "secret",
        url: "https://example.authentication.eu10.hana.ondemand.com",
        uaadomain: "authentication.eu10.hana.ondemand.com",
      },
    }],
  });
  const { req, res, getStatus, getBody } = fakeReqRes({ jwt: "not.a.real.jwt" });
  await new Promise((resolve) => {
    xa.requireJwt(req, res, () => resolve());
    // The verifier may finish via response.status() instead of next() — poll
    // for that path too, capped to a few ticks so the test fails fast on hang.
    let ticks = 0;
    const settled = setInterval(() => {
      if (getStatus() !== 200 || ++ticks > 50) {
        clearInterval(settled);
        resolve();
      }
    }, 10);
  });
  // 401 (INVALID) is the contract. A 200, 500, or unhandled throw all fail
  // this test — exactly the failure modes the production bug exhibited.
  assert.equal(getStatus(), 401);
  assert.equal(getBody().error, "unauthenticated");
});

// ─── decision 0009: shared instance (figaf-faid) ───────────────────────────

test("findXsuaaBinding: prefers the SHARED instance (xsappname figaf-faid, with tenant suffix) over the legacy one", () => {
  process.env.VCAP_SERVICES = JSON.stringify({
    xsuaa: [
      { credentials: { xsappname: "figaf-manager-xsuaa!t1", clientid: "legacy" } },
      { credentials: { xsappname: "figaf-faid!t1", clientid: "shared" } },
    ],
  });
  const b = xa.findXsuaaBinding();
  assert.equal(b.credentials.clientid, "shared");
});

test("findXsuaaBinding: the legacy instance is still recognized when it is the only one", () => {
  process.env.VCAP_SERVICES = JSON.stringify({
    xsuaa: [
      { credentials: { xsappname: "some-other-app!t1", clientid: "other" } },
      { credentials: { xsappname: "figaf-manager-xsuaa!t1", clientid: "legacy" } },
    ],
  });
  assert.equal(xa.findXsuaaBinding().credentials.clientid, "legacy");
});

test("operatorScopeFor: the shared instance requires <xsappname>.FAIDManagerOperator", () => {
  assert.equal(
    xa.operatorScopeFor({ credentials: { xsappname: "figaf-faid!t12345" } }),
    "figaf-faid!t12345.FAIDManagerOperator"
  );
  assert.equal(
    xa.operatorScopeFor({ credentials: { xsappname: "figaf-faid" } }),
    "figaf-faid.FAIDManagerOperator"
  );
});
