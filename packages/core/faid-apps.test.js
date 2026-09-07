"use strict";
// Tests for the FAID Apps manager (faid-apps.js).
//
// Coverage:
//   A. Pure helpers: loadCatalog validation, computeAppStatus rollup,
//      buildPushArgs, buildDestinationsEnv, validateConfigEnv whitelist.
//   B. Handler flows with an injected fake `run` recorder (no processes):
//      - faid:install happy path — command order per CF app:
//        push --no-start → bind-service (required + optional-if-present)
//        → set-env (masked) → start; frontend gets a destinations env
//        pointing at the backend route.
//      - required bind failure aborts the install.
//      - faid:configure — whitelist enforced, values masked in logCmd/auditArgs,
//        restart follows, unknown key rejected.
//      - faid:disable stops in reverse order; faid:remove deletes in reverse order.
//      - faid:status maps /v3 responses to app status + installed version,
//        reports the in-flight action and marks a part that is staging.
//      - one lifecycle action at a time: a second install is refused and
//        pushes nothing; the lock is released after a failure too.
//      - faid:health hits <route><healthPath> via httpsText.

const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  VERSION_ENV,
  APPS_DOMAIN_PLACEHOLDER,
  runningAction,
  resetRunningAction,
  loadCatalog,
  computeAppStatus,
  buildDestinationsEnv,
  buildPushArgs,
  validateConfigEnv,
  serviceStatusFromCf,
  wantedService,
  createFaidHandlers,
} = require("./faid-apps");

// ─── fixtures ────────────────────────────────────────────────────────────────

// Catalog v2: the shared backend connector lives in the `platform` block;
// the app entry holds only its frontend. configTargetCfApp points config and
// health at the connector.
const CATALOG = {
  releaseVersion: "0.2.0",
  platform: {
    name: "Platform base",
    cfApps: [
      {
        name: "arch-backend", artifact: "backend.zip", buildpack: "nodejs_buildpack",
        memory: "256M", disk: "1024M",
        services: ["db", "xsuaa"], optionalServices: ["credstore"],
        env: { FIGAF_PAGE_SIZE: "200" },
      },
    ],
  },
  apps: [
    {
      id: "arch",
      name: "B2B Archiving Setup",
      version: "0.2.0",
      cfApps: [
        {
          name: "arch-frontend", artifact: "frontend.zip", buildpack: "nodejs_buildpack",
          memory: "128M", disk: "512M",
          services: ["xsuaa"],
          destinationTo: "arch-backend", destinationName: "figaf-b2b-gov-backend",
        },
      ],
      configTargetCfApp: "arch-backend",
      configForm: [
        { key: "FIGAF_BASE_URL", secret: false },
        { key: "FIGAF_API_CLIENT_SECRET", secret: true },
      ],
      healthPath: "/health/connections",
    },
  ],
};

function makeChannelDir(catalog = CATALOG) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "faid-test-"));
  fs.writeFileSync(path.join(dir, "catalog.json"), JSON.stringify(catalog));
  fs.writeFileSync(path.join(dir, "backend.zip"), "zip");
  fs.writeFileSync(path.join(dir, "frontend.zip"), "zip");
  return dir;
}

/**
 * Fake ctx for createFaidHandlers. `responses` maps a predicate over the args
 * array to a canned { code, stdout }. Calls are recorded in `calls`
 * ({ args, opts }); log lines in `logLines`.
 */
function makeCtx(channelDir, respond) {
  const calls = [];
  const logLines = [];
  const events = [];
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "faid-user-"));
  return {
    calls, logLines, events,
    ctx: {
      host: {
        isHosted: true,
        getUserDataDir: () => userDir,
        // A local release directory is the development source (decision 0010).
        resolveFaidReleaseSource: () => (channelDir ? { kind: "local", dir: channelDir } : null),
      },
      run: async (cmd, args, opts = {}) => {
        calls.push({ cmd, args, opts });
        logLines.push(opts.logCmd || `${cmd} ${args.join(" ")}`);
        return respond(args, opts) || { code: 0, stdout: "", stderr: "" };
      },
      log: (source, type, text) => logLines.push(text),
      send: (channel, payload) => events.push({ channel, payload }),
      resolveCf: () => "cf",
      extractZip: async () => {},
      httpsText: async (url) => { events.push({ channel: "httpsText", payload: url }); return "{\"ok\":true}"; },
      // health endpoints return diagnostics WITH non-2xx statuses; the ctx
      // fetcher must hand back both. Tests override `httpsBodyResult`.
      httpsBody: async (url) => {
        events.push({ channel: "httpsBody", payload: url });
        return httpsBodyResult;
      },
    },
  };
}

let httpsBodyResult = { status: 200, body: "{\"ok\":true}" };

// ─── A. pure helpers ─────────────────────────────────────────────────────────

test("loadCatalog: accepts a valid catalog", () => {
  const dir = makeChannelDir();
  const r = loadCatalog(dir);
  assert.equal(r.ok, true);
  assert.equal(r.catalog.apps[0].id, "arch");
});

test("loadCatalog: missing file / bad JSON / missing fields are rejected", () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "faid-empty-"));
  assert.equal(loadCatalog(empty).ok, false);

  const badJson = fs.mkdtempSync(path.join(os.tmpdir(), "faid-bad-"));
  fs.writeFileSync(path.join(badJson, "catalog.json"), "{nope");
  assert.equal(loadCatalog(badJson).ok, false);

  const noApps = fs.mkdtempSync(path.join(os.tmpdir(), "faid-noapps-"));
  fs.writeFileSync(path.join(noApps, "catalog.json"), JSON.stringify({ apps: [{ id: "x", version: "1", cfApps: [] }] }));
  assert.equal(loadCatalog(noApps).ok, false);
});

test("computeAppStatus rollup", () => {
  assert.equal(computeAppStatus([{ exists: false }, { exists: false }]), "not-installed");
  assert.equal(computeAppStatus([{ exists: true, state: "STARTED" }, { exists: false }]), "partial");
  assert.equal(computeAppStatus([{ exists: true, state: "STARTED" }, { exists: true, state: "STARTED" }]), "running");
  assert.equal(computeAppStatus([{ exists: true, state: "STOPPED" }, { exists: true, state: "STOPPED" }]), "stopped");
  assert.equal(computeAppStatus([{ exists: true, state: "STARTED" }, { exists: true, state: "STOPPED" }]), "mixed");
});

test("buildPushArgs / buildDestinationsEnv", () => {
  const args = buildPushArgs(CATALOG.platform.cfApps[0], "/tmp/x", { noStart: true });
  assert.deepEqual(args, ["push", "arch-backend", "-p", "/tmp/x", "--no-manifest", "-b", "nodejs_buildpack", "-m", "256M", "-k", "1024M", "--no-start"]);
  const dest = JSON.parse(buildDestinationsEnv("figaf-b2b-gov-backend", "https://x.example"));
  assert.deepEqual(dest, [{ name: "figaf-b2b-gov-backend", url: "https://x.example", forwardAuthToken: true }]);
});

test("validateConfigEnv: whitelist, empty-skip, type and length checks", () => {
  const app = CATALOG.apps[0];
  const ok = validateConfigEnv(app, { FIGAF_BASE_URL: "https://f", FIGAF_API_CLIENT_SECRET: "s3cret", });
  assert.equal(ok.ok, true);
  assert.equal(ok.entries.length, 2);
  assert.equal(ok.entries.find(e => e.key === "FIGAF_API_CLIENT_SECRET").secret, true);

  assert.equal(validateConfigEnv(app, { NOT_ALLOWED: "x" }).ok, false);
  assert.equal(validateConfigEnv(app, { FIGAF_BASE_URL: 42 }).ok, false);
  assert.equal(validateConfigEnv(app, { FIGAF_BASE_URL: "x".repeat(5000) }).ok, false);

  const skip = validateConfigEnv(app, { FIGAF_BASE_URL: "" });
  assert.equal(skip.ok, true);
  assert.equal(skip.entries.length, 0);
});

// ─── B. handler flows ────────────────────────────────────────────────────────

