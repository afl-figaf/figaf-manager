"use strict";
// Tests for per-session CLI state isolation (the FigafManager single-operator
// gap, fixed for the FAID Apps manager).
//
// In hosted mode every spawned btp/cf process must receive:
//   CF_HOME          = <sessionUserDataDir>/cli
//   BTP_CLIENTCONFIG = <sessionUserDataDir>/cli/btp-config.json
// so cf/btp login state is per wizard session, not shared across the dyno.
// Desktop (Electron, isHosted=false) keeps the OS-default CLI state — no
// CF_HOME override there.
//
// Harness: patch child_process.spawn BEFORE requiring the orchestrator
// (same pattern as orchestrator-restage.test.js in apps/figaf-manager/cloud).

const { test } = require("node:test");
const assert = require("node:assert/strict");
const child_process = require("child_process");
const EventEmitter = require("events");
const fs = require("fs");
const os = require("os");
const path = require("path");

const spawnCalls = [];

function fakeSpawn(cmd, args, opts) {
  spawnCalls.push({ cmd, args: args.slice(), opts });
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = { write: () => {}, end: () => {} };
  proc.killed = false;
  setImmediate(() => {
    proc.stdout.emit("data", Buffer.from("status:    create succeeded\n"));
    proc.emit("close", 0);
  });
  return proc;
}

child_process.spawn = fakeSpawn;

// Require AFTER the patch so the orchestrator binds the patched spawn.
const { createOrchestrator } = require("./orchestrator");

function makeHost({ hosted, userDir }) {
  return {
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
    getDeployTargetForSelf: () => null,
  };
}

test("hosted mode: run() spawns with session-scoped CF_HOME and BTP_CLIENTCONFIG", async () => {
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-env-hosted-"));
  const { handlers } = createOrchestrator({ host: makeHost({ hosted: true, userDir }), send: () => {} });

  spawnCalls.length = 0;
  await handlers["cf:service"]({ name: "some-service" });

  assert.equal(spawnCalls.length, 1);
  const env = spawnCalls[0].opts.env;
  assert.equal(env.CF_HOME, path.join(userDir, "cli"));
  assert.equal(env.BTP_CLIENTCONFIG, path.join(userDir, "cli", "btp-config.json"));
  // The scoped dir is created eagerly so the CLI can write its config.
  assert.ok(fs.existsSync(path.join(userDir, "cli")));
});

test("hosted mode: the long-lived cf login spawn is session-scoped too", async () => {
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-env-login-"));
  const { handlers, dispose } = createOrchestrator({ host: makeHost({ hosted: true, userDir }), send: () => {} });

  spawnCalls.length = 0;
  await handlers["cf:loginStart"]({ apiUrl: "https://api.cf.example.com" });

  const login = spawnCalls.find((c) => c.args[0] === "login");
  assert.ok(login, "cf login must be spawned");
  assert.equal(login.opts.env.CF_HOME, path.join(userDir, "cli"));
  dispose();
});

test("desktop mode: no CF_HOME override — the user's own CLI state is used", async () => {
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-env-desktop-"));
  const { handlers } = createOrchestrator({ host: makeHost({ hosted: false, userDir }), send: () => {} });

  spawnCalls.length = 0;
  await handlers["cf:service"]({ name: "some-service" });

  const env = spawnCalls[0].opts.env;
  assert.equal(env.CF_HOME, process.env.CF_HOME); // untouched (usually undefined)
  assert.equal(env.BTP_CLIENTCONFIG, process.env.BTP_CLIENTCONFIG);
});
