"use strict";
// Tests for faid-database.js — the backend's own database role, administered
// by the manager. No processes, no database, no Credential Store: `run`, the
// pg Client and the entry store are fakes.
//
// Coverage:
//   A. Pure helpers: instance-name validation, service-key parsing, cf service
//      / cf services parsing, the SQL, the entry value, error text masking.
//   B. prepare: the whole sequence in order (cf service, create-service-key
//      figaf-manager - "already exists" is success -, service-key read masked,
//      SQL as dbo, verification as faid_app, entry written); the password is
//      reused when an entry exists; no secret in any logged line or result; a
//      readable other schema is a refusal and nothing is stored.
//   C. rotate, drop (deletes the standing key too), status, certificateChain.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const db = require("./faid-database");

const CF_SERVICE_READY = `Showing info of service figaf-db in org Figaf / space figaf-faid as ais@figaf.com...

name:            figaf-db
guid:            0c2679b7-2e79-464d-8abe-f9d1797e0af2
type:            managed
broker:          sm-backing-services-broker-postgresql-db
offering:        postgresql-db
plan:            standard
tags:
offering tags:   relational, database
description:     PostgreSQL service on SAP BTP
documentation:
dashboard url:

Showing status of last operation:
   status:    create succeeded
   message:
   started:   2026-09-08T12:42:11Z
   updated:   2026-09-08T12:48:30Z

Showing bound apps:
   name       binding name   status             message
   irt-app                   create succeeded

Showing sharing info:
   This service instance is not currently being shared.
`;

const CF_SERVICE_NO_APPS = CF_SERVICE_READY
  .replace("name:            figaf-db", "name:            faid-only-db")
  .replace(/Showing bound apps:[\s\S]*?\n\n/, "Showing bound apps:\n   There are no bound apps for this service instance.\n\n");

const KEY_STDOUT = `Getting key figaf-manager-admin-1 for service instance figaf-db as ais@figaf.com...

{
  "credentials": {
    "dbname": "ABCDEF",
    "hostname": "postgres-x.rds.amazonaws.com",
    "password": "DBO-SECRET-PASSWORD",
    "port": "1234",
    "sslrootcert": "-----BEGIN CERTIFICATE-----\\nMIIC\\n-----END CERTIFICATE-----",
    "uri": "postgres://u:DBO-SECRET-PASSWORD@postgres-x:1234/ABCDEF",
    "username": "dbo-user-1"
  }
}
`;

const CF_SERVICES = `Getting service instances in org Figaf ApS_figafpartner-1 / space figaf-faid as ais@figaf.com...

name            offering        plan       bound apps          last operation       broker                                    upgrade available
figaf-db        postgresql-db   standard   irt-app, other-x    create succeeded     sm-backing-services-broker-postgresql-db   no
figaf-xsuaa     xsuaa           application irt-app, irt-router create succeeded    sm-backing-services-broker-xsuaa           no
faid-only-db    postgresql-db   free                           create in progress   sm-backing-services-broker-postgresql-db   no
`;

// ─── fakes ───────────────────────────────────────────────────────────────────

/**
 * A fake pg: `new Client(cfg)`; queries are recorded per user; `plan` decides
 * what a query answers or throws. `connectFails(user)` makes connect() reject.
 */
function fakePg({ foreignTable = { table_schema: "irt", table_name: "agents" }, roleCanRead = false, currentSchema = "faid", failStatement = null, connectFails = () => false } = {}) {
  const clients = [];
  class Client {
    constructor(cfg) { this.cfg = cfg; this.queries = []; this.ended = false; clients.push(this); }
    async connect() { if (connectFails(this.cfg.user)) { const e = new Error(`password authentication failed for user "${this.cfg.user}" (pw ${this.cfg.password})`); e.code = "28P01"; throw e; } this.connected = true; }
    async query(sql, params) {
      this.queries.push(sql);
      if (failStatement && sql.includes(failStatement)) { const e = new Error(`boom on ${failStatement} with ${this.cfg.password}`); e.code = "42601"; throw e; }
      if (/information_schema\.tables/.test(sql)) return { rows: foreignTable ? [foreignTable] : [] };
      if (/current_schema\(\)/.test(sql)) return { rows: [{ schema: currentSchema }] };
      if (/^SELECT 1 FROM "/.test(sql)) {
        if (roleCanRead) return { rows: [{ "?column?": 1 }] };
        const e = new Error("permission denied for schema irt"); e.code = "42501"; throw e;
      }
      return { rows: [] };
    }
    async end() { this.ended = true; }
  }
  return { Client, clients };
}

