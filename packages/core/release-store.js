"use strict";
// release-store.js — where the Figaf Platform releases come from
// (figaf-platform decision 0010).
//
// A RELEASE is a versioned set: catalog.json, release.json (checksums and the
// source commit), xs-security.json and one zip per CF app. Releases live in a
// STORE. Two kinds, one code path:
//
//   remote  the artifact store (Cloudflare R2 behind a public URL). Layout,
//           the contract with the figaf-platform repo (release/publish.js):
//             <url>/index.json              { latest, versions: [{ version, publishedAt }] }
//             <url>/<version>/catalog.json   the release catalog
//             <url>/<version>/release.json   { files: [{ name, size, sha256 }], source, ... }
//             <url>/<version>/<file>         xs-security.json, backend.zip, <app-id>.zip
//           Versions are immutable, so a downloaded version is cached on the
//           container disk under <cacheDir>/<version>/ and never re-fetched.
//           Only index.json changes; it is read again after INDEX_TTL_MS.
//   local   one release in a directory, in the flat shape build.js
//           writes (catalog.json next to the zips). Development and e2e tests.
//
// Every network read is one line in the terminal drawer (`>> GET <url>`) and
// every downloaded file is checked against its sha256 before it is used:
// catalog.json and the config files against release.json, the zips against
// the catalog. A mismatch is an error; nothing half-verified is used.

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { compareSemver } = require("./release-config");

const VERSION_RE = /^\d+\.\d+\.\d+$/;
const INDEX_TTL_MS = 30_000;
const MAX_CACHED_VERSIONS = 4;

// ─── pure helpers (unit-tested) ──────────────────────────────────────────────

function stripBom(text) {
  return String(text).replace(/^﻿/, "");
}

function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/** Read + validate <dir>/catalog.json. Returns { ok, catalog } or { ok:false, error }. */
function loadCatalog(dir) {
  const file = path.join(dir, "catalog.json");
  if (!fs.existsSync(file)) return { ok: false, error: `catalog.json not found in ${dir}` };
  let parsed;
  try {
    // strip a UTF-8 BOM - a hand-edited or fixture file may carry one
    parsed = JSON.parse(stripBom(fs.readFileSync(file, "utf8")));
  } catch (e) {
    return { ok: false, error: `catalog.json is not valid JSON: ${e.message}` };
  }
  return validateCatalog(parsed);
}

function validateCatalog(parsed) {
  if (!parsed || !Array.isArray(parsed.apps)) {
    return { ok: false, error: "catalog.json must have an 'apps' array" };
  }
  if (parsed.platform != null) {
    if (!Array.isArray(parsed.platform.cfApps) || parsed.platform.cfApps.length === 0) {
      return { ok: false, error: "catalog 'platform' needs a non-empty cfApps array" };
    }
    for (const c of parsed.platform.cfApps) {
      if (!c.name || !c.artifact) {
        return { ok: false, error: "catalog 'platform' has a cfApp without name/artifact" };
      }
    }
  }
  for (const app of parsed.apps) {
    if (!app.id || !app.version || !Array.isArray(app.cfApps) || app.cfApps.length === 0) {
      return { ok: false, error: `catalog app '${app.id || "?"}' needs id, version and a non-empty cfApps array` };
    }
    for (const c of app.cfApps) {
      if (!c.name || !c.artifact) {
        return { ok: false, error: `catalog app '${app.id}' has a cfApp without name/artifact` };
      }
    }
  }
  // Catalog v3: service INSTANCES the manager creates when missing.
  if (parsed.services != null) {
    if (!Array.isArray(parsed.services)) return { ok: false, error: "catalog 'services' must be an array" };
    for (const s of parsed.services) {
      if (!s.name || !s.offering || !s.plan) {
        return { ok: false, error: `catalog service '${s.name || "?"}' needs name, offering and plan` };
      }
      if (s.plans != null && (!Array.isArray(s.plans) || !s.plans.includes(s.plan))) {
        return { ok: false, error: `catalog service '${s.name}': 'plans' must be an array containing the default plan` };
      }
    }
  }
  return { ok: true, catalog: parsed };
}

/** The version a catalog carries (releaseVersion; channelVersion is the legacy alias). */
function catalogVersion(catalog) {
  return (catalog && (catalog.releaseVersion || catalog.channelVersion)) || null;
}

