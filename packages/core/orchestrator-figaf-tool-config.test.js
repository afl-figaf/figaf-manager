"use strict";
// Tests for the Figaf Tool deploy configuration handlers (2026-09-08):
//   config:writeVars   the two required instance names, patched into
//                      manifest.yml and xs-security.json from a PRISTINE copy
//   cf:createService   "already exists" counts only when the instance is in
//                      this space
//   cf:services        the parsed listing the Configuration screen reads
//
// Harness: patch child_process.spawn BEFORE requiring the orchestrator (repo
// pattern); the deploy templates are the bundled copy in
// packages/deploy-templates, copied into a temp user dir.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const child_process = require("child_process");
const EventEmitter = require("events");
const fs = require("fs");
const os = require("os");
const path = require("path");

const spawnCalls = [];
let responses = []; // [{ match: (args)=>bool, stdout, stderr, code }]

function popResponse(args) {
  for (let i = 0; i < responses.length; i++) {
    const r = responses[i];
    if (!r.match || r.match(args)) { responses.splice(i, 1); return r; }
  }
  return { stdout: "", stderr: "", code: 0 };
}

child_process.spawn = function fakeSpawn(cmd, args, opts) {
  spawnCalls.push({ cmd, args: args.slice(), opts });
  const resp = popResponse(args);
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = { write: () => {}, end: () => {} };
  proc.killed = false;
  setImmediate(() => {
    if (resp.stdout) proc.stdout.emit("data", Buffer.from(resp.stdout));
    if (resp.stderr) proc.stderr.emit("data", Buffer.from(resp.stderr));
    proc.emit("close", resp.code || 0);
  });
  return proc;
};

const { createOrchestrator } = require("./orchestrator");
const { createAuditLogger } = require("./audit-log");

const TEMPLATES = path.join(__dirname, "..", "deploy-templates");

function makeHost(userDir) {
  return {
    isHosted: true,
    getUserDataDir: () => userDir,
    resolveBinary: (name) => name,
    pickFile: async () => null,
    openExternal: async () => {},
    readClipboard: async () => "",
    writeClipboard: async () => ({ ok: false }),
    resolveDeployTemplate: () => ({ kind: "bundle", src: TEMPLATES }),
    getInstalledVersion: () => "0.0.0",
    getUpdateStagingDir: () => userDir,
    getDeployTargetForSelf: () => null,
  };
}

function fresh() {
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "figaf-tool-config-"));
  const audit = createAuditLogger({ level: "cli", sink: () => {} });
  const { handlers } = createOrchestrator({ host: makeHost(userDir), send: () => {}, audit });
  const deployDir = path.join(userDir, "deploy");
  const read = (f) => fs.readFileSync(path.join(deployDir, f), "utf8");
  const lines = (f, re) => read(f).split(/\r?\n/).filter((l) => re.test(l));
  return { handlers, deployDir, read, lines };
}

const BASE_VARS = { id: "figaf-tool", domain: "cfapps.eu10-004.hana.ondemand.com", dockerVersion: "2409-btp" };

test("writeVars with the defaults keeps figaf-db and figaf-xsuaa, sets xsappname, keeps pristine copies", async () => {
  const { handlers, deployDir, read, lines } = fresh();
  const r = await handlers["config:writeVars"]({ ...BASE_VARS });
  assert.equal(r.ok, true);
  assert.equal(r.dbServiceName, "figaf-db");
  assert.equal(r.xsuaaServiceName, "figaf-xsuaa");
  assert.deepEqual(lines("manifest.yml", /figaf-db/), ["  - figaf-db"]);
  assert.deepEqual(lines("manifest.yml", /figaf-xsuaa/), ["  - figaf-xsuaa", "    - figaf-xsuaa"]);
  assert.equal(JSON.parse(read("xs-security.json")).xsappname, "figaf-xsuaa");
  assert.ok(fs.existsSync(path.join(deployDir, "manifest.yml.template")));
  assert.ok(fs.existsSync(path.join(deployDir, "xs-security.json.template")));
  assert.match(read("vars.yml"), /^ID: figaf-tool$/m);
});

