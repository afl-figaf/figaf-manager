"use strict";
// Tests for release-store.js (figaf-l3-l4 decision 0010).
//
// Coverage:
//   A. Pure helpers: parseIndex validation and ordering; chooseVersion — the
//      "one version per installation" rule for install / update / read.
//   B. Local store: index and resolve from a flat release directory; a
//      version mismatch is refused; ensureArtifact needs the file.
//   C. Remote store with fake fetchJson/download over an in-memory bucket:
//      index memo and refresh; resolve downloads catalog + config files once,
//      verifies them against release.json, refuses a corrupt catalog, tolerates
//      a missing release.json; ensureArtifact downloads a zip once, verifies it
//      against the catalog, deletes and reports a corrupt download; every
//      network read is a visible ">> GET" line; the cache is bounded.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const {
  loadCatalog,
  parseIndex,
  chooseVersion,
  describeSource,
  createReleaseStore,
  MAX_CACHED_VERSIONS,
} = require("./release-store");

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");

function catalogFor(version, { withSha = true } = {}) {
  return {
    releaseVersion: version,
    services: [{ name: "xsuaa", offering: "xsuaa", plan: "application", configFile: "xs-security.json" }],
    platform: { name: "Shared backend", cfApps: [{ name: "backend", artifact: "backend.zip", ...(withSha ? { sha256: sha(`backend-${version}`) } : {}) }] },
    apps: [{ id: "arch", version, cfApps: [{ name: "arch-fe", artifact: "arch.zip", ...(withSha ? { sha256: sha(`arch-${version}`) } : {}) }] }],
  };
}