test("faid:install: full command sequence, optional bind skipped when absent, destinations env set", async () => {
  const dir = makeChannelDir();
  const { ctx, calls, logLines } = makeCtx(dir, (args) => {
    if (args[0] === "app" && args[1] === "arch-backend" && args[2] === "--guid") return { code: 1, stdout: "" }; // fresh
    if (args[0] === "app" && args[1] === "arch-frontend" && args[2] === "--guid") return { code: 1, stdout: "" };
    if (args[0] === "service" && args[1] === "credstore") return { code: 1, stdout: "" }; // optional absent
    if (args[0] === "app" && args[1] === "arch-backend") return { code: 0, stdout: "name: arch-backend\nroutes:   arch-backend.cfapps.eu10.hana.ondemand.com\n" };
    return { code: 0, stdout: "" };
  });
  const handlers = createFaidHandlers(ctx);
  const r = await handlers["faid:install"]({ appId: "arch" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.version, "0.2.0");

  const seq = calls.map((c) => c.args.slice(0, 2).join(" "));
  // backend: push --no-start … bind db, bind xsuaa, (probe credstore), env×2, start
  assert.ok(seq.includes("push arch-backend"));
  assert.ok(seq.includes("bind-service arch-backend"));
  assert.ok(seq.includes("start arch-backend"));
  // optional service absent → no bind of credstore
  assert.ok(!calls.some((c) => c.args[0] === "bind-service" && c.args[2] === "credstore"));
  // version stamp on both apps
  const stamps = calls.filter((c) => c.args[0] === "set-env" && c.args[2] === VERSION_ENV);
  assert.equal(stamps.length, 2);
  assert.equal(stamps[0].args[3], "0.2.0");
  // frontend destinations env carries the backend route
  const destSet = calls.find((c) => c.args[0] === "set-env" && c.args[1] === "arch-frontend" && c.args[2] === "destinations");
  assert.ok(destSet, "destinations env must be set on the frontend");
  assert.match(destSet.args[3], /arch-backend\.cfapps\.eu10/);
  // backend pushed before frontend
  assert.ok(seq.indexOf("push arch-backend") < seq.indexOf("push arch-frontend"));
  // env values are masked in the terminal stream
  assert.ok(logLines.some((l) => /set-env .*<value hidden>/.test(l)));
  assert.ok(!logLines.some((l) => l.includes("cfapps.eu10") && l.startsWith("cf set-env")));
});

test("faid:install: required bind failure aborts with an error", async () => {
  const dir = makeChannelDir();
  const { ctx, calls } = makeCtx(dir, (args) => {
    if (args[0] === "app" && args[2] === "--guid") return { code: 1, stdout: "" };
    if (args[0] === "bind-service" && args[2] === "db") return { code: 1, stdout: "", stderr: "not found" };
    return { code: 0, stdout: "" };
  });
  const handlers = createFaidHandlers(ctx);
  const r = await handlers["faid:install"]({ appId: "arch" });
  assert.equal(r.ok, false);
  assert.match(r.error, /bind-service db failed/);
  assert.equal(r.failedApp, "arch-backend");
  // frontend never touched
  assert.ok(!calls.some((c) => c.args.includes("arch-frontend")));
});

test("faid:update on an existing app: set-env then push (no --no-start, no bind)", async () => {
  const dir = makeChannelDir();
  const { ctx, calls } = makeCtx(dir, (args) => {
    if (args[0] === "app" && args[2] === "--guid") return { code: 0, stdout: "guid" }; // exists
    if (args[0] === "app" && args[1] === "arch-backend") return { code: 0, stdout: "routes:   b.example.com\n" };
    return { code: 0, stdout: "" };
  });
  const handlers = createFaidHandlers(ctx);
  const r = await handlers["faid:update"]({ appId: "arch" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(!calls.some((c) => c.args.includes("--no-start")));
  assert.ok(!calls.some((c) => c.args[0] === "bind-service"));
  assert.ok(calls.some((c) => c.args[0] === "push" && c.args[1] === "arch-backend"));
});

test("faid:configure: masked set-env + restart; unknown key rejected; not-deployed rejected", async () => {
  const dir = makeChannelDir();
  let exists = true;
  const { ctx, calls, logLines } = makeCtx(dir, (args) => {
    if (args[0] === "app" && args[2] === "--guid") return { code: exists ? 0 : 1, stdout: "" };
    return { code: 0, stdout: "" };
  });
  const handlers = createFaidHandlers(ctx);

  const r = await handlers["faid:configure"]({ appId: "arch", env: { FIGAF_API_CLIENT_SECRET: "super-secret" } });
  assert.equal(r.ok, true);
  assert.equal(r.applied, 1);
  const setCall = calls.find((c) => c.args[0] === "set-env");
  assert.equal(setCall.args[3], "super-secret");                       // real value reaches cf
  assert.ok(!logLines.some((l) => l.includes("super-secret")));        // …but never the terminal
  assert.deepEqual(setCall.opts.auditArgs.slice(-1), ["<value hidden>"]); // …or the audit log
  assert.ok(calls.some((c) => c.args[0] === "restart" && c.args[1] === "arch-backend"));

  const bad = await handlers["faid:configure"]({ appId: "arch", env: { EVIL: "x" } });
  assert.equal(bad.ok, false);

  exists = false;
  const notDeployed = await handlers["faid:configure"]({ appId: "arch", env: { FIGAF_BASE_URL: "https://x" } });
  assert.equal(notDeployed.ok, false);
  assert.match(notDeployed.error, /not deployed/);
});

test("faid:disable / faid:remove touch ONLY the app's own CF apps — the shared platform stays", async () => {
  const dir = makeChannelDir();
  const { ctx, calls } = makeCtx(dir, () => ({ code: 0, stdout: "" }));
  const handlers = createFaidHandlers(ctx);

  await handlers["faid:disable"]({ appId: "arch" });
  const stops = calls.filter((c) => c.args[0] === "stop").map((c) => c.args[1]);
  assert.deepEqual(stops, ["arch-frontend"]);

  calls.length = 0;
  await handlers["faid:remove"]({ appId: "arch" });
  const dels = calls.filter((c) => c.args[0] === "delete").map((c) => c.args[1]);
  assert.deepEqual(dels, ["arch-frontend"]);
  assert.ok(calls.every((c) => c.args[0] !== "delete" || c.args[2] === "-f"));
  // Read-only probes (the installed-version lookup asks `cf app arch-backend
  // --guid`) are fine; no state-changing command may name the connector.
  const mutating = calls.filter((c) => ["stop", "start", "delete", "push", "restart"].includes(c.args[0]));
  assert.ok(!mutating.some((c) => c.args.includes("arch-backend")), "the platform connector must never be stopped/deleted by app actions");
});

test("faid:status: rolls up states, reads FIGAF_APP_VERSION and routes", async () => {
  const dir = makeChannelDir();
  const { ctx } = makeCtx(dir, (args) => {
    if (args[0] === "target") return { code: 0, stdout: "org: o\nspace: myspace\n" };
    if (args[0] === "space") return { code: 0, stdout: "space-guid-1\n" };
    if (args[0] === "curl" && /\/v3\/apps\?/.test(args[1])) {
      return { code: 0, stdout: JSON.stringify({ resources: [
        { name: "arch-backend", guid: "g1", state: "STARTED" },
        { name: "arch-frontend", guid: "g2", state: "STARTED" },
      ] }) };
    }
    if (args[0] === "curl" && /\/v3\/apps\/g[12]\/environment_variables$/.test(args[1])) {
      return { code: 0, stdout: JSON.stringify({ var: { [VERSION_ENV]: "0.1.9" } }) };
    }
    if (args[0] === "curl" && /routes$/.test(args[1])) {
      return { code: 0, stdout: JSON.stringify({ resources: [{ url: "arch.example.com" }] }) };
    }
    return { code: 0, stdout: "" };
  });
  const handlers = createFaidHandlers(ctx);
  const r = await handlers["faid:status"]();
  assert.equal(r.ok, true, JSON.stringify(r));
  // catalog v2: the connector is its own platform row; the app row holds the frontend
  assert.equal(r.platform.status, "running");
  assert.equal(r.platform.installedVersion, "0.1.9");
  assert.equal(r.platform.parts[0].name, "arch-backend");
  assert.equal(r.apps[0].status, "running");
  assert.equal(r.apps[0].installedVersion, "0.1.9");
  assert.equal(r.apps[0].catalogVersion, "0.2.0");
  assert.equal(r.apps[0].parts[0].name, "arch-frontend");
  assert.equal(r.apps[0].parts[0].route, "arch.example.com");
});

test("faid:install verifies artifact checksums when the catalog carries them", async () => {
  const crypto = require("node:crypto");
  const goodSha = crypto.createHash("sha256").update("zip").digest("hex"); // fixture zips contain "zip"
  const withSha = JSON.parse(JSON.stringify(CATALOG));
  withSha.platform.cfApps[0].sha256 = goodSha;
  withSha.apps[0].cfApps[0].sha256 = "0".repeat(64); // wrong on purpose
  const dir = makeChannelDir(withSha);
  const { ctx, calls } = makeCtx(dir, (args) => {
    if (args[0] === "app" && args[2] === "--guid") return { code: 1, stdout: "" };
    if (args[0] === "service") return { code: 1, stdout: "" };
    if (args[0] === "app" && args[1] === "arch-backend") return { code: 0, stdout: "routes:   b.example.com\n" };
    return { code: 0, stdout: "" };
  });
  const handlers = createFaidHandlers(ctx);
  const r = await handlers["faid:install"]({ appId: "arch" });
  assert.equal(r.ok, false);
  assert.match(r.error, /checksum mismatch for frontend.zip/);
  // the platform (good checksum) deployed; the frontend was stopped BEFORE any push
  assert.ok(calls.some((c) => c.args[0] === "push" && c.args[1] === "arch-backend"));
  assert.ok(!calls.some((c) => c.args[0] === "push" && c.args[1] === "arch-frontend"));
});

test("faid:health: GETs route + healthPath and parses JSON", async () => {
  const dir = makeChannelDir();
  const { ctx, events } = makeCtx(dir, (args) => {
    if (args[0] === "app" && args[1] === "arch-backend") return { code: 0, stdout: "routes:   arch.example.com\n" };
    return { code: 0, stdout: "" };
  });
  const handlers = createFaidHandlers(ctx);

  httpsBodyResult = { status: 200, body: "{\"ok\":true}" };
  const r = await handlers["faid:health"]({ appId: "arch" });
  assert.equal(r.ok, true);
  assert.equal(r.httpStatus, 200);
  assert.equal(r.url, "https://arch.example.com/health/connections");
  assert.deepEqual(r.body, { ok: true });
  assert.ok(events.some((e) => e.channel === "httpsBody" && e.payload === r.url));

  // 503 with a diagnostic body (unconfigured connections): body must survive.
  httpsBodyResult = { status: 503, body: "{\"ok\":false,\"postgres\":{\"ok\":true}}" };
  const bad = await handlers["faid:health"]({ appId: "arch" });
  assert.equal(bad.ok, false);
  assert.equal(bad.httpStatus, 503);
  assert.deepEqual(bad.body, { ok: false, postgres: { ok: true } });
});

// ─── C. catalog v3: base services ────────────────────────────────────────────

const CATALOG_V3 = {
  ...CATALOG,
  releaseVersion: "0.3.2",
  services: [
    { name: "db", offering: "postgresql-db", plan: "free", plans: ["free", "standard"], purpose: "database" },
    { name: "xsuaa", offering: "xsuaa", plan: "application", configFile: "xs-security.json", purpose: "roles" },
    { name: "credstore", offering: "credstore", plan: "free", config: { authentication: { type: "basic" } }, bindToManager: true },
  ],
};

function makeV3Dir() {
  const dir = makeChannelDir(CATALOG_V3);
  fs.writeFileSync(path.join(dir, "xs-security.json"), "{\"xsappname\":\"figaf-faid\"}");
  return dir;
}

// `cf curl /v3/domains` fake: the landscape has one cfapps domain.
function domainsResponder(args) {
  if (args[0] === "curl" && args[1] === "/v3/domains") {
    return { code: 0, stdout: JSON.stringify({ resources: [{ name: "apps.internal" }, { name: "cfapps.eu10-004.hana.ondemand.com" }] }) };
  }
  return null;
}

// `cf service <name>` fake: names in `existing` report the given status text.
function cfServiceResponder(existing, extra) {
  return (args, opts) => {
    if (args[0] === "service") {
      const st = existing[args[1]];
      return st ? { code: 0, stdout: `name: ${args[1]}\nstatus:    ${st}\n` } : { code: 1, stdout: "", stderr: "not found" };
    }
    return extra ? extra(args, opts) : null;
  };
}

test("serviceStatusFromCf: maps cf service output to one status word", () => {
  assert.equal(serviceStatusFromCf(1, ""), "missing");
  assert.equal(serviceStatusFromCf(0, "status:    create succeeded"), "ready");
  assert.equal(serviceStatusFromCf(0, "status:    update succeeded"), "ready");
  assert.equal(serviceStatusFromCf(0, "status:    create in progress"), "in-progress");
  assert.equal(serviceStatusFromCf(0, "status:    create failed"), "failed");
  assert.equal(serviceStatusFromCf(0, "no status line"), "unknown");
});

test("loadCatalog: v3 services validated (needs name/offering/plan; plans must contain the default)", () => {
  assert.equal(loadCatalog(makeV3Dir()).ok, true);
  const bad1 = makeChannelDir({ ...CATALOG, services: [{ name: "db", offering: "postgresql-db" }] });
  assert.match(loadCatalog(bad1).error, /needs name, offering and plan/);
  const bad2 = makeChannelDir({ ...CATALOG, services: [{ name: "db", offering: "postgresql-db", plan: "free", plans: ["standard"] }] });
  assert.match(loadCatalog(bad2).error, /containing the default plan/);
});

test("faid:services: reports status per service and the manager binding for bindToManager entries", async () => {
  const dir = makeV3Dir();
  const { ctx } = makeCtx(dir, cfServiceResponder(
    { db: "create in progress", credstore: "create succeeded" },
    (args) => (args[0] === "curl" && /service_credential_bindings/.test(args[1]))
      ? { code: 0, stdout: JSON.stringify({ resources: [{ guid: "b1" }] }) } : null
  ));
  ctx.host.getDeployTargetForSelf = () => ({ appName: "figaf-manager", apiUrl: "u", orgName: "o", spaceName: "s" });
  const handlers = createFaidHandlers(ctx);
  const r = await handlers["faid:services"]();
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.selfApp, "figaf-manager");
  const by = Object.fromEntries(r.services.map((s) => [s.name, s]));
  assert.equal(by.db.status, "in-progress");
  assert.equal(by.xsuaa.status, "missing");
  assert.equal(by.credstore.status, "ready");
  assert.equal(by.credstore.boundToManager, true);
  assert.equal(by.db.boundToManager, null); // not a bindToManager entry
  assert.deepEqual(by.db.plans, ["free", "standard"]);
  assert.deepEqual(by.xsuaa.plans, ["application"]); // default when no plans listed
});

test("faid:provisionServices: creates only the missing ones, passes configs as files, honors a plan override, waits until ready", async () => {
  const dir = makeV3Dir();
  const state = { credstore: "create succeeded" }; // db + xsuaa missing
  let polls = 0;
  const { ctx, calls } = makeCtx(dir, (args) => {
    if (domainsResponder(args)) return domainsResponder(args);
    if (args[0] === "create-service") {
      state[args[3]] = "create in progress";
      return { code: 0, stdout: "Create in progress" };
    }
    if (args[0] === "service") {
      const st = state[args[1]];
      if (!st) return { code: 1, stdout: "" };
      // the second poll of an in-progress instance flips it to succeeded
      if (st === "create in progress" && ++polls > 2) state[args[1]] = "create succeeded";
      return { code: 0, stdout: `status:    ${state[args[1]]}\n` };
    }
    return null;
  });
  ctx.sleep = async () => {};
  ctx.pollIntervalMs = 0;
  const handlers = createFaidHandlers(ctx);
  const r = await handlers["faid:provisionServices"]({ plans: { db: "standard" } });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.created.sort(), ["db", "xsuaa"]);
  const creates = calls.filter((c) => c.args[0] === "create-service");
  assert.equal(creates.length, 2);
  const dbCreate = creates.find((c) => c.args[3] === "db");
  assert.deepEqual(dbCreate.args, ["create-service", "postgresql-db", "standard", "db"]);
  const xsCreate = creates.find((c) => c.args[3] === "xsuaa");
  assert.equal(xsCreate.args[4], "-c");
  // decision 0009: the xsuaa config is the COMPOSED document (release + manager part)
  assert.equal(path.basename(xsCreate.args[5]), "xs-security.composed.json");
  assert.ok(fs.existsSync(xsCreate.args[5]), "the composed config file must exist");
  // credstore existed → never re-created
  assert.ok(!creates.some((c) => c.args[3] === "credstore"));
});

test("faid:provisionServices: rejects a plan that the catalog does not allow; inline config written to a file", async () => {
  const dir = makeV3Dir();
  const state = {}; // everything missing
  const { ctx, calls } = makeCtx(dir, (args) => {
    if (domainsResponder(args)) return domainsResponder(args);
    if (args[0] === "create-service") { state[args[3]] = "create succeeded"; return { code: 0, stdout: "" }; }
    if (args[0] === "service") return state[args[1]] ? { code: 0, stdout: `status: ${state[args[1]]}` } : { code: 1, stdout: "" };
    return null;
  });
  ctx.sleep = async () => {};
  const handlers = createFaidHandlers(ctx);
  const r = await handlers["faid:provisionServices"]({ plans: { db: "enterprise" } });
  assert.equal(r.ok, false);
  assert.match(r.error, /plan 'enterprise' is not allowed for db/);
  // the other two were still created
  assert.deepEqual(r.created.sort(), ["credstore", "xsuaa"]);
  const cs = calls.find((c) => c.args[0] === "create-service" && c.args[3] === "credstore");
  assert.equal(cs.args[4], "-c");
  assert.deepEqual(JSON.parse(fs.readFileSync(cs.args[5], "utf8")), { authentication: { type: "basic" } });
});

test("faid:provisionServices: a failed creation is reported, the deadline stops the wait", async () => {
  const dir = makeV3Dir();
  const state = { xsuaa: "create succeeded" };
  const { ctx } = makeCtx(dir, (args) => {
    if (args[0] === "create-service") {
      state[args[3]] = args[3] === "db" ? "create failed" : "create in progress"; // credstore never finishes
      return { code: 0, stdout: "" };
    }
    if (args[0] === "service") return state[args[1]] ? { code: 0, stdout: `status: ${state[args[1]]}` } : { code: 1, stdout: "" };
    return null;
  });
  ctx.sleep = async () => {};
  ctx.pollIntervalMs = 0;
  ctx.provisionTimeoutMs = 0;
  const handlers = createFaidHandlers(ctx);
  const r = await handlers["faid:provisionServices"]({});
  assert.equal(r.ok, false);
  assert.ok(r.failed.some((f) => f.name === "db"));
  assert.deepEqual(r.timedOut, ["credstore"]);
});

test("faid:provisionServices: a FAILED instance is deleted and created again; cf error text is carried", async () => {
  const dir = makeV3Dir();
  const state = { db: "create failed", xsuaa: "create succeeded", credstore: "create succeeded" };
  let deleted = false;
  const { ctx, calls } = makeCtx(dir, (args) => {
    if (args[0] === "delete-service") { deleted = true; delete state[args[1]]; return { code: 0, stdout: "" }; }
    if (args[0] === "create-service") {
      if (args[3] === "db") { state.db = "create succeeded"; return { code: 0, stdout: "" }; }
      return { code: 1, stdout: "", stderr: "Service broker error: plan quota exceeded" };
    }
    if (args[0] === "service") return state[args[1]] ? { code: 0, stdout: `status: ${state[args[1]]}` } : { code: 1, stdout: "" };
    return null;
  });
  ctx.sleep = async () => {};
  ctx.pollIntervalMs = 0;
  const handlers = createFaidHandlers(ctx);
  const r = await handlers["faid:provisionServices"]({});
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(deleted, "the failed instance must be deleted first");
  assert.deepEqual(r.created, ["db"]);
  const order = calls.filter((c) => ["delete-service", "create-service"].includes(c.args[0])).map((c) => c.args[0]);
  assert.deepEqual(order, ["delete-service", "create-service"]);

  // Error text from cf reaches the caller.
  const dir2 = makeV3Dir();
  const { ctx: ctx2 } = makeCtx(dir2, (args) => {
    if (args[0] === "create-service") return { code: 1, stdout: "", stderr: "FAILED\nService broker error: plan quota exceeded" };
    if (args[0] === "service") return { code: 1, stdout: "" };
    return null;
  });
  ctx2.sleep = async () => {};
  const r2 = await createFaidHandlers(ctx2)["faid:provisionServices"]({});
  assert.equal(r2.ok, false);
  assert.match(r2.error, /plan quota exceeded/);
});

test("faid:bindManagerService + faid:restartSelf use the manager's own app name; refused for non-manager services", async () => {
  const dir = makeV3Dir();
  const { ctx, calls } = makeCtx(dir, () => null);
  ctx.host.getDeployTargetForSelf = () => ({ appName: "figaf-manager" });
  const handlers = createFaidHandlers(ctx);
  const r = await handlers["faid:bindManagerService"]({ name: "credstore" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.restartRequired, true);
  assert.deepEqual(calls.find((c) => c.args[0] === "bind-service").args, ["bind-service", "figaf-manager", "credstore"]);
  const bad = await handlers["faid:bindManagerService"]({ name: "db" });
  assert.equal(bad.ok, false);
  const rs = await handlers["faid:restartSelf"]();
  assert.equal(rs.ok, true);
  assert.deepEqual(calls.find((c) => c.args[0] === "restart").args, ["restart", "figaf-manager"]);
});

test("faid:bindManagerService outside CF (no self app name) is a clear error", async () => {
  const { ctx } = makeCtx(makeV3Dir(), () => null);
  const handlers = createFaidHandlers(ctx);
  const r = await handlers["faid:bindManagerService"]({ name: "credstore" });
  assert.equal(r.ok, false);
  assert.match(r.error, /not running in CF/);
});

test("faid:install refuses while a required service instance is missing (v3), v2 catalogs unaffected", async () => {
  const dir = makeV3Dir();
  const { ctx, calls } = makeCtx(dir, cfServiceResponder({ xsuaa: "create succeeded" })); // db missing
  const handlers = createFaidHandlers(ctx);
  const r = await handlers["faid:install"]({ appId: "arch" });
  assert.equal(r.ok, false);
  assert.match(r.error, /required service instance\(s\) missing: db/);
  assert.ok(!calls.some((c) => c.args[0] === "push"), "nothing must be deployed");
});

test("faid:figafSystems: finds app+router pairs running figaf/app images, returns router URLs", async () => {
  const dir = makeChannelDir();
  const { ctx } = makeCtx(dir, (args) => {
    if (args[0] === "curl" && /\/v3\/apps\?/.test(args[1])) {
      return { code: 0, stdout: JSON.stringify({ pagination: {}, resources: [
        { name: "qa-figaf-app",    guid: "a1", state: "STARTED" },   // internal CI image (ilnfigaf)
        { name: "qa-figaf-router", guid: "r1", state: "STARTED" },
        { name: "demo-app",        guid: "a4", state: "STARTED" },   // official image, no "figaf" in id
        { name: "demo-router",     guid: "r4", state: "STARTED" },
        { name: "lonely-app",      guid: "a2", state: "STARTED" },   // no router → skipped
        { name: "other-app",       guid: "a3", state: "STARTED" },   // wrong image
        { name: "other-router",    guid: "r3", state: "STARTED" },
        { name: "figaf-manager",   guid: "m1", state: "STARTED" },   // no pair pattern
      ] }) };
    }
    if (args[1] === "/v3/apps/a1/droplets/current") return { code: 0, stdout: JSON.stringify({ image: "ilnfigaf/app:2608.1-btp" }) };
    if (args[1] === "/v3/apps/a4/droplets/current") return { code: 0, stdout: JSON.stringify({ image: "figaf/app:2608-btp" }) };
    if (args[1] === "/v3/apps/a3/droplets/current") return { code: 0, stdout: JSON.stringify({ image: "someone/else:1" }) };
    if (args[1] === "/v3/apps/r1/routes") return { code: 0, stdout: JSON.stringify({ resources: [{ url: "qa-figaf.cfapps.eu10-004.hana.ondemand.com" }] }) };
    if (args[1] === "/v3/apps/r4/routes") return { code: 0, stdout: JSON.stringify({ resources: [{ url: "demo.cfapps.eu10-004.hana.ondemand.com" }] }) };
    return { code: 0, stdout: "" };
  });
  const handlers = createFaidHandlers(ctx);
  const r = await handlers["faid:figafSystems"]();
  assert.equal(r.ok, true, JSON.stringify(r));
  // "figaf"-named candidates are checked first; both image repos are accepted.
  assert.deepEqual(r.systems, [
    { id: "qa-figaf", url: "https://qa-figaf.cfapps.eu10-004.hana.ondemand.com", image: "ilnfigaf/app:2608.1-btp" },
    { id: "demo", url: "https://demo.cfapps.eu10-004.hana.ondemand.com", image: "figaf/app:2608-btp" },
  ]);
});

test("handlers report a friendly error when the host has no release source", async () => {
  const { ctx } = makeCtx(null, () => ({ code: 0, stdout: "" }));
  const handlers = createFaidHandlers(ctx);
  for (const ch of ["faid:catalog", "faid:status", "faid:releases"]) {
    const r = await handlers[ch]({});
    assert.equal(r.ok, false);
    assert.match(r.error, /No release source configured.*FIGAF_FAID_RELEASE_URL/);
  }
  // An older host adapter that only knows the directory seam still works.
  const dir = makeChannelDir();
  const { ctx: legacy } = makeCtx(null, () => ({ code: 0, stdout: "" }));
  delete legacy.host.resolveFaidReleaseSource;
  legacy.host.resolveFaidArtifactsDir = () => dir;
  const c = await createFaidHandlers(legacy)["faid:catalog"]({});
  assert.equal(c.ok, true);
  assert.equal(c.source.kind, "local");
});

// ─── D. landscape-independent release (decision 0008) ────────────────────────

function makeV3DirWithPlaceholder() {
  const dir = makeChannelDir(CATALOG_V3);
  fs.writeFileSync(path.join(dir, "xs-security.json"), JSON.stringify({
    xsappname: "figaf-faid",
    "oauth2-configuration": { "redirect-uris": [`https://*.${APPS_DOMAIN_PLACEHOLDER}/**`] },
  }));
  return dir;
}

test("faid:provisionServices: fills __CF_APPS_DOMAIN__ in a release config file from the landscape's cfapps domain; the release file stays untouched", async () => {
  const dir = makeV3DirWithPlaceholder();
  const state = { db: "create succeeded", credstore: "create succeeded" }; // only xsuaa missing
  const { ctx, calls, logLines } = makeCtx(dir, (args) => {
    if (args[0] === "curl" && args[1] === "/v3/domains") {
      return { code: 0, stdout: JSON.stringify({ resources: [{ name: "apps.internal" }, { name: "cfapps.eu10-004.hana.ondemand.com" }] }) };
    }
    if (args[0] === "create-service") { state[args[3]] = "create succeeded"; return { code: 0, stdout: "" }; }
    if (args[0] === "service") { const st = state[args[1]]; return st ? { code: 0, stdout: `status:    ${st}\n` } : { code: 1, stdout: "" }; }
    return null;
  });
  ctx.sleep = async () => {};
  ctx.pollIntervalMs = 0;
  const handlers = createFaidHandlers(ctx);
  const r = await handlers["faid:provisionServices"]({});
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.created, ["xsuaa"]);
  const xsCreate = calls.find((c) => c.args[0] === "create-service" && c.args[3] === "xsuaa");
  assert.equal(xsCreate.args[4], "-c");
  const written = fs.readFileSync(xsCreate.args[5], "utf8");
  assert.ok(!written.includes(APPS_DOMAIN_PLACEHOLDER), "placeholder must be filled");
  assert.ok(written.includes("https://*.cfapps.eu10-004.hana.ondemand.com/**"), written);
  assert.notEqual(path.dirname(xsCreate.args[5]), dir, "the filled copy must not overwrite the release file");
  assert.ok(fs.readFileSync(path.join(dir, "xs-security.json"), "utf8").includes(APPS_DOMAIN_PLACEHOLDER), "release file untouched");
  assert.ok(logLines.some((l) => l.includes("cfapps.eu10-004.hana.ondemand.com")), "the filled domain is shown in the terminal");
});

test("faid:provisionServices: no cfapps domain in the landscape -> the XSUAA instance is reported failed with a clear error and is not created", async () => {
  const dir = makeV3DirWithPlaceholder();
  const state = { db: "create succeeded", credstore: "create succeeded" };
  const { ctx, calls } = makeCtx(dir, (args) => {
    if (args[0] === "curl" && args[1] === "/v3/domains") return { code: 0, stdout: JSON.stringify({ resources: [{ name: "apps.internal" }] }) };
    if (args[0] === "create-service") { state[args[3]] = "create succeeded"; return { code: 0, stdout: "" }; }
    if (args[0] === "service") { const st = state[args[1]]; return st ? { code: 0, stdout: `status:    ${st}\n` } : { code: 1, stdout: "" }; }
    return null;
  });
  ctx.sleep = async () => {};
  ctx.pollIntervalMs = 0;
  const handlers = createFaidHandlers(ctx);
  const r = await handlers["faid:provisionServices"]({});
  assert.equal(r.ok, false);
  assert.equal(r.failed.length, 1);
  assert.equal(r.failed[0].name, "xsuaa");
  assert.match(r.failed[0].error, /no cfapps\.\* domain/);
  assert.ok(!calls.some((c) => c.args[0] === "create-service"), "nothing is created without a domain");
});

test("faid:provisionServices: the XSUAA config is ALWAYS composed - the manager's roles are added to the release part (decision 0009)", async () => {
  const dir = makeV3Dir(); // release part: {"xsappname":"figaf-faid"}, no placeholder
  const state = { db: "create succeeded", credstore: "create succeeded" };
  const { ctx, calls } = makeCtx(dir, (args) => {
    if (domainsResponder(args)) return domainsResponder(args);
    if (args[0] === "create-service") { state[args[3]] = "create succeeded"; return { code: 0, stdout: "" }; }
    if (args[0] === "service") { const st = state[args[1]]; return st ? { code: 0, stdout: `status:    ${st}\n` } : { code: 1, stdout: "" }; }
    return null;
  });
  ctx.sleep = async () => {};
  ctx.pollIntervalMs = 0;
  const handlers = createFaidHandlers(ctx);
  const r = await handlers["faid:provisionServices"]({});
  assert.equal(r.ok, true, JSON.stringify(r));
  const xsCreate = calls.find((c) => c.args[0] === "create-service" && c.args[3] === "xsuaa");
  assert.notEqual(xsCreate.args[5], path.join(dir, "xs-security.json"), "the composed copy, never the release file");
  const doc = JSON.parse(fs.readFileSync(xsCreate.args[5], "utf8"));
  assert.equal(doc.xsappname, "figaf-faid");
  assert.ok(doc.scopes.some((s) => s.name === "$XSAPPNAME.FAIDManagerOperator"), "manager scope merged in");
  assert.ok(doc["role-collections"].some((c) => c.name === "FAID-Manager-Admin"), "manager collection merged in");
  assert.deepEqual(doc["oauth2-configuration"]["redirect-uris"], ["https://*.cfapps.eu10-004.hana.ondemand.com/**"]);
});

test("faid:provisionServices: a NON-xsuaa config file without the placeholder is passed to cf as-is from the release dir", async () => {
  const catalog = {
    ...CATALOG_V3,
    services: [{ name: "dest", offering: "destination", plan: "lite", configFile: "dest.json", purpose: "destinations" }],
  };
  const dir = makeChannelDir(catalog);
  fs.writeFileSync(path.join(dir, "dest.json"), "{\"HTML5Runtime_enabled\":false}");
  const state = {};
  const { ctx, calls } = makeCtx(dir, (args) => {
    if (args[0] === "create-service") { state[args[3]] = "create succeeded"; return { code: 0, stdout: "" }; }
    if (args[0] === "service") { const st = state[args[1]]; return st ? { code: 0, stdout: `status:    ${st}\n` } : { code: 1, stdout: "" }; }
    return null;
  });
  ctx.sleep = async () => {};
  ctx.pollIntervalMs = 0;
  const handlers = createFaidHandlers(ctx);
  const r = await handlers["faid:provisionServices"]({});
  assert.equal(r.ok, true, JSON.stringify(r));
  const create = calls.find((c) => c.args[0] === "create-service" && c.args[3] === "dest");
  assert.equal(create.args[5], path.join(dir, "dest.json"));
  assert.ok(!calls.some((c) => c.args[0] === "curl" && c.args[1] === "/v3/domains"), "no domain lookup without a placeholder");
});

// ─── E. one XSUAA instance for the manager and the apps (decision 0009) ──────

test("faid:ensureXsuaa: instance missing -> create-service figaf-faid-xsuaa with the composed document, then wait until ready", async () => {
  const dir = makeV3DirWithPlaceholder();
  const state = {};
  const { ctx, calls } = makeCtx(dir, (args) => {
    if (domainsResponder(args)) return domainsResponder(args);
    if (args[0] === "create-service") { state[args[3]] = "create succeeded"; return { code: 0, stdout: "" }; }
    if (args[0] === "service") { const st = state[args[1]]; return st ? { code: 0, stdout: `status:    ${st}\n` } : { code: 1, stdout: "" }; }
    return null;
  });
  ctx.sleep = async () => {};
  ctx.pollIntervalMs = 0;
  const handlers = createFaidHandlers(ctx);
  const r = await handlers["faid:ensureXsuaa"]({});
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.created, true);
  assert.equal(r.instance, "figaf-faid-xsuaa");
  const create = calls.find((c) => c.args[0] === "create-service");
  assert.deepEqual(create.args.slice(0, 5), ["create-service", "xsuaa", "application", "figaf-faid-xsuaa", "-c"]);
  const doc = JSON.parse(fs.readFileSync(create.args[5], "utf8"));
  assert.equal(doc.xsappname, "figaf-faid");
  assert.ok(doc.scopes.some((s) => s.name === "$XSAPPNAME.FAIDManagerOperator"), "manager scope added");
  assert.ok(doc["role-collections"].some((c) => c.name === "FAID-Manager-Admin"));
  assert.deepEqual(doc["oauth2-configuration"]["redirect-uris"], ["https://*.cfapps.eu10-004.hana.ondemand.com/**"]);
  assert.ok(!calls.some((c) => c.args[0] === "update-service"), "no update on a fresh create");
});