/** Validate an index.json document. Returns { ok, latest, versions } or { ok:false, error }. */
function parseIndex(doc) {
  if (!doc || typeof doc !== "object" || !Array.isArray(doc.versions)) {
    return { ok: false, error: "index.json must have a 'versions' array" };
  }
  const versions = [];
  for (const v of doc.versions) {
    if (!v || !VERSION_RE.test(String(v.version || ""))) return { ok: false, error: `index.json lists an invalid version: ${JSON.stringify(v && v.version)}` };
    versions.push({ version: v.version, publishedAt: v.publishedAt || null });
  }
  if (!versions.length) return { ok: false, error: "index.json lists no versions" };
  versions.sort((a, b) => compareSemver(b.version, a.version));
  const latest = doc.latest && versions.some((v) => v.version === doc.latest) ? doc.latest : versions[0].version;
  return { ok: true, latest, versions };
}

/**
 * Which version an action uses (decision 0010, "one version per installation").
 *
 *   requested  a version the caller named (UI dropdown), or undefined
 *   installed  the version of the shared backend in the space, or null
 *   latest     the newest version in the store
 *   versions   every version in the store (strings)
 *   purpose    "install" — deploy one app: always the installed version
 *              "update"  — move the whole installation: only upwards
 *              "read"    — read a catalog (services, roles): installed, else latest
 *
 * Returns { ok, version, note? } or { ok:false, error }.
 */
function chooseVersion({ requested, installed, latest, versions, purpose = "read" }) {
  const known = new Set(versions || []);
  const listed = (versions || []).join(", ") || "none";
  if (requested != null && requested !== "") {
    if (!known.has(requested)) return { ok: false, error: `version ${requested} is not in the release store (available: ${listed})` };
    if (purpose === "install" && installed && requested !== installed) {
      return { ok: false, error: `Install uses the installed version ${installed}; to move the installation to ${requested}, use Update` };
    }
    if (purpose === "install" && !installed && requested !== latest) {
      return { ok: false, error: `nothing is installed yet — Install uses the latest release, ${latest}, not ${requested}` };
    }
    if (purpose === "update") {
      if (!installed) return { ok: false, error: "nothing is installed yet — install an app first; Install uses the latest release" };
      if (compareSemver(requested, installed) < 0) {
        return { ok: false, error: `version ${requested} is lower than the installed ${installed} — rollback is not supported (forward-only migrations); choose ${installed} or higher` };
      }
    }
    return { ok: true, version: requested };
  }
  if (purpose === "update") {
    if (!installed) return { ok: false, error: "nothing is installed yet — install an app first; Install uses the latest release" };
    if (!known.has(latest)) return { ok: false, error: `latest version ${latest} is not in the release store (available: ${listed})` };
    if (compareSemver(latest, installed) <= 0) return { ok: false, error: `the installation is already at ${installed}; nothing newer than that is in the release store` };
    return { ok: true, version: latest };
  }
  if (installed) {
    if (known.has(installed)) return { ok: true, version: installed };
    if (purpose === "install") {
      return { ok: false, error: `the installed version ${installed} is not in the release store (available: ${listed}) — use Update to move the installation to a listed version first` };
    }
    return { ok: true, version: latest, note: `installed version ${installed} is not in the store; using ${latest}` };
  }
  if (!known.has(latest)) return { ok: false, error: `latest version ${latest} is not in the release store (available: ${listed})` };
  return { ok: true, version: latest };
}

/** One line for the UI: what the store is. */
function describeSource(source) {
  if (!source) return null;
  if (source.kind === "remote") return { kind: "remote", location: source.url, label: `${source.url} (release store)` };
  return { kind: "local", location: source.dir, label: `${source.dir} (local directory, development)` };
}

function fmtBytes(n) {
  return Number(n || 0).toLocaleString("en-US") + " bytes";
}

// ─── the store ───────────────────────────────────────────────────────────────

/**
 * @param {object} o
 * @param {object} o.source        { kind:"remote", url, cacheDir? } | { kind:"local", dir }
 * @param {Function} o.fetchJson   (url) => Promise<object>          remote only
 * @param {Function} o.download    (url, destPath) => Promise<any>   remote only
 * @param {Function} [o.log]       (source, type, text) terminal drawer line
 * @param {Function} [o.now]       clock (tests)
 */
