"use strict";
// Tests for the stored-management-user login and the session-resume handler.
//
// Harness: patch child_process.spawn BEFORE requiring the orchestrator
// (repo pattern); stub global.fetch so credstore-client's read hits a local
// fake; VCAP_SERVICES / VCAP_APPLICATION are set per test.
//
// Coverage:
//   1. login:withStoredUser — command sequence cf api → cf auth → cf target;
//      the password travels ONLY via the child env (CF_USERNAME/CF_PASSWORD),
//      never in argv, terminal line, or audit args.
//   2. login:withStoredUser without a binding → friendly error, no spawns.
//   3. session:state — logged-in cf target output → resume payload;
//      logged-out → cfLoggedIn:false.

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
let responses = []; // [{ match: (args)=>bool, stdout, code }]

function popResponse(args) {
  for (let i = 0; i < responses.length; i++) {
    const r = responses[i];
    if (!r.match || r.match(args)) { responses.splice(i, 1); return r; }
  }
  return { stdout: "", code: 0 };
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
    proc.emit("close", resp.code || 0);
  });
  return proc;
};

// Require AFTER the spawn patch.
const { createOrchestrator } = require("./orchestrator");

// ─── credstore fixture (binding + JWE the fetch stub serves) ────────────────
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
      orgName: "Figaf ApS_figafpartner-1",
      spaceName: "figaf-faid",
      appName: "figaf-manager",
      uris: ["figaf-manager-x.cfapps.eu10-004.hana.ondemand.com"],
    }),
  };
}

function freshOrchestrator() {
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "stored-login-"));
  const events = [];
  const { handlers } = createOrchestrator({
    host: makeHost(userDir),
    send: (channel, payload) => events.push({ channel, payload }),
  });
  return { handlers, events };
}

test("login:withStoredUser: api → auth (env-only credentials, masked) → target", async () => {
  process.env.VCAP_SERVICES = JSON.stringify({ credstore: [{ credentials: BINDING }] });
  global.fetch = async () => ({ ok: true, status: 200, text: async () => jweFor({ name: "cf-management-user", value: "tech-pass", username: "tech@figaf.com" }) });

  const { handlers } = freshOrchestrator();
  spawnCalls.length = 0;
  responses = [];

  const r = await handlers["login:withStoredUser"]();
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.user, "tech@figaf.com");
  assert.equal(r.org, "Figaf ApS_figafpartner-1");
  assert.equal(r.space, "figaf-faid");

  const seq = spawnCalls.map((c) => c.args[0]);
  assert.deepEqual(seq, ["api", "auth", "target"]);
  const auth = spawnCalls[1];
  // credentials travel via env only — argv is exactly ["auth"]
  assert.deepEqual(auth.args, ["auth"]);
  assert.equal(auth.opts.env.CF_USERNAME, "tech@figaf.com");
  assert.equal(auth.opts.env.CF_PASSWORD, "tech-pass");
  // session isolation still applies on top
  assert.ok(auth.opts.env.CF_HOME, "CF_HOME must be session-scoped");
  const target = spawnCalls[2];
  assert.deepEqual(target.args, ["target", "-o", "Figaf ApS_figafpartner-1", "-s", "figaf-faid"]);
});

test("login:withStoredUser: no credstore binding → friendly error, nothing spawned", async () => {
  delete process.env.VCAP_SERVICES;
  const { handlers } = freshOrchestrator();
  spawnCalls.length = 0;
  const r = await handlers["login:withStoredUser"]();
  assert.equal(r.ok, false);
  assert.match(r.error, /not bound to a Credential Store/);
  assert.equal(spawnCalls.length, 0);
});

test("login:storedUserStatus: available with username; caches the probe", async () => {
  process.env.VCAP_SERVICES = JSON.stringify({ credstore: [{ credentials: BINDING }] });
  let fetches = 0;
  global.fetch = async () => { fetches++; return { ok: true, status: 200, text: async () => jweFor({ name: "cf-management-user", value: "pw", username: "tech@figaf.com" }) }; };

  const { handlers } = freshOrchestrator();
  const first = await handlers["login:storedUserStatus"]();
  assert.deepEqual(first, { ok: true, available: true, bindingPresent: true, username: "tech@figaf.com" });
  const second = await handlers["login:storedUserStatus"]();
  assert.equal(second.available, true);
  assert.equal(fetches, 1, "second probe must come from the 60s cache");
});