test("faid:ensureXsuaa: instance present -> update-service with the composed document; updateOnly on a missing instance does nothing", async () => {
  const dir = makeV3DirWithPlaceholder();
  const state = { "figaf-faid-xsuaa": "create succeeded" };
  const { ctx, calls } = makeCtx(dir, (args) => {
    if (domainsResponder(args)) return domainsResponder(args);
    if (args[0] === "update-service") { state[args[1]] = "update succeeded"; return { code: 0, stdout: "" }; }
    if (args[0] === "service") { const st = state[args[1]]; return st ? { code: 0, stdout: `status:    ${st}\n` } : { code: 1, stdout: "" }; }
    return null;
  });
  ctx.sleep = async () => {};
  ctx.pollIntervalMs = 0;
  const handlers = createFaidHandlers(ctx);
  const r = await handlers["faid:ensureXsuaa"]({});
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.updated, true);
  assert.equal(r.created, false);
  const upd = calls.find((c) => c.args[0] === "update-service");
  assert.deepEqual(upd.args.slice(0, 3), ["update-service", "figaf-faid-xsuaa", "-c"]);
  assert.ok(!calls.some((c) => c.args[0] === "create-service"));

  delete state["figaf-faid-xsuaa"];
  calls.length = 0;
  const r2 = await handlers["faid:ensureXsuaa"]({ updateOnly: true });
  assert.equal(r2.ok, true);
  assert.equal(r2.skipped, true);
  assert.ok(!calls.some((c) => c.args[0] === "update-service" || c.args[0] === "create-service"), "nothing created or updated");
});

