"use strict";
// The backend's own database role in faid-apps.js (catalog v7
// `requires.database: "own-role"`, faid-database.js) and the editable
// instance name (base-services.js). A fake `database` is injected; `run` is a
// recorder. Coverage:
//   - chooseDatabaseInstance (pure); the requirement of the fixture
//   - faid:services: instanceName from the override, the entry or the space;
//     access, nameEditable, databaseAccess and boundApps on the row
//   - faid:prepareSpaceServices / provisionServices with names: cf gets the
//     actual name, plans stay keyed by the catalog name, nothing binds the database
//   - faid:install: never a bind-service of an own-role service; refused before
//     any push while the access is not prepared (step "database")
//   - faid:databasePrepare / Rotate / Drop: the lock, the confirmation, the
//     backend restart after a rotation; refused on the desktop

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { createFaidHandlers, chooseDatabaseInstance, resetRunningAction } = require("./faid-apps");
const { requirementsOf } = require("./base-services");

// Catalog v7: the backend requires the database with its own role, XSUAA and
// the Credential Store as bindings; the frontend XSUAA only.
const CATALOG_V7 = {
  releaseVersion: "0.8.0",
  platform: {
    name: "Platform base",
    cfApps: [{ name: "arch-backend", artifact: "backend.zip", buildpack: "nodejs_buildpack", memory: "256M", requires: { database: "own-role", xsuaa: "binding", credstore: "binding" } }],
  },
  apps: [{
    id: "arch", name: "B2B Archiving Setup", version: "0.8.0",
    cfApps: [{ name: "arch-frontend", artifact: "frontend.zip", buildpack: "nodejs_buildpack", memory: "128M", requires: { xsuaa: "binding" }, destinationTo: "arch-backend", destinationName: "figaf-faid-backend" }],
    configTargetCfApp: "arch-backend", healthPath: "/health",
  }],
};

const CF_SERVICES_TOOL = `Getting service instances in org o / space s as me...

name          offering        plan       bound apps          last operation     broker   upgrade available
figaf-db      postgresql-db   standard   irt-app             create succeeded   b        no
other-pg      postgresql-db   free                           create succeeded   b        no
figaf-xsuaa   xsuaa           application irt-app            create succeeded   b        no
`;

function makeDir(catalog = CATALOG_V7) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "faid-v6-"));
  fs.writeFileSync(path.join(dir, "catalog.json"), JSON.stringify(catalog));
  fs.writeFileSync(path.join(dir, "backend.zip"), "zip");
  fs.writeFileSync(path.join(dir, "frontend.zip"), "zip");
  fs.writeFileSync(path.join(dir, "xs-security.json"), "{\"xsappname\":\"figaf-faid\"}");
  return dir;
}

function fakeDatabase(status = { state: "not-prepared", prepared: false, instanceName: null }) {
  const calls = [];
  return {
    calls,
    status: async () => { calls.push("status"); return { ok: true, role: "faid_app", schema: "faid", ...status }; },
    prepare: async (a) => { calls.push(`prepare:${a.instanceName}`); return { ok: true, instanceName: a.instanceName, role: "faid_app", schema: "faid", verify: { note: "ok" } }; },
    rotate: async () => { calls.push("rotate"); return { ok: true, instanceName: status.instanceName || "figaf-db", restartRequired: true }; },
    drop: async () => { calls.push("drop"); return { ok: true, instanceName: status.instanceName || "figaf-db" }; },
    certificateChain: async (a) => { calls.push(`certificate:${a.instanceName}`); return { ok: true, sslrootcert: "-----BEGIN CERTIFICATE-----\nFAKECA\n-----END CERTIFICATE-----\n", envName: "FAID_DATABASE_CA" }; },
  };
}

