"use strict";
// Tests for the role-assignment step of the persistent-SSO upgrade
// (docs/faid-apps-console/SPEC.md "Role assignment in the SSO upgrade", run #4 finding 2):
//   xsuaa:roleAssignmentPrecheck and xsuaa:assignRoleCollection.
//
// Harness: patch child_process.spawn BEFORE requiring the orchestrator (repo
// pattern), stub global.fetch for the credstore read, capture the audit sink.
//
// Coverage:
//   1. precheck without a BTP login: btpLoggedIn=false, cf user from cf target.
//   2. assign without a BTP login: refused with a clear error; no service key,
//      no `btp assign` spawned.
//   3. assign with a BTP login and no captured subaccount: GUID from a
//      throw-away service key (create -> read quietly, audit tail redacted ->
//      delete); `btp assign` gets the NAMED user and that GUID.
//   4. the GUID is cached: a second assign creates no service key.
//   5. a non-e-mail user is refused before anything runs.
//   6. precheck after login:withStoredUser: cfUserIsStoredUser=true.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const child_process = require("child_process");
const EventEmitter = require("events");
const fs = require("fs");
const os = require("os");
const path = require("path");

// ─── spawn stub with a per-test response queue ──────────────────────────────
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

// Require AFTER the spawn patch.
const { createOrchestrator } = require("./orchestrator");
const { createAuditLogger } = require("./audit-log");

// ─── credstore fixture (binding + JWE the fetch stub serves), for test 6 ────
const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });

function jweFor(payload) {
  const header = Buffer.from(JSON.stringify({ alg: "RSA-OAEP-256", enc: "A256GCM" })).toString("base64url");
  const cek = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", cek, iv);
  cipher.setAAD(Buffer.from(header, "ascii"));
  const ct = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  const encKey = crypto.publicEncrypt(
    { key: publicKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
    cek
  );
  return [header, encKey.toString("base64url"), iv.toString("base64url"), ct.toString("base64url"), cipher.getAuthTag().toString("base64url")].join(".");
}

const BINDING = {
  url: "https://credstore.example/api/v1/credentials",
  username: "bind-user",
  password: "bind-pass",
  encryption: {
    client_private_key: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
    server_public_key: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
  },
};

function makeHost(userDir) {
  return {
    isHosted: true,
    getUserDataDir: () => userDir,
    resolveBinary: (name) => name,
    pickFile: async () => null,
    openExternal: async () => {},
    readClipboard: async () => "",
    writeClipboard: async () => ({ ok: false }),
    resolveDeployTemplate: () => ({ kind: "bundle", src: userDir }),
    getInstalledVersion: () => "0.0.0",
    getUpdateStagingDir: () => userDir,
    getDeployTargetForSelf: () => ({
      apiUrl: "https://api.cf.eu10-004.hana.ondemand.com",
      orgName: "figafpartner-1",
      spaceName: "figaf-platform",
      appName: "figaf-manager",
      uris: ["figaf-manager-x.cfapps.eu10-004.hana.ondemand.com"],
    }),
  };
}

function freshOrchestrator() {
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "role-assign-"));
  const events = [];
  const auditLines = [];
  const audit = createAuditLogger({ level: "cli", sink: (line) => auditLines.push(line) });
  const { handlers } = createOrchestrator({
    host: makeHost(userDir),
    send: (channel, payload) => events.push({ channel, payload }),
    audit,
  });
  return { handlers, events, auditLines };
}

const CF_TARGET_OK = [
  "API endpoint:   https://api.cf.eu10-004.hana.ondemand.com",
  "API version:    3.220.0",
  "user:           ais@figaf.com",
  "org:            figafpartner-1",
  "space:          figaf-platform",
].join("\n");

const isBtpGet = (a) => a.includes("get") && a.includes("accounts/global-account");
const seq = () => spawnCalls.map((c) => `${c.cmd} ${c.args[0]}`);

// Sign the session's cf CLI in "as a person" through session:state (cf target).
async function seedPasscodeUser(handlers) {
  responses.push({ match: (a) => a[0] === "target", stdout: CF_TARGET_OK, code: 0 });
  const s = await handlers["session:state"]();
  assert.equal(s.cfLoggedIn, true, JSON.stringify(s));
}

