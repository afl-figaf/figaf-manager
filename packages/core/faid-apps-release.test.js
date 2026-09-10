"use strict";
// Tests for the release-store side of faid-apps.js (figaf-faid decision 0010):
//   - faid:releases — source, installed vs latest, which versions Update may choose;
//   - faid:install deploys at the INSTALLED version (latest on an empty space),
//     downloads only that version's artifacts, refuses another version;
//   - faid:update({version}) moves the whole installation upwards: shared
//     backend first, then every installed frontend; downwards / unknown /
//     empty space refused; faid:update({appId}) re-deploys one app;
//   - a failed or corrupt download is the step "download", nothing is pushed;
//   - an unreachable store is one clear error naming the URL.
// The store is an in-memory bucket behind fake httpsJson / httpsDownload; cf
// is a fake `run` recorder, as in faid-apps.test.js.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const { VERSION_ENV, createFaidHandlers } = require("./faid-apps");

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const BASE = "https://store.example/faid";

function catalogFor(v) {
  return {
    releaseVersion: v,
    // Catalog v7: no CF app requires a service instance here, so these tests
    // stay about versions and downloads (the base services have their own).
    platform: { name: "Shared backend", cfApps: [{ name: "arch-backend", artifact: "backend.zip", sha256: sha(`backend-${v}`), buildpack: "nodejs_buildpack" }] },
    apps: [
      { id: "arch", name: "Archiving", version: v, cfApps: [{ name: "arch-frontend", artifact: "arch.zip", sha256: sha(`arch-${v}`), buildpack: "nodejs_buildpack", destinationTo: "arch-backend" }] },
      { id: "other", name: "Other app", version: v, cfApps: [{ name: "other-frontend", artifact: "other.zip", sha256: sha(`other-${v}`), buildpack: "nodejs_buildpack", destinationTo: "arch-backend" }] },
    ],
  };
}

/**
 * A remote store in memory with the given versions, and a fake cf whose
 * backend reports `installed` (null = not deployed). `respond` answers the
 * other cf calls; unknown calls succeed with empty output.
 */
function makeRemoteCtx({ versions, installed, respond }) {
  const objects = { "index.json": JSON.stringify({ latest: versions[versions.length - 1], versions: versions.map((v) => ({ version: v, publishedAt: "2026-09-04T00:00:00Z" })) }) };
  for (const v of versions) {
    const text = JSON.stringify(catalogFor(v));
    objects[`${v}/catalog.json`] = text;
    objects[`${v}/release.json`] = JSON.stringify({ releaseVersion: v, files: [{ name: "catalog.json", sha256: sha(text) }] });
    objects[`${v}/backend.zip`] = `backend-${v}`;
    objects[`${v}/arch.zip`] = `arch-${v}`;
    objects[`${v}/other.zip`] = `other-${v}`;
  }
  const gets = [];
  const read = (url) => {
    gets.push(url);
    const key = url.slice(BASE.length + 1);
    if (!(key in objects)) throw new Error("HTTP 404");
    return objects[key];
  };
  const calls = [];
  const logLines = [];
  const events = [];
  const ctx = {
    host: {
      isHosted: true,
      getUserDataDir: () => fs.mkdtempSync(path.join(os.tmpdir(), "faid-user-")),
      resolveFaidReleaseSource: () => ({ kind: "remote", url: BASE, cacheDir: fs.mkdtempSync(path.join(os.tmpdir(), "faid-cache-")) }),
    },
    run: async (cmd, args, opts = {}) => {
      calls.push({ cmd, args, opts });
      if (args[0] === "app" && args[1] === "arch-backend" && args[2] === "--guid") return installed ? { code: 0, stdout: "guid-b\n" } : { code: 1, stdout: "" };
      if (args[0] === "curl" && args[1] === "/v3/apps/guid-b/environment_variables") return { code: 0, stdout: JSON.stringify({ var: { [VERSION_ENV]: installed } }) };
      if (args[0] === "app" && args[1] === "arch-backend") return { code: 0, stdout: "routes:   b.example.com\n" };
      return (respond && respond(args, opts)) || { code: 0, stdout: "", stderr: "" };
    },
    log: (source, type, text) => logLines.push(text),
    send: (channel, payload) => events.push({ channel, payload }),
    resolveCf: () => "cf",
    extractZip: async () => {},
    httpsText: async () => "{}",
    httpsBody: async () => ({ status: 200, body: "{}" }),
    httpsJson: async (url) => JSON.parse(read(url)),
    httpsDownload: async (url, dest) => { fs.writeFileSync(dest, read(url)); return dest; },
  };
  return { ctx, calls, logLines, events, gets, objects };
}