function fakeStore({ entry = null, available = true, writeFails = false } = {}) {
  const ops = [];
  let current = entry;
  return {
    ops,
    get entry() { return current; },
    available: () => available,
    async read() { ops.push("read"); return current; },
    async write(v) { ops.push("write"); if (writeFails) throw new Error("HTTP 429"); current = v; },
    async delete() { ops.push("delete"); current = null; },
  };
}

function fakeRun({ service = CF_SERVICE_READY, serviceCode = 0, key = KEY_STDOUT, createKeyCode = 0, createKeyExists = false } = {}) {
  const calls = [];
  const logLines = [];
  const run = async (cmd, args, opts = {}) => {
    calls.push({ args, opts });
    logLines.push(opts.logCmd || `${cmd} ${args.join(" ")}`);
    if (args[0] === "service") return { code: serviceCode, stdout: serviceCode === 0 ? service : "", stderr: serviceCode === 0 ? "" : "Service instance 'x' not found\nFAILED" };
    if (args[0] === "create-service-key") {
      if (createKeyExists) return { code: 1, stdout: "", stderr: "Service key figaf-manager already exists\nFAILED" };
      return { code: createKeyCode, stdout: createKeyCode === 0 ? "OK" : "", stderr: createKeyCode === 0 ? "" : "Service instance not found\nFAILED" };
    }
    if (args[0] === "service-key") return { code: 0, stdout: key, stderr: "" };
    if (args[0] === "delete-service-key") return { code: 0, stdout: "OK", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  return { run, calls, logLines, seq: () => calls.map((c) => c.args[0]) };
}

function make(opts = {}) {
  const r = fakeRun(opts.run || {});
  const pg = fakePg(opts.pg || {});
  const store = fakeStore(opts.store || {});
  const log = (source, type, text) => r.logLines.push(text);
  const inst = db.createFaidDatabase({ run: r.run, log, resolveCf: () => "cf", entryStore: store, pg, now: () => 1_700_000_000_000, newPassword: () => opts.password || "GeneratedPassword1234567890abcdEF" });
  return { inst, r, pg, store };
}

const assertNoSecret = (lines, secrets) => {
  const text = JSON.stringify(lines);
  for (const s of secrets) assert.ok(!text.includes(s), `secret ${s.slice(0, 6)}… leaked into: ${text.slice(0, 400)}`);
};

// ─── A. pure helpers ─────────────────────────────────────────────────────────

test("validateInstanceName: default and custom names pass; empty, too long, odd characters and a leading dash are refused", () => {
  assert.deepEqual(db.validateInstanceName("figaf-db"), { ok: true, name: "figaf-db" });
  assert.deepEqual(db.validateInstanceName("  my_db.prod-1  "), { ok: true, name: "my_db.prod-1" });
  assert.equal(db.validateInstanceName("").ok, false);
  assert.equal(db.validateInstanceName(null).ok, false);
  assert.equal(db.validateInstanceName("-f").ok, false, "a leading dash would read as a cf flag");
  assert.equal(db.validateInstanceName("a b").ok, false);
  assert.equal(db.validateInstanceName("x".repeat(51)).ok, false);
  assert.match(db.validateInstanceName("a;b").error, /not a valid service instance name/);
});

test("parseServiceKeyOutput + connectionFromKey: the JSON after the header, unwrapped; TLS from sslrootcert; incomplete keys are null", () => {
  const key = db.parseServiceKeyOutput(KEY_STDOUT);
  assert.equal(key.username, "dbo-user-1");
  const c = db.connectionFromKey(key);
  assert.equal(c.host, "postgres-x.rds.amazonaws.com");
  assert.equal(c.port, 1234);
  assert.equal(c.database, "ABCDEF");
  assert.equal(c.user, "dbo-user-1");
  assert.equal(c.ssl.rejectUnauthorized, true);
  assert.match(c.ssl.ca, /BEGIN CERTIFICATE/);
  assert.equal(db.parseServiceKeyOutput("no json here\nFAILED"), null);
  assert.equal(db.connectionFromKey({ hostname: "h" }), null);
  assert.equal(db.connectionFromKey(db.parseServiceKeyOutput('{"hostname":"h","dbname":"d","username":"u","password":"p"}')).ssl.rejectUnauthorized, true);
});

test("parseCfService: guid, offering, plan, status word and bound apps; a missing instance", () => {
  const s = db.parseCfService(0, CF_SERVICE_READY);
  assert.equal(s.exists, true);
  assert.equal(s.guid, "0c2679b7-2e79-464d-8abe-f9d1797e0af2");
  assert.equal(s.offering, "postgresql-db");
  assert.equal(s.plan, "standard");
  assert.equal(s.status, "ready");
  assert.deepEqual(s.boundApps, ["irt-app"]);
  const n = db.parseCfService(0, CF_SERVICE_NO_APPS);
  assert.deepEqual(n.boundApps, []);
  assert.equal(db.parseCfService(0, CF_SERVICE_READY.replace("create succeeded", "delete in progress")).status, "in-progress");
  assert.equal(db.parseCfService(0, CF_SERVICE_READY.replace("create succeeded", "create failed")).status, "failed");
  const m = db.parseCfService(1, "");
  assert.equal(m.exists, false);
  assert.equal(m.status, "missing");
});

test("parseCfServices: rows by header column positions; multi-word cells and app lists stay whole", () => {
  const rows = db.parseCfServices(CF_SERVICES);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], { name: "figaf-db", offering: "postgresql-db", plan: "standard", boundApps: ["irt-app", "other-x"], operation: "create succeeded" });
  assert.deepEqual(rows[2].boundApps, []);
  assert.equal(rows[2].operation, "create in progress");
  assert.deepEqual(db.parseCfServices("Getting service instances...\n\nNo service instances found\n"), []);
});

