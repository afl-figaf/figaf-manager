"use strict";
// Unit tests for the Setup step model (packages/ui/setup-checklist.js).
// The module is a browser-globals script; we fake `window` and load it.
// Run via `node --test packages/ui/setup-checklist.test.js`.
//
// Order under test (docs/faid-apps-console/SPEC.md section 6): 1 Prepare the space,
// 2 Management user, 3 Base services, 4 Shared backend and first app,
// 5 Figaf tool connection. Everything is blocked until step 1 is done.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const SRC = fs.readFileSync(path.join(__dirname, "setup-checklist.js"), "utf8");

function load() {
  const w = {};
  new Function("window", SRC)(w);
  return w.figafSetupSteps;
}

const V3 = (db, xsuaa, cred, boundToManager) => ({
  ok: true,
  services: [
    { name: "figaf-faid-db", status: db },
    { name: "figaf-faid-xsuaa", status: xsuaa },
    { name: "figaf-faid-credstore", status: cred, bindToManager: true, boundToManager },
  ],
});
const ids = (r) => r.steps.map((s) => s.id);
const byId = (r, id) => r.steps.find((s) => s.id === id);

test("v3, empty space, token mode: Prepare the space is step 1 and current; every other step is blocked 'after step 1'", () => {
  const r = load()({ services: V3("missing", "missing", "missing", false), stored: { available: false, bindingPresent: false }, faid: { ok: true, platform: { status: "missing" } }, figaf: { configured: false } });
  assert.deepEqual(ids(r), ["prepare", "mgmt-user", "services", "platform", "figaf-connection"]);
  assert.deepEqual(r.steps.map((s) => s.n), [1, 2, 3, 4, 5]);
  assert.equal(r.done, 0);
  assert.equal(r.total, 5);
  assert.equal(r.complete, false);
  assert.equal(byId(r, "prepare").current, true);
  assert.equal(r.current && r.current.id, "prepare");
  assert.equal(byId(r, "prepare").blocked, "");
  assert.equal(byId(r, "prepare").cta, "Prepare the space");
  for (const id of ["mgmt-user", "services", "platform", "figaf-connection"]) {
    assert.equal(byId(r, id).blocked, "after step 1", id);
    assert.equal(byId(r, id).current, false, id);
  }
  assert.equal(r.steps.filter((s) => s.current).length, 1);
});

test("v3, token mode, instances already ready and bound: still everything after step 1 is blocked (no restart before step 1)", () => {
  const r = load()({ services: V3("ready", "ready", "ready", true), stored: { available: false, bindingPresent: false } });
  assert.equal(byId(r, "prepare").current, true);
  assert.equal(byId(r, "services").blocked, "after step 1");
  assert.equal(byId(r, "mgmt-user").blocked, "after step 1");
});

test("step 1 done, binding active, nothing stored, database still creating: management user is current; step 3 says the database is being created", () => {
  const r = load()({ services: V3("in-progress", "ready", "ready", true), stored: { available: false, bindingPresent: true }, faid: { ok: true, platform: { status: "missing" } }, figaf: { configured: false } }, { ssoDone: true });
  assert.equal(byId(r, "prepare").done, true);
  assert.equal(byId(r, "mgmt-user").current, true);
  assert.equal(byId(r, "mgmt-user").blocked, "");
  const s3 = byId(r, "services");
  assert.equal(s3.done, false);
  assert.equal(s3.blocked, "");
  assert.match(s3.when, /Still being created: figaf-faid-db/);
  assert.match(s3.when, /refreshes by itself/);
  assert.equal(byId(r, "platform").blocked, "after step 3");
  assert.equal(byId(r, "figaf-connection").blocked, "");
  assert.equal(r.done, 1);
});

test("step 1 done, an instance missing or failed: step 3 asks to pick the plan and create it", () => {
  const r = load()({ services: V3("missing", "ready", "ready", true), stored: { available: true, bindingPresent: true } }, { ssoDone: true });
  const s3 = byId(r, "services");
  assert.equal(s3.current, true);
  assert.match(s3.when, /1 of 3 instance missing or failed \(figaf-faid-db\)/);
  assert.match(s3.when, /Pick the plan and create it below/);
  const r2 = load()({ services: V3("failed", "ready", "in-progress", true), stored: { available: true, bindingPresent: true } }, { ssoDone: true });
  assert.match(byId(r2, "services").when, /1 of 3 instance missing or failed \(figaf-faid-db\)/);
});