const frontendsAbsent = (args) => ((args[0] === "app" && args[2] === "--guid") ? { code: 1, stdout: "" } : null);
const pushes = (calls) => calls.filter((c) => c.args[0] === "push").map((c) => c.args[1]);
const stamps = (calls) => calls.filter((c) => c.args[0] === "set-env" && c.args[2] === VERSION_ENV).map((c) => c.args[3]);

test("faid:releases: source, installed vs latest, which versions Update may choose", async () => {
  const { ctx } = makeRemoteCtx({ versions: ["0.4.0", "0.4.1", "0.4.2"], installed: "0.4.1" });
  const r = await createFaidHandlers(ctx)["faid:releases"]({});
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.source.kind, "remote");
  assert.equal(r.source.location, BASE);
  assert.equal(r.installed, "0.4.1");
  assert.equal(r.latest, "0.4.2");
  assert.equal(r.current, "0.4.1", "the installation works with its installed version");
  assert.equal(r.updateAvailable, true);
  const by = Object.fromEntries(r.versions.map((v) => [v.version, v]));
  assert.equal(by["0.4.2"].selectable, true);
  assert.equal(by["0.4.1"].selectable, true, "equal = re-deploy everything");
  assert.equal(by["0.4.0"].selectable, false);
  assert.match(by["0.4.0"].reason, /rollback is not supported/);
  assert.equal(by["0.4.1"].installed, true);
  assert.equal(by["0.4.2"].latest, true);

  // empty space: nothing selectable, Install will use latest
  const empty = makeRemoteCtx({ versions: ["0.4.1", "0.4.2"], installed: null });
  const e = await createFaidHandlers(empty.ctx)["faid:releases"]({});
  assert.equal(e.installed, null);
  assert.equal(e.current, "0.4.2");
  assert.equal(e.updateAvailable, false);
  assert.ok(e.versions.every((v) => !v.selectable));
});

test("faid:install deploys at the INSTALLED version even when the store has a newer one; only that version's artifacts are downloaded and verified", async () => {
  const { ctx, calls, logLines, gets } = makeRemoteCtx({ versions: ["0.4.1", "0.4.2"], installed: "0.4.1", respond: frontendsAbsent });
  const r = await createFaidHandlers(ctx)["faid:install"]({ appId: "arch" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.version, "0.4.1");
  assert.ok(gets.includes(`${BASE}/0.4.1/backend.zip`));
  assert.ok(gets.includes(`${BASE}/0.4.1/arch.zip`));
  assert.ok(!gets.some((u) => u.includes("/0.4.2/backend.zip")), "nothing of the newer release is downloaded");
  assert.ok(!gets.some((u) => u.endsWith("/other.zip")), "only the app being installed is downloaded");
  assert.deepEqual(stamps(calls), ["0.4.1", "0.4.1"]);
  assert.ok(logLines.includes(`>> GET ${BASE}/0.4.1/arch.zip`), "every download is a visible line");
  assert.ok(logLines.some((l) => /arch\.zip .* sha256 ok/.test(l)));
  assert.ok(logLines.some((l) => /release 0\.4\.1 from https:\/\/store\.example\/faid \(release store\)/.test(l)));

  // asking Install for another version is refused before any cf change
  const two = makeRemoteCtx({ versions: ["0.4.1", "0.4.2"], installed: "0.4.1" });
  const bad = await createFaidHandlers(two.ctx)["faid:install"]({ appId: "arch", version: "0.4.2" });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /Install uses the installed version 0\.4\.1/);
  assert.deepEqual(pushes(two.calls), []);
});

