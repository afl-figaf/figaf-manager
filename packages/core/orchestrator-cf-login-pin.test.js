"use strict";
// The passcode CF login targets the manager's OWN org/space automatically
// (figaf-faid SPEC "its own Cloud Foundry space"): `cf login` is spawned with
// `-o`/`-s`, so the operator is never asked a question with exactly one
// correct answer. A wrong pick would install the platform into the wrong
// space, and nothing downstream re-checks the target.
//
// The picker must still apply where the pin cannot: desktop mode, and a login
// to a CF endpoint that is not the manager's own (the Figaf-tool flow).
//
// Harness: patch child_process.spawn BEFORE requiring the orchestrator
// (same pattern as orchestrator-cli-env.test.js).

const { test } = require("node:test");
const assert = require("node:assert/strict");
const child_process = require("child_process");
const EventEmitter = require("events");
const fs = require("fs");
const os = require("os");
const path = require("path");

const spawnCalls = [];
// Set by a test to drive the fake `cf login`: exit code and what it printed.
let loginExit = { code: 0, stderr: "" };

function fakeSpawn(cmd, args, opts) {
  spawnCalls.push({ cmd, args: args.slice(), opts });
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = { write: () => {}, end: () => {} };
  proc.killed = false;
  const isLogin = args[0] === "login";
  setImmediate(() => {
    if (isLogin && loginExit.stderr) proc.stderr.emit("data", Buffer.from(loginExit.stderr));
    proc.emit("close", isLogin ? loginExit.code : 0);
  });
  return proc;
}

child_process.spawn = fakeSpawn;

const { createOrchestrator } = require("./orchestrator");

const SELF = {
  apiUrl: "https://api.cf.eu10-004.hana.ondemand.com",
  orgName: "Figaf ApS_figafpartner-1",
  spaceName: "figaf-faid",
  appName: "figaf-manager",
  uris: [],
};

// consoleUI: the FAID Apps console frame. `null` models a host that does not
// implement isConsoleUI at all - then the pin must stay off. (A default
// parameter cannot express that: JS treats `undefined` as "not passed".)
function makeHost({ hosted = true, self = SELF, consoleUI = true } = {}) {
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-login-pin-"));
  const host = {
    isHosted: hosted,
    getUserDataDir: () => userDir,
    resolveBinary: (name) => name,
    pickFile: async () => null,
    openExternal: async () => {},
    readClipboard: async () => "",
    writeClipboard: async () => ({ ok: false }),
    resolveDeployTemplate: () => ({ kind: "bundle", src: userDir }),
    getInstalledVersion: () => "0.0.0",
    getUpdateStagingDir: () => userDir,
    getDeployTargetForSelf: () => self,
  };
  if (consoleUI !== null) host.isConsoleUI = () => consoleUI;
  return host;
}

// Run one cf:loginStart and return { args, events, result }.
async function startLogin({ host, apiUrl }) {
  const events = [];
  const { handlers, dispose } = createOrchestrator({
    host,
    send: (name, payload) => events.push({ name, payload }),
  });
  spawnCalls.length = 0;
  const result = await handlers["cf:loginStart"]({ apiUrl });
  // let the fake process close and the handler run
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  const login = spawnCalls.find((c) => c.args[0] === "login");
  dispose();
  return { args: login ? login.args : null, events, result, handlers };
}

test("hosted, login to the manager's own endpoint: cf login carries -o and -s", async () => {
  loginExit = { code: 0, stderr: "" };
  const { args, result } = await startLogin({ host: makeHost(), apiUrl: SELF.apiUrl });
  assert.deepEqual(args, [
    "login", "-a", SELF.apiUrl, "--sso",
    "-o", SELF.orgName,
    "-s", SELF.spaceName,
  ]);
  assert.deepEqual(result.pinned, { org: SELF.orgName, space: SELF.spaceName });
});

test("hosted, no apiUrl and no BTP landscape: the handler refuses instead of guessing", async () => {
  loginExit = { code: 0, stderr: "" };
  // cf:loginStart falls back to state.landscape, which only a BTP login sets.
  // Without either, it must refuse - never silently pick an endpoint.
  const { result } = await startLogin({ host: makeHost(), apiUrl: null });
  assert.equal(result.ok, false);
});

test("hosted, login to ANOTHER CF landscape: no -o/-s, the picker stays (Figaf-tool flow)", async () => {
  loginExit = { code: 0, stderr: "" };
  const { args, result } = await startLogin({
    host: makeHost(),
    apiUrl: "https://api.cf.us10-001.hana.ondemand.com",
  });
  assert.deepEqual(args, ["login", "-a", "https://api.cf.us10-001.hana.ondemand.com", "--sso"]);
  assert.equal(result.pinned, null);
});

