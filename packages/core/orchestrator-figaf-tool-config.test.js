"use strict";
// Tests for the Figaf Tool deploy configuration handlers (2026-09-08):
//   config:writeVars   the two required instance names, patched into
//                      manifest.yml and xs-security.json from a PRISTINE copy
//   cf:createService   "already exists" counts only when the instance is in
//                      this space
//   cf:services        the parsed listing the Configuration screen reads
// and the additional environment variables (gap G1, 2026-09-14):
//   config:writeVars          the free-form rows land in the manifest's env block
//   update:readCurrentConfig  what is live, minus the keys the template owns
//   update:writeVars          a removed row is unset on the app
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

// ─── Additional environment variables (gap G1, 2026-09-14) ──────────────────
// The round trip the gap asks for: deploy writes the rows into the manifest,
// an update reads back what is LIVE (including a `cf set-env` run by hand),
// and a row the operator removed is unset instead of lingering on the app.

const APP_GUID = "0e4c7a10-1111-2222-3333-444455556666";
const guidReply = { match: (a) => a[0] === "app" && a[1] === "--guid", stdout: `${APP_GUID}\n`, code: 0 };
const envReply = (v) => ({
  match: (a) => a[0] === "curl" && a[1].includes("environment_variables"),
  stdout: JSON.stringify({ var: v }),
  code: 0,
});

test("writeVars writes the named fields and the additional rows into the app block of the manifest", async () => {
  const { handlers, read, lines } = fresh();
  const r = await handlers["config:writeVars"]({
    ...BASE_VARS,
    additionalIrtParameters: "  --irt.some.property=1 --irt.other=2  ",
    additionalJvmArguments: "-Xss2m",
    additionalEnv: { IRT_ROOT_LOGGING_LEVEL: "DEBUG" },
  });
  assert.equal(r.ok, true);
  // Named fields first (trimmed), then the table.
  assert.deepEqual(lines("manifest.yml", /ADDITIONAL_|IRT_ROOT_LOGGING_LEVEL/), [
    "    ADDITIONAL_IRT_PARAMETERS: '--irt.some.property=1 --irt.other=2'",
    "    ADDITIONAL_JVM_ARGUMENTS: '-Xss2m'",
    "    IRT_ROOT_LOGGING_LEVEL: 'DEBUG'",
  ]);
  // An empty named field writes nothing - the variable stays absent.
  const r3 = await handlers["config:writeVars"]({ ...BASE_VARS, additionalIrtParameters: "   ", additionalJvmArguments: "" });
  assert.equal(r3.ok, true);
  assert.deepEqual(lines("manifest.yml", /ADDITIONAL_/), []);
  assert.deepEqual(r3.env, {});
  // The router's block and the template's own keys are untouched.
  assert.match(read("manifest.yml"), /^    httpHeaders: >$/m);
  assert.match(read("manifest.yml"), /^    LOCATION_ID: \(\(LOCATION_ID\)\)$/m);

  // A later deployment without extras starts from the pristine copy again.
  const r2 = await handlers["config:writeVars"]({ ...BASE_VARS });
  assert.equal(r2.ok, true);
  assert.deepEqual(lines("manifest.yml", /IRT_ROOT_LOGGING_LEVEL/), []);
});

test("writeVars refuses a bad environment row before touching any file", async () => {
  const { handlers, deployDir } = fresh();
  const r = await handlers["config:writeVars"]({ ...BASE_VARS, additionalEnv: { MAX_RAM_PERCENTAGE: "70" } });
  assert.equal(r.ok, false);
  assert.match(r.error, /has its own field/);
  assert.ok(!fs.existsSync(path.join(deployDir, "manifest.yml.template")), "nothing was patched");
});

test("readCurrentConfig reports every live variable the template does not own, including a hand-run cf set-env", async () => {
  const { handlers } = fresh();
  responses = [
    guidReply,
    envReply({
      LOCATION_ID: "loc-1",
      MAX_RAM_PERCENTAGE: "50",
      BTP_APP_ROUTER_URL: "https://figaf-tool.cfapps.eu10-004.hana.ondemand.com",
      IRT_ROOT_LOGGING_LEVEL: "DEBUG",
      SOMETHING_BY_HAND: "yes",
    }),
  ];
  const r = await handlers["update:readCurrentConfig"]({ deployId: "figaf-tool" });
  assert.equal(r.ok, true);
  assert.deepEqual(r.vars.additionalEnv, { IRT_ROOT_LOGGING_LEVEL: "DEBUG", SOMETHING_BY_HAND: "yes" });
  // The named fields still come from the same read.
  assert.equal(r.vars.locationId, "loc-1");
  assert.equal(r.vars.domain, "cfapps.eu10-004.hana.ondemand.com");
});

