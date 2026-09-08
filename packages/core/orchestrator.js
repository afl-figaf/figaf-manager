"use strict";
const path = require("path");
const fs = require("fs");
const fsp = fs.promises;
const os = require("os");
const crypto = require("crypto");
const { spawn } = require("child_process");
const https = require("https");
const http = require("http");

// Plain HTTP is accepted for the local machine only (the e2e harness serves
// a fixture release store on 127.0.0.1). Everything else goes over HTTPS.
function httpClientFor(url) {
  return /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(String(url)) ? http : https;
}
const dbSchemas = require("./db-schemas");
const { redactServiceKeyLine } = require("./redact-service-key");
const {
  parseSsoUrlFromMetadata,
  cockpitBaseFromLicense,
  trustConfigUrl,
  cockpitSpaceUrl,
  regionFromLandscape,
  findTrustOrigin,
  pickIasTenant,
  classifyAssignResult,
} = require("./saml-connect");
const { parseGlobalAccountTree } = require("./btp-target");
const {
  parseCfApi,
  parseCfTarget,
  normalizeApiUrl,
  resolveSelfPin,
  explainPinnedLoginFailure,
} = require("./cf-target");
const { patchManifestName } = require("./manifest-patch");
const releaseConfig = require("./release-config");
const { createFaidHandlers } = require("./faid-apps");
const { ownStack, stackArgs } = require("./cf-stack");
const { createConnectionsHandlers } = require("./connections");
const credstoreClient = require("./credstore-client");
// One XSUAA instance for the manager and the apps (figaf-faid decision 0009).
const managerXsuaa = require("./manager-xsuaa");

const DEPLOYMENT_ZIP_URL =
  process.env.FIGAF_DEPLOYMENT_ZIP_URL ||
  "https://github.com/figaf/Figaf-BTP-Deployment/archive/refs/heads/btp-users.zip";

/**
 * @typedef {Object} HostAdapter
 * @property {boolean} isHosted
 *   true → cloud deployment (figaf-manager); false → desktop (figaf-local).
 *   Drives all environment-specific branches in the orchestrator.
 *
 * @property {() => string} getUserDataDir
 *   Per-host writable directory. Electron: app.getPath("userData").
 *   Cloud: $HOME/sessions/<sessionId>.
 *
 * @property {(name: "btp"|"cf") => string} resolveBinary
 *   Returns the full path (or bare name to fall back to PATH) for a CLI
 *   binary. Electron: persisted under userData/cliPaths.json.
 *   Cloud: bundled at /app/bin/<name>.
 *
 * @property {(name: "btp"|"cf", value: string|null) => void} [storeCliPath]
 *   Persist a resolved CLI path. Electron only — cloud has no need.
 *
 * @property {(opts: object) => Promise<string|null>} pickFile
 *   Native file picker. Returns absolute path, or null if cancelled.
 *   Cloud: no-op (returns null).
 *
 * @property {(url: string) => Promise<void>} openExternal
 *   Open URL in the OS's default browser. Cloud: no-op (the browser shim
 *   in cloud/client.js handles this client-side via window.open).
 *
 * @property {() => Promise<string>} readClipboard
 *   Return the system clipboard contents. Cloud: no-op (the browser shim
 *   uses navigator.clipboard).
 *
 * @property {(text: string) => Promise<{ ok: boolean, error?: string }>} writeClipboard
 *   Write `text` to the system clipboard. Electron: clipboard.writeText.
 *   Cloud: no-op returning { ok: false } — the cloud/client.js browser
 *   shim calls navigator.clipboard.writeText directly and never reaches
 *   the server handler.
 *
 * @property {() => { kind: "bundle"|"github", src: string }} resolveDeployTemplate
 *   Where to materialize the deployment template tree from.
 *   Electron: { kind: "bundle", src: <bundled directory> } — copied to
 *             userData/deploy/ on first use.
 *   Cloud:    { kind: "github", src: <zip URL> } — downloaded into
 *             getUserDataDir() on first use.
 *
 * @property {() => string|null} [resolveManagerApprouterDir]
 *   Absolute path to the bundled @figaf/manager-approuter directory (server.js,
 *   xs-app.json, xs-security.json, maintenance.html, node_modules/). Returned
 *   ONLY by hosts that ship the approuter payload — figaf-manager in cloud
 *   mode after a v2-aware build-zip run. Electron returns null (the v2
 *   XSUAA upgrade flow does not apply to the desktop installer).
 *
 * @property {() => object|null} [getBundledVersions]
 *   Cloud only: the contents of bin/VERSIONS.json written by build-zip.js
 *   ({ manager, btp, cf, node, npm, builtAt }). Null when absent (dev
 *   checkout, desktop). Read by prereq:bundledVersions.
 *
 * @property {() => string} getInstalledVersion
 *   Semver of the running app — surfaced to the renderer for the self-update
 *   banner. Electron: app.getVersion(). Cloud: figaf-manager's package.json
 *   version baked into the build-zip.
 *
 * @property {() => string} getUpdateStagingDir
 *   Per-host writable temp dir for staging downloaded self-update artifacts
 *   (the new figaf-manager-app-<v>.zip, or the desktop installer .exe).
 *   Distinct from getUserDataDir so cleanup is cheap and a corrupted
 *   download can't pollute persistent state.
 *
 * @property {() => null | { apiUrl: string, orgName: string, spaceName: string, appName: string, uris: string[] }} getDeployTargetForSelf
 *   Cloud only: parses VCAP_APPLICATION to return the running dyno's own
 *   CF coordinates so the self-redeploy flow can verify the operator's cf
 *   CLI is targeted at the same landscape + org + space before `cf push`.
 *   Returns null on desktop (the desktop self-update opens the GitHub release
 *   page for a manual portable download, rather than redeploying).
 *
 * @property {() => boolean} [isConsoleUI]
 *   Is this host running the FAID Apps console frame (not Alex's classic wizard)?
 *   Cloud: FIGAF_CONSOLE_UI !== "0". Desktop: false. It decides whether the
 *   CF sign-in may pin itself to the manager's own org/space: the console
 *   installs the FAID Apps into its OWN space, while the wizard deploys the
 *   Figaf tool into a space the operator picks. A host without the method
 *   counts as "not the console", so the picker stays.
 */

function patchManifestService(text, serviceName, enable) {
  const re = new RegExp(`^(#?)(  - ${serviceName})$`, "m");
  return text.replace(re, enable ? "$2" : "#$2");
}

