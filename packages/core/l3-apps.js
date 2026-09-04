"use strict";
// L3 App Manager (PoC) — catalog-driven install / update / disable / enable /
// remove / configure / health for Figaf L3 applications.
//
// Architecture:
//   - An artifact-store directory (host.resolveL3ArtifactsDir()) holds one
//     RELEASE: catalog.json plus one zip artifact per CF app. ("Release" =
//     the versioned set; the store is where releases live — the word
//     "channel" is retired, 2026-09-01.) For the PoC the release is bundled
//     inside the manager build; the seam is this one host method, so a
//     remote store (Cloudflare R2, GitHub releases) is a later swap.
//   - Catalog v2 (release 0.3.0+): a `platform` block holds the SHARED
//     BACKEND CONNECTOR's CF apps; each catalog "app" holds only its
//     frontend(s). Install/update deploy the platform FIRST, then the app —
//     the new connector must serve old frontends during that window
//     (decision 0005's backward-compatibility gate). Disable/enable/remove
//     touch only the app's own CF apps; the platform stays for the others.
//     A catalog WITHOUT a platform block keeps the v1 behavior.
//   - Artifacts may carry a sha256; the zip is verified before extraction.
//   - Bindings go to EXISTING service instances named in the catalog
//     (`services` must exist; `optionalServices` are bound only when present).
//   - The manager stamps FIGAF_APP_VERSION on every CF app it deploys and
//     reads it back for the status view.
//   - Config values (Figaf/SAP connection settings) are applied via
//     `cf set-env` with the value masked in the terminal stream and in the
//     audit log — secret values must never appear in either.
//
// Handlers are created by createL3Handlers(ctx) and spread into the
// orchestrator's handlers map. ctx carries the orchestrator's own helpers so
// this module spawns nothing on its own (tests inject a fake `run`).

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const VERSION_ENV = "FIGAF_APP_VERSION";
// Landscape-independent releases (decision 0008, figaf-l3-l4 repo): a service
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

// ─── pure helpers (unit-tested in l3-apps.test.js) ──────────────────────────

/** Read + validate <dir>/catalog.json. Returns { ok, catalog } or { ok:false, error }. */
function loadCatalog(dir) {
  const file = path.join(dir, "catalog.json");
  if (!fs.existsSync(file)) return { ok: false, error: `catalog.json not found in ${dir}` };
  let parsed;
  try {
    // strip a UTF-8 BOM — Windows-side writers (PowerShell 5.1) often add one
    parsed = JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
  } catch (e) {
    return { ok: false, error: `catalog.json is not valid JSON: ${e.message}` };
  }
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
 * The manager's manifest then becomes the base of the L3 app push (its
 * buildpack, command, random-route, env) and CAPI rejects the mix:
 * "Buildpack and Buildpacks fields cannot be used together" — found live on
 * 2026-09-03, install of release 0.4.0. An L3 app is described ONLY by the
 * release catalog; no manifest is ever part of its push.
 */
function buildPushArgs(cfApp, dir, { noStart } = {}) {
  const args = ["push", cfApp.name, "-p", dir, "--no-manifest"];
  if (cfApp.buildpack) args.push("-b", cfApp.buildpack);
  if (cfApp.memory) args.push("-m", cfApp.memory);
  if (cfApp.disk) args.push("-k", cfApp.disk);
  if (noStart) args.push("--no-start");
  return args;
}

/**
 * Whitelist-validate the env object a renderer sends to l3:configure.
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
 * @param {object} ctx.host        HostAdapter (needs resolveL3ArtifactsDir + getUserDataDir)
 * @param {Function} ctx.run       orchestrator subprocess helper
 * @param {Function} ctx.log       cli:line logger (source, type, text)
 * @param {Function} ctx.send      event emitter to the renderer
 * @param {Function} ctx.resolveCf () => cf binary path
 * @param {Function} ctx.extractZip (zipPath, destDir) => Promise
 * @param {Function} ctx.httpsText (url) => Promise<string>
 */