test("update:writeVars unsets exactly the additional variables the operator removed", async () => {
  const { handlers, lines } = fresh();
  spawnCalls.length = 0;
  responses = [
    guidReply,
    envReply({ LOCATION_ID: "loc-1", IRT_ROOT_LOGGING_LEVEL: "DEBUG", SOMETHING_BY_HAND: "yes" }),
  ];
  const r = await handlers["update:writeVars"]({
    deployId: "figaf-tool",
    dockerTag: "2409-btp",
    vars: { ...BASE_VARS, additionalEnv: { IRT_ROOT_LOGGING_LEVEL: "INFO" } },
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.unsetEnv, ["SOMETHING_BY_HAND"]);
  const unsets = spawnCalls.filter((c) => c.args[0] === "unset-env").map((c) => c.args);
  assert.deepEqual(unsets, [["unset-env", "figaf-tool-app", "SOMETHING_BY_HAND"]]);
  // The kept row is written with its new value, not unset.
  assert.deepEqual(lines("manifest.yml", /IRT_ROOT_LOGGING_LEVEL/), ["    IRT_ROOT_LOGGING_LEVEL: 'INFO'"]);
});

test("update:writeVars unsets nothing when the Update form never received a live environment", async () => {
  const { handlers } = fresh();
  spawnCalls.length = 0;
  responses = [guidReply, envReply({ SOMETHING_BY_HAND: "yes" })];
  // No `additionalEnv` at all: readCurrentConfig could not read the environment,
  // so the table was never shown. Silence must not mean "remove them all".
  const r = await handlers["update:writeVars"]({ deployId: "figaf-tool", dockerTag: "2409-btp", vars: { ...BASE_VARS } });
  assert.equal(r.ok, true);
  assert.deepEqual(r.unsetEnv, []);
  assert.equal(spawnCalls.filter((c) => c.args[0] === "unset-env").length, 0);
});

test("readCurrentConfig leaves additionalEnv unset when the environment response is unreadable", async () => {
  // An empty object would mean "the app has no extra variables" and would make
  // update:writeVars unset every one of them. Unreadable must stay silent.
  const { handlers } = fresh();
  responses = [
    guidReply,
    { match: (a) => a[0] === "curl" && a[1].includes("environment_variables"), stdout: "not json", code: 0 },
  ];
  const r = await handlers["update:readCurrentConfig"]({ deployId: "figaf-tool" });
  assert.equal(r.ok, true);
  assert.equal(r.partial, true);
  assert.equal("additionalEnv" in r.vars, false);
});

test("readCurrentConfig fills the named fields and leaves them out of the table", async () => {
  const { handlers } = fresh();
  responses = [
    guidReply,
    envReply({
      LOCATION_ID: "loc-1",
      ADDITIONAL_IRT_PARAMETERS: "--irt.a=1",
      ADDITIONAL_JVM_ARGUMENTS: "-Xss2m",
      SOMETHING_BY_HAND: "yes",
    }),
  ];
  const r = await handlers["update:readCurrentConfig"]({ deployId: "figaf-tool" });
  assert.equal(r.vars.additionalIrtParameters, "--irt.a=1");
  assert.equal(r.vars.additionalJvmArguments, "-Xss2m");
  assert.deepEqual(r.vars.additionalEnv, { SOMETHING_BY_HAND: "yes" });
});

test("update:writeVars unsets a named field the operator cleared, and keeps one that is still set", async () => {
  const { handlers, lines } = fresh();
  spawnCalls.length = 0;
  responses = [
    guidReply,
    envReply({ LOCATION_ID: "loc-1", ADDITIONAL_IRT_PARAMETERS: "--irt.a=1", ADDITIONAL_JVM_ARGUMENTS: "-Xss2m" }),
  ];
  const r = await handlers["update:writeVars"]({
    deployId: "figaf-tool",
    dockerTag: "2409-btp",
    // The JVM field was emptied on the Update form; the IRT one was changed.
    vars: { ...BASE_VARS, additionalIrtParameters: "--irt.a=2", additionalJvmArguments: "", additionalEnv: {} },
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.unsetEnv, ["ADDITIONAL_JVM_ARGUMENTS"]);
  assert.deepEqual(lines("manifest.yml", /ADDITIONAL_/), ["    ADDITIONAL_IRT_PARAMETERS: '--irt.a=2'"]);
  assert.deepEqual(spawnCalls.filter((c) => c.args[0] === "unset-env").map((c) => c.args[2]), ["ADDITIONAL_JVM_ARGUMENTS"]);
});