test("writeVars renames both instances everywhere and moves the xsappname; a later run with the defaults restores the template", async () => {
  const { handlers, read, lines } = fresh();
  const r = await handlers["config:writeVars"]({ ...BASE_VARS, dbServiceName: " shared-pg ", xsuaaServiceName: "figaf-tool2-xsuaa", enableConnectivity: true });
  assert.equal(r.ok, true);
  assert.equal(r.dbServiceName, "shared-pg");
  assert.deepEqual(lines("manifest.yml", /shared-pg|figaf-db/), ["  - shared-pg"]);
  assert.deepEqual(lines("manifest.yml", /xsuaa/), ["  - figaf-tool2-xsuaa", "    - figaf-tool2-xsuaa"]);
  assert.deepEqual(lines("manifest.yml", /figaf-connectivity/), ["  - figaf-connectivity"]);
  assert.equal(JSON.parse(read("xs-security.json")).xsappname, "figaf-tool2-xsuaa");

  // Second deployment in the same container: the patched files are not the
  // starting point, the pristine copies are.
  const r2 = await handlers["config:writeVars"]({ ...BASE_VARS });
  assert.equal(r2.ok, true);
  assert.deepEqual(lines("manifest.yml", /figaf-db|shared-pg/), ["  - figaf-db"]);
  assert.deepEqual(lines("manifest.yml", /xsuaa/), ["  - figaf-xsuaa", "    - figaf-xsuaa"]);
  assert.deepEqual(lines("manifest.yml", /figaf-connectivity/), ["#  - figaf-connectivity"]);
  assert.equal(JSON.parse(read("xs-security.json")).xsappname, "figaf-xsuaa");
});

test("writeVars refuses an invalid instance name before touching any file", async () => {
  const { handlers, deployDir } = fresh();
  const r = await handlers["config:writeVars"]({ ...BASE_VARS, xsuaaServiceName: "-bad name" });
  assert.equal(r.ok, false);
  assert.match(r.error, /^XSUAA service name: /);
  assert.ok(!fs.existsSync(path.join(deployDir, "manifest.yml.template")), "nothing was patched");
});

test("createService: 'already exists' on a failed create is refused when the instance is not in this space", async () => {
  const { handlers } = fresh();
  spawnCalls.length = 0;
  responses = [
    { match: (a) => a[0] === "create-service", stdout: "", stderr: "Service broker error: Application with xsappname 'figaf-xsuaa' already exists", code: 1 },
    { match: (a) => a[0] === "service", stdout: "", stderr: "Service instance 'figaf-xsuaa' not found.", code: 1 },
  ];
  const r = await handlers["cf:createService"]({ offering: "xsuaa", plan: "application", name: "figaf-xsuaa", configFile: "xs-security.json" });
  assert.equal(r.ok, false);
  assert.equal(r.alreadyExists, false);
  assert.match(r.stderr, /already exists/);
  assert.match(r.stderr, /not in this space/);
  assert.deepEqual(spawnCalls.map((c) => c.args[0]), ["create-service", "service"]);
});

test("createService: 'already exists' is a success when `cf service` finds the instance here", async () => {
  const { handlers } = fresh();
  responses = [
    { match: (a) => a[0] === "create-service", stdout: "Service instance figaf-db already exists", stderr: "", code: 1 },
    { match: (a) => a[0] === "service", stdout: "name: figaf-db\nstatus: create succeeded", stderr: "", code: 0 },
  ];
  const r = await handlers["cf:createService"]({ offering: "postgresql-db", plan: "free", name: "figaf-db", configFile: "db.json" });
  assert.equal(r.ok, true);
  assert.equal(r.alreadyExists, true);
});

test("createService: a clean create is a success without a second call", async () => {
  const { handlers } = fresh();
  spawnCalls.length = 0;
  responses = [{ match: (a) => a[0] === "create-service", stdout: "Creating service instance figaf-db...\nOK", stderr: "", code: 0 }];
  const r = await handlers["cf:createService"]({ offering: "postgresql-db", plan: "free", name: "figaf-db" });
  assert.equal(r.ok, true);
  assert.equal(r.alreadyExists, false);
  assert.deepEqual(spawnCalls.map((c) => c.args[0]), ["create-service"]);
});

test("cf:services parses the listing of the space", async () => {
  const { handlers } = fresh();
  responses = [{
    match: (a) => a[0] === "services",
    stdout: [
      "Getting service instances in org figafpartner-1 / space figaf-faid as ais@figaf.com...",
      "",
      "name                  offering        plan          bound apps            last operation     broker              upgrade available",
      "figaf-db              postgresql-db   free          figaf-faid-backend    create succeeded   postgresql-broker   no",
      "figaf-faid-xsuaa      xsuaa           application                         create succeeded   xsuaa               no",
    ].join("\n"),
    code: 0,
  }];
  const r = await handlers["cf:services"]();
  assert.equal(r.ok, true);
  assert.deepEqual(r.services.map((s) => [s.name, s.offering, s.plan]), [
    ["figaf-db", "postgresql-db", "free"],
    ["figaf-faid-xsuaa", "xsuaa", "application"],
  ]);
  responses = [{ match: (a) => a[0] === "services", stdout: "", stderr: "Not logged in.", code: 1 }];
  const bad = await handlers["cf:services"]();
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.services, []);
});