test("faid:ensureXsuaa: without a release on the host the manager part alone is used (xsappname figaf-faid)", async () => {
  const { ctx, calls } = makeCtx(null, (args) => {
    if (domainsResponder(args)) return domainsResponder(args);
    if (args[0] === "create-service") return { code: 0, stdout: "" };
    if (args[0] === "service") return calls.some((c) => c.args[0] === "create-service") ? { code: 0, stdout: "status:    create succeeded\n" } : { code: 1, stdout: "" };
    return null;
  });
  ctx.host.resolveFaidArtifactsDir = () => null;
  ctx.sleep = async () => {};
  ctx.pollIntervalMs = 0;
  const handlers = createFaidHandlers(ctx);
  const r = await handlers["faid:ensureXsuaa"]({});
  assert.equal(r.ok, true, JSON.stringify(r));
  const create = calls.find((c) => c.args[0] === "create-service");
  const doc = JSON.parse(fs.readFileSync(create.args[5], "utf8"));
  assert.equal(doc.xsappname, "figaf-faid");
  assert.deepEqual(doc["role-collections"].map((c) => c.name), ["FAID-Manager-Operator", "FAID-Manager-Admin"]);
});

test("faid:prepareManagerServices: creates ONLY the manager-bound services and binds them to the manager - no restart, db and xsuaa untouched", async () => {
  const dir = makeV3DirWithPlaceholder();
  const state = {};
  const { ctx, calls } = makeCtx(dir, (args) => {
    if (args[0] === "create-service") { state[args[3]] = "create succeeded"; return { code: 0, stdout: "" }; }
    if (args[0] === "service") { const st = state[args[1]]; return st ? { code: 0, stdout: `status:    ${st}\n` } : { code: 1, stdout: "" }; }
    if (args[0] === "bind-service") return { code: 0, stdout: "OK" };
    return null;
  });
  ctx.host.getDeployTargetForSelf = () => ({ appName: "figaf-manager", apiUrl: "u", orgName: "o", spaceName: "s" });
  ctx.sleep = async () => {};
  ctx.pollIntervalMs = 0;
  const handlers = createFaidHandlers(ctx);
  const r = await handlers["faid:prepareManagerServices"]({});
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.created, ["credstore"]);
  assert.deepEqual(r.bound, ["credstore"]);
  assert.deepEqual(calls.filter((c) => c.args[0] === "create-service").map((c) => c.args[3]), ["credstore"]);
  const create = calls.find((c) => c.args[0] === "create-service");
  assert.equal(create.args[4], "-c", "the credstore basic-auth config is passed as a file");
  assert.deepEqual(calls.find((c) => c.args[0] === "bind-service").args, ["bind-service", "figaf-manager", "credstore"]);
  assert.ok(!calls.some((c) => c.args[0] === "restart"), "no restart in this step");
  assert.ok(!calls.some((c) => c.args[0] === "curl" && c.args[1] === "/v3/domains"), "xsuaa is not touched here");
});

