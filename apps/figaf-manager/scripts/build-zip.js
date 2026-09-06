#!/usr/bin/env node
// Assembles figaf-manager-app-<version>.zip for BTP Cockpit "Deploy Application".
//
// What it does:
//   1. Download Linux x86_64 btp + cf binaries into bin/. The versions are the
//      exact pins in package.json (btpCliVersion, cfCliVersion). The download is
//      skipped only when bin/VERSIONS.json records the same versions; a changed
//      pin re-downloads. The cf download must resolve to a file name that carries
//      the pinned version, otherwise the build fails. bin/VERSIONS.json ships in
//      the zip; the About page shows it (prereq:bundledVersions).
//   2. Stage a self-contained app tree in apps/figaf-manager/.staging/:
//        cloud/, host.cloud.js, bin/, manifest.yml, package.json,
//        node_modules/@figaf/{core,ui}/  (copied from packages/, NOT symlinked —
//                                         the logo lives inside @figaf/ui),
//        node_modules/{express,ws,…}      (installed by npm install in staging).
//   3. Zip the staging directory contents → dist/figaf-manager-app-<version>.zip
//
// Run from inside apps/figaf-manager/:  node scripts/build-zip.js

"use strict";
const fs   = require("fs");
const fsp  = fs.promises;
const path = require("path");
const os   = require("os");
const https = require("https");
const { execSync, spawnSync } = require("child_process");

const APP_DIR        = path.join(__dirname, "..");
const WORKSPACE_ROOT = path.join(APP_DIR, "..", "..");
const pkg            = JSON.parse(fs.readFileSync(path.join(APP_DIR, "package.json"), "utf8"));

let archiver;
try {
  archiver = require("archiver");
} catch {
  console.error("\narchiver not found — run  npm install  at the workspace root first (installs devDependencies)");
  process.exit(1);
}

const VERSION      = pkg.version;
const BTP_VERSION  = pkg.btpCliVersion;
const CF_VERSION   = pkg.cfCliVersion;
const NODE_ENGINE  = (pkg.engines && pkg.engines.node) || null;
if (!BTP_VERSION || !CF_VERSION) {
  console.error("\napps/figaf-manager/package.json must pin btpCliVersion and cfCliVersion (exact versions).");
  process.exit(1);
}

const BIN_DIR       = path.join(APP_DIR, "bin");
const VERSIONS_FILE = path.join(BIN_DIR, "VERSIONS.json");
const STAGE_DIR     = path.join(APP_DIR, ".staging");
const DIST_DIR      = path.join(APP_DIR, "dist");
const OUT_ZIP       = path.join(DIST_DIR, `figaf-manager-app-${VERSION}.zip`);

function cfDownloadUrl(version) {
  return `https://packages.cloudfoundry.org/stable?release=linux64-binary&version=${version}&source=github`;
}
function btpDownloadUrl(version) {
  return `https://tools.hana.ondemand.com/additional/btp-cli-linux-amd64-${version}.tar.gz`;
}

// bin/VERSIONS.json: what the build put into bin/ (and, after staging, the
// exact npm dependency versions). Read at runtime by host.getBundledVersions().
function readVersions() {
  try { return JSON.parse(fs.readFileSync(VERSIONS_FILE, "utf8")); } catch { return null; }
}
function writeVersions() {
  const v = {
    manager: VERSION,
    btp: BTP_VERSION,
    cf: CF_VERSION,
    node: NODE_ENGINE,
    builtAt: new Date().toISOString(),
    sources: { btp: btpDownloadUrl(BTP_VERSION), cf: cfDownloadUrl(CF_VERSION) },
  };
  fs.writeFileSync(VERSIONS_FILE, JSON.stringify(v, null, 2) + "\n");
  return v;
}