function createOrchestrator({ host, send, audit }) {
  const state = {
    landscape: null,
    org: null,
    space: null,
    user: null,
    subaccount: null,
    provider: null,
    globalAccountSubdomain: null,
    btpLoginWaitingForChoice: false,
    subaccountWaitingForChoice: false,
    subaccountList: null,
    gaTree: null,
    globalAccountName: null,
    cfLoginProc: null,
    cfOrgList: null,
    cfSpaceList: null,
    cfWaitingForOrgChoice: false,
    cfWaitingForSpaceChoice: false,
    btpLoginProc: null,
    deployDirResolved: null,
    subaccountSubdomain: null,
    globalAccountGuid: null,
    licenseType: null,
    cfSwitchOrgList: null,
    cfSwitchSelectedOrg: null,
    cfSwitchSpaceList: null,
    // Cached result of the most recent update:checkSelf call. download/extract/
    // push handlers consult this to refuse arbitrary URLs from the renderer.
    lastCheckSelf: null,
  };

  // SAP BTP region → hyperscaler mapping. Suffix tells you the provider for
  // every region we've seen so far (*10/11/12 = AWS, *20/21 = Azure, *30/31 = GCP),
  // Unknown regions fall through to null so the UI just hides the chip.
  function providerFromRegion(region) {
    if (!region) return null;
    const r = String(region).toLowerCase();
    if (/1\d$/.test(r)) return "AWS";
    if (/2\d$/.test(r)) return "Microsoft Azure";
    if (/3\d$/.test(r)) return "Google Cloud Platform";
    return null;
  }

  // Audit logger is optional — callers that don't pass one get a no-op shim
  // so the orchestrator stays runnable in test harnesses and from any
  // host adapter that hasn't been upgraded to v3 yet. See audit-log.js for
  // the full contract.
  const noopHandle = { id: null, exit() {}, out() {}, error() {}, end() {} };
  const auditor = audit || {
    beginCli: () => noopHandle,
    beginRpc: () => noopHandle,
    beginNet: () => noopHandle,
  };

  function log(source, type, text) {
    send("cli:line", { source, type, text });
  }

  function resolveBtp() { return host.resolveBinary("btp"); }
  function resolveCf()  { return host.resolveBinary("cf");  }

  // Shared probe: is the sibling figaf-manager-approuter app present in the
  // currently-targeted org/space? Used by both xsuaa:upgradeStatus (to gate
  // the v2 upgrade UI) and update:pushSelf (to decide whether self-update
  // should co-redeploy the approuter alongside the manager).
  async function probeApprouterPresence() {
    const r = await run(resolveCf(), ["app", "figaf-manager-approuter"], { source: "cf" });
    return r.code === 0;
  }

  // One XSUAA instance (decision 0009). New installations bind the manager to
  // the shared `figaf-faid-xsuaa` (roles of the manager AND the apps). Alex's
  // shipped installations are bound to the legacy `figaf-manager-xsuaa` and
  // keep working: when THIS process is bound to the legacy instance, every
  // xsuaa:* handler keeps talking to it. Nothing creates the legacy instance
  // any more.
  function boundXsuaaInstanceName() {
    try {
      const vs = JSON.parse(process.env.VCAP_SERVICES || "{}");
      for (const b of vs.xsuaa || []) {
        if (b && b.credentials && managerXsuaa.isLegacyXsappname(b.credentials.xsappname)) {
          return managerXsuaa.LEGACY_INSTANCE;
        }
        if (b && b.credentials && managerXsuaa.isSharedXsappname(b.credentials.xsappname)) {
          return managerXsuaa.SHARED_INSTANCE;
        }
      }
    } catch { /* not in CF, or unreadable */ }
    return null;
  }
  function targetXsuaaInstance() {
    return boundXsuaaInstanceName() === managerXsuaa.LEGACY_INSTANCE
      ? managerXsuaa.LEGACY_INSTANCE
      : managerXsuaa.SHARED_INSTANCE;
  }

  // ─── subprocess helpers ────────────────────────────────────────────────────

  // Session-scoped CLI state (hosted mode only). Without this, ~/.cf and the
  // btp client config live in $HOME and are SHARED by every wizard session in
  // the same dyno: after one user completes cf login, every other session —
  // including an attacker's — inherits the authenticated CLI. Scoping CF_HOME
  // and BTP_CLIENTCONFIG to the per-session user-data dir closes that hole.
  // Desktop (Electron) is single-user and keeps the OS-default CLI state.
  function cliEnv(extra) {
    let scoped = {};
    if (host.isHosted) {
      const base = path.join(host.getUserDataDir(), "cli");
      try { fs.mkdirSync(base, { recursive: true }); } catch {}
      scoped = { CF_HOME: base, BTP_CLIENTCONFIG: path.join(base, "btp-config.json") };
    }
    return { ...process.env, ...scoped, ...(extra || {}) };
  }

  function run(cmd, args, opts = {}) {
    return new Promise((resolve) => {
      const proc = spawn(cmd, args, {
        shell: false,
        windowsHide: true,
        cwd: opts.cwd,
        env: cliEnv(opts.env),
      });
      let stdout = "";
      let stderr = "";
      // opts.auditArgs replaces the argv recorded in the audit log — used when
      // an argument carries a secret (e.g. cf set-env <app> KEY <value>).
      const auditHandle = auditor.beginCli({
        cmd,
        args: opts.auditArgs || args,
        cwd: opts.cwd,
        user: state.user,
      });

      // opts.logCmd replaces the command line echoed to the terminal drawer —
      // same secret-masking purpose as auditArgs.
      log("cmd", "cmd", opts.logCmd || `${cmd} ${args.join(" ")}`);

      proc.stdout.on("data", (buf) => {
        const text = buf.toString();
        stdout += text;
        // opts.quiet suppresses per-line streaming to the terminal drawer (used
        // for large JSON payloads like `list accounts/subscription`, which carry
        // base64 icons). stdout is still captured for the return value + audit.
        // opts.silent goes further: no stdout, stderr or spawn-error lines in
        // the drawer at all (the command echo and the audit stay). For probes
        // whose result has its own place in the UI, e.g. prereq:bundledVersions.
        if (opts.quiet || opts.silent) return;
        for (const line of text.split(/\r?\n/)) {
          if (line.length) log(opts.source || cmd, "line", line);
        }
      });
      proc.stderr.on("data", (buf) => {
        const text = buf.toString();
        stderr += text;
        if (opts.silent) return;
        for (const line of text.split(/\r?\n/)) {
          if (line.length) log(opts.source || cmd, "err", line);
        }
      });
      proc.on("error", (err) => {
        if (!opts.silent) log(opts.source || cmd, "err", err.message);
        auditHandle.exit({ code: -1, stdout: opts.auditStdout === false ? "[not recorded: contains credentials]" : stdout, stderr, errorMessage: err.message });
        resolve({ code: -1, stdout, stderr, error: err.message });
      });
      proc.on("close", (code) => {
        // opts.auditStdout === false keeps a credential-bearing stdout (e.g. a
        // service key) out of the audit tail; the caller still receives it.
        auditHandle.exit({ code: code ?? 0, stdout: opts.auditStdout === false ? "[not recorded: contains credentials]" : stdout, stderr });
        resolve({ code: code ?? 0, stdout, stderr });
      });

      if (opts.stdin) {
        proc.stdin.write(opts.stdin);
        proc.stdin.end();
      }
    });
  }

  function httpsJson(url) {
    return new Promise((resolve, reject) => {
      const netHandle = auditor.beginNet({ url, method: "GET" });
      httpClientFor(url).get(url, { headers: { "User-Agent": "Figaf-Manager" } }, (res) => {
        let data = "";
        res.on("data", (c) => { data += c; });
        res.on("end", () => {
          netHandle.end({ status: res.statusCode });
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
          } else {
            reject(new Error(`HTTP ${res.statusCode}`));
          }
        });
      }).on("error", (err) => {
        netHandle.end({ error: err });
        reject(err);
      });
    });
  }

  // GET a URL and resolve its body as a string (≤512 KB). Follows up to 5
  // redirects, mirroring httpsDownload. Used to fetch SAML SP metadata.
  function httpsText(url) {
    return new Promise((resolve, reject) => {
      const netHandle = auditor.beginNet({ url, method: "GET" });
      const handle = (currentUrl, hops = 0) => {
        if (hops > 5) { netHandle.end({ error: "too many redirects" }); return reject(new Error("Too many redirects")); }
        https.get(currentUrl, { headers: { "User-Agent": "Figaf-Manager" } }, (res) => {
          if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
            res.resume();
            let nextUrl;
            try { nextUrl = new URL(res.headers.location, currentUrl).href; }
            catch (e) { netHandle.end({ error: e }); return reject(new Error("bad redirect location")); }
            return handle(nextUrl, hops + 1);
          }
          if (res.statusCode !== 200) {
            res.resume();
            netHandle.end({ status: res.statusCode, error: `HTTP ${res.statusCode}` });
            return reject(new Error(`HTTP ${res.statusCode}`));
          }
          let data = "";
          res.on("data", (c) => {
            data += c;
            if (data.length > 512 * 1024) { res.destroy(new Error("response too large (>512 KB)")); }
          });
          res.on("end", () => { netHandle.end({ status: 200 }); resolve(data); });
        }).on("error", (err) => { netHandle.end({ error: err }); reject(err); });
      };
      handle(url);
    });
  }

  function httpsDownload(url, destPath, onProgress) {
    return new Promise((resolve, reject) => {
      const netHandle = auditor.beginNet({ url, method: "GET" });
      let finalStatus = null;
      const handle = (currentUrl, hops = 0) => {
        if (hops > 5) {
          netHandle.end({ status: finalStatus, error: "too many redirects" });
          return reject(new Error("Too many redirects"));
        }
        const headers = {
          "User-Agent": "Figaf-Manager",
          "Cookie": "eula_3_2_agreed=tools.hana.ondemand.com/developer-license-3_2.txt",
        };
        httpClientFor(currentUrl).get(currentUrl, { headers }, (res) => {
          finalStatus = res.statusCode;
          if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
            res.resume();
            const nextUrl = new URL(res.headers.location, currentUrl).href;
            return handle(nextUrl, hops + 1);
          }
          if (res.statusCode !== 200) {
            res.resume();
            netHandle.end({ status: res.statusCode, error: `HTTP ${res.statusCode}` });
            return reject(new Error(`HTTP ${res.statusCode} fetching ${currentUrl}`));
          }
          const total = Number(res.headers["content-length"]) || 0;
          let received = 0;
          const ws = fs.createWriteStream(destPath);
          res.on("data", (chunk) => {
            received += chunk.length;
            if (onProgress) onProgress(received, total);
          });
          res.pipe(ws);
          ws.on("finish", () => ws.close(() => {
            netHandle.end({ status: 200 });
            resolve(destPath);
          }));
          ws.on("error", (err) => {
            netHandle.end({ status: 200, error: err });
            reject(err);
          });
        }).on("error", (err) => {
          netHandle.end({ status: finalStatus, error: err });
          reject(err);
        });
      };
      handle(url);
    });
  }

  async function extractZip(zipPath, destDir) {
    fs.mkdirSync(destDir, { recursive: true });
    let r;
    if (process.platform === "win32") {
      r = await run("powershell", [
        "-NoProfile", "-Command",
        `Expand-Archive -Path "${zipPath}" -DestinationPath "${destDir}" -Force`,
      ]);
    } else {
      r = await run("unzip", ["-o", zipPath, "-d", destDir]);
    }
    if (r.code !== 0) throw new Error(`zip extract failed: ${r.stderr || "unknown"}`);
  }

  function walkSync(dir, results = []) {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      if (fs.statSync(full).isDirectory()) walkSync(full, results);
      else results.push(full);
    }
    return results;
  }

  function parseTable(text, headerKeys) {
    const lines = text.split(/\r?\n/).filter(Boolean);
    const headerIdx = lines.findIndex((l) => {
      const low = l.toLowerCase();
      return headerKeys.every((k) => low.includes(k.toLowerCase()));
    });
    if (headerIdx < 0) return [];
    const header = lines[headerIdx];
    const cols = [];
    let i = 0;
    while (i < header.length) {
      while (i < header.length && header[i] === " ") i++;
      const start = i;
      while (i < header.length && header[i] !== " ") i++;
      const name = header.slice(start, i).trim();
      cols.push({ name, start });
    }
    for (let j = 0; j < cols.length; j++) {
      cols[j].end = j + 1 < cols.length ? cols[j + 1].start : 9999;
    }
    const rows = [];
    for (let k = headerIdx + 1; k < lines.length; k++) {
      const line = lines[k];
      if (!line.trim() || line.trim().startsWith("-")) continue;
      if (/^Getting |^OK$|^FAILED/.test(line)) continue;
      const row = {};
      for (const col of cols) {
        row[col.name] = (line.slice(col.start, col.end) || "").trim();
      }
      rows.push(row);
    }
    return rows;
  }

  function copyRecursiveSync(src, dest) {
    const stat = fs.statSync(src);
    if (stat.isDirectory()) {
      if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
      for (const name of fs.readdirSync(src)) {
        copyRecursiveSync(path.join(src, name), path.join(dest, name));
      }
    } else {
      fs.copyFileSync(src, dest);
    }
  }

  // ─── deploy dir ───────────────────────────────────────────────────────────
  // Electron: copies the bundled snapshot to userData/deploy/ on first use.
  // Hosted:   downloads the GitHub archive into $HOME/deploy/ on first use
  //           and caches for the container lifetime.
  //
  // {force:true} wipes both the in-memory cache and the on-disk extraction
  // before falling through to the normal first-use path. Used by the Update
  // flow to guarantee the operator gets the live GitHub HEAD and not whatever
  // template was downloaded during the original install.

  async function resolveDeployDir(opts) {
    const force = !!(opts && opts.force);
    if (state.deployDirResolved && !force) return state.deployDirResolved;

    const tmpl = host.resolveDeployTemplate();
    const userDir = host.getUserDataDir();

    if (force && tmpl.kind === "github") {
      const extracted = path.join(userDir, "Figaf-BTP-Deployment-btp-users");
      try { fs.rmSync(extracted, { recursive: true, force: true }); } catch {}
      state.deployDirResolved = null;
    }

    if (tmpl.kind === "bundle") {
      const dest = path.join(userDir, "deploy");
      if (!fs.existsSync(dest)) {
        fs.mkdirSync(dest, { recursive: true });
        copyRecursiveSync(tmpl.src, dest);
      }
      state.deployDirResolved = dest;
    } else {
      fs.mkdirSync(userDir, { recursive: true });
      const zipPath = path.join(userDir, "btp-users.zip");
      log("deploy", "line", "Downloading deployment template…");
      await httpsDownload(tmpl.src, zipPath, (got, total) => {
        if (total) log("deploy", "line", `Downloading… ${Math.round((got / total) * 100)}%`);
      });
      log("deploy", "line", "Extracting deployment template…");
      await extractZip(zipPath, userDir);
      try { fs.unlinkSync(zipPath); } catch {}
      const extracted = path.join(userDir, "Figaf-BTP-Deployment-btp-users");
      if (!fs.existsSync(extracted)) {
        throw new Error("Deployment template extraction failed — directory not found");
      }
      state.deployDirResolved = extracted;
      log("deploy", "ok", "Deployment template ready.");
    }

    return state.deployDirResolved;
  }

  // ─── update-state.json helpers ────────────────────────────────────────────
  // Persisted under <userDataDir>/figaf-tool-update/update-state.json. Each
  // phase handler in the Update flow reads it on entry (to short-circuit
  // already-completed phases on resume) and writes back its own phase marker
  // on success. The file is intentionally scoped to the session dir — a fresh
  // dyno gets a fresh state, which is the correct "resume window" boundary.

  function updateStateDir() {
    return path.join(host.getUserDataDir(), "figaf-tool-update");
  }
  function updateStatePath() {
    return path.join(updateStateDir(), "update-state.json");
  }

  function readUpdateState() {
    try {
      const text = fs.readFileSync(updateStatePath(), "utf8");
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  function writeUpdateState(patch) {
    const dir = updateStateDir();
    fs.mkdirSync(dir, { recursive: true });
    const prev = readUpdateState() || {};
    const next = { ...prev, ...patch, updatedAt: new Date().toISOString() };
    fs.writeFileSync(updateStatePath(), JSON.stringify(next, null, 2) + "\n", "utf8");
    return next;
  }

  function clearUpdateState() {
    try { fs.rmSync(updateStateDir(), { recursive: true, force: true }); } catch {}
  }

  function sha256OfFile(p) {
    try {
      const buf = fs.readFileSync(p);
      return crypto.createHash("sha256").update(buf).digest("hex");
    } catch {
      return null;
    }
  }

  // The manager's own CF coordinates, but ONLY where pinning the sign-in to
  // them is right: the FAID Apps console installs into its own space, while Alex's
  // classic wizard (FIGAF_CONSOLE_UI=0) deploys the Figaf tool into a space
  // the operator picks. Everything else (desktop, another landscape) is
  // handled by resolveSelfPin. Returning null keeps the org/space picker.
  function selfTargetForPin() {
    const console_ = host.isConsoleUI ? host.isConsoleUI() : false;
    if (!console_) return null;
    return (host.getDeployTargetForSelf && host.getDeployTargetForSelf()) || null;
  }

  // Commit an enumerated subaccount entry as the active target: runs
  // `btp target --subaccount <guid>` so the CLI's notion of the target stays
  // in sync with our state, then writes state.landscape/subaccount/org and
  // returns the env payload shape that callers feed into `btp:loggedIn`.
  async function applySubaccountSelection(entry) {
    const t = await run(resolveBtp(), ["target", "--subaccount", entry.guid], { source: "btp" });
    if (t.code !== 0) {
      return { ok: false, error: t.stderr || "Failed to target subaccount" };
    }
    state.landscape = entry.landscape;
    state.subaccount = entry.guid;
    state.subaccountSubdomain = entry.subdomain || null;
    state.org = entry.org;
    state.provider = entry.provider || null;
    return {
      ok: true,
      landscape: entry.landscape,
      apiUrl: `https://api.${entry.landscape.replace(/^cf-/, "cf.")}.hana.ondemand.com`,
      org: entry.org,
      subaccount: entry.guid,
      subaccountName: entry.displayName,
      subdomain: state.globalAccountSubdomain,
      provider: entry.provider || null,
    };
  }

  // Is the session's btp CLI logged in NOW? `btp get accounts/global-account`
  // needs a login and a targeted global account (btp login sets both). The
  // BTP CLI session lives in the container and is gone after every restart,
  // so this is asked live, never taken from memory alone. Refreshes the GA
  // guid / license type when the answer parses.
  async function probeBtpLogin() {
    const r = await run(resolveBtp(), ["--format", "json", "get", "accounts/global-account"], { source: "btp", quiet: true });
    if (r.code !== 0) return { loggedIn: false };
    try {
      const jsonStart = r.stdout.indexOf("{");
      const data = jsonStart >= 0 ? JSON.parse(r.stdout.slice(jsonStart)) : {};
      if (data.guid) state.globalAccountGuid = data.guid;
      if (data.licenseType) state.licenseType = data.licenseType;
    } catch { /* logged in; details stay as they were */ }
    return { loggedIn: true };
  }

  // Subaccount GUID without the BTP subaccount pick (docs/faid-apps-console/SPEC.md "Role
  // assignment in the SSO upgrade", run #4 finding 2): every XSUAA binding
  // or service key carries `subaccountid`. A throw-away service key on the
  // manager's own instance (created by cf:createXsuaa) is read quietly and
  // deleted again. The key JSON holds the XSUAA client secret, so its stdout
  // is neither streamed to the terminal nor written to the audit tail.
  async function deriveSubaccountGuidFromXsuaa() {
    if (state.subaccountFromXsuaa) return { ok: true, guid: state.subaccountFromXsuaa };
    const inst = targetXsuaaInstance();
    const keyName = "figaf-manager-role-key";
    const c = await run(resolveCf(), ["create-service-key", inst, keyName], { source: "cf" });
    if (c.code !== 0 && !/already exists/i.test(`${c.stderr}\n${c.stdout}`)) {
      return { ok: false, error: `cf create-service-key ${inst} failed` };
    }
    const k = await run(resolveCf(), ["service-key", inst, keyName], {
      source: "cf",
      quiet: true,
      auditStdout: false,
      logCmd: `cf service-key ${inst} ${keyName}  (output not shown: contains the XSUAA client secret)`,
    });
    let guid = null;
    if (k.code === 0) {
      try {
        const jsonStart = k.stdout.indexOf("{");
        let key = jsonStart >= 0 ? JSON.parse(k.stdout.slice(jsonStart)) : null;
        if (key && key.credentials) key = key.credentials;
        guid = (key && (key.subaccountid || key.zoneid || key.tenantid)) || null;
      } catch { guid = null; }
    }
    await run(resolveCf(), ["delete-service-key", inst, keyName, "-f"], { source: "cf" });
    if (!guid) return { ok: false, error: `could not read the subaccount id from a service key of ${inst}` };
    state.subaccountFromXsuaa = String(guid);
    return { ok: true, guid: state.subaccountFromXsuaa };
  }

  // Spawn `btp target --hierarchy true`, wait for the interactive prompt, parse
  // the tree, then write `chooseIndex` to stdin so the CLI targets that node and
  // exits 0. `chooseIndex` is a number, or a fn(parsed) -> number (e.g. stay on
  // the current target). Resolves { code, parsed }. This is the same long-lived
  // proc + stdin mechanism btp login uses; verified against btp v2.106.1.
  function runTargetHierarchy(chooseIndex) {
    return new Promise((resolve) => {
      const btpBin = resolveBtp();
      const args = ["target", "--hierarchy", "true"];
      log("cmd", "cmd", `${btpBin} ${args.join(" ")}`);
      const proc = spawn(btpBin, args, { shell: false, windowsHide: true, env: cliEnv() });
      const ansiRe = /\x1b\[[0-9;?]*[a-zA-Z]/g;
      let clean = "";
      let parsed = null;
      let wrote = false;

      const onData = (buf) => {
        const text = buf.toString();
        clean += text.replace(ansiRe, "").replace(/\r(?!\n)/g, "\n");
        for (const raw of text.split(/\r\n|\n/)) {
          const line = raw.replace(ansiRe, "").replace(/\r/g, "").trim();
          if (line.length) log("btp", "line", line);
        }
        if (!wrote && /hit ENTER to stay in '[^']*'\s*\[\d+\]/.test(clean)) {
          wrote = true;
          parsed = parseGlobalAccountTree(clean);
          const idx = typeof chooseIndex === "function" ? chooseIndex(parsed) : chooseIndex;
          try { proc.stdin.write((idx != null ? String(idx) : "") + os.EOL); } catch {}
        }
      };

      proc.stdout.on("data", onData);
      proc.stderr.on("data", (b) => {
        for (const line of b.toString().split(/\r?\n/)) if (line.trim()) log("btp", "err", line.trim());
      });
      proc.on("error", (err) => { log("btp", "err", `btp target spawn error: ${err.message}`); resolve({ code: -1, parsed }); });
      proc.on("close", (code) => {
        if (!parsed && clean) parsed = parseGlobalAccountTree(clean);
        resolve({ code, parsed });
      });
    });
  }

  // Parse `cf orgs` / `cf spaces` output into a plain string array.
  // Skips: "Getting X as Y..." header, "OK" (CLI v7), "name" (CLI v8 header),
  // separator lines (---), and blank lines. Every remaining non-empty line is an entry.
  function parseCfList(stdout) {
    return stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(
        (l) =>
          l &&
          !/^getting /i.test(l) &&
          l !== "OK" &&
          l.toLowerCase() !== "name" &&
          !/^-+$/.test(l)
      );
  }

  // ─── handlers ─────────────────────────────────────────────────────────────

  const handlers = {

    // FAID Apps manager — catalog-driven install/manage of FAID Apps.
    // Implemented in faid-apps.js; spread here so both hosts wire the channels
    // automatically (ipc-bridge iterates the map; server.js looks up per RPC).
    ...createFaidHandlers({
      host,
      run: (...a) => run(...a),
      log,
      send,
      resolveCf: () => resolveCf(),
      extractZip: (zip, dest) => extractZip(zip, dest),
      httpsText: (url) => httpsText(url),
      // The release store (decision 0010): index.json / catalog reads and the
      // artifact downloads go through the audited helpers above.
      httpsJson: (url) => httpsJson(url),
      httpsDownload: (url, dest) => httpsDownload(url, dest),
      // GET that resolves body + status even on non-2xx — health endpoints
      // (e.g. /health/connections) return 503 WITH a diagnostic JSON body.
      httpsBody: (url) => new Promise((resolve, reject) => {
        https.get(url, { headers: { "User-Agent": "Figaf-Manager" } }, (res) => {
          let data = "";
          res.on("data", (c) => {
            data += c;
            if (data.length > 512 * 1024) res.destroy(new Error("response too large (>512 KB)"));
          });
          res.on("end", () => resolve({ status: res.statusCode, body: data }));
        }).on("error", reject);
      }),
      // Decision 0016: before an install or update, the stored Figaf API client
      // is checked against the release's figafScopes (connections.js). Lazy:
      // `handlers` is filled long after this literal.
      checkFigafScopes: (required) => handlers["connections:figafScopesCheck"]({ required }),
    }),

    // System connections (decision 0006 slice): the manager verifies and
    // writes Figaf-tool / SAP-system connection entries to the Credential
    // Store; FAID Apps backends read them at runtime. Implemented in
    // connections.js; requires the manager to be BOUND to the credstore
    // instance (same precondition as the stored management user).
    // probeDestination: a PI/PO entry (decision 0011) is verified by the
    // shared backend, the only side bound to the destination service. The
    // arrow resolves `handlers` lazily - it is called long after this literal.
    ...createConnectionsHandlers({
      log,
      probeDestination: (name) => handlers["faid:destinationCheck"]({ destinationName: name }),
      // Decision 0016: the authorities the release requires of the ONE Figaf
      // API client (catalog v5 figafScopes; installed version, else latest).
      requiredFigafScopes: async () => {
        const r = await handlers["faid:requiredFigafScopes"]();
        return r && r.ok ? r.scopes : [];
      },
    }),

    // stored management user + session resume (FAID Apps manager) ───────────
    // "Option B" (Aug 31 decision): the manager's cf login can come from a
    // technical user stored in SAP Credential Store, instead of a per-session
    // SSO passcode. Requires the manager app to be BOUND to the credstore
    // instance; the credential lives at namespace "figaf-manager", name
    // "cf-management-user" (password + username field).

    /**
     * Probe: is a stored management user available on this host?
     * Cached for 60s — credstore reads are rate-limited on the free plan.
     */
    async "login:storedUserStatus"() {
      if (state.storedUserProbe && Date.now() - state.storedUserProbe.at < 60000) {
        return state.storedUserProbe.result;
      }
      const binding = credstoreClient.findCredstoreBinding();
      let result;
      if (!binding) {
        result = { ok: true, available: false, bindingPresent: false, reason: "no credential-store binding" };
      } else {
        try {
          const cred = await credstoreClient.readCredential(binding);
          result = cred && cred.value && cred.username
            ? { ok: true, available: true, bindingPresent: true, username: cred.username }
            : { ok: true, available: false, bindingPresent: true, reason: "management credential not stored" };
        } catch (e) {
          result = { ok: true, available: false, bindingPresent: true, reason: e.message };
        }
      }
      state.storedUserProbe = { at: Date.now(), result };
      return result;
    },

    /**
     * Store (or replace) the management user — the UI path, so no script is
     * needed. The candidate credentials are FIRST verified against Cloud
     * Foundry in a throw-away CF_HOME (the operator's own session login is
     * untouched), then written encrypted to the Credential Store. The
     * password exists only in this request and the child-process env — the
     * RPC audit redacts it (see server.js) and the terminal shows masked
     * command lines only.
     */
    async "login:storeManagementUser"({ username, password } = {}) {
      if (!username || !password) return { ok: false, error: "username and password are required" };
      if (String(username).length > 256 || String(password).length > 512) {
        return { ok: false, error: "username/password too long" };
      }
      const binding = credstoreClient.findCredstoreBinding();
      if (!binding) return { ok: false, error: "the manager is not bound to a Credential Store instance" };
      const target = host.getDeployTargetForSelf && host.getDeployTargetForSelf();
      if (!target || !target.apiUrl || !target.orgName || !target.spaceName) {
        return { ok: false, error: "cannot derive the CF target from VCAP_APPLICATION (not running in CF?)" };
      }

      // 1. Verify: login + space access, in a scratch CF_HOME.
      const scratch = path.join(host.getUserDataDir(), "verify-cli");
      try {
        fs.rmSync(scratch, { recursive: true, force: true });
        fs.mkdirSync(scratch, { recursive: true });
      } catch {}
      const scratchEnv = { CF_HOME: scratch };
      try {
        let r = await run(resolveCf(), ["api", target.apiUrl], {
          source: "cf", quiet: true, env: scratchEnv,
          logCmd: `cf api ${target.apiUrl}  (management-user verification)`,
        });
        if (r.code !== 0) return { ok: false, error: "cf api failed during verification" };
        r = await run(resolveCf(), ["auth"], {
          source: "cf", quiet: true,
          logCmd: "cf auth <candidate management user>  (verification)",
          env: { ...scratchEnv, CF_USERNAME: username, CF_PASSWORD: password },
        });
        if (r.code !== 0) {
          return { ok: false, error: "login check failed — wrong password, 2FA enabled, or the account is not registered" };
        }
        r = await run(resolveCf(), ["target", "-o", target.orgName, "-s", target.spaceName], {
          source: "cf", quiet: true, env: scratchEnv,
          logCmd: `cf target -o ${target.orgName} -s ${target.spaceName}  (verification)`,
        });
        if (r.code !== 0) {
          return { ok: false, error: `the user logs in, but has no role in ${target.orgName} / ${target.spaceName} — add it as Space Developer first` };
        }
      } finally {
        try { fs.rmSync(scratch, { recursive: true, force: true }); } catch {}
      }

      // 2. Store encrypted; refresh the availability probe.
      try {
        await credstoreClient.writeCredential(binding, { username, value: password });
      } catch (e) {
        return { ok: false, error: e.message };
      }
      state.storedUserProbe = null;
      log("cf", "ok", `Management user verified and stored in the Credential Store (${username})`);
      return { ok: true, username };
    },

    /**
     * Log the session's cf CLI in with the stored management user and target
     * the manager's own org/space. The password travels only via the child
     * process env (CF_USERNAME/CF_PASSWORD — supported by `cf auth`), so it
     * never appears in the command line, the terminal stream, or the audit log.
     */
    async "login:withStoredUser"() {
      const binding = credstoreClient.findCredstoreBinding();
      if (!binding) return { ok: false, error: "the manager is not bound to a Credential Store instance" };
      let cred;
      try {
        cred = await credstoreClient.readCredential(binding);
      } catch (e) {
        return { ok: false, error: e.message };
      }
      if (!cred || !cred.value || !cred.username) {
        return { ok: false, error: "management user not found in the credential store (namespace figaf-manager, name cf-management-user)" };
      }
      const target = host.getDeployTargetForSelf && host.getDeployTargetForSelf();
      if (!target || !target.apiUrl || !target.orgName || !target.spaceName) {
        return { ok: false, error: "cannot derive the CF target from VCAP_APPLICATION (not running in CF?)" };
      }
      // A pending interactive cf login would fight over the same CF_HOME.
      if (state.cfLoginProc && !state.cfLoginProc.killed) {
        try { state.cfLoginProc.kill(); } catch {}
        state.cfLoginProc = null;
      }
      let r = await run(resolveCf(), ["api", target.apiUrl], { source: "cf" });
      if (r.code !== 0) return { ok: false, error: "cf api failed" };
      r = await run(resolveCf(), ["auth"], {
        source: "cf",
        quiet: true,
        logCmd: `cf auth <stored management user ${cred.username}>`,
        env: { CF_USERNAME: cred.username, CF_PASSWORD: cred.value },
      });
      if (r.code !== 0) {
        return { ok: false, error: "cf auth with the stored user failed — check the stored password and that the account has no 2FA" };
      }
      r = await run(resolveCf(), ["target", "-o", target.orgName, "-s", target.spaceName], { source: "cf" });
      if (r.code !== 0) {
        return { ok: false, error: `cf target -o ${target.orgName} -s ${target.spaceName} failed — does the management user have a Space role there?` };
      }
      state.user = cred.username;
      state.cfLoginKind = "stored-user"; // the cf identity is the technical account, not a person
      state.org = target.orgName;
      state.space = target.spaceName;
      log("cf", "ok", `Signed in as the stored management user (${cred.username}) — org ${target.orgName}, space ${target.spaceName}`);
      return { ok: true, user: cred.username, org: target.orgName, space: target.spaceName, apiUrl: target.apiUrl };
    },

    /**
     * Session resume: does this server-side session already hold a usable cf
     * login? Verified with a real `cf target` (catches expired tokens). The UI
     * calls this on page load to skip the wizard's login steps.
     */
    async "session:state"() {
      const r = await run(resolveCf(), ["target"], { source: "cf", quiet: true });
      if (r.code !== 0) return { ok: true, cfLoggedIn: false };
      const t = parseCfTarget(r.stdout || "");
      if (!t.loggedIn || !t.orgName || !t.spaceName) {
        return { ok: true, cfLoggedIn: false };
      }
      // BTP context survives in the server-side session too (session-scoped
      // BTP_CLIENTCONFIG + in-memory state). Resuming it keeps the BTP-gated
      // flows (Deploy / Connect / SSO upgrade) available after a page reload.
      const btp = state.landscape && state.subaccount
        ? {
            loggedIn: true,
            landscape: state.landscape,
            subaccount: state.subaccount,
            subdomain: state.globalAccountSubdomain || "",
            provider: state.provider || "",
          }
        : { loggedIn: false };
      state.user = t.user;
      state.org = t.orgName;
      state.space = t.spaceName;
      return { ok: true, cfLoggedIn: true, user: t.user, org: t.orgName, space: t.spaceName, apiUrl: t.apiUrl || null, btp };
    },

    // prerequisites ───────────────────────────────────────────────────────────

    /**
     * What the manager runs with: the Node runtime, the btp and cf CLIs it
     * will spawn (their own version output) against the versions the build
     * pinned (bin/VERSIONS.json), and the pinned npm dependencies. Hosted:
     * the bundled binaries. Desktop or dev checkout: the CLIs from PATH, no
     * build record. Never throws; a CLI that does not start is reported.
     */
    async "prereq:bundledVersions"() {
      const build = (host.getBundledVersions && host.getBundledVersions()) || null;
      async function probe(bin, args, re) {
        try {
          // silent: the result is shown on the About page and in the checks;
          // its lines would only bury real failures in the terminal drawer.
          const r = await run(host.resolveBinary(bin), args, { source: bin, silent: true });
          // run() never throws: a binary that does not start comes back as
          // code -1 with the spawn error in r.error (e.g. ENOENT).
          const text = ((r.stdout || "") + "\n" + (r.stderr || "") + "\n" + (r.error || "")).trim();
          const m = r.code === 0 ? text.match(re) : null;
          return { ok: r.code === 0, version: m ? m[1] : null, raw: text.split(/\r?\n/).find(Boolean) || "" };
        } catch (e) {
          return { ok: false, version: null, raw: e.message };
        }
      }
      const btp = await probe("btp", ["--version"], /(\d+\.\d+\.\d+)/);
      const cf  = await probe("cf",  ["version"],   /version (\d+\.\d+\.\d+)/);
      const expected = (key) => (build && build[key]) || null;
      const compare = (probed, want) => ({ ...probed, expected: want, matches: want ? probed.version === want : null });
      return {
        ok: true,
        bundled: !!build,
        manager: (host.getInstalledVersion && host.getInstalledVersion()) || null,
        node: process.version,
        nodeExpected: expected("node"),
        btp: compare(btp, expected("btp")),
        cf:  compare(cf,  expected("cf")),
        npm: (build && build.npm) || null,
        builtAt: expected("builtAt"),
      };
    },

    async "prereq:whichBtp"() {
      if (host.isHosted) {
        const p = host.resolveBinary("btp");
        return { ok: fs.existsSync(p), path: p, source: "bundled" };
      }
      const stored = host.resolveBinary("btp");
      if (path.isAbsolute(stored) && fs.existsSync(stored)) {
        return { ok: true, path: stored, source: "stored" };
      }
      const r = await run(process.platform === "win32" ? "where" : "which", ["btp"]);
      const first = r.stdout.split(/\r?\n/).find(Boolean);
      return { ok: r.code === 0 && !!first, path: first || null, source: first ? "path" : null };
    },

    async "prereq:whichCf"() {
      if (host.isHosted) {
        const p = host.resolveBinary("cf");
        return { ok: fs.existsSync(p), path: p, source: "bundled" };
      }
      const stored = host.resolveBinary("cf");
      if (path.isAbsolute(stored) && fs.existsSync(stored)) {
        return { ok: true, path: stored, source: "stored" };
      }
      const r = await run(process.platform === "win32" ? "where" : "which", ["cf"]);
      const first = r.stdout.split(/\r?\n/).find(Boolean);
      return { ok: r.code === 0 && !!first, path: first || null, source: first ? "path" : null };
    },

    async "prereq:getCliPaths"() {
      return {
        btp: host.resolveBinary("btp"),
        cf: host.resolveBinary("cf"),
        binDir: host.getUserDataDir(),
      };
    },

    async "prereq:clearCliPath"({ cli }) {
      if (host.isHosted) return { ok: false, error: "not available in hosted mode" };
      if (cli !== "btp" && cli !== "cf") return { ok: false, error: "invalid cli" };
      await host.storeCliPath?.(cli, null);
      return { ok: true };
    },

    async "prereq:openBtpDownloadPage"() {
      const url = "https://tools.hana.ondemand.com/#cloud";
      await host.openExternal(url);
      return { ok: true, url };
    },

    async "prereq:installBtp"() {
      if (host.isHosted) return { ok: false, error: "not available in hosted mode" };
      send("cli:install", { cli: "btp", phase: "start" });
      try {
        const url = "https://tools.hana.ondemand.com/additional/btp-cli-windows-amd64-2.106.1.tar.gz";
        const filename = "btp-cli-windows-amd64-2.106.1.tar.gz";
        log("install", "line", `Downloading ${filename}`);
        const binDir = path.join(host.getUserDataDir(), "bin");
        fs.mkdirSync(binDir, { recursive: true });
        const tmpTar = path.join(os.tmpdir(), `figaf-${filename}`);
        await httpsDownload(url, tmpTar, (got, total) => {
          if (!total) return;
          send("cli:install", { cli: "btp", phase: "download", percent: Math.round((got / total) * 100) });
        });
        send("cli:install", { cli: "btp", phase: "extract" });
        log("install", "line", "Extracting…");
        const tmpDir = path.join(os.tmpdir(), `figaf-btpcli-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });
        const r = await run("tar", ["-xzf", tmpTar, "-C", tmpDir]);
        if (r.code !== 0) throw new Error(`Extract failed: ${r.stderr || "unknown"}`);
        const files = walkSync(tmpDir);
        const btpExe = files.find(f => /[\\/]btp\.exe$/i.test(f));
        if (!btpExe) throw new Error("btp.exe not found in downloaded archive");
        const dest = path.join(binDir, "btp.exe");
        try { fs.unlinkSync(dest); } catch {}
        fs.copyFileSync(btpExe, dest);
        await host.storeCliPath?.("btp", dest);
        try { fs.unlinkSync(tmpTar); } catch {}
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
        const v = await run(dest, ["--version"], { source: "btp" });
        send("cli:install", { cli: "btp", phase: "done", path: dest });
        return { ok: true, path: dest, version: (v.stdout || "").split(/\r?\n/)[0].trim() || "2.106.1" };
      } catch (e) {
        log("install", "err", `btp install failed: ${e.message}`);
        send("cli:install", { cli: "btp", phase: "error", error: e.message });
        return { ok: false, error: e.message };
      }
    },

    async "prereq:installCf"() {
      if (host.isHosted) return { ok: false, error: "not available in hosted mode" };
      send("cli:install", { cli: "cf", phase: "start" });
      try {
        const rel = await httpsJson("https://api.github.com/repos/cloudfoundry/cli/releases/latest");
        const asset = (rel.assets || []).find(a => /winx64\.zip$/i.test(a.name) && !/installer/i.test(a.name));
        if (!asset) throw new Error("No Windows zip asset in cloudfoundry/cli latest release");
        log("install", "line", `Downloading ${asset.name} (${(asset.size / 1024 / 1024).toFixed(1)} MB)`);
        const binDir = path.join(host.getUserDataDir(), "bin");
        fs.mkdirSync(binDir, { recursive: true });
        const tmpZip = path.join(os.tmpdir(), `figaf-${asset.name}`);
        await httpsDownload(asset.browser_download_url, tmpZip, (got, total) => {
          if (!total) return;
          send("cli:install", { cli: "cf", phase: "download", percent: Math.round((got / total) * 100) });
        });
        send("cli:install", { cli: "cf", phase: "extract" });
        log("install", "line", "Extracting…");
        const tmpDir = path.join(os.tmpdir(), `figaf-cfcli-${Date.now()}`);
        await extractZip(tmpZip, tmpDir);
        const files = walkSync(tmpDir);
        const cfExe = files.find(f => /[\\/]cf\d*\.exe$/i.test(f));
        if (!cfExe) throw new Error("cf.exe not found in downloaded archive");
        const dest = path.join(binDir, "cf.exe");
        try { fs.unlinkSync(dest); } catch {}
        fs.copyFileSync(cfExe, dest);
        await host.storeCliPath?.("cf", dest);
        try { fs.unlinkSync(tmpZip); } catch {}
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
        const v = await run(dest, ["--version"], { source: "cf" });
        send("cli:install", { cli: "cf", phase: "done", path: dest });
        return { ok: true, path: dest, version: (v.stdout || "").trim() };
      } catch (e) {
        log("install", "err", `cf install failed: ${e.message}`);
        send("cli:install", { cli: "cf", phase: "error", error: e.message });
        return { ok: false, error: e.message };
      }
    },

    async "prereq:locateCli"({ cli }) {
      if (host.isHosted) return { ok: false, error: "not available in hosted mode" };
      if (cli !== "btp" && cli !== "cf") return { ok: false, error: "invalid cli" };
      const src = await host.pickFile({
        title: `Locate ${cli} executable or archive`,
        properties: ["openFile"],
        filters: [
          { name: "Executable or archive", extensions: ["exe", "zip"] },
          { name: "Executable", extensions: ["exe"] },
          { name: "Archive", extensions: ["zip"] },
        ],
      });
      if (!src) return { ok: false, cancelled: true };
      const ext = path.extname(src).toLowerCase();
      const binDir = path.join(host.getUserDataDir(), "bin");
      fs.mkdirSync(binDir, { recursive: true });
      const dest = path.join(binDir, `${cli}.exe`);
      try {
        if (ext === ".zip") {
          send("cli:install", { cli, phase: "extract" });
          const tmpDir = path.join(os.tmpdir(), `figaf-${cli}-${Date.now()}`);
          await extractZip(src, tmpDir);
          const files = walkSync(tmpDir);
          const match = cli === "btp"
            ? files.find(f => /[\\/]btp\.exe$/i.test(f))
            : files.find(f => /[\\/]cf\d*\.exe$/i.test(f));
          if (!match) throw new Error(`${cli}.exe not found in archive`);
          try { fs.unlinkSync(dest); } catch {}
          fs.copyFileSync(match, dest);
          try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
        } else if (ext === ".exe") {
          try { fs.unlinkSync(dest); } catch {}
          fs.copyFileSync(src, dest);
        } else {
          throw new Error("Please select a .exe or .zip file");
        }
        await host.storeCliPath?.(cli, dest);
        const v = await run(dest, ["--version"], { source: cli });
        const version = ((v.stdout || "") + (v.stderr || "")).split(/\r?\n/).find(Boolean) || "";
        send("cli:install", { cli, phase: "done", path: dest });
        return { ok: true, path: dest, version };
      } catch (e) {
        send("cli:install", { cli, phase: "error", error: e.message });
        return { ok: false, error: e.message };
      }
    },

    async "prereq:dockerHub"() {
      try {
        const data = await httpsJson(
          "https://hub.docker.com/v2/repositories/figaf/app/tags?name=btp&page_size=1&ordering=last_updated"
        );
        const latest = data?.results?.[0]?.name || null;
        return { ok: !!latest, latest };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    },

    async "prereq:disk"() {
      if (host.isHosted) return { ok: true, gb: 999, drive: "/" };
      if (process.platform !== "win32") {
        const r = await run("df", ["-BG", "."], { source: "disk" });
        const match = /(\d+)G\s/.exec((r.stdout.split("\n")[1]) || "");
        const gb = match ? Number(match[1]) : 0;
        return { ok: gb >= 2, gb, drive: "/" };
      }
      const drive = (process.env.SystemDrive || "C:") + "\\";
      const r = await run("powershell", ["-NoProfile", "-Command", `(Get-PSDrive ${drive[0]}).Free`]);
      const bytes = Number(r.stdout.trim());
      const gb = Number.isFinite(bytes) ? bytes / (1024 ** 3) : 0;
      return { ok: gb >= 2, gb: Number(gb.toFixed(1)), drive };
    },

    // BTP login ───────────────────────────────────────────────────────────────

    // Long-lived `btp login` process — kept alive so we can write the GA choice
    // number to its stdin when the multi-account prompt appears.
    async "btp:loginStart"() {
      if (state.btpLoginProc && !state.btpLoginProc.killed) {
        log("btp", "warn", "Login already in progress, ignoring re-invocation");
        return { ok: true };
      }
      state.gaTree = null;
      state.globalAccountName = null;
      // Force `btp login` to always prompt for a GA so our handling is
      // deterministic; we auto-answer it below and re-pick via `btp target`.
      await run(resolveBtp(), ["set", "config", "--login.showglobalaccounts", "true"], { source: "btp" });
      const btpBin = resolveBtp();
      const args = ["login", "--url", "https://cli.btp.cloud.sap", "--sso"];
      const proc = spawn(btpBin, args, { shell: false, windowsHide: true, env: cliEnv() });
      state.btpLoginProc = proc;
      log("cmd", "cmd", `${btpBin} ${args.join(" ")}`);

      // ANSI escapes + the BTP CLI spinner's `\r` redraws can corrupt line-by-line
      // parsing (e.g. a leading `\r` glued to "Choose a global account:" defeats `^`).
      // Keep a rolling "clean" buffer (ANSI/CR stripped) and pattern-match the whole
      // multi-GA block at once.
      const ansiRe = /\x1b\[[0-9;?]*[a-zA-Z]/g;
      let cleanBuffer = "";
      let lineRemainder = "";
      let promptEmitted = false;

      const flushLines = (chunk, source) => {
        lineRemainder += chunk;
        const parts = lineRemainder.split(/\r\n|\n/);
        lineRemainder = parts.pop();
        for (const raw of parts) {
          const line = raw.replace(ansiRe, "").replace(/\r/g, "").trim();
          if (line.length) log("btp", source, line);
        }
      };

      const tryAutoPickGa = () => {
        if (promptEmitted) return;
        const m = /Choose a global account:?[\s\S]*?Choose option\s*[>:]/i.exec(cleanBuffer);
        if (!m) return;
        promptEmitted = true;
        log("btp", "line", "GA prompt detected — auto-answering '1' (real selection follows via 'btp target').");
        try { proc.stdin.write("1" + os.EOL); } catch {}
        cleanBuffer = cleanBuffer.slice(m.index + m[0].length);
      };

      const tryDetectSsoUrl = () => {
        const m = /Please continue login at:\s*(https:\/\/\S+)/i.exec(cleanBuffer);
        if (m) {
          send("btp:ssoUrl", { url: m[1] });
          cleanBuffer = cleanBuffer.replace(m[0], "");
        }
      };

      const ingest = (text, source) => {
        cleanBuffer += text.replace(ansiRe, "").replace(/\r(?!\n)/g, "\n");
        if (cleanBuffer.length > 16384) cleanBuffer = cleanBuffer.slice(-8192);
        flushLines(text, source);
        tryAutoPickGa();
        tryDetectSsoUrl();
      };

      proc.stdout.on("data", (buf) => ingest(buf.toString(), "line"));
      proc.stderr.on("data", (buf) => ingest(buf.toString(), "err"));
      proc.on("error", (err) => log("btp", "err", `btp spawn error: ${err.message}`));

      proc.on("close", async (code, signal) => {
        if (lineRemainder.trim()) {
          log("btp", "line", lineRemainder.replace(ansiRe, "").replace(/\r/g, "").trim());
          lineRemainder = "";
        }
        const detail = signal ? `code=${code} signal=${signal}` : `code=${code}`;
        log("btp", code === 0 ? "ok" : "err", `btp login exited (${detail})`);
        state.btpLoginProc = null;
        state.btpLoginWaitingForChoice = false;
        if (code === 0) {
          await handlers["btp:listGlobalAccounts"]();
        } else {
          send("btp:loginFailed", { code, signal });
        }
      });

      return { ok: true };
    },

    async "btp:submitChoice"({ choice }) {
      const proc = state.btpLoginProc;
      if (!proc || proc.killed) return { ok: false, error: "No active btp login session" };
      try {
        state.btpLoginWaitingForChoice = false;
        proc.stdin.write(String(choice).trim() + os.EOL);
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    },

    async "btp:cancelLogin"() {
      const proc = state.btpLoginProc;
      if (proc && !proc.killed) { try { proc.kill(); } catch {} }
      state.btpLoginProc = null;
      state.btpLoginWaitingForChoice = false;
      // Run full logout so the BTP/CF session is cleanly torn down.
      await run(resolveBtp(), ["logout"], { source: "btp" });
      await run(resolveCf(), ["logout"], { source: "cf" }).catch(() => {});
      state.globalAccountSubdomain = null;
      state.globalAccountGuid = null;
      state.landscape = null;
      state.subaccount = null;
      state.org = null;
      state.space = null;
      state.user = null;
      state.cfLoginKind = null;
      state.provider = null;
      state.subaccountList = null;
      state.subaccountWaitingForChoice = false;
      state.gaTree = null;
      state.globalAccountName = null;
      state.cfSwitchOrgList = null;
      state.cfSwitchSelectedOrg = null;
      state.cfSwitchSpaceList = null;
      return { ok: true };
    },

    // Enumerate all reachable global accounts via `btp target --hierarchy true`.
    // Stays on the current target (writes its index) — read-only. Single GA →
    // auto-select; otherwise emit btp:gaChoice with each GA's subaccounts (which
    // disambiguate same-named GAs). Reused by the UI's "Back" button.
    async "btp:listGlobalAccounts"() {
      const { code, parsed } = await runTargetHierarchy((p) => (p ? p.currentIndex : null));
      if (code !== 0 || !parsed || parsed.accounts.length === 0) {
        send("btp:loginFailed", { code });
        return { ok: false, error: "Could not list global accounts" };
      }
      state.gaTree = parsed.accounts;
      if (parsed.accounts.length === 1) {
        return await handlers["btp:selectGlobalAccount"]({ index: parsed.accounts[0].index });
      }
      send("btp:gaChoice", { accounts: parsed.accounts });
      return { ok: true, choicePending: true };
    },

    async "btp:selectGlobalAccount"({ index }) {
      const ga = (state.gaTree || []).find((g) => g.index === Number(index));
      if (!ga) return { ok: false, error: "Unknown global account index" };

      const { code } = await runTargetHierarchy(Number(index));
      if (code !== 0) {
        send("btp:loginFailed", { code });
        return { ok: false, error: "Failed to target global account" };
      }
      state.globalAccountName = ga.name;
      // GA switch invalidates the previous subaccount enumeration.
      state.subaccountList = null;
      state.subaccountWaitingForChoice = false;
      state.provider = null;
      // Clear prior-GA metadata up front so a failed `get` below can't leak a
      // stale subdomain/guid/license from a previously-selected global account.
      state.globalAccountSubdomain = null;
      state.globalAccountGuid = null;
      state.licenseType = null;

      // Authoritative GA metadata (subdomain / guid / license) from JSON — the
      // current target is now the chosen GA.
      const gaInfo = await run(resolveBtp(), ["--format", "json", "get", "accounts/global-account"], { source: "btp" });
      if (gaInfo.code === 0) {
        try {
          const js = gaInfo.stdout.indexOf("{");
          if (js >= 0) {
            const data = JSON.parse(gaInfo.stdout.slice(js));
            state.globalAccountSubdomain = data.subdomain || null;
            state.globalAccountGuid = data.guid || null;
            state.licenseType = data.licenseType || null;
            log("btp", "line", `Global account subdomain: ${state.globalAccountSubdomain}`);
          }
        } catch (e) {
          log("btp", "warn", `Could not parse GA info: ${e.message}`);
        }
      } else {
        log("btp", "warn", `get accounts/global-account failed (code ${gaInfo.code}); subdomain/guid will be null`);
      }

      const env = await handlers["btp:listEnvInstances"]();
      if (env.ok === false) {
        // e.g. this GA has no Cloud-Foundry-enabled subaccount. Surface the
        // reason, and if there are other GAs, drop back to the GA picker so the
        // user can choose a different one rather than restarting the whole login.
        log("btp", "warn", env.error || "No Cloud Foundry environment in this global account");
        if ((state.gaTree || []).length > 1) {
          send("btp:gaChoice", { accounts: state.gaTree });
        } else {
          send("btp:loggedIn", { ...env, subdomain: state.globalAccountSubdomain });
        }
        return env;
      }
      if (!env.choicePending) {
        send("btp:loggedIn", { ...env, subdomain: state.globalAccountSubdomain });
      }
      return env;
    },

    async "btp:logout"() {
      await run(resolveBtp(), ["logout"], { source: "btp" });
      await run(resolveCf(), ["logout"], { source: "cf" }).catch(() => {});
      state.globalAccountSubdomain = null;
      state.landscape = null;
      state.subaccount = null;
      state.org = null;
      state.space = null;
      state.user = null;
      state.cfLoginKind = null;
      state.provider = null;
      state.subaccountList = null;
      state.subaccountWaitingForChoice = false;
      state.gaTree = null;
      state.globalAccountName = null;
      state.globalAccountGuid = null;
      state.licenseType = null;
      state.cfSwitchOrgList = null;
      state.cfSwitchSelectedOrg = null;
      state.cfSwitchSpaceList = null;
      return { ok: true };
    },

    // Enumerate every subaccount in the targeted GA and probe each for a
    // Cloud Foundry environment instance. Outcomes:
    //   0 CF-enabled  → return error
    //   ≥1 CF-enabled → cache the list, emit `btp:subaccountChoice`, return
    //                   { ok: true, choicePending: true } — callers must NOT
    //                   emit `btp:loggedIn` until the user picks via
    //                   `btp:selectSubaccount`.
    // Non-CF subaccounts are included in the choice payload (cfEnabled:false)
    // so the picker renders them as disabled, giving visibility into the full GA.
    async "btp:listEnvInstances"() {
      const subRes = await run(resolveBtp(), ["--format", "json", "list", "accounts/subaccount"], { source: "btp" });
      if (subRes.code !== 0) return { ok: false, error: subRes.stderr || "Failed to list subaccounts" };

      let subaccounts = [];
      try {
        const jsonStart = subRes.stdout.indexOf("{");
        const data = jsonStart >= 0 ? JSON.parse(subRes.stdout.slice(jsonStart)) : null;
        subaccounts = (data && (data.value || data.subaccounts || data.children)) || [];
      } catch (e) {
        return { ok: false, error: "Cannot parse subaccount list: " + e.message };
      }
      if (!subaccounts.length) return { ok: false, error: "No subaccounts found in current global account" };

      const enumerated = [];
      for (const sa of subaccounts) {
        const said = sa.guid || sa.subaccountGUID || sa.id;
        if (!said) continue;
        const entry = {
          guid: said,
          displayName: sa.displayName || sa.name || said,
          subdomain: sa.subdomain || null,
          region: sa.region || null,
          provider: providerFromRegion(sa.region),
          state: sa.state || null,
          cfEnabled: false,
          landscape: null,
          org: null,
        };

        const r = await run(resolveBtp(), ["--format", "json", "list", "accounts/environment-instance", "--subaccount", said], { source: "btp" });
        if (r.code === 0) {
          let parsed = null;
          try {
            const jsonStart = r.stdout.indexOf("{");
            parsed = jsonStart >= 0 ? JSON.parse(r.stdout.slice(jsonStart)) : null;
          } catch {}
          const cf = parsed && (parsed.environmentInstances || []).find((e) => e.environmentType === "cloudfoundry");
          if (cf) {
            entry.cfEnabled = true;
            entry.landscape = cf.landscapeLabel;
            entry.guid = cf.subaccountGUID || said;
            try {
              const labels = typeof cf.labels === "string" ? JSON.parse(cf.labels) : cf.labels;
              entry.org = labels?.["Org Name"] || null;
            } catch {}
          }
        }
        enumerated.push(entry);
      }

      state.subaccountList = enumerated;
      const cfList = enumerated.filter((e) => e.cfEnabled);

      if (cfList.length === 0) {
        return { ok: false, error: "No Cloud Foundry environment found in any subaccount" };
      }

      state.subaccountWaitingForChoice = true;
      send("btp:subaccountChoice", {
        globalAccountName: state.globalAccountName || null,
        globalAccountSubdomain: state.globalAccountSubdomain || null,
        subaccounts: enumerated.map((e) => ({
          guid: e.guid,
          displayName: e.displayName,
          subdomain: e.subdomain,
          region: e.region,
          provider: e.provider,
          cfEnabled: e.cfEnabled,
        })),
      });
      return { ok: true, choicePending: true };
    },

    async "btp:selectSubaccount"({ guid }) {
      const entry = (state.subaccountList || []).find((e) => e.guid === guid);
      if (!entry) return { ok: false, error: "Unknown subaccount" };
      if (!entry.cfEnabled) return { ok: false, error: "Subaccount has no Cloud Foundry environment" };
      state.subaccountWaitingForChoice = false;
      const env = await applySubaccountSelection(entry);
      send("btp:loggedIn", { ...env, subdomain: state.globalAccountSubdomain });
      return env;
    },

    async "btp:listUsers"() {
      const args = ["list", "security/user"];
      if (state.subaccount) args.push("--subaccount", state.subaccount);
      const r = await run(resolveBtp(), args, { source: "btp" });
      if (r.code !== 0) return { ok: false, users: [], error: r.stderr };
      const users = r.stdout
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => /@/.test(l) && !/username/i.test(l));
      return { ok: true, users };
    },

    async "btp:assignRole"({ user, role }) {
      const args = ["assign", "security/role-collection", role || "IRTAdmin", "--to-user", user];
      if (state.subaccount) args.push("--subaccount", state.subaccount);
      const r = await run(resolveBtp(), args, { source: "btp" });
      return { ok: r.code === 0, stdout: r.stdout, stderr: r.stderr };
    },

    // CF login ────────────────────────────────────────────────────────────────

    async "cf:loginStart"({ apiUrl }) {
      const target = apiUrl ||
        (state.landscape ? `https://api.${state.landscape.replace(/^cf-/, "cf.")}.hana.ondemand.com` : null);
      if (!target) return { ok: false, error: "No API URL" };
      if (state.cfLoginProc && !state.cfLoginProc.killed) {
        try { state.cfLoginProc.kill(); } catch {}
      }
      const cfBin = resolveCf();
      // In the FAID Apps console the manager's own space is the only correct install
      // target, and the hosted manager knows it from VCAP_APPLICATION - so
      // `-o`/`-s` answer the CLI's org/space prompts for us (cf-target.js
      // resolveSelfPin). A null pin means the interactive picker below still
      // applies: desktop, a login to another landscape, or Alex's classic
      // wizard, which deploys the Figaf tool into a space the operator picks.
      const pin = resolveSelfPin(selfTargetForPin(), target);
      const args = ["login", "-a", target, "--sso"];
      if (pin) args.push("-o", pin.org, "-s", pin.space);
      const proc = spawn(cfBin, args, { shell: false, windowsHide: true, env: cliEnv() });
      state.cfLoginProc = proc;
      state.cfOrgList = null;
      state.cfSpaceList = null;
      state.cfWaitingForOrgChoice = false;
      state.cfWaitingForSpaceChoice = false;
      log("cmd", "cmd", `${cfBin} ${args.join(" ")}`);
      if (pin) {
        log("cf", "line", `Target fixed to this manager's own location: org ${pin.org}, space ${pin.space} (nothing to choose).`);
      }

      // Parse cf's interactive picker for "Select an org:" / "Select a space:".
      // The CLI writes the prompt header, then numbered lines, then "<thing>
      // (enter to skip):" without a trailing newline. We detect that final
      // marker (which may straddle a buffer boundary) by scanning the rolling
      // tail of stdout, surface a choice event, and feed the user's pick back
      // through stdin via cf:selectOrg / cf:selectSpace.
      let stdoutTail = "";
      // Last few KB of stdout+stderr. A pinned login has no picker to correct
      // a wrong target in, so the close handler classifies the failure from
      // this tail and says what to do about it.
      let failTail = "";
      const keepTail = (chunk) => { failTail = (failTail + chunk).slice(-4096); };
      let collecting = null; // "org" | "space" | null
      let entries = [];
      const ENTRY_RE = /^\s*(\d+)\.\s+(.+?)\s*$/;

      function emitChoice(kind) {
        const list = entries.slice();
        entries = [];
        collecting = null;
        if (kind === "org") {
          state.cfOrgList = list;
          state.cfWaitingForOrgChoice = true;
          send("cf:orgChoice", {
            orgs: list.map((e) => ({
              index: e.index,
              name: e.name,
              recommended: !!(state.org && e.name === state.org),
            })),
          });
        } else {
          state.cfSpaceList = list;
          state.cfWaitingForSpaceChoice = true;
          send("cf:spaceChoice", {
            spaces: list.map((e) => ({ index: e.index, name: e.name })),
          });
        }
      }

      proc.stdout.on("data", (buf) => {
        const chunk = buf.toString();
        keepTail(chunk);
        // split() always returns a trailing element even when the chunk has no
        // final newline, so the unterminated "Org (enter to skip):" prompt
        // shows up here as a regular line. Match it inline rather than via the
        // stdout tail — the tail-watch below is only a safety net for the rare
        // case where the prompt straddles a chunk boundary.
        for (const line of chunk.split(/\r?\n/)) {
          if (!line.length) continue;
          log("cf", "line", line);
          if (/^Select an org:/i.test(line)) {
            collecting = "org"; entries = []; continue;
          }
          if (/^Select a space:/i.test(line)) {
            collecting = "space"; entries = []; continue;
          }
          if (/^\s*Org\s*\(enter to skip\):/i.test(line)) {
            if (collecting === "org" && entries.length) emitChoice("org");
            continue;
          }
          if (/^\s*Space\s*\(enter to skip\):/i.test(line)) {
            if (collecting === "space" && entries.length) emitChoice("space");
            continue;
          }
          if (collecting) {
            const m = ENTRY_RE.exec(line);
            if (m) {
              entries.push({ index: Number(m[1]), name: m[2] });
              continue;
            }
            // Non-matching, non-empty line aborts collection (defensive).
            if (!/^\s*$/.test(line)) collecting = null;
          }
        }
        // Safety net: prompt straddled a chunk boundary so neither half was a
        // full line. Watch the rolling tail of recent stdout.
        stdoutTail = (stdoutTail + chunk).slice(-256);
        if (collecting === "org" && entries.length && /Org\s*\(enter to skip\):\s*$/i.test(stdoutTail)) {
          stdoutTail = ""; emitChoice("org");
        } else if (collecting === "space" && entries.length && /Space\s*\(enter to skip\):\s*$/i.test(stdoutTail)) {
          stdoutTail = ""; emitChoice("space");
        }
      });
      proc.stderr.on("data", (buf) => {
        const chunk = buf.toString();
        keepTail(chunk);
        for (const line of chunk.split(/\r?\n/)) {
          if (line.length) log("cf", "err", line);
        }
      });
      proc.on("close", (code) => {
        log("cf", code === 0 ? "ok" : "err", `cf login exited (${code})`);
        state.cfOrgList = null;
        state.cfSpaceList = null;
        state.cfWaitingForOrgChoice = false;
        state.cfWaitingForSpaceChoice = false;
        if (code === 0) {
          state.cfLoginKind = "passcode";
          if (pin) {
            // `cf login -o -s` already targeted it; mirror it into our state
            // so the setup steps do not have to wait for cf:targetOrgSpace.
            state.org = pin.org;
            state.space = pin.space;
            log("cf", "ok", `Signed in - org ${pin.org}, space ${pin.space} (this manager's own space)`);
          }
          send("cf:loggedIn", {});
        } else {
          const explained = explainPinnedLoginFailure(failTail, pin);
          if (explained) log("cf", "err", explained);
          send("cf:loginFailed", { code, error: explained || null });
        }
        state.cfLoginProc = null;
      });
      return { ok: true, apiUrl: target, pinned: pin };
    },

    // CF-only login (skip BTP): suggest a default CF API endpoint for the
    // manual entry field. Hosted manager knows its own endpoint from VCAP;
    // desktop has no ambient CF context, so this returns "" there.
    async "cf:suggestedApiUrl"() {
      try { return { ok: true, apiUrl: host.getDeployTargetForSelf?.()?.apiUrl || "" }; }
      catch { return { ok: true, apiUrl: "" }; }
    },

    // The manager's own org/space, when a passcode login to `apiUrl` will be
    // pinned to them (cf-target.js resolveSelfPin). The sign-in card shows
    // this as fixed information instead of an org/space picker.
    // `{ ok: true, pinned: null }` means the picker still applies.
    async "cf:ownTarget"({ apiUrl } = {}) {
      const self = selfTargetForPin();
      const requested = apiUrl || (self && self.apiUrl) || null;
      return { ok: true, pinned: resolveSelfPin(self, requested) };
    },

    async "cf:submitPasscode"({ code }) {
      const proc = state.cfLoginProc;
      if (!proc || proc.killed) return { ok: false, error: "No active cf login session" };
      try {
        proc.stdin.write(code.trim() + os.EOL);
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    },

    async "cf:selectOrg"({ index }) {
      const proc = state.cfLoginProc;
      if (!proc || proc.killed) return { ok: false, error: "No active cf login session" };
      if (!state.cfWaitingForOrgChoice) return { ok: false, error: "cf login is not awaiting an org selection" };
      const entry = (state.cfOrgList || []).find((e) => e.index === Number(index));
      if (!entry) return { ok: false, error: "Unknown org index" };
      try {
        proc.stdin.write(String(entry.index) + os.EOL);
        state.cfWaitingForOrgChoice = false;
        return { ok: true, org: entry.name };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    },

    async "cf:selectSpace"({ index }) {
      const proc = state.cfLoginProc;
      if (!proc || proc.killed) return { ok: false, error: "No active cf login session" };
      if (!state.cfWaitingForSpaceChoice) return { ok: false, error: "cf login is not awaiting a space selection" };
      const entry = (state.cfSpaceList || []).find((e) => e.index === Number(index));
      if (!entry) return { ok: false, error: "Unknown space index" };
      try {
        proc.stdin.write(String(entry.index) + os.EOL);
        state.cfWaitingForSpaceChoice = false;
        return { ok: true, space: entry.name };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    },

    async "cf:logout"() {
      if (state.cfLoginProc && !state.cfLoginProc.killed) {
        try { state.cfLoginProc.kill(); } catch {}
      }
      state.cfLoginProc = null;
      await run(resolveCf(), ["logout"], { source: "cf" }).catch(() => {});
      state.org = null;
      state.space = null;
      state.user = null;
      state.cfLoginKind = null;
      state.cfSwitchOrgList = null;
      state.cfSwitchSelectedOrg = null;
      state.cfSwitchSpaceList = null;
      return { ok: true };
    },

    async "cf:targetOrgSpace"() {
      const r = await run(resolveCf(), ["target"], { source: "cf" });
      if (r.code !== 0) return { ok: false, error: r.stderr };
      const org   = /org:\s+(\S+)/i.exec(r.stdout)?.[1] || null;
      const space = /space:\s+(\S+)/i.exec(r.stdout)?.[1] || null;
      const user  = /user:\s+(\S+)/i.exec(r.stdout)?.[1] || null;
      state.org   = org   || state.org;
      state.space = space || state.space;
      state.user  = user  || state.user;
      return { ok: true, org, space, user };
    },

    async "cf:switchOrgStart"() {
      const r = await run(resolveCf(), ["orgs"], { source: "cf" });
      if (r.code !== 0) return { ok: false, error: r.stderr || "cf orgs failed" };
      const orgs = parseCfList(r.stdout);
      if (orgs.length === 0) return { ok: false, error: "No orgs found" };
      state.cfSwitchOrgList = orgs;
      state.cfSwitchSelectedOrg = null;
      state.cfSwitchSpaceList = null;
      send("cf:orgChoice", {
        orgs: orgs.map((name, i) => ({
          index: i + 1,
          name,
          recommended: !!(state.org && name === state.org),
        })),
      });
      return { ok: true };
    },

    async "cf:switchSelectOrg"({ index }) {
      const orgName = (state.cfSwitchOrgList || [])[Number(index) - 1];
      if (!orgName) return { ok: false, error: "Unknown org index" };
      const t = await run(resolveCf(), ["target", "-o", orgName], { source: "cf" });
      if (t.code !== 0) return { ok: false, error: t.stderr || "cf target -o failed" };
      state.cfSwitchSelectedOrg = orgName;
      const sr = await run(resolveCf(), ["spaces"], { source: "cf" });
      if (sr.code !== 0) {
        const sync = await run(resolveCf(), ["target"], { source: "cf" });
        if (sync.code === 0) {
          state.org   = /org:\s+(\S+)/i.exec(sync.stdout)?.[1]   || state.org;
          state.space = /space:\s+(\S+)/i.exec(sync.stdout)?.[1] || null;
        } else {
          state.org   = null;
          state.space = null;
        }
        return { ok: false, error: sr.stderr || "cf spaces failed" };
      }
      const spaces = parseCfList(sr.stdout);
      if (spaces.length === 0) return { ok: false, error: "No spaces found in org" };
      state.cfSwitchSpaceList = spaces;
      send("cf:spaceChoice", {
        spaces: spaces.map((name, i) => ({ index: i + 1, name })),
      });
      return { ok: true };
    },

    async "cf:switchSelectSpace"({ index }) {
      const org = state.cfSwitchSelectedOrg;
      const spaceName = (state.cfSwitchSpaceList || [])[Number(index) - 1];
      if (!org) return { ok: false, error: "No org selected for switch" };
      if (!spaceName) return { ok: false, error: "Unknown space index" };
      const t = await run(resolveCf(), ["target", "-o", org, "-s", spaceName], { source: "cf" });
      if (t.code !== 0) return { ok: false, error: t.stderr || "cf target -o -s failed" };
      state.org = org;
      state.space = spaceName;
      state.cfSwitchOrgList = null;
      state.cfSwitchSelectedOrg = null;
      state.cfSwitchSpaceList = null;
      send("cf:switchOrgDone", { org, space: spaceName });
      return { ok: true };
    },

    async "cf:domains"() {
      const r = await run(resolveCf(), ["domains"], { source: "cf" });
      if (r.code !== 0) return { ok: false, error: r.stderr };
      const rows = parseTable(r.stdout, ["name", "availability"]);
      const cfapps = rows.map((row) => row.name).filter((n) => n && n.startsWith("cfapps."));
      return { ok: true, domains: cfapps };
    },

    async "cf:marketplacePostgresql"() {
      const r = await run(resolveCf(), ["marketplace", "-e", "postgresql-db"], { source: "cf" });
      if (r.code !== 0) return { ok: false, error: r.stderr, plans: [] };
      const rows = parseTable(r.stdout, ["plan", "description"]);
      const plans = rows
        .filter((row) => row.plan && !/^-+$/.test(row.plan))
        .map((row) => ({
          name: row.plan,
          description: row.description || "",
          free: /free/i.test(row["free or paid"] || row.costs || ""),
        }));
      return { ok: true, plans };
    },

    async "cf:marketplaceCheck"({ offering } = {}) {
      if (!offering) return { ok: false, error: "offering required" };
      const r = await run(resolveCf(), ["marketplace", "-e", offering], { source: "cf" });
      // cf v8 returns code 1 with a "Service offering 'X' not found." stderr
      // on a missing offering. cf v7 returns 0 with a "No service offerings
      // found" stdout line. Handle both.
      const blob = r.stdout + r.stderr;
      const notFound = /not\s+found|no service offerings found/i.test(blob);
      return { ok: r.code === 0 && !notFound, offering, stderr: r.stderr };
    },

    async "cf:createService"({ offering, plan, name, configFile }) {
      const deployDir = await resolveDeployDir();
      const args = ["create-service", offering, plan, name];
      if (configFile) args.push("-c", configFile);
      const r = await run(resolveCf(), args, { source: "cf", cwd: deployDir });
      const alreadyExists = /already exists/i.test(r.stdout + r.stderr);
      return { ok: r.code === 0 || alreadyExists, alreadyExists, stderr: r.stderr };
    },

    async "cf:service"({ name }) {
      const r = await run(resolveCf(), ["service", name], { source: "cf" });
      if (r.code !== 0) return { ok: false, error: r.stderr };
      const statusLine = /status:\s+(.+)/i.exec(r.stdout);
      return { ok: true, status: statusLine ? statusLine[1].trim() : "unknown", raw: r.stdout };
    },

    async "cf:pollService"({ name }) {
      const start = Date.now();
      const timeoutMs = 15 * 60 * 1000;
      while (Date.now() - start < timeoutMs) {
        const r = await run(resolveCf(), ["service", name], { source: "cf" });
        const line = /status:\s+(.+)/i.exec(r.stdout)?.[1]?.trim() || "unknown";
        send("cf:serviceStatus", { name, status: line });
        if (/succeeded/i.test(line)) return { ok: true, status: line };
        if (/failed/i.test(line)) return { ok: false, status: line };
        await new Promise((r) => setTimeout(r, 10000));
      }
      return { ok: false, status: "timeout" };
    },

    async "cf:createServiceKey"({ service, key } = {}) {
      if (!service || !key) return { ok: false, error: "service and key required" };
      const r = await run(resolveCf(), ["create-service-key", service, key], { source: "cf" });
      const alreadyExists = /already exists/i.test(r.stdout + r.stderr);
      return { ok: r.code === 0 || alreadyExists, alreadyExists, stderr: r.stderr };
    },

    /**
     * Read a service key. cf prints a few prefix lines then a pretty-printed
     * JSON block (the service-key payload). We spawn cf directly (not via
     * run()) so we can route stdout through redactServiceKeyLine BEFORE the
     * cli:line frames are emitted — the TerminalDrawer and audit log only
     * ever see the redacted form. The unredacted JSON travels back to the
     * UI via this handler's return value so the screen can render +
     * copy-to-clipboard the real keys.
     *
     * Returns: { ok, json, raw } on success, { ok: false, error|stderr|code }
     * on failure. `raw` is the unredacted JSON substring (not the full
     * stdout) so the UI can copy a clean payload.
     */
    async "cf:serviceKey"({ service, key } = {}) {
      if (!service || !key) return { ok: false, error: "service and key required" };
      return new Promise((resolve) => {
        const cfBin = resolveCf();
        log("cmd", "cmd", `${cfBin} service-key ${service} ${key}`);
        const proc = spawn(cfBin, ["service-key", service, key], { shell: false, windowsHide: true, env: cliEnv() });
        let rawStdout = "";
        let rawStderr = "";
        let lineRemainder = "";
        proc.stdout.on("data", (buf) => {
          const chunk = buf.toString();
          rawStdout += chunk;
          lineRemainder += chunk;
          const parts = lineRemainder.split(/\r?\n/);
          lineRemainder = parts.pop();
          for (const line of parts) log("cf", "line", redactServiceKeyLine(line));
        });
        proc.stderr.on("data", (buf) => {
          const chunk = buf.toString();
          rawStderr += chunk;
          for (const line of chunk.split(/\r?\n/)) {
            if (line) log("cf", "err", redactServiceKeyLine(line));
          }
        });
        proc.on("error", (e) => resolve({ ok: false, error: e.message }));
        proc.on("close", (code) => {
          if (lineRemainder) log("cf", "line", redactServiceKeyLine(lineRemainder));
          if (code !== 0) return resolve({ ok: false, code, stderr: rawStderr });
          const jsonStart = rawStdout.indexOf("{");
          const jsonEnd   = rawStdout.lastIndexOf("}");
          if (jsonStart < 0 || jsonEnd <= jsonStart) {
            return resolve({ ok: false, error: "could not locate JSON in cf service-key output" });
          }
          const slice = rawStdout.slice(jsonStart, jsonEnd + 1);
          try {
            const json = JSON.parse(slice);
            resolve({ ok: true, json, raw: slice });
          } catch (e) {
            resolve({ ok: false, error: "JSON parse failed: " + e.message });
          }
        });
      });
    },

    async "cf:push"() {
      const deployDir = await resolveDeployDir();
      const r = await run(resolveCf(), ["push", "--vars-file", "vars.yml"], { source: "cf", cwd: deployDir });
      return { ok: r.code === 0, code: r.code };
    },

    // Deletes the manager app itself — surfaced as the final wizard step in hosted mode.
    async "cf:deleteApp"({ name }) {
      const appName = name || "figaf-manager";
      const r = await run(resolveCf(), ["delete", appName, "-f"], { source: "cf" });
      return { ok: r.code === 0, code: r.code };
    },

    // config ──────────────────────────────────────────────────────────────────

    async "config:dockerHubLatestBtpTag"() {
      try {
        const data = await httpsJson(
          "https://hub.docker.com/v2/repositories/figaf/app/tags?name=btp&page_size=1&ordering=last_updated"
        );
        const latest = data?.results?.[0]?.name || null;
        return { ok: !!latest, tag: latest };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    },

    async "config:dockerHubBtpTags"() {
      try {
        const data = await httpsJson(
          "https://hub.docker.com/v2/repositories/figaf/app/tags?name=btp&page_size=10&ordering=last_updated"
        );
        const tags = (data?.results || []).map(r => r.name).filter(Boolean);
        return { ok: tags.length > 0, tags };
      } catch (e) {
        return { ok: false, tags: [], error: e.message };
      }
    },

    async "config:deployDir"() {
      return { path: await resolveDeployDir() };
    },

    // connect ──────────────────────────────────────────────────────────────────

    /**
     * Return the absolute path to a connect-flow template shipped with
     * @figaf/core. Whitelisted filenames only — the channel cannot be
     * coerced into reading arbitrary paths. The UI uses this to feed an
     * absolute path into cf:createService's -c argument.
     */
    async "connect:templatePath"({ name } = {}) {
      const allowed = new Set(["figaf-api.json", "figaf-iflow.json"]);
      if (!allowed.has(name)) return { ok: false, error: "unknown template" };
      const p = path.join(__dirname, "connect-templates", name);
      return { ok: fs.existsSync(p), path: p };
    },

    /**
     * Build the cockpit deep-link to this subaccount's Trust Configuration
     * screen, where the operator manually creates the SAML trust. Trial vs
     * productive host derived from state.licenseType (see saml-connect.js).
     */
    async "connect:trustConfigUrl"() {
      const gaGuid = state.globalAccountGuid;
      const subGuid = state.subaccount;
      if (!gaGuid || !subGuid) {
        return { ok: false, error: "global account / subaccount not captured yet (sign in first)" };
      }
      const url = trustConfigUrl({ licenseType: state.licenseType, gaGuid, subGuid });
      return { ok: true, url, isTrial: state.licenseType === "TRIAL" };
    },

    /**
     * Find this subaccount's Integration Suite subscription URL, if any.
     * Integration Suite is a multitenant-app subscription, so `list
     * accounts/subscription` surfaces it (alongside every other marketplace app,
     * subscribed or not — each carrying a base64 icon, hence quiet:true so the
     * ~160 KB payload doesn't flood the terminal drawer). We accept only
     * state === "SUBSCRIBED" and match on commercialAppName
     * ("integrationsuite" / "integrationsuite-trial") or the "Integration Suite"
     * displayName; appName is a random provisioning id (e.g. "it-cpitrial05-prov")
     * so we never key off it. Returns { ok:false } (not an error toast) when no
     * IS subscription exists — the UI just hides the banner.
     */
    async "connect:integrationSuiteUrl"() {
      const sub = state.subaccount;
      if (!sub) return { ok: false, error: "subaccount not captured (sign in first)" };
      const r = await run(
        resolveBtp(),
        ["--format", "json", "list", "accounts/subscription", "--subaccount", sub],
        { source: "btp", quiet: true }
      );
      if (r.code !== 0) return { ok: false, error: r.stderr || "list accounts/subscription failed" };
      let apps;
      try {
        const jsonStart = r.stdout.indexOf("{");
        const data = jsonStart >= 0 ? JSON.parse(r.stdout.slice(jsonStart)) : null;
        apps = (data && data.applications) || [];
      } catch (e) {
        return { ok: false, error: "could not parse subscription list: " + e.message };
      }
      const is = apps.find(
        (a) =>
          a && a.state === "SUBSCRIBED" &&
          ((typeof a.commercialAppName === "string" &&
            a.commercialAppName.toLowerCase().startsWith("integrationsuite")) ||
            a.displayName === "Integration Suite")
      );
      if (!is || !is.subscriptionUrl) {
        log("btp", "line", "No Integration Suite subscription found on this subaccount.");
        return { ok: false, error: "No Integration Suite subscription found on this subaccount." };
      }
      log("btp", "ok", `Integration Suite found: ${is.subscriptionUrl}`);
      return {
        ok: true,
        url: is.subscriptionUrl,
        displayName: is.displayName || "Integration Suite",
        planName: is.planName || null,
      };
    },

    /**
     * List the subaccount's trust configs and resolve the originKey of the one
     * named `idpName`. This is the verify-on-submit call from Screen A — the UI
     * stores the originKey and reuses it on Screen B (does NOT call this again).
     */
    async "connect:resolveIdpOrigin"({ idpName } = {}) {
      const sub = state.subaccount;
      if (!sub) return { ok: false, error: "subaccount not captured (sign in first)" };
      if (!idpName) return { ok: false, error: "idpName is required" };
      const r = await run(resolveBtp(), ["--format", "json", "list", "security/trust", "--subaccount", sub], { source: "btp" });
      if (r.code !== 0) return { ok: false, error: r.stderr || "list security/trust failed" };
      let parsed;
      try {
        const arrStart = r.stdout.indexOf("[");
        const objStart = r.stdout.indexOf("{");
        // Pick the earliest real JSON start; findTrustOrigin handles both a bare
        // array and a { value: [...] } wrapper.
        const candidates = [arrStart, objStart].filter((i) => i >= 0);
        const js = candidates.length ? Math.min(...candidates) : -1;
        parsed = js >= 0 ? JSON.parse(r.stdout.slice(js)) : [];
      } catch (e) {
        return { ok: false, error: "could not parse trust list: " + e.message };
      }
      const found = findTrustOrigin(parsed, idpName);
      if (!found.ok) {
        return { ok: false, error: `No SAML trust named "${idpName}" found in this subaccount.`, all: found.all };
      }
      return { ok: true, originKey: found.originKey, all: found.all };
    },

    /**
     * Assign ONE PI role collection to the SAML group for the custom IDP origin.
     * One role per call so the UI owns the loop + per-row state (mirrors
     * ScreenConnectProvision + cf:createService). Uses --of-idp <originKey>
     * --to-group <group> — distinct from xsuaa:assignRoleCollection, which is
     * --to-user against the default IDP.
     */
    async "connect:assignPiRole"({ role, originKey, group } = {}) {
      const sub = state.subaccount;
      if (!sub) return { ok: false, error: "subaccount not captured (sign in first)" };
      if (!role || !originKey || !group) return { ok: false, error: "role, originKey and group are required" };
      const args = ["assign", "security/role-collection", role, "--subaccount", sub, "--of-idp", originKey, "--to-group", group];
      const r = await run(resolveBtp(), args, { source: "btp" });
      const c = classifyAssignResult(r);
      return { ok: c.ok || c.alreadyAssigned, alreadyAssigned: c.alreadyAssigned, sessionExpired: c.sessionExpired, stderr: c.stderr, role };
    },

    /**
     * Fetch the subaccount's SAML SP metadata and extract the SSO URL (the
     * AssertionConsumerService HTTP-POST Location). The operator copies this
     * into the Figaf Tool. The `.aws-live` alias inside the URL is not exposed
     * by any btp CLI command, which is why we fetch-and-parse rather than build.
     */
    async "connect:samlSsoUrl"() {
      const subdomain = state.subaccountSubdomain;
      const region = regionFromLandscape(state.landscape);
      if (!subdomain || !region) {
        return { ok: false, error: "subaccount subdomain / region not captured (sign in first)" };
      }
      const url = `https://${subdomain}.authentication.${region}.hana.ondemand.com/saml/metadata`;
      // Subaccounts on a custom UAA / sovereign authentication domain don't
      // follow <region>.hana.ondemand.com, so the constructed host fails to
      // resolve/return — surface that explicitly rather than a raw network error.
      const customDomainHint =
        " — this subaccount may use a custom authentication domain; open the SAML SP metadata manually and copy the SSO URL.";
      try {
        log("btp", "line", `Fetching SAML metadata: ${url}`);
        const xml = await httpsText(url);
        const { ssoUrl, alias } = parseSsoUrlFromMetadata(xml);
        if (!ssoUrl) return { ok: false, error: `metadata fetched but no HTTP-POST AssertionConsumerService found${customDomainHint}` };
        return { ok: true, ssoUrl, alias };
      } catch (e) {
        return { ok: false, error: `could not auto-locate SAML metadata (${e.message})${customDomainHint}` };
      }
    },

    /**
     * Subscribe this subaccount to the SAP Cloud Identity Services onboarding
     * app (app: sap-identity-services-onboarding, plan: default,
     * params: {cloud_service:"PRODUCTIVE"}). This is a multitenant SaaS
     * *subscription*, NOT a CF service instance — `cf create-service` cannot
     * create it (in the cockpit "default" lives under Subscriptions; only the
     * "application" plan is a createable instance). Polls
     * `btp list accounts/subscription` until the app reaches SUBSCRIBED.
     * Returns { ok, alreadyExists, status? }.
     */
    async "connect:createIasService"() {
      const sub = state.subaccount;
      if (!sub) return { ok: false, error: "subaccount not captured (sign in first)" };

      const APP = "sap-identity-services-onboarding";
      const PLAN = "default";

      // --parameters accepts a file path; writing the JSON to a temp file
      // sidesteps Windows shell-quoting of the inline object.
      const configFile = path.join(os.tmpdir(), "figaf-ias-config.json");
      await fsp.writeFile(configFile, JSON.stringify({ cloud_service: "PRODUCTIVE" }), "utf8");

      const r = await run(resolveBtp(), [
        "subscribe", "accounts/subaccount",
        "--subaccount", sub,
        "--to-app", APP,
        "--plan", PLAN,
        "--parameters", configFile,
      ], { source: "btp" });

      // An existing or in-flight subscription is reported as an error; treat it
      // as success and let the poll below converge to the real state.
      const alreadyExists =
        /already subscribed|already exists|in progress|in process|subscription.*(exist|process)/i.test(r.stdout + r.stderr);
      if (r.code !== 0 && !alreadyExists) {
        return { ok: false, alreadyExists: false, stderr: r.stderr };
      }

      // Provisioning an IAS tenant can take several minutes.
      const timeoutMs = 15 * 60 * 1000;
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const s = await run(resolveBtp(), [
          "--format", "json", "list", "accounts/subscription", "--subaccount", sub,
        ], { source: "btp" });
        let appState = "UNKNOWN";
        try {
          const js = s.stdout.indexOf("{");
          const parsed = js >= 0 ? JSON.parse(s.stdout.slice(js)) : {};
          const apps = parsed.applications || [];
          const entry = apps.find((a) => a.appName === APP);
          appState = (entry && entry.state) || "UNKNOWN";
        } catch { /* keep UNKNOWN and retry on the next tick */ }
        send("cf:serviceStatus", { name: "identity", status: appState });
        if (/^SUBSCRIBED$/i.test(appState)) return { ok: true, alreadyExists };
        if (/FAILED/i.test(appState)) return { ok: false, alreadyExists, status: appState };
        await new Promise((resolve) => setTimeout(resolve, 10000));
      }
      return { ok: false, alreadyExists, status: "timeout" };
    },

    /**
     * Establish trust between this subaccount and its SAP Cloud Identity
     * Services tenant. Once the onboarding subscription (step 1) finishes
     * provisioning, the tenant appears in `btp list security/available-idp`;
     * that tenant value is exactly what `btp create security/trust --idp`
     * consumes (per the available-idp help). No service key / secret is read in
     * this flow — trust is established purely from the listed tenant identifier.
     * Returns { ok, iasUrl, alreadyExists, step?, stderr?, error?, idps? }.
     */
    async "connect:establishIasTrust"() {
      const sub = state.subaccount;
      if (!sub) return { ok: false, error: "subaccount not captured (sign in first)" };

      // Look up the provisioned IAS tenant from the subaccount's available IDPs.
      const lr = await run(resolveBtp(), [
        "--format", "json", "list", "security/available-idp", "--subaccount", sub,
      ], { source: "btp" });
      if (lr.code !== 0) return { ok: false, step: "list-idp", stderr: lr.stderr };

      let idps;
      try {
        const arrStart = lr.stdout.indexOf("[");
        const objStart = lr.stdout.indexOf("{");
        const candidates = [arrStart, objStart].filter((i) => i >= 0);
        const js = candidates.length ? Math.min(...candidates) : -1;
        idps = js >= 0 ? JSON.parse(lr.stdout.slice(js)) : [];
      } catch (e) {
        return { ok: false, step: "parse-idp", error: "could not parse available-idp list: " + e.message };
      }

      const idpList = Array.isArray(idps) ? idps : (idps.value || idps.identityProviders || []);
      if (!idpList.length) {
        return {
          ok: false,
          step: "no-idp",
          error: "No SAP Cloud Identity Services tenant is available yet — finish step 1 (subscribe) and wait for provisioning to complete before establishing trust.",
        };
      }

      const tenant = pickIasTenant(idps);
      if (!tenant) {
        // Surface the raw entries so the tenant field can be pinned without guessing.
        return { ok: false, step: "extract-idp", error: "could not determine the IAS tenant value from available-idp", idps: idpList };
      }

      const tr = await run(resolveBtp(), [
        "create", "security/trust",
        "--idp", tenant,
        "--subaccount", sub,
        "--name", "SAP Cloud Identity Services",
      ], { source: "btp" });

      const alreadyEstablished = /already exists|already established|already trusted/i.test(tr.stdout + tr.stderr);
      if (tr.code !== 0 && !alreadyEstablished) {
        return { ok: false, step: "establish-trust", stderr: tr.stderr, iasUrl: tenant };
      }

      return { ok: true, iasUrl: tenant, alreadyExists: alreadyEstablished };
    },

    async "config:readVars"() {
      const deployDir = await resolveDeployDir();
      const file = path.join(deployDir, "vars.yml");
      const text = await fsp.readFile(file, "utf8");
      return { ok: true, text, path: file };
    },

    async "config:writeVars"(vars) {
      const deployDir = await resolveDeployDir();
      const file = path.join(deployDir, "vars.yml");
      let text = await fsp.readFile(file, "utf8");
      const mutations = [
        ["ID", vars.id],
        ["LANDSCAPE_APPS_DOMAIN", vars.domain],
        ["LOCATION_ID", vars.locationId],
        ["DOCKER_IMAGE_VERSION", vars.dockerVersion],
        ["DOCKER_USERNAME", vars.dockerUsername],
        ["INSTANCE_MEMORY", vars.instanceMemory],
        ["MAX_RAM_PERCENTAGE", vars.maxRamPercentage],
        ["LOGS_TOTAL_SIZE_CAP", vars.logsTotalSizeCap],
        ["ENABLE_INSTANCE_MONITORING", vars.enableInstanceMonitoring],
        ["USE_CLOUD_CONNECTOR_FOR_SMTP_INTEGRATION", vars.useCloudConnectorForSmtpIntegration],
        ["CLOUD_CONNECTOR_DESTINATION_NAME_FOR_SMTP_INTEGRATION", vars.cloudConnectorDestinationNameForSmtpIntegration],
      ];
      for (const [key, value] of mutations) {
        if (value == null || value === "") continue;
        const re = new RegExp(`^(${key}\\s*:).*$`, "m");
        if (re.test(text)) text = text.replace(re, `$1 ${value}`);
        else text += `\n${key}: ${value}`;
      }
      await fsp.writeFile(file, text, "utf8");

      // Patch manifest.yml: toggle optional services and rename the DB service if needed.
      const manifestFile = path.join(deployDir, "manifest.yml");
      try {
        let manifest = await fsp.readFile(manifestFile, "utf8");
        manifest = patchManifestService(manifest, "figaf-connectivity", !!vars.enableConnectivity);
        manifest = patchManifestService(manifest, "figaf-destination", !!vars.enableDestination);
        if (vars.dbServiceName && vars.dbServiceName !== "figaf-db") {
          manifest = manifest.replace(/^(\s*- )figaf-db(\s*)$/m, `$1${vars.dbServiceName}$2`);
        }
        await fsp.writeFile(manifestFile, manifest, "utf8");
      } catch { /* manifest may not exist yet during early setup */ }

      return { ok: true, path: file };
    },

    /**
     * Read the current db.json verbatim. Used by the UI to seed the
     * PostgreSQL parameters form (and to keep parity with config:readVars).
     */
    async "config:readDbConfig"() {
      const deployDir = await resolveDeployDir();
      const file = path.join(deployDir, "db.json");
      try {
        const text = await fsp.readFile(file, "utf8");
        return { ok: true, text, path: file };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    },

    /**
     * Write <deployDir>/db.json from a structured input. The renderer sends:
     *   { trial: boolean, provider: "AWS"|"Microsoft Azure"|"Google Cloud Platform"|null,
     *     fields: { engine_version, locale, storage, memory, ... } }
     * The orchestrator owns the schema map (packages/core/db-schemas.js); the
     * renderer cannot inject arbitrary keys. Trial schema is the limited
     * { engine_version, locale } the broker accepts on trial subaccounts;
     * hyperscaler schema is the full per-provider shape and includes the
     * Figaf-required postgresql_extensions list.
     */
    async "config:writeDbConfig"({ trial, provider, fields } = {}) {
      const built = dbSchemas.buildDbConfig({ trial: !!trial, provider, fields: fields || {} });
      if (!built.ok) return built;
      const deployDir = await resolveDeployDir();
      const file = path.join(deployDir, "db.json");
      await fsp.writeFile(file, JSON.stringify(built.json, null, 4) + "\n", "utf8");
      return { ok: true, path: file, json: built.json };
    },

    /**
     * Inspect the schema metadata (defaults + allowed UI fields) for a
     * (trial, provider) pair. Lets the renderer render a sane form without
     * embedding SAP-side schema knowledge.
     */
    async "config:dbSchema"({ trial, provider } = {}) {
      const defaults = dbSchemas.defaultsFor(!!trial, provider);
      const fields = dbSchemas.allowedFields(!!trial, provider);
      return { ok: !!defaults, defaults: defaults || null, fields };
    },

    // XSUAA upgrade (v2) ──────────────────────────────────────────────────────
    // See auth-gate-implementation-plan.md §2. The upgrade runs from inside
    // the manager dyno using the operator's already-authenticated cf CLI.
    // All handlers below are hosted-mode only — in figaf-local they return
    // safe { ok: false, error: "not available in desktop mode" }.

    /**
     * Detect mid-upgrade state. Returns { hasXsuaaService, hasApprouterApp,
     * managerBound, route, mode }. Pure inspection — never mutates.
     */
    async "xsuaa:upgradeStatus"() {
      if (!host.isHosted) return { ok: false, error: "not available in desktop mode" };
      const inst = targetXsuaaInstance();
      const result = {
        ok: true, hasXsuaaService: false, hasApprouterApp: false, managerBound: false, route: null, mode: "token",
        // decision 0009: which instance this manager talks to, and the role
        // collection the upgrade assigns by default.
        instance: inst,
        legacy: inst === managerXsuaa.LEGACY_INSTANCE,
        roleCollection: managerXsuaa.adminCollectionFor(inst),
      };
      const svc = await run(resolveCf(), ["service", inst], { source: "cf" });
      result.hasXsuaaService = svc.code === 0;
      result.hasApprouterApp = await probeApprouterPresence();
      // Read manager's own routes from VCAP_APPLICATION (set by CF on every dyno).
      try {
        const va = JSON.parse(process.env.VCAP_APPLICATION || "{}");
        result.route = (va.uris && va.uris[0]) || null;
      } catch { /* leave null */ }
      // managerBound: try cf services and look for figaf-manager in the
      // bound apps column. CF v8 doesn't have a direct "show bindings for
      // service X" CLI, so we use cf curl on the service binding endpoint.
      const sb = await run(resolveCf(), ["curl", `/v3/service_credential_bindings?service_instance_names=${inst}&app_names=figaf-manager`], { source: "cf" });
      if (sb.code === 0) {
        try {
          const parsed = JSON.parse(sb.stdout);
          result.managerBound = Array.isArray(parsed.resources) && parsed.resources.length > 0;
        } catch { /* ignore */ }
      }
      result.mode = result.managerBound ? "xsuaa" : "token";
      return result;
    },

    /**
     * Phase 1 — prepare the SHARED XSUAA instance (decision 0009): create
     * `figaf-faid-xsuaa` when missing, update it when present, always from the
     * composed document (manager part + release part). Runs on every upgrade,
     * so an instance that came from the release or a script gets the manager
     * roles too. Delegates to faid:ensureXsuaa (packages/core/faid-apps.js).
     * A manager already bound to the legacy instance has nothing to create.
     */
    async "cf:createXsuaa"() {
      if (!host.isHosted) return { ok: false, error: "not available in desktop mode" };
      const inst = targetXsuaaInstance();
      if (inst === managerXsuaa.LEGACY_INSTANCE) {
        send("xsuaa:upgradePhase", { phase: "create-xsuaa", state: "done" });
        return { ok: true, alreadyExists: true, instance: inst, legacy: true };
      }
      send("xsuaa:upgradePhase", { phase: "create-xsuaa", state: "running" });
      send("cf:serviceStatus", { name: inst, status: "preparing" });
      const r = await handlers["faid:ensureXsuaa"]({});
      if (!r || !r.ok) {
        const error = (r && r.error) || "prepare XSUAA failed";
        send("xsuaa:upgradePhase", { phase: "create-xsuaa", state: "failed", error });
        return { ok: false, error, instance: inst };
      }
      const status = r.created ? "create succeeded" : "update succeeded";
      send("cf:serviceStatus", { name: inst, status });
      send("xsuaa:upgradePhase", { phase: "create-xsuaa", state: "done" });
      return { ok: true, alreadyExists: !r.created, created: !!r.created, updated: !!r.updated, instance: inst, status };
    },

    /**
     * Phase 1.3-1.6 — push, bind, start the manager-approuter app.
     * Reads the bundled approuter dir, materializes a synthetic manifest
     * with the wizard's route info, then runs cf push.
     *
     * Destination wiring (the reason this handler does more than just push):
     * @sap/approuter validates xs-app.json at boot — every route that names
     * a `destination` must have a matching entry in either a bound destination
     * service or the `destinations` env var. The wizard's xs-app.json forwards
     * every non-/_health request to a destination named `figaf-manager-internal`.
     * We don't bind a CF destination service (it would be one more service to
     * provision and clean up); we wire the destination via env var instead.
     *
     * The destination URL must outlive the public-route swap in Phase 2: after
     * `cf unmap-route figaf-manager <public>` the manager has no public route
     * left, so we map an additional `<hostname>-internal` route to figaf-manager
     * here, BEFORE the approuter starts, and point the destination at that URL.
     * This mirrors the pattern in `packages/deploy-templates/manifest.yml` where
     * the Figaf Tool sits behind a `-internal` hostname and its approuter
     * forwards via a `destinations` env var.
     */
    async "cf:pushManagerApprouter"() {
      if (!host.isHosted) return { ok: false, error: "not available in desktop mode" };
      const approuterDir = host.resolveManagerApprouterDir && host.resolveManagerApprouterDir();
      if (!approuterDir || !fs.existsSync(approuterDir)) {
        return { ok: false, error: "manager-approuter not bundled in this build; redeploy with v2 zip" };
      }

      // Read the manager's own current route(s) from VCAP_APPLICATION (set on
      // every CF dyno). We need both the hostname (to derive an internal
      // sibling) and the domain (to map the internal route on the same
      // landscape apps domain). On a retry after Phase 2.3 the only remaining
      // uri will already be the -internal hostname; in that case strip the
      // suffix back to the canonical hostname so we don't double-suffix.
      let managerHostname, managerDomain;
      try {
        const va = JSON.parse(process.env.VCAP_APPLICATION || "{}");
        const uri = (va.uris && va.uris[0]) || "";
        const dot = uri.indexOf(".");
        if (dot > 0) {
          let host = uri.slice(0, dot);
          if (host.endsWith("-internal")) host = host.slice(0, -"-internal".length);
          managerHostname = host;
          managerDomain   = uri.slice(dot + 1);
        }
      } catch { /* leave undefined */ }
      if (!managerHostname || !managerDomain) {
        return { ok: false, error: "could not derive manager route from VCAP_APPLICATION" };
      }
      const internalHostname = `${managerHostname}-internal`;
      const internalUrl      = `https://${internalHostname}.${managerDomain}`;

      send("xsuaa:upgradePhase", { phase: "push-approuter", state: "running" });

      // We push with --no-route --no-start so phase 2 can map the route
      // atomically. The approuter's own internal port comes from $PORT (CF
      // sets it). Memory: 128 MB is fine for @sap/approuter under steady load.
      // Stack: the one the manager runs on (CF_STACK; cf-stack.js).
      const pushArgs = [
        "push", "figaf-manager-approuter",
        "-p", approuterDir,
        "-m", "128M",
        "-k", "256M",
        ...stackArgs(ownStack()),
        "--no-route",
        "--no-start",
        "--no-manifest",
      ];
      const r = await run(resolveCf(), pushArgs, { source: "cf" });
      if (r.code !== 0) {
        send("xsuaa:upgradePhase", { phase: "push-approuter", state: "failed", error: r.stderr });
        return { ok: false, error: r.stderr || "cf push failed" };
      }
      // 1.5 bind-service
      const b = await run(resolveCf(), ["bind-service", "figaf-manager-approuter", targetXsuaaInstance()], { source: "cf" });
      if (b.code !== 0 && !/already bound/i.test(b.stdout + b.stderr)) {
        send("xsuaa:upgradePhase", { phase: "push-approuter", state: "failed", error: b.stderr });
        return { ok: false, error: b.stderr || "bind-service failed" };
      }

      // 1.5b — map the internal route to figaf-manager. Idempotent: cf
      // map-route returns 0 on a fresh map and a recognizable message on a
      // pre-existing one. We accept both (a re-run of the upgrade flow must
      // not blow up here).
      const mr = await run(resolveCf(), ["map-route", "figaf-manager", managerDomain, "--hostname", internalHostname], { source: "cf" });
      const alreadyMapped = /already exists|already mapped/i.test(mr.stdout + mr.stderr);
      if (mr.code !== 0 && !alreadyMapped) {
        send("xsuaa:upgradePhase", { phase: "push-approuter", state: "failed", error: mr.stderr });
        return { ok: false, error: mr.stderr || "map-route (internal) failed" };
      }

      // 1.5c — declare the figaf-manager-internal destination on the approuter
      // before first start, so @sap/approuter's JsonValidator finds it when it
      // loads xs-app.json. forwardAuthToken=true is essential: the manager's
      // @sap/xssec middleware needs the JWT the approuter validated.
      const destinations = JSON.stringify([{
        name: "figaf-manager-internal",
        url: internalUrl,
        forwardAuthToken: true,
        timeout: 86400000,
      }]);
      const se1 = await run(resolveCf(), ["set-env", "figaf-manager-approuter", "destinations", destinations], { source: "cf" });
      if (se1.code !== 0) {
        send("xsuaa:upgradePhase", { phase: "push-approuter", state: "failed", error: se1.stderr });
        return { ok: false, error: se1.stderr || "set-env destinations failed" };
      }
      // server.js (the approuter's own custom wrapper) reads this convenience
      // env var to probe the manager's /health from /_manager-health.
      const se2 = await run(resolveCf(), ["set-env", "figaf-manager-approuter", "destinations_figaf_manager_internal_url", internalUrl], { source: "cf" });
      if (se2.code !== 0) {
        send("xsuaa:upgradePhase", { phase: "push-approuter", state: "failed", error: se2.stderr });
        return { ok: false, error: se2.stderr || "set-env destinations_figaf_manager_internal_url failed" };
      }

      // 1.6 start
      const s = await run(resolveCf(), ["start", "figaf-manager-approuter"], { source: "cf" });
      if (s.code !== 0) {
        send("xsuaa:upgradePhase", { phase: "push-approuter", state: "failed", error: s.stderr });
        return { ok: false, error: s.stderr || "cf start failed" };
      }
      send("xsuaa:upgradePhase", { phase: "push-approuter", state: "done" });
      return { ok: true, internalUrl };
    },

    async "cf:mapRoute"({ app, domain, hostname }) {
      if (!host.isHosted) return { ok: false, error: "not available in desktop mode" };
      if (!app || !domain || !hostname) return { ok: false, error: "app/domain/hostname required" };
      const r = await run(resolveCf(), ["map-route", app, domain, "--hostname", hostname], { source: "cf" });
      const exists = /already exists|already mapped/i.test(r.stdout + r.stderr);
      return { ok: r.code === 0 || exists, alreadyMapped: exists, stderr: r.stderr };
    },

    async "cf:unmapRoute"({ app, domain, hostname }) {
      if (!host.isHosted) return { ok: false, error: "not available in desktop mode" };
      if (!app || !domain || !hostname) return { ok: false, error: "app/domain/hostname required" };
      const r = await run(resolveCf(), ["unmap-route", app, domain, "--hostname", hostname], { source: "cf" });
      // cf unmap-route returns non-zero if the route wasn't mapped — treat
      // as success (idempotent rollback).
      const notMapped = /not mapped|does not exist/i.test(r.stdout + r.stderr);
      return { ok: r.code === 0 || notMapped, notMapped, stderr: r.stderr };
    },

    /**
     * Phase 2.5 — bind manager to xsuaa, then restage. After restage the
     * manager comes back up with VCAP_SERVICES.xsuaa populated, which flips
     * XSUAA_ACTIVE=true in server.js at the new process's boot.
     *
     * The handler returns BEFORE restage completes — the dyno is going to
     * die in the next ~30-90s and the response would never reach the
     * browser otherwise. The UI polls via the approuter's /_manager-health
     * to detect when the manager is back.
     *
     * Args:
     *   app          — defaults to figaf-manager
     *   bindXsuaa    — when true, runs `cf bind-service <app> figaf-manager-xsuaa`
     *                  before the restage. Idempotent: "already bound" is treated
     *                  as success.
     *   skipIfBound  — when true, probes the v3 service_credential_bindings
     *                  endpoint and short-circuits the entire bind+restage if
     *                  the binding already exists. Used by the upgrade flow to
     *                  avoid an unnecessary 30-90s restage on re-runs.
     *   unmapRoute   — { domain, hostname }. When supplied, runs
     *                  `cf unmap-route <app> <domain> --hostname <hostname>` as
     *                  the first step of the cutover, BEFORE the bind. The
     *                  XSUAA upgrade splits the public route off the manager
     *                  onto the approuter — if the wizard fires the unmap as a
     *                  separate browser RPC, the next request (this restage)
     *                  arrives after the gorouter has switched the hostname
     *                  to the approuter, which 401s before the manager is ever
     *                  reached. Bundling the unmap server-side keeps the whole
     *                  cutover on one TCP connection: the RPC arrives while
     *                  the manager still serves the route, and the response
     *                  flows back over the already-open socket. Idempotent:
     *                  "not mapped / does not exist" is treated as success
     *                  so re-runs of the upgrade flow don't bail here.
     *
     * Observability: every cf call run here emits a cli:line cmd event before
     * execution. This is important during the upgrade: the restage spawn would
     * otherwise be invisible in the terminal drawer because spawn() doesn't go
     * through run(). When the bind step's frame is the last frame the browser
     * receives before the dyno bounces, operators can at least see that the
     * bind happened and the restage was initiated.
     */
    async "cf:restage"({ app, bindXsuaa, skipIfBound, unmapRoute } = {}) {
      if (!host.isHosted) return { ok: false, error: "not available in desktop mode" };
      const appName = app || "figaf-manager";
      // The shared instance for new installations; the legacy one only when
      // this process is already bound to it (decision 0009).
      const xsuaaInst = targetXsuaaInstance();

      // Short-circuit: if the caller asked us to be conservative AND the
      // binding already exists, do nothing. The manager is already (or will
      // be on next natural boot) in XSUAA mode. The phase-running/done events
      // are still emitted so the UI's phase row resolves either way.
      if (skipIfBound) {
        const probe = await run(
          resolveCf(),
          ["curl", `/v3/service_credential_bindings?service_instance_names=${xsuaaInst}&app_names=${appName}`],
          { source: "cf" }
        );
        if (probe.code === 0) {
          try {
            const parsed = JSON.parse(probe.stdout);
            if (Array.isArray(parsed.resources) && parsed.resources.length > 0) {
              send("xsuaa:upgradePhase", { phase: "restage", state: "done" });
              return { ok: true, alreadyBound: true, message: `manager already bound to ${xsuaaInst}; bind+restage skipped` };
            }
          } catch { /* fall through to the real bind path */ }
        }
      }

      // Optional cutover step: unmap the public route off this app BEFORE
      // bind/restage. See the JSDoc above for why this has to be bundled
      // into the same RPC as the restage rather than fired separately.
      if (unmapRoute && unmapRoute.domain && unmapRoute.hostname) {
        const u = await run(
          resolveCf(),
          ["unmap-route", appName, unmapRoute.domain, "--hostname", unmapRoute.hostname],
          { source: "cf" }
        );
        if (u.code !== 0 && !/not mapped|does not exist/i.test(u.stdout + u.stderr)) {
          return { ok: false, error: u.stderr || "unmap-route failed" };
        }
      }

      if (bindXsuaa) {
        const b = await run(resolveCf(), ["bind-service", appName, xsuaaInst], { source: "cf" });
        if (b.code !== 0 && !/already bound/i.test(b.stdout + b.stderr)) {
          return { ok: false, error: b.stderr || "bind-service failed" };
        }
      }
      send("xsuaa:upgradePhase", { phase: "restage", state: "running" });
      // Fire-and-forget: spawn cf restage in the background so we can
      // return success to the browser before the dyno dies.
      const cfBin = resolveCf();
      // Log the command line ourselves — spawn() bypasses run()'s cmd-emit.
      // Without this the only signal that the restage was initiated is a
      // potentially-undelivered "Restaging app ..." stdout frame from cf.
      log("cmd", "cmd", `${cfBin} restage ${appName}`);
      const restageAudit = auditor.beginCli({ cmd: cfBin, args: ["restage", appName], user: state.user });
      let restageStdout = "";
      let restageStderr = "";
      const proc = spawn(cfBin, ["restage", appName], { shell: false, windowsHide: true, detached: false, env: cliEnv() });
      proc.stdout.on("data", (b) => { const s = b.toString(); restageStdout += s; log("cf", "line", s); });
      proc.stderr.on("data", (b) => { const s = b.toString(); restageStderr += s; log("cf", "err", s); });
      // proc.on("error") is rare here (cf binary is bundled + resolveCf was
      // already called for the bind step) but a missing/unexecutable binary
      // would otherwise produce a silent failure. We log and don't reject —
      // the HTTP response is already in flight by the time this fires. The
      // audit log might still flush before the dyno bounces if the failure
      // is fast (e.g., missing binary), so we record what we can.
      proc.on("error", (err) => {
        log("cf", "err", "cf restage spawn failed: " + (err && err.message));
        restageAudit.exit({ code: -1, stdout: restageStdout, stderr: restageStderr, errorMessage: err && err.message });
      });
      // close handler is best-effort: most of the time the dyno is gone
      // before cf restage returns, but in re-run scenarios (where the
      // dyno survives) we still want the cli.exit record.
      proc.on("close", (code) => {
        restageAudit.exit({ code: code ?? 0, stdout: restageStdout, stderr: restageStderr });
      });
      return { ok: true, message: "restage initiated; manager will be unavailable for 30-90s" };
    },

    /**
     * Assign a person to a manager role collection via the btp CLI. Used by
     * ScreenXsuaaUpgrade's role-assignment panel (decided before "Start
     * upgrade"). Needs a BTP login in THIS session (probed live); the
     * subaccount GUID comes from the BTP flow when it captured one, otherwise
     * from a throw-away service key of the manager's own XSUAA instance; the
     * user is the e-mail named on the panel (default: the cf identity).
     *
     * Default role is the Admin collection of the bound instance
     * (FAID-Manager-Admin on the shared instance, FigafManagerAdmin on a
     * legacy one - decision 0009) because the Admin role-template's
     * scope-references include the Operator scope, so a single assignment
     * covers both. The role parameter is plumbed through so a caller can
     * assign the Operator collection instead, no contract change here.
     *
     * NOT shell-concatenated: spawn() with an args array via run(). No user
     * input ever lands in shell syntax. The user/subaccount values come from
     * trusted internal state (CF target output + btp env-instance JSON).
     *
     * Identity provider: we deliberately do NOT pass `--of-idp ORIGIN`. The
     * btp CLI defaults to the subaccount's primary IDP, which on standard
     * BTP/IAS setups is exactly what the wizard authenticates against. For
     * subaccounts with multiple IDPs the operator can re-run via the cockpit
     * fallback screen (ScreenXsuaaAssignRole) to pick the right origin.
     *
     * Failure handling: surfaces the stderr verbatim. The wizard treats this
     * as non-fatal — the XSUAA upgrade itself stays committed; the operator
     * just has to assign the role collection manually in the cockpit before
     * the new scope appears in their next JWT.
     */
    async "xsuaa:assignRoleCollection"({ role, user } = {}) {
      if (!host.isHosted) return { ok: false, error: "not available in desktop mode" };
      const rc = role || managerXsuaa.adminCollectionFor(targetXsuaaInstance());
      const cockpitHint = "assign the role in the BTP cockpit (subaccount > Security > Users)";
      // Who gets the role: the e-mail named on the upgrade screen. The default,
      // state.user, is the cf identity - after the stored management user
      // signed the manager in, that is the TECHNICAL account, which is why the
      // screen asks for a person explicitly (run #4 finding 3).
      const target = String(user || state.user || "").trim();
      if (!target) return { ok: false, error: `no user to assign the role to; ${cockpitHint}` };
      if (target.length > 256 || !/^[^\s@]+@[^\s@]+$/.test(target)) {
        return { ok: false, error: `"${target}" is not an e-mail address; ${cockpitHint}` };
      }
      // The btp CLI must be logged in NOW. A BTP login made before the last
      // restart is gone with the container; memory alone would lie.
      const btp = await probeBtpLogin();
      if (!btp.loggedIn) {
        return {
          ok: false,
          error: `no BTP login in this session (a BTP login made before the last restart is forgotten) - add it on Session & access, or ${cockpitHint}`,
          role: rc, user: target,
        };
      }
      // Subaccount GUID: from the BTP flow when it captured one, otherwise from
      // a throw-away service key of the manager's own XSUAA instance.
      let sub = state.subaccount;
      let subaccountSource = "btp-login";
      if (!sub) {
        const d = await deriveSubaccountGuidFromXsuaa();
        if (!d.ok) return { ok: false, error: `${d.error}; ${cockpitHint}`, role: rc, user: target };
        sub = d.guid;
        subaccountSource = "xsuaa-service-key";
      }

      send("xsuaa:upgradePhase", { phase: "assign-role", state: "running" });
      const args = ["assign", "security/role-collection", rc, "--to-user", target, "--subaccount", sub];
      const r = await run(resolveBtp(), args, { source: "btp" });
      // btp CLI returns 0 on a fresh assignment AND on a re-assignment (it
      // prints "already assigned" but exits 0). Treat any 0-exit as success.
      // If non-zero, capture both stdout (sometimes carries the error line)
      // and stderr so the UI has a meaningful message to display.
      if (r.code !== 0) {
        const detail = (r.stderr || r.stdout || "").trim().split(/\r?\n/).filter(Boolean).slice(-3).join(" / ");
        send("xsuaa:upgradePhase", { phase: "assign-role", state: "failed", error: detail || "btp assign failed" });
        return { ok: false, error: detail || "btp assign failed", role: rc, user: target, subaccount: sub, subaccountSource };
      }
      send("xsuaa:upgradePhase", { phase: "assign-role", state: "done" });
      return { ok: true, role: rc, user: target, subaccount: sub, subaccountSource };
    },

    /**
     * What the upgrade screen needs BEFORE "Start upgrade" (decision up
     * front, run #4 finding 2): is the btp CLI logged in right now, who is
     * the cf user, and is that user the stored technical account (then the
     * role must go to a person the operator names). The BTP answer is a live
     * probe; the stored-user answer comes from login:storedUserStatus (cached).
     */
    async "xsuaa:roleAssignmentPrecheck"() {
      if (!host.isHosted) return { ok: false, error: "not available in desktop mode" };
      const btp = await probeBtpLogin();
      let storedUsername = null;
      try {
        const st = await handlers["login:storedUserStatus"]();
        if (st && st.available && st.username) storedUsername = st.username;
      } catch { /* no binding or store unreachable: not a technical user then */ }
      const cfUser = state.user || null;
      const cfUserIsStoredUser =
        state.cfLoginKind === "stored-user" ||
        (!!storedUsername && !!cfUser && storedUsername.toLowerCase() === cfUser.toLowerCase());
      return {
        ok: true,
        btpLoggedIn: btp.loggedIn,
        cfUser,
        cfUserIsStoredUser,
        storedUsername,
        subaccountKnown: !!state.subaccount,
      };
    },

    /**
     * Build the cockpit URL the operator should click to self-assign to the
     * FigafManagerOperator role collection. Composed from data the wizard
     * already has via btp accounts subaccount list.
     */
    async "xsuaa:assignRoleCollectionPreflight"() {
      if (!host.isHosted) return { ok: false, error: "not available in desktop mode" };
      const gaGuid = state.globalAccountGuid;
      const sub = state.subaccount;
      if (!gaGuid || !sub) return { ok: false, error: "missing globalAccountGuid or subaccount" };
      // Trial vs productive cockpit base (see saml-connect.cockpitBaseFromLicense).
      // The cockpit deep-link fragment uses GUIDs for both GA and subaccount —
      // matching connect:trustConfigUrl. (The prior code used the GA subdomain
      // here, which is wrong for the #/globalaccount/<…>/ fragment.)
      const base = cockpitBaseFromLicense(state.licenseType);
      const url = `${base}#/globalaccount/${encodeURIComponent(gaGuid)}/subaccount/${encodeURIComponent(sub)}/users`;
      return { ok: true, url, roleCollection: managerXsuaa.adminCollectionFor(targetXsuaaInstance()) };
    },

    /**
     * Build the cockpit deep-link to the deployed app's CF space (Applications
     * page), shown on the Finish screens. Composed from the GA + subaccount
     * GUIDs the wizard already holds plus the org/space GUIDs resolved live via
     * the cf CLI. Read-only; works on desktop and cloud (no isHosted gate).
     *
     * Precondition: the cf CLI must already be targeted at state.org/state.space
     * (true on the Finish screens, which run right after `cf push`). `cf space
     * <name> --guid` resolves within the currently targeted org, so calling this
     * before the org/space target is set could return a GUID from the wrong org.
     */
    async "cf:cockpitUrl"() {
      const gaGuid = state.globalAccountGuid;
      const subGuid = state.subaccount;
      if (!gaGuid || !subGuid) return { ok: false, error: "missing globalAccountGuid or subaccount" };
      if (!state.org || !state.space) return { ok: false, error: "missing org or space target" };

      const GUID_RE = /^[0-9a-f-]{36}$/i;
      async function resolveGuid(kind, name) {
        const r = await run(resolveCf(), [kind, name, "--guid"], { source: "cf" });
        if (r.code !== 0) return null;
        const guid = r.stdout.trim().split(/\r?\n/).filter(Boolean).pop();
        return guid && GUID_RE.test(guid) ? guid : null;
      }

      const orgGuid = await resolveGuid("org", state.org);
      if (!orgGuid) return { ok: false, error: "could not resolve org GUID" };
      const spaceGuid = await resolveGuid("space", state.space);
      if (!spaceGuid) return { ok: false, error: "could not resolve space GUID" };
      const url = cockpitSpaceUrl({ licenseType: state.licenseType, gaGuid, subGuid, orgGuid, spaceGuid });
      if (!url) return { ok: false, error: "could not build cockpit URL" };
      return { ok: true, url };
    },

    /**
     * Multi-step teardown (§2.8). Fire-and-forget delete-self pattern: we
     * respond { ok: true } first, then run the teardown in a setImmediate.
     * By the time the operator's browser re-polls, the manager and its
     * approuter are both gone.
     */
    async "cf:uninstallManager"({ deleteRoleCollections } = {}) {
      if (!host.isHosted) return { ok: false, error: "not available in desktop mode" };
      // Schedule teardown after the current call frame so the RPC response
      // can flush back to the browser before any blocking work begins.
      // One XSUAA instance (decision 0009): the shared instance also holds the
      // apps' roles and every user assignment - it is unbound, never deleted.
      // Only the legacy manager-only instance goes away with the manager.
      const xsuaaInst = targetXsuaaInstance();
      const legacy = xsuaaInst === managerXsuaa.LEGACY_INSTANCE;
      setImmediate(async () => {
        const steps = [
          { name: "unbind-service approuter", args: ["unbind-service", "figaf-manager-approuter", xsuaaInst] },
          { name: "unbind-service manager",   args: ["unbind-service", "figaf-manager", xsuaaInst] },
          { name: "delete approuter",         args: ["delete", "figaf-manager-approuter", "-r", "-f"] },
          { name: "delete manager",           args: ["delete", "figaf-manager", "-r", "-f"] },
        ];
        if (legacy) steps.push({ name: "delete-service xsuaa", args: ["delete-service", xsuaaInst, "-f"] });
        // The manager's standing service key on the FAID database instance
        // (catalog v6, faid-database.js) goes with the manager; the role,
        // the schema and the entry stay for the backend.
        try {
          const st = await handlers["faid:databaseStatus"]();
          if (st && st.instanceName) steps.unshift({ name: "delete-service-key database", args: ["delete-service-key", st.instanceName, "figaf-manager", "-f"] });
        } catch (e) {
          log("teardown", "warn", `database key check skipped: ${e.message}`);
        }
        for (const step of steps) {
          log("teardown", "line", `Running: cf ${step.args.join(" ")}`);
          await run(resolveCf(), step.args, { source: "cf" }).catch((e) => {
            log("teardown", "err", `${step.name} failed: ${e.message}`);
          });
        }
        if (deleteRoleCollections) {
          const collections = legacy
            ? [managerXsuaa.LEGACY_OPERATOR_COLLECTION, managerXsuaa.LEGACY_ADMIN_COLLECTION]
            : [managerXsuaa.SHARED_OPERATOR_COLLECTION, managerXsuaa.SHARED_ADMIN_COLLECTION];
          for (const rc of collections) {
            const args = ["delete", "security/role-collection", rc, "--force"];
            if (state.subaccount) args.push("--subaccount", state.subaccount);
            await run(resolveBtp(), args, { source: "btp" }).catch(() => {});
          }
        }
        // We are about to be killed (the manager just delete'd itself).
        // Nothing else to do.
      });
      return { ok: true, message: "Uninstall in progress. Page will go offline in ~30s." };
    },

    // Update Figaf Tool (hosted-only) ─────────────────────────────────────────
    // See update-figaf-tool-plan.md. The flow detects an existing
    // <ID>-app / <ID>-router deployment, force-refreshes the GitHub deploy
    // templates, optionally updates the figaf-xsuaa service, and rolling-
    // pushes the two apps to the operator's chosen Docker tag. State is
    // persisted under <userDataDir>/figaf-tool-update/update-state.json
    // so a mid-flow dyno restart can pick up where it left off.

    async "update:resumeStatus"() {
      if (!host.isHosted) return { ok: false, error: "not available in desktop mode" };
      const s = readUpdateState();
      if (!s) return { ok: true, hasInFlight: false };
      const terminal = s.phase === "verified" || s.phase === "failed";
      return { ok: true, hasInFlight: !terminal, state: s };
    },

    async "update:clear"() {
      if (!host.isHosted) return { ok: false, error: "not available in desktop mode" };
      clearUpdateState();
      return { ok: true };
    },

    async "update:detectDeployment"({ deployId } = {}) {
      if (!host.isHosted) return { ok: false, error: "not available in desktop mode" };

      // Helper: read current image tag for a Docker app via the v3 droplets
      // endpoint. cf curl-only; cf app's text output is too brittle here.
      async function readImage(appName) {
        const g = await run(resolveCf(), ["app", "--guid", appName], { source: "cf" });
        if (g.code !== 0) return null;
        const guid = g.stdout.trim().split(/\r?\n/).filter(Boolean).pop();
        if (!guid) return null;
        const d = await run(resolveCf(), ["curl", `/v3/apps/${guid}/droplets/current`], { source: "cf" });
        if (d.code !== 0) return null;
        try {
          const parsed = JSON.parse(d.stdout);
          return parsed.image || null;
        } catch {
          return null;
        }
      }

      if (deployId) {
        const appName = `${deployId}-app`;
        const routerName = `${deployId}-router`;
        const a = await run(resolveCf(), ["app", appName], { source: "cf" });
        const r = await run(resolveCf(), ["app", routerName], { source: "cf" });
        const foundApp = a.code === 0;
        const foundRouter = r.code === 0;
        if (!foundApp && !foundRouter) {
          return { ok: true, found: false, deployId, app: null, router: null, candidates: [] };
        }
        const image = foundApp ? await readImage(appName) : null;
        return {
          ok: true,
          found: true,
          deployId,
          app:    foundApp    ? { name: appName,    image, exists: true }  : { name: appName,    image: null, exists: false },
          router: foundRouter ? { name: routerName, exists: true }          : { name: routerName, exists: false },
        };
      }

      // No deployId provided — try to enumerate candidates in the current
      // space. The space GUID is read via cf curl /v3/organizations/.../spaces
      // chains is too long; the simpler "cf app --guid" lookup is per-app, so
      // we list apps in the targeted space and post-filter by name regex plus
      // docker image prefix.
      const list = await run(resolveCf(), ["curl", "/v3/apps?per_page=500"], { source: "cf" });
      if (list.code !== 0) {
        return { ok: true, found: false, deployId: null, candidates: [], error: "cf curl /v3/apps failed" };
      }
      let resources = [];
      try { resources = (JSON.parse(list.stdout).resources) || []; } catch {}
      const byId = new Map();
      for (const app of resources) {
        const m = /^(.+)-(app|router)$/.exec(app.name || "");
        if (!m) continue;
        const id = m[1];
        const role = m[2];
        if (!byId.has(id)) byId.set(id, { id, app: null, router: null });
        byId.get(id)[role] = { name: app.name, guid: app.guid };
      }
      const candidates = [];
      for (const [id, pair] of byId) {
        if (!pair.app) continue;
        const image = await readImage(pair.app.name);
        if (!image || !/^figaf\/app:/i.test(image)) continue;
        candidates.push({ id, app: pair.app.name, router: pair.router ? pair.router.name : null, image });
      }
      return { ok: true, found: false, deployId: null, candidates };
    },

    // Read the LIVE <deployId>-app configuration so the Update form can default
    // to what is actually running, rather than the freshly-downloaded template
    // defaults (those silently rewrote memory/domain/location and tripped
    // `memory quota_exceeded`). Returns a `vars` object in the exact shape
    // config:writeVars consumes. On a partial read failure the affected fields
    // are simply omitted and partial=true is set, so the UI can warn and let
    // the template defaults stand in for the gaps.
    async "update:readCurrentConfig"({ deployId } = {}) {
      if (!host.isHosted) return { ok: false, error: "not available in desktop mode" };
      if (!deployId) return { ok: false, error: "deployId required" };
      const appName = `${deployId}-app`;
      const vars = {};
      let partial = false;

      const g = await run(resolveCf(), ["app", "--guid", appName], { source: "cf" });
      if (g.code !== 0) return { ok: true, vars: {}, partial: true };
      const guid = g.stdout.trim().split(/\r?\n/).filter(Boolean).pop();
      if (!guid) return { ok: true, vars: {}, partial: true };

      // CF stores env values as strings ("true"/"false"); coerce the two booleans.
      const toBool = (v) => v === true || v === "true";

      const e = await run(resolveCf(), ["curl", `/v3/apps/${guid}/environment_variables`], { source: "cf" });
      if (e.code === 0) {
        let env = {};
        try { env = (JSON.parse(e.stdout).var) || {}; } catch { partial = true; }
        if (env.LOCATION_ID != null) vars.locationId = env.LOCATION_ID;
        if (env.MAX_RAM_PERCENTAGE != null) vars.maxRamPercentage = String(env.MAX_RAM_PERCENTAGE);
        if (env.LOGS_TOTAL_SIZE_CAP != null) vars.logsTotalSizeCap = env.LOGS_TOTAL_SIZE_CAP;
        if (env.ENABLE_INSTANCE_MONITORING != null) vars.enableInstanceMonitoring = toBool(env.ENABLE_INSTANCE_MONITORING);
        if (env.USE_CLOUD_CONNECTOR_FOR_SMTP_INTEGRATION != null) vars.useCloudConnectorForSmtpIntegration = toBool(env.USE_CLOUD_CONNECTOR_FOR_SMTP_INTEGRATION);
        if (env.CLOUD_CONNECTOR_DESTINATION_NAME_FOR_SMTP_INTEGRATION != null) vars.cloudConnectorDestinationNameForSmtpIntegration = env.CLOUD_CONNECTOR_DESTINATION_NAME_FOR_SMTP_INTEGRATION;
        // LANDSCAPE_APPS_DOMAIN ← strip "https://<deployId>." off BTP_APP_ROUTER_URL.
        if (env.BTP_APP_ROUTER_URL) {
          const bare = String(env.BTP_APP_ROUTER_URL).replace(/^https?:\/\//, "");
          const prefix = `${deployId}.`;
          vars.domain = bare.startsWith(prefix) ? bare.slice(prefix.length) : bare;
        }
      } else {
        partial = true;
      }

      const p = await run(resolveCf(), ["curl", `/v3/apps/${guid}/processes/web`], { source: "cf" });
      if (p.code === 0) {
        try {
          const mem = JSON.parse(p.stdout).memory_in_mb;
          if (mem != null) vars.instanceMemory = `${mem}M`;
        } catch { partial = true; }
      } else {
        partial = true;
      }

      // Detect bound service instances: figaf-connectivity, figaf-destination,
      // and the DB service (anything that isn't a known non-DB service).
      const NON_DB_SERVICES = new Set(["figaf-xsuaa", "figaf-connectivity", "figaf-destination"]);
      const sb = await run(resolveCf(), ["curl", `/v3/service_credential_bindings?app_guids=${guid}&include=service_instance`], { source: "cf" });
      if (sb.code === 0) {
        try {
          const sbData = JSON.parse(sb.stdout);
          const instances = ((sbData.included || {}).service_instances) || [];
          const names = instances.map((i) => i.name);
          if (names.includes("figaf-connectivity")) vars.enableConnectivity = true;
          if (names.includes("figaf-destination")) vars.enableDestination = true;
          const dbCandidates = names.filter((n) => !NON_DB_SERVICES.has(n));
          if (dbCandidates.length === 1) {
            vars.dbServiceName = dbCandidates[0];
          } else {
            // Zero or multiple candidates — can't auto-select; let the UI warn.
            partial = true;
          }
        } catch { partial = true; }
      } else {
        partial = true;
      }

      return { ok: true, vars, partial };
    },

    async "update:begin"({ deployId, targetImageTag, strategy } = {}) {
      if (!host.isHosted) return { ok: false, error: "not available in desktop mode" };
      if (!deployId) return { ok: false, error: "deployId required" };
      send("update:phase", { phase: "refresh-templates", state: "running" });
      try {
        await resolveDeployDir({ force: true });
      } catch (e) {
        send("update:phase", { phase: "refresh-templates", state: "failed", error: e.message });
        return { ok: false, error: e.message };
      }
      writeUpdateState({
        deployId,
        targetImageTag: targetImageTag || null,
        strategy: strategy === "rolling" ? "rolling" : "recreate",
        phase: "starting",
        startedAt: new Date().toISOString(),
        lastError: null,
      });
      send("update:phase", { phase: "refresh-templates", state: "done" });
      return { ok: true };
    },

    // Rewrite vars.yml with the operator's chosen ID + Docker tag (and any
    // additional overrides). Reuses config:writeVars' mutation logic but
    // forces ID + DOCKER_IMAGE_VERSION from the Update flow inputs so the
    // operator can't accidentally drop them by leaving the advanced form
    // blank. Persists the chosen tag into update-state.json for downstream
    // hash-skip + verify steps.
    async "update:writeVars"({ deployId, dockerTag, vars } = {}) {
      if (!host.isHosted) return { ok: false, error: "not available in desktop mode" };
      if (!deployId) return { ok: false, error: "deployId required" };
      if (!dockerTag) return { ok: false, error: "dockerTag required" };
      const deployDir = await resolveDeployDir();
      const file = path.join(deployDir, "vars.yml");
      const merged = {
        ...(vars || {}),
        id: deployId,
        dockerVersion: dockerTag,
      };
      const r = await handlers["config:writeVars"](merged);
      if (!r.ok) return r;
      writeUpdateState({ deployId, targetImageTag: dockerTag, phase: "vars-written" });
      return { ok: true, path: file };
    },

    async "update:updateXsuaa"({ deployId, skip } = {}) {
      if (!host.isHosted) return { ok: false, error: "not available in desktop mode" };
      if (!deployId) return { ok: false, error: "deployId required" };
      const phase = "update-xsuaa";
      if (skip) {
        send("update:phase", { phase, state: "done", detail: "skipped by operator" });
        writeUpdateState({ phase: "xsuaa-updated", xsuaaSkipped: true });
        return { ok: true, skipped: true };
      }
      const deployDir = await resolveDeployDir();
      const xsPath = path.join(deployDir, "xs-security.json");
      if (!fs.existsSync(xsPath)) {
        send("update:phase", { phase, state: "failed", error: "xs-security.json missing" });
        return { ok: false, error: `xs-security.json not found at ${xsPath}` };
      }
      const hash = sha256OfFile(xsPath);
      const prev = readUpdateState() || {};
      // Plan D8: skip update-service when the refreshed template hashes
      // identically to the one we applied on a previous successful run.
      // First-run-after-deployment has no prior hash → always update.
      if (hash && prev["xs-security-hash"] === hash) {
        send("update:phase", { phase, state: "done", detail: "unchanged (hash match)" });
        writeUpdateState({ phase: "xsuaa-updated" });
        return { ok: true, skipped: true, reason: "hash-match" };
      }
      send("update:phase", { phase, state: "running" });
      const upd = await run(resolveCf(), ["update-service", "figaf-xsuaa", "-c", xsPath], { source: "cf" });
      if (upd.code !== 0) {
        const errText = upd.stderr || "update-service failed";
        send("update:phase", { phase, state: "failed", error: errText });
        writeUpdateState({ lastError: errText });
        return { ok: false, error: errText };
      }
      // Poll until the broker reports update succeeded/failed. 10-minute
      // timeout matches the cf:pollService shape; XSUAA updates are usually
      // sub-minute but the broker can be sluggish during landscape events.
      const start = Date.now();
      const timeoutMs = 10 * 60 * 1000;
      while (Date.now() - start < timeoutMs) {
        const s = await run(resolveCf(), ["service", "figaf-xsuaa"], { source: "cf" });
        const line = /status:\s+(.+)/i.exec(s.stdout)?.[1]?.trim() || "unknown";
        send("cf:serviceStatus", { name: "figaf-xsuaa", status: line });
        if (/update succeeded|create succeeded|succeeded/i.test(line)) {
          send("update:phase", { phase, state: "done" });
          writeUpdateState({ phase: "xsuaa-updated", "xs-security-hash": hash });
          return { ok: true, status: line };
        }
        if (/failed/i.test(line)) {
          send("update:phase", { phase, state: "failed", error: line });
          writeUpdateState({ lastError: line });
          return { ok: false, error: line };
        }
        await new Promise((r) => setTimeout(r, 5000));
      }
      send("update:phase", { phase, state: "failed", error: "timeout" });
      writeUpdateState({ lastError: "timeout polling figaf-xsuaa" });
      return { ok: false, error: "timeout polling figaf-xsuaa" };
    },

    // Recreate strategy: delete <deployId>-router and <deployId>-app before
    // pushing, so the org quota is freed *before* CF stages the new droplet.
    // An in-place `cf push` (even without --strategy rolling) stages the new
    // droplet while the old app still holds its memory — on a trial org that
    // overlap trips "organization's memory limit exceeded: staging requires
    // NNNNM". Deleting first is Figaf's recommended upgrade path: figaf-db
    // (and its data) and figaf-xsuaa are service instances untouched by the
    // delete, and the bindings + routes are recreated from manifest.yml on the
    // subsequent push. Router is deleted before app to match the docs' order.
    // No-op under the "rolling" strategy (old instances must keep serving).
    // `cf delete -f` exits 0 and prints "does not exist" when the app is
    // already gone, so this is idempotent on retry after a half-finished run.
    async "update:deleteApps"({ deployId, strategy } = {}) {
      if (!host.isHosted) return { ok: false, error: "not available in desktop mode" };
      if (!deployId) return { ok: false, error: "deployId required" };
      const phase = "delete-apps";
      const st = strategy || (readUpdateState() || {}).strategy || "recreate";
      if (st === "rolling") {
        send("update:phase", { phase, state: "done", detail: "skipped (rolling — in-place)" });
        return { ok: true, skipped: true };
      }
      send("update:phase", { phase, state: "running" });
      for (const role of ["router", "app"]) {
        const name = `${deployId}-${role}`;
        const r = await run(resolveCf(), ["delete", name, "-f"], { source: "cf" });
        if (r.code !== 0 && !/does not exist|not found/i.test(`${r.stdout}\n${r.stderr}`)) {
          const errText = r.stderr || `cf delete ${name} failed`;
          send("update:phase", { phase, state: "failed", error: errText });
          writeUpdateState({ lastError: errText, lastFailedPhase: phase });
          return { ok: false, error: errText };
        }
      }
      writeUpdateState({ phase: "apps-deleted" });
      send("update:phase", { phase, state: "done" });
      return { ok: true };
    },

    // Create the optional PI/PO services (figaf-connectivity / figaf-destination)
    // when the operator selected them. The update's config:writeVars only
    // *binds* these in manifest.yml via patchManifestService — the instances
    // themselves must exist before the push or CF fails the push with
    // "Service instance 'figaf-connectivity' not found". cf:createService treats
    // "already exists" as success, and we poll each to "create succeeded" so the
    // subsequent push binds against a ready instance. No-op (marked done) when
    // neither service is selected so the phase rail stays honest on plain
    // updates. Idempotent on retry: re-running just re-confirms the instances.
    async "update:createServices"({ deployId, vars } = {}) {
      if (!host.isHosted) return { ok: false, error: "not available in desktop mode" };
      const phase = "create-services";
      const targets = [];
      if (vars && vars.enableConnectivity) targets.push({ offering: "connectivity", name: "figaf-connectivity" });
      if (vars && vars.enableDestination)  targets.push({ offering: "destination",  name: "figaf-destination" });
      if (targets.length === 0) {
        send("update:phase", { phase, state: "done", detail: "no PI services selected" });
        return { ok: true, skipped: true };
      }
      send("update:phase", { phase, state: "running" });
      for (const t of targets) {
        const c = await handlers["cf:createService"]({ offering: t.offering, plan: "lite", name: t.name });
        if (!c.ok) {
          const errText = c.stderr || `cf create-service ${t.name} failed`;
          send("update:phase", { phase, state: "failed", error: errText });
          writeUpdateState({ lastError: errText, lastFailedPhase: phase });
          return { ok: false, error: errText };
        }
      }
      // Wait until every instance reports "create succeeded" — the lite plans
      // are usually instant, but the push must not race a still-provisioning
      // instance. cf:pollService emits cf:serviceStatus per tick.
      for (const t of targets) {
        const p = await handlers["cf:pollService"]({ name: t.name });
        if (!p.ok) {
          const errText = `${t.name} did not become active (${p.status})`;
          send("update:phase", { phase, state: "failed", error: errText });
          writeUpdateState({ lastError: errText, lastFailedPhase: phase });
          return { ok: false, error: errText };
        }
      }
      writeUpdateState({ phase: "services-created" });
      send("update:phase", { phase, state: "done", detail: targets.map((t) => t.name).join(", ") });
      return { ok: true, created: targets.map((t) => t.name) };
    },

    // Push <deployId>-<role>. The manifest names both apps (<id>-app via the
    // figaf-app block, <id>-router via the approuter block) using ((ID)) from
    // vars.yml, so a single -f manifest.yml + the already-rewritten vars.yml
    // suffices. Under "rolling" we add --strategy rolling (old instance keeps
    // serving until the new one is healthy, ~2x memory during overlap); under
    // "recreate" the app was already deleted by update:deleteApps so this is a
    // plain fresh push.
    async "update:pushApp"({ deployId, role, strategy } = {}) {
      if (!host.isHosted) return { ok: false, error: "not available in desktop mode" };
      if (!deployId) return { ok: false, error: "deployId required" };
      if (role !== "app" && role !== "router") return { ok: false, error: "role must be 'app' or 'router'" };
      const name = `${deployId}-${role}`;
      const phase = role === "app" ? "push-app" : "push-router";
      const deployDir = await resolveDeployDir();
      send("update:phase", { phase, state: "running" });
      // Fall back to the value persisted at update:begin so a resumed run keeps
      // the choice. Only "rolling" adds the flag; "recreate" (and any legacy
      // value) is a plain push.
      const st = strategy || (readUpdateState() || {}).strategy || "recreate";
      const args = ["push", name];
      if (st === "rolling") args.push("--strategy", "rolling");
      args.push("--vars-file", "vars.yml", "-f", "manifest.yml");
      const r = await run(resolveCf(), args, { source: "cf", cwd: deployDir });
      if (r.code !== 0) {
        const errText = r.stderr || `cf push ${name} failed`;
        send("update:phase", { phase, state: "failed", error: errText });
        writeUpdateState({ lastError: errText, lastFailedPhase: phase });
        return { ok: false, name, error: errText };
      }
      writeUpdateState({ phase: role === "app" ? "app-pushed" : "router-pushed" });
      send("update:phase", { phase, state: "done" });
      return { ok: true, name, strategy: st };
    },

    async "update:verify"({ deployId } = {}) {
      if (!host.isHosted) return { ok: false, error: "not available in desktop mode" };
      if (!deployId) return { ok: false, error: "deployId required" };
      const appName = `${deployId}-app`;
      const routerName = `${deployId}-router`;
      const phase = "verify";
      send("update:phase", { phase, state: "running" });

      const g = await run(resolveCf(), ["app", "--guid", appName], { source: "cf" });
      const guid = g.code === 0 ? g.stdout.trim().split(/\r?\n/).filter(Boolean).pop() : null;
      let appImage = null;
      if (guid) {
        const d = await run(resolveCf(), ["curl", `/v3/apps/${guid}/droplets/current`], { source: "cf" });
        if (d.code === 0) {
          try { appImage = (JSON.parse(d.stdout).image) || null; } catch {}
        }
      }

      const r = await run(resolveCf(), ["app", routerName], { source: "cf" });
      const routerHealthy = r.code === 0 && /running|started/i.test(r.stdout);
      // Public route comes from the router's "routes" line in cf app output.
      // The exact text varies across cf versions, so we match a broad URL
      // shape rather than a fragile header keyword.
      let route = null;
      const urlMatch = /(https?:\/\/[^\s,]+)/i.exec(r.stdout);
      if (urlMatch) route = urlMatch[1].replace(/^https?:\/\//, "");
      if (!route) {
        const lineMatch = /^routes:\s+(\S+)/im.exec(r.stdout);
        if (lineMatch) route = lineMatch[1];
      }

      const state = readUpdateState() || {};
      const targetTag = state.targetImageTag;
      const tagMatches = !targetTag || (appImage && appImage.endsWith(`:${targetTag}`));

      if (!appImage || !routerHealthy || !tagMatches) {
        const detail = !appImage ? "could not read app image"
          : !tagMatches ? `image tag mismatch (got ${appImage}, expected ${targetTag})`
          : "router not in running state";
        send("update:phase", { phase, state: "failed", error: detail });
        writeUpdateState({ lastError: detail });
        return { ok: false, appImage, routerHealth: routerHealthy ? "running" : "unhealthy", route, error: detail };
      }

      writeUpdateState({ phase: "verified", completedAt: new Date().toISOString(), lastError: null });
      send("update:phase", { phase, state: "done" });
      return { ok: true, appImage, routerHealth: "running", route };
    },

    // Self-update — version-discovery for the installer itself ────────────────
    // Detects whether a newer Figaf Installer release is published on the
    // GitHub repo configured via release-config.js. Fails open: any network
    // error, missing release, or unconfigured repo returns ok:false WITHOUT
    // blocking the wizard. The renderer banner is suppressed unless the
    // response says updateAvailable=true.
    //
    // The "host" field distinguishes which CTA the renderer should show
    // (download installer vs. self-redeploy) — the renderer never branches
    // on isHosted directly for this feature.
    async "update:checkSelf"() {
      const host_ = host.isHosted ? "cloud" : "desktop";
      const current = (host.getInstalledVersion && host.getInstalledVersion()) || "0.0.0";

      let data;
      try {
        data = await httpsJson(releaseConfig.RELEASE_LATEST_URL);
      } catch (e) {
        // No releases yet → GitHub 404 lands here. Banner stays hidden.
        return { ok: false, current, host: host_, error: e.message };
      }

      const tag = String(data?.tag_name || "").replace(/^v/, "");
      if (!tag) {
        return { ok: false, current, host: host_, error: "release missing tag_name" };
      }

      const assetList = Array.isArray(data.assets) ? data.assets : [];
      const cloudAsset   = assetList.find((a) => releaseConfig.CLOUD_ASSET_REGEX.test(a.name || ""));
      const desktopAsset = assetList.find((a) => releaseConfig.DESKTOP_ASSET_REGEX.test(a.name || ""));

      const updateAvailable = releaseConfig.compareSemver(current, tag) < 0;

      const result = {
        ok: true,
        host: host_,
        current,
        latest: tag,
        updateAvailable,
        releaseUrl: data.html_url || null,
        assets: {
          cloud:   cloudAsset   ? { name: cloudAsset.name,   url: cloudAsset.browser_download_url   } : null,
          desktop: desktopAsset ? { name: desktopAsset.name, url: desktopAsset.browser_download_url } : null,
        },
      };
      // Cache the asset URLs so update:downloadSelf can validate the URL it's
      // told to fetch against what GitHub actually published in this version's
      // release. The renderer cannot be trusted to pass an arbitrary URL.
      state.lastCheckSelf = result;
      return result;
    },

    // Pre-flight for self-redeploy. Read-only: runs `cf api` + `cf target`,
    // parses, and compares against the manager's OWN CF coordinates from
    // VCAP_APPLICATION. Used by <UpdatePreflightModal/> to decide whether
    // to show "Update now" (clean) or drive the operator through a cf-cli
    // re-target / re-login sub-flow first.
    //
    // Returns four shapes:
    //   { ok: false, error: "not available in desktop mode" }          desktop
    //   { ok: false, error: "VCAP_APPLICATION missing" }               dev/non-CF runtime
    //   { ok: true,  loggedIn: false, target, current: {...}, mismatch:{...} } not logged in
    //   { ok: true,  loggedIn: true,  target, current: {...}, mismatch:{...} } logged in
    //
    // `mismatch` is { apiUrl: bool, org: bool, space: bool } — true means
    // the current cf-cli target does NOT match the manager's own location.
    async "update:selfTarget"() {
      if (!host.isHosted || !host.getDeployTargetForSelf) {
        return { ok: false, error: "not available in desktop mode" };
      }
      const target = host.getDeployTargetForSelf();
      if (!target) {
        return { ok: false, error: "VCAP_APPLICATION missing — not running in CF?" };
      }

      const cfBin = resolveCf();
      const apiOut    = await run(cfBin, ["api"],    { source: "cf" });
      const targetOut = await run(cfBin, ["target"], { source: "cf" });

      // `cf target` exits non-zero when logged out; stdout+stderr both carry
      // information depending on cf-cli version. Concatenate for the parser.
      const apiText    = (apiOut.stdout    || "") + "\n" + (apiOut.stderr    || "");
      const targetText = (targetOut.stdout || "") + "\n" + (targetOut.stderr || "");

      const api     = parseCfApi(apiText);
      const current = parseCfTarget(targetText);

      // Prefer `cf api`'s endpoint (stable across logged-in/out); fall back
      // to `cf target` parse if the user has only ever run `cf target`.
      const currentApiUrl = api.apiUrl || current.apiUrl || null;

      const apiUrlMatch = !!currentApiUrl
        && normalizeApiUrl(currentApiUrl) === normalizeApiUrl(target.apiUrl);
      const orgMatch    = current.loggedIn && current.orgName   === target.orgName;
      const spaceMatch  = current.loggedIn && current.spaceName === target.spaceName;

      return {
        ok: true,
        loggedIn: current.loggedIn,
        target: {
          apiUrl:    target.apiUrl,
          orgName:   target.orgName,
          spaceName: target.spaceName,
          appName:   target.appName,
        },
        current: {
          apiUrl:    currentApiUrl,
          orgName:   current.loggedIn ? current.orgName   : null,
          spaceName: current.loggedIn ? current.spaceName : null,
          user:      current.loggedIn ? current.user      : null,
        },
        mismatch: {
          apiUrl: !apiUrlMatch,
          org:    !orgMatch,
          space:  !spaceMatch,
        },
      };
    },

    // Self-update: download the new manager zip. URL must match what the
    // most recent update:checkSelf saw on GitHub — this is the only seam
    // where a renderer-supplied URL is honoured, so it is hard-pinned.
    async "update:downloadSelf"({ assetUrl } = {}) {
      if (!host.isHosted) return { ok: false, error: "not available in desktop mode" };
      if (!assetUrl) return { ok: false, error: "assetUrl required" };

      const last = state.lastCheckSelf;
      if (!last || !last.assets || !last.assets.cloud || last.assets.cloud.url !== assetUrl) {
        return { ok: false, error: "assetUrl does not match latest update:checkSelf — re-run check first" };
      }

      const stagingDir = host.getUpdateStagingDir();
      try {
        fs.mkdirSync(stagingDir, { recursive: true });
      } catch (e) {
        return { ok: false, error: "could not create staging dir: " + e.message };
      }
      const zipPath = path.join(stagingDir, last.assets.cloud.name);

      send("update:selfPhase", { phase: "download", state: "running", percent: 0 });
      try {
        await httpsDownload(assetUrl, zipPath, (got, total) => {
          const percent = total ? Math.round((got / total) * 100) : 0;
          send("update:selfPhase", { phase: "download", state: "running", percent });
        });
        send("update:selfPhase", { phase: "download", state: "done", percent: 100 });
        return { ok: true, zipPath, version: last.latest };
      } catch (e) {
        send("update:selfPhase", { phase: "download", state: "failed", error: e.message });
        return { ok: false, error: e.message };
      }
    },

    // Self-update: extract the downloaded zip, sanity-check layout, detect
    // whether the v2 manager-approuter tarball is present so the caller knows
    // whether to also redeploy the approuter (PR 4).
    async "update:extractSelf"({ zipPath } = {}) {
      if (!host.isHosted) return { ok: false, error: "not available in desktop mode" };
      if (!zipPath || !fs.existsSync(zipPath)) return { ok: false, error: "zipPath missing or not found" };

      const stagingDir = host.getUpdateStagingDir();
      const extractedDir = path.join(stagingDir, "extracted");

      send("update:selfPhase", { phase: "extract", state: "running" });
      try {
        try { fs.rmSync(extractedDir, { recursive: true, force: true }); } catch {}
        await extractZip(zipPath, extractedDir);
      } catch (e) {
        send("update:selfPhase", { phase: "extract", state: "failed", error: e.message });
        return { ok: false, error: e.message };
      }

      // Sanity-check: build-zip.js stages manifest.yml + package.json + cloud/
      // at the zip root. Anything else is a malformed (or wrong) archive.
      const mustExist = ["manifest.yml", "package.json", "cloud"];
      const missing = mustExist.filter((n) => !fs.existsSync(path.join(extractedDir, n)));
      if (missing.length) {
        const err = "zip layout unexpected — missing at root: " + missing.join(", ");
        send("update:selfPhase", { phase: "extract", state: "failed", error: err });
        return { ok: false, error: err };
      }

      const apprtTar = path.join(extractedDir, "manager-approuter.tar.gz");
      const hasApprouterTarball = fs.existsSync(apprtTar);

      send("update:selfPhase", {
        phase: "extract", state: "done",
        detail: hasApprouterTarball ? "approuter tarball present" : "no approuter tarball",
      });
      return { ok: true, extractedDir, hasApprouterTarball };
    },

    // Self-update: redeploy the manager from extractedDir. Re-runs the
    // pre-flight as a fresh safety check (the renderer's preflight result
    // may be stale by the time the user clicks Update). Force-targets the
    // manager's own org/space as defense in depth, then fires `cf push`
    // fire-and-forget — the dyno will bounce during the rolling cutover.
    //
    // includeApprouter is plumbed for PR 4; for PR 3 it is logged and
    // ignored (the call still succeeds, but the approuter is not touched).
    async "update:pushSelf"({ extractedDir, includeApprouter } = {}) {
      if (!host.isHosted) return { ok: false, error: "not available in desktop mode" };
      if (!extractedDir || !fs.existsSync(extractedDir)) {
        return { ok: false, error: "extractedDir missing or not found" };
      }

      send("update:selfPhase", { phase: "preflight", state: "running" });
      const pf = await handlers["update:selfTarget"]();
      if (!pf.ok) {
        send("update:selfPhase", { phase: "preflight", state: "failed", error: pf.error });
        return pf;
      }
      if (!pf.loggedIn || pf.mismatch.apiUrl || pf.mismatch.org || pf.mismatch.space) {
        const err = "preflight failed — cf CLI must be targeted at the manager's own landscape/org/space";
        send("update:selfPhase", { phase: "preflight", state: "failed", error: err });
        return { ok: false, error: err, preflight: pf };
      }

      const target = pf.target;
      const cfBin = resolveCf();

      const t = await run(cfBin, ["target", "-o", target.orgName, "-s", target.spaceName], { source: "cf" });
      if (t.code !== 0) {
        send("update:selfPhase", { phase: "preflight", state: "failed", error: t.stderr || "cf target failed" });
        return { ok: false, error: "cf target failed: " + (t.stderr || "(no stderr)") };
      }
      send("update:selfPhase", { phase: "preflight", state: "done" });

      // Approuter co-redeploy (PR 4) ─────────────────────────────────────────
      // If the operator has the v2 XSUAA approuter deployed, redeploy it
      // FIRST then the manager. Push order matters: approuter fronts the
      // public route, manager sits behind on -internal. Pushing approuter
      // first means the intermediate state is "new approuter → old manager"
      // (xs-app.json contract is backwards-compat across minor versions),
      // never "new manager → old approuter" (which would 404 new endpoints).
      //
      // The approuter push is AWAITED (not fire-and-forget): the manager
      // dyno running this orchestrator is unaffected, so we can wait. If
      // the approuter push fails we abort BEFORE bouncing the manager —
      // operator keeps a working system to retry from.
      if (includeApprouter) {
        const approuterPresent = await probeApprouterPresence();
        if (!approuterPresent) {
          // Bundle had the tarball but the live space has no approuter app —
          // probably the operator never ran the v2 XSUAA upgrade. Skip cleanly.
          log("cf", "warn", "approuter tarball bundled but figaf-manager-approuter not deployed in this space — skipping approuter step");
        } else {
          const approuterDir = path.join(extractedDir, "manager-approuter");
          send("update:selfPhase", { phase: "push-approuter", state: "running", detail: "extracting tarball" });
          try {
            fs.mkdirSync(approuterDir, { recursive: true });
            // Spawn tar with cwd=extractedDir and relative paths: GNU tar on
            // Windows mis-parses absolute paths with a colon ("C:/…") as
            // remote host:path. --force-local is a no-op on Linux, a fix
            // on Windows, and using cwd-relative paths sidesteps the parser
            // entirely. The on-CF Linux dyno is fine with either form.
            const tarRes = await run(
              "tar",
              ["--force-local", "-xzf", "manager-approuter.tar.gz", "-C", "manager-approuter"],
              { source: "cf", cwd: extractedDir }
            );
            if (tarRes.code !== 0) throw new Error(tarRes.stderr || "tar -xzf failed");
          } catch (e) {
            const err = "approuter tarball extract failed: " + e.message;
            send("update:selfPhase", { phase: "push-approuter", state: "failed", error: err });
            return { ok: false, error: err };
          }

          // Push the approuter. --no-manifest because the approuter package
          // ships no manifest — its routes, env vars (destinations), and
          // service bindings (figaf-manager-xsuaa) are already attached to
          // the live app and persist across cf push. --strategy rolling for
          // zero-downtime cutover. We await this; if it fails, we abort.
          // Stack: the one the manager runs on (CF_STACK; cf-stack.js), so a
          // manager moved to a new stack takes its approuter along.
          const apprtPushArgs = [
            "push", "figaf-manager-approuter",
            "-p", approuterDir,
            "--strategy", "rolling",
            ...stackArgs(ownStack()),
            "--no-manifest",
          ];
          send("update:selfPhase", { phase: "push-approuter", state: "running", detail: "cf push (rolling)" });
          log("cmd", "cmd", `${cfBin} ${apprtPushArgs.join(" ")}`);
          const apprtRes = await run(cfBin, apprtPushArgs, { source: "cf" });
          if (apprtRes.code !== 0) {
            const err = "approuter rolling push failed: " + (apprtRes.stderr || "(no stderr)");
            send("update:selfPhase", { phase: "push-approuter", state: "failed", error: err });
            return { ok: false, error: err };
          }
          send("update:selfPhase", { phase: "push-approuter", state: "done" });
        }
      }

      // Patch the bundled manifest's `name:` to match the operator's actual
      // app name (could differ from the literal `figaf-manager` baked into
      // the zip if the deployment was renamed). Write the patched copy to
      // the staging dir so the extracted tree stays pristine.
      const manifestSrc = path.join(extractedDir, "manifest.yml");
      let manifestPath = manifestSrc;
      try {
        const yaml = fs.readFileSync(manifestSrc, "utf8");
        const patched = patchManifestName(yaml, target.appName);
        if (patched !== yaml) {
          manifestPath = path.join(host.getUpdateStagingDir(), "manifest-patched.yml");
          fs.writeFileSync(manifestPath, patched);
          log("cf", "line", `manifest name rewritten: figaf-manager → ${target.appName} (${manifestPath})`);
        }
      } catch (e) {
        send("update:selfPhase", { phase: "push-manager", state: "failed", error: "manifest patch failed: " + e.message });
        return { ok: false, error: "manifest patch failed: " + e.message };
      }

      // Fire-and-forget cf push with -f <patchedManifest>: applies all
      // manifest values from v Next (new env vars, memory bumps, command,
      // buildpack) so the operator gets the version's intended runtime.
      // Trade-off: a manual `cf scale -m` override the operator did between
      // deploys WILL be reset to whatever the manifest declares. For a wizard
      // app this is the right default; operators aren't expected to hand-tune.
      // --strategy rolling = zero-downtime cutover.
      const pushArgs = ["push", target.appName, "-f", manifestPath, "-p", extractedDir, "--strategy", "rolling"];
      send("update:selfPhase", { phase: "push-manager", state: "running" });
      log("cmd", "cmd", `${cfBin} ${pushArgs.join(" ")}`);
      const pushAudit = auditor.beginCli({ cmd: cfBin, args: pushArgs, user: state.user });
      let pushStdout = "", pushStderr = "";
      const proc = spawn(cfBin, pushArgs, { shell: false, windowsHide: true, detached: false, env: cliEnv() });
      proc.stdout.on("data", (b) => { const s = b.toString(); pushStdout += s; log("cf", "line", s); });
      proc.stderr.on("data", (b) => { const s = b.toString(); pushStderr += s; log("cf", "err", s); });
      proc.on("error", (err) => {
        log("cf", "err", "cf push spawn failed: " + (err && err.message));
        pushAudit.exit({ code: -1, stdout: pushStdout, stderr: pushStderr, errorMessage: err && err.message });
      });
      proc.on("close", (code) => {
        pushAudit.exit({ code: code ?? 0, stdout: pushStdout, stderr: pushStderr });
      });

      return {
        ok: true,
        kickedOff: true,
        appName: target.appName,
        expectedRoute: (target.uris && target.uris[0]) || null,
        etaSec: 180,
      };
    },

    // shell ───────────────────────────────────────────────────────────────────
    // In hosted mode these are implemented client-side in cloud/client.js via
    // window.open / navigator.clipboard — the server handlers are never invoked.

    async "shell:openPasscodeUrl"({ landscape }) {
      const lp = landscape || state.landscape;
      if (!lp) return { ok: false, error: "No landscape yet" };
      const url = `https://login.${lp.replace(/^cf-/, "cf.")}.hana.ondemand.com/passcode`;
      await host.openExternal(url);
      return { ok: true, url };
    },

    async "shell:openExternal"({ url }) {
      await host.openExternal(url);
      return { ok: true };
    },

    async "shell:readClipboard"() {
      try {
        return { ok: true, text: (await host.readClipboard()) || "" };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    },

    async "shell:writeClipboard"({ text } = {}) {
      if (typeof text !== "string") return { ok: false, error: "text must be a string" };
      try {
        const r = await host.writeClipboard(text);
        // host may return undefined for a successful write
        return r && typeof r === "object" ? r : { ok: true };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    },
  };

  function dispose() {
    if (state.cfLoginProc && !state.cfLoginProc.killed) {
      try { state.cfLoginProc.kill(); } catch {}
    }
    if (state.btpLoginProc && !state.btpLoginProc.killed) {
      try { state.btpLoginProc.kill(); } catch {}
    }
  }

  return { handlers, dispose };
}

module.exports = { createOrchestrator, DEPLOYMENT_ZIP_URL };
