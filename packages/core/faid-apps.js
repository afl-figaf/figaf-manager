"use strict";
// FAID Apps manager — catalog-driven install / update / disable / enable /
// remove / configure / health for FAID Apps.
//
// Architecture:
//   - Releases come from a RELEASE STORE (release-store.js; figaf-faid
//     decision 0010): the artifact store behind FIGAF_FAID_RELEASE_URL, or a
//     local directory for development. host.resolveFaidReleaseSource() names
//     the one source. A RELEASE is catalog.json plus one zip per CF app,
//     downloaded on demand and verified against its checksums.
//   - ONE VERSION PER INSTALLATION: the installed version is what the shared
//     backend reports (FIGAF_APP_VERSION). Install deploys an app at that
//     version (latest on an empty space); Update moves the whole installation
//     — shared backend first, then every installed frontend — to a chosen
//     higher version. Never downwards (rollback is decommissioned).
//   - Catalog v2 (release 0.3.0+): a `platform` block holds the SHARED
//     BACKEND CONNECTOR's CF apps; each catalog "app" holds only its
//     frontend(s). Install/update deploy the platform FIRST, then the app —
//     the new connector must serve old frontends during that window
//     (decision 0005's backward-compatibility gate). Disable/enable/remove
//     touch only the app's own CF apps; the platform stays for the others.
//     A catalog WITHOUT a platform block keeps the v1 behavior.
//   - Artifacts may carry a sha256; the zip is verified before extraction.
//   - Catalog v7 (figaf-faid decision 0018): the manager OWNS the base service
//     instances (base-services.js: names, plans, who binds them). A CF app
//     says only what it REQUIRES, by kind: `requires: { xsuaa: "binding",
//     database: "own-role" }` and `optional: ["pipo"]`. Bindings go to the
//     module's instances (required ones must exist; optional groups are
//     bound only when their instances exist). A catalog that still names
//     instances (`services`, v6 or older) is refused by the release store.
//   - The manager stamps FIGAF_APP_VERSION on every CF app it deploys and
//     reads it back for the status view.
//   - Config values (Figaf/SAP connection settings) are applied via
//     `cf set-env` with the value masked in the terminal stream and in the
//     audit log — secret values must never appear in either.
//
// Handlers are created by createFaidHandlers(ctx) and spread into the
// orchestrator's handlers map. ctx carries the orchestrator's own helpers so
// this module spawns nothing on its own (tests inject a fake `run`).

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { loadCatalog, chooseVersion, createReleaseStore, requiredFigafScopes } = require("./release-store");
const { stackArgs, parseStackNames, wantedStacks, missingStacks, missingStackError } = require("./cf-stack");
// The backend's own database role (`requires.database: "own-role"`): the only
// module that talks to PostgreSQL. docs/shared-database-plan.md.
const faidDatabase = require("./faid-database");
// The base service instances are the manager's own (catalog v7).
const baseServices = require("./base-services");
const { requirementsOf, bindingsFor, requiresOwnRole, ownRoleService, wantedService, resolveNames } = baseServices;

const VERSION_ENV = "FIGAF_APP_VERSION";
const NO_SOURCE_ERROR = "No release source configured: set FIGAF_FAID_RELEASE_URL (the release store) or FIGAF_FAID_ARTIFACTS_DIR (a local release directory)";
// How long the installed platform version is remembered between the cf calls
// of one page load (catalog, status and services are asked together).
const INSTALLED_MEMO_MS = 5_000;
// Landscape-independent releases (decision 0008, figaf-faid repo): a service
// config file in the release (xs-security.json) may carry this placeholder in
// its redirect URI; provisionServices fills it with the cfapps domain of the
// landscape we are logged into. No landscape is ever hard-coded in a release.
const APPS_DOMAIN_PLACEHOLDER = "__CF_APPS_DOMAIN__";
const MAX_ENV_VALUE_LEN = 4096;
// One XSUAA instance for the manager and the apps (decision 0009): the
// manager part of xs-security is merged into the release part whenever the
// instance is created or updated.
const managerXsuaa = require("./manager-xsuaa");

// ─── one lifecycle action at a time (process-wide) ──────────────────────────
// Why: the console's "busy" state lives in ONE browser page. A reload, a
// second tab or a second session sees nothing running, and a fresh install
// keeps the CF app in state STOPPED for the whole staging time (`cf push
// --no-start` + `cf start`) — so the page invites a second click. Live on
// 2026-09-04: Install was pressed again while the shared backend was staging;
// the second push uploaded a new package, Cloud Foundry dropped the running
// build, and the install never finished. Module scope = one lock for every
// session in this container (one instance runs the manager).
const ACTION_STALE_MS = 30 * 60_000;
let currentAction = null; // { action, appId, startedAt } | null

/**
 * The lifecycle action running now, or null. An entry older than
 * ACTION_STALE_MS is treated as gone, so a lost release can never block the
 * console for good (the normal release is a `finally`).
 */
function runningAction(now) {
  if (!currentAction) return null;
  const t = typeof now === "number" ? now : Date.now();
  if (t - currentAction.startedAt > ACTION_STALE_MS) {
    currentAction = null;
    return null;
  }
  return { ...currentAction };
}

/** Test seam: forget the in-flight action. */
function resetRunningAction() {
  currentAction = null;
}

/** How long ago, in words, for the refusal message. */
function agoText(ms) {
  const secs = Math.max(0, Math.round(ms / 1000));
  return secs < 90 ? `${secs} s` : `${Math.round(secs / 60)} min`;
}

// ─── pure helpers (unit-tested in faid-apps.test.js) ──────────────────────────

// loadCatalog lives in release-store.js (re-exported below for the tests).

/**
 * Map `cf service <name>` output to one status word.
 * exitCode != 0 → "missing"; otherwise from the `status:` line.
 */
function serviceStatusFromCf(exitCode, stdout) {
  if (exitCode !== 0) return "missing";
  const m = /^\s*status:\s*(.+)$/im.exec(stdout || "");
  const op = m ? m[1].trim().toLowerCase() : "";
  if (/succeeded/.test(op)) return "ready";
  if (/in progress/.test(op)) return "in-progress";
  if (/failed/.test(op)) return "failed";
  return "unknown";
}

/**
 * The base services a release needs (catalog v7): the module's list filtered
 * by what the release's CF apps require. The release store has validated the
 * catalog, so a refusal here is a programming error, reported as one.
 * Returns { ok, services, requirements } or { ok:false, error }.
 */
function releaseServices(catalog) {
  const req = requirementsOf(catalog);
  if (!req.ok) return { ok: false, error: `release catalog: ${req.error}`, services: [], requirements: null };
  return { ok: true, services: req.services, requirements: req };
}

/**
 * Which PostgreSQL instance of the space is the backend's database when no
 * entry names one yet (between Setup step 1 and the prepare in step 3, and as
 * the prefill of step 1). `candidates` = the `cf services` rows of the same
 * offering. Rules, in order: exactly one instance; one with the default name;
 * one bound to a `<id>-app` (the Figaf Tool's pattern); else the default name.
 */
function chooseDatabaseInstance(defaultName, candidates) {
  const list = Array.isArray(candidates) ? candidates : [];
  if (list.length === 1) return { name: list[0].name, source: "space" };
  if (list.some((c) => c.name === defaultName)) return { name: defaultName, source: "space" };
  const tool = list.find((c) => (c.boundApps || []).some((a) => /-app$/.test(a)));
  if (tool) return { name: tool.name, source: "space" };
  return { name: defaultName, source: "default" };
}

/**
 * The shared backend connector (catalog key `platform`) as a pseudo-app, so
 * the deploy machinery treats it exactly like an app's CF apps. Null on v1
 * catalogs. UI name: "Shared backend" (decision 0009 naming).
 */
function platformPseudoApp(catalog) {
  const p = catalog && catalog.platform;
  if (!p || !Array.isArray(p.cfApps) || p.cfApps.length === 0) return null;
  return {
    id: "platform",
    name: p.name || "Shared backend (connector)",
    version: catalog.releaseVersion || catalog.channelVersion || "unknown",
    cfApps: p.cfApps,
  };
}

/**
 * Roll the per-CF-app states up to one app-level status.
 * parts: [{ exists: bool, state: "STARTED"|"STOPPED"|null, staging?: bool }]
 */
function computeAppStatus(parts) {
  const existing = parts.filter((p) => p.exists);
  if (existing.length === 0) return "not-installed";
  // A part with a build in STAGING is being deployed right now. It must not
  // read as "stopped": between `cf push --no-start` and the end of staging a
  // fresh app IS stopped, and that state made an operator install twice
  // (2026-09-04). "installing" wins over every other rollup.
  if (existing.some((p) => p.staging)) return "installing";
  if (existing.length < parts.length) return "partial";
  if (existing.every((p) => p.state === "STARTED")) return "running";
  if (existing.every((p) => p.state === "STOPPED")) return "stopped";
  return "mixed";
}

/** approuter `destinations` env value pointing a frontend at its backend. */
function buildDestinationsEnv(destinationName, url) {
  return JSON.stringify([{ name: destinationName, url, forwardAuthToken: true }]);
}

/**
 * What a failed CLI call said, for the operator: the last (up to `lines`)
 * non-empty stderr lines; when stderr is empty, the last stdout line that is
 * not the bare "FAILED" marker; when both are empty, the spawn error.
 * Trimmed to `maxLen` characters. Never throws.
 */
function cliFailureDetail(r, { lines = 3, maxLen = 400 } = {}) {
  const pick = (text) => String(text || "").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && l !== "FAILED");
  let tail = pick(r && r.stderr).slice(-lines);
  if (!tail.length) tail = pick(r && r.stdout).slice(-1);
  if (!tail.length && r && r.error) tail = [String(r.error)];
  return tail.join(" | ").slice(0, maxLen);
}

/**
 * cf push argument list for one catalog cfApp.
 *
 * `--no-manifest` is mandatory. Without it the cf CLI applies any manifest.yml
 * it finds in ITS working directory — and inside the CF container that is the
 * manager's OWN /home/vcap/app/manifest.yml. That file is present whenever the
 * manager was deployed through the BTP cockpit upload (the customer path):
 * `cf push` strips manifest.yml from what it uploads, the cockpit does not.
 * The manager's manifest then becomes the base of the FAID app push (its
 * buildpack, command, random-route, env) and CAPI rejects the mix:
 * "Buildpack and Buildpacks fields cannot be used together" — found live on
 * 2026-09-03, install of release 0.4.0. An FAID app is described ONLY by the
 * release catalog; no manifest is ever part of its push.
 */
function buildPushArgs(cfApp, dir, { noStart } = {}) {
  const args = ["push", cfApp.name, "-p", dir, "--no-manifest"];
  if (cfApp.buildpack) args.push("-b", cfApp.buildpack);
  // The stack the release names (figaf-faid decision 0015); none = the
  // landscape's default stack, as older catalogs expect. preflight() has
  // checked that the landscape offers it.
  args.push(...stackArgs(cfApp.stack));
  if (cfApp.memory) args.push("-m", cfApp.memory);
  if (cfApp.disk) args.push("-k", cfApp.disk);
  if (noStart) args.push("--no-start");
  return args;
}

/**
 * Whitelist-validate the env object a renderer sends to faid:configure.
 * Only keys declared in the catalog app's configForm are accepted — the RPC
 * channel must not be usable to set arbitrary env vars on arbitrary apps.
 * Empty values are skipped (meaning: leave unchanged).
 */