test("faid:prepareManagerServices: re-run with the instance present and already bound is a success; a create failure is reported and nothing is bound", async () => {
  const dir = makeV3DirWithPlaceholder();
  const { ctx: ctx1, calls: calls1 } = makeCtx(dir, (args) => {
    if (args[0] === "service" && args[1] === "credstore") return { code: 0, stdout: "status:    create succeeded\n" };
    if (args[0] === "bind-service") return { code: 1, stdout: "", stderr: "Service instance credstore is already bound to application figaf-manager." };
    return null;
  });
  ctx1.host.getDeployTargetForSelf = () => ({ appName: "figaf-manager", apiUrl: "u", orgName: "o", spaceName: "s" });
  ctx1.sleep = async () => {}; ctx1.pollIntervalMs = 0;
  const r1 = await createFaidHandlers(ctx1)["faid:prepareManagerServices"]({});
  assert.equal(r1.ok, true, JSON.stringify(r1));
  assert.deepEqual(r1.created, []);
  assert.deepEqual(r1.bound, ["credstore"]);
  assert.ok(!calls1.some((c) => c.args[0] === "create-service"));

  const { ctx: ctx2, calls: calls2 } = makeCtx(dir, (args) => {
    if (args[0] === "create-service") return { code: 1, stdout: "", stderr: "Service plan free: only one instance allowed per subaccount" };
    if (args[0] === "service") return { code: 1, stdout: "" };
    return null;
  });
  ctx2.host.getDeployTargetForSelf = () => ({ appName: "figaf-manager", apiUrl: "u", orgName: "o", spaceName: "s" });
  ctx2.sleep = async () => {}; ctx2.pollIntervalMs = 0;
  const r2 = await createFaidHandlers(ctx2)["faid:prepareManagerServices"]({});
  assert.equal(r2.ok, false);
  assert.match(r2.error, /only one instance allowed/);
  assert.ok(!calls2.some((c) => c.args[0] === "bind-service"), "nothing bound after a failed create");
});

test("faid:install on a v3 release: the shared XSUAA instance is UPDATED (role refresh) before the shared backend is pushed", async () => {
  const dir = makeV3DirWithPlaceholder();
  const state = { db: "create succeeded", xsuaa: "create succeeded", credstore: "create succeeded", "figaf-faid-xsuaa": "create succeeded" };
  const { ctx, calls } = makeCtx(dir, (args) => {
    if (domainsResponder(args)) return domainsResponder(args);
    if (args[0] === "update-service") { state[args[1]] = "update succeeded"; return { code: 0, stdout: "" }; }
    if (args[0] === "service") { const st = state[args[1]]; return st ? { code: 0, stdout: `status:    ${st}\n` } : { code: 1, stdout: "" }; }
    if (args[0] === "app" && args[2] === "--guid") return { code: 1, stdout: "" }; // fresh
    if (args[0] === "app" && args[1] === "arch-backend") return { code: 0, stdout: "routes:   arch-backend.cfapps.eu10.hana.ondemand.com\n" };
    return { code: 0, stdout: "" };
  });
  ctx.sleep = async () => {};
  ctx.pollIntervalMs = 0;
  const handlers = createFaidHandlers(ctx);
  const r = await handlers["faid:install"]({ appId: "arch" });
  assert.equal(r.ok, true, JSON.stringify(r));
  const seq = calls.map((c) => c.args[0]);
  const upd = seq.indexOf("update-service");
  const push = seq.indexOf("push");
  assert.ok(upd !== -1, "update-service ran");
  assert.ok(push !== -1, "push ran");
  assert.ok(upd < push, "role refresh happens before the first push");
  assert.equal(calls[upd].args[1], "figaf-faid-xsuaa");
});

test("faid:install on a v3 release: a failed role refresh stops the install before any push, with step/cfApp/command", async () => {
  const dir = makeV3DirWithPlaceholder();
  const state = { db: "create succeeded", xsuaa: "create succeeded", credstore: "create succeeded", "figaf-faid-xsuaa": "create succeeded" };
  const { ctx, calls } = makeCtx(dir, (args) => {
    if (domainsResponder(args)) return domainsResponder(args);
    if (args[0] === "update-service") return { code: 1, stdout: "", stderr: "Service broker error: invalid xs-security" };
    if (args[0] === "service") { const st = state[args[1]]; return st ? { code: 0, stdout: `status:    ${st}\n` } : { code: 1, stdout: "" }; }
    if (args[0] === "app" && args[2] === "--guid") return { code: 1, stdout: "" };
    return { code: 0, stdout: "" };
  });
  ctx.sleep = async () => {};
  ctx.pollIntervalMs = 0;
  const handlers = createFaidHandlers(ctx);
  const r = await handlers["faid:install"]({ appId: "arch" });
  assert.equal(r.ok, false);
  assert.equal(r.step, "roles");
  assert.equal(r.cfApp, "figaf-faid-xsuaa");
  assert.match(r.error, /role refresh of figaf-faid-xsuaa failed/);
  assert.match(r.error, /invalid xs-security/);
  assert.ok(!calls.some((c) => c.args[0] === "push"), "nothing pushed");
});

// ─── F. Failed actions explain themselves (live failure 2026-09-03) ──────────
//
// Release 0.4.0 could not be installed from a manager deployed through the BTP
// cockpit upload: the manager's own manifest.yml sat in its working directory,
// `cf push` applied it to the FAID app and CAPI rejected "Buildpack and
// Buildpacks fields cannot be used together". The console showed nothing: the
// generic error was wiped by the status refresh within a second and the CLI
// text never reached the result. These tests lock both fixes.

test("buildPushArgs always passes --no-manifest, fresh install and update alike", () => {
  const fresh = buildPushArgs(CATALOG.platform.cfApps[0], "/tmp/x", { noStart: true });
  assert.ok(fresh.includes("--no-manifest"), fresh.join(" "));
  assert.ok(fresh.includes("--no-start"));
  const update = buildPushArgs(CATALOG.apps[0].cfApps[0], "/tmp/y", { noStart: false });
  assert.ok(update.includes("--no-manifest"), update.join(" "));
  assert.ok(!update.includes("--no-start"));
  // -p stays the extracted release directory; nothing else names a manifest.
  assert.equal(update[update.indexOf("-p") + 1], "/tmp/y");
  assert.ok(!update.includes("-f"));
});

test("cliFailureDetail: last stderr lines win, the bare FAILED marker is skipped, stdout and spawn error are fallbacks", () => {
  const { cliFailureDetail } = require("./faid-apps");
  assert.equal(
    cliFailureDetail({ stdout: "Pushing app x...\nApplying manifest file /home/vcap/app/manifest.yml...\nFAILED\n", stderr: "For application 'x': Buildpack and Buildpacks fields cannot be used together.\n" }),
    "For application 'x': Buildpack and Buildpacks fields cannot be used together."
  );
  assert.equal(cliFailureDetail({ stdout: "line one\nFAILED\n", stderr: "" }), "line one");
  assert.equal(cliFailureDetail({ stdout: "", stderr: "a\nb\nc\nd\n" }), "b | c | d");
  assert.equal(cliFailureDetail({ stdout: "", stderr: "", error: "spawn cf ENOENT" }), "spawn cf ENOENT");
  assert.equal(cliFailureDetail(null), "");
  assert.equal(cliFailureDetail({ stderr: "x".repeat(1000) }).length, 400);
});

test("faid:install: a failed cf push carries step, CF app, command and what cf said; the terminal ends with one FAILED line; the phase event has the detail", async () => {
  const dir = makeChannelDir();
  const { ctx, logLines, events } = makeCtx(dir, (args) => {
    if (args[0] === "app" && args[2] === "--guid") return { code: 1, stdout: "" }; // fresh
    if (args[0] === "push") {
      return {
        code: 1,
        stdout: "Pushing app arch-backend to org o / space s as u...\nApplying manifest file /home/vcap/app/manifest.yml...\nFAILED\n",
        stderr: "For application 'arch-backend': Buildpack and Buildpacks fields cannot be used together.\n",
      };
    }
    return { code: 0, stdout: "" };
  });
  const handlers = createFaidHandlers(ctx);
  const r = await handlers["faid:install"]({ appId: "arch" });
  assert.equal(r.ok, false);
  assert.equal(r.step, "push");
  assert.equal(r.cfApp, "arch-backend");
  assert.equal(r.failedApp, "arch-backend");
  assert.equal(r.detail, "For application 'arch-backend': Buildpack and Buildpacks fields cannot be used together.");
  assert.equal(r.error, "cf push arch-backend failed: For application 'arch-backend': Buildpack and Buildpacks fields cannot be used together.");
  assert.match(r.command, /^cf push arch-backend -p \S+ --no-manifest -b nodejs_buildpack -m 256M -k 1024M --no-start$/);
  // one red summary line closes the action in the terminal drawer
  assert.ok(logLines.some((l) => l === `install arch FAILED at step "push" (arch-backend): ${r.error}`), logLines.join("\n"));
  // the phase event carries the same detail (for a future stepper view)
  const ph = events.find((e) => e.channel === "faid:phase" && e.payload.step === "push" && e.payload.state === "error");
  assert.ok(ph);
  assert.match(ph.payload.detail, /Buildpack and Buildpacks/);
  // nothing after the failed push
  assert.ok(!logLines.some((l) => /bind-service|set-env|^cf start/.test(l)));
});

test("faid:install: a required bind failure names the step, the CF app and the command", async () => {
  const dir = makeChannelDir();
  const { ctx } = makeCtx(dir, (args) => {
    if (args[0] === "app" && args[2] === "--guid") return { code: 1, stdout: "" };
    if (args[0] === "bind-service" && args[2] === "db") return { code: 1, stdout: "FAILED\n", stderr: "Service instance db not found\n" };
    return { code: 0, stdout: "" };
  });
  const r = await createFaidHandlers(ctx)["faid:install"]({ appId: "arch" });
  assert.equal(r.ok, false);
  assert.equal(r.step, "bind");
  assert.equal(r.cfApp, "arch-backend");
  assert.equal(r.command, "cf bind-service arch-backend db");
  assert.match(r.error, /^bind-service db failed — does the service instance exist in this space\?: Service instance db not found$/);
});

test("faid:install: a failed cf start keeps the 'see the staging log' pointer and adds cf's last lines", async () => {
  const dir = makeChannelDir();
  const { ctx } = makeCtx(dir, (args) => {
    if (args[0] === "app" && args[2] === "--guid") return { code: 1, stdout: "" };
    if (args[0] === "app" && args[1] === "arch-backend") return { code: 0, stdout: "routes:   b.example.com\n" };
    if (args[0] === "start") return { code: 1, stdout: "Staging app...\nFAILED\n", stderr: "Start unsuccessful\nTIP: use 'cf logs arch-backend --recent' for more information\n" };
    return { code: 0, stdout: "" };
  });
  const r = await createFaidHandlers(ctx)["faid:install"]({ appId: "arch" });
  assert.equal(r.ok, false);
  assert.equal(r.step, "start");
  assert.equal(r.command, "cf start arch-backend");
  assert.match(r.error, /see the staging log in the terminal: Start unsuccessful \| TIP: use 'cf logs arch-backend --recent'/);
});