test("step 1 done but the Credential Store binding is NOT active (step 1 failed to bind): management user and connection say so; step 3 offers the repair", () => {
  const r = load()({ services: V3("ready", "ready", "ready", false), stored: { available: false, bindingPresent: false } }, { ssoDone: true });
  assert.equal(byId(r, "mgmt-user").blocked, "Credential Store binding not active");
  assert.equal(byId(r, "figaf-connection").blocked, "Credential Store binding not active");
  assert.match(byId(r, "services").when, /Bind to manager/);
  assert.equal(byId(r, "services").current, true);
  const r2 = load()({ services: V3("ready", "ready", "ready", true), stored: { available: false, bindingPresent: false } }, { ssoDone: true });
  assert.match(byId(r2, "services").when, /Restart the manager/);
});

test("step 1 done, user stored, all instances ready and bound: shared backend is current (install does it)", () => {
  const r = load()({ services: V3("ready", "ready", "ready", true), stored: { available: true, bindingPresent: true }, faid: { ok: true, platform: { status: "missing" } }, figaf: { configured: false } }, { ssoDone: true });
  assert.equal(byId(r, "mgmt-user").done, true);
  assert.equal(byId(r, "services").done, true);
  assert.equal(byId(r, "platform").current, true);
  assert.equal(byId(r, "platform").cta, "Open FAID Apps");
  assert.equal(byId(r, "figaf-connection").blocked, "");
  assert.equal(byId(r, "figaf-connection").cta, "Open Connections");
  assert.equal(r.done, 3);
});

test("everything done: 5 of 5, complete, no current step", () => {
  const r = load()({ services: V3("ready", "ready", "ready", true), stored: { available: true, bindingPresent: true }, faid: { ok: true, platform: { status: "running" } }, figaf: { configured: true } }, { ssoDone: true });
  assert.equal(r.done, 5);
  assert.equal(r.complete, true);
  assert.equal(r.current, null);
  assert.equal(r.steps.every((s) => s.done), true);
  assert.equal(r.steps.some((s) => s.current), false);
});

test("v2 release (no services block): four steps, numbering 1-4, Prepare the space first", () => {
  const r = load()({ services: { ok: true, services: [] }, stored: { available: false, bindingPresent: false } });
  assert.deepEqual(ids(r), ["prepare", "mgmt-user", "platform", "figaf-connection"]);
  assert.deepEqual(r.steps.map((s) => s.n), [1, 2, 3, 4]);
  assert.equal(byId(r, "prepare").current, true);
  assert.equal(byId(r, "platform").blocked, "after step 1");
});

test("v2 release, step 1 done, binding not active: the reason is spelled out", () => {
  const r = load()({ services: { ok: true, services: [] }, stored: { available: false, bindingPresent: false } }, { ssoDone: true });
  assert.equal(byId(r, "mgmt-user").blocked, "Credential Store binding not active");
  assert.equal(byId(r, "platform").blocked, "");
  assert.equal(byId(r, "platform").current, true);
});

test("services fetch failed: treated like v2 (no false 'to do' for unknown instances)", () => {
  const r = load()({ services: { ok: false, error: "boom" }, stored: { available: false, bindingPresent: true } }, { ssoDone: true });
  assert.deepEqual(ids(r), ["prepare", "mgmt-user", "platform", "figaf-connection"]);
  assert.equal(byId(r, "mgmt-user").current, true);
});

test("missing inputs: nothing throws, Prepare the space is the only actionable step", () => {
  const r = load()(undefined);
  assert.equal(r.done, 0);
  assert.equal(r.total, 4);
  assert.equal(byId(r, "prepare").current, true);
  assert.equal(byId(r, "mgmt-user").blocked, "after step 1");
});

test("every step carries a title and a why-line; step 1 names the passcode, the restart and the database in the background", () => {
  const r = load()({ services: V3("missing", "missing", "missing", false), stored: {} });
  for (const s of r.steps) {
    assert.ok(s.title.length > 0, s.id + " title");
    assert.ok(s.why.length > 0, s.id + " why");
  }
  const p = byId(r, "prepare");
  assert.equal(p.title, "Prepare the space");
  assert.match(p.when, /passcode/);
  assert.match(p.when, /30-90 s/);
  assert.match(p.when, /database/);
  assert.match(p.why, /Credential Store/);
  assert.match(p.why, /SAP IAS/);
  assert.equal(byId(r, "mgmt-user").cta, null);
  assert.match(byId(r, "mgmt-user").when, /below/);
  assert.equal(byId(r, "services").cta, null);
  assert.equal(byId(r, "platform").title, "Shared backend and first app");
});