function tmp(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

// ─── A. pure helpers ─────────────────────────────────────────────────────────

test("parseIndex: validates, sorts newest first, trusts a listed latest, falls back to the highest", () => {
  const r = parseIndex({ latest: "0.4.1", versions: [{ version: "0.4.0", publishedAt: "a" }, { version: "0.4.1", publishedAt: "b" }, { version: "0.10.0" }] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.versions.map((v) => v.version), ["0.10.0", "0.4.1", "0.4.0"]);
  assert.equal(r.latest, "0.4.1", "a listed latest is kept as the store wrote it");
  assert.equal(parseIndex({ versions: [{ version: "0.4.0" }, { version: "0.5.0" }] }).latest, "0.5.0");
  assert.equal(parseIndex({}).ok, false);
  assert.equal(parseIndex({ versions: [] }).ok, false);
  assert.match(parseIndex({ versions: [{ version: "0.0.0-e2e" }] }).error, /invalid version/);
});

test("chooseVersion: install uses the installed version, latest on an empty space, refuses another version", () => {
  const versions = ["0.4.1", "0.4.2", "0.5.0"];
  assert.deepEqual(chooseVersion({ installed: "0.4.1", latest: "0.5.0", versions, purpose: "install" }), { ok: true, version: "0.4.1" });
  assert.deepEqual(chooseVersion({ installed: null, latest: "0.5.0", versions, purpose: "install" }), { ok: true, version: "0.5.0" });
  const other = chooseVersion({ requested: "0.5.0", installed: "0.4.1", latest: "0.5.0", versions, purpose: "install" });
  assert.equal(other.ok, false);
  assert.match(other.error, /Install uses the installed version 0\.4\.1.*use Update/);
  // the installed version left the store: install must not silently pick another
  const gone = chooseVersion({ installed: "0.4.0", latest: "0.5.0", versions, purpose: "install" });
  assert.equal(gone.ok, false);
  assert.match(gone.error, /installed version 0\.4\.0 is not in the release store/);
  assert.match(chooseVersion({ requested: "9.9.9", installed: null, latest: "0.5.0", versions, purpose: "install" }).error, /not in the release store/);
  // empty space: only latest, also when a version is named
  assert.deepEqual(chooseVersion({ requested: "0.5.0", installed: null, latest: "0.5.0", versions, purpose: "install" }), { ok: true, version: "0.5.0" });
  assert.match(chooseVersion({ requested: "0.4.1", installed: null, latest: "0.5.0", versions, purpose: "install" }).error, /Install uses the latest release, 0\.5\.0, not 0\.4\.1/);
});

test("chooseVersion: update moves upwards only; nothing installed = nothing to update; equal = re-deploy allowed", () => {
  const versions = ["0.4.1", "0.4.2", "0.5.0"];
  assert.deepEqual(chooseVersion({ requested: "0.5.0", installed: "0.4.1", latest: "0.5.0", versions, purpose: "update" }), { ok: true, version: "0.5.0" });
  assert.deepEqual(chooseVersion({ requested: "0.4.1", installed: "0.4.1", latest: "0.5.0", versions, purpose: "update" }), { ok: true, version: "0.4.1" });
  const down = chooseVersion({ requested: "0.4.1", installed: "0.4.2", latest: "0.5.0", versions, purpose: "update" });
  assert.equal(down.ok, false);
  assert.match(down.error, /lower than the installed 0\.4\.2.*rollback is not supported/);
  assert.match(chooseVersion({ requested: "0.5.0", installed: null, latest: "0.5.0", versions, purpose: "update" }).error, /nothing is installed yet/);
  // no version named: latest, when it is newer
  assert.deepEqual(chooseVersion({ installed: "0.4.1", latest: "0.5.0", versions, purpose: "update" }), { ok: true, version: "0.5.0" });
  assert.match(chooseVersion({ installed: "0.5.0", latest: "0.5.0", versions, purpose: "update" }).error, /already at 0\.5\.0/);
});

test("chooseVersion: read uses installed, else latest; an installed version missing from the store falls back with a note", () => {
  const versions = ["0.4.1", "0.5.0"];
  assert.deepEqual(chooseVersion({ installed: "0.4.1", latest: "0.5.0", versions }), { ok: true, version: "0.4.1" });
  assert.deepEqual(chooseVersion({ installed: null, latest: "0.5.0", versions }), { ok: true, version: "0.5.0" });
  const r = chooseVersion({ installed: "0.3.0", latest: "0.5.0", versions });
  assert.equal(r.version, "0.5.0");
  assert.match(r.note, /0\.3\.0 is not in the store/);
});

test("describeSource: one label per kind", () => {
  assert.equal(describeSource({ kind: "remote", url: "https://s/l3" }).label, "https://s/l3 (release store)");
  assert.equal(describeSource({ kind: "local", dir: "/x" }).kind, "local");
  assert.equal(describeSource(null), null);
});

// ─── B. local store ──────────────────────────────────────────────────────────

test("local store: index and resolve come from the one catalog; another version is refused; artifacts must exist", async () => {
  const dir = tmp("rs-local-");
  fs.writeFileSync(path.join(dir, "catalog.json"), "﻿" + JSON.stringify(catalogFor("0.4.1")));
  fs.writeFileSync(path.join(dir, "backend.zip"), "backend-0.4.1");
  const store = createReleaseStore({ source: { kind: "local", dir } });
  const idx = await store.index();
  assert.deepEqual(idx, { ok: true, latest: "0.4.1", versions: [{ version: "0.4.1", publishedAt: null }] });
  const rel = await store.resolve("0.4.1");
  assert.equal(rel.ok, true);
  assert.equal(rel.dir, dir);
  assert.equal(rel.catalog.apps[0].id, "arch");
  assert.match((await store.resolve("0.5.0")).error, /holds 0\.4\.1, not 0\.5\.0/);
  assert.equal((await store.ensureArtifact(rel, "backend.zip")).path, path.join(dir, "backend.zip"));
  assert.match((await store.ensureArtifact(rel, "arch.zip")).error, /arch\.zip is missing/);
  assert.equal(store.describe().kind, "local");
});

test("loadCatalog: missing file, bad JSON, missing fields, v3 services are validated", () => {
  const empty = tmp("rs-empty-");
  assert.equal(loadCatalog(empty).ok, false);
  const bad = tmp("rs-bad-");
  fs.writeFileSync(path.join(bad, "catalog.json"), "{nope");
  assert.equal(loadCatalog(bad).ok, false);
  const noApps = tmp("rs-noapps-");
  fs.writeFileSync(path.join(noApps, "catalog.json"), JSON.stringify({ apps: [{ id: "x", version: "1", cfApps: [] }] }));
  assert.equal(loadCatalog(noApps).ok, false);
  const badSvc = tmp("rs-svc-");
  fs.writeFileSync(path.join(badSvc, "catalog.json"), JSON.stringify({ ...catalogFor("1.0.0"), services: [{ name: "db", offering: "postgresql-db", plan: "free", plans: ["standard"] }] }));
  assert.match(loadCatalog(badSvc).error, /containing the default plan/);
});

// ─── C. remote store ─────────────────────────────────────────────────────────

// An in-memory bucket: key -> string body. fetchJson / download read from it
// and record every URL they were asked for.
function fakeBucket(objects) {
  const gets = [];
  const base = "https://store.example/l3";
  const body = (url) => {
    gets.push(url);
    if (!url.startsWith(base + "/")) throw new Error("HTTP 404");
    const key = url.slice(base.length + 1);
    if (!(key in objects)) throw new Error("HTTP 404");
    return objects[key];
  };
  return {
    base, gets, objects,
    fetchJson: async (url) => JSON.parse(body(url)),
    download: async (url, dest) => { fs.writeFileSync(dest, body(url)); return dest; },
  };
}

function bucketWith(versions, { releaseJson = true } = {}) {
  const objects = { "index.json": JSON.stringify({ latest: versions[versions.length - 1], versions: versions.map((v) => ({ version: v, publishedAt: "2026-09-04T00:00:00Z" })) }) };
  for (const v of versions) {
    const catalog = JSON.stringify(catalogFor(v));
    const xs = JSON.stringify({ xsappname: "figaf-l3l4", v });
    objects[`${v}/catalog.json`] = catalog;
    objects[`${v}/xs-security.json`] = xs;
    objects[`${v}/backend.zip`] = `backend-${v}`;
    objects[`${v}/arch.zip`] = `arch-${v}`;
    if (releaseJson) {
      objects[`${v}/release.json`] = JSON.stringify({ releaseVersion: v, files: [
        { name: "catalog.json", sha256: sha(catalog) }, { name: "xs-security.json", sha256: sha(xs) },
        { name: "backend.zip", sha256: sha(`backend-${v}`) }, { name: "arch.zip", sha256: sha(`arch-${v}`) },
      ] });
    }
  }
  return fakeBucket(objects);
}

function remoteStore(bucket, extra = {}) {
  const lines = [];
  let t = 1_000_000;
  const store = createReleaseStore({
    source: { kind: "remote", url: bucket.base + "/", cacheDir: tmp("rs-cache-") },
    fetchJson: bucket.fetchJson,
    download: bucket.download,
    log: (source, type, text) => lines.push({ type, text }),
    now: () => t,
    ...extra,
  });
  return { store, lines, tick: (ms) => { t += ms; } };
}

test("remote store: index.json is read once per TTL, again on refresh; the trailing slash of the URL is ignored", async () => {
  const bucket = bucketWith(["0.4.1", "0.5.0"]);
  const { store, lines, tick } = remoteStore(bucket);
  const a = await store.index();
  assert.equal(a.ok, true);
  assert.equal(a.latest, "0.5.0");
  assert.deepEqual(a.versions.map((v) => v.version), ["0.5.0", "0.4.1"]);
  await store.index();
  assert.equal(bucket.gets.filter((u) => u.endsWith("index.json")).length, 1, "memoised inside the TTL");
  tick(60_000);
  await store.index();
  assert.equal(bucket.gets.filter((u) => u.endsWith("index.json")).length, 2, "read again after the TTL");
  await store.index({ refresh: true });
  assert.equal(bucket.gets.filter((u) => u.endsWith("index.json")).length, 3, "refresh bypasses the memo");
  assert.ok(lines.some((l) => l.text === ">> GET https://store.example/l3/index.json"), "every network read is a visible line");
  assert.equal(store.describe().label, "https://store.example/l3 (release store)");
});

test("remote store: an unreachable index is a clear error naming the URL", async () => {
  const { store } = remoteStore(fakeBucket({}));
  const r = await store.index();
  assert.equal(r.ok, false);
  assert.match(r.error, /cannot read https:\/\/store\.example\/l3\/index\.json: HTTP 404/);
  const bad = remoteStore(fakeBucket({ "index.json": JSON.stringify({ versions: [] }) })).store;
  assert.match((await bad.index()).error, /lists no versions/);
});

test("remote store: resolve downloads catalog, release.json and config files once, verified; the second resolve is served from the cache", async () => {
  const bucket = bucketWith(["0.4.1"]);
  const { store, lines } = remoteStore(bucket);
  const rel = await store.resolve("0.4.1");
  assert.equal(rel.ok, true, JSON.stringify(rel));
  assert.equal(rel.version, "0.4.1");
  assert.equal(rel.catalog.releaseVersion, "0.4.1");
  assert.equal(rel.release.releaseVersion, "0.4.1");
  assert.ok(fs.existsSync(path.join(rel.dir, "catalog.json")));
  assert.ok(fs.existsSync(path.join(rel.dir, "xs-security.json")), "config files are part of the resolved release");
  assert.ok(!fs.existsSync(path.join(rel.dir, "backend.zip")), "zips are not downloaded before an install needs them");
  assert.equal(lines.filter((l) => /sha256 ok/.test(l.text)).length, 2, "catalog and config file verified against release.json");

  const before = bucket.gets.length;
  const linesBefore = lines.length;
  const again = await store.resolve("0.4.1");
  assert.equal(again.ok, true);
  assert.equal(bucket.gets.length, before, "nothing fetched twice: versions are immutable");
  assert.equal(lines.length, linesBefore, "a cached, verified release adds no terminal line (the page reads it often)");
  await store.resolve("0.4.1", { verbose: true });
  assert.ok(lines.some((l) => /catalog\.json .*sha256 ok \(cached\)/.test(l.text)), "an explicit refresh shows the verification of the cached files");
});

test("remote store: a catalog that does not match release.json is refused and removed from the cache", async () => {
  const bucket = bucketWith(["0.4.1"]);
  bucket.objects["0.4.1/catalog.json"] = JSON.stringify({ ...catalogFor("0.4.1"), tampered: true });
  const { store } = remoteStore(bucket);
  const r = await store.resolve("0.4.1");
  assert.equal(r.ok, false);
  assert.match(r.error, /checksum mismatch for catalog\.json/);
  const r2 = await store.resolve("0.4.1");
  assert.equal(r2.ok, false, "the corrupt file was deleted, the second attempt downloads and fails again instead of trusting the cache");
  assert.equal(bucket.gets.filter((u) => u.endsWith("0.4.1/catalog.json")).length, 2);
});

test("remote store: without release.json the small files are used unverified (older releases), zips still checked against the catalog", async () => {
  const bucket = bucketWith(["0.4.0"], { releaseJson: false });
  const { store, lines } = remoteStore(bucket);
  const rel = await store.resolve("0.4.0");
  assert.equal(rel.ok, true, JSON.stringify(rel));
  assert.equal(rel.release, null);
  assert.ok(lines.some((l) => l.type === "warn" && /continuing without release\.json/.test(l.text)));
  const a = await store.ensureArtifact(rel, "backend.zip");
  assert.equal(a.ok, true);
  assert.equal(fs.readFileSync(a.path, "utf8"), "backend-0.4.0");
});

test("remote store: invalid or inconsistent versions are refused", async () => {
  const bucket = bucketWith(["0.4.1"]);
  bucket.objects["0.4.2/catalog.json"] = JSON.stringify(catalogFor("0.4.1"));
  const { store } = remoteStore(bucket);
  assert.match((await store.resolve("0.0.0-e2e")).error, /invalid version/);
  assert.match((await store.resolve("../etc")).error, /invalid version/);
  assert.match((await store.resolve("0.4.2")).error, /its catalog says 0\.4\.1/);
  assert.match((await store.resolve("0.9.9")).error, /download of catalog\.json failed: HTTP 404/);
});

test("remote store: ensureArtifact downloads a zip once, verifies it against the catalog, and deletes a corrupt download", async () => {
  const bucket = bucketWith(["0.4.1"]);
  const { store, lines } = remoteStore(bucket);
  const rel = await store.resolve("0.4.1");
  const a = await store.ensureArtifact(rel, "backend.zip");
  assert.equal(a.ok, true, JSON.stringify(a));
  assert.equal(fs.readFileSync(a.path, "utf8"), "backend-0.4.1");
  assert.ok(lines.some((l) => l.text === ">> GET https://store.example/l3/0.4.1/backend.zip"));
  const before = bucket.gets.length;
  const b = await store.ensureArtifact(rel, "backend.zip");
  assert.equal(b.ok, true);
  assert.equal(bucket.gets.length, before, "a verified cached zip is not downloaded again");
  assert.ok(lines.some((l) => /backend\.zip: cached/.test(l.text)));

  bucket.objects["0.4.1/arch.zip"] = "arch-CORRUPT";
  const c = await store.ensureArtifact(rel, "arch.zip");
  assert.equal(c.ok, false);
  assert.match(c.error, /checksum mismatch for arch\.zip/);
  assert.ok(!fs.existsSync(path.join(rel.dir, "arch.zip")), "a corrupt download never stays in the cache");
  // a cached file that was changed on disk is re-downloaded, not trusted
  fs.writeFileSync(path.join(rel.dir, "backend.zip"), "changed on disk");
  const d = await store.ensureArtifact(rel, "backend.zip");
  assert.equal(d.ok, true);
  assert.equal(fs.readFileSync(d.path, "utf8"), "backend-0.4.1");
});

test("remote store: the cache keeps at most MAX_CACHED_VERSIONS versions", async () => {
  const versions = ["0.1.0", "0.2.0", "0.3.0", "0.4.0", "0.5.0", "0.6.0"];
  const bucket = bucketWith(versions);
  const cacheDir = tmp("rs-cache-");
  const store = createReleaseStore({ source: { kind: "remote", url: bucket.base, cacheDir }, fetchJson: bucket.fetchJson, download: bucket.download });
  for (const v of versions) {
    const r = await store.resolve(v);
    assert.equal(r.ok, true, JSON.stringify(r));
    // make the change times distinct on fast file systems
    fs.utimesSync(path.join(cacheDir, v), new Date(Date.now() - 1000 * (10 - versions.indexOf(v))), new Date(Date.now() - 1000 * (10 - versions.indexOf(v))));
  }
  const kept = fs.readdirSync(cacheDir).sort();
  assert.equal(kept.length, MAX_CACHED_VERSIONS);
  assert.ok(kept.includes("0.6.0"), "the version just resolved is always kept");
});