test("faid:remove / faid:disable failures carry step, CF app, command and cf's message; success ends with a green done line", async () => {
  const dir = makeChannelDir();
  const { ctx, logLines } = makeCtx(dir, (args) => {
    if (args[0] === "delete") return { code: 1, stdout: "FAILED\n", stderr: "App 'arch-frontend' not found\n" };
    return { code: 0, stdout: "" };
  });
  const handlers = createFaidHandlers(ctx);
  const r = await handlers["faid:remove"]({ appId: "arch" });
  assert.equal(r.ok, false);
  assert.equal(r.step, "delete");
  assert.equal(r.cfApp, "arch-frontend");
  assert.equal(r.command, "cf delete arch-frontend -f");
  assert.equal(r.error, "cf delete arch-frontend failed: App 'arch-frontend' not found");
  assert.ok(logLines.some((l) => l.startsWith('remove arch FAILED at step "delete" (arch-frontend):')));
  const ok = await handlers["faid:disable"]({ appId: "arch" });
  assert.equal(ok.ok, true);
  assert.ok(logLines.includes("disable arch: done"));
});

test("faid:install refused for a missing required service is reported as FAILED in the terminal too", async () => {
  const v3 = JSON.parse(JSON.stringify(CATALOG));
  v3.services = [{ name: "db", offering: "postgresql-db", plan: "free" }];
  const dir = makeChannelDir(v3);
  const { ctx, logLines, calls } = makeCtx(dir, (args) => (args[0] === "service" ? { code: 1, stdout: "" } : { code: 0, stdout: "" }));
  const r = await createFaidHandlers(ctx)["faid:install"]({ appId: "arch" });
  assert.equal(r.ok, false);
  assert.match(r.error, /required service instance\(s\) missing: db, xsuaa/);
  assert.ok(logLines.some((l) => l.startsWith("install arch FAILED: required service instance(s) missing")));
  assert.ok(!calls.some((c) => c.args[0] === "push"), "nothing may be pushed");
});

// ─── Setup step 1: faid:prepareSpaceServices (docs/faid-apps-console/SPEC.md 5.2) ────────────

test("faid:prepareSpaceServices: creates every missing instance except XSUAA with the chosen plans, waits only for the Credential Store, binds it, leaves the database creating (pending); no restart", async () => {
  const dir = makeV3DirWithPlaceholder();
  const state = {}; // everything missing
  const { ctx, calls, logLines } = makeCtx(dir, (args) => {
    if (args[0] === "create-service") {
      // credstore is quick; the database stays "in progress" (nobody waits for it)
      state[args[3]] = args[3] === "db" ? "create in progress" : "create succeeded";
      return { code: 0, stdout: "" };
    }
    if (args[0] === "service") { const st = state[args[1]]; return st ? { code: 0, stdout: `status:    ${st}\n` } : { code: 1, stdout: "" }; }
    if (args[0] === "bind-service") return { code: 0, stdout: "OK" };
    return null;
  });
  ctx.host.getDeployTargetForSelf = () => ({ appName: "figaf-manager", apiUrl: "u", orgName: "o", spaceName: "s" });
  ctx.sleep = async () => { throw new Error("must not wait for the database"); };
  ctx.pollIntervalMs = 0;
  const handlers = createFaidHandlers(ctx);
  const r = await handlers["faid:prepareSpaceServices"]({ plans: { db: "standard", credstore: "free" } });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.created.sort(), ["credstore", "db"]);
  assert.deepEqual(r.bound, ["credstore"]);
  assert.deepEqual(r.pending, ["db"]);
  assert.deepEqual(r.failed, []);
  const creates = calls.filter((c) => c.args[0] === "create-service");
  assert.deepEqual(creates.map((c) => c.args[3]).sort(), ["credstore", "db"], "xsuaa is owned by faid:ensureXsuaa");
  assert.deepEqual(creates.find((c) => c.args[3] === "db").args.slice(0, 4), ["create-service", "postgresql-db", "standard", "db"]);
  assert.deepEqual(calls.find((c) => c.args[0] === "bind-service").args, ["bind-service", "figaf-manager", "credstore"]);
  assert.ok(!calls.some((c) => c.args[0] === "restart"), "no restart in this step");
  assert.ok(!calls.some((c) => c.args[0] === "curl" && c.args[1] === "/v3/domains"), "xsuaa is not touched here");
  assert.ok(logLines.some((l) => /db: still being created/.test(l)), "the terminal says the database is left creating");
});

test("faid:prepareSpaceServices: a plan the catalog does not allow fails that instance only; the Credential Store is still created and bound; ok:false carries the reason", async () => {
  const dir = makeV3DirWithPlaceholder();
  const state = {};
  const { ctx, calls } = makeCtx(dir, (args) => {
    if (args[0] === "create-service") { state[args[3]] = "create succeeded"; return { code: 0, stdout: "" }; }
    if (args[0] === "service") { const st = state[args[1]]; return st ? { code: 0, stdout: `status:    ${st}\n` } : { code: 1, stdout: "" }; }
    if (args[0] === "bind-service") return { code: 0, stdout: "OK" };
    return null;
  });
  ctx.host.getDeployTargetForSelf = () => ({ appName: "figaf-manager", apiUrl: "u", orgName: "o", spaceName: "s" });
  ctx.sleep = async () => {}; ctx.pollIntervalMs = 0;
  const r = await createFaidHandlers(ctx)["faid:prepareSpaceServices"]({ plans: { db: "enterprise" } });
  assert.equal(r.ok, false);
  assert.match(r.error, /plan 'enterprise' is not allowed for db/);
  assert.deepEqual(r.created, ["credstore"]);
  assert.deepEqual(r.bound, ["credstore"]);
  assert.ok(!calls.some((c) => c.args[0] === "create-service" && c.args[3] === "db"));
});

test("faid:prepareSpaceServices: a Credential Store that cannot be created (free plan used up) is reported and NOT bound; the database is still started", async () => {
  const dir = makeV3DirWithPlaceholder();
  const state = {};
  const { ctx, calls } = makeCtx(dir, (args) => {
    if (args[0] === "create-service") {
      if (args[3] === "credstore") return { code: 1, stdout: "", stderr: "FAILED\nService plan free: only one instance allowed per subaccount" };
      state[args[3]] = "create in progress";
      return { code: 0, stdout: "" };
    }
    if (args[0] === "service") { const st = state[args[1]]; return st ? { code: 0, stdout: `status:    ${st}\n` } : { code: 1, stdout: "" }; }
    return null;
  });
  ctx.host.getDeployTargetForSelf = () => ({ appName: "figaf-manager", apiUrl: "u", orgName: "o", spaceName: "s" });
  ctx.sleep = async () => {}; ctx.pollIntervalMs = 0;
  const r = await createFaidHandlers(ctx)["faid:prepareSpaceServices"]({});
  assert.equal(r.ok, false);
  assert.match(r.error, /only one instance allowed/);
  assert.deepEqual(r.created, ["db"]);
  assert.deepEqual(r.pending, ["db"]);
  assert.deepEqual(r.bound, []);
  assert.ok(!calls.some((c) => c.args[0] === "bind-service"), "nothing bound after a failed create");
});

test("faid:prepareSpaceServices: instances that exist are left alone; an already bound Credential Store is a success; no release = nothing to do", async () => {
  const dir = makeV3DirWithPlaceholder();
  const { ctx, calls } = makeCtx(dir, (args) => {
    if (args[0] === "service") return { code: 0, stdout: "status:    create succeeded\n" };
    if (args[0] === "bind-service") return { code: 1, stdout: "", stderr: "Service instance credstore is already bound to application figaf-manager." };
    return null;
  });
  ctx.host.getDeployTargetForSelf = () => ({ appName: "figaf-manager", apiUrl: "u", orgName: "o", spaceName: "s" });
  ctx.sleep = async () => {}; ctx.pollIntervalMs = 0;
  const r = await createFaidHandlers(ctx)["faid:prepareSpaceServices"]({});
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.created, []);
  assert.deepEqual(r.pending, []);
  assert.deepEqual(r.bound, ["credstore"]);
  assert.ok(!calls.some((c) => c.args[0] === "create-service"));

  const { ctx: ctx2 } = makeCtx(dir, () => null);
  ctx2.host.resolveFaidReleaseSource = () => null;
  const r2 = await createFaidHandlers(ctx2)["faid:prepareSpaceServices"]({});
  assert.equal(r2.ok, true);
  assert.match(r2.note, /nothing to prepare/);
});

test("faid:provisionServices with waitOnly: only the named instances are awaited; a not-awaited instance that already failed is reported failed", async () => {
  const dir = makeV3Dir();
  const state = {};
  let polls = 0;
  const { ctx } = makeCtx(dir, (args) => {
    if (domainsResponder(args)) return domainsResponder(args);
    if (args[0] === "create-service") {
      state[args[3]] = args[3] === "db" ? "create failed" : "create in progress";
      return { code: 0, stdout: "" };
    }
    if (args[0] === "service") {
      const st = state[args[1]];
      if (!st) return { code: 1, stdout: "" };
      if (st === "create in progress" && ++polls > 2) state[args[1]] = "create succeeded";
      return { code: 0, stdout: `status:    ${state[args[1]]}\n` };
    }
    return null;
  });
  ctx.sleep = async () => {}; ctx.pollIntervalMs = 0;
  const r = await createFaidHandlers(ctx)["faid:provisionServices"]({ waitOnly: ["credstore", "xsuaa"] });
  assert.equal(r.ok, false);
  assert.ok(r.failed.some((f) => f.name === "db"), JSON.stringify(r));
  assert.deepEqual(r.timedOut, []);
  assert.deepEqual(r.pending, []);
});

test("faid:install refuses with a pointer to Setup step 3 while a required instance is missing", async () => {
  const dir = makeV3Dir();
  const { ctx } = makeCtx(dir, cfServiceResponder({ xsuaa: "create succeeded", credstore: "create succeeded" }));
  ctx.sleep = async () => {};
  const r = await createFaidHandlers(ctx)["faid:install"]({ appId: "arch" });
  assert.equal(r.ok, false);
  assert.match(r.error, /required service instance\(s\) missing: db — create them first \(Setup, step 3\)/);
});


// --- C. one lifecycle action at a time --------------------------------------
// Why these exist: on 2026-09-04 Install was pressed a second time while the
// shared backend was staging (the CF app reads STOPPED for that whole time).
// The second push uploaded a new package, Cloud Foundry dropped the running
// build, and the install never finished.

test("a second install is refused while the first one runs - and pushes nothing", async () => {
  resetRunningAction();
  const dir = makeChannelDir();
  let releaseFirst;
  const firstDone = new Promise((res) => { releaseFirst = res; });
  const { ctx, calls, events } = makeCtx(dir, (args) => {
    if (args[0] === "app" && args[2] === "--guid") return { code: 1, stdout: "" };  // fresh
    if (args[0] === "service" && args[1] === "credstore") return { code: 1, stdout: "" };
    if (args[0] === "app" && args[1] === "arch-backend") return { code: 0, stdout: "routes:   b.example.com\n" };
    return { code: 0, stdout: "" };
  });
  // Hold the first install inside its first push.
  const realRun = ctx.run;
  let held = false;
  ctx.run = async (cmd, args, opts) => {
    if (!held && args[0] === "push") { held = true; await firstDone; }
    return realRun(cmd, args, opts);
  };
  const handlers = createFaidHandlers(ctx);

  const first = handlers["faid:install"]({ appId: "arch" });
  await new Promise((r) => setImmediate(r));            // let it reach the hold
  assert.equal((runningAction() || {}).action, "install", "the manager must report the running action");
  const running = await handlers["faid:running"]();
  assert.equal(running.running.action, "install");
  assert.equal(running.running.appId, "arch");

  const pushesBefore = calls.filter((c) => c.args[0] === "push").length;
  const second = await handlers["faid:install"]({ appId: "arch" });
  assert.equal(second.ok, false);
  assert.equal(second.busy, true);
  assert.equal(second.running.action, "install");
  assert.match(second.error, /already running/);
  assert.equal(
    calls.filter((c) => c.args[0] === "push").length, pushesBefore,
    "the refused call must not push anything"
  );

  releaseFirst();
  const r = await first;
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(runningAction(), null, "the lock is released when the action ends");
  const runningEvents = events.filter((e) => e.channel === "faid:running");
  assert.equal(runningEvents.length, 2, "one event on start, one on end");
  assert.equal(runningEvents[0].payload.action, "install");
  assert.equal(runningEvents[1].payload, null);
});