// Exact installed versions from the workspace package-lock.json (what `npm ci`
// installs in CI): the workspace's own node_modules entry first, then the
// hoisted one. Rewrites `deps` in place and returns the pins.
function pinFromLockfile(deps, skip, workspacePath) {
  const lock = JSON.parse(fs.readFileSync(path.join(WORKSPACE_ROOT, "package-lock.json"), "utf8"));
  const pinned = {};
  for (const name of Object.keys(deps)) {
    if (skip.includes(name)) continue;
    const local   = lock.packages[`${workspacePath}/node_modules/${name}`];
    const hoisted = lock.packages[`node_modules/${name}`];
    const v = (local && local.version) || (hoisted && hoisted.version);
    if (!v) throw new Error(`${name} is not in package-lock.json — run npm install at the workspace root and commit the lockfile`);
    deps[name] = v;
    pinned[name] = v;
  }
  return pinned;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function log(msg) { process.stdout.write(msg + "\n"); }

function copyDir(src, dest, shouldSkip = () => false) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (shouldSkip(entry.name)) continue;
    if (entry.isDirectory()) copyDir(s, d, shouldSkip);
    else if (entry.isFile() || entry.isSymbolicLink()) {
      try { fs.copyFileSync(s, d); } catch (e) { /* skip dangling symlinks */ }
    }
  }
}