test("the SQL: role reconcile, plain schema (owned by dbo), grant, search_path; teardown in one transaction with timeouts; identifiers validated", () => {
  const st = db.prepareStatements("GeneratedPassword1234567890abcdEF");
  assert.deepEqual(st.map((s) => s.step), ["role", "schema", "grant", "grant"]);
  assert.match(st[0].sql, /IF EXISTS \(SELECT FROM pg_roles WHERE rolname = 'faid_app'\)/);
  assert.match(st[0].sql, /ALTER ROLE "faid_app" WITH LOGIN PASSWORD 'GeneratedPassword1234567890abcdEF'/);
  assert.match(st[0].sql, /CREATE ROLE "faid_app" WITH LOGIN PASSWORD/);
  assert.equal(st[1].sql, 'CREATE SCHEMA IF NOT EXISTS "faid";');
  assert.ok(!/AUTHORIZATION/.test(st[1].sql), "no AUTHORIZATION: dbo owns the schema");
  assert.equal(st[2].sql, 'GRANT USAGE, CREATE ON SCHEMA "faid" TO "faid_app";');
  assert.equal(st[3].sql, 'ALTER ROLE "faid_app" SET search_path TO "faid";');
  assert.throws(() => db.prepareStatements("short"), /invalid generated password/);
  assert.throws(() => db.prepareStatements("has'quote1234567890abcdefgh"), /invalid generated password/);
  const td = db.teardownStatements();
  assert.deepEqual(td, ["BEGIN;", "SET lock_timeout = '10s';", "SET statement_timeout = '60s';", 'DROP SCHEMA IF EXISTS "faid" CASCADE;', 'DROP ROLE IF EXISTS "faid_app";', "COMMIT;"]);
  assert.equal(db.validateIdentifier("faid_app"), true);
  assert.equal(db.validateIdentifier("Faid"), false);
  assert.equal(db.validateIdentifier("1x"), false);
  assert.equal(db.generatePassword().length, 32);
  assert.match(db.generatePassword(), /^[A-Za-z0-9]{32}$/);
});

