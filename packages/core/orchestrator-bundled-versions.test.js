"use strict";
// prereq:bundledVersions — what the manager runs with, against the build's pins.
//
// The handler asks the btp and cf binaries for their version, reads the build
// record (host.getBundledVersions -> bin/VERSIONS.json) and reports, per CLI,
// the probed version, the pinned version and whether they match. It never
// throws: a CLI that does not start is reported with the spawn error.
//
// Harness: patch child_process.spawn BEFORE requiring the orchestrator (same
// pattern as orchestrator-cli-env.test.js).

const { test } = require("node:test");
const assert = require("node:assert/strict");
const child_process = require("child_process");
const EventEmitter = require("events");
const os = require("os");

function fakeSpawn(cmd, args) {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = { write: () => {}, end: () => {} };
  proc.killed = false;
  setImmediate(() => {
    if (/nope/.test(cmd)) {
      const err = new Error(`spawn ${cmd} ENOENT`);
      err.code = "ENOENT";
      proc.emit("error", err);
      return;
    }
    if (/btp/.test(cmd) && args[0] === "--version") {
      proc.stdout.emit("data", Buffer.from("SAP BTP command line interface (client v2.106.1)\n"));
    } else if (/cf/.test(cmd) && args[0] === "version") {
      proc.stdout.emit("data", Buffer.from("cf version 8.19.0+abc123.2026-08-01\n"));
    } else {
      proc.stderr.emit("data", Buffer.from("unexpected command in test\n"));
      proc.emit("close", 2);
      return;
    }
    proc.emit("close", 0);
  });
  return proc;
}

child_process.spawn = fakeSpawn;

const { createOrchestrator } = require("./orchestrator");

function makeHost({ build, binaries } = {}) {
  const names = { btp: "btp", cf: "cf", ...(binaries || {}) };
  return {
    isHosted: true,
    getUserDataDir: () => os.tmpdir(),
    resolveBinary: (name) => names[name] || name,
    pickFile: async () => null,
    openExternal: async () => {},
    readClipboard: async () => "",
    writeClipboard: async () => ({ ok: false }),
    resolveDeployTemplate: () => ({ kind: "bundle", src: os.tmpdir() }),
    getInstalledVersion: () => "26.5.0",
    getUpdateStagingDir: () => os.tmpdir(),
    getDeployTargetForSelf: () => null,
    ...(build === undefined ? {} : { getBundledVersions: () => build }),
  };
}

const BUILD = { manager: "26.5.0", btp: "2.106.1", cf: "8.19.0", node: "24.x", builtAt: "2026-09-04T09:00:00.000Z", npm: { express: "4.22.2" } };

test("both CLIs report the pinned versions: matches true, build record carried through", async () => {
  const { handlers } = createOrchestrator({ host: makeHost({ build: BUILD }), send: () => {} });
  const r = await handlers["prereq:bundledVersions"]();
  assert.equal(r.ok, true);
  assert.equal(r.bundled, true);
  assert.equal(r.manager, "26.5.0");
  assert.equal(r.node, process.version);
  assert.equal(r.nodeExpected, "24.x");
  assert.deepEqual({ ok: r.btp.ok, version: r.btp.version, expected: r.btp.expected, matches: r.btp.matches },
    { ok: true, version: "2.106.1", expected: "2.106.1", matches: true });
  assert.deepEqual({ ok: r.cf.ok, version: r.cf.version, expected: r.cf.expected, matches: r.cf.matches },
    { ok: true, version: "8.19.0", expected: "8.19.0", matches: true });
  assert.deepEqual(r.npm, { express: "4.22.2" });
  assert.equal(r.builtAt, BUILD.builtAt);
});

test("a CLI that reports another version than the pin: matches false, the others unaffected", async () => {
  const { handlers } = createOrchestrator({ host: makeHost({ build: { ...BUILD, cf: "8.18.0" } }), send: () => {} });
  const r = await handlers["prereq:bundledVersions"]();
  assert.equal(r.cf.version, "8.19.0");
  assert.equal(r.cf.expected, "8.18.0");
  assert.equal(r.cf.matches, false);
  assert.equal(r.btp.matches, true);
});

test("no build record (dev checkout): bundled false, no expectation, matches null", async () => {
  const { handlers } = createOrchestrator({ host: makeHost({ build: undefined }), send: () => {} });
  const r = await handlers["prereq:bundledVersions"]();
  assert.equal(r.ok, true);
  assert.equal(r.bundled, false);
  assert.equal(r.nodeExpected, null);
  assert.equal(r.npm, null);
  assert.equal(r.builtAt, null);
  assert.equal(r.btp.expected, null);
  assert.equal(r.btp.matches, null);
  assert.equal(r.cf.version, "8.19.0");
});

test("a CLI that does not start is reported, not thrown: ok false, the spawn error as raw text", async () => {
  const { handlers } = createOrchestrator({ host: makeHost({ build: BUILD, binaries: { btp: "nope-btp" } }), send: () => {} });
  const r = await handlers["prereq:bundledVersions"]();
  assert.equal(r.ok, true);
  assert.equal(r.btp.ok, false);
  assert.equal(r.btp.version, null);
  assert.match(r.btp.raw, /ENOENT/);
  assert.equal(r.btp.matches, false);
  assert.equal(r.cf.ok, true);
});