// Resolves with the redirect chain (every URL visited, the final one last) so
// callers can verify WHAT was downloaded, not only that something was.
function httpsGet(url, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    const chain = [];
    function fetch(currentUrl, hops) {
      chain.push(currentUrl);
      if (hops > 8) return reject(new Error("Too many redirects"));
      const headers = {
        "User-Agent": "figaf-manager-build",
        "Cookie": "eula_3_2_agreed=tools.hana.ondemand.com/developer-license-3_2.txt",
      };
      https.get(currentUrl, { headers }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
          res.resume();
          return fetch(res.headers.location, hops + 1);
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode} for ${currentUrl}`));
        }
        const total = parseInt(res.headers["content-length"] || "0", 10);
        let got = 0;
        const out = fs.createWriteStream(destPath);
        res.on("data", (chunk) => {
          got += chunk.length;
          if (onProgress && total) onProgress(got, total);
        });
        res.pipe(out);
        out.on("finish", () => resolve({ chain }));
        out.on("error", reject);
        res.on("error", reject);
      }).on("error", reject);
    }
    fetch(url, 0);
  });
}

function extractTarGz(tarPath, destDir, stripComponents = 1, excludes = []) {
  // On Windows, pin the System32 tar (bsdtar): it understands `C:\` paths.
  // A GNU tar found on PATH (e.g. Git for Windows) parses the drive letter
  // as a remote host ("Cannot connect to C: resolve failed").
  const tarBin = process.platform === "win32"
    ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe")
    : "tar";
  const result = spawnSync(tarBin, [
    "-xzf", tarPath,
    "-C", destDir,
    `--strip-components=${stripComponents}`,
    // --exclude entries: the cf CLI tarball ships `cf` as a symlink to `cf8`;
    // Windows tar cannot create symlinks ("Can't create ...: Invalid
    // argument"), and we rename cf8 → cf ourselves right after extraction.
    ...excludes.map((e) => `--exclude=${e}`),
  ], { stdio: "inherit" });
  if (result.status !== 0) throw new Error(`tar extraction failed (exit ${result.status})`);
}

// ─── Step 1: Download CLI binaries ────────────────────────────────────────────

async function ensureBinaries() {
  await fsp.mkdir(BIN_DIR, { recursive: true });
  const recorded = readVersions();
  const btpBin = path.join(BIN_DIR, "btp");
  const cfBin  = path.join(BIN_DIR, "cf");

  // A binary is reused only when bin/VERSIONS.json says it IS the pinned
  // version. An unrecorded binary (older builds wrote no record) is replaced.
  const needBtp = !fs.existsSync(btpBin) || !recorded || recorded.btp !== BTP_VERSION;
  const needCf  = !fs.existsSync(cfBin)  || !recorded || recorded.cf  !== CF_VERSION;

  if (needBtp) {
    if (fs.existsSync(btpBin)) {
      log(`[btp] bin/btp is ${(recorded && recorded.btp) || "unrecorded"}, pin is ${BTP_VERSION} — re-downloading.`);
      fs.unlinkSync(btpBin);
    }
    const btpTarName = `btp-cli-linux-amd64-${BTP_VERSION}.tar.gz`;
    const tmpTar = path.join(os.tmpdir(), btpTarName);
    log(`[btp] Downloading ${btpTarName}…`);
    await httpsGet(btpDownloadUrl(BTP_VERSION), tmpTar, (got, total) =>
      process.stdout.write(`\r[btp] ${Math.round((got / total) * 100)}%   `));
    process.stdout.write("\n");
    log("[btp] Extracting…");
    extractTarGz(tmpTar, BIN_DIR);
    const keep = new Set(["btp", "cf", "cf8", "LICENSE", "NOTICE", "VERSIONS.json"]);
    const found = fs.readdirSync(BIN_DIR).find(f => !f.endsWith(".tar.gz") && !f.endsWith(".gitkeep") && !keep.has(f));
    if (found) fs.renameSync(path.join(BIN_DIR, found), btpBin);
    if (!fs.existsSync(btpBin)) throw new Error("btp binary missing after extraction");
    fs.chmodSync(btpBin, "755");
    try { fs.unlinkSync(tmpTar); } catch {}
    log(`[btp] Done (${BTP_VERSION}).`);
  } else {
    log(`[btp] bin/btp is ${BTP_VERSION} (bin/VERSIONS.json) — skipping download.`);
  }

  if (needCf) {
    if (fs.existsSync(cfBin)) {
      log(`[cf]  bin/cf is ${(recorded && recorded.cf) || "unrecorded"}, pin is ${CF_VERSION} — re-downloading.`);
      fs.unlinkSync(cfBin);
    }
    const marker = `cf8-cli_${CF_VERSION}_linux_x86-64`;
    const tmpTar = path.join(os.tmpdir(), `${marker}.tgz`);
    log(`[cf]  Downloading cf CLI ${CF_VERSION} (linux64)…`);
    const { chain } = await httpsGet(cfDownloadUrl(CF_VERSION), tmpTar, (got, total) =>
      total ? process.stdout.write(`\r[cf]  ${Math.round((got / total) * 100)}%   `) : null);
    process.stdout.write("\n");
    // packages.cloudfoundry.org redirects to the GitHub release asset; the
    // asset name carries the version. No match = not the pinned version.
    const visited = chain.map((u) => { try { return decodeURIComponent(u); } catch { return u; } });
    if (!visited.some((u) => u.includes(marker))) {
      try { fs.unlinkSync(tmpTar); } catch {}
      throw new Error(`cf download did not resolve to ${marker}.tgz (last URL: ${visited[visited.length - 1]}) — refusing to bundle an unverified version`);
    }
    log("[cf]  Extracting…");
    extractTarGz(tmpTar, BIN_DIR, 0, ["cf"]);
    const cf8 = path.join(BIN_DIR, "cf8");
    if (fs.existsSync(cf8)) fs.renameSync(cf8, cfBin);
    if (!fs.existsSync(cfBin)) throw new Error("cf binary missing after extraction (expected cf8 in the tarball)");
    fs.chmodSync(cfBin, "755");
    try { fs.unlinkSync(tmpTar); } catch {}
    log(`[cf]  Done (${CF_VERSION}).`);
  } else {
    log(`[cf]  bin/cf is ${CF_VERSION} (bin/VERSIONS.json) — skipping download.`);
  }

  const v = writeVersions();
  log(`[bin] VERSIONS.json written: btp ${v.btp}, cf ${v.cf}, node ${v.node || "unpinned"}.`);
}

// ─── Step 2: Stage a self-contained app tree ──────────────────────────────────

async function stage() {
  log("[stage] Preparing .staging/…");
  fs.rmSync(STAGE_DIR, { recursive: true, force: true });
  fs.mkdirSync(STAGE_DIR);

  copyDir(path.join(APP_DIR, "cloud"), path.join(STAGE_DIR, "cloud"), name => name.endsWith(".test.js"));
  copyDir(BIN_DIR,                     path.join(STAGE_DIR, "bin"));
  fs.copyFileSync(path.join(APP_DIR, "host.cloud.js"),    path.join(STAGE_DIR, "host.cloud.js"));
  fs.copyFileSync(path.join(APP_DIR, "manifest.yml"),     path.join(STAGE_DIR, "manifest.yml"));

  // L3 releases are NOT bundled (figaf-l3-l4 decision 0010): the manager reads
  // them from the release store named by FIGAF_L3_RELEASE_URL in manifest.yml.
  // A developer's l3-artifacts/ in the checkout is a local source for
  // `npm start` and the e2e install smoke only.
  const manifest = fs.readFileSync(path.join(APP_DIR, "manifest.yml"), "utf8");
  const releaseUrl = /^\s*FIGAF_L3_RELEASE_URL:\s*(\S+)/m.exec(manifest);
  if (!releaseUrl) {
    console.error("\nmanifest.yml must set FIGAF_L3_RELEASE_URL (the L3 release store) — the zip ships no bundled release.");
    process.exit(1);
  }
  log(`[stage] L3 releases come from ${releaseUrl[1]} (manifest.yml); nothing bundled.`);

  // Staged package.json strategy for @figaf/* workspace packages:
  //
  // Problem A: "file:packages/core" / "file:packages/ui" in dependencies causes
  // npm install on Windows to create absolute-path symlinks pointing to the
  // Windows build machine path. Those symlinks break on CF's Linux container.
  //
  // Problem B (previous fix was wrong): deleting @figaf/* from dependencies
  // causes the CF nodejs buildpack's own `npm install` (run during CF staging)
  // to prune them from node_modules/ — because npm prunes packages that are in
  // node_modules but absent from package.json. Log evidence: "removed 2 packages
  // in 3s" during CF staging, then MODULE_NOT_FOUND at runtime.
  //
  // Correct fix: copy @figaf/* as real directories FIRST, then write a staged
  // package.json that keeps them in dependencies (with version strings, not
  // file: paths) AND declares them in bundledDependencies. The bundledDependencies
  // field tells npm: "these are already present in node_modules/ — do not fetch
  // from the registry and do not prune them." Both our local npm install and the
  // CF buildpack's npm install honour this contract.

  log("[stage] Copying @figaf/core and @figaf/ui into node_modules/ as real directories…");
  const figafNmDir = path.join(STAGE_DIR, "node_modules", "@figaf");
  fs.mkdirSync(figafNmDir, { recursive: true });
  copyDir(path.join(WORKSPACE_ROOT, "packages", "core"), path.join(figafNmDir, "core"));
  copyDir(path.join(WORKSPACE_ROOT, "packages", "ui"),   path.join(figafNmDir, "ui"));

  const corePkgVersion = JSON.parse(fs.readFileSync(path.join(WORKSPACE_ROOT, "packages", "core", "package.json"), "utf8")).version;
  const uiPkgVersion   = JSON.parse(fs.readFileSync(path.join(WORKSPACE_ROOT, "packages", "ui",   "package.json"), "utf8")).version;

  const stagedPkg = JSON.parse(JSON.stringify(pkg));
  stagedPkg.dependencies["@figaf/core"] = corePkgVersion;
  stagedPkg.dependencies["@figaf/ui"]   = uiPkgVersion;
  stagedPkg.bundledDependencies = ["@figaf/core", "@figaf/ui"];
  delete stagedPkg.bundleDependencies;
  // Exact versions for the public dependencies, from the workspace lockfile.
  // Without this, `npm install` below would float within the package.json
  // ranges on every build. (Transitive dependencies still resolve at build
  // time — a staged lockfile is the next step, after a manager push test.)
  const pins = pinFromLockfile(stagedPkg.dependencies, ["@figaf/core", "@figaf/ui"], "apps/figaf-manager");
  log(`[stage] Pinned from package-lock.json: ${Object.entries(pins).map(([n, v]) => `${n}@${v}`).join(", ")}`);
  fs.writeFileSync(path.join(STAGE_DIR, "package.json"), JSON.stringify(stagedPkg, null, 2));

  log("[stage] Running npm install --omit=dev in staging (public registry deps only)…");
  execSync("npm install --omit=dev --no-package-lock --no-audit --no-fund", {
    cwd: STAGE_DIR,
    stdio: "inherit",
  });

  const installed = {};
  for (const name of Object.keys(stagedPkg.dependencies)) {
    try { installed[name] = JSON.parse(fs.readFileSync(path.join(STAGE_DIR, "node_modules", name, "package.json"), "utf8")).version; }
    catch { installed[name] = null; }
  }

  // v2 XSUAA upgrade (auth-gate-implementation-plan.md §2.4):
  // bundle the wizard's approuter (`@figaf/manager-approuter`) so the
  // manager dyno can `cf push` it as a second app during the upgrade flow.
  // It is NOT a runtime dependency of figaf-manager — it is a payload
  // shipped INSIDE the manager's zip, copied out at upgrade time. Hence we
  // stage it at .staging/manager-approuter/ (sibling of cloud/, NOT under
  // packages/), with its own node_modules/ populated by a separate
  // `npm install --omit=dev` so the buildpack doesn't need to touch it.
  const approuterVersion = await stageManagerApprouter();

  // The staged copy of bin/VERSIONS.json gets the exact npm versions too.
  const bins = readVersions();
  if (!bins) throw new Error("bin/VERSIONS.json is missing — run the build once without --skip-binaries so the CLI versions are recorded");
  const staged = { ...bins, npm: { ...installed, ...(approuterVersion ? { "@sap/approuter": approuterVersion } : {}) } };
  fs.writeFileSync(path.join(STAGE_DIR, "bin", "VERSIONS.json"), JSON.stringify(staged, null, 2) + "\n");
  log(`[stage] bin/VERSIONS.json: btp ${staged.btp}, cf ${staged.cf}, node ${staged.node || "unpinned"}, ${Object.entries(staged.npm).map(([n, v]) => `${n}@${v}`).join(", ")}`);

  log("[stage] Done.");
}

// v2: stage the wizard-scoped approuter as a payload inside the cloud zip.
// At runtime host.cloud.js#resolveManagerApprouterDir() extracts the tarball
// once into <app>/manager-approuter/, then cf:pushManagerApprouter runs
// `cf push -p <extracted-dir>` against it.
//
// Why a tarball instead of a plain directory: BTP Cockpit "Deploy Application"
// caps the upload at 5,000 distinct resources. @sap/approuter alone ships
// ~6,400 files, so bundling it as a directory blows the cap with a 500-style
// "Resources array can have at most 5000 resources" error. Collapsing it to a
// single tarball entry keeps the cockpit-uploadable zip well under the limit.
// node_modules is bundled (inside the tarball) so the wizard does not depend
// on outbound npm-registry egress from the manager dyno during the v2 upgrade.
async function stageManagerApprouter() {
  const src  = path.join(WORKSPACE_ROOT, "packages", "manager-approuter");
  if (!fs.existsSync(src)) {
    log("[stage] manager-approuter not present in workspace — skipping (v2 bundle disabled)");
    return;
  }
  log("[stage] Bundling manager-approuter (v2 XSUAA bootstrap payload)…");

  // Install into a scratch dir OUTSIDE .staging/ so the 6k+ node_modules
  // files never enter the cockpit zip's resource enumeration.
  const scratch = path.join(APP_DIR, ".staging-approuter");
  fs.rmSync(scratch, { recursive: true, force: true });
  fs.mkdirSync(scratch, { recursive: true });
  copyDir(src, scratch, name => name === "node_modules" || name === "static" || name.endsWith(".test.js"));

  // Same rule as the manager itself: exact versions from the workspace lockfile.
  const approuterPkgPath = path.join(scratch, "package.json");
  const approuterPkg = JSON.parse(fs.readFileSync(approuterPkgPath, "utf8"));
  const approuterPins = pinFromLockfile(approuterPkg.dependencies, [], "packages/manager-approuter");
  fs.writeFileSync(approuterPkgPath, JSON.stringify(approuterPkg, null, 2));
  log(`[stage] manager-approuter pinned from package-lock.json: ${Object.entries(approuterPins).map(([n, v]) => `${n}@${v}`).join(", ")}`);

  log("[stage] Running npm install --omit=dev in manager-approuter scratch…");
  execSync("npm install --omit=dev --no-package-lock --no-audit --no-fund", {
    cwd: scratch,
    stdio: "inherit",
  });
  let approuterVersion = null;
  try { approuterVersion = JSON.parse(fs.readFileSync(path.join(scratch, "node_modules", "@sap", "approuter", "package.json"), "utf8")).version; } catch {}

  const tarballOut = path.join(STAGE_DIR, "manager-approuter.tar.gz");
  log("[stage] Compressing manager-approuter → manager-approuter.tar.gz (single entry in zip)…");
  // Use archiver (already a devDep) rather than the system `tar` binary so the
  // build is cross-platform. On Windows, spawnSync("tar", ...) with absolute
  // Windows paths (C:\...) causes POSIX tar to misinterpret the drive letter as
  // a remote host, producing "Cannot connect to C: resolve failed" and exit 128.
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(tarballOut);
    const tgz = archiver("tar", { gzip: true, gzipOptions: { level: 6 } });
    out.on("close", resolve);
    tgz.on("error", reject);
    tgz.pipe(out);
    tgz.directory(scratch, false);
    tgz.finalize();
  });
  fs.rmSync(scratch, { recursive: true, force: true });

  const mb = (fs.statSync(tarballOut).size / 1024 / 1024).toFixed(1);
  log(`[stage] manager-approuter.tar.gz staged (${mb} MB, 1 entry)`);
  return approuterVersion;
}

// ─── Step 3: Build zip from staging ───────────────────────────────────────────

async function buildZip() {
  await fsp.mkdir(DIST_DIR, { recursive: true });
  log(`[zip] Building ${path.basename(OUT_ZIP)}…`);

  const output = fs.createWriteStream(OUT_ZIP);
  const archive = archiver("zip", { zlib: { level: 6 } });

  await new Promise((resolve, reject) => {
    output.on("close", resolve);
    archive.on("error", reject);
    archive.pipe(output);
    archive.directory(STAGE_DIR, false);
    archive.finalize();
  });

  const bytes = fs.statSync(OUT_ZIP).size;
  const mb = (bytes / 1024 / 1024).toFixed(1);
  log(`[zip] Done → ${OUT_ZIP}  (${mb} MB)`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

(async () => {
  log(`\nfigaf-manager build  v${VERSION}`);
  log(`  btp CLI: ${BTP_VERSION}   (package.json btpCliVersion)`);
  log(`  cf  CLI: ${CF_VERSION}   (package.json cfCliVersion)`);
  log(`  node   : ${NODE_ENGINE || "unpinned"}   (package.json engines.node)\n`);

  const skipBinaries = process.argv.includes("--skip-binaries");
  const skipNpm      = process.argv.includes("--skip-npm");
  const skipZip      = process.argv.includes("--skip-zip");

  if (!skipBinaries) await ensureBinaries();
  if (!skipNpm)      await stage();
  if (!skipZip) {
    await buildZip();
    log("\nBuild complete.");
    log(`Upload to BTP Cockpit → Space → Applications → Deploy Application:`);
    log(`  ${OUT_ZIP}`);
  } else {
    log("\nBinaries ready in bin/ — skipped staging + zip.");
  }
})().catch((err) => {
  console.error("\nBuild failed:", err.message);
  process.exit(1);
});