test("entryValue: what the backend reads; pgErrorText masks secrets and keeps the SQLSTATE", () => {
  const c = db.connectionFromKey(db.parseServiceKeyOutput(KEY_STDOUT));
  const e = db.entryValue({ connection: c, password: "P".repeat(32), instanceName: "figaf-db", instanceGuid: "g1" });
  assert.equal(e.host, "postgres-x.rds.amazonaws.com");
  assert.equal(e.port, 1234);
  assert.equal(e.dbname, "ABCDEF");
  assert.equal(e.user, "faid_app");
  assert.equal(e.schema, "faid");
  assert.equal(e.instanceName, "figaf-db");
  assert.equal(e.instanceGuid, "g1");
  assert.ok(!("sslrootcert" in e), "the certificate is not in the entry: the manager sets it on the backend as FAID_DATABASE_CA");
  assert.ok(!("sslrootcertParts" in e));
  assert.equal(db.KEY_NAME, "figaf-manager");
  assert.equal(db.CA_ENV, "FAID_DATABASE_CA");
  assert.ok(!("username" in e));
  const err = new Error("auth failed for pw SECRET1"); err.code = "28P01";
  assert.equal(db.pgErrorText(err, ["SECRET1"]), "auth failed for pw <hidden> [28P01]");
});

// ─── B. prepare ──────────────────────────────────────────────────────────────

test("prepare: cf service, create-service-key figaf-manager, masked service-key read, SQL as dbo, verification as faid_app, entry written — in that order; the key stays; no secret anywhere", async () => {
  const { inst, r, pg, store } = make();
  const res = await inst.prepare({ instanceName: "figaf-db" });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.instanceName, "figaf-db");
  assert.equal(res.instanceGuid, "0c2679b7-2e79-464d-8abe-f9d1797e0af2");
  assert.equal(res.passwordReused, false);
  assert.equal(res.verify.isolationChecked, true);
  assert.equal(res.verify.checkedTable, "irt.agents");
  assert.equal(res.verify.currentSchema, "faid");

  assert.deepEqual(r.seq(), ["service", "create-service-key", "service-key"]);
  assert.deepEqual(r.calls[1].args, ["create-service-key", "figaf-db", "figaf-manager"]);
  const keyRead = r.calls[2];
  assert.deepEqual(keyRead.args, ["service-key", "figaf-db", "figaf-manager"]);
  assert.equal(keyRead.opts.quiet, true);
  assert.equal(keyRead.opts.auditStdout, false);
  assert.match(keyRead.opts.logCmd, /output not shown/);

  // Two connections: dbo (statements + the table lookup), then faid_app (verification).
  assert.equal(pg.clients.length, 2);
  const [dbo, role] = pg.clients;
  assert.equal(dbo.cfg.user, "dbo-user-1");
  assert.equal(dbo.cfg.host, "postgres-x.rds.amazonaws.com");
  assert.equal(dbo.cfg.ssl.rejectUnauthorized, true);
  assert.match(dbo.queries[0], /CREATE ROLE "faid_app"/);
  assert.equal(dbo.queries[1], 'CREATE SCHEMA IF NOT EXISTS "faid";');
  assert.equal(dbo.queries[2], 'GRANT USAGE, CREATE ON SCHEMA "faid" TO "faid_app";');
  assert.equal(dbo.queries[3], 'ALTER ROLE "faid_app" SET search_path TO "faid";');
  assert.match(dbo.queries[4], /information_schema\.tables/);
  assert.equal(dbo.ended, true);
  assert.equal(role.cfg.user, "faid_app");
  assert.equal(role.cfg.password, "GeneratedPassword1234567890abcdEF");
  assert.match(role.queries[0], /current_schema\(\)/);
  assert.equal(role.queries[1], 'SELECT 1 FROM "irt"."agents" LIMIT 1');
  assert.equal(role.ended, true);

  assert.deepEqual(store.ops, ["read", "write"]);
  assert.equal(store.entry.user, "faid_app");
  assert.equal(store.entry.password, "GeneratedPassword1234567890abcdEF");
  assert.equal(store.entry.dbname, "ABCDEF");
  assert.equal(store.entry.instanceName, "figaf-db");
  assert.equal(store.entry.instanceGuid, "0c2679b7-2e79-464d-8abe-f9d1797e0af2");
  assert.ok(!("sslrootcert" in store.entry));

  assertNoSecret(r.logLines, ["DBO-SECRET-PASSWORD", "GeneratedPassword1234567890abcdEF"]);
  assertNoSecret([res], ["DBO-SECRET-PASSWORD", "GeneratedPassword1234567890abcdEF"]);
});

