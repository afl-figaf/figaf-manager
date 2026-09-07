"use strict";
// Tests for the orchestrator's cf:restage handler — v2 phase 2.5 of the XSUAA
// upgrade flow. The handler is the single seam that flips the manager from v1
// (cookie-token) to v2 (XSUAA + approuter) mode: it binds the manager to the
// xsuaa service and triggers a restage that brings the dyno back up with the
// xsuaa entry in VCAP_SERVICES.
//
// Coverage:
//   1. bindXsuaa=true on a fresh app: runs `cf bind-service` then spawns
//      `cf restage` (fire-and-forget). Returns ok=true.
//   2. bindXsuaa=true when bind-service stderr says "already bound": treated
//      as success; restage still spawned.
//   3. bindXsuaa=true when bind-service fails with a different stderr:
//      returns ok=false; restage NOT spawned.
//   4. skipIfBound=true when the credential-binding probe shows the binding
//      already exists: short-circuits with alreadyBound=true; bind+restage
//      skipped. This is the re-run idempotency path.
//   5. skipIfBound=true when the probe shows NO binding: falls through to
//      the bind+restage path.
//   6. The `log("cmd","cmd", ...)` line for `cf restage` is emitted before
//      the spawn, so the operator sees the command in the terminal drawer
//      even when the dyno bounces away the post-spawn stdout.
//
// Test harness: we patch child_process.spawn to return a synthetic process
// whose stdout/stderr/exit-code are programmable per-call. No real binary
// is invoked, which keeps the test portable across Windows/macOS/Linux. The
// orchestrator is required AFTER the patch so its bound reference to spawn
// is the patched version.

const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const child_process = require("child_process");
const EventEmitter = require("events");

// ─── Patch spawn ───────────────────────────────────────────────────────────
// We replace child_process.spawn with a recording stub. Per test, we set
// `nextResponse` to control how the next spawn behaves. The recorded call log
// is in `spawnCalls`. The orchestrator caches its require() of spawn at
// module load, so we patch the export the orchestrator actually uses by
// replacing the destructured `spawn` symbol via require.cache mutation? No —
// safer: patch child_process.spawn BEFORE requiring the orchestrator, then
// reset between tests via the `responses` queue.

const originalSpawn = child_process.spawn;
const spawnCalls = [];
let responses = []; // [{ args: regex|fn|null, stdout: string, stderr: string, code: number }]

function popResponse(args) {
  // Match the first response whose `match` predicate accepts these args.
  for (let i = 0; i < responses.length; i++) {
    const r = responses[i];
    if (!r.match || r.match(args)) {
      responses.splice(i, 1);
      return r;
    }
  }
  return { stdout: "", stderr: "", code: 0 };
}

function fakeSpawn(cmd, args, opts) {
  spawnCalls.push({ cmd, args: args.slice(), opts });
  const resp = popResponse(args);
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = { write: () => {}, end: () => {} };
  proc.killed = false;
  // Defer emission so synchronous orchestrator code can register .on() first.
  setImmediate(() => {
    if (resp.stdout) proc.stdout.emit("data", Buffer.from(resp.stdout));
    if (resp.stderr) proc.stderr.emit("data", Buffer.from(resp.stderr));
    proc.emit("close", resp.code || 0);
  });
  return proc;
}

child_process.spawn = fakeSpawn;

// IMPORTANT: require @figaf/core AFTER the patch so the orchestrator binds to
// the patched spawn. The orchestrator destructures `spawn` from child_process
// at module load.
const { createOrchestrator } = require("@figaf/core");

beforeEach(() => {
  spawnCalls.length = 0;
  responses.length = 0;
});

afterEach(() => {
  // Drain any unconsumed responses so a misconfigured test doesn't bleed.
  responses.length = 0;
});

// Restore at process exit so unrelated test files don't see the patched spawn.
process.on("exit", () => { child_process.spawn = originalSpawn; });

// ─── helpers ───────────────────────────────────────────────────────────────

function makeHost() {
  return {
    isHosted: true,
    resolveBinary: () => "/fake/path/cf",
    getUserDataDir: () => "/tmp/figaf-fake",
    resolveManagerApprouterDir: () => null,
    resolveDeployTemplate: () => ({ kind: "bundle", src: "/tmp/figaf-fake" }),
    pickFile: async () => null,
    openExternal: async () => {},
    readClipboard: async () => "",
  };
}

function makeSend() {
  const events = [];
  return { fn: (channel, payload) => events.push({ channel, payload }), events };
}