function createL3Handlers(ctx) {
  const { host, run, log, send, resolveCf, extractZip, httpsText } = ctx;
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
      log("l3", "dim", `waiting for: ${pending.join(", ")} …`);
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
   * 0009): the release part (the xsuaa entry's configFile, when a release is
   * present) merged with the manager part, the __CF_APPS_DOMAIN__ placeholder
   * filled with the landscape's cfapps domain (decision 0008). Written to
   * <userData>/l3-services/ so the release file stays untouched.
   * Returns { ok, path, doc } or { ok:false, error }.
   */
  async function composedXsuaaConfig(dir, catalog) {
    let release = null;
    const svc = catalog && Array.isArray(catalog.services) ? catalog.services.find((s) => s.offering === "xsuaa") : null;
    if (dir && svc && svc.configFile) {
      const file = path.join(dir, svc.configFile);
      if (!fs.existsSync(file)) return { ok: false, error: `config file ${svc.configFile} missing from the release` };
      try { release = JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, "")); }
      catch (e) { return { ok: false, error: `${svc.configFile} is not valid JSON: ${e.message}` }; }
    }
    const dom = await resolveAppsDomain();
    if (!dom.ok) return dom;
    const composed = managerXsuaa.composeXsSecurity({ release, appsDomain: dom.domain });
    if (!composed.ok) return composed;
    const cfgDir = path.join(host.getUserDataDir(), "l3-services");
    fs.mkdirSync(cfgDir, { recursive: true });
    const out = path.join(cfgDir, "xs-security.composed.json");
    fs.writeFileSync(out, JSON.stringify(composed.doc, null, 2));
    log("l3", "dim", `xs-security = manager part + release part; ${APPS_DOMAIN_PLACEHOLDER} -> ${dom.domain}`);
    return { ok: true, path: out, doc: composed.doc };
  }

  /**
   * Make the shared XSUAA instance carry the current roles (decision 0009):
   * create `figaf-l3l4-xsuaa` when missing, update it when present, always
   * from the composed document. Waits until the operation succeeded.
   * updateOnly: do nothing when the instance is missing (before install and
   * update, where the required-services check reports a missing instance).
   */
  async function ensureXsuaa({ updateOnly } = {}) {
    const inst = managerXsuaa.SHARED_INSTANCE;
    const dir = artifactsDir();
    let catalog = null;
    if (dir) {
      const c = loadCatalog(dir);
      if (!c.ok) return { ok: false, instance: inst, error: c.error };
      catalog = c.catalog;
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
      log("l3", "warn", `${inst} is in a failed state — deleting it before creating again`);
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
      const svc = (catalog && (catalog.services || []).find((s) => s.offering === "xsuaa")) || null;
      const plan = (svc && svc.plan) || "application";
      log("l3", "line", `Creating service instance ${inst} (xsuaa / ${plan}) — roles of the manager and the apps …`);
      const r = await run(resolveCf(), ["create-service", "xsuaa", plan, inst, "-c", cfg.path], { source: "cf" });
      if (r.code !== 0) return { ok: false, instance: inst, error: `cf create-service ${inst} failed: ${cfTail(r)}` };
      created = true;
    } else {
      log("l3", "line", `Updating service instance ${inst} — roles of the manager and the apps …`);
      const r = await run(resolveCf(), ["update-service", inst, "-c", cfg.path], { source: "cf" });
      if (r.code !== 0) return { ok: false, instance: inst, error: `cf update-service ${inst} failed: ${cfTail(r)}` };
    }
    const w = await waitForServices([inst]);
    if (!w.ok) return { ok: false, instance: inst, error: w.error };
    return { ok: true, instance: inst, created, updated: !created };
  }

  function artifactsDir() {
    if (typeof host.resolveL3ArtifactsDir !== "function") return null;
    return host.resolveL3ArtifactsDir();
  }

  function requireApp(appId) {
    const dir = artifactsDir();
    if (!dir) return { error: "No L3 artifact store on this host (l3-artifacts/ missing)" };
    const c = loadCatalog(dir);
    if (!c.ok) return { error: c.error };
    const app = c.catalog.apps.find((a) => a.id === appId);
    if (!app) return { error: `unknown app id '${appId}'` };
    return { dir, app, catalog: c.catalog };
  }

  function phase(appId, cfApp, step, state, detail) {
    send("l3:phase", { appId, cfApp, step, state, detail: detail || null });
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
   * it. Also emits the l3:phase error event with the detail.
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
   * of this session learns it from the `l3:running` event, and any page can
   * ask with `l3:running` or read `running` from `l3:status`.
   */
  async function exclusive(action, appId, fn) {
    const busy = runningAction();
    if (busy) {
      const error =
        `${busy.action} of ${busy.appId} is already running (started ${agoText(Date.now() - busy.startedAt)} ago) — ` +
        "wait until it finishes. Two deploys at the same time overwrite the package Cloud Foundry is staging, " +
        "and both fail.";
      log("l3", "err", `${action} ${appId} refused: ${error}`);
      return { ok: false, busy: true, running: busy, error };
    }
    currentAction = { action, appId, startedAt: Date.now() };
    send("l3:running", runningAction());
    try {
      return await fn();
    } finally {
      currentAction = null;
      send("l3:running", null);
    }
  }

  /**
   * Deploy one catalog cfApp: fresh install (push --no-start, bind, env,
   * start) or in-place update (env refresh, push). Returns { ok } or
   * { ok:false, error, step, cfApp, command?, detail? }.
   */
  async function deployPart(app, cfApp, channelDir) {
    const name = cfApp.name;

    // Verify the artifact against its release checksum BEFORE extracting.
    if (cfApp.sha256) {
      const zipPath = path.join(channelDir, cfApp.artifact);
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
    const workDir = path.join(host.getUserDataDir(), "l3-apps", app.id, name);
    try {
      await removeTree(workDir);
      await extractZip(path.join(channelDir, cfApp.artifact), workDir);
      await normalizeTreePerms(workDir);
    } catch (e) {
      phase(app.id, name, "extract", "error", e.message);
      return { ok: false, error: `extract ${cfApp.artifact} failed: ${e.message}`, step: "extract", cfApp: name };
    }
    phase(app.id, name, "extract", "ok");

    const fresh = !(await cfAppExists(name));

    if (fresh) {
      phase(app.id, name, "push", "running");
      const pushArgs = buildPushArgs(cfApp, workDir, { noStart: true });
      let r = await run(resolveCf(), pushArgs, { source: "cf" });
      if (r.code !== 0) return stepFailure(app, cfApp, "push", r, `cf push ${name} failed`, `cf ${pushArgs.join(" ")}`);
      phase(app.id, name, "push", "ok");

      phase(app.id, name, "bind", "running");
      for (const s of cfApp.services || []) {
        const bindArgs = ["bind-service", name, s];
        r = await run(resolveCf(), bindArgs, { source: "cf" });
        if (r.code !== 0) {
          return stepFailure(app, cfApp, "bind", r, `bind-service ${s} failed — does the service instance exist in this space?`, `cf ${bindArgs.join(" ")}`);
        }
      }
      for (const s of cfApp.optionalServices || []) {
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
  }

  /**
   * Catalog v3 guard: every REQUIRED service instance (any name in a cfApp's
   * `services`) must exist before a deploy starts — a clear early error
   * instead of `bind-service` failing halfway through.
   */
  async function missingRequiredServices(catalog, app) {
    const platform = platformPseudoApp(catalog);
    const names = new Set();
    for (const c of [...(platform ? platform.cfApps : []), ...app.cfApps]) {
      for (const s of c.services || []) names.add(s);
    }
    const missing = [];
    for (const name of names) {
      const r = await run(resolveCf(), ["service", name], { source: "cf", quiet: true });
      if (r.code !== 0) missing.push(name);
    }
    return missing;
  }

  async function deployAll(appId) {
    const req = requireApp(appId);
    if (req.error) return { ok: false, error: req.error };
    if (Array.isArray(req.catalog.services)) {
      const missing = await missingRequiredServices(req.catalog, req.app);
      if (missing.length) {
        return {
          ok: false,
          error: `required service instance(s) missing: ${missing.join(", ")} — create them first (Setup, step 3)`,
        };
      }
    }
    // One XSUAA instance (decision 0009): refresh its roles from the release
    // before anything is deployed, so a new app's role collections exist when
    // its frontend starts. Update only — a missing instance was reported above.
    if (Array.isArray(req.catalog.services) && req.catalog.services.some((s) => s.offering === "xsuaa")) {
      const x = await ensureXsuaa({ updateOnly: true });
      if (!x.ok) {
        const inst = x.instance || managerXsuaa.SHARED_INSTANCE;
        return { ok: false, error: `role refresh of ${inst} failed: ${x.error}`, step: "roles", cfApp: inst, command: `cf update-service ${inst} -c xs-security.json` };
      }
    }
    // Shared backend FIRST (catalog v2): the shared connector is deployed /
    // updated before any frontend, so the only mixed state that ever exists
    // is "new backend + old frontend" — the state the backward-compatibility
    // gate (decision 0005) covers. Idempotent: an already-current connector
    // is simply pushed again (same as the app "Re-deploy").
    const platform = platformPseudoApp(req.catalog);
    if (platform) {
      for (const cfApp of platform.cfApps) {
        const r = await deployPart(platform, cfApp, req.dir);
        if (!r.ok) return { ...r, failedApp: cfApp.name };
      }
    }
    for (const cfApp of req.app.cfApps) {
      const r = await deployPart(req.app, cfApp, req.dir);
      if (!r.ok) return { ...r, failedApp: cfApp.name };
    }
    return { ok: true, version: req.app.version };
  }

  /** stop/start/delete every CF app of a catalog app. Reverse order for teardown. */
  async function forEachPart(appId, argsFor, { reverse } = {}) {
    const req = requireApp(appId);
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

  /** l3:configure body — see the handler. */
  async function configure(appId, env) {
    const req = requireApp(appId);
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
   * Every state-changing action ends with ONE clear line in the terminal
   * drawer: green "done" or red "FAILED at step … (cf app): what cf said".
   * The RPC result carries the same facts for the console's outcome panel.
   */
  function reportOutcome(action, appId, r) {
    if (r && r.ok) {
      log("l3", "ok", `${action} ${appId}: done`);
    } else {
      const where = [r && r.step ? `at step "${r.step}"` : "", r && r.cfApp ? `(${r.cfApp})` : ""].filter(Boolean).join(" ");
      log("l3", "err", `${action} ${appId} FAILED${where ? " " + where : ""}: ${(r && r.error) || "unknown error"}`);
    }
    return r;
  }

  /**
   * Create every MISSING catalog service, then wait until all are ready.
   * plans: optional { <name>: <plan> } overrides, validated against the
   * catalog's allowed plans. only: optional list of service names that
   * restricts the run. waitOnly: optional list of names to WAIT for; the
   * other created instances are started and reported as `pending` (Setup
   * step 1 starts the database and moves on - it takes minutes and nothing
   * in that step needs it). Progress lines go to the terminal drawer.
   */
  async function provisionServices({ plans, only, waitOnly } = {}) {
      const dir = artifactsDir();
      if (!dir) return { ok: false, error: "No L3 artifact store on this host" };
      const c = loadCatalog(dir);
      if (!c.ok) return c;
      let declared = c.catalog.services || [];
      if (Array.isArray(only)) declared = declared.filter((s) => only.includes(s.name));
      if (declared.length === 0) {
        return { ok: true, created: [], note: Array.isArray(only) ? "nothing to create for the requested services" : "this release declares no services" };
      }

      const created = [];
      const failed = [];
      for (const s of declared) {
        const probe = await run(resolveCf(), ["service", s.name], { source: "cf", quiet: true });
        if (probe.code === 0) {
          // Exists. A FAILED instance blocks re-creation under the same name;
          // remove it and create again (the admin already asked to provision).
          if (serviceStatusFromCf(probe.code, probe.stdout) !== "failed") continue;
          log("l3", "warn", `${s.name} is in a failed state — deleting it before creating again`);
          const del = await run(resolveCf(), ["delete-service", s.name, "-f"], { source: "cf" });
          if (del.code !== 0) { failed.push({ name: s.name, error: `could not delete the failed instance: ${cfTail(del)}` }); continue; }
          // Deletion is asynchronous — wait until the name is free.
          const gone = Date.now() + PROVISION_TIMEOUT_MS;
          while ((await run(resolveCf(), ["service", s.name], { source: "cf", quiet: true })).code === 0) {
            if (Date.now() > gone) break;
            await sleep(POLL_MS);
          }
        }
        const allowed = s.plans || [s.plan];
        const plan = (plans && plans[s.name]) || s.plan;
        if (!allowed.includes(plan)) {
          failed.push({ name: s.name, error: `plan '${plan}' is not allowed for ${s.name} (allowed: ${allowed.join(", ")})` });
          continue;
        }
        const args = ["create-service", s.offering, plan, s.name];
        if (s.offering === "xsuaa") {
          // One XSUAA instance for the manager and the apps (decision 0009):
          // always the composed document (release part + manager part).
          const cfg = await composedXsuaaConfig(dir, c.catalog);
          if (!cfg.ok) { failed.push({ name: s.name, error: cfg.error }); continue; }
          args.push("-c", cfg.path);
        } else if (s.configFile) {
          const file = path.join(dir, s.configFile);
          if (!fs.existsSync(file)) { failed.push({ name: s.name, error: `config file ${s.configFile} missing from the release` }); continue; }
          let cfgPath = file;
          const text = fs.readFileSync(file, "utf8");
          if (text.includes(APPS_DOMAIN_PLACEHOLDER)) {
            const dom = await resolveAppsDomain();
            if (!dom.ok) { failed.push({ name: s.name, error: dom.error }); continue; }
            const cfgDir = path.join(host.getUserDataDir(), "l3-services");
            fs.mkdirSync(cfgDir, { recursive: true });
            cfgPath = path.join(cfgDir, s.configFile);
            fs.writeFileSync(cfgPath, text.split(APPS_DOMAIN_PLACEHOLDER).join(dom.domain));
            log("l3", "dim", `${s.configFile}: ${APPS_DOMAIN_PLACEHOLDER} -> ${dom.domain}`);
          }
          args.push("-c", cfgPath);
        } else if (s.config && typeof s.config === "object") {
          // cf -c accepts a file path; never pass JSON on the command line.
          const cfgDir = path.join(host.getUserDataDir(), "l3-services");
          fs.mkdirSync(cfgDir, { recursive: true });
          const file = path.join(cfgDir, `${s.name}.json`);
          fs.writeFileSync(file, JSON.stringify(s.config));
          args.push("-c", file);
        }
        log("l3", "line", `Creating service instance ${s.name} (${s.offering} / ${plan}) …`);
        const r = await run(resolveCf(), args, { source: "cf" });
        if (r.code !== 0) { failed.push({ name: s.name, error: `cf create-service ${s.name} failed: ${cfTail(r)}` }); continue; }
        created.push(s.name);
      }

      // Wait for asynchronous creations (PostgreSQL takes minutes). With
      // waitOnly, the other instances are probed once and reported as pending.
      const candidates = declared.filter((s) => !failed.some((f) => f.name === s.name)).map((s) => s.name);
      const toWait = Array.isArray(waitOnly) ? candidates.filter((n) => waitOnly.includes(n)) : candidates;
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
      if (pending.length) log("l3", "line", `${pending.join(", ")}: still being created — not waited for, see Setup step 3`);
      const ok = failed.length === 0 && timedOut.length === 0;
      return {
        ok, created, failed, timedOut, pending,
        error: ok ? undefined :
          [failed.map((f) => `${f.name}: ${f.error}`).join("; "), timedOut.length ? `still not ready: ${timedOut.join(", ")}` : ""]
            .filter(Boolean).join(" | "),
      };
  }

  async function bindManagerService(name) {
      const dir = artifactsDir();
      if (!dir) return { ok: false, error: "No L3 artifact store on this host" };
      const c = loadCatalog(dir);
      if (!c.ok) return c;
      const s = (c.catalog.services || []).find((x) => x.name === name);
      if (!s || !s.bindToManager) return { ok: false, error: `${name || "?"} is not a manager-bound service in this release` };
      const self = selfAppName();
      if (!self) return { ok: false, error: "cannot determine the manager's own app name (not running in CF?)" };
      const r = await run(resolveCf(), ["bind-service", self, name], { source: "cf" });
      if (r.code !== 0) return { ok: false, error: `cf bind-service ${self} ${name} failed` };
      return { ok: true, restartRequired: true, note: `${name} is bound to ${self}; the binding becomes active after a restart of the manager` };
  }

  return {
    async "l3:catalog"() {
      const dir = artifactsDir();
      if (!dir) return { ok: false, error: "No L3 artifact store on this host (l3-artifacts/ missing)" };
      const c = loadCatalog(dir);
      if (!c.ok) return c;
      const platform = platformPseudoApp(c.catalog);
      return {
        ok: true,
        // releaseVersion is the name; releases built before 2026-09-01 carry
        // only the legacy field channelVersion (kept as a read fallback).
        releaseVersion: c.catalog.releaseVersion || c.catalog.channelVersion || null,
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
      };
    },

    async "l3:status"() {
      const dir = artifactsDir();
      if (!dir) return { ok: false, error: "No L3 artifact store on this host" };
      const c = loadCatalog(dir);
      if (!c.ok) return c;

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
      return { ok: true, platform: platformRow, apps, running };
    },

    /**
     * Catalog v3: the service instances the platform needs, with their live
     * state. `boundToManager` is filled for bindToManager entries (a binding
     * exists in CF; it is effective in THIS process only after a restart —
     * the renderer combines it with login:storedUserStatus.bindingPresent).
     */
    async "l3:services"() {
      const dir = artifactsDir();
      if (!dir) return { ok: false, error: "No L3 artifact store on this host" };
      const c = loadCatalog(dir);
      if (!c.ok) return c;
      const self = selfAppName();
      const services = [];
      for (const s of c.catalog.services || []) {
        const r = await run(resolveCf(), ["service", s.name], { source: "cf", quiet: true });
        const status = serviceStatusFromCf(r.code, r.stdout);
        let boundToManager = null;
        if (s.bindToManager && self && status !== "missing") {
          const b = await run(resolveCf(), ["curl", `/v3/service_credential_bindings?type=app&service_instance_names=${s.name}&app_names=${self}`], { source: "cf", quiet: true });
          if (b.code === 0) { try { boundToManager = (JSON.parse(b.stdout).resources || []).length > 0; } catch {} }
        }
        services.push({
          name: s.name, offering: s.offering, plan: s.plan, plans: s.plans || [s.plan],
          purpose: s.purpose || "", bindToManager: !!s.bindToManager,
          exists: status !== "missing", status, boundToManager,
        });
      }
      return { ok: true, selfApp: self, services };
    },

    /**
     * Create every MISSING catalog service, then wait until all are ready.
     * plans: optional { <name>: <plan> } overrides, validated against the
     * catalog's allowed plans. Progress lines go to the terminal drawer.
     */
    async "l3:provisionServices"(args) {
      return provisionServices(args || {});
    },

    /**
     * Make the shared XSUAA instance carry the current roles of the manager
     * and the apps (create or update, decision 0009). See ensureXsuaa().
     */
    async "l3:ensureXsuaa"(args) {
      return ensureXsuaa(args || {});
    },

    /**
     * Legacy (wizard frame only): create the release's manager-bound
     * services (the Credential Store) when missing and bind them to the
     * manager — WITHOUT a restart. The restage at the end of the SSO upgrade
     * activates the binding, so the management user can be stored right after
     * the IAS sign-in and no second passcode is needed.
     */
    async "l3:prepareManagerServices"({ plans } = {}) {
      const dir = artifactsDir();
      if (!dir) return { ok: true, created: [], bound: [], note: "no release on this host - nothing to prepare" };
      const c = loadCatalog(dir);
      if (!c.ok) return c;
      const targets = (c.catalog.services || []).filter((s) => s.bindToManager);
      if (!targets.length) return { ok: true, created: [], bound: [], note: "this release declares no manager-bound service" };
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
     * Setup step 1 "Prepare the space" (docs/l3-console/SPEC.md 5.2): create every
     * MISSING catalog instance except the XSUAA one (l3:ensureXsuaa owns it)
     * with the plans the person chose on the page, wait only for the
     * manager-bound ones (the Credential Store) and bind them to the manager
     * - no restart; the restage at the end of the step activates the binding.
     * The database is only STARTED: it takes minutes and nothing in this step
     * needs it, so it finishes in the background while the person signs in
     * with IAS and stores the management user (Setup step 3 shows it).
     * Result: { ok, created, bound, pending, failed, error?, note? }.
     */
    async "l3:prepareSpaceServices"({ plans } = {}) {
      const dir = artifactsDir();
      if (!dir) return { ok: true, created: [], bound: [], pending: [], failed: [], note: "no release on this host - nothing to prepare" };
      const c = loadCatalog(dir);
      if (!c.ok) return c;
      const targets = (c.catalog.services || []).filter((s) => s.offering !== "xsuaa");
      if (!targets.length) return { ok: true, created: [], bound: [], pending: [], failed: [], note: "this release declares no service instances besides XSUAA" };
      const toBind = targets.filter((s) => s.bindToManager);
      const self = selfAppName();
      if (toBind.length && !self) return { ok: false, error: "cannot determine the manager's own app name (not running in CF?)" };
      const prov = await provisionServices({ plans, only: targets.map((s) => s.name), waitOnly: toBind.map((s) => s.name) });
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

    /** Bind a bindToManager catalog service to the manager app itself. */
    async "l3:bindManagerService"({ name } = {}) {
      return bindManagerService(name);
    },

    /**
     * Restart the manager itself so new bindings take effect. Fire-and-forget:
     * this process is stopped by the restart, so the command never "returns".
     */
    async "l3:restartSelf"() {
      const self = selfAppName();
      if (!self) return { ok: false, error: "cannot determine the manager's own app name (not running in CF?)" };
      log("l3", "warn", `Restarting ${self} — this session ends; reload the page in ~30 s (token mode: claim a new token from the logs).`);
      run(resolveCf(), ["restart", self], { source: "cf" }).catch(() => {});
      return { ok: true, note: "restart started" };
    },

    /**
     * What lifecycle action is running now, for a page that did not start it
     * (a reload, a second tab, a second session). `{ ok:true, running:null }`
     * = nothing is running. No cf call.
     */
    async "l3:running"() {
      return { ok: true, running: runningAction() };
    },

    async "l3:install"({ appId } = {}) {
      if (!appId) return { ok: false, error: "appId required" };
      return exclusive("install", appId, async () => {
        log("l3", "line", `Installing ${appId} …`);
        return reportOutcome("install", appId, await deployAll(appId));
      });
    },

    async "l3:update"({ appId } = {}) {
      if (!appId) return { ok: false, error: "appId required" };
      return exclusive("update", appId, async () => {
        log("l3", "line", `Updating ${appId} …`);
        return reportOutcome("update", appId, await deployAll(appId));
      });
    },

    async "l3:disable"({ appId } = {}) {
      if (!appId) return { ok: false, error: "appId required" };
      return exclusive("disable", appId, async () =>
        reportOutcome("disable", appId, await forEachPart(appId, (c) => ["stop", c.name], { reverse: true })));
    },

    async "l3:enable"({ appId } = {}) {
      if (!appId) return { ok: false, error: "appId required" };
      return exclusive("enable", appId, async () =>
        reportOutcome("enable", appId, await forEachPart(appId, (c) => ["start", c.name])));
    },

    async "l3:remove"({ appId } = {}) {
      if (!appId) return { ok: false, error: "appId required" };
      return exclusive("remove", appId, async () =>
        reportOutcome("remove", appId, await forEachPart(appId, (c) => ["delete", c.name, "-f"], { reverse: true })));
    },

    /**
     * Discover Figaf Tool deployments visible to the current cf login, so the
     * Configure form can offer them as a dropdown instead of a typed URL.
     * Detection (same as the manager's Update flow): app pairs `X-app` +
     * `X-router` where X-app runs a `figaf/app:*` Docker image. The URL an L3
     * app needs is the ROUTER's route. Note: visibility follows the cf login —
     * a single-space technical user only sees its own space; the form keeps
     * manual URL entry as the fallback.
     */
    async "l3:figafSystems"() {
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
    async "l3:configure"({ appId, env } = {}) {
      if (!appId) return { ok: false, error: "appId required" };
      return exclusive("configure", appId, () => configure(appId, env));
    },

    async "l3:health"({ appId } = {}) {
      const req = requireApp(appId);
      if (req.error) return { ok: false, error: req.error };
      if (!req.app.healthPath) return { ok: false, error: "app declares no healthPath" };
      const target = req.app.configTargetCfApp || req.app.cfApps[0].name;
      const base = await routeUrl(target);
      if (!base) return { ok: false, error: `${target} has no route — is it deployed?` };
      const url = base + req.app.healthPath;
      log("l3", "line", `GET ${url}`);
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
  createL3Handlers,
};