test("prepare: the password is reused when an entry exists (a running backend is never surprised); host/port/dbname are refreshed", async () => {
  const { inst, pg, store } = make({ store: { entry: { host: "old-host", port: 1, dbname: "OLD", user: "faid_app", password: "KeptPasswordKeptPasswordKeptPass", schema: "faid", instanceName: "figaf-db" } } });
  const res = await inst.prepare({ instanceName: "figaf-db" });
  assert.equal(res.ok, true);
  assert.equal(res.passwordReused, true);
  assert.match(pg.clients[0].queries[0], /PASSWORD 'KeptPasswordKeptPasswordKeptPass'/);
  assert.equal(store.entry.password, "KeptPasswordKeptPasswordKeptPass");
  assert.equal(store.entry.host, "postgres-x.rds.amazonaws.com");
  assert.equal(store.entry.dbname, "ABCDEF");
});

test("prepare: a fresh instance without another schema's table — the denial check is skipped and the result says so", async () => {
  const { inst } = make({ pg: { foreignTable: null }, run: { service: CF_SERVICE_NO_APPS } });
  const res = await inst.prepare({ instanceName: "faid-only-db" });
  assert.equal(res.ok, true);
  assert.equal(res.verify.isolationChecked, false);
  assert.match(res.verify.note, /skipped/);
});

test("prepare refusals before any cf change: bad name, Credential Store not bound, instance missing / not ready / wrong offering", async () => {
  let m = make();
  let res = await inst_(m).prepare({ instanceName: "a b" });
  assert.equal(res.ok, false); assert.equal(res.step, "instance"); assert.deepEqual(m.r.seq(), []);

  m = make({ store: { available: false } });
  res = await inst_(m).prepare({ instanceName: "figaf-db" });
  assert.equal(res.step, "store"); assert.match(res.error, /not bound to the manager/); assert.deepEqual(m.r.seq(), []);

  m = make({ run: { serviceCode: 1 } });
  res = await inst_(m).prepare({ instanceName: "figaf-db" });
  assert.equal(res.step, "instance"); assert.match(res.error, /does not exist/); assert.deepEqual(m.r.seq(), ["service"]);

  m = make({ run: { service: CF_SERVICE_READY.replace("create succeeded", "create in progress") } });
  res = await inst_(m).prepare({ instanceName: "figaf-db" });
  assert.equal(res.step, "instance"); assert.match(res.error, /not ready \(create in progress\)/); assert.deepEqual(m.r.seq(), ["service"]);

  m = make({ run: { service: CF_SERVICE_READY.replace("offering:        postgresql-db", "offering:        xsuaa") } });
  res = await inst_(m).prepare({ instanceName: "figaf-db" });
  assert.equal(res.step, "instance"); assert.match(res.error, /is a xsuaa instance/);
  function inst_(x) { return x.inst; }
});

test("prepare: an existing key figaf-manager is reused (\"already exists\" is success); a failed owner connection or statement stops the run with its step; a key that cannot be created stops everything", async () => {
  let m = make({ run: { createKeyExists: true } });
  let res = await m.inst.prepare({ instanceName: "figaf-db" });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(m.r.seq(), ["service", "create-service-key", "service-key"]);

  m = make({ pg: { connectFails: (user) => user === "dbo-user-1" } });
  res = await m.inst.prepare({ instanceName: "figaf-db" });
  assert.equal(res.ok, false);
  assert.equal(res.step, "connect");
  assert.match(res.error, /as the owner failed/);
  assert.deepEqual(m.r.seq(), ["service", "create-service-key", "service-key"]);
  assert.deepEqual(m.store.ops, ["read"], "nothing written");
  assertNoSecret([res, m.r.logLines], ["DBO-SECRET-PASSWORD"]);

  m = make({ pg: { failStatement: "GRANT USAGE" } });
  res = await m.inst.prepare({ instanceName: "figaf-db" });
  assert.equal(res.ok, false);
  assert.equal(res.step, "grant");
  assert.match(res.error, /\[42601\]/);
  assert.equal(m.pg.clients[0].ended, true);
  assertNoSecret([res, m.r.logLines], ["DBO-SECRET-PASSWORD", "GeneratedPassword1234567890abcdEF"]);

  m = make({ run: { createKeyCode: 1 } });
  res = await m.inst.prepare({ instanceName: "figaf-db" });
  assert.equal(res.step, "key");
  assert.deepEqual(m.r.seq(), ["service", "create-service-key"]);
  assert.equal(m.pg.clients.length, 0);
});