test("every lifecycle action shares the lock, and a failure releases it", async () => {
  resetRunningAction();
  const dir = makeChannelDir();
  let release;
  const held = new Promise((res) => { release = res; });
  const { ctx } = makeCtx(dir, () => ({ code: 0, stdout: "" }));
  const realRun = ctx.run;
  let first = true;
  ctx.run = async (cmd, args, opts) => {
    if (first && args[0] === "stop") { first = false; await held; }
    return realRun(cmd, args, opts);
  };
  const handlers = createFaidHandlers(ctx);
  const disable = handlers["faid:disable"]({ appId: "arch" });
  await new Promise((r) => setImmediate(r));
  for (const action of ["install", "update", "enable", "remove", "configure"]) {
    const r = await handlers["faid:" + action]({ appId: "arch", env: { FIGAF_BASE_URL: "https://f" } });
    assert.equal(r.busy, true, action + " must wait for the running disable");
  }
  release();
  await disable;
  assert.equal(runningAction(), null);

  // A failing action must not leave the lock behind.
  const bad = makeCtx(dir, (args) => (args[0] === "stop" ? { code: 1, stderr: "boom" } : { code: 0, stdout: "" }));
  const h2 = createFaidHandlers(bad.ctx);
  const f = await h2["faid:disable"]({ appId: "arch" });
  assert.equal(f.ok, false);
  assert.equal(runningAction(), null, "the lock must be released after a failure too");
});

test("faid:status: a stopped part with a staging build reads as installing", async () => {
  resetRunningAction();
  const dir = makeChannelDir();
  const { ctx } = makeCtx(dir, (args) => {
    if (args[0] === "target") return { code: 0, stdout: "org: o\nspace: myspace\n" };
    if (args[0] === "space") return { code: 0, stdout: "space-guid-1\n" };
    if (args[0] === "curl" && /\/v3\/apps\?/.test(args[1])) {
      return { code: 0, stdout: JSON.stringify({ resources: [
        { name: "arch-backend", guid: "g1", state: "STOPPED" },
      ] }) };
    }
    if (args[0] === "curl" && /\/v3\/builds\?app_guids=g1&states=STAGING/.test(args[1])) {
      return { code: 0, stdout: JSON.stringify({ resources: [{ guid: "b1", state: "STAGING" }] }) };
    }
    if (args[0] === "curl" && /environment_variables$/.test(args[1])) {
      return { code: 0, stdout: JSON.stringify({ var: { [VERSION_ENV]: "0.2.0" } }) };
    }
    if (args[0] === "curl" && /routes$/.test(args[1])) return { code: 0, stdout: JSON.stringify({ resources: [] }) };
    return { code: 0, stdout: "" };
  });
  const r = await createFaidHandlers(ctx)["faid:status"]();
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.platform.status, "installing");
  assert.equal(r.platform.parts[0].staging, true);
  assert.equal(r.running, null, "no action of THIS manager is running");
  assert.equal(r.apps[0].status, "not-installed", "the app row has no CF app yet");
});

test("faid:status: a running install marks the app row and the shared backend", async () => {
  resetRunningAction();
  const dir = makeChannelDir();
  let release;
  const held = new Promise((res) => { release = res; });
  const { ctx } = makeCtx(dir, (args) => {
    if (args[0] === "app" && args[2] === "--guid") return { code: 1, stdout: "" };
    if (args[0] === "service" && args[1] === "credstore") return { code: 1, stdout: "" };
    if (args[0] === "app" && args[1] === "arch-backend") return { code: 0, stdout: "routes:   b.example.com\n" };
    if (args[0] === "target") return { code: 0, stdout: "org: o\nspace: myspace\n" };
    if (args[0] === "space") return { code: 0, stdout: "space-guid-1\n" };
    if (args[0] === "curl" && /\/v3\/apps\?/.test(args[1])) return { code: 0, stdout: JSON.stringify({ resources: [] }) };
    return { code: 0, stdout: "" };
  });
  const realRun = ctx.run;
  let first = true;
  ctx.run = async (cmd, args, opts) => {
    if (first && args[0] === "push") { first = false; await held; }
    return realRun(cmd, args, opts);
  };
  const handlers = createFaidHandlers(ctx);
  const install = handlers["faid:install"]({ appId: "arch" });
  await new Promise((r) => setImmediate(r));
  const st = await handlers["faid:status"]();
  assert.equal(st.running.action, "install");
  assert.equal(st.running.appId, "arch");
  // Nothing exists in CF yet, but a deploy IS running - both rows must say so.
  assert.equal(st.platform.status, "installing");
  assert.equal(st.apps[0].status, "installing");
  release();
  await install;
});

// ─── catalog v4: optional services + the PI/PO destination check (0011) ──────
// Optional services (connectivity / destination for on-premise PI/PO) exist in
// the catalog but are never created by the normal "prepare the space" run. The
// admin asks for the group, or for one instance by name from Base services.

const CATALOG_V4 = {
  ...CATALOG,
  releaseVersion: "0.5.0",
  // Same shape as the real release: the two optional instances are also in the
  // shared backend's optionalServices, so a push binds them when they exist.
  platform: {
    ...CATALOG.platform,
    cfApps: [{ ...CATALOG.platform.cfApps[0], optionalServices: ["credstore", "figaf-connectivity", "figaf-destination"] }],
  },
  services: [
    { name: "db", offering: "postgresql-db", plan: "free", plans: ["free", "standard"], purpose: "database" },
    { name: "xsuaa", offering: "xsuaa", plan: "application", configFile: "xs-security.json", purpose: "roles" },
    { name: "credstore", offering: "credstore", plan: "free", config: { authentication: { type: "basic" } }, bindToManager: true },
    { name: "figaf-connectivity", offering: "connectivity", plan: "lite", optional: true, group: "pipo", sharedWith: "figaf-tool", purpose: "Cloud Connector tunnel" },
    { name: "figaf-destination", offering: "destination", plan: "lite", optional: true, group: "pipo", sharedWith: "figaf-tool", purpose: "PI/PO destinations" },
  ],
};

function makeV4Dir() {
  const dir = makeChannelDir(CATALOG_V4);
  fs.writeFileSync(path.join(dir, "xs-security.json"), "{\"xsappname\":\"figaf-faid\"}");
  return dir;
}

function servicesResponder(state) {
  return (args) => {
    if (args[0] === "create-service") { state[args[3]] = "create succeeded"; return { code: 0, stdout: "" }; }
    if (args[0] === "service") { const st = state[args[1]]; return st ? { code: 0, stdout: `status:    ${st}\n` } : { code: 1, stdout: "" }; }
    if (args[0] === "bind-service") return { code: 0, stdout: "OK" };
    return null;
  };
}

test("wantedService: required always, optional only when its group is asked for", () => {
  const required = { name: "db" };
  const optional = { name: "figaf-destination", optional: true, group: "pipo" };
  assert.equal(wantedService(required, undefined), true, "a required service is always wanted");
  assert.equal(wantedService(required, ["pipo"]), true);
  assert.equal(wantedService(optional, undefined), false, "an optional service is skipped by default");
  assert.equal(wantedService(optional, []), false);
  assert.equal(wantedService(optional, ["other"]), false);
  assert.equal(wantedService(optional, ["pipo"]), true);
});

test("faid:prepareSpaceServices: the optional PI/PO services are NOT created by default", async () => {
  const dir = makeV4Dir();
  const { ctx, calls } = makeCtx(dir, servicesResponder({}));
  ctx.host.getDeployTargetForSelf = () => ({ appName: "figaf-manager", apiUrl: "u", orgName: "o", spaceName: "s" });
  ctx.sleep = async () => {}; ctx.pollIntervalMs = 0;
  const r = await createFaidHandlers(ctx)["faid:prepareSpaceServices"]({ plans: {} });
  assert.equal(r.ok, true, JSON.stringify(r));
  const created = calls.filter((c) => c.args[0] === "create-service").map((c) => c.args[3]).sort();
  assert.deepEqual(created, ["credstore", "db"]);
});

test("faid:prepareSpaceServices: groups:['pipo'] adds connectivity and destination", async () => {
  const dir = makeV4Dir();
  const { ctx, calls } = makeCtx(dir, servicesResponder({}));
  ctx.host.getDeployTargetForSelf = () => ({ appName: "figaf-manager", apiUrl: "u", orgName: "o", spaceName: "s" });
  ctx.sleep = async () => {}; ctx.pollIntervalMs = 0;
  const r = await createFaidHandlers(ctx)["faid:prepareSpaceServices"]({ plans: {}, groups: ["pipo"] });
  assert.equal(r.ok, true, JSON.stringify(r));
  const created = calls.filter((c) => c.args[0] === "create-service");
  assert.deepEqual(created.map((c) => c.args[3]).sort(), ["credstore", "db", "figaf-connectivity", "figaf-destination"]);
  assert.deepEqual(
    created.find((c) => c.args[3] === "figaf-connectivity").args,
    ["create-service", "connectivity", "lite", "figaf-connectivity"]
  );
  assert.ok(!r.bound.includes("figaf-destination"), "shared services are not bound to the manager");
});

test("faid:provisionServices: `only` creates one optional instance (the Base services repair path)", async () => {
  const dir = makeV4Dir();
  const { ctx, calls } = makeCtx(dir, servicesResponder({}));
  ctx.sleep = async () => {}; ctx.pollIntervalMs = 0;
  const r = await createFaidHandlers(ctx)["faid:provisionServices"]({ only: ["figaf-destination"] });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(calls.filter((c) => c.args[0] === "create-service").map((c) => c.args[3]), ["figaf-destination"]);
});

test("faid:provisionServices: without `only` or `groups` the optional services stay untouched", async () => {
  const dir = makeV4Dir();
  const { ctx, calls } = makeCtx(dir, servicesResponder({}));
  ctx.sleep = async () => {}; ctx.pollIntervalMs = 0;
  await createFaidHandlers(ctx)["faid:provisionServices"]({});
  const created = calls.filter((c) => c.args[0] === "create-service").map((c) => c.args[3]);
  assert.ok(!created.includes("figaf-connectivity"), created.join(","));
  assert.ok(!created.includes("figaf-destination"), created.join(","));
});

test("faid:services: reports optional, group and sharedWith so the panel can show them apart", async () => {
  const dir = makeV4Dir();
  const { ctx } = makeCtx(dir, (args) => {
    if (args[0] === "service") return { code: 1, stdout: "" }; // everything missing
    return null;
  });
  const r = await createFaidHandlers(ctx)["faid:services"]();
  assert.equal(r.ok, true);
  const dest = r.services.find((s) => s.name === "figaf-destination");
  assert.equal(dest.optional, true);
  assert.equal(dest.group, "pipo");
  assert.equal(dest.sharedWith, "figaf-tool");
  const db = r.services.find((s) => s.name === "db");
  assert.equal(db.optional, false);
  assert.equal(db.group, "");
});