// The restage spawn is fire-and-forget; we give it a short tick to flush
// before reading spawnCalls. setImmediate inside fakeSpawn means the close
// event fires on the next tick; the spawnCalls entry is pushed synchronously
// so reading immediately is fine, but we add a microtask flush for clarity.
async function flush() { await new Promise((r) => setImmediate(r)); }

// ─── tests ─────────────────────────────────────────────────────────────────

test("cf:restage bindXsuaa=true on fresh app: bind then spawn restage, ok=true", async () => {
  // bind-service succeeds with empty stderr; restage is fire-and-forget.
  responses.push(
    { match: (a) => a[0] === "bind-service", stdout: "", stderr: "", code: 0 },
    { match: (a) => a[0] === "restage", stdout: "", stderr: "", code: 0 },
  );
  const send = makeSend();
  const orch = createOrchestrator({ host: makeHost(), send: send.fn });
  const r = await orch.handlers["cf:restage"]({ app: "figaf-manager", bindXsuaa: true });
  await flush();
  assert.equal(r.ok, true);
  const bindIdx = spawnCalls.findIndex((c) => c.args[0] === "bind-service");
  const restageIdx = spawnCalls.findIndex((c) => c.args[0] === "restage");
  assert.ok(bindIdx !== -1, "bind-service invoked");
  assert.ok(restageIdx !== -1, "restage spawned");
  assert.ok(bindIdx < restageIdx, "bind precedes restage");
  // Decision 0009: a fresh installation binds the SHARED instance.
  assert.deepEqual(spawnCalls[bindIdx].args, ["bind-service", "figaf-manager", "figaf-faid-xsuaa"]);
  const phaseRunning = send.events.find(
    (e) => e.channel === "xsuaa:upgradePhase" && e.payload.phase === "restage" && e.payload.state === "running"
  );
  assert.ok(phaseRunning, "xsuaa:upgradePhase restage:running event emitted");
});

test("cf:restage bindXsuaa=true when bind says 'already bound': still ok, restage proceeds", async () => {
  responses.push(
    { match: (a) => a[0] === "bind-service", stdout: "", stderr: "Service instance figaf-manager-xsuaa is already bound to application figaf-manager.\n", code: 1 },
    { match: (a) => a[0] === "restage", stdout: "", stderr: "", code: 0 },
  );
  const send = makeSend();
  const orch = createOrchestrator({ host: makeHost(), send: send.fn });
  const r = await orch.handlers["cf:restage"]({ app: "figaf-manager", bindXsuaa: true });
  await flush();
  assert.equal(r.ok, true, "already-bound is treated as success");
  assert.ok(spawnCalls.some((c) => c.args[0] === "restage"), "restage still spawned");
});

test("cf:restage bindXsuaa=true when bind fails: returns ok=false, no restage", async () => {
  responses.push(
    { match: (a) => a[0] === "bind-service", stdout: "", stderr: "Quota exceeded.\n", code: 1 },
  );
  const send = makeSend();
  const orch = createOrchestrator({ host: makeHost(), send: send.fn });
  const r = await orch.handlers["cf:restage"]({ app: "figaf-manager", bindXsuaa: true });
  await flush();
  assert.equal(r.ok, false, "non-already-bound failure surfaces ok=false");
  assert.match(String(r.error || ""), /quota/i, "stderr propagates as error");
  assert.ok(!spawnCalls.some((c) => c.args[0] === "restage"), "restage NOT spawned on bind failure");
});

test("cf:restage skipIfBound=true with existing binding: alreadyBound, no bind/no restage", async () => {
  responses.push(
    { match: (a) => a[0] === "curl", stdout: JSON.stringify({ resources: [{ guid: "abc-123" }] }), stderr: "", code: 0 },
  );
  const send = makeSend();
  const orch = createOrchestrator({ host: makeHost(), send: send.fn });
  const r = await orch.handlers["cf:restage"]({ app: "figaf-manager", bindXsuaa: true, skipIfBound: true });
  await flush();
  assert.equal(r.ok, true);
  assert.equal(r.alreadyBound, true);
  assert.ok(spawnCalls.some((c) => c.args[0] === "curl"), "curl probe was invoked");
  assert.ok(!spawnCalls.some((c) => c.args[0] === "bind-service"), "bind-service skipped");
  assert.ok(!spawnCalls.some((c) => c.args[0] === "restage"), "restage skipped");
  const phaseDone = send.events.find(
    (e) => e.channel === "xsuaa:upgradePhase" && e.payload.phase === "restage" && e.payload.state === "done"
  );
  assert.ok(phaseDone, "restage phase marked done via short-circuit");
});