/** services state: name -> "create succeeded" | "create in progress" | undefined (missing) */
function makeCtx(dir, { services = {}, cfServices = "", database, apps = {}, hosted = true } = {}) {
  const calls = [];
  const logLines = [];
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "faid-v6-user-"));
  const state = { ...services };
  const db = database || fakeDatabase();
  const ctx = {
    host: { isHosted: hosted, getUserDataDir: () => userDir, resolveFaidReleaseSource: () => ({ kind: "local", dir }), getDeployTargetForSelf: () => ({ appName: "figaf-manager", apiUrl: "u", orgName: "o", spaceName: "s" }) },
    run: async (cmd, args, opts = {}) => {
      calls.push({ args, opts });
      logLines.push(opts.logCmd || `${cmd} ${args.join(" ")}`);
      if (args[0] === "services") return { code: 0, stdout: cfServices, stderr: "" };
      if (args[0] === "create-service") { state[args[3]] = args[1] === "postgresql-db" ? "create in progress" : "create succeeded"; return { code: 0, stdout: "OK", stderr: "" }; }
      if (args[0] === "service") { const st = state[args[1]]; return st ? { code: 0, stdout: `name: ${args[1]}\nplan: free\nstatus:    ${st}\n`, stderr: "" } : { code: 1, stdout: "", stderr: "not found" }; }
      if (args[0] === "app" && args[2] === "--guid") return apps[args[1]] ? { code: 0, stdout: "guid-1\n", stderr: "" } : { code: 1, stdout: "", stderr: "App 'x' not found" };
      if (args[0] === "app") return { code: 0, stdout: `name: ${args[1]}\nroutes:   ${args[1]}.cfapps.eu10.hana.ondemand.com\n`, stderr: "" };
      if (args[0] === "curl" && /\/v3\/domains/.test(args[1])) return { code: 0, stdout: JSON.stringify({ resources: [{ name: "cfapps.eu10.hana.ondemand.com" }] }), stderr: "" };
      if (args[0] === "curl" && /service_credential_bindings/.test(args[1])) return { code: 0, stdout: JSON.stringify({ resources: [] }), stderr: "" };
      if (args[0] === "curl") return { code: 0, stdout: JSON.stringify({ resources: [], var: {} }), stderr: "" };
      if (args[0] === "stacks") return { code: 0, stdout: "name\ncflinuxfs4\ncflinuxfs5\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
    log: (source, type, text) => logLines.push(text),
    send: () => {},
    resolveCf: () => "cf",
    extractZip: async () => {},
    httpsText: async () => "{}",
    httpsBody: async () => ({ status: 200, body: "{}" }),
    sleep: async () => {},
    pollIntervalMs: 0,
    database: db,
  };
  return { ctx, calls, logLines, db, seq: () => calls.map((c) => c.args.slice(0, 3).join(" ")) };
}

// ─── pure ────────────────────────────────────────────────────────────────────

test("the fixture requires the database as own-role (the name resolution itself is tested in base-services.test.js)", () => {
  const req = requirementsOf(CATALOG_V7);
  assert.equal(req.ok, true, req.error);
  assert.equal(req.consumption.database, "own-role");
  assert.deepEqual(req.services.map((s) => s.name), ["figaf-db", "figaf-faid-xsuaa", "figaf-faid-credstore"]);
});

test("chooseDatabaseInstance: one instance wins; else the default name; else the one bound to a <id>-app; else the default (to be created)", () => {
  assert.deepEqual(chooseDatabaseInstance("figaf-db", []), { name: "figaf-db", source: "default" });
  assert.deepEqual(chooseDatabaseInstance("figaf-db", [{ name: "only-pg", boundApps: [] }]), { name: "only-pg", source: "space" });
  assert.deepEqual(chooseDatabaseInstance("figaf-db", [{ name: "a", boundApps: [] }, { name: "figaf-db", boundApps: [] }]), { name: "figaf-db", source: "space" });
  assert.deepEqual(chooseDatabaseInstance("figaf-db", [{ name: "a", boundApps: [] }, { name: "tool-db", boundApps: ["irt-app"] }]), { name: "tool-db", source: "space" });
  assert.deepEqual(chooseDatabaseInstance("figaf-db", [{ name: "a", boundApps: [] }, { name: "b", boundApps: ["x-router"] }]), { name: "figaf-db", source: "default" });
});

// ─── faid:services ───────────────────────────────────────────────────────────

test("faid:services: no entry -> the space's PostgreSQL instance bound to the Tool app is the database (prefill); the row carries access, nameEditable, boundApps, candidates and databaseAccess", async () => {
  const dir = makeDir();
  const { ctx, db } = makeCtx(dir, { services: { "figaf-db": "create succeeded", "figaf-faid-xsuaa": "create succeeded" }, cfServices: CF_SERVICES_TOOL });
  const r = await createFaidHandlers(ctx)["faid:services"]();
  assert.equal(r.ok, true, JSON.stringify(r));
  const row = r.services.find((s) => s.name === "figaf-db");
  assert.equal(row.instanceName, "figaf-db");
  assert.equal(row.nameSource, "space");
  assert.equal(row.access, "own-role");
  assert.equal(row.nameEditable, true);
  assert.deepEqual(row.candidates.map((c) => c.name), ["figaf-db", "other-pg"]);
  assert.equal(row.status, "ready");
  assert.equal(row.databaseAccess.state, "not-prepared");
  assert.equal(r.databaseAccess.prepared, false);
  const xs = r.services.find((s) => s.name === "figaf-faid-xsuaa");
  assert.equal(xs.access, "binding");
  assert.equal(xs.nameEditable, false);
  assert.equal(xs.instanceName, "figaf-faid-xsuaa");
  assert.equal(xs.databaseAccess, null);
  assert.deepEqual(db.calls, ["status"]);
});

test("faid:services: an override names the instance to probe; an entry wins over the space; an invalid override is a clear error", async () => {
  const dir = makeDir();
  let m = makeCtx(dir, { services: { "my-db": "create in progress" }, cfServices: CF_SERVICES_TOOL });
  let r = await createFaidHandlers(m.ctx)["faid:services"]({ names: { "figaf-db": "my-db" } });
  let row = r.services.find((s) => s.name === "figaf-db");
  assert.equal(row.instanceName, "my-db");
  assert.equal(row.nameSource, "override");
  assert.equal(row.status, "in-progress");
  assert.ok(m.calls.some((c) => c.args[0] === "service" && c.args[1] === "my-db"));
  assert.ok(!m.calls.some((c) => c.args[0] === "services"), "no space scan when the name is given");

  m = makeCtx(dir, { services: { "prepared-db": "create succeeded" }, database: fakeDatabase({ state: "prepared", prepared: true, instanceName: "prepared-db", instanceGuid: "g" }) });
  r = await createFaidHandlers(m.ctx)["faid:services"]();
  row = r.services.find((s) => s.name === "figaf-db");
  assert.equal(row.instanceName, "prepared-db");
  assert.equal(row.nameSource, "entry");
  assert.equal(row.databaseAccess.prepared, true);

  m = makeCtx(dir);
  r = await createFaidHandlers(m.ctx)["faid:services"]({ names: { "figaf-db": "-bad" } });
  assert.equal(r.ok, false);
  assert.match(r.error, /figaf-db: .*not a valid service instance name/);
});

// ─── provisioning with names ─────────────────────────────────────────────────

test("faid:prepareSpaceServices with names: cf create-service gets the actual name, the plan is looked up by the catalog name, the database is never bound", async () => {
  const dir = makeDir();
  const { ctx, calls } = makeCtx(dir, {});
  const r = await createFaidHandlers(ctx)["faid:prepareSpaceServices"]({ plans: { "figaf-db": "standard" }, names: { "figaf-db": "customer-pg" } });
  assert.equal(r.ok, true, JSON.stringify(r));
  const creates = calls.filter((c) => c.args[0] === "create-service");
  assert.deepEqual(creates.find((c) => c.args[1] === "postgresql-db").args, ["create-service", "postgresql-db", "standard", "customer-pg"]);
  assert.ok(r.created.includes("customer-pg"));
  assert.ok(r.pending.includes("customer-pg"), "the database is only started");
  assert.ok(!calls.some((c) => c.args[0] === "bind-service" && c.args[2] === "customer-pg"));
  assert.ok(calls.some((c) => c.args[0] === "bind-service" && c.args[2] === "figaf-faid-credstore"));
});

test("faid:provisionServices: an existing instance under the chosen name is accepted as it is (never re-created); a FAILED own-role database is never deleted", async () => {
  const dir = makeDir();
  let m = makeCtx(dir, { services: { "figaf-db": "create succeeded" }, cfServices: CF_SERVICES_TOOL });
  let r = await createFaidHandlers(m.ctx)["faid:provisionServices"]({ only: ["figaf-db"] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.created, []);
  assert.ok(!m.calls.some((c) => c.args[0] === "create-service"));

  m = makeCtx(dir, { services: { "figaf-db": "create failed" }, cfServices: CF_SERVICES_TOOL });
  r = await createFaidHandlers(m.ctx)["faid:provisionServices"]({ only: ["figaf-db"] });
  assert.equal(r.ok, false);
  assert.match(r.error, /never deletes a database instance/);
  assert.ok(!m.calls.some((c) => c.args[0] === "delete-service"));
});

// ─── install ─────────────────────────────────────────────────────────────────

test("faid:install: refused before any push while the database access is not prepared (step database, Setup step 3 hint)", async () => {
  resetRunningAction();
  const dir = makeDir();
  const { ctx, calls } = makeCtx(dir, { services: { "figaf-db": "create succeeded", "figaf-faid-xsuaa": "create succeeded", "figaf-faid-credstore": "create succeeded" } });
  const r = await createFaidHandlers(ctx)["faid:install"]({ appId: "arch" });
  assert.equal(r.ok, false);
  assert.equal(r.step, "database");
  assert.match(r.error, /database access is not prepared.*Setup step 3, "Prepare database access"/);
  assert.ok(!calls.some((c) => c.args[0] === "push"));
});

test("faid:install with the access prepared: the required instances are checked without the database; no bind-service ever names the database; the backend gets FAID_DATABASE_CA (masked)", async () => {
  resetRunningAction();
  const dir = makeDir();
  const { ctx, calls, logLines, db } = makeCtx(dir, {
    services: { "figaf-faid-xsuaa": "create succeeded", "figaf-faid-credstore": "create succeeded", "figaf-db": "create succeeded" },
    database: fakeDatabase({ state: "prepared", prepared: true, instanceName: "figaf-db", instanceGuid: "g" }),
  });
  const r = await createFaidHandlers(ctx)["faid:install"]({ appId: "arch" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(db.calls.includes("certificate:figaf-db"), "the CA chain is read from the standing key at deploy");
  const caSet = calls.filter((c) => c.args[0] === "set-env" && c.args[2] === "FAID_DATABASE_CA");
  assert.equal(caSet.length, 1, "the CA goes to the shared backend only");
  assert.equal(caSet[0].args[1], "arch-backend");
  assert.match(caSet[0].args[3], /BEGIN CERTIFICATE/);
  assert.match(caSet[0].opts.logCmd, /<value hidden>/);
  assert.ok(!calls.some((c) => c.args[0] === "set-env" && c.args[1] === "arch-frontend" && c.args[2] === "FAID_DATABASE_CA"));
  const binds = calls.filter((c) => c.args[0] === "bind-service").map((c) => c.args[2]);
  assert.ok(binds.includes("figaf-faid-xsuaa"));
  assert.ok(binds.includes("figaf-faid-credstore"));
  assert.ok(!binds.includes("figaf-db"), `the database must never be bound: ${binds}`);
  assert.ok(logLines.some((l) => /figaf-db: .*never through a binding/.test(l)));
  assert.ok(calls.some((c) => c.args[0] === "push" && c.args[1] === "arch-backend"));
});

// ─── the handlers ────────────────────────────────────────────────────────────

test("faid:databasePrepare passes the instance name to the module under the lock; Drop needs confirm:true; Rotate restarts a deployed backend; the desktop refuses", async () => {
  resetRunningAction();
  const dir = makeDir();
  let m = makeCtx(dir, { apps: { "arch-backend": true }, database: fakeDatabase({ state: "prepared", prepared: true, instanceName: "figaf-db" }) });
  let h = createFaidHandlers(m.ctx);
  const p = await h["faid:databasePrepare"]({ instanceName: "figaf-db" });
  assert.equal(p.ok, true);
  assert.deepEqual(m.db.calls, ["prepare:figaf-db"]);

  const d0 = await h["faid:databaseDrop"]({});
  assert.equal(d0.ok, false);
  assert.match(d0.error, /confirmation required/);
  const d1 = await h["faid:databaseDrop"]({ confirm: true });
  assert.equal(d1.ok, true);
  assert.ok(m.db.calls.includes("drop"));

  const rot = await h["faid:databaseRotate"]();
  assert.equal(rot.ok, true);
  assert.equal(rot.restarted, "arch-backend");
  assert.ok(m.calls.some((c) => c.args[0] === "restart" && c.args[1] === "arch-backend"));

  const st = await h["faid:databaseStatus"]();
  assert.equal(st.prepared, true);

  m = makeCtx(dir, { hosted: false });
  h = createFaidHandlers(m.ctx);
  for (const name of ["faid:databaseStatus", "faid:databasePrepare", "faid:databaseRotate", "faid:databaseDrop"]) {
    const r = await h[name]({ instanceName: "x", confirm: true });
    assert.equal(r.ok, false, name);
    assert.match(r.error, /desktop/);
  }
  assert.deepEqual(m.db.calls, []);
});

test("faid:databaseRotate without a deployed backend: rotated, nothing restarted", async () => {
  resetRunningAction();
  const dir = makeDir();
  const m = makeCtx(dir, { database: fakeDatabase({ state: "prepared", prepared: true, instanceName: "figaf-db" }) });
  const r = await createFaidHandlers(m.ctx)["faid:databaseRotate"]();
  assert.equal(r.ok, true);
  assert.equal(r.restarted, null);
  assert.ok(!m.calls.some((c) => c.args[0] === "restart"));
});