test("hosted but Alex's classic wizard (FIGAF_CONSOLE_UI=0): no -o/-s", async () => {
  // The wizard deploys the Figaf tool into a space the operator picks, which
  // may not be the manager's own. Pinning there would deploy in the wrong
  // place, and the wizard is a shipped product (governance decision 0005).
  loginExit = { code: 0, stderr: "" };
  const { args, result } = await startLogin({
    host: makeHost({ consoleUI: false }),
    apiUrl: SELF.apiUrl,
  });
  assert.deepEqual(args, ["login", "-a", SELF.apiUrl, "--sso"]);
  assert.equal(result.pinned, null);
});

test("a host that does not implement isConsoleUI: no -o/-s (safe default)", async () => {
  loginExit = { code: 0, stderr: "" };
  const { args, result } = await startLogin({
    host: makeHost({ consoleUI: null }),
    apiUrl: SELF.apiUrl,
  });
  assert.deepEqual(args, ["login", "-a", SELF.apiUrl, "--sso"]);
  assert.equal(result.pinned, null);
});

test("desktop mode (no VCAP target): no -o/-s, the picker stays", async () => {
  loginExit = { code: 0, stderr: "" };
  const { args, result } = await startLogin({
    host: makeHost({ hosted: false, self: null }),
    apiUrl: SELF.apiUrl,
  });
  assert.deepEqual(args, ["login", "-a", SELF.apiUrl, "--sso"]);
  assert.equal(result.pinned, null);
});

test("pinned login succeeds: cf:loggedIn is sent and org/space are known without a `cf target`", async () => {
  loginExit = { code: 0, stderr: "" };
  const { events, handlers } = await startLogin({ host: makeHost(), apiUrl: SELF.apiUrl });
  assert.ok(events.find((e) => e.name === "cf:loggedIn"), "cf:loggedIn must be sent");
  const st = await handlers["session:state"]();
  assert.equal(st.ok, true);
});

test("pinned login fails on the space: cf:loginFailed carries an explanation, not just a code", async () => {
  loginExit = { code: 1, stderr: "FAILED\nSpace 'figaf-faid' not found\n" };
  const { events } = await startLogin({ host: makeHost(), apiUrl: SELF.apiUrl });
  const failed = events.find((e) => e.name === "cf:loginFailed");
  assert.ok(failed, "cf:loginFailed must be sent");
  assert.match(failed.payload.error, /figaf-faid/);
  assert.match(failed.payload.error, /Space Developer/);
});

test("pinned login fails on a rejected passcode: no invented role explanation", async () => {
  loginExit = { code: 1, stderr: "Credentials were rejected, please try again.\n" };
  const { events } = await startLogin({ host: makeHost(), apiUrl: SELF.apiUrl });
  const failed = events.find((e) => e.name === "cf:loginFailed");
  assert.ok(failed);
  assert.equal(failed.payload.error, null);
});

// ── cf:ownTarget (what the sign-in card shows) ──────────────────────────────

test("cf:ownTarget: hosted and our own endpoint -> the fixed org/space", async () => {
  const { handlers } = createOrchestrator({ host: makeHost(), send: () => {} });
  const r = await handlers["cf:ownTarget"]({ apiUrl: SELF.apiUrl });
  assert.deepEqual(r, { ok: true, pinned: { org: SELF.orgName, space: SELF.spaceName } });
});

test("cf:ownTarget: no apiUrl given -> falls back to the manager's own endpoint", async () => {
  const { handlers } = createOrchestrator({ host: makeHost(), send: () => {} });
  const r = await handlers["cf:ownTarget"]({});
  assert.deepEqual(r.pinned, { org: SELF.orgName, space: SELF.spaceName });
});

test("cf:ownTarget: another landscape, desktop, or the wizard -> null (the card shows the picker)", async () => {
  const { handlers } = createOrchestrator({ host: makeHost(), send: () => {} });
  const other = await handlers["cf:ownTarget"]({ apiUrl: "https://api.cf.us10-001.hana.ondemand.com" });
  assert.equal(other.pinned, null);

  const desktop = createOrchestrator({ host: makeHost({ hosted: false, self: null }), send: () => {} });
  assert.equal((await desktop.handlers["cf:ownTarget"]({ apiUrl: SELF.apiUrl })).pinned, null);

  const wizard = createOrchestrator({ host: makeHost({ consoleUI: false }), send: () => {} });
  assert.equal((await wizard.handlers["cf:ownTarget"]({ apiUrl: SELF.apiUrl })).pinned, null);
});