// Catalog v6: the database is reached with the backend's own role; the access
// (Credential Store entry) must be prepared in step 3 before step 4 opens.
const V6 = (dbAccess, dbStatus = "ready") => ({
  ok: true,
  services: [
    { name: "figaf-db", instanceName: "customer-pg", status: dbStatus, access: "own-role", nameEditable: true, databaseAccess: dbAccess },
    { name: "figaf-faid-xsuaa", status: "ready" },
    { name: "figaf-faid-credstore", status: "ready", bindToManager: true, boundToManager: true },
  ],
});
const V6_CTX = { stored: { available: true, bindingPresent: true }, faid: { ok: true, platform: { status: "missing" } }, figaf: { configured: false } };

test("v6: instances ready but the database access not prepared -> step 3 stays open with the Prepare hint naming the instance; step 4 is blocked", () => {
  const r = load()({ ...V6_CTX, services: V6({ state: "not-prepared", prepared: false }) }, { ssoDone: true });
  const s3 = byId(r, "services");
  assert.equal(s3.done, false);
  assert.equal(s3.current, true);
  assert.match(s3.when, /database access is not prepared/);
  assert.match(s3.when, /"Prepare database access" for customer-pg/);
  assert.match(s3.when, /faid_app/);
  assert.equal(byId(r, "platform").blocked, "after step 3");
  assert.match(byId(r, "platform").when, /database access is prepared/);
});

test("v6: a stale entry keeps step 3 open and says why", () => {
  const r = load()({ ...V6_CTX, services: V6({ state: "stale", prepared: false, reason: "instance customer-pg was re-created (another GUID); prepare again" }) }, { ssoDone: true });
  const s3 = byId(r, "services");
  assert.equal(s3.done, false);
  assert.match(s3.when, /stale/);
  assert.match(s3.when, /re-created/);
});

test("v6: access prepared -> step 3 done, step 4 current; the database still creating wins over the access text", () => {
  const done = load()({ ...V6_CTX, services: V6({ state: "prepared", prepared: true, instanceName: "customer-pg" }) }, { ssoDone: true });
  assert.equal(byId(done, "services").done, true);
  assert.equal(byId(done, "platform").current, true);
  const creating = load()({ ...V6_CTX, services: V6({ state: "not-prepared", prepared: false }, "in-progress") }, { ssoDone: true });
  assert.match(byId(creating, "services").when, /Still being created: figaf-db/);
});

test("v3 rows without `access` are unchanged by the v6 rule", () => {
  const r = load()({ ...V6_CTX, services: V3("ready", "ready", "ready", true) }, { ssoDone: true });
  assert.equal(byId(r, "services").done, true);
});

test("faid:services failed (the release could not be read, e.g. a catalog older than v7): step 1 says so with the error, step 3 is not listed, nothing is hidden silently", () => {
  const r = load()({
    services: { ok: false, error: "catalog.json: the catalog carries a 'services' list (catalog v6 or older); this manager needs catalog v7 (requires per CF app; release 0.8.0 or newer)" },
    stored: { available: false, bindingPresent: false }, faid: { ok: true, platform: { status: "missing" } }, figaf: { configured: false },
  });
  assert.deepEqual(ids(r), ["prepare", "mgmt-user", "platform", "figaf-connection"]);
  const s1 = byId(r, "prepare");
  assert.match(s1.when, /The release could not be read, so the service instances cannot be listed or created: catalog\.json: .*catalog v6 or older.*needs catalog v7/);
  assert.match(s1.error, /catalog v6 or older/);
  assert.equal(s1.current, true);
  // a normal answer carries no error and the usual when-line
  const ok = load()({ services: V3("missing", "missing", "missing", false), stored: { available: false, bindingPresent: false } });
  assert.equal(byId(ok, "prepare").error, "");
  assert.match(byId(ok, "prepare").when, /one-time passcode/);
});