function createReleaseStore({ source, fetchJson, download, log, now }) {
  if (!source || (source.kind !== "remote" && source.kind !== "local")) throw new Error("release store needs a source of kind remote or local");
  const clock = now || (() => Date.now());
  const say = (type, text) => { if (log) log("faid", type, text); };
  const remote = source.kind === "remote";
  const baseUrl = remote ? String(source.url).replace(/\/+$/, "") : null;
  const cacheDir = remote ? (source.cacheDir || path.join(os.tmpdir(), "figaf-platform-releases")) : null;
  let indexMemo = null; // { at, value }

  // GET a small JSON object; one visible line.
  async function getJson(url) {
    say("dim", `>> GET ${url}`);
    try { return { ok: true, doc: await fetchJson(url) }; }
    catch (e) { return { ok: false, error: `cannot read ${url}: ${(e && e.message) || e}` }; }
  }

  // Download one file into dir atomically: to a .part file first, renamed
  // when complete. Two sessions fetching the same version never see a
  // half-written file. Returns { ok, path, size } or { ok:false, error }.
  async function downloadTo(url, dir, name) {
    const dest = path.join(dir, name);
    const part = `${dest}.part-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
    say("dim", `>> GET ${url}`);
    try {
      fs.mkdirSync(dir, { recursive: true });
      await download(url, part);
      fs.renameSync(part, dest);
      return { ok: true, path: dest, size: fs.statSync(dest).size };
    } catch (e) {
      try { fs.rmSync(part, { force: true }); } catch { /* nothing to clean */ }
      return { ok: false, error: `download of ${name} failed: ${(e && e.message) || e}` };
    }
  }

  // Verify a file against an expected sha256 (lower-case hex). Deletes the
  // file on a mismatch so the next attempt downloads it again. `quiet`: a
  // cached file that is fine gets no line (the page reads the release many
  // times; only downloads and explicit refreshes are worth a line).
  function verify(file, name, expected, origin, { quiet, cached } = {}) {
    const size = fmtBytes(fs.statSync(file).size);
    const tail = cached ? " (cached)" : "";
    if (!expected) { if (!quiet) say("dim", `   ${name} ${size} (no checksum in ${origin})${tail}`); return { ok: true }; }
    const actual = sha256File(file);
    if (actual !== String(expected).toLowerCase()) {
      try { fs.rmSync(file, { force: true }); } catch { /* ignore */ }
      return { ok: false, error: `checksum mismatch for ${name}: ${origin} says ${expected}, the ${cached ? "cached file" : "download"} is ${actual} — the store content is corrupt or was changed; nothing was used` };
    }
    if (!quiet) say("dim", `   ${name} ${size}, sha256 ok${tail}`);
    return { ok: true };
  }

  // Keep the cache small: at most MAX_CACHED_VERSIONS version directories,
  // the oldest (by change time) removed first, never the one just resolved.
  function evict(keep) {
    try {
      const dirs = fs.readdirSync(cacheDir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && d.name !== keep)
        .map((d) => ({ name: d.name, at: fs.statSync(path.join(cacheDir, d.name)).mtimeMs }))
        .sort((a, b) => a.at - b.at);
      while (dirs.length > MAX_CACHED_VERSIONS - 1) {
        const victim = dirs.shift();
        fs.rmSync(path.join(cacheDir, victim.name), { recursive: true, force: true });
        say("dim", `   cache: removed release ${victim.name}`);
      }
    } catch { /* the cache is a convenience */ }
  }

  return {
    describe() { return describeSource(remote ? { kind: "remote", url: baseUrl } : source); },

    /**
     * The versions the store offers. { ok, latest, versions:[{version, publishedAt}] }.
     * Remote: index.json, memoised for INDEX_TTL_MS unless `refresh`.
     * Local: the one catalog in the directory.
     */
    async index({ refresh } = {}) {
      if (!remote) {
        const c = loadCatalog(source.dir);
        if (!c.ok) return { ok: false, error: c.error };
        const v = catalogVersion(c.catalog);
        if (!v) return { ok: false, error: "catalog.json has no releaseVersion" };
        return { ok: true, latest: v, versions: [{ version: v, publishedAt: null }] };
      }
      if (!refresh && indexMemo && clock() - indexMemo.at < INDEX_TTL_MS) return indexMemo.value;
      const r = await getJson(`${baseUrl}/index.json`);
      if (!r.ok) return r;
      const parsed = parseIndex(r.doc);
      if (!parsed.ok) return { ok: false, error: `${baseUrl}/index.json: ${parsed.error}` };
      indexMemo = { at: clock(), value: parsed };
      return parsed;
    },

    /**
     * Make one version usable: its catalog, release.json and config files in
     * a local directory, verified. { ok, version, dir, catalog, release } or
     * { ok:false, error }. Local: the directory itself, no copy.
     * Lines in the terminal: every download; cached files only with `verbose`
     * (an explicit refresh), so that the page's many reads stay silent.
     */
    async resolve(version, { verbose } = {}) {
      if (!remote) {
        const c = loadCatalog(source.dir);
        if (!c.ok) return { ok: false, error: c.error };
        const v = catalogVersion(c.catalog);
        if (version && v !== version) return { ok: false, error: `the local release directory holds ${v || "?"}, not ${version}` };
        return { ok: true, version: v, dir: source.dir, catalog: c.catalog, release: null };
      }
      if (!VERSION_RE.test(String(version || ""))) return { ok: false, error: `invalid version ${JSON.stringify(version)}` };
      const dir = path.join(cacheDir, version);
      const url = (name) => `${baseUrl}/${version}/${name}`;

      // release.json: the checksums of the small files. Optional for releases
      // published before it existed; then the small files are used unverified
      // (the zips are still checked against the catalog).
      let release = null;
      const relPath = path.join(dir, "release.json");
      if (!fs.existsSync(relPath)) {
        const d = await downloadTo(url("release.json"), dir, "release.json");
        if (!d.ok) say("warn", `${d.error} — continuing without release.json checksums`);
      }
      if (fs.existsSync(relPath)) {
        try { release = JSON.parse(stripBom(fs.readFileSync(relPath, "utf8"))); }
        catch (e) { fs.rmSync(relPath, { force: true }); return { ok: false, error: `release.json of ${version} is not valid JSON: ${e.message}` }; }
      }
      const expectedSha = (name) => {
        const f = release && Array.isArray(release.files) ? release.files.find((x) => x.name === name) : null;
        return f ? f.sha256 : null;
      };

      // catalog.json and every config file: download once, verify every time.
      const need = async (name) => {
        const file = path.join(dir, name);
        if (!fs.existsSync(file)) {
          const d = await downloadTo(url(name), dir, name);
          if (!d.ok) return d;
          return verify(file, name, expectedSha(name), "release.json");
        }
        return verify(file, name, expectedSha(name), "release.json", { quiet: !verbose, cached: true });
      };
      if (verbose) say("dim", `release ${version} from ${baseUrl}: checking the cached files …`);
      const c1 = await need("catalog.json");
      if (!c1.ok) return { ok: false, error: `release ${version}: ${c1.error}` };
      const c = loadCatalog(dir);
      if (!c.ok) return { ok: false, error: `release ${version}: ${c.error}` };
      const v = catalogVersion(c.catalog);
      if (v !== version) return { ok: false, error: `release ${version}: its catalog says ${v} — the store content is inconsistent` };
      for (const s of c.catalog.services || []) {
        if (!s.configFile) continue;
        const r = await need(s.configFile);
        if (!r.ok) return { ok: false, error: `release ${version}: ${r.error}` };
      }
      evict(version);
      return { ok: true, version, dir, catalog: c.catalog, release };
    },

    /**
     * The local path of one artifact (zip) of a resolved release, downloaded
     * when missing and checked against the catalog's sha256. { ok, path } or
     * { ok:false, error }.
     */
    async ensureArtifact(rel, name) {
      const file = path.join(rel.dir, name);
      if (!remote) {
        if (!fs.existsSync(file)) return { ok: false, error: `${name} is missing from the local release directory ${rel.dir}` };
        return { ok: true, path: file };
      }
      const cfApps = [...((rel.catalog.platform && rel.catalog.platform.cfApps) || []), ...(rel.catalog.apps || []).flatMap((a) => a.cfApps || [])];
      const entry = cfApps.find((c) => c.artifact === name);
      const expected = entry && entry.sha256 ? String(entry.sha256).toLowerCase() : null;
      if (fs.existsSync(file) && (!expected || sha256File(file) === expected)) {
        say("dim", `   ${name}: cached (${fmtBytes(fs.statSync(file).size)}${expected ? ", sha256 ok" : ""})`);
        return { ok: true, path: file };
      }
      const d = await downloadTo(`${baseUrl}/${rel.version}/${name}`, rel.dir, name);
      if (!d.ok) return d;
      const v = verify(file, name, expected, "the catalog");
      if (!v.ok) return v;
      return { ok: true, path: file };
    },
  };
}

module.exports = {
  VERSION_RE,
  INDEX_TTL_MS,
  MAX_CACHED_VERSIONS,
  loadCatalog,
  validateCatalog,
  catalogVersion,
  parseIndex,
  chooseVersion,
  describeSource,
  sha256File,
  createReleaseStore,
};