test("prepare: when faid_app CAN read another schema's table, the run is a refusal and nothing is stored", async () => {
  const m = make({ pg: { roleCanRead: true } });
  const res = await m.inst.prepare({ instanceName: "figaf-db" });
  assert.equal(res.ok, false);
  assert.equal(res.step, "verify");
  assert.match(res.error, /could read irt\.agents/);
  assert.deepEqual(m.store.ops, ["read"]);
  assert.deepEqual(m.r.seq(), ["service", "create-service-key", "service-key"]);
});

test("prepare: a wrong current_schema() as faid_app is a refusal; a failed entry write names the store step", async () => {
  let m = make({ pg: { currentSchema: "public" } });
  let res = await m.inst.prepare({ instanceName: "figaf-db" });
  assert.equal(res.step, "verify");
  assert.match(res.error, /current_schema\(\) as faid_app is "public"/);

  m = make({ store: { writeFails: true } });
  res = await m.inst.prepare({ instanceName: "figaf-db" });
  assert.equal(res.step, "store");
  assert.match(res.error, /HTTP 429/);
  assert.deepEqual(m.r.seq(), ["service", "create-service-key", "service-key"]);
});

// ─── C. rotate, drop, status ─────────────────────────────────────────────────

const PREPARED = { host: "postgres-x.rds.amazonaws.com", port: 1234, dbname: "ABCDEF", user: "faid_app", password: "OldPasswordOldPasswordOldPass123", schema: "faid", instanceName: "figaf-db", instanceGuid: "0c2679b7-2e79-464d-8abe-f9d1797e0af2" };

test("rotate: ALTER ROLE with a new password on the entry's instance, verification, entry updated, restart required; refused without an entry", async () => {
  const m = make({ store: { entry: { ...PREPARED } }, password: "NewPasswordNewPasswordNewPass1234" });
  const res = await m.inst.rotate();
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.restartRequired, true);
  assert.equal(res.instanceName, "figaf-db");
  assert.deepEqual(m.r.seq(), ["service", "create-service-key", "service-key"]);
  assert.deepEqual(m.pg.clients[0].queries.filter((q) => /ALTER ROLE/.test(q)), ['ALTER ROLE "faid_app" WITH LOGIN PASSWORD \'NewPasswordNewPasswordNewPass1234\';']);
  assert.equal(m.pg.clients[1].cfg.password, "NewPasswordNewPasswordNewPass1234");
  assert.equal(m.store.entry.password, "NewPasswordNewPasswordNewPass1234");
  assertNoSecret([res, m.r.logLines], ["NewPasswordNewPasswordNewPass1234", "OldPasswordOldPasswordOldPass123", "DBO-SECRET-PASSWORD"]);

  const none = make();
  const r2 = await none.inst.rotate();
  assert.equal(r2.ok, false);
  assert.match(r2.error, /not prepared/);
  assert.deepEqual(none.r.seq(), []);
});

test("drop: one transaction (BEGIN, timeouts, DROP SCHEMA CASCADE, DROP ROLE, COMMIT), entry deleted, the standing key deleted; a gone instance only deletes the entry; refused without an entry", async () => {
  const m = make({ store: { entry: { ...PREPARED } } });
  const res = await m.inst.drop();
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.keyDeleted, true);
  assert.deepEqual(m.pg.clients[0].queries, ["BEGIN;", "SET lock_timeout = '10s';", "SET statement_timeout = '60s';", 'DROP SCHEMA IF EXISTS "faid" CASCADE;', 'DROP ROLE IF EXISTS "faid_app";', "COMMIT;"]);
  assert.equal(m.pg.clients.length, 1, "no verification connection on drop");
  assert.deepEqual(m.store.ops, ["read", "delete"]);
  assert.deepEqual(m.r.seq(), ["service", "create-service-key", "service-key", "delete-service-key"]);
  assert.deepEqual(m.r.calls[3].args, ["delete-service-key", "figaf-db", "figaf-manager", "-f"]);

  const gone = make({ store: { entry: { ...PREPARED } }, run: { serviceCode: 1 } });
  const r2 = await gone.inst.drop();
  assert.equal(r2.ok, true);
  assert.equal(r2.instanceGone, true);
  assert.deepEqual(gone.store.ops, ["read", "delete"]);
  assert.deepEqual(gone.r.seq(), ["service"]);

  const failing = make({ store: { entry: { ...PREPARED } }, pg: { failStatement: "DROP ROLE" } });
  const r3 = await failing.inst.drop();
  assert.equal(r3.ok, false);
  assert.equal(r3.step, "role");
  assert.ok(failing.pg.clients[0].queries.includes("ROLLBACK;"));
  assert.deepEqual(failing.store.ops, ["read"], "the entry stays when the drop failed");

  const none = make();
  assert.equal((await none.inst.drop()).ok, false);
});