test("faid:install on an empty space uses the latest release", async () => {
  const { ctx, calls } = makeRemoteCtx({ versions: ["0.4.1", "0.4.2"], installed: null, respond: frontendsAbsent });
  const r = await createFaidHandlers(ctx)["faid:install"]({ appId: "arch" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.version, "0.4.2");
  assert.deepEqual(stamps(calls), ["0.4.2", "0.4.2"]);
});

test("faid:update({version}) moves the whole installation: shared backend first, then every INSTALLED frontend, not the others; downwards is refused", async () => {
  const present = new Set(["arch-backend", "arch-frontend"]); // "other" is not installed
  const { ctx, calls, logLines } = makeRemoteCtx({
    versions: ["0.4.0", "0.4.1", "0.4.2"], installed: "0.4.1",
    respond: (args) => ((args[0] === "app" && args[2] === "--guid") ? (present.has(args[1]) ? { code: 0, stdout: "g\n" } : { code: 1, stdout: "" }) : null),
  });
  const handlers = createFaidHandlers(ctx);
  const r = await handlers["faid:update"]({ version: "0.4.2" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual({ from: r.from, version: r.version, apps: r.apps }, { from: "0.4.1", version: "0.4.2", apps: ["arch"] });
  assert.deepEqual(pushes(calls), ["arch-backend", "arch-frontend"], "backend first, installed frontend second, the absent app untouched");
  assert.deepEqual(stamps(calls), ["0.4.2", "0.4.2"]);
  assert.ok(logLines.some((l) => /Updating the installation from 0\.4\.1 to 0\.4\.2/.test(l)));
  assert.ok(logLines.some((l) => /update installation to 0\.4\.2: done/.test(l)));

  calls.length = 0;
  const down = await handlers["faid:update"]({ version: "0.4.0" });
  assert.equal(down.ok, false);
  assert.match(down.error, /lower than the installed 0\.4\.1.*rollback is not supported/);
  assert.deepEqual(pushes(calls), [], "a refused update changes nothing");
  assert.match((await handlers["faid:update"]({ version: "9.9.9" })).error, /not in the release store/);
  assert.match((await handlers["faid:update"]({})).error, /appId or version required/);
});

test("faid:update({version}) on an empty space is refused; faid:update({appId}) re-deploys one app at the installed version", async () => {
  const empty = makeRemoteCtx({ versions: ["0.4.1", "0.4.2"], installed: null });
  const e = await createFaidHandlers(empty.ctx)["faid:update"]({ version: "0.4.2" });
  assert.equal(e.ok, false);
  assert.match(e.error, /nothing is installed yet/);

  const { ctx, calls } = makeRemoteCtx({
    versions: ["0.4.1", "0.4.2"], installed: "0.4.1",
    respond: (args) => ((args[0] === "app" && args[2] === "--guid") ? { code: 0, stdout: "g\n" } : null),
  });
  const r = await createFaidHandlers(ctx)["faid:update"]({ appId: "arch" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.version, "0.4.1", "re-deploy stays at the installed version");
  assert.deepEqual(pushes(calls), ["arch-backend", "arch-frontend"]);
});

test("a failed or corrupt download is the step 'download': nothing is pushed for that part", async () => {
  const { ctx, calls, objects } = makeRemoteCtx({ versions: ["0.4.1"], installed: null, respond: frontendsAbsent });
  objects["0.4.1/backend.zip"] = "backend-TAMPERED";
  const r = await createFaidHandlers(ctx)["faid:install"]({ appId: "arch" });
  assert.equal(r.ok, false);
  assert.equal(r.step, "download");
  assert.equal(r.cfApp, "arch-backend");
  assert.match(r.error, /checksum mismatch for backend\.zip/);
  assert.deepEqual(pushes(calls), []);

  delete objects["0.4.1/arch.zip"];
  objects["0.4.1/backend.zip"] = "backend-0.4.1";
  const r2 = await createFaidHandlers(ctx)["faid:install"]({ appId: "arch" });
  assert.equal(r2.ok, false);
  assert.equal(r2.step, "download");
  assert.match(r2.error, /download of arch\.zip failed: HTTP 404/);
  assert.deepEqual(pushes(calls), ["arch-backend"], "the backend went through; the frontend stopped at its download");
});

test("an unreachable store is one clear error on every read handler; the catalog names the source", async () => {
  const { ctx } = makeRemoteCtx({ versions: ["0.4.1"], installed: null });
  ctx.httpsJson = async () => { throw new Error("getaddrinfo ENOTFOUND store.example"); };
  const handlers = createFaidHandlers(ctx);
  for (const ch of ["faid:catalog", "faid:status", "faid:services", "faid:releases"]) {
    const r = await handlers[ch]({});
    assert.equal(r.ok, false, ch);
    assert.match(r.error, /cannot read https:\/\/store\.example\/faid\/index\.json: getaddrinfo ENOTFOUND/);
  }
  const good = makeRemoteCtx({ versions: ["0.4.1"], installed: null });
  const c = await createFaidHandlers(good.ctx)["faid:catalog"]({});
  assert.equal(c.ok, true);
  assert.equal(c.source.label, `${BASE} (release store)`);
  assert.equal(c.releaseVersion, "0.4.1");
  assert.equal(c.latest, "0.4.1");
  assert.equal(c.installed, null);
});
