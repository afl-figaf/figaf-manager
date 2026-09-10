"use strict";
// node:test coverage for the per-session directories (server.js).
//
// Each session owns $HOME/sessions/<sessionId>. The directory shares the
// container disk quota with the droplet and /tmp, so it must go when the
// session is pruned, and every old one must go at boot. The home directory
// is pointed at a temp directory here, so a developer's real home is never
// touched. Run: node --test apps/figaf-manager/cloud/session-dirs.test.js

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "figaf-home-"));
const savedEnv = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, VCAP_APPLICATION: process.env.VCAP_APPLICATION };
process.env.HOME = fakeHome;
process.env.USERPROFILE = fakeHome;
delete process.env.VCAP_APPLICATION;

const srv = require("./server");
const { sessionsRoot } = require("../host.cloud");

before(() => {
  assert.equal(sessionsRoot(), path.join(fakeHome, "sessions"), "the test must control the home directory");
});
after(() => {
  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(fakeHome, { recursive: true, force: true });
});

function touchSessionDir(sess) {
  const dir = sess.host.getUserDataDir();
  fs.mkdirSync(path.join(dir, "cli", ".cf"), { recursive: true });
  fs.writeFileSync(path.join(dir, "cli", ".cf", "config.json"), "{}");
  return dir;
}

test("pruning an idle session removes its directory; a live session keeps it", () => {
  const idle = srv.__getOrCreateSession("idle-session");
  const live = srv.__getOrCreateSession("live-session");
  const idleDir = touchSessionDir(idle);
  const liveDir = touchSessionDir(live);
  idle.lastSeen = Date.now() - 2 * 60 * 60 * 1000; // two hours ago, past the one-hour TTL

  srv.__pruneIdleSessions();

  assert.equal(fs.existsSync(idleDir), false, "idle session directory removed");
  assert.equal(srv.sessions.has("idle-session"), false);
  assert.equal(fs.existsSync(liveDir), true, "live session directory kept");
  assert.equal(srv.sessions.has("live-session"), true);
  srv.sessions.delete("live-session");
});

test("boot wipe: only inside a CF container (VCAP_APPLICATION), then the whole sessions root goes", () => {
  const dir = path.join(sessionsRoot(), "stale-from-last-boot");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "btp-config.json"), "{}");

  assert.equal(srv.__wipeSessionDirs(), false, "no-op outside a container");
  assert.equal(fs.existsSync(dir), true);

  process.env.VCAP_APPLICATION = "{}";
  try {
    assert.equal(srv.__wipeSessionDirs(), true);
    assert.equal(fs.existsSync(sessionsRoot()), false, "sessions root removed");
  } finally {
    delete process.env.VCAP_APPLICATION;
  }
});