const SERVICE_KEY_STDOUT = [
  "Getting key figaf-manager-role-key for service instance figaf-faid-xsuaa as ais@figaf.com...",
  "",
  JSON.stringify({
    credentials: {
      clientid: "sb-figaf-faid-xsuaa!t1",
      clientsecret: "S3CRET-VALUE-NEVER-IN-AUDIT",
      subaccountid: "sub-guid-123",
      zoneid: "sub-guid-123",
      url: "https://figafpartner-1.authentication.eu10.hana.ondemand.com",
    },
  }, null, 2),
  "",
].join("\n");

test("precheck without a BTP login: btpLoggedIn=false, the cf user is reported, not a technical user", async () => {
  delete process.env.VCAP_SERVICES;
  const { handlers } = freshOrchestrator();
  await seedPasscodeUser(handlers);
  spawnCalls.length = 0;
  responses = [{ match: isBtpGet, stdout: "", stderr: "You are not logged in. Use 'btp login' first.", code: 1 }];

  const r = await handlers["xsuaa:roleAssignmentPrecheck"]();
  assert.equal(r.ok, true);
  assert.equal(r.btpLoggedIn, false);
  assert.equal(r.cfUser, "ais@figaf.com");
  assert.equal(r.cfUserIsStoredUser, false);
  assert.equal(r.storedUsername, null);
  assert.deepEqual(seq(), ["btp --format"]);
});

test("assign without a BTP login: refused with a clear error; no service key, no btp assign", async () => {
  delete process.env.VCAP_SERVICES;
  const { handlers } = freshOrchestrator();
  await seedPasscodeUser(handlers);
  spawnCalls.length = 0;
  responses = [{ match: isBtpGet, stdout: "", stderr: "You are not logged in.", code: 1 }];

  const r = await handlers["xsuaa:assignRoleCollection"]({ role: "FigafManagerAdmin", user: "person@figaf.com" });
  assert.equal(r.ok, false);
  assert.match(r.error, /no BTP login in this session/);
  assert.match(r.error, /before the last restart/);
  assert.match(r.error, /Session & access/);
  assert.match(r.error, /cockpit/);
  assert.deepEqual(seq(), ["btp --format"]);
});