function validateConfigEnv(app, env) {
  if (!env || typeof env !== "object" || Array.isArray(env)) {
    return { ok: false, error: "env must be an object" };
  }
  const form = new Map((app.configForm || []).map((f) => [f.key, f]));
  const entries = [];
  for (const [key, value] of Object.entries(env)) {
    const field = form.get(key);
    if (!field) return { ok: false, error: `key '${key}' is not in this app's configForm` };
    if (value == null || value === "") continue;
    if (typeof value !== "string") return { ok: false, error: `value of '${key}' must be a string` };
    if (value.length > MAX_ENV_VALUE_LEN) return { ok: false, error: `value of '${key}' is too long` };
    entries.push({ key, value, secret: !!field.secret });
  }
  return { ok: true, entries };
}

// ─── handler factory ─────────────────────────────────────────────────────────

/**
 * @param {object} ctx
 * @param {object} ctx.host        HostAdapter (needs resolveFaidReleaseSource + getUserDataDir)
 * @param {Function} ctx.run       orchestrator subprocess helper
 * @param {Function} ctx.log       cli:line logger (source, type, text)
 * @param {Function} ctx.send      event emitter to the renderer
 * @param {Function} ctx.resolveCf () => cf binary path
 * @param {Function} ctx.extractZip (zipPath, destDir) => Promise
 * @param {Function} ctx.httpsText (url) => Promise<string>
 * @param {Function} ctx.httpsJson (url) => Promise<object>            release store reads
 * @param {Function} ctx.httpsDownload (url, destPath) => Promise      release store downloads
 */