test("login:storeManagementUser: verifies in a scratch CF_HOME, stores encrypted, refreshes the probe", async () => {
  process.env.VCAP_SERVICES = JSON.stringify({ credstore: [{ credentials: BINDING }] });
  const fetches = [];
  // GET (probe/read) answers 404 first (nothing stored); POST records the write;
  // afterwards GET answers with the freshly stored credential.
  let stored = null;
  global.fetch = async (url, opts = {}) => {
    fetches.push({ url, method: opts.method || "GET" });
    if ((opts.method || "GET") === "POST") { stored = true; return { ok: true, status: 201, text: async () => "" }; }
    return stored
      ? { ok: true, status: 200, text: async () => jweFor({ name: "cf-management-user", value: "npw", username: "new-tech@figaf.com" }) }
      : { ok: false, status: 404, text: async () => "" };
  };

  const { handlers } = freshOrchestrator();

  // Before: probe says "binding present, nothing stored".
  const before = await handlers["login:storedUserStatus"]();
  assert.deepEqual(before, { ok: true, available: false, bindingPresent: true, reason: "management credential not stored" });

  spawnCalls.length = 0;
  responses = [];
  const r = await handlers["login:storeManagementUser"]({ username: "new-tech@figaf.com", password: "npw" });
  assert.equal(r.ok, true, JSON.stringify(r));

  // Verification sequence ran in a SCRATCH CF_HOME (…/verify-cli), not the session one.
  const seq = spawnCalls.map((c) => c.args[0]);
  assert.deepEqual(seq, ["api", "auth", "target"]);
  for (const c of spawnCalls) {
    assert.match(c.opts.env.CF_HOME, /verify-cli$/, "verification must not touch the session CLI state");
  }
  assert.equal(spawnCalls[1].opts.env.CF_USERNAME, "new-tech@figaf.com");
  assert.equal(spawnCalls[1].opts.env.CF_PASSWORD, "npw");
  assert.deepEqual(spawnCalls[1].args, ["auth"]); // never in argv

  // The write went out, and the probe cache was invalidated → now available.
  assert.ok(fetches.some((f) => f.method === "POST"));
  const after = await handlers["login:storedUserStatus"]();
  assert.deepEqual(after, { ok: true, available: true, bindingPresent: true, username: "new-tech@figaf.com" });
});

test("login:storeManagementUser: rejects a user without space access, stores nothing", async () => {
  process.env.VCAP_SERVICES = JSON.stringify({ credstore: [{ credentials: BINDING }] });
  const fetches = [];
  global.fetch = async (url, opts = {}) => {
    fetches.push({ method: (opts && opts.method) || "GET" });
    return { ok: false, status: 404, text: async () => "" };
  };
  const { handlers } = freshOrchestrator();
  spawnCalls.length = 0;
  responses = [{ match: (a) => a[0] === "target" && a[1] === "-o", stdout: "FAILED", code: 1 }];

  const r = await handlers["login:storeManagementUser"]({ username: "no-role@figaf.com", password: "pw" });
  assert.equal(r.ok, false);
  assert.match(r.error, /no role in/);
  assert.ok(!fetches.some((f) => f.method === "POST"), "nothing must be stored on a failed verification");
});

test("session:state: resumes from a logged-in cf target; reports logged-out honestly", async () => {
  delete process.env.VCAP_SERVICES;
  const { handlers } = freshOrchestrator();

  responses = [{
    match: (a) => a[0] === "target",
    stdout: "API endpoint:   https://api.cf.eu10-004.hana.ondemand.com\nAPI version:    3.225.0\nuser:           ais@figaf.com\norg:            Figaf ApS_figafpartner-1\nspace:          figaf-faid\n",
    code: 0,
  }];
  const resumed = await handlers["session:state"]();
  assert.deepEqual(resumed, {
    ok: true,
    cfLoggedIn: true,
    user: "ais@figaf.com",
    org: "Figaf ApS_figafpartner-1",
    space: "figaf-faid",
    apiUrl: "https://api.cf.eu10-004.hana.ondemand.com",
    btp: { loggedIn: false }, // no BTP login in this server session
  });

  responses = [{ match: (a) => a[0] === "target", stdout: "FAILED\nNot logged in.", code: 1 }];
  const out = await handlers["session:state"]();
  assert.deepEqual(out, { ok: true, cfLoggedIn: false });
});