test("cf:restage skipIfBound=true with NO existing binding: falls through to bind+restage", async () => {
  responses.push(
    { match: (a) => a[0] === "curl", stdout: JSON.stringify({ resources: [] }), stderr: "", code: 0 },
    { match: (a) => a[0] === "bind-service", stdout: "", stderr: "", code: 0 },
    { match: (a) => a[0] === "restage", stdout: "", stderr: "", code: 0 },
  );
  const send = makeSend();
  const orch = createOrchestrator({ host: makeHost(), send: send.fn });
  const r = await orch.handlers["cf:restage"]({ app: "figaf-manager", bindXsuaa: true, skipIfBound: true });
  await flush();
  assert.equal(r.ok, true);
  assert.notEqual(r.alreadyBound, true);
  assert.ok(spawnCalls.some((c) => c.args[0] === "curl"));
  assert.ok(spawnCalls.some((c) => c.args[0] === "bind-service"));
  assert.ok(spawnCalls.some((c) => c.args[0] === "restage"));
});

test("cf:restage emits a cli:line cmd event for the restage spawn (observability)", async () => {
  responses.push({ match: (a) => a[0] === "restage", stdout: "", stderr: "", code: 0 });
  const send = makeSend();
  const orch = createOrchestrator({ host: makeHost(), send: send.fn });
  await orch.handlers["cf:restage"]({ app: "figaf-manager", bindXsuaa: false });
  await flush();
  // No bind step; only the spawn path. The cmd event must still be emitted
  // before the spawn so the terminal drawer reflects it.
  const restageCmd = send.events.find(
    (e) => e.channel === "cli:line"
      && e.payload.type === "cmd"
      && / restage figaf-manager$/.test(String(e.payload.text || ""))
  );
  assert.ok(restageCmd, "cli:line cmd event for restage spawn was emitted");
});

// ─── unmapRoute bundle (v2 cutover-atomic) ─────────────────────────────────
// The XSUAA upgrade splits the public route off the manager onto the approuter.
// Originally the wizard ran cf:mapRoute (approuter) → cf:unmapRoute (manager) →
// cf:restage as three browser RPCs. The third one fails: by the time it fires,
// the gorouter resolves the public hostname to the approuter alone, the
// approuter has no IAS session for the operator, and the request 401s before
// the manager ever sees it — the wizard surfaces "restage: unauthenticated".
//
// Fix: fold unmap-route into cf:restage so the entire cutover (unmap → bind →
// restage) is one server-side trajectory. The browser's RPC arrives while the
// manager is still on the route; the response flows back over the open TCP
// connection even after unmap-route removes the manager from the gorouter.

test("cf:restage unmapRoute={...}: unmap precedes bind precedes restage, all three run in order", async () => {
  responses.push(
    { match: (a) => a[0] === "unmap-route", stdout: "", stderr: "", code: 0 },
    { match: (a) => a[0] === "bind-service", stdout: "", stderr: "", code: 0 },
    { match: (a) => a[0] === "restage", stdout: "", stderr: "", code: 0 },
  );
  const send = makeSend();
  const orch = createOrchestrator({ host: makeHost(), send: send.fn });
  const r = await orch.handlers["cf:restage"]({
    app: "figaf-manager",
    bindXsuaa: true,
    unmapRoute: { domain: "cfapps.us10-001.hana.ondemand.com", hostname: "abc123" },
  });
  await flush();
  assert.equal(r.ok, true);
  const unmapIdx = spawnCalls.findIndex((c) => c.args[0] === "unmap-route");
  const bindIdx = spawnCalls.findIndex((c) => c.args[0] === "bind-service");
  const restageIdx = spawnCalls.findIndex((c) => c.args[0] === "restage");
  assert.ok(unmapIdx !== -1, "unmap-route invoked");
  assert.ok(bindIdx !== -1, "bind-service invoked");
  assert.ok(restageIdx !== -1, "restage spawned");
  assert.ok(unmapIdx < bindIdx, "unmap precedes bind");
  assert.ok(bindIdx < restageIdx, "bind precedes restage");
  const unmapCall = spawnCalls.find((c) => c.args[0] === "unmap-route");
  assert.deepEqual(
    unmapCall.args,
    ["unmap-route", "figaf-manager", "cfapps.us10-001.hana.ondemand.com", "--hostname", "abc123"],
    "unmap-route is called against the restaged app on the supplied domain+hostname"
  );
});