test("faid:services: optional instances report backendDeployed and boundToBackend (the panel offers the bind only when needed)", async () => {
  const dir = makeV4Dir();
  const { ctx, calls } = makeCtx(dir, (args) => {
    if (args[0] === "app" && args[1] === "arch-backend" && args[2] === "--guid") return { code: 0, stdout: "guid\n" };
    if (args[0] === "service") {
      return /^figaf-(connectivity|destination)$/.test(args[1]) ? { code: 0, stdout: "status:    create succeeded\n" } : { code: 1, stdout: "" };
    }
    if (args[0] === "curl" && /app_names=arch-backend$/.test(args[1])) {
      const bound = /service_instance_names=figaf-destination&/.test(args[1]);
      return { code: 0, stdout: JSON.stringify({ resources: bound ? [{ guid: "b1" }] : [] }) };
    }
    return null;
  });
  const r = await createFaidHandlers(ctx)["faid:services"]();
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.backend, "arch-backend");
  assert.equal(r.backendDeployed, true);
  const by = Object.fromEntries(r.services.map((s) => [s.name, s]));
  assert.equal(by["figaf-destination"].backendDeployed, true);
  assert.equal(by["figaf-destination"].boundToBackend, true);
  assert.equal(by["figaf-connectivity"].backendDeployed, true);
  assert.equal(by["figaf-connectivity"].boundToBackend, false);
  assert.equal(by.db.backendDeployed, null, "only optional rows carry the backend fields");
  assert.equal(by.db.boundToBackend, null);
  assert.equal(calls.filter((c) => c.args[0] === "app" && c.args[2] === "--guid").length, 1, "one existence probe, shared with the installed-version read");
  assert.equal(calls.filter((c) => c.args[0] === "curl" && /app_names=arch-backend$/.test(c.args[1])).length, 2, "one binding probe per ready optional instance");
});

test("faid:services: backend not deployed -> backendDeployed false, boundToBackend null, no binding probe", async () => {
  const dir = makeV4Dir();
  const { ctx, calls } = makeCtx(dir, (args) => {
    if (args[0] === "app" && args[1] === "arch-backend" && args[2] === "--guid") return { code: 1, stdout: "" };
    if (args[0] === "service") return { code: 0, stdout: "status:    create succeeded\n" };
    return null;
  });
  const r = await createFaidHandlers(ctx)["faid:services"]();
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.backendDeployed, false);
  const dest = r.services.find((s) => s.name === "figaf-destination");
  assert.equal(dest.backendDeployed, false);
  assert.equal(dest.boundToBackend, null);
  assert.ok(!calls.some((c) => c.args[0] === "curl" && /app_names=arch-backend/.test(c.args[1])), "no binding probe without a backend");
});

test("faid:services: a release without optional instances never probes the backend", async () => {
  const dir = makeV3Dir();
  const { ctx, calls } = makeCtx(dir, cfServiceResponder({ db: "create succeeded", credstore: "create succeeded" }));
  const r = await createFaidHandlers(ctx)["faid:services"]();
  assert.equal(r.ok, true);
  assert.equal(r.backendDeployed, null);
  assert.ok(r.services.every((s) => s.backendDeployed === null && s.boundToBackend === null));
  assert.ok(!calls.some((c) => c.args[0] === "curl" && /service_credential_bindings/.test(c.args[1])), "no binding probe when nothing is optional");
});

// faid:destinationCheck — the manager asks the shared backend, because only the
// backend is bound to the destination service (decision 0011).

function backendRouteResponder(args) {
  if (args[0] === "app" && args[1] === "arch-backend") {
    return { code: 0, stdout: "routes:   arch-backend.cfapps.example\n" };
  }
  return null;
}

test("faid:destinationCheck: asks the backend and passes its answer through", async () => {
  const dir = makeV4Dir();
  const { ctx, events } = makeCtx(dir, backendRouteResponder);
  httpsBodyResult = {
    status: 200,
    body: JSON.stringify({ ok: true, found: true, name: "PO_TPM_DEV", proxyType: "OnPremise", locationId: "pi-dev", warning: null }),
  };
  const r = await createFaidHandlers(ctx)["faid:destinationCheck"]({ destinationName: "PO_TPM_DEV" });
  assert.equal(r.ok, true);
  assert.equal(r.found, true);
  assert.equal(r.proxyType, "OnPremise");
  assert.equal(r.locationId, "pi-dev");
  const asked = events.filter((e) => e.channel === "httpsBody").map((e) => e.payload);
  assert.ok(asked.some((u) => u.endsWith("/health/destination?name=PO_TPM_DEV")), asked.join(","));
});

test("faid:destinationCheck: a name is required and nothing is called", async () => {
  const dir = makeV4Dir();
  const { ctx, events } = makeCtx(dir, backendRouteResponder);
  const r = await createFaidHandlers(ctx)["faid:destinationCheck"]({ destinationName: "  " });
  assert.equal(r.ok, false);
  assert.match(r.error, /destinationName is required/);
  assert.equal(events.filter((e) => e.channel === "httpsBody").length, 0);
});

test("faid:destinationCheck: no backend route -> ok:false with the install hint", async () => {
  const dir = makeV4Dir();
  const { ctx } = makeCtx(dir, (args) => {
    if (args[0] === "app" && args[1] === "arch-backend") return { code: 1, stdout: "" }; // not deployed
    return null;
  });
  const r = await createFaidHandlers(ctx)["faid:destinationCheck"]({ destinationName: "PO_TPM_DEV" });
  assert.equal(r.ok, false);
  assert.match(r.error, /not deployed yet/);
  assert.match(r.hint, /Install the platform/);
});

test("faid:destinationCheck: an old backend without the endpoint says so", async () => {
  const dir = makeV4Dir();
  const { ctx } = makeCtx(dir, backendRouteResponder);
  httpsBodyResult = { status: 404, body: "Cannot GET /health/destination" };
  const r = await createFaidHandlers(ctx)["faid:destinationCheck"]({ destinationName: "PO_TPM_DEV" });
  assert.equal(r.ok, false);
  assert.match(r.error, /no [/]health[/]destination endpoint/);
  assert.match(r.hint, /Update the installation/);
  httpsBodyResult = { status: 200, body: "{\"ok\":true}" };
});

test("faid:destinationCheck: the backend's own failure (503) is reported as a failed check", async () => {
  const dir = makeV4Dir();
  const { ctx } = makeCtx(dir, backendRouteResponder);
  httpsBodyResult = {
    status: 503,
    body: JSON.stringify({ ok: false, error: "this backend is not bound to a destination service instance", hint: "Create the PI/PO services" }),
  };
  const r = await createFaidHandlers(ctx)["faid:destinationCheck"]({ destinationName: "PO_TPM_DEV" });
  assert.equal(r.ok, false);
  assert.match(r.error, /not bound to a destination service/);
  assert.match(r.hint, /Create the PI[/]PO services/);
  httpsBodyResult = { status: 200, body: "{\"ok\":true}" };
});

// faid:bindPlatformService — the repair path for an optional instance created
// AFTER the backend was deployed (decision 0011). A binding only reaches a CF
// app after a restart, so it binds and restarts.

function bindResponder(state) {
  return (args) => {
    if (args[0] === "service") { const st = state[args[1]]; return st ? { code: 0, stdout: `status:    ${st}\n` } : { code: 1, stdout: "" }; }
    if (args[0] === "app" && args[1] === "arch-backend") return { code: 0, stdout: "routes:   arch-backend.cfapps.example\n" };
    if (args[0] === "bind-service") return { code: 0, stdout: "OK" };
    if (args[0] === "restart") return { code: 0, stdout: "OK" };
    return null;
  };
}

test("faid:bindPlatformService: binds the instance to the shared backend, then restarts it", async () => {
  const dir = makeV4Dir();
  const { ctx, calls } = makeCtx(dir, bindResponder({ "figaf-destination": "create succeeded" }));
  const r = await createFaidHandlers(ctx)["faid:bindPlatformService"]({ name: "figaf-destination" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.cfApp, "arch-backend");
  assert.deepEqual(calls.find((c) => c.args[0] === "bind-service").args, ["bind-service", "arch-backend", "figaf-destination"]);
  assert.deepEqual(calls.find((c) => c.args[0] === "restart").args, ["restart", "arch-backend"]);
});

test("faid:bindPlatformService: only the catalog's optional services may be bound", async () => {
  const dir = makeV4Dir();
  const { ctx, calls } = makeCtx(dir, bindResponder({ "figaf-faid-secret": "create succeeded" }));
  const r = await createFaidHandlers(ctx)["faid:bindPlatformService"]({ name: "figaf-faid-secret" });
  assert.equal(r.ok, false);
  assert.match(r.error, /not an optional service of the shared backend/);
  assert.ok(!calls.some((c) => c.args[0] === "bind-service"), "nothing is bound");
});

test("faid:bindPlatformService: an instance that is not ready is refused", async () => {
  const dir = makeV4Dir();
  const { ctx, calls } = makeCtx(dir, bindResponder({})); // missing
  const r = await createFaidHandlers(ctx)["faid:bindPlatformService"]({ name: "figaf-destination" });
  assert.equal(r.ok, false);
  assert.match(r.error, /not ready yet/);
  assert.ok(!calls.some((c) => c.args[0] === "bind-service"));
});

test("faid:bindPlatformService: no backend deployed -> says a later install binds it anyway", async () => {
  const dir = makeV4Dir();
  const { ctx, calls } = makeCtx(dir, (args) => {
    if (args[0] === "service") return { code: 0, stdout: "status:    create succeeded\n" };
    if (args[0] === "app") return { code: 1, stdout: "" };
    return null;
  });
  const r = await createFaidHandlers(ctx)["faid:bindPlatformService"]({ name: "figaf-connectivity" });
  assert.equal(r.ok, false);
  assert.match(r.error, /is not deployed/);
  assert.ok(!calls.some((c) => c.args[0] === "bind-service"));
});

test("faid:bindPlatformService: an already bound instance is fine; the restart still runs", async () => {
  const dir = makeV4Dir();
  const { ctx, calls } = makeCtx(dir, (args) => {
    if (args[0] === "service") return { code: 0, stdout: "status:    create succeeded\n" };
    if (args[0] === "app" && args[1] === "arch-backend") return { code: 0, stdout: "routes:   b.example\n" };
    if (args[0] === "bind-service") return { code: 1, stdout: "", stderr: "FAILED\nApp arch-backend is already bound to service figaf-destination" };
    if (args[0] === "restart") return { code: 0, stdout: "OK" };
    return null;
  });
  const r = await createFaidHandlers(ctx)["faid:bindPlatformService"]({ name: "figaf-destination" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.alreadyBound, true);
  assert.ok(calls.some((c) => c.args[0] === "restart"));
});

test("faid:bindPlatformService: a failed restart is reported, and says the binding is in place", async () => {
  const dir = makeV4Dir();
  const { ctx } = makeCtx(dir, (args) => {
    if (args[0] === "service") return { code: 0, stdout: "status:    create succeeded\n" };
    if (args[0] === "app" && args[1] === "arch-backend") return { code: 0, stdout: "routes:   b.example\n" };
    if (args[0] === "bind-service") return { code: 0, stdout: "OK" };
    if (args[0] === "restart") return { code: 1, stdout: "", stderr: "FAILED\ninsufficient memory" };
    return null;
  });
  const r = await createFaidHandlers(ctx)["faid:bindPlatformService"]({ name: "figaf-destination" });
  assert.equal(r.ok, false);
  assert.match(r.error, /is bound, but cf restart/);
  assert.equal(r.step, "restart");
});