function createFaidHandlers(ctx) {
  const { host, run, log, send, resolveCf, extractZip, httpsText } = ctx;
  // The backend's own database role (tests inject a fake).
  const database = ctx.database || faidDatabase.createFaidDatabase({ run: (...a) => run(...a), log, resolveCf: () => resolveCf() });

  // ─── the release store ────────────────────────────────────────────────────
  let storeInst = null;
  let storeKey = null;
  function releaseSource() {
    if (typeof host.resolveFaidReleaseSource === "function") return host.resolveFaidReleaseSource();
    // Older host adapters: a directory is a local source.
    if (typeof host.resolveFaidArtifactsDir === "function") {
      const dir = host.resolveFaidArtifactsDir();
      return dir ? { kind: "local", dir } : null;
    }
    return null;
  }
  /** The store of the configured source, created once per source. null = none configured. */
  function store() {
    const src = releaseSource();
    if (!src) return null;
    const key = JSON.stringify(src);
    if (!storeInst || storeKey !== key) {
      storeInst = createReleaseStore({ source: src, fetchJson: ctx.httpsJson, download: ctx.httpsDownload, log });
      storeKey = key;
    }
    return storeInst;
  }

  // The installed platform: does the shared backend CF app named by the
  // catalog exist (`exists`), and which FIGAF_APP_VERSION does it carry
  // (`version`, null when not deployed or not stamped). Two cf calls,
  // remembered for INSTALLED_MEMO_MS; forgotten after every action. Both
  // facts come from the same probe, so `faid:services` (backendDeployed) and
  // the Release panel (installed) never disagree.
  let installedMemo = null; // { at, name, value, exists }
  async function installedPlatformState(catalog) {
    const platform = platformPseudoApp(catalog);
    if (!platform) return { version: null, exists: null };
    const name = platform.cfApps[0].name;
    if (installedMemo && installedMemo.name === name && Date.now() - installedMemo.at < INSTALLED_MEMO_MS) {
      return { version: installedMemo.value, exists: installedMemo.exists };
    }
    // `silent`: a backend that is not deployed yet is a normal state, not an
    // error; its "App not found" must not become a red line in the drawer
    // (the Release panel shows the result: installed "—").
    let value = null;
    const g = await run(resolveCf(), ["app", name, "--guid"], { source: "cf", quiet: true, silent: true });
    const guid = g.code === 0 ? (g.stdout || "").trim().split(/\r?\n/).filter(Boolean).pop() : null;
    // "not found" is the normal empty-space answer. Anything else (an expired
    // login, a timeout) leaves the installed version UNKNOWN: the page then
    // shows the latest release instead of the installed one. Say so in the
    // drawer, once per memo window, instead of silently showing the wrong catalog.
    if (g.code !== 0 && !/not found/i.test(`${g.stdout || ""}\n${g.stderr || ""}`)) {
      log("cf", "warn", `cf app ${name} --guid failed (${cfTail(g)}) — the installed version is unknown for the next ${Math.round(INSTALLED_MEMO_MS / 1000)} s, so the page shows the latest release`);
    }
    if (guid) {
      const e = await run(resolveCf(), ["curl", `/v3/apps/${guid}/environment_variables`], { source: "cf", quiet: true, silent: true });
      if (e.code === 0) { try { value = (JSON.parse(e.stdout).var || {})[VERSION_ENV] || null; } catch { value = null; } }
    }
    installedMemo = { at: Date.now(), name, value, exists: !!guid };
    return { version: value, exists: !!guid };
  }
  async function installedPlatformVersion(catalog) {
    return (await installedPlatformState(catalog)).version;
  }

  /**
   * The release an action works with (decision 0010). Reads the store's
   * index, finds the installed version (from the space), applies the version
   * rule of `purpose` ("install" | "update" | "read", see chooseVersion) to
   * `version` (optional, from the UI), and resolves that release: its catalog
   * and config files in a local directory.
   * Returns { ok, version, dir, catalog, release, installed, latest, source, note? }
   * or { ok:false, error }.
   */
  async function currentRelease({ version, purpose = "read", refresh } = {}) {
    const s = store();
    if (!s) return { ok: false, error: NO_SOURCE_ERROR };
    const idx = await s.index({ refresh });
    if (!idx.ok) return { ok: false, error: idx.error };
    // The latest catalog names the platform CF app; frozen names make any
    // catalog fine for that (decision 0008). An explicit refresh also shows
    // the verification of the cached files in the terminal.
    const latestRel = await s.resolve(idx.latest, { verbose: !!refresh });
    if (!latestRel.ok) return latestRel;
    const installed = await installedPlatformVersion(latestRel.catalog);
    const versions = idx.versions.map((v) => v.version);
    const pick = chooseVersion({ requested: version, installed, latest: idx.latest, versions, purpose });
    if (!pick.ok) return pick;
    if (pick.note) log("faid", "warn", pick.note);
    const rel = pick.version === idx.latest ? latestRel : await s.resolve(pick.version, { verbose: !!refresh });
    if (!rel.ok) return rel;
    // latestCatalog: what a NEWER release would bring (apps that are not in
    // the installed version yet); the page names them, Install refuses them
    // with the reason (see requireApp).
    return { ...rel, installed, latest: idx.latest, latestCatalog: latestRel.catalog, versions: idx.versions, source: s.describe(), note: pick.note };
  }

  /** The apps of the latest release that `catalog` (an older, installed version) does not have. */
  function appsNewInLatest(rel) {
    if (!rel || !rel.latestCatalog || rel.latest === rel.version) return [];
    const have = new Set((rel.catalog.apps || []).map((a) => a.id));
    return (rel.latestCatalog.apps || []).filter((a) => !have.has(a.id));
  }
  // Polling knobs (tests inject a no-op sleep and a short deadline).
  const sleep = ctx.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const POLL_MS = ctx.pollIntervalMs != null ? ctx.pollIntervalMs : 10_000;
  const PROVISION_TIMEOUT_MS = ctx.provisionTimeoutMs != null ? ctx.provisionTimeoutMs : 15 * 60_000;

  /** The manager's own CF app name (cloud only; null on desktop / outside CF). */
  /** The landscape's shared `cfapps.` domain, read from the CF API (never hard-coded). */
  async function resolveAppsDomain() {
    const r = await run(resolveCf(), ["curl", "/v3/domains"], { source: "cf", quiet: true });
    if (r.code !== 0) return { ok: false, error: `cf curl /v3/domains failed: ${(r.stderr || r.stdout || "").trim().slice(0, 200)}` };
    let names = [];
    try { names = (JSON.parse(r.stdout).resources || []).map((d) => d.name).filter(Boolean); }
    catch { return { ok: false, error: "cf curl /v3/domains returned no JSON" }; }
    const domain = names.find((n) => n.startsWith("cfapps."));
    if (!domain) return { ok: false, error: `no cfapps.* domain in this landscape (domains: ${names.join(", ") || "none"}) - cannot fill ${APPS_DOMAIN_PLACEHOLDER}` };
    return { ok: true, domain };
  }

  function selfAppName() {
    const t = host.getDeployTargetForSelf && host.getDeployTargetForSelf();
    return t && t.appName ? t.appName : null;
  }

  /** Last non-empty line the CLI printed, for error texts. */
  const cfTail = (r) => ((r.stderr || r.stdout || "").trim().split(/\r?\n/).filter(Boolean).pop() || "").slice(0, 300);

  /**
   * Wait until every named instance reports a succeeded operation. Failed
   * instances are collected, the rest is polled until PROVISION_TIMEOUT_MS.
   */
  async function waitForServices(names) {
    const failed = [];
    const timedOut = [];
    const deadline = Date.now() + PROVISION_TIMEOUT_MS;
    let pending = [...names];
    while (pending.length) {
      const still = [];
      for (const name of pending) {
        const r = await run(resolveCf(), ["service", name], { source: "cf", quiet: true });
        const status = serviceStatusFromCf(r.code, r.stdout);
        if (status === "ready") continue;
        if (status === "failed") { failed.push({ name, error: "service operation failed (see cf service)" }); continue; }
        still.push(name);
      }
      pending = still;
      if (!pending.length) break;
      if (Date.now() > deadline) { timedOut.push(...pending); break; }
      log("faid", "dim", `waiting for: ${pending.join(", ")} …`);
      await sleep(POLL_MS);
    }
    const ok = failed.length === 0 && timedOut.length === 0;
    return {
      ok, failed, timedOut,
      error: ok ? undefined :
        [failed.map((f) => `${f.name}: ${f.error}`).join("; "), timedOut.length ? `still not ready: ${timedOut.join(", ")}` : ""]
          .filter(Boolean).join(" | "),
    };
  }

  /**
   * The full xs-security document for the shared XSUAA instance (decision
   * 0009): the release part (the release's xs-security.json, a fixed name,
   * when a release is present) merged with the manager part, the
   * __CF_APPS_DOMAIN__ placeholder filled with the landscape's cfapps domain
   * (decision 0008). Written to <userData>/faid-services/ so the release
   * file stays untouched. Returns { ok, path, doc } or { ok:false, error }.
   * A release whose CF apps require XSUAA must ship the file; otherwise it is
   * used when present.
   */
  async function composedXsuaaConfig(dir, catalog) {
    let release = null;
    const configFile = baseServices.serviceOfKind("xsuaa").configFile;
    if (dir) {
      const file = path.join(dir, configFile);
      const rs = catalog ? releaseServices(catalog) : null;
      const required = !!(rs && rs.ok && rs.requirements.kinds.includes("xsuaa"));
      if (fs.existsSync(file)) {
        try { release = JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, "")); }
        catch (e) { return { ok: false, error: `${configFile} is not valid JSON: ${e.message}` }; }
      } else if (required) {
        return { ok: false, error: `config file ${configFile} missing from the release` };
      }
    }
    const dom = await resolveAppsDomain();
    if (!dom.ok) return dom;
    const composed = managerXsuaa.composeXsSecurity({ release, appsDomain: dom.domain });
    if (!composed.ok) return composed;
    const cfgDir = path.join(host.getUserDataDir(), "faid-services");
    fs.mkdirSync(cfgDir, { recursive: true });
    const out = path.join(cfgDir, "xs-security.composed.json");
    fs.writeFileSync(out, JSON.stringify(composed.doc, null, 2));
    log("faid", "dim", `xs-security = manager part + release part; ${APPS_DOMAIN_PLACEHOLDER} -> ${dom.domain}`);
    return { ok: true, path: out, doc: composed.doc };
  }

  /**
   * Make the shared XSUAA instance carry the current roles (decision 0009):
   * create `figaf-faid-xsuaa` when missing, update it when present, always
   * from the composed document. Waits until the operation succeeded.
   * updateOnly: do nothing when the instance is missing (before install and
   * update, where the required-services check reports a missing instance).
   */
  async function ensureXsuaa({ updateOnly, version } = {}) {
    const inst = managerXsuaa.SHARED_INSTANCE;
    let dir = null;
    let catalog = null;
    if (store()) {
      const rel = await currentRelease({ version });
      if (!rel.ok) return { ok: false, instance: inst, error: rel.error };
      dir = rel.dir;
      catalog = rel.catalog;
    }
    const probe = await run(resolveCf(), ["service", inst], { source: "cf", quiet: true });
    let status = serviceStatusFromCf(probe.code, probe.stdout);
    if (status === "missing" && updateOnly) return { ok: true, instance: inst, skipped: true, note: `${inst} does not exist yet` };
    if (status === "in-progress") {
      const w = await waitForServices([inst]);
      if (!w.ok) return { ok: false, instance: inst, error: w.error };
      status = "ready";
    }
    const cfg = await composedXsuaaConfig(dir, catalog);
    if (!cfg.ok) return { ok: false, instance: inst, error: cfg.error };
    if (status === "failed") {
      log("faid", "warn", `${inst} is in a failed state — deleting it before creating again`);
      const del = await run(resolveCf(), ["delete-service", inst, "-f"], { source: "cf" });
      if (del.code !== 0) return { ok: false, instance: inst, error: `could not delete the failed instance ${inst}: ${cfTail(del)}` };
      const gone = Date.now() + PROVISION_TIMEOUT_MS;
      while ((await run(resolveCf(), ["service", inst], { source: "cf", quiet: true })).code === 0) {
        if (Date.now() > gone) return { ok: false, instance: inst, error: `${inst}: deletion did not finish in time` };
        await sleep(POLL_MS);
      }
      status = "missing";
    }
    let created = false;
    if (status === "missing") {
      const plan = baseServices.serviceOfKind("xsuaa").plan;
      log("faid", "line", `Creating service instance ${inst} (xsuaa / ${plan}) — roles of the manager and the apps …`);
      const r = await run(resolveCf(), ["create-service", "xsuaa", plan, inst, "-c", cfg.path], { source: "cf" });
      if (r.code !== 0) return { ok: false, instance: inst, error: `cf create-service ${inst} failed: ${cfTail(r)}` };
      created = true;
    } else {
      log("faid", "line", `Updating service instance ${inst} — roles of the manager and the apps …`);
      const r = await run(resolveCf(), ["update-service", inst, "-c", cfg.path], { source: "cf" });
      if (r.code !== 0) return { ok: false, instance: inst, error: `cf update-service ${inst} failed: ${cfTail(r)}` };
    }
    const w = await waitForServices([inst]);
    if (!w.ok) return { ok: false, instance: inst, error: w.error };
    return { ok: true, instance: inst, created, updated: !created };
  }

  /** The release (per `opts`, see currentRelease) and the catalog app `appId` in it. */
  async function requireApp(appId, opts) {
    const rel = await currentRelease(opts);
    if (!rel.ok) return { error: rel.error };
    const app = rel.catalog.apps.find((a) => a.id === appId);
    if (!app) {
      // One version per installation (decision 0010): an app that only a newer
      // release has cannot be installed at the installed version. Say so, and
      // say what to do - the generic "unknown app id" hid this on 2026-09-07.
      if (appsNewInLatest(rel).some((a) => a.id === appId)) {
        return {
          error: `'${appId}' is new in release ${rel.latest}; this installation runs ${rel.version}, whose catalog does not have it. ` +
            `Update the installation to ${rel.latest} first (Release panel), then Install. Nothing was deployed.`,
          step: "version",
        };
      }
      return { error: `unknown app id '${appId}' in release ${rel.version}` };
    }
    return { rel, dir: rel.dir, app, catalog: rel.catalog };
  }

  function phase(appId, cfApp, step, state, detail) {
    send("faid:phase", { appId, cfApp, step, state, detail: detail || null });
  }

  /**
   * Is a build of this CF app being staged right now? One `cf curl`; asked
   * only for a part that Cloud Foundry reports as STOPPED, which is exactly
   * the window a fresh install spends in staging.
   */
  async function isStaging(guid) {
    if (!guid) return false;
    const r = await run(resolveCf(), ["curl", `/v3/builds?app_guids=${guid}&states=STAGING`], { source: "cf", quiet: true });
    if (r.code !== 0) return false;
    try { return (JSON.parse(r.stdout).resources || []).length > 0; } catch { return false; }
  }

  async function cfAppExists(name) {
    const r = await run(resolveCf(), ["app", name, "--guid"], { source: "cf", quiet: true });
    return r.code === 0;
  }

  /**
   * Does a CF binding of the service instance to the app exist? One
   * `cf curl`. null when the probe fails (the caller shows "unknown", never
   * a wrong "bound" or "missing").
   */
  async function bindingExists(instance, app) {
    const b = await run(resolveCf(), ["curl", `/v3/service_credential_bindings?type=app&service_instance_names=${instance}&app_names=${app}`], { source: "cf", quiet: true });
    if (b.code !== 0) return null;
    try { return (JSON.parse(b.stdout).resources || []).length > 0; } catch { return null; }
  }

  /** First HTTPS route of a CF app, or null. */
  async function routeUrl(appName) {
    const r = await run(resolveCf(), ["app", appName], { source: "cf", quiet: true });
    if (r.code !== 0) return null;
    const m = /routes:\s+([^\s,]+)/i.exec(r.stdout);
    return m ? "https://" + m[1] : null;
  }

  /**
   * Zips built on Windows carry no Unix permission info; unzip on Linux can
   * extract their directories WITHOUT write permission. Re-grant owner
   * read/write (+x on dirs) so cf push can read the tree and a retry can
   * delete it. No-op on Windows.
   */
  async function normalizeTreePerms(dir) {
    if (process.platform === "win32") return;
    await run("chmod", ["-R", "u+rwX", dir], { source: "sh", quiet: true });
  }

  /** rm -rf that survives a previous extraction with unwritable directories. */
  async function removeTree(dir) {
    if (!fs.existsSync(dir)) return;
    await normalizeTreePerms(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  /** cf set-env with the VALUE hidden from terminal stream + audit log. */
  async function setEnvMasked(appName, key, value) {
    return run(resolveCf(), ["set-env", appName, key, String(value)], {
      source: "cf",
      quiet: true,
      logCmd: `cf set-env ${appName} ${key} <value hidden>`,
      auditArgs: ["set-env", appName, key, "<value hidden>"],
    });
  }

  /**
   * The structured failure of one deploy step. Carries what cf said (`detail`),
   * WHERE it happened (`step`, `cfApp`) and the exact command (masked where it
   * carried a secret), so the console can show it and the operator can report
   * it. Also emits the faid:phase error event with the detail.
   */
  function stepFailure(app, cfApp, step, r, summary, command) {
    const detail = cliFailureDetail(r);
    phase(app.id, cfApp.name, step, "error", detail || null);
    return {
      ok: false,
      error: detail ? `${summary}: ${detail}` : summary,
      step,
      cfApp: cfApp.name,
      command: command || undefined,
      detail: detail || undefined,
    };
  }

  /**
   * Run one state-changing lifecycle action, refusing a second one while it
   * lasts (see the module header). The refusal is a normal failed result, so
   * the console shows it in the red panel; `busy: true` and `running` let a
   * caller tell it apart from a real error. While the action runs, every page
   * of this session learns it from the `faid:running` event, and any page can
   * ask with `faid:running` or read `running` from `faid:status`.
   */
  async function exclusive(action, appId, fn, extra) {
    const busy = runningAction();
    if (busy) {
      const error =
        `${busy.action} of ${busy.appId} is already running (started ${agoText(Date.now() - busy.startedAt)} ago) — ` +
        "wait until it finishes. Two deploys at the same time overwrite the package Cloud Foundry is staging, " +
        "and both fail.";
      log("faid", "err", `${action} ${appId} refused: ${error}`);
      return { ok: false, busy: true, running: busy, error };
    }
    // `extra` = more facts about the action for the pages (today `appIds`,
    // the apps of a bulk disable / enable), next to the one-line `appId`.
    currentAction = { action, appId, startedAt: Date.now(), ...(extra || {}) };
    send("faid:running", runningAction());
    try {
      return await fn();
    } finally {
      currentAction = null;
      installedMemo = null; // the action may have changed the installed version
      send("faid:running", null);
    }
  }

  /**
   * Deploy one catalog cfApp: fresh install (push --no-start, bind, env,
   * start) or in-place update (env refresh, push). `names` = the actual
   * instance names (effectiveServiceNames). Returns { ok } or
   * { ok:false, error, step, cfApp, command?, detail? }.
   */
  async function deployPart(app, cfApp, rel, names) {
    const name = cfApp.name;

    // The artifact: from the store when not cached yet (remote), verified
    // against the catalog's sha256 by the store. A failure here is the step
    // "download": nothing was pushed.
    phase(app.id, name, "download", "running");
    const got = await store().ensureArtifact(rel, cfApp.artifact);
    if (!got.ok) {
      phase(app.id, name, "download", "error", got.error);
      return { ok: false, error: got.error, step: "download", cfApp: name, command: `GET ${cfApp.artifact} from ${rel.source ? rel.source.location : "the release store"}` };
    }
    phase(app.id, name, "download", "ok");
    const channelDir = rel.dir;

    // Verify the artifact against its release checksum BEFORE extracting.
    if (cfApp.sha256) {
      const zipPath = got.path;
      let actual;
      try {
        actual = crypto.createHash("sha256").update(fs.readFileSync(zipPath)).digest("hex");
      } catch (e) {
        phase(app.id, name, "extract", "error", e.message);
        return { ok: false, error: `could not read ${cfApp.artifact}: ${e.message}`, step: "extract", cfApp: name };
      }
      if (actual !== String(cfApp.sha256).toLowerCase()) {
        phase(app.id, name, "extract", "error", "checksum mismatch");
        return { ok: false, error: `checksum mismatch for ${cfApp.artifact} — the release is corrupt or was tampered with; nothing was deployed`, step: "extract", cfApp: name };
      }
    }

    phase(app.id, name, "extract", "running");
    const workDir = path.join(host.getUserDataDir(), "faid-apps", app.id, name);
    try {
      await removeTree(workDir);
      await extractZip(path.join(channelDir, cfApp.artifact), workDir);
      await normalizeTreePerms(workDir);
    } catch (e) {
      phase(app.id, name, "extract", "error", e.message);
      return { ok: false, error: `extract ${cfApp.artifact} failed: ${e.message}`, step: "extract", cfApp: name };
    }
    phase(app.id, name, "extract", "ok");

    // The extracted tree is needed for cf push only. It is removed in every
    // case (success or failure) because the container disk quota covers
    // $HOME as well; a copy per session and per install filled it up.
    try {
      const fresh = !(await cfAppExists(name));

      if (fresh) {
        phase(app.id, name, "push", "running");
        const pushArgs = buildPushArgs(cfApp, workDir, { noStart: true });
        let r = await run(resolveCf(), pushArgs, { source: "cf" });
        if (r.code !== 0) return stepFailure(app, cfApp, "push", r, `cf push ${name} failed`, `cf ${pushArgs.join(" ")}`);
        phase(app.id, name, "push", "ok");

        phase(app.id, name, "bind", "running");
        // The instances this CF app binds (catalog v7 `requires` -> the module's
        // names). The database is never among them: the backend reaches it with
        // its own role (Credential Store entry), never through a binding.
        const bindings = bindingsFor(cfApp, names);
        if (requiresOwnRole(cfApp)) {
          const db = baseServices.serviceOfKind("database");
          const inst = (names && names[db.name]) || db.name;
          log("cf", "dim", `${inst}: the backend reaches this database with its own role (Credential Store entry ${faidDatabase.NAMESPACE}/${faidDatabase.ENTRY}), never through a binding`);
        }
        for (const s of bindings.required) {
          const bindArgs = ["bind-service", name, s];
          r = await run(resolveCf(), bindArgs, { source: "cf" });
          if (r.code !== 0) {
            return stepFailure(app, cfApp, "bind", r, `bind-service ${s} failed — does the service instance exist in this space?`, `cf ${bindArgs.join(" ")}`);
          }
        }
        for (const s of bindings.optional) {
          const probe = await run(resolveCf(), ["service", s], { source: "cf", quiet: true });
          if (probe.code === 0) {
            r = await run(resolveCf(), ["bind-service", name, s], { source: "cf" });
            if (r.code !== 0) log("cf", "warn", `optional bind-service ${s} failed — continuing without it`);
          } else {
            log("cf", "warn", `optional service ${s} not found — skipping bind`);
          }
        }
        phase(app.id, name, "bind", "ok");
      }

      phase(app.id, name, "env", "running");
      const envPairs = { ...(cfApp.env || {}), [VERSION_ENV]: app.version };
      if (cfApp.destinationTo) {
        const url = await routeUrl(cfApp.destinationTo);
        if (!url) {
          phase(app.id, name, "env", "error", `no route on ${cfApp.destinationTo}`);
          return { ok: false, error: `could not resolve the route of ${cfApp.destinationTo} — is the shared backend deployed and started?`, step: "env", cfApp: name, command: `cf app ${cfApp.destinationTo}` };
        }
        envPairs.destinations = buildDestinationsEnv(cfApp.destinationName || cfApp.destinationTo, url);
      }
      // `requires.database: "own-role"`: the shared backend reaches the database
      // with its own role (Credential Store entry) and verifies the server with
      // the instance's CA chain, which the manager reads from its standing
      // service key and sets here as FAID_DATABASE_CA (public; too large for
      // the store).
      if (requiresOwnRole(cfApp)) {
        const st = await database.status();
        if (!st.instanceName) return { ok: false, error: `database access is not prepared (${st.reason || st.state}) - Setup step 3, "Prepare database access"`, step: "database", cfApp: name };
        const ca = await database.certificateChain({ instanceName: st.instanceName });
        if (!ca.ok) return { ok: false, error: `could not read the CA certificate of ${st.instanceName}: ${ca.error}`, step: "database", cfApp: name, command: ca.command };
        envPairs[ca.envName] = ca.sslrootcert;
      }
      for (const [k, v] of Object.entries(envPairs)) {
        const r = await setEnvMasked(name, k, v);
        if (r.code !== 0) return stepFailure(app, cfApp, "env", r, `cf set-env ${k} failed`, `cf set-env ${name} ${k} <value hidden>`);
      }
      phase(app.id, name, "env", "ok");

      phase(app.id, name, "start", "running");
      const startArgs = fresh ? ["start", name] : buildPushArgs(cfApp, workDir, { noStart: false });
      const r = await run(resolveCf(), startArgs, { source: "cf" });
      if (r.code !== 0) {
        return stepFailure(app, cfApp, "start", r, `${fresh ? "cf start" : "cf push"} ${name} failed — see the staging log in the terminal`, `cf ${startArgs.join(" ")}`);
      }
      phase(app.id, name, "start", "ok");
      return { ok: true };
    } finally {
      try { await removeTree(workDir); } catch { /* best effort */ }
    }
  }

  /**
   * Every instance the deploy binds (the kinds the platform's and the app's
   * CF apps consume as a binding) must exist before a deploy starts — a
   * clear early error instead of `bind-service` failing halfway through.
   * The own-role database is checked separately (database.status()).
   */
  async function missingRequiredServices(catalog, app, names) {
    const platform = platformPseudoApp(catalog);
    const wanted = new Set();
    for (const c of [...(platform ? platform.cfApps : []), ...app.cfApps]) {
      for (const s of bindingsFor(c, names).required) wanted.add(s);
    }
    const missing = [];
    for (const name of wanted) {
      const r = await run(resolveCf(), ["service", name], { source: "cf", quiet: true });
      if (r.code !== 0) missing.push(name);
    }
    return missing;
  }

  /**
   * What every deploy needs before the first push: the landscape offers the
   * stack(s) the release names (decision 0015), the required service
   * instances exist, and the shared XSUAA instance carries the roles of the
   * release being deployed (decision 0009; update only — a missing instance
   * is reported first). Returns null or a failed result; on success the
   * actual instance names are attached to `rel.names` for the deploy.
   */
  async function preflight(rel, apps) {
    const platform = platformPseudoApp(rel.catalog);
    const rs = releaseServices(rel.catalog);
    if (!rs.ok) return { ok: false, error: rs.error, step: "catalog" };
    const req = rs.requirements;
    const stacks = wantedStacks([...(platform ? platform.cfApps : []), ...apps.flatMap((a) => a.cfApps || [])]);
    if (stacks.length) {
      const r = await run(resolveCf(), ["stacks"], { source: "cf", quiet: true });
      if (r.code !== 0) {
        log("cf", "warn", `cf stacks failed — the stack check is skipped; cf push reports a stack this landscape lacks (release asks for ${stacks.join(", ")})`);
      } else {
        const available = parseStackNames(r.stdout);
        const missing = missingStacks(stacks, available);
        if (missing.length) {
          return { ok: false, error: missingStackError(missing, available), step: "stack", command: "cf stacks" };
        }
      }
    }
    // The actual instance names (an editable one may differ from its default).
    const nm = await effectiveServiceNames(rel.catalog);
    if (!nm.ok) return { ok: false, error: nm.error, step: "names" };
    rel.names = nm.names;
    if (req.kinds.length) {
      const names = new Set();
      for (const app of apps) for (const m of await missingRequiredServices(rel.catalog, app, nm.names)) names.add(m);
      if (names.size) {
        return { ok: false, error: `required service instance(s) missing: ${[...names].join(", ")} — create them first (Setup, step 3)` };
      }
      // The backend's database is reached with its own role. The Credential
      // Store entry must exist and name a ready instance, or the backend
      // refuses to start after the push. Checked here, before any push.
      if (req.consumption.database === "own-role") {
        const st = nm.databaseAccess || await database.status();
        if (!st.prepared) {
          return {
            ok: false,
            step: "database",
            error: `database access is not prepared (${st.reason || st.state}) - Setup step 3, "Prepare database access", then try again. Nothing was deployed.`,
          };
        }
      }
    }
    // Catalog v5 (figaf-faid decision 0016): the installation's ONE Figaf API
    // client must carry every authority this release needs. Checked before the
    // role refresh, so a refusal changes nothing. No stored connection is not a
    // blocker (it can be connected later); a client that lacks an authority is.
    // A probe that fails (Figaf unreachable) is logged, and the health check
    // reports it later - an install does not need the Figaf tool itself.
    const scopesNeeded = requiredFigafScopes(rel.catalog);
    if (scopesNeeded.length && typeof ctx.checkFigafScopes === "function") {
      const check = await ctx.checkFigafScopes(scopesNeeded);
      if (check && check.ok === false) {
        log("faid", "warn", `the Figaf API client could not be checked (${check.error || "no answer"}) — the action goes on; /health/connections reports the client's authorities`);
      } else if (check && check.configured && Array.isArray(check.missing) && check.missing.length) {
        return {
          ok: false,
          step: "figafScopes",
          error: `the Figaf API client lacks the authorities ${check.missing.join(", ")} that release ${rel.version} needs — add them to the client in the Figaf tool (Settings > API clients), then Connections > Replace connection, then try again. Nothing was deployed.`,
        };
      }
    }
    if (req.kinds.includes("xsuaa")) {
      const x = await ensureXsuaa({ updateOnly: true, version: rel.version });
      if (!x.ok) {
        const inst = x.instance || managerXsuaa.SHARED_INSTANCE;
        return { ok: false, error: `role refresh of ${inst} failed: ${x.error}`, step: "roles", cfApp: inst, command: `cf update-service ${inst} -c xs-security.json` };
      }
    }
    return null;
  }

  /** Shared backend FIRST, then the given apps' CF apps, all from one release. */
  async function deploySet(rel, apps) {
    // Shared backend FIRST (catalog v2): the shared connector is deployed /
    // updated before any frontend, so the only mixed state that ever exists
    // is "new backend + old frontend" — the state the backward-compatibility
    // gate (decision 0005) covers. Idempotent: an already-current connector
    // is simply pushed again (same as the app "Re-deploy").
    const platform = platformPseudoApp(rel.catalog);
    const names = rel.names || resolveNames({}, {}).names;
    if (platform) {
      for (const cfApp of platform.cfApps) {
        const r = await deployPart(platform, cfApp, rel, names);
        if (!r.ok) return { ...r, failedApp: cfApp.name };
      }
    }
    for (const app of apps) {
      for (const cfApp of app.cfApps) {
        const r = await deployPart(app, cfApp, rel, names);
        if (!r.ok) return { ...r, failedApp: cfApp.name };
      }
    }
    return { ok: true };
  }

  /**
   * Install (or re-deploy) ONE app at the installed version — latest on an
   * empty space (decision 0010). `version` may only name that same version.
   */
  async function deployAll(appId, { version } = {}) {
    const req = await requireApp(appId, { version, purpose: "install" });
    if (req.error) return { ok: false, error: req.error, ...(req.step ? { step: req.step } : {}) };
    log("faid", "dim", `release ${req.rel.version} from ${req.rel.source.label}`);
    const pre = await preflight(req.rel, [req.app]);
    if (pre) return pre;
    const r = await deploySet(req.rel, [req.app]);
    if (!r.ok) return r;
    return { ok: true, version: req.app.version };
  }

  /**
   * Move the WHOLE installation to `version` (decision 0010): the shared
   * backend, then every frontend that is installed in the space, in catalog
   * order. Only upwards; equal = re-deploy everything. Apps that are not
   * installed are not installed by this.
   */
  async function updateInstallation(version) {
    const rel = await currentRelease({ version, purpose: "update" });
    if (!rel.ok) return { ok: false, error: rel.error };
    log("faid", "line", `Updating the installation from ${rel.installed} to ${rel.version} (${rel.source.label}) …`);
    const installedApps = [];
    for (const app of rel.catalog.apps) {
      let present = false;
      for (const c of app.cfApps) if (await cfAppExists(c.name)) present = true;
      if (present) installedApps.push(app);
    }
    log("faid", "dim", installedApps.length
      ? `installed apps to update: ${installedApps.map((a) => a.id).join(", ")}`
      : "no app frontend is installed; only the shared backend is updated");
    const pre = await preflight(rel, installedApps);
    if (pre) return pre;
    const r = await deploySet(rel, installedApps);
    if (!r.ok) return r;
    return { ok: true, version: rel.version, from: rel.installed, apps: installedApps.map((a) => a.id) };
  }

  /** stop/start/delete every CF app of a catalog app. Reverse order for teardown. */
  async function forEachPart(appId, argsFor, { reverse } = {}) {
    const req = await requireApp(appId);
    if (req.error) return { ok: false, error: req.error };
    const parts = reverse ? [...req.app.cfApps].reverse() : req.app.cfApps;
    for (const cfApp of parts) {
      const args = argsFor(cfApp);
      const r = await run(resolveCf(), args, { source: "cf" });
      if (r.code !== 0) {
        const detail = cliFailureDetail(r);
        return {
          ok: false,
          error: `cf ${args[0]} ${cfApp.name} failed${detail ? `: ${detail}` : ""}`,
          failedApp: cfApp.name,
          step: args[0],
          cfApp: cfApp.name,
          command: `cf ${args.join(" ")}`,
          detail: detail || undefined,
        };
      }
    }
    return { ok: true };
  }

  /**
   * The body of faid:disable / faid:enable (see the handlers): one app, or a
   * list of apps under one lock. `argsFor` and `opts` are forEachPart's.
   */
  async function stopOrStart(action, { appId, appIds }, argsFor, opts) {
    const list = Array.isArray(appIds) ? [...new Set(appIds.filter((id) => typeof id === "string" && id))] : null;
    if (list && list.length === 0) return { ok: false, error: "appIds is empty" };
    if (!list && !appId) return { ok: false, error: "appId required" };
    if (!list) {
      return exclusive(action, appId, async () =>
        reportOutcome(action, appId, await forEachPart(appId, argsFor, opts)));
    }
    const verb = action === "disable" ? "Stopping" : "Starting";
    return exclusive(action, list.join(", "), async () => {
      log("faid", "line", `${verb} ${list.length} apps: ${list.join(", ")} …`);
      const results = [];
      for (const id of list) {
        const r = reportOutcome(action, id, await forEachPart(id, argsFor, opts));
        results.push({ appId: id, ...r });
      }
      const failed = results.filter((r) => !r.ok);
      if (failed.length === 0) {
        log("faid", "ok", `${action} of ${list.length} apps: done`);
        return { ok: true, results };
      }
      const error = `${action} failed for ${failed.length} of ${list.length} apps: ` +
        failed.map((r) => `${r.appId} (${r.error})`).join("; ");
      log("faid", "err", `${action} of ${list.length} apps FAILED: ${failed.map((r) => r.appId).join(", ")}`);
      // `step` and `cfApp` of the FIRST failure, so the outcome panel names a place.
      return { ok: false, error, results, step: failed[0].step, cfApp: failed[0].cfApp, command: failed[0].command, detail: failed[0].detail };
    }, { appIds: list });
  }

  /** faid:configure body — see the handler. */
  async function configure(appId, env) {
    const req = await requireApp(appId);
    if (req.error) return { ok: false, error: req.error };
    const v = validateConfigEnv(req.app, env);
    if (!v.ok) return v;
    if (v.entries.length === 0) return { ok: true, applied: 0, note: "nothing to apply" };
    const target = req.app.configTargetCfApp || req.app.cfApps[0].name;
    if (!(await cfAppExists(target))) return { ok: false, error: `${target} is not deployed — install the app first` };
    for (const { key, value } of v.entries) {
      const r = await setEnvMasked(target, key, value);
      if (r.code !== 0) return { ok: false, error: `cf set-env ${key} failed` };
    }
    const r = await run(resolveCf(), ["restart", target], { source: "cf" });
    if (r.code !== 0) return { ok: false, error: `cf restart ${target} failed` };
    return { ok: true, applied: v.entries.length };
  }

  /**
   * Bind one OPTIONAL service instance to the shared backend and restart it.
   *
   * Why this exists (decision 0011): the optional groups' instances are bound
   * while the backend is pushed. An instance created LATER - the PI/PO pair from the
   * Base services panel - would otherwise stay unused until the next deploy,
   * and an Update installation is refused when nothing newer is in the store.
   * So the panel offers this instead: bind, then restart, because a Cloud
   * Foundry binding only reaches the app after a restart.
   *
   * Only the instances of the optional groups the platform's CF app names
   * (catalog `optional`) are accepted; nothing else may ever be bound to the
   * shared backend.
   */
  async function bindPlatformService(name) {
    const wanted = String(name || "").trim();
    if (!wanted) return { ok: false, error: "a service name is required" };
    const rel = await currentRelease();
    if (!rel.ok) return { ok: false, error: rel.error };
    const platform = platformPseudoApp(rel.catalog);
    if (!platform) return { ok: false, error: "this release declares no shared backend" };
    const cfApp = platform.cfApps[0];
    const nm = await effectiveServiceNames(rel.catalog);
    if (!nm.ok) return { ok: false, error: nm.error };
    const allowed = bindingsFor(cfApp, nm.names).optional;
    if (!allowed.includes(wanted)) {
      return { ok: false, error: `${wanted} is not an optional service of the shared backend (allowed: ${allowed.join(", ") || "none"})` };
    }
    const probe = await run(resolveCf(), ["service", wanted], { source: "cf", quiet: true });
    if (serviceStatusFromCf(probe.code, probe.stdout) !== "ready") {
      return { ok: false, error: `the service instance ${wanted} is not ready yet — create it first and wait for it` };
    }
    const target = cfApp.name;
    if (!(await cfAppExists(target))) {
      return { ok: false, error: `${target} is not deployed — install the platform first; a later install binds ${wanted} on its own` };
    }
    const bind = await run(resolveCf(), ["bind-service", target, wanted], { source: "cf" });
    const already = /already bound/i.test(`${bind.stdout}\n${bind.stderr}`);
    if (bind.code !== 0 && !already) {
      return { ok: false, error: `cf bind-service ${target} ${wanted} failed: ${cfTail(bind)}`, step: "bind", cfApp: target };
    }
    const restart = await run(resolveCf(), ["restart", target], { source: "cf" });
    if (restart.code !== 0) {
      return { ok: false, error: `${wanted} is bound, but cf restart ${target} failed: ${cfTail(restart)}`, step: "restart", cfApp: target };
    }
    log("faid", "ok", `${wanted} bound to ${target}${already ? " (was already bound)" : ""} and ${target} restarted`);
    return { ok: true, service: wanted, cfApp: target, alreadyBound: already };
  }

  /**
   * Every state-changing action ends with ONE clear line in the terminal
   * drawer: green "done" or red "FAILED at step … (cf app): what cf said".
   * The RPC result carries the same facts for the console's outcome panel.
   */
  function reportOutcome(action, appId, r) {
    if (r && r.ok) {
      log("faid", "ok", `${action} ${appId}: done`);
    } else {
      const where = [r && r.step ? `at step "${r.step}"` : "", r && r.cfApp ? `(${r.cfApp})` : ""].filter(Boolean).join(" ");
      log("faid", "err", `${action} ${appId} FAILED${where ? " " + where : ""}: ${(r && r.error) || "unknown error"}`);
    }
    return r;
  }

  /**
   * The actual instance name of every base service, and how it was found.
   * For the own-role database (when the release requires it): the override
   * from the page, else the Credential Store entry, else the space (`cf
   * services`: the PostgreSQL instances of the offering, see
   * chooseDatabaseInstance), else the module's default. Nothing is stored
   * (SPEC: the manager keeps no state).
   * Returns { ok, names, info: { [defaultName]: { source, candidates } }, databaseAccess }.
   */
  async function effectiveServiceNames(catalog, overrides) {
    const rs = releaseServices(catalog);
    if (!rs.ok) return { ok: false, error: rs.error };
    const discovered = {};
    const info = {};
    let databaseAccess = null;
    let spaceRows = null;
    for (const s of rs.services) {
      if (!ownRoleService(s)) continue;
      databaseAccess = databaseAccess || await database.status();
      if (overrides && overrides[s.name] != null && String(overrides[s.name]).trim() !== "") {
        info[s.name] = { source: "override", candidates: [] };
        continue;
      }
      if (databaseAccess.instanceName) {
        discovered[s.name] = databaseAccess.instanceName;
        info[s.name] = { source: "entry", candidates: [] };
        continue;
      }
      if (spaceRows === null) {
        const r = await run(resolveCf(), ["services"], { source: "cf", quiet: true });
        spaceRows = r.code === 0 ? faidDatabase.parseCfServices(r.stdout) : [];
      }
      const candidates = spaceRows.filter((row) => row.offering === s.offering);
      const pick = chooseDatabaseInstance(s.name, candidates);
      discovered[s.name] = pick.name;
      info[s.name] = { source: pick.source, candidates: candidates.map((row) => ({ name: row.name, plan: row.plan, boundApps: row.boundApps, operation: row.operation })) };
    }
    const res = resolveNames(overrides, discovered);
    if (!res.ok) return res;
    return { ok: true, names: res.names, info, databaseAccess };
  }

  /**
   * Create every MISSING base service the release needs, then wait until all
   * are ready. plans: optional { <defaultName>: <plan> } overrides, validated
   * against the module's allowed plans. only: optional list of default names
   * that restricts the run. waitOnly: optional list of default names to WAIT
   * for; the other created instances are started and reported as `pending`
   * (Setup step 1 starts the database and moves on - it takes minutes and
   * nothing in that step needs it). groups: optional list of OPTIONAL groups
   * to include (e.g. ["pipo"]); optional services are otherwise left alone -
   * see wantedService(). Progress lines go to the terminal drawer.
   */
  async function provisionServices({ plans, only, waitOnly, groups, names } = {}) {
      const rel = await currentRelease();
      if (!rel.ok) return { ok: false, error: rel.error };
      const dir = rel.dir;
      const c = { catalog: rel.catalog };
      const rs = releaseServices(c.catalog);
      if (!rs.ok) return { ok: false, error: rs.error, created: [], failed: [], timedOut: [], pending: [] };
      let declared = rs.services;
      if (Array.isArray(only)) declared = declared.filter((s) => only.includes(s.name));
      else declared = declared.filter((s) => wantedService(s, groups));
      if (declared.length === 0) {
        return { ok: true, created: [], note: Array.isArray(only) ? "nothing to create for the requested services" : "this release needs no service instance" };
      }
      // Default names -> actual instance names (the person may rename an
      // editable one in Setup step 1; a prepared database is found by its entry).
      const nm = await effectiveServiceNames(c.catalog, names);
      if (!nm.ok) return { ok: false, error: nm.error, created: [], failed: [], timedOut: [], pending: [] };
      const actual = (svc) => nm.names[svc.name] || svc.name;

      const created = [];
      const failed = [];
      for (const s of declared) {
        const inst = actual(s);
        const probe = await run(resolveCf(), ["service", inst], { source: "cf", quiet: true });
        if (probe.code === 0) {
          // Exists. A FAILED instance blocks re-creation under the same name;
          // remove it and create again (the admin already asked to provision).
          // An own-role database is NEVER deleted by the manager (it may be the
          // Figaf Tool's): a failed one is reported and left alone.
          if (serviceStatusFromCf(probe.code, probe.stdout) !== "failed") continue;
          if (ownRoleService(s)) { failed.push({ name: s.name, instanceName: inst, error: `${inst} is in a failed state - the manager never deletes a database instance; inspect it with cf service ${inst}` }); continue; }
          log("faid", "warn", `${inst} is in a failed state — deleting it before creating again`);
          const del = await run(resolveCf(), ["delete-service", inst, "-f"], { source: "cf" });
          if (del.code !== 0) { failed.push({ name: s.name, instanceName: inst, error: `could not delete the failed instance: ${cfTail(del)}` }); continue; }
          // Deletion is asynchronous — wait until the name is free.
          const gone = Date.now() + PROVISION_TIMEOUT_MS;
          while ((await run(resolveCf(), ["service", inst], { source: "cf", quiet: true })).code === 0) {
            if (Date.now() > gone) break;
            await sleep(POLL_MS);
          }
        }
        const allowed = s.plans || [s.plan];
        const plan = (plans && plans[s.name]) || s.plan;
        if (!allowed.includes(plan)) {
          failed.push({ name: s.name, instanceName: inst, error: `plan '${plan}' is not allowed for ${s.name} (allowed: ${allowed.join(", ")})` });
          continue;
        }
        const args = ["create-service", s.offering, plan, inst];
        if (s.kind === "xsuaa") {
          // One XSUAA instance for the manager and the apps (decision 0009):
          // always the composed document (release part + manager part).
          const cfg = await composedXsuaaConfig(dir, c.catalog);
          if (!cfg.ok) { failed.push({ name: s.name, error: cfg.error }); continue; }
          args.push("-c", cfg.path);
        } else if (s.config && typeof s.config === "object") {
          // cf -c accepts a file path; never pass JSON on the command line.
          const cfgDir = path.join(host.getUserDataDir(), "faid-services");
          fs.mkdirSync(cfgDir, { recursive: true });
          const file = path.join(cfgDir, `${s.name}.json`);
          fs.writeFileSync(file, JSON.stringify(s.config));
          args.push("-c", file);
        }
        log("faid", "line", `Creating service instance ${inst} (${s.offering} / ${plan}) …`);
        const r = await run(resolveCf(), args, { source: "cf" });
        if (r.code !== 0) { failed.push({ name: s.name, instanceName: inst, error: `cf create-service ${inst} failed: ${cfTail(r)}` }); continue; }
        created.push(inst);
      }

      // Wait for asynchronous creations (PostgreSQL takes minutes). With
      // waitOnly, the other instances are probed once and reported as pending.
      const candidates = declared.filter((s) => !failed.some((f) => f.name === s.name)).map((s) => actual(s));
      const waitActual = Array.isArray(waitOnly) ? waitOnly.map((n) => nm.names[n] || n) : null;
      const toWait = waitActual ? candidates.filter((n) => waitActual.includes(n)) : candidates;
      const w = await waitForServices(toWait);
      failed.push(...w.failed);
      const timedOut = w.timedOut;
      const pending = [];
      for (const name of candidates.filter((n) => !toWait.includes(n))) {
        const r = await run(resolveCf(), ["service", name], { source: "cf", quiet: true });
        const st = serviceStatusFromCf(r.code, r.stdout);
        if (st === "failed") failed.push({ name, error: "service operation failed (see cf service)" });
        else if (st !== "ready") pending.push(name);
      }
      if (pending.length) log("faid", "line", `${pending.join(", ")}: still being created — not waited for, see Setup step 3`);
      const ok = failed.length === 0 && timedOut.length === 0;
      return {
        ok, created, failed, timedOut, pending,
        error: ok ? undefined :
          [failed.map((f) => `${f.name}: ${f.error}`).join("; "), timedOut.length ? `still not ready: ${timedOut.join(", ")}` : ""]
            .filter(Boolean).join(" | "),
      };
  }

  async function bindManagerService(name) {
      const rel = await currentRelease();
      if (!rel.ok) return { ok: false, error: rel.error };
      const rs = releaseServices(rel.catalog);
      if (!rs.ok) return { ok: false, error: rs.error };
      const s = rs.services.find((x) => x.name === name);
      if (!s || !s.bindToManager) return { ok: false, error: `${name || "?"} is not a manager-bound service of the platform` };
      const self = selfAppName();
      if (!self) return { ok: false, error: "cannot determine the manager's own app name (not running in CF?)" };
      const r = await run(resolveCf(), ["bind-service", self, name], { source: "cf" });
      if (r.code !== 0) return { ok: false, error: `cf bind-service ${self} ${name} failed` };
      return { ok: true, restartRequired: true, note: `${name} is bound to ${self}; the binding becomes active after a restart of the manager` };
  }

  return {
    /**
     * The catalog of the release this installation works with: the installed
     * version, or latest on an empty space (`version` names another one for
     * a read). Carries where the release came from.
     */
    async "faid:catalog"({ version } = {}) {
      const rel = await currentRelease({ version });
      if (!rel.ok) return { ok: false, error: rel.error };
      const c = { catalog: rel.catalog };
      const platform = platformPseudoApp(c.catalog);
      return {
        ok: true,
        // releaseVersion is the name; releases built before 2026-09-01 carry
        // only the legacy field channelVersion (kept as a read fallback).
        releaseVersion: rel.version,
        source: rel.source,
        installed: rel.installed,
        latest: rel.latest,
        platform: platform ? { name: platform.name, cfApps: platform.cfApps.map((p) => ({ name: p.name })) } : null,
        apps: c.catalog.apps.map((a) => ({
          id: a.id,
          name: a.name || a.id,
          version: a.version,
          description: a.description || "",
          cfApps: a.cfApps.map((p) => ({ name: p.name })),
          configForm: a.configForm || [],
          healthPath: a.healthPath || null,
          roleCollections: a.roleCollections || [],
        })),
        // Apps a newer release brings that this installation's version does
        // not have: shown as rows without Install, with the Update hint.
        pendingApps: appsNewInLatest(rel).map((a) => ({
          id: a.id, name: a.name || a.id, description: a.description || "", version: rel.latest,
        })),
      };
    },

    /**
     * The versions the store offers, against what is installed (decision
     * 0010). `refresh` re-reads index.json now. For the release panel.
     */
    async "faid:releases"({ refresh } = {}) {
      const rel = await currentRelease({ refresh });
      if (!rel.ok) return { ok: false, error: rel.error, source: store() ? store().describe() : null };
      const { compareSemver } = require("./release-config");
      const versions = rel.versions.map((v) => {
        const cmp = rel.installed ? compareSemver(v.version, rel.installed) : null;
        let selectable = false;
        let reason = null;
        if (!rel.installed) reason = "nothing installed yet — Install uses the latest release";
        else if (cmp < 0) reason = "older than the installed version — rollback is not supported";
        else selectable = true;
        return { version: v.version, publishedAt: v.publishedAt, installed: v.version === rel.installed, latest: v.version === rel.latest, selectable, reason };
      });
      return {
        ok: true,
        source: rel.source,
        installed: rel.installed,
        latest: rel.latest,
        current: rel.version,
        updateAvailable: !!(rel.installed && compareSemver(rel.latest, rel.installed) > 0),
        versions,
      };
    },

    async "faid:status"() {
      const rel = await currentRelease();
      if (!rel.ok) return { ok: false, error: rel.error };
      const c = { catalog: rel.catalog };

      // Scope the app listing to the targeted space; fall back to unscoped.
      let spaceGuid = null;
      const t = await run(resolveCf(), ["target"], { source: "cf", quiet: true });
      const spaceName = /space:\s+(\S+)/i.exec(t.stdout || "")?.[1] || null;
      if (spaceName) {
        const sg = await run(resolveCf(), ["space", spaceName, "--guid"], { source: "cf", quiet: true });
        if (sg.code === 0) spaceGuid = (sg.stdout || "").trim().split(/\r?\n/).filter(Boolean).pop() || null;
      }
      const q = spaceGuid ? `/v3/apps?space_guids=${spaceGuid}&per_page=200` : "/v3/apps?per_page=200";
      const list = await run(resolveCf(), ["curl", q], { source: "cf", quiet: true });
      if (list.code !== 0) return { ok: false, error: "cf curl /v3/apps failed — are you logged in and targeted?" };
      let resources = [];
      try { resources = JSON.parse(list.stdout).resources || []; } catch {}
      const byName = new Map(resources.map((r) => [r.name, r]));

      // The platform base is reported as its own row, computed the same way
      // as the app rows (catalog v2; null on v1 catalogs).
      const platform = platformPseudoApp(c.catalog);
      const entries = platform ? [platform, ...c.catalog.apps] : c.catalog.apps;
      const running = runningAction();
      const apps = [];
      for (const app of entries) {
        const parts = [];
        for (const p of app.cfApps) {
          const res = byName.get(p.name);
          parts.push({ name: p.name, exists: !!res, state: res ? res.state : null, guid: res ? res.guid : null, route: null });
        }
        let installedVersion = null;
        const first = parts.find((p) => p.exists);
        if (first) {
          const e = await run(resolveCf(), ["curl", `/v3/apps/${first.guid}/environment_variables`], { source: "cf", quiet: true });
          if (e.code === 0) { try { installedVersion = (JSON.parse(e.stdout).var || {})[VERSION_ENV] || null; } catch {} }
        }
        for (const p of parts) {
          if (!p.exists) continue;
          const rr = await run(resolveCf(), ["curl", `/v3/apps/${p.guid}/routes`], { source: "cf", quiet: true });
          if (rr.code === 0) { try { p.route = (((JSON.parse(rr.stdout).resources || [])[0]) || {}).url || null; } catch {} }
          if (p.state === "STOPPED") p.staging = await isStaging(p.guid);
        }
        // A deploy in flight is more truthful than the CF state it is about
        // to change: with `push --no-start` + `cf start` the app stays
        // STOPPED (or, before the first push, absent) for minutes. Every
        // deploy touches the shared backend, so the platform row follows any
        // running deploy, not only its own.
        const deploying = running &&
          (running.action === "install" || running.action === "update") &&
          (running.appId === app.id || app.id === "platform");
        let status = computeAppStatus(parts);
        if (deploying && status !== "running") status = "installing";
        apps.push({
          id: app.id,
          name: app.name || app.id,
          status,
          installedVersion,
          catalogVersion: app.version,
          parts: parts.map(({ guid, ...rest }) => rest),
        });
      }
      const platformRow = platform ? apps.shift() : null;
      // `running` travels with the status so ANY page — also one that just
      // reloaded — knows an action is in flight and keeps its buttons off.
      // `release` says which version the rows were computed against.
      return { ok: true, platform: platformRow, apps, running, release: { version: rel.version, installed: rel.installed, latest: rel.latest } };
    },

    /**
     * The base service instances the platform needs (base-services.js,
     * filtered by what the release requires), with their live state. Row
     * shape: `name` is the module's DEFAULT name (the key of plans / only /
     * names), `instanceName` what exists or will be created. `boundToManager`
     * is filled for bindToManager entries (a binding exists in CF; it is
     * effective in THIS process only after a restart — the renderer combines
     * it with login:storedUserStatus.bindingPresent).
     *
     * Optional instances (the PI/PO pair) also carry
     * `backendDeployed` (the shared backend's CF app exists; from the same
     * probe as the installed version, no extra cf call) and `boundToBackend`
     * (a binding of the instance to that app exists, one `cf curl` each).
     * Both are null for required rows and when the release declares
     * no shared backend; `boundToBackend` is also null while the backend is
     * not deployed or the instance is missing. The Base services panel uses
     * them to offer "Bind to backend & restart backend" only when it is
     * needed - an instance created AFTER the backend was pushed. A fresh
     * install binds the optional instances on its own (SPEC section 4.1).
     */
    async "faid:services"({ names } = {}) {
      const rel = await currentRelease();
      if (!rel.ok) return { ok: false, error: rel.error };
      const c = { catalog: rel.catalog };
      const self = selfAppName();
      const platform = platformPseudoApp(c.catalog);
      const backend = platform ? platform.cfApps[0].name : null;
      const rs = releaseServices(c.catalog);
      if (!rs.ok) return { ok: false, error: rs.error };
      const hasOptional = rs.services.some((s) => s.optional);
      const backendDeployed = backend && hasOptional ? (await installedPlatformState(c.catalog)).exists : null;
      // The actual name of an editable instance (the page's override, the
      // Credential Store entry, or the space) and the state of the backend's
      // database access.
      const nm = await effectiveServiceNames(c.catalog, names);
      if (!nm.ok) return { ok: false, error: nm.error };
      const services = [];
      for (const s of rs.services) {
        const instanceName = nm.names[s.name] || s.name;
        const r = await run(resolveCf(), ["service", instanceName], { source: "cf", quiet: true });
        const status = serviceStatusFromCf(r.code, r.stdout);
        const inst = faidDatabase.parseCfService(r.code, r.stdout);
        let boundToManager = null;
        if (s.bindToManager && self && status !== "missing") {
          boundToManager = await bindingExists(instanceName, self);
        }
        let boundToBackend = null;
        if (s.optional && backendDeployed === true && status !== "missing") {
          boundToBackend = await bindingExists(instanceName, backend);
        }
        const own = ownRoleService(s);
        const info = nm.info[s.name] || null;
        services.push({
          // `name` is the module's default name (the key of plans, only, names);
          // `instanceName` is what exists (or will be created) in the space.
          name: s.name, kind: s.kind, instanceName, offering: s.offering, plan: s.plan, plans: [...s.plans],
          actualPlan: inst.plan || null,
          purpose: s.purpose || "", bindToManager: !!s.bindToManager,
          optional: !!s.optional, group: s.group || "", sharedWith: s.sharedWith || "",
          access: own ? "own-role" : "binding", nameEditable: !!s.nameEditable,
          nameSource: info ? info.source : "default",
          candidates: info ? info.candidates : [],
          boundApps: inst.boundApps || [],
          exists: status !== "missing", status, boundToManager,
          backendDeployed: s.optional ? backendDeployed : null, boundToBackend,
          databaseAccess: own ? nm.databaseAccess : null,
        });
      }
      return { ok: true, selfApp: self, backend, backendDeployed, services, databaseAccess: nm.databaseAccess };
    },

    /**
     * The state of the backend's database access (faid-database.js):
     * prepared / not-prepared / stale / unknown, with the entry's instance. No
     * database connection, no lock.
     */
    async "faid:databaseStatus"() {
      if (!host.isHosted) return { ok: false, error: "not available in desktop mode" };
      return database.status();
    },

    /**
     * Create or reconcile the backend's database role on `instanceName`
     * (Setup step 3, "Prepare database access"; also "Prepare again"). One
     * temporary service key, SQL as the owner, verification as faid_app, the
     * Credential Store entry. Under the lifecycle lock: a deploy must not
     * overlap (the backend reads the entry at its start).
     */
    async "faid:databasePrepare"({ instanceName } = {}) {
      if (!host.isHosted) return { ok: false, error: "not available in desktop mode" };
      return exclusive("database-prepare", String(instanceName || "?"), () => database.prepare({ instanceName }));
    },

    /**
     * New password for faid_app; the entry is updated; the shared backend is
     * restarted when it is deployed (it reads the entry at start).
     */
    async "faid:databaseRotate"() {
      if (!host.isHosted) return { ok: false, error: "not available in desktop mode" };
      return exclusive("database-rotate", "platform", async () => {
        const r = await database.rotate();
        if (!r.ok) return r;
        const rel = await currentRelease();
        const platform = rel.ok ? platformPseudoApp(rel.catalog) : null;
        const backend = platform ? platform.cfApps[0].name : null;
        if (!backend || !(await cfAppExists(backend))) return { ...r, restarted: null };
        const rs = await run(resolveCf(), ["restart", backend], { source: "cf" });
        if (rs.code !== 0) {
          return { ...r, ok: false, step: "restart", cfApp: backend, command: `cf restart ${backend}`, error: `the password is rotated and stored, but cf restart ${backend} failed: ${cfTail(rs)} - restart it by hand` };
        }
        return { ...r, restarted: backend };
      });
    },

    /**
     * DROP SCHEMA faid CASCADE and DROP ROLE faid_app on the entry's instance;
     * the entry is deleted. Destructive: `confirm: true` is required (the page
     * asks). A deployed backend fails at its next start until Prepare runs again.
     */
    async "faid:databaseDrop"({ confirm } = {}) {
      if (!host.isHosted) return { ok: false, error: "not available in desktop mode" };
      if (confirm !== true) return { ok: false, error: "confirmation required: this drops schema faid with every table in it and the role faid_app" };
      return exclusive("database-drop", "platform", () => database.drop());
    },

    /**
     * Create every MISSING base service the release needs, then wait until all are ready.
     * plans: optional { <name>: <plan> } overrides, validated against the
     * module's allowed plans. only: create just these instances by name (the
     * Base services panel uses it for one optional instance). groups: include
     * the optional services of these groups. Progress lines go to the
     * terminal drawer.
     */
    async "faid:provisionServices"(args) {
      return provisionServices(args || {});
    },

    /**
     * Make the shared XSUAA instance carry the current roles of the manager
     * and the apps (create or update, decision 0009). See ensureXsuaa().
     */
    async "faid:ensureXsuaa"(args) {
      return ensureXsuaa(args || {});
    },

    /**
     * Decision 0016 (catalog v5): the Figaf API client authorities the
     * installation's release requires (installed version, else latest). The
     * Connections page verifies a new client against this list.
     */
    async "faid:requiredFigafScopes"() {
      const rel = await currentRelease({ purpose: "read" });
      if (!rel.ok) return { ok: false, error: rel.error, scopes: [] };
      return { ok: true, version: rel.version, scopes: requiredFigafScopes(rel.catalog) };
    },

    /**
     * Legacy (wizard frame only): create the platform's manager-bound
     * services (the Credential Store) when missing and bind them to the
     * manager — WITHOUT a restart. The restage at the end of the SSO upgrade
     * activates the binding, so the management user can be stored right after
     * the IAS sign-in and no second passcode is needed.
     */
    async "faid:prepareManagerServices"({ plans } = {}) {
      if (!store()) return { ok: true, created: [], bound: [], note: "no release source on this host - nothing to prepare" };
      const rel = await currentRelease();
      if (!rel.ok) return { ok: false, error: rel.error };
      const rs = releaseServices(rel.catalog);
      if (!rs.ok) return { ok: false, error: rs.error };
      const targets = rs.services.filter((s) => s.bindToManager);
      if (!targets.length) return { ok: true, created: [], bound: [], note: "this release needs no manager-bound service" };
      const self = selfAppName();
      if (!self) return { ok: false, error: "cannot determine the manager's own app name (not running in CF?)" };
      const prov = await provisionServices({ plans, only: targets.map((s) => s.name) });
      if (!prov.ok) return { ok: false, created: prov.created || [], bound: [], error: prov.error };
      const bound = [];
      for (const s of targets) {
        const r = await run(resolveCf(), ["bind-service", self, s.name], { source: "cf" });
        if (r.code !== 0 && !/already bound/i.test(`${r.stdout}\n${r.stderr}`)) {
          return { ok: false, created: prov.created, bound, error: `cf bind-service ${self} ${s.name} failed: ${cfTail(r)}` };
        }
        bound.push(s.name);
      }
      return { ok: true, created: prov.created, bound, note: "bindings become active with the restart at the end of this step" };
    },

    /**
     * Setup step 1 "Prepare the space" (docs/faid-apps-console/SPEC.md 5.2): create every
     * MISSING base instance the release needs except the XSUAA one (faid:ensureXsuaa owns it)
     * with the plans the person chose on the page, wait only for the
     * manager-bound ones (the Credential Store) and bind them to the manager
     * - no restart; the restage at the end of the step activates the binding.
     * The database is only STARTED: it takes minutes and nothing in this step
     * needs it, so it finishes in the background while the person signs in
     * with IAS and stores the management user (Setup step 3 shows it).
     * Result: { ok, created, bound, pending, failed, error?, note? }.
     */
    async "faid:prepareSpaceServices"({ plans, groups, names } = {}) {
      if (!store()) return { ok: true, created: [], bound: [], pending: [], failed: [], note: "no release source on this host - nothing to prepare" };
      const rel = await currentRelease();
      if (!rel.ok) return { ok: false, error: rel.error };
      const rs = releaseServices(rel.catalog);
      if (!rs.ok) return { ok: false, error: rs.error };
      const targets = rs.services
        .filter((s) => s.kind !== "xsuaa")
        .filter((s) => wantedService(s, groups));
      if (!targets.length) return { ok: true, created: [], bound: [], pending: [], failed: [], note: "this release needs no service instance besides XSUAA" };
      const toBind = targets.filter((s) => s.bindToManager);
      const self = selfAppName();
      if (toBind.length && !self) return { ok: false, error: "cannot determine the manager's own app name (not running in CF?)" };
      const prov = await provisionServices({ plans, names, only: targets.map((s) => s.name), waitOnly: toBind.map((s) => s.name) });
      const errors = prov.ok ? [] : [prov.error];
      const bound = [];
      for (const s of toBind) {
        const broken = (prov.failed || []).some((f) => f.name === s.name) || (prov.timedOut || []).includes(s.name);
        if (broken) continue;
        const r = await run(resolveCf(), ["bind-service", self, s.name], { source: "cf" });
        if (r.code !== 0 && !/already bound/i.test(`${r.stdout}\n${r.stderr}`)) {
          errors.push(`cf bind-service ${self} ${s.name} failed: ${cfTail(r)}`);
          continue;
        }
        bound.push(s.name);
      }
      const ok = errors.length === 0;
      return {
        ok,
        created: prov.created || [],
        bound,
        pending: prov.pending || [],
        failed: prov.failed || [],
        error: ok ? undefined : errors.join(" | "),
        note: ok ? "bindings become active with the restart at the end of this step" : undefined,
      };
    },

    /** Bind a manager-bound base service (the Credential Store) to the manager app itself. */
    async "faid:bindManagerService"({ name } = {}) {
      return bindManagerService(name);
    },

    /**
     * Bind an OPTIONAL base service to the shared backend and restart it
     * (decision 0011). Under the same lock as a deploy: it restarts the shared
     * backend, so it must not overlap an install.
     */
    async "faid:bindPlatformService"({ name } = {}) {
      if (!name) return { ok: false, error: "name required" };
      return exclusive("bind-platform-service", String(name), () => bindPlatformService(name));
    },

    /**
     * Restart the manager itself so new bindings take effect. Fire-and-forget:
     * this process is stopped by the restart, so the command never "returns".
     */
    async "faid:restartSelf"() {
      const self = selfAppName();
      if (!self) return { ok: false, error: "cannot determine the manager's own app name (not running in CF?)" };
      log("faid", "warn", `Restarting ${self} — this session ends; reload the page in ~30 s (token mode: claim a new token from the logs).`);
      run(resolveCf(), ["restart", self], { source: "cf" }).catch(() => {});
      return { ok: true, note: "restart started" };
    },

    /**
     * What lifecycle action is running now, for a page that did not start it
     * (a reload, a second tab, a second session). `{ ok:true, running:null }`
     * = nothing is running. No cf call.
     */
    async "faid:running"() {
      return { ok: true, running: runningAction() };
    },

    /**
     * Install one app at the installed version (latest on an empty space).
     * `version` is accepted only when it IS that version — moving the
     * installation is Update's job (decision 0010).
     */
    async "faid:install"({ appId, version } = {}) {
      if (!appId) return { ok: false, error: "appId required" };
      return exclusive("install", appId, async () => {
        log("faid", "line", `Installing ${appId} …`);
        return reportOutcome("install", appId, await deployAll(appId, { version }));
      });
    },

    /**
     * Two shapes (decision 0010):
     *   { version }  move the WHOLE installation to `version` (shared backend,
     *                then every installed frontend); upwards only. Locked as
     *                "platform".
     *   { appId }    re-deploy ONE app at the installed version (the row's
     *                Re-deploy button; the shared backend is pushed again first,
     *                as with Install).
     */
    async "faid:update"({ appId, version } = {}) {
      if (version) {
        return exclusive("update", "platform", async () =>
          reportOutcome("update", `installation to ${version}`, await updateInstallation(version)));
      }
      if (!appId) return { ok: false, error: "appId or version required" };
      return exclusive("update", appId, async () => {
        log("faid", "line", `Re-deploying ${appId} …`);
        return reportOutcome("update", appId, await deployAll(appId));
      });
    },

    /**
     * Two shapes, one lock:
     *   { appId }   stop the CF apps of ONE app (frontend first).
     *   { appIds }  the same for SEVERAL apps, one after the other, under ONE
     *               lock (the page's "Disable selected"). A failure of one app
     *               does not stop the others: stop and start are independent
     *               per app, and a half-done batch would be the worst outcome.
     *               The result lists every app (`results`), and `ok` is true
     *               only when every app succeeded.
     */
    async "faid:disable"({ appId, appIds } = {}) {
      return stopOrStart("disable", { appId, appIds }, (c) => ["stop", c.name], { reverse: true });
    },

    async "faid:enable"({ appId, appIds } = {}) {
      return stopOrStart("enable", { appId, appIds }, (c) => ["start", c.name], {});
    },

    async "faid:remove"({ appId } = {}) {
      if (!appId) return { ok: false, error: "appId required" };
      return exclusive("remove", appId, async () =>
        reportOutcome("remove", appId, await forEachPart(appId, (c) => ["delete", c.name, "-f"], { reverse: true })));
    },

    /**
     * Discover Figaf Tool deployments visible to the current cf login, so the
     * Configure form can offer them as a dropdown instead of a typed URL.
     * Detection (same as the manager's Update flow): app pairs `X-app` +
     * `X-router` where X-app runs a `figaf/app:*` Docker image. The URL a FAID
     * app needs is the ROUTER's route. Note: visibility follows the cf login —
     * a single-space technical user only sees its own space; the form keeps
     * manual URL entry as the fallback.
     */
    async "faid:figafSystems"() {
      // Accepted Figaf Tool Docker repos. `figaf/app` = official releases
      // (what Alex's wizard deploys); `ilnfigaf/app` = Figaf's internal CI
      // builds (run-btp-instance-pipeline.Jenkinsfile). Override / extend via
      // FIGAF_TOOL_IMAGE_PREFIXES (comma-separated) without a redeploy of code.
      const prefixes = (process.env.FIGAF_TOOL_IMAGE_PREFIXES || "figaf/app:,ilnfigaf/app:")
        .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

      // List all apps visible to this cf login, following pagination.
      let resources = [];
      let pagePath = "/v3/apps?per_page=500";
      for (let page = 0; page < 4 && pagePath; page++) {
        const list = await run(resolveCf(), ["curl", pagePath], { source: "cf", quiet: true });
        if (list.code !== 0) {
          if (page === 0) return { ok: false, error: "cf curl /v3/apps failed — are you logged in?" };
          break;
        }
        try {
          const parsed = JSON.parse(list.stdout);
          resources = resources.concat(parsed.resources || []);
          const next = parsed.pagination && parsed.pagination.next && parsed.pagination.next.href;
          pagePath = next ? next.replace(/^https?:\/\/[^/]+/, "") : null;
        } catch { break; }
      }

      const byId = new Map();
      for (const app of resources) {
        const m = /^(.+)-(app|router)$/.exec(app.name || "");
        if (!m) continue;
        if (!byId.has(m[1])) byId.set(m[1], {});
        byId.get(m[1])[m[2]] = app;
      }
      // Complete pairs only; check ids containing "figaf" first — the droplet
      // lookup costs one cf curl per candidate, so spend them wisely.
      const candidates = [...byId.entries()]
        .filter(([, pair]) => pair.app && pair.router)
        .sort(([a], [b]) => (b.toLowerCase().includes("figaf") ? 1 : 0) - (a.toLowerCase().includes("figaf") ? 1 : 0));

      const systems = [];
      let lookups = 0;
      for (const [id, pair] of candidates) {
        if (lookups >= 25 || systems.length >= 15) break;
        lookups++;
        const d = await run(resolveCf(), ["curl", `/v3/apps/${pair.app.guid}/droplets/current`], { source: "cf", quiet: true });
        if (d.code !== 0) continue;
        let image = null;
        try { image = JSON.parse(d.stdout).image || null; } catch {}
        if (!image || !prefixes.some((p) => image.toLowerCase().startsWith(p))) continue;
        const rr = await run(resolveCf(), ["curl", `/v3/apps/${pair.router.guid}/routes`], { source: "cf", quiet: true });
        let route = null;
        if (rr.code === 0) { try { route = (((JSON.parse(rr.stdout).resources || [])[0]) || {}).url || null; } catch {} }
        if (!route) continue;
        systems.push({ id, url: "https://" + route, image });
      }
      return { ok: true, systems };
    },

    /**
     * Rare infrastructure fix: set whitelisted env keys on the app's config
     * target and restart it. Under the same lock as a deploy — it restarts the
     * shared backend, so it must not overlap an install (decision: one
     * lifecycle action at a time).
     */
    async "faid:configure"({ appId, env } = {}) {
      if (!appId) return { ok: false, error: "appId required" };
      return exclusive("configure", appId, () => configure(appId, env));
    },

    /**
     * Ask the shared backend whether a BTP destination exists (decision 0011).
     * The manager is not bound to the destination service - the backend is -
     * so a PI/PO connection is verified by delegation: one call proves the
     * binding, the destination and its Cloud Connector settings at once.
     *
     * Returns { ok, found, proxyType, locationId, ... }. `ok:false` means the
     * check itself could not run (backend not deployed, not bound, no route);
     * `ok:true, found:false` means the backend looked and saw no such
     * destination.
     */
    async "faid:destinationCheck"({ destinationName } = {}) {
      const name = String(destinationName || "").trim();
      if (!name) return { ok: false, error: "destinationName is required" };
      const rel = await currentRelease();
      if (!rel.ok) return { ok: false, error: rel.error };
      const platform = platformPseudoApp(rel.catalog);
      if (!platform) return { ok: false, error: "this release declares no shared backend" };
      const target = platform.cfApps[0].name;
      const base = await routeUrl(target);
      if (!base) {
        return {
          ok: false,
          error: `${target} has no route - the shared backend is not deployed yet`,
          hint: "Install the platform first (Setup step 4); the destination check runs inside the backend.",
        };
      }
      const url = `${base}/health/destination?name=${encodeURIComponent(name)}`;
      log("faid", "line", `GET ${url}`);
      const get = ctx.httpsBody || (async (u) => ({ status: 200, body: await httpsText(u) }));
      let body = null;
      let status = 0;
      try {
        const r = await get(url);
        status = r.status;
        try { body = JSON.parse(r.body); } catch { body = null; }
      } catch (e) {
        return { ok: false, error: `could not reach ${target}: ${e.message}`, url };
      }
      if (status === 404 && !body) {
        return {
          ok: false, url, httpStatus: status,
          error: "this shared backend has no /health/destination endpoint",
          hint: "Update the installation to a release that supports PI/PO connections.",
        };
      }
      if (!body || typeof body !== "object") {
        return { ok: false, url, httpStatus: status, error: `unexpected answer from ${target} (HTTP ${status})` };
      }
      return {
        ok: body.ok !== false,
        found: !!body.found,
        name: body.name || name,
        proxyType: body.proxyType || "",
        locationId: body.locationId || "",
        destinationServiceBound: body.destinationServiceBound !== false,
        connectivityServiceBound: body.connectivityServiceBound !== false,
        warning: body.warning || null,
        error: body.ok === false ? (body.error || `HTTP ${status}`) : undefined,
        hint: body.hint || undefined,
        httpStatus: status,
        url,
      };
    },

    async "faid:health"({ appId } = {}) {
      const req = await requireApp(appId);
      if (req.error) return { ok: false, error: req.error };
      if (!req.app.healthPath) return { ok: false, error: "app declares no healthPath" };
      const target = req.app.configTargetCfApp || req.app.cfApps[0].name;
      const base = await routeUrl(target);
      if (!base) return { ok: false, error: `${target} has no route — is it deployed?` };
      const url = base + req.app.healthPath;
      log("faid", "line", `GET ${url}`);
      // Health endpoints answer non-2xx WITH a diagnostic body (e.g. 503 when
      // a connection is unconfigured) — keep the body either way.
      const get = ctx.httpsBody || (async (u) => ({ status: 200, body: await httpsText(u) }));
      try {
        const r = await get(url);
        let parsed = null;
        try { parsed = JSON.parse(r.body); } catch {}
        return {
          ok: r.status >= 200 && r.status < 300,
          httpStatus: r.status,
          url,
          body: parsed || r.body,
        };
      } catch (e) {
        return { ok: false, url, error: e.message };
      }
    },
  };
}

module.exports = {
  APPS_DOMAIN_PLACEHOLDER,
  VERSION_ENV,
  NO_SOURCE_ERROR,
  runningAction,
  resetRunningAction,
  loadCatalog,
  platformPseudoApp,
  computeAppStatus,
  buildDestinationsEnv,
  buildPushArgs,
  cliFailureDetail,
  validateConfigEnv,
  serviceStatusFromCf,
  releaseServices,
  chooseDatabaseInstance,
  createFaidHandlers,
};