test("cf:restage unmapRoute reports 'not mapped': treated as success, bind+restage proceed", async () => {
  responses.push(
    { match: (a) => a[0] === "unmap-route", stdout: "", stderr: "Route abc.cfapps.us10-001.hana.ondemand.com is not mapped to app figaf-manager.\n", code: 1 },
    { match: (a) => a[0] === "bind-service", stdout: "", stderr: "", code: 0 },
    { match: (a) => a[0] === "restage", stdout: "", stderr: "", code: 0 },
  );
  const send = makeSend();
  const orch = createOrchestrator({ host: makeHost(), send: send.fn });
  const r = await orch.handlers["cf:restage"]({
    app: "figaf-manager",
    bindXsuaa: true,
    unmapRoute: { domain: "cfapps.us10-001.hana.ondemand.com", hostname: "abc123" },
  });
  await flush();
  assert.equal(r.ok, true, "not-mapped is treated as success (idempotent re-run)");
  assert.ok(spawnCalls.some((c) => c.args[0] === "bind-service"), "bind still ran");
  assert.ok(spawnCalls.some((c) => c.args[0] === "restage"), "restage still spawned");
});

test("cf:restage unmapRoute fails for non-idempotent reason: ok=false, bind+restage skipped", async () => {
  responses.push(
    { match: (a) => a[0] === "unmap-route", stdout: "", stderr: "Insufficient privileges.\n", code: 1 },
  );
  const send = makeSend();
  const orch = createOrchestrator({ host: makeHost(), send: send.fn });
  const r = await orch.handlers["cf:restage"]({
    app: "figaf-manager",
    bindXsuaa: true,
    unmapRoute: { domain: "cfapps.us10-001.hana.ondemand.com", hostname: "abc123" },
  });
  await flush();
  assert.equal(r.ok, false, "non-idempotent failure surfaces ok=false");
  assert.match(String(r.error || ""), /privilege/i, "stderr propagates as error");
  assert.ok(!spawnCalls.some((c) => c.args[0] === "bind-service"), "bind NOT run after unmap failure");
  assert.ok(!spawnCalls.some((c) => c.args[0] === "restage"), "restage NOT spawned after unmap failure");
});

// ─── decision 0009: legacy installations keep their instance ───────────────

test("cf:restage bindXsuaa=true on a manager bound to the LEGACY instance: binds figaf-manager-xsuaa (Alex's shipped installations keep working)", async () => {
  process.env.VCAP_SERVICES = JSON.stringify({
    xsuaa: [{ instance_name: "figaf-manager-xsuaa", credentials: { xsappname: "figaf-manager-xsuaa!t77", clientid: "x" } }],
  });
  try {
    responses.push(
      { match: (a) => a[0] === "bind-service", stdout: "", stderr: "", code: 0 },
      { match: (a) => a[0] === "restage", stdout: "", stderr: "", code: 0 },
    );
    const send = makeSend();
    const orch = createOrchestrator({ host: makeHost(), send: send.fn });
    const r = await orch.handlers["cf:restage"]({ app: "figaf-manager", bindXsuaa: true });
    await flush();
    assert.equal(r.ok, true);
    const bind = spawnCalls.find((c) => c.args[0] === "bind-service");
    assert.deepEqual(bind.args, ["bind-service", "figaf-manager", "figaf-manager-xsuaa"]);
  } finally {
    delete process.env.VCAP_SERVICES;
  }
});

test("cf:restage on a manager bound to the SHARED instance (or nothing): binds figaf-faid-xsuaa", async () => {
  process.env.VCAP_SERVICES = JSON.stringify({
    xsuaa: [{ instance_name: "figaf-faid-xsuaa", credentials: { xsappname: "figaf-faid!t77", clientid: "x" } }],
  });
  try {
    responses.push(
      { match: (a) => a[0] === "bind-service", stdout: "", stderr: "", code: 0 },
      { match: (a) => a[0] === "restage", stdout: "", stderr: "", code: 0 },
    );
    const send = makeSend();
    const orch = createOrchestrator({ host: makeHost(), send: send.fn });
    const r = await orch.handlers["cf:restage"]({ app: "figaf-manager", bindXsuaa: true });
    await flush();
    assert.equal(r.ok, true);
    const bind = spawnCalls.find((c) => c.args[0] === "bind-service");
    assert.deepEqual(bind.args, ["bind-service", "figaf-manager", "figaf-faid-xsuaa"]);
  } finally {
    delete process.env.VCAP_SERVICES;
  }
});