test("status: unknown without the binding; not-prepared without an entry; prepared when the entry matches a ready instance; stale when the instance is gone or re-created", async () => {
  assert.equal((await make({ store: { available: false } }).inst.status()).state, "unknown");
  const none = await make().inst.status();
  assert.equal(none.state, "not-prepared");
  assert.equal(none.prepared, false);
  assert.equal(none.instanceName, null);

  const ok = await make({ store: { entry: { ...PREPARED } } }).inst.status();
  assert.equal(ok.state, "prepared");
  assert.equal(ok.prepared, true);
  assert.equal(ok.instanceName, "figaf-db");
  assert.equal(ok.role, "faid_app");
  assert.equal(ok.schema, "faid");

  const gone = await make({ store: { entry: { ...PREPARED } }, run: { serviceCode: 1 } }).inst.status();
  assert.equal(gone.state, "stale");
  assert.match(gone.reason, /no longer exists/);

  const recreated = await make({ store: { entry: { ...PREPARED, instanceGuid: "other-guid" } } }).inst.status();
  assert.equal(recreated.state, "stale");
  assert.match(recreated.reason, /re-created/);

  const creating = await make({ store: { entry: { ...PREPARED } }, run: { service: CF_SERVICE_READY.replace("create succeeded", "update in progress") } }).inst.status();
  assert.equal(creating.state, "stale");
  assert.equal(creating.prepared, false);
});

test("createEntryStore: one entry backend-database in namespace figaf-faid; read parses it; delete removes it", async () => {
  const stored = new Map();
  const calls = [];
  const client = {
    findCredstoreBinding: () => ({ url: "u" }),
    async readCredential(b, { namespace, name }) { calls.push(`read ${namespace}/${name}`); const v = stored.get(name); return v === undefined ? null : { name, value: v }; },
    async writeCredential(b, { namespace, name, value, username }) { calls.push(`write ${namespace}/${name} ${username}`); assert.ok(value.length < 1000, `entry stays small: ${value.length}`); stored.set(name, value); },
    async deleteCredential(b, { namespace, name }) { calls.push(`delete ${namespace}/${name}`); stored.delete(name); },
  };
  const store = db.createEntryStore({ client });
  assert.equal(store.available(), true);
  assert.equal(await store.read(), null);
  await store.write({ host: "h", port: 1, dbname: "d", user: "faid_app", password: "P".repeat(32), schema: "faid", instanceName: "figaf-db", instanceGuid: "g" });
  assert.deepEqual(calls.filter((c) => c.startsWith("write")), ["write figaf-faid/backend-database faid_app"]);
  const back = await store.read();
  assert.equal(back.password, "P".repeat(32));
  assert.equal(back.instanceName, "figaf-db");
  await store.delete();
  assert.deepEqual([...stored.keys()], []);
  assert.equal(db.createEntryStore({ client: { findCredstoreBinding: () => null } }).available(), false);
});

test("certificateChain: the CA chain from the standing key (created when missing), with the backend's variable name; the owner password is not in the result", async () => {
  const m = make();
  const r = await m.inst.certificateChain({ instanceName: "figaf-db" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.envName, "FAID_DATABASE_CA");
  assert.match(r.sslrootcert, /BEGIN CERTIFICATE/);
  assert.deepEqual(m.r.seq(), ["create-service-key", "service-key"]);
  assertNoSecret([r, m.r.logLines], ["DBO-SECRET-PASSWORD"]);
  assert.equal((await m.inst.certificateChain({ instanceName: "a b" })).ok, false);
  const noCa = make({ run: { key: KEY_STDOUT.replace(/"sslrootcert": "[^"]*",\n/, "") } });
  const r2 = await noCa.inst.certificateChain({ instanceName: "figaf-db" });
  assert.equal(r2.ok, false);
  assert.match(r2.error, /no CA certificate/);
  const bad = make({ run: { createKeyCode: 1 } });
  assert.equal((await bad.inst.certificateChain({ instanceName: "figaf-db" })).step, "key");
});