test("assign with a BTP login and no captured subaccount: GUID from a throw-away service key, named user, audit tail redacted", async () => {
  delete process.env.VCAP_SERVICES;
  const { handlers, events, auditLines } = freshOrchestrator();
  await seedPasscodeUser(handlers);
  spawnCalls.length = 0;
  events.length = 0;
  responses = [
    { match: isBtpGet, stdout: JSON.stringify({ guid: "ga-guid-1", licenseType: "PRODUCTIVE" }), code: 0 },
    { match: (a) => a[0] === "create-service-key", stdout: "Creating service key figaf-manager-role-key for service instance figaf-faid-xsuaa as ais@figaf.com...\nOK", code: 0 },
    { match: (a) => a[0] === "service-key", stdout: SERVICE_KEY_STDOUT, code: 0 },
    { match: (a) => a[0] === "delete-service-key", stdout: "OK", code: 0 },
    { match: (a) => a[0] === "assign", stdout: "OK", code: 0 },
  ];

  const r = await handlers["xsuaa:assignRoleCollection"]({ role: "FigafManagerAdmin", user: "person@figaf.com" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.user, "person@figaf.com");
  assert.equal(r.subaccount, "sub-guid-123");
  assert.equal(r.subaccountSource, "xsuaa-service-key");

  assert.deepEqual(seq(), ["btp --format", "cf create-service-key", "cf service-key", "cf delete-service-key", "btp assign"]);
  const key = spawnCalls[2];
  assert.deepEqual(key.args, ["service-key", "figaf-faid-xsuaa", "figaf-manager-role-key"]);
  const del = spawnCalls[3];
  assert.deepEqual(del.args, ["delete-service-key", "figaf-faid-xsuaa", "figaf-manager-role-key", "-f"]);
  const assign = spawnCalls[4];
  assert.deepEqual(assign.args, [
    "assign", "security/role-collection", "FigafManagerAdmin",
    "--to-user", "person@figaf.com", "--subaccount", "sub-guid-123",
  ]);

  // The service key holds the XSUAA client secret: never in the audit tail.
  const audit = auditLines.join("\n");
  assert.ok(!audit.includes("S3CRET-VALUE-NEVER-IN-AUDIT"), "client secret leaked into the audit log");
  assert.ok(audit.includes("[not recorded: contains credentials]"), "service-key stdout must be replaced in the audit tail");

  // Phase events for the UI: running, then done.
  const phases = events.filter((e) => e.channel === "xsuaa:upgradePhase" && e.payload.phase === "assign-role").map((e) => e.payload.state);
  assert.deepEqual(phases, ["running", "done"]);

  // 4. Cached GUID: the second call creates no service key.
  spawnCalls.length = 0;
  responses = [
    { match: isBtpGet, stdout: JSON.stringify({ guid: "ga-guid-1" }), code: 0 },
    { match: (a) => a[0] === "assign", stdout: "OK", code: 0 },
  ];
  const r2 = await handlers["xsuaa:assignRoleCollection"]({ user: "person@figaf.com" });
  assert.equal(r2.ok, true, JSON.stringify(r2));
  assert.equal(r2.subaccount, "sub-guid-123");
  assert.deepEqual(seq(), ["btp --format", "btp assign"]);
});

test("assign: a failed btp assign surfaces the CLI's last lines and a failed phase", async () => {
  delete process.env.VCAP_SERVICES;
  const { handlers, events } = freshOrchestrator();
  await seedPasscodeUser(handlers);
  spawnCalls.length = 0;
  events.length = 0;
  responses = [
    { match: isBtpGet, stdout: JSON.stringify({ guid: "ga-guid-1" }), code: 0 },
    { match: (a) => a[0] === "create-service-key", stdout: "OK", code: 0 },
    { match: (a) => a[0] === "service-key", stdout: SERVICE_KEY_STDOUT, code: 0 },
    { match: (a) => a[0] === "delete-service-key", stdout: "OK", code: 0 },
    { match: (a) => a[0] === "assign", stdout: "", stderr: "User person@figaf.com not found in the identity provider", code: 1 },
  ];
  const r = await handlers["xsuaa:assignRoleCollection"]({ user: "person@figaf.com" });
  assert.equal(r.ok, false);
  assert.match(r.error, /not found in the identity provider/);
  const phases = events.filter((e) => e.channel === "xsuaa:upgradePhase" && e.payload.phase === "assign-role").map((e) => e.payload.state);
  assert.deepEqual(phases, ["running", "failed"]);
});

test("assign: a non-e-mail user is refused before anything runs", async () => {
  delete process.env.VCAP_SERVICES;
  const { handlers } = freshOrchestrator();
  await seedPasscodeUser(handlers);
  spawnCalls.length = 0;
  responses = [];
  // (An EMPTY user is not "bad": it means "the cf identity", the old default.)
  for (const bad of ["not an email", "nobody", "a@b c", "@figaf.com", "a".repeat(250) + "@figaf.com"]) {
    const r = await handlers["xsuaa:assignRoleCollection"]({ user: bad });
    assert.equal(r.ok, false, bad);
    assert.match(r.error, /is not an e-mail address/, bad);
  }
  assert.equal(spawnCalls.length, 0, "validation must happen before any CLI call");
});

test("precheck after login:withStoredUser: the cf identity is the technical user", async () => {
  process.env.VCAP_SERVICES = JSON.stringify({ credstore: [{ credentials: BINDING }] });
  global.fetch = async () => ({ ok: true, status: 200, text: async () => jweFor({ name: "cf-management-user", value: "tech-pass", username: "tech@figaf.com" }) });
  const { handlers } = freshOrchestrator();
  spawnCalls.length = 0;
  responses = []; // api / auth / target all exit 0 by default
  const login = await handlers["login:withStoredUser"]();
  assert.equal(login.ok, true, JSON.stringify(login));

  spawnCalls.length = 0;
  responses = [{ match: isBtpGet, stdout: JSON.stringify({ guid: "ga-guid-1" }), code: 0 }];
  const r = await handlers["xsuaa:roleAssignmentPrecheck"]();
  assert.equal(r.ok, true);
  assert.equal(r.btpLoggedIn, true);
  assert.equal(r.cfUser, "tech@figaf.com");
  assert.equal(r.cfUserIsStoredUser, true);
  assert.equal(r.storedUsername, "tech@figaf.com");
  delete process.env.VCAP_SERVICES;
});
