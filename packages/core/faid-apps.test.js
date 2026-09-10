"use strict";
// Tests for the FAID Apps manager (faid-apps.js).
//
// Coverage:
//   A. Pure helpers: loadCatalog validation, computeAppStatus rollup,
//      buildPushArgs, buildDestinationsEnv, validateConfigEnv whitelist.
//   B. Handler flows with an injected fake `run` recorder (no processes):
//      - faid:install happy path — command order per CF app:
//        push --no-start → bind-service (the kinds the CF app requires as a
//        binding, the optional group's instances when present) → set-env
//        (masked) → start; frontend gets a destinations env pointing at the
//        backend route. The instances are the manager's own (base-services.js,
//        catalog v7): figaf-faid-xsuaa, figaf-faid-credstore, figaf-db (own
//        role, never bound), the optional PI/PO pair figaf-connectivity /
//        figaf-destination.
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
  createFaidHandlers,
} = require("./faid-apps");
const { baseServices, wantedService } = require("./base-services");

// The default names of the manager's base instances (base-services.js).
const BASE_NAMES = baseServices().map((s) => s.name);

// ─── fixtures ────────────────────────────────────────────────────────────────

// Catalog v7: the shared backend connector lives in the `platform` block;
// the app entry holds only its frontend. configTargetCfApp points config and
// health at the connector. Every CF app says what it REQUIRES by kind; the
// instances are the manager's (base-services.js). This base fixture needs no
// database, so the deploy mechanics are tested without the database module.
const CATALOG = {
  releaseVersion: "0.2.0",
  platform: {
    name: "Platform base",
    cfApps: [
      {
        name: "arch-backend", artifact: "backend.zip", buildpack: "nodejs_buildpack",
        memory: "256M", disk: "1024M",
        requires: { xsuaa: "binding", credstore: "binding" }, optional: ["pipo"],
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
          requires: { xsuaa: "binding" },
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

// A release directory in the flat build shape: catalog, zips, and the release
// part of the XSUAA document (every release ships it; a release that requires
// XSUAA must have it).
function makeChannelDir(catalog = CATALOG) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "faid-test-"));
  fs.writeFileSync(path.join(dir, "catalog.json"), JSON.stringify(catalog));
  fs.writeFileSync(path.join(dir, "backend.zip"), "zip");
  fs.writeFileSync(path.join(dir, "frontend.zip"), "zip");
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

// What every fake cf answers unless the test says otherwise: the base
// instances exist and are ready, the landscape has a cfapps domain. So a
// deploy test passes the preflight (required instances, role refresh) and
// reaches its push; a test that wants an instance missing answers first.
function baseDefaults(args) {
  if (args[0] === "service" && BASE_NAMES.includes(args[1])) return { code: 0, stdout: `name: ${args[1]}\nstatus:    create succeeded\n` };
  return domainsResponder(args);
}

// The backend's database access (faid-database.js), faked: prepared on
// figaf-db unless a test says otherwise. Only releases whose backend requires
// the database as own-role ever ask it.
function fakeDatabase(status = { state: "prepared", prepared: true, instanceName: "figaf-db", instanceGuid: "g" }) {
  const calls = [];
  return {
    calls,
    status: async () => { calls.push("status"); return { ok: true, role: "faid_app", schema: "faid", ...status }; },
    prepare: async (a) => { calls.push(`prepare:${a.instanceName}`); return { ok: true, instanceName: a.instanceName }; },
    rotate: async () => { calls.push("rotate"); return { ok: true, instanceName: status.instanceName || "figaf-db", restartRequired: true }; },
    drop: async () => { calls.push("drop"); return { ok: true, instanceName: status.instanceName || "figaf-db" }; },
    certificateChain: async (a) => { calls.push(`certificate:${a.instanceName}`); return { ok: true, sslrootcert: "-----BEGIN CERTIFICATE-----\nFAKECA\n-----END CERTIFICATE-----\n", envName: "FAID_DATABASE_CA" }; },
  };
}

/**
 * Fake ctx for createFaidHandlers. `respond(args, opts)` answers a cf call
 * with a canned { code, stdout } (null = the defaults of baseDefaults, then
 * an empty success). Calls are recorded in `calls` ({ args, opts }); log
 * lines in `logLines`.
 */
function makeCtx(channelDir, respond) {
  const calls = [];
  const logLines = [];
  const events = [];
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "faid-user-"));
  return {
    calls, logLines, events, userDir,
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
        return respond(args, opts) || baseDefaults(args) || { code: 0, stdout: "", stderr: "" };
      },
      database: fakeDatabase(),
      log: (source, type, text) => logLines.push(text),
      send: (channel, payload) => events.push({ channel, payload }),
      resolveCf: () => "cf",
      // A real directory with one file, so the tests can check that the
      // extracted tree is removed after the deploy.
      extractZip: async (zip, dest) => { fs.mkdirSync(dest, { recursive: true }); fs.writeFileSync(path.join(dest, "package.json"), "{}"); },
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

test("buildPushArgs: a cfApp that names a stack is pushed with -s; without one the landscape default applies (no -s)", () => {
  const withStack = { ...CATALOG.platform.cfApps[0], stack: "cflinuxfs5" };
  assert.deepEqual(
    buildPushArgs(withStack, "/tmp/x", { noStart: true }),
    ["push", "arch-backend", "-p", "/tmp/x", "--no-manifest", "-b", "nodejs_buildpack", "-s", "cflinuxfs5", "-m", "256M", "-k", "1024M", "--no-start"]
  );
  assert.ok(!buildPushArgs(CATALOG.platform.cfApps[0], "/tmp/x", {}).includes("-s"));
});

// A catalog whose CF apps name a stack (release built for cflinuxfs5).
function catalogWithStack(stack = "cflinuxfs5") {
  const c = JSON.parse(JSON.stringify(CATALOG));
  for (const cfApp of [...c.platform.cfApps, ...c.apps.flatMap((a) => a.cfApps)]) cfApp.stack = stack;
  return c;
}
const CF_STACKS_WITHOUT_FS5 = "Getting stacks as u...\n\nname         description\ncflinuxfs3   Cloud Foundry Linux-based filesystem (Ubuntu 18.04)\ncflinuxfs4   Cloud Foundry Linux-based filesystem (Ubuntu 22.04)\n";
const CF_STACKS_WITH_FS5 = CF_STACKS_WITHOUT_FS5 + "cflinuxfs5   Cloud Foundry Linux-based filesystem (Ubuntu 24.04)\n";

test("faid:install: a release that needs a stack this landscape lacks fails before any push, naming the stack and what cf stacks offers", async () => {
  const dir = makeChannelDir(catalogWithStack());
  const { ctx, calls } = makeCtx(dir, (args) => {
    if (args[0] === "stacks") return { code: 0, stdout: CF_STACKS_WITHOUT_FS5 };
    if (args[0] === "app" && args[2] === "--guid") return { code: 1, stdout: "" };
    return { code: 0, stdout: "" };
  });
  const handlers = createFaidHandlers(ctx);
  const r = await handlers["faid:install"]({ appId: "arch" });
  assert.equal(r.ok, false);
  assert.equal(r.step, "stack");
  assert.match(r.error, /needs the Cloud Foundry stack cflinuxfs5/);
  assert.match(r.error, /cf stacks: cflinuxfs3, cflinuxfs4/);
  assert.ok(!calls.some((c) => c.args[0] === "push"), "nothing was pushed");
});

test("faid:install: with the stack available every push carries -s <stack>; a failing cf stacks only skips the check", async () => {
  const dir = makeChannelDir(catalogWithStack());
  const { ctx, calls } = makeCtx(dir, (args) => {
    if (args[0] === "stacks") return { code: 0, stdout: CF_STACKS_WITH_FS5 };
    if (args[0] === "app" && args[2] === "--guid") return { code: 1, stdout: "" }; // fresh
    if (args[0] === "app") return { code: 0, stdout: "routes: arch-backend.cfapps.example\n" };
    return null;
  });
  const r = await createFaidHandlers(ctx)["faid:install"]({ appId: "arch" });
  assert.equal(r.ok, true, JSON.stringify(r));
  const pushes = calls.filter((c) => c.args[0] === "push");
  assert.equal(pushes.length, 2);
  for (const p of pushes) {
    const i = p.args.indexOf("-s");
    assert.ok(i > 0 && p.args[i + 1] === "cflinuxfs5", p.args.join(" "));
  }
  assert.equal(calls.filter((c) => c.args[0] === "stacks").length, 1, "cf stacks is asked once per action");

  const dir2 = makeChannelDir(catalogWithStack());
  const { ctx: ctx2, calls: calls2, logLines } = makeCtx(dir2, (args) => {
    if (args[0] === "stacks") return { code: 1, stdout: "", stderr: "FAILED\nNot logged in" };
    if (args[0] === "app" && args[2] === "--guid") return { code: 1, stdout: "" };
    if (args[0] === "app") return { code: 0, stdout: "routes: arch-backend.cfapps.example\n" };
    return null;
  });
  const r2 = await createFaidHandlers(ctx2)["faid:install"]({ appId: "arch" });
  assert.equal(r2.ok, true, JSON.stringify(r2));
  assert.ok(logLines.some((l) => /cf stacks failed — the stack check is skipped/.test(l)), logLines.join("\n"));
  assert.ok(calls2.some((c) => c.args[0] === "push" && c.args.includes("cflinuxfs5")));
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

test("faid:install: full command sequence, the required kinds bound by the manager's names, optional group skipped when absent, destinations env set", async () => {
  const dir = makeChannelDir();
  const { ctx, calls, logLines, userDir } = makeCtx(dir, (args) => {
    if (args[0] === "app" && args[1] === "arch-backend" && args[2] === "--guid") return { code: 1, stdout: "" }; // fresh
    if (args[0] === "app" && args[1] === "arch-frontend" && args[2] === "--guid") return { code: 1, stdout: "" };
    if (args[0] === "service" && /^figaf-(connectivity|destination)$/.test(args[1])) return { code: 1, stdout: "" }; // optional group absent
    if (args[0] === "app" && args[1] === "arch-backend") return { code: 0, stdout: "name: arch-backend\nroutes:   arch-backend.cfapps.eu10.hana.ondemand.com\n" };
    return null;
  });
  const handlers = createFaidHandlers(ctx);
  const r = await handlers["faid:install"]({ appId: "arch" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.version, "0.2.0");

  const seq = calls.map((c) => c.args.slice(0, 2).join(" "));
  // backend: push --no-start … bind xsuaa, bind credstore, (probe the PI/PO pair), env×2, start
  assert.ok(seq.includes("push arch-backend"));
  assert.ok(seq.includes("bind-service arch-backend"));
  assert.ok(seq.includes("start arch-backend"));
  // the kinds the backend requires as a binding -> the module's instance names
  const backendBinds = calls.filter((c) => c.args[0] === "bind-service" && c.args[1] === "arch-backend").map((c) => c.args[2]);
  assert.deepEqual(backendBinds, ["figaf-faid-xsuaa", "figaf-faid-credstore"]);
  const frontendBinds = calls.filter((c) => c.args[0] === "bind-service" && c.args[1] === "arch-frontend").map((c) => c.args[2]);
  assert.deepEqual(frontendBinds, ["figaf-faid-xsuaa"]);
  // optional group absent → no bind of the PI/PO pair
  assert.ok(!calls.some((c) => c.args[0] === "bind-service" && /^figaf-(connectivity|destination)$/.test(c.args[2])));
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
  // the extracted trees are removed after the push (container disk quota)
  assert.ok(!fs.existsSync(path.join(userDir, "faid-apps", "arch", "arch-backend")), "backend work dir removed");
  assert.ok(!fs.existsSync(path.join(userDir, "faid-apps", "arch", "arch-frontend")), "frontend work dir removed");
});

test("faid:install: required bind failure aborts with an error", async () => {
  const dir = makeChannelDir();
  const { ctx, calls, userDir } = makeCtx(dir, (args) => {
    if (args[0] === "app" && args[2] === "--guid") return { code: 1, stdout: "" };
    if (args[0] === "bind-service" && args[2] === "figaf-faid-credstore") return { code: 1, stdout: "", stderr: "not found" };
    return null;
  });
  const handlers = createFaidHandlers(ctx);
  const r = await handlers["faid:install"]({ appId: "arch" });
  assert.equal(r.ok, false);
  assert.match(r.error, /bind-service figaf-faid-credstore failed/);
  assert.equal(r.failedApp, "arch-backend");
  // frontend never touched
  assert.ok(!calls.some((c) => c.args.includes("arch-frontend")));
  // the extracted tree is removed on failure too
  assert.ok(!fs.existsSync(path.join(userDir, "faid-apps", "arch", "arch-backend")), "work dir removed after a failed step");
});

test("faid:update on an existing app: set-env then push (no --no-start, no bind)", async () => {
  const dir = makeChannelDir();
  const { ctx, calls } = makeCtx(dir, (args) => {
    if (args[0] === "app" && args[2] === "--guid") return { code: 0, stdout: "guid" }; // exists
    if (args[0] === "app" && args[1] === "arch-backend") return { code: 0, stdout: "routes:   b.example.com\n" };
    return null;
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
    if (args[0] === "app" && args[1] === "arch-backend") return { code: 0, stdout: "routes:   b.example.com\n" };
    return null;
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

// ─── C. the base services (catalog v7 `requires`, base-services.js) ──────────

// A release whose backend requires all three base kinds: the database with
// its own role (never bound), XSUAA and the Credential Store as bindings. No
// optional group here (CATALOG_V4 below adds the PI/PO pair).
const CATALOG_BASE = {
  ...CATALOG,
  releaseVersion: "0.3.2",
  platform: {
    ...CATALOG.platform,
    cfApps: [{ ...CATALOG.platform.cfApps[0], requires: { database: "own-role", xsuaa: "binding", credstore: "binding" }, optional: [] }],
  },
};

function makeBaseDir() {
  const dir = makeChannelDir(CATALOG_BASE);
  fs.writeFileSync(path.join(dir, "xs-security.json"), "{\"xsappname\":\"figaf-faid\"}");
  return dir;
}

// `cf service <name>` fake: names in `existing` report the given status text,
// every other instance is missing.
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

test("loadCatalog: a catalog that still names service instances (v6 or older) is refused; an unknown kind or group is a catalog error", () => {
  assert.equal(loadCatalog(makeBaseDir()).ok, true);
  const old = makeChannelDir({ ...CATALOG, services: [{ name: "figaf-db", offering: "postgresql-db", plan: "free" }] });
  assert.match(loadCatalog(old).error, /catalog v6 or older.*this manager needs catalog v7/);
  const names = JSON.parse(JSON.stringify(CATALOG));
  names.platform.cfApps[0].services = ["figaf-faid-xsuaa"];
  assert.match(loadCatalog(makeChannelDir(names)).error, /platform cfApp arch-backend names service instances/);
  const kind = JSON.parse(JSON.stringify(CATALOG));
  kind.apps[0].cfApps[0].requires = { hana: "binding" };
  assert.match(loadCatalog(makeChannelDir(kind)).error, /app 'arch' cfApp arch-frontend requires an unknown service kind 'hana'/);
  const group = JSON.parse(JSON.stringify(CATALOG));
  group.platform.cfApps[0].optional = ["mail"];
  assert.match(loadCatalog(makeChannelDir(group)).error, /unknown optional group 'mail'/);
});

test("faid:services: the module's rows for the kinds the release requires, with the live status and the manager binding of the Credential Store", async () => {
  const dir = makeBaseDir();
  const { ctx } = makeCtx(dir, cfServiceResponder(
    { "figaf-db": "create in progress", "figaf-faid-credstore": "create succeeded" },
    (args) => (args[0] === "curl" && /service_credential_bindings/.test(args[1]))
      ? { code: 0, stdout: JSON.stringify({ resources: [{ guid: "b1" }] }) } : null
  ));
  ctx.host.getDeployTargetForSelf = () => ({ appName: "figaf-manager", apiUrl: "u", orgName: "o", spaceName: "s" });
  const handlers = createFaidHandlers(ctx);
  const r = await handlers["faid:services"]();
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.selfApp, "figaf-manager");
  assert.deepEqual(r.services.map((s) => s.name), ["figaf-db", "figaf-faid-xsuaa", "figaf-faid-credstore"], "no optional row without a group in the catalog");
  const by = Object.fromEntries(r.services.map((s) => [s.name, s]));
  assert.equal(by["figaf-db"].status, "in-progress");
  assert.equal(by["figaf-db"].kind, "database");
  assert.equal(by["figaf-db"].access, "own-role");
  assert.equal(by["figaf-db"].nameEditable, true);
  assert.equal(by["figaf-faid-xsuaa"].status, "missing");
  assert.equal(by["figaf-faid-credstore"].status, "ready");
  assert.equal(by["figaf-faid-credstore"].boundToManager, true);
  assert.equal(by["figaf-faid-credstore"].bindToManager, true);
  assert.equal(by["figaf-db"].boundToManager, null); // not a bindToManager entry
  assert.deepEqual(by["figaf-db"].plans, ["free", "standard"]);
  assert.deepEqual(by["figaf-faid-xsuaa"].plans, ["application"]);
});

test("faid:provisionServices: creates only the missing ones, passes configs as files, honors a plan override, waits until ready", async () => {
  const dir = makeBaseDir();
  const state = { "figaf-faid-credstore": "create succeeded" }; // db + xsuaa missing
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
  const r = await handlers["faid:provisionServices"]({ plans: { "figaf-db": "standard" } });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.created.sort(), ["figaf-db", "figaf-faid-xsuaa"]);
  const creates = calls.filter((c) => c.args[0] === "create-service");
  assert.equal(creates.length, 2);
  const dbCreate = creates.find((c) => c.args[3] === "figaf-db");
  assert.deepEqual(dbCreate.args, ["create-service", "postgresql-db", "standard", "figaf-db"]);
  const xsCreate = creates.find((c) => c.args[3] === "figaf-faid-xsuaa");
  assert.equal(xsCreate.args[4], "-c");
  // decision 0009: the xsuaa config is the COMPOSED document (release + manager part)
  assert.equal(path.basename(xsCreate.args[5]), "xs-security.composed.json");
  assert.ok(fs.existsSync(xsCreate.args[5]), "the composed config file must exist");
  // credstore existed → never re-created
  assert.ok(!creates.some((c) => c.args[3] === "figaf-faid-credstore"));
});

test("faid:provisionServices: rejects a plan the module does not allow; inline config written to a file", async () => {
  const dir = makeBaseDir();
  const state = {}; // everything missing
  const { ctx, calls } = makeCtx(dir, (args) => {
    if (domainsResponder(args)) return domainsResponder(args);
    if (args[0] === "create-service") { state[args[3]] = "create succeeded"; return { code: 0, stdout: "" }; }
    if (args[0] === "service") return state[args[1]] ? { code: 0, stdout: `status: ${state[args[1]]}` } : { code: 1, stdout: "" };
    return null;
  });
  ctx.sleep = async () => {};
  const handlers = createFaidHandlers(ctx);
  const r = await handlers["faid:provisionServices"]({ plans: { "figaf-db": "enterprise" } });
  assert.equal(r.ok, false);
  assert.match(r.error, /plan 'enterprise' is not allowed for figaf-db \(allowed: free, standard\)/);
  // the other two were still created
  assert.deepEqual(r.created.sort(), ["figaf-faid-credstore", "figaf-faid-xsuaa"]);
  const cs = calls.find((c) => c.args[0] === "create-service" && c.args[3] === "figaf-faid-credstore");
  assert.equal(cs.args[4], "-c");
  assert.deepEqual(JSON.parse(fs.readFileSync(cs.args[5], "utf8")), { authentication: { type: "basic" } });
});

test("faid:provisionServices: a failed creation is reported, the deadline stops the wait", async () => {
  const dir = makeBaseDir();
  const state = { "figaf-faid-xsuaa": "create succeeded" };
  const { ctx } = makeCtx(dir, (args) => {
    if (args[0] === "create-service") {
      state[args[3]] = args[3] === "figaf-db" ? "create failed" : "create in progress"; // credstore never finishes
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
  assert.ok(r.failed.some((f) => f.name === "figaf-db"));
  assert.deepEqual(r.timedOut, ["figaf-faid-credstore"]);
});

test("faid:provisionServices: a FAILED instance (not the database) is deleted and created again; cf error text is carried", async () => {
  const dir = makeBaseDir();
  const state = { "figaf-db": "create succeeded", "figaf-faid-xsuaa": "create succeeded", "figaf-faid-credstore": "create failed" };
  let deleted = false;
  const { ctx, calls } = makeCtx(dir, (args) => {
    if (args[0] === "delete-service") { deleted = true; delete state[args[1]]; return { code: 0, stdout: "" }; }
    if (args[0] === "create-service") {
      if (args[3] === "figaf-faid-credstore") { state["figaf-faid-credstore"] = "create succeeded"; return { code: 0, stdout: "" }; }
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
  assert.deepEqual(r.created, ["figaf-faid-credstore"]);
  const order = calls.filter((c) => ["delete-service", "create-service"].includes(c.args[0])).map((c) => c.args[0]);
  assert.deepEqual(order, ["delete-service", "create-service"]);
  assert.deepEqual(calls.find((c) => c.args[0] === "delete-service").args, ["delete-service", "figaf-faid-credstore", "-f"]);

  // Error text from cf reaches the caller.
  const dir2 = makeBaseDir();
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
  const dir = makeBaseDir();
  const { ctx, calls } = makeCtx(dir, () => null);
  ctx.host.getDeployTargetForSelf = () => ({ appName: "figaf-manager" });
  const handlers = createFaidHandlers(ctx);
  const r = await handlers["faid:bindManagerService"]({ name: "figaf-faid-credstore" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.restartRequired, true);
  assert.deepEqual(calls.find((c) => c.args[0] === "bind-service").args, ["bind-service", "figaf-manager", "figaf-faid-credstore"]);
  const bad = await handlers["faid:bindManagerService"]({ name: "figaf-db" });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /not a manager-bound service/);
  const rs = await handlers["faid:restartSelf"]();
  assert.equal(rs.ok, true);
  assert.deepEqual(calls.find((c) => c.args[0] === "restart").args, ["restart", "figaf-manager"]);
});

test("faid:bindManagerService outside CF (no self app name) is a clear error", async () => {
  const { ctx } = makeCtx(makeBaseDir(), () => null);
  const handlers = createFaidHandlers(ctx);
  const r = await handlers["faid:bindManagerService"]({ name: "figaf-faid-credstore" });
  assert.equal(r.ok, false);
  assert.match(r.error, /not running in CF/);
});

test("faid:install refuses while a required instance is missing; the own-role database is not part of that check", async () => {
  const dir = makeBaseDir();
  const { ctx, calls } = makeCtx(dir, cfServiceResponder({ "figaf-faid-xsuaa": "create succeeded" })); // credstore missing, db missing too
  const handlers = createFaidHandlers(ctx);
  const r = await handlers["faid:install"]({ appId: "arch" });
  assert.equal(r.ok, false);
  assert.match(r.error, /required service instance\(s\) missing: figaf-faid-credstore — create them first \(Setup, step 3\)/);
  assert.ok(!r.error.includes("figaf-db"), "the database is never a binding, so it is not in the binding check");
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

function makeBaseDirWithPlaceholder() {
  const dir = makeChannelDir(CATALOG_BASE);
  fs.writeFileSync(path.join(dir, "xs-security.json"), JSON.stringify({
    xsappname: "figaf-faid",
    "oauth2-configuration": { "redirect-uris": [`https://*.${APPS_DOMAIN_PLACEHOLDER}/**`] },
  }));
  return dir;
}

test("faid:provisionServices: fills __CF_APPS_DOMAIN__ in the release's xs-security.json from the landscape's cfapps domain; the release file stays untouched", async () => {
  const dir = makeBaseDirWithPlaceholder();
  const state = { "figaf-db": "create succeeded", "figaf-faid-credstore": "create succeeded" }; // only xsuaa missing
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
  assert.deepEqual(r.created, ["figaf-faid-xsuaa"]);
  const xsCreate = calls.find((c) => c.args[0] === "create-service" && c.args[3] === "figaf-faid-xsuaa");
  assert.equal(xsCreate.args[4], "-c");
  const written = fs.readFileSync(xsCreate.args[5], "utf8");
  assert.ok(!written.includes(APPS_DOMAIN_PLACEHOLDER), "placeholder must be filled");
  assert.ok(written.includes("https://*.cfapps.eu10-004.hana.ondemand.com/**"), written);
  assert.notEqual(path.dirname(xsCreate.args[5]), dir, "the filled copy must not overwrite the release file");
  assert.ok(fs.readFileSync(path.join(dir, "xs-security.json"), "utf8").includes(APPS_DOMAIN_PLACEHOLDER), "release file untouched");
  assert.ok(logLines.some((l) => l.includes("cfapps.eu10-004.hana.ondemand.com")), "the filled domain is shown in the terminal");
});

test("faid:provisionServices: no cfapps domain in the landscape -> the XSUAA instance is reported failed with a clear error and is not created", async () => {
  const dir = makeBaseDirWithPlaceholder();
  const state = { "figaf-db": "create succeeded", "figaf-faid-credstore": "create succeeded" };
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
  assert.equal(r.failed[0].name, "figaf-faid-xsuaa");
  assert.match(r.failed[0].error, /no cfapps\.\* domain/);
  assert.ok(!calls.some((c) => c.args[0] === "create-service"), "nothing is created without a domain");
});

test("faid:provisionServices: the XSUAA config is ALWAYS composed - the manager's roles are added to the release part (decision 0009)", async () => {
  const dir = makeBaseDir(); // release part: {"xsappname":"figaf-faid"}, no placeholder
  const state = { "figaf-db": "create succeeded", "figaf-faid-credstore": "create succeeded" };
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
  const xsCreate = calls.find((c) => c.args[0] === "create-service" && c.args[3] === "figaf-faid-xsuaa");
  assert.notEqual(xsCreate.args[5], path.join(dir, "xs-security.json"), "the composed copy, never the release file");
  const doc = JSON.parse(fs.readFileSync(xsCreate.args[5], "utf8"));
  assert.equal(doc.xsappname, "figaf-faid");
  assert.ok(doc.scopes.some((s) => s.name === "$XSAPPNAME.FAIDManagerOperator"), "manager scope merged in");
  assert.ok(doc["role-collections"].some((c) => c.name === "FAID-Manager-Admin"), "manager collection merged in");
  assert.deepEqual(doc["oauth2-configuration"]["redirect-uris"], ["https://*.cfapps.eu10-004.hana.ondemand.com/**"]);
});

test("faid:provisionServices: the PI/PO pair is created without a config file; a release that requires no XSUAA needs no xs-security.json", async () => {
  const noXsuaa = JSON.parse(JSON.stringify(CATALOG));
  noXsuaa.platform.cfApps[0].requires = { credstore: "binding" };
  noXsuaa.apps[0].cfApps[0].requires = {};
  const dir = makeChannelDir(noXsuaa); // no xs-security.json written
  const state = {};
  const { ctx, calls } = makeCtx(dir, (args) => {
    if (args[0] === "create-service") { state[args[3]] = "create succeeded"; return { code: 0, stdout: "" }; }
    if (args[0] === "service") { const st = state[args[1]]; return st ? { code: 0, stdout: `status:    ${st}\n` } : { code: 1, stdout: "" }; }
    return null;
  });
  ctx.sleep = async () => {};
  ctx.pollIntervalMs = 0;
  const handlers = createFaidHandlers(ctx);
  const r = await handlers["faid:provisionServices"]({ groups: ["pipo"] });
  assert.equal(r.ok, true, JSON.stringify(r));
  const creates = calls.filter((c) => c.args[0] === "create-service");
  assert.deepEqual(creates.map((c) => c.args.slice(0, 4)), [
    ["create-service", "credstore", "free", "figaf-faid-credstore"],
    ["create-service", "connectivity", "lite", "figaf-connectivity"],
    ["create-service", "destination", "lite", "figaf-destination"],
  ]);
  assert.ok(creates.slice(1).every((c) => !c.args.includes("-c")), "the PI/PO pair takes no config");
  assert.ok(!calls.some((c) => c.args[0] === "curl" && c.args[1] === "/v3/domains"), "no domain lookup without XSUAA");
});

// ─── E. one XSUAA instance for the manager and the apps (decision 0009) ──────

test("faid:ensureXsuaa: instance missing -> create-service figaf-faid-xsuaa with the composed document, then wait until ready", async () => {
  const dir = makeBaseDirWithPlaceholder();
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
  const dir = makeBaseDirWithPlaceholder();
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
  const dir = makeBaseDirWithPlaceholder();
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
  assert.deepEqual(r.created, ["figaf-faid-credstore"]);
  assert.deepEqual(r.bound, ["figaf-faid-credstore"]);
  assert.deepEqual(calls.filter((c) => c.args[0] === "create-service").map((c) => c.args[3]), ["figaf-faid-credstore"]);
  const create = calls.find((c) => c.args[0] === "create-service");
  assert.equal(create.args[4], "-c", "the credstore basic-auth config is passed as a file");
  assert.deepEqual(JSON.parse(fs.readFileSync(create.args[5], "utf8")), { authentication: { type: "basic" } });
  assert.deepEqual(calls.find((c) => c.args[0] === "bind-service").args, ["bind-service", "figaf-manager", "figaf-faid-credstore"]);
  assert.ok(!calls.some((c) => c.args[0] === "restart"), "no restart in this step");
  assert.ok(!calls.some((c) => c.args[0] === "curl" && c.args[1] === "/v3/domains"), "xsuaa is not touched here");
});

test("faid:prepareManagerServices: re-run with the instance present and already bound is a success; a create failure is reported and nothing is bound", async () => {
  const dir = makeBaseDirWithPlaceholder();
  const { ctx: ctx1, calls: calls1 } = makeCtx(dir, (args) => {
    if (args[0] === "service" && args[1] === "figaf-faid-credstore") return { code: 0, stdout: "status:    create succeeded\n" };
    if (args[0] === "bind-service") return { code: 1, stdout: "", stderr: "Service instance figaf-faid-credstore is already bound to application figaf-manager." };
    return null;
  });
  ctx1.host.getDeployTargetForSelf = () => ({ appName: "figaf-manager", apiUrl: "u", orgName: "o", spaceName: "s" });
  ctx1.sleep = async () => {}; ctx1.pollIntervalMs = 0;
  const r1 = await createFaidHandlers(ctx1)["faid:prepareManagerServices"]({});
  assert.equal(r1.ok, true, JSON.stringify(r1));
  assert.deepEqual(r1.created, []);
  assert.deepEqual(r1.bound, ["figaf-faid-credstore"]);
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

test("faid:install: the shared XSUAA instance is UPDATED (role refresh) before the shared backend is pushed", async () => {
  const dir = makeBaseDirWithPlaceholder();
  const state = { "figaf-db": "create succeeded", "figaf-faid-xsuaa": "create succeeded", "figaf-faid-credstore": "create succeeded" };
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

test("faid:install: a failed role refresh stops the install before any push, with step/cfApp/command", async () => {
  const dir = makeBaseDirWithPlaceholder();
  const state = { "figaf-db": "create succeeded", "figaf-faid-xsuaa": "create succeeded", "figaf-faid-credstore": "create succeeded" };
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
    return null;
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
    if (args[0] === "bind-service" && args[2] === "figaf-faid-xsuaa") return { code: 1, stdout: "FAILED\n", stderr: "Service instance figaf-faid-xsuaa not found\n" };
    return null;
  });
  const r = await createFaidHandlers(ctx)["faid:install"]({ appId: "arch" });
  assert.equal(r.ok, false);
  assert.equal(r.step, "bind");
  assert.equal(r.cfApp, "arch-backend");
  assert.equal(r.command, "cf bind-service arch-backend figaf-faid-xsuaa");
  assert.match(r.error, /^bind-service figaf-faid-xsuaa failed — does the service instance exist in this space\?: Service instance figaf-faid-xsuaa not found$/);
});

test("faid:install: a failed cf start keeps the 'see the staging log' pointer and adds cf's last lines", async () => {
  const dir = makeChannelDir();
  const { ctx } = makeCtx(dir, (args) => {
    if (args[0] === "app" && args[2] === "--guid") return { code: 1, stdout: "" };
    if (args[0] === "app" && args[1] === "arch-backend") return { code: 0, stdout: "routes:   b.example.com\n" };
    if (args[0] === "start") return { code: 1, stdout: "Staging app...\nFAILED\n", stderr: "Start unsuccessful\nTIP: use 'cf logs arch-backend --recent' for more information\n" };
    return null;
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
  const dir = makeChannelDir();
  const { ctx, logLines, calls } = makeCtx(dir, (args) => (args[0] === "service" ? { code: 1, stdout: "" } : null));
  const r = await createFaidHandlers(ctx)["faid:install"]({ appId: "arch" });
  assert.equal(r.ok, false);
  assert.match(r.error, /required service instance\(s\) missing: figaf-faid-xsuaa, figaf-faid-credstore/);
  assert.ok(logLines.some((l) => l.startsWith("install arch FAILED: required service instance(s) missing")));
  assert.ok(!calls.some((c) => c.args[0] === "push"), "nothing may be pushed");
});

// ─── Setup step 1: faid:prepareSpaceServices (docs/faid-apps-console/SPEC.md 5.2) ────────────

test("faid:prepareSpaceServices: creates every missing instance except XSUAA with the chosen plans, waits only for the Credential Store, binds it, leaves the database creating (pending); no restart", async () => {
  const dir = makeBaseDirWithPlaceholder();
  const state = {}; // everything missing
  const { ctx, calls, logLines } = makeCtx(dir, (args) => {
    if (args[0] === "create-service") {
      // credstore is quick; the database stays "in progress" (nobody waits for it)
      state[args[3]] = args[3] === "figaf-db" ? "create in progress" : "create succeeded";
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
  const r = await handlers["faid:prepareSpaceServices"]({ plans: { "figaf-db": "standard", "figaf-faid-credstore": "free" } });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.created.sort(), ["figaf-db", "figaf-faid-credstore"]);
  assert.deepEqual(r.bound, ["figaf-faid-credstore"]);
  assert.deepEqual(r.pending, ["figaf-db"]);
  assert.deepEqual(r.failed, []);
  const creates = calls.filter((c) => c.args[0] === "create-service");
  assert.deepEqual(creates.map((c) => c.args[3]).sort(), ["figaf-db", "figaf-faid-credstore"], "xsuaa is owned by faid:ensureXsuaa");
  assert.deepEqual(creates.find((c) => c.args[3] === "figaf-db").args.slice(0, 4), ["create-service", "postgresql-db", "standard", "figaf-db"]);
  assert.deepEqual(calls.find((c) => c.args[0] === "bind-service").args, ["bind-service", "figaf-manager", "figaf-faid-credstore"]);
  assert.ok(!calls.some((c) => c.args[0] === "restart"), "no restart in this step");
  assert.ok(!calls.some((c) => c.args[0] === "curl" && c.args[1] === "/v3/domains"), "xsuaa is not touched here");
  assert.ok(logLines.some((l) => /figaf-db: still being created/.test(l)), "the terminal says the database is left creating");
});

test("faid:prepareSpaceServices: a plan the module does not allow fails that instance only; the Credential Store is still created and bound; ok:false carries the reason", async () => {
  const dir = makeBaseDirWithPlaceholder();
  const state = {};
  const { ctx, calls } = makeCtx(dir, (args) => {
    if (args[0] === "create-service") { state[args[3]] = "create succeeded"; return { code: 0, stdout: "" }; }
    if (args[0] === "service") { const st = state[args[1]]; return st ? { code: 0, stdout: `status:    ${st}\n` } : { code: 1, stdout: "" }; }
    if (args[0] === "bind-service") return { code: 0, stdout: "OK" };
    return null;
  });
  ctx.host.getDeployTargetForSelf = () => ({ appName: "figaf-manager", apiUrl: "u", orgName: "o", spaceName: "s" });
  ctx.sleep = async () => {}; ctx.pollIntervalMs = 0;
  const r = await createFaidHandlers(ctx)["faid:prepareSpaceServices"]({ plans: { "figaf-db": "enterprise" } });
  assert.equal(r.ok, false);
  assert.match(r.error, /plan 'enterprise' is not allowed for figaf-db/);
  assert.deepEqual(r.created, ["figaf-faid-credstore"]);
  assert.deepEqual(r.bound, ["figaf-faid-credstore"]);
  assert.ok(!calls.some((c) => c.args[0] === "create-service" && c.args[3] === "figaf-db"));
});

test("faid:prepareSpaceServices: a Credential Store that cannot be created (free plan used up) is reported and NOT bound; the database is still started", async () => {
  const dir = makeBaseDirWithPlaceholder();
  const state = {};
  const { ctx, calls } = makeCtx(dir, (args) => {
    if (args[0] === "create-service") {
      if (args[3] === "figaf-faid-credstore") return { code: 1, stdout: "", stderr: "FAILED\nService plan free: only one instance allowed per subaccount" };
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
  assert.deepEqual(r.created, ["figaf-db"]);
  assert.deepEqual(r.pending, ["figaf-db"]);
  assert.deepEqual(r.bound, []);
  assert.ok(!calls.some((c) => c.args[0] === "bind-service"), "nothing bound after a failed create");
});

test("faid:prepareSpaceServices: instances that exist are left alone; an already bound Credential Store is a success; no release = nothing to do", async () => {
  const dir = makeBaseDirWithPlaceholder();
  const { ctx, calls } = makeCtx(dir, (args) => {
    if (args[0] === "service") return { code: 0, stdout: "status:    create succeeded\n" };
    if (args[0] === "bind-service") return { code: 1, stdout: "", stderr: "Service instance figaf-faid-credstore is already bound to application figaf-manager." };
    return null;
  });
  ctx.host.getDeployTargetForSelf = () => ({ appName: "figaf-manager", apiUrl: "u", orgName: "o", spaceName: "s" });
  ctx.sleep = async () => {}; ctx.pollIntervalMs = 0;
  const r = await createFaidHandlers(ctx)["faid:prepareSpaceServices"]({});
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.created, []);
  assert.deepEqual(r.pending, []);
  assert.deepEqual(r.bound, ["figaf-faid-credstore"]);
  assert.ok(!calls.some((c) => c.args[0] === "create-service"));

  const { ctx: ctx2 } = makeCtx(dir, () => null);
  ctx2.host.resolveFaidReleaseSource = () => null;
  const r2 = await createFaidHandlers(ctx2)["faid:prepareSpaceServices"]({});
  assert.equal(r2.ok, true);
  assert.match(r2.note, /nothing to prepare/);
});

test("faid:provisionServices with waitOnly: only the named instances are awaited; a not-awaited instance that already failed is reported failed", async () => {
  const dir = makeBaseDir();
  const state = {};
  let polls = 0;
  const { ctx } = makeCtx(dir, (args) => {
    if (domainsResponder(args)) return domainsResponder(args);
    if (args[0] === "create-service") {
      state[args[3]] = args[3] === "figaf-db" ? "create failed" : "create in progress";
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
  const r = await createFaidHandlers(ctx)["faid:provisionServices"]({ waitOnly: ["figaf-faid-credstore", "figaf-faid-xsuaa"] });
  assert.equal(r.ok, false);
  assert.ok(r.failed.some((f) => f.name === "figaf-db"), JSON.stringify(r));
  assert.deepEqual(r.timedOut, []);
  assert.deepEqual(r.pending, []);
});

test("faid:install refuses with a pointer to Setup step 3 while a required instance is missing", async () => {
  const dir = makeBaseDir();
  const { ctx } = makeCtx(dir, cfServiceResponder({ "figaf-db": "create succeeded", "figaf-faid-xsuaa": "create succeeded" }));
  ctx.sleep = async () => {};
  const r = await createFaidHandlers(ctx)["faid:install"]({ appId: "arch" });
  assert.equal(r.ok, false);
  assert.match(r.error, /required service instance\(s\) missing: figaf-faid-credstore — create them first \(Setup, step 3\)/);
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
    if (args[0] === "service" && /^figaf-(connectivity|destination)$/.test(args[1])) return { code: 1, stdout: "" };
    if (args[0] === "app" && args[1] === "arch-backend") return { code: 0, stdout: "routes:   b.example.com\n" };
    return null;
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
    if (args[0] === "service" && /^figaf-(connectivity|destination)$/.test(args[1])) return { code: 1, stdout: "" };
    if (args[0] === "app" && args[1] === "arch-backend") return { code: 0, stdout: "routes:   b.example.com\n" };
    if (args[0] === "target") return { code: 0, stdout: "org: o\nspace: myspace\n" };
    if (args[0] === "space") return { code: 0, stdout: "space-guid-1\n" };
    if (args[0] === "curl" && /\/v3\/apps\?/.test(args[1])) return { code: 0, stdout: JSON.stringify({ resources: [] }) };
    return null;
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

// ─── the optional PI/PO group + the destination check (decision 0011) ────────
// The optional instances (connectivity / destination for on-premise PI/PO)
// are the module's; a release names the GROUP on its backend (`optional:
// ["pipo"]`). They are never created by the normal "prepare the space" run:
// the admin asks for the group, or for one instance by name from Base services.

const CATALOG_V4 = {
  ...CATALOG_BASE,
  releaseVersion: "0.5.0",
  // Same shape as the real release: the shared backend names the optional
  // group, so a push binds its instances when they exist.
  platform: {
    ...CATALOG_BASE.platform,
    cfApps: [{ ...CATALOG_BASE.platform.cfApps[0], optional: ["pipo"] }],
  },
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
  const required = { name: "figaf-db" };
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
  assert.deepEqual(created, ["figaf-db", "figaf-faid-credstore"]);
});

test("faid:prepareSpaceServices: groups:['pipo'] adds connectivity and destination", async () => {
  const dir = makeV4Dir();
  const { ctx, calls } = makeCtx(dir, servicesResponder({}));
  ctx.host.getDeployTargetForSelf = () => ({ appName: "figaf-manager", apiUrl: "u", orgName: "o", spaceName: "s" });
  ctx.sleep = async () => {}; ctx.pollIntervalMs = 0;
  const r = await createFaidHandlers(ctx)["faid:prepareSpaceServices"]({ plans: {}, groups: ["pipo"] });
  assert.equal(r.ok, true, JSON.stringify(r));
  const created = calls.filter((c) => c.args[0] === "create-service");
  assert.deepEqual(created.map((c) => c.args[3]).sort(), ["figaf-connectivity", "figaf-db", "figaf-destination", "figaf-faid-credstore"]);
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
  const db = r.services.find((s) => s.name === "figaf-db");
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
  assert.equal(by["figaf-db"].backendDeployed, null, "only optional rows carry the backend fields");
  assert.equal(by["figaf-db"].boundToBackend, null);
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

test("faid:services: a release without an optional group never probes the backend", async () => {
  const dir = makeBaseDir();
  const { ctx, calls } = makeCtx(dir, cfServiceResponder({ "figaf-db": "create succeeded", "figaf-faid-credstore": "create succeeded" }));
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

test("faid:bindPlatformService: only the instances of the optional groups the backend names may be bound", async () => {
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

// ─── decision 0016 (catalog v5): the Figaf API client must carry the release's authorities ─

const CATALOG_V5 = { ...CATALOG_BASE, releaseVersion: "0.6.0", figafScopes: ["agent:read", "ctt:sync"] };
function makeV5Dir() {
  const dir = makeChannelDir(CATALOG_V5);
  fs.writeFileSync(path.join(dir, "xs-security.json"), "{\"xsappname\":\"figaf-faid\"}");
  return dir;
}
const V3_READY = { "figaf-db": "create succeeded", "figaf-faid-xsuaa": "create succeeded", "figaf-faid-credstore": "create succeeded" };
function v3InstallResponder(args) {
  if (args[0] === "app" && args[2] === "--guid") return { code: 1, stdout: "" }; // fresh space
  if (args[0] === "app") return { code: 0, stdout: "routes: arch-backend.cfapps.example\n" };
  return domainsResponder(args);
}

test("faid:install refuses when the stored Figaf API client lacks an authority the release needs (v5): step figafScopes, before any push or role refresh", async () => {
  const { ctx, calls } = makeCtx(makeV5Dir(), cfServiceResponder(V3_READY, v3InstallResponder));
  const asked = [];
  ctx.checkFigafScopes = async (required) => { asked.push(required); return { ok: true, configured: true, granted: ["agent:read"], missing: ["ctt:sync"] }; };
  const r = await createFaidHandlers(ctx)["faid:install"]({ appId: "arch" });
  assert.equal(r.ok, false);
  assert.equal(r.step, "figafScopes");
  assert.match(r.error, /lacks the authorities ctt:sync that release 0\.6\.0 needs/);
  assert.match(r.error, /Replace connection/);
  assert.deepEqual(asked, [["agent:read", "ctt:sync"]]);
  assert.ok(!calls.some((c) => c.args[0] === "push"), "nothing must be deployed");
  assert.ok(!calls.some((c) => c.args[0] === "update-service" || c.args[0] === "create-service"), "the role refresh must not run");
});

test("faid:install goes on when no Figaf connection is stored, when the client has every authority, or when the probe itself fails (logged); a v3 catalog asks nothing", async () => {
  for (const check of [
    { ok: true, configured: false },
    { ok: true, configured: true, granted: ["agent:read", "ctt:sync", "download"], missing: [] },
    { ok: false, configured: true, error: "HTTP 503" },
  ]) {
    const { ctx, calls, logLines } = makeCtx(makeV5Dir(), cfServiceResponder(V3_READY, v3InstallResponder));
    ctx.checkFigafScopes = async () => check;
    const r = await createFaidHandlers(ctx)["faid:install"]({ appId: "arch" });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.ok(calls.some((c) => c.args[0] === "push"), "the install ran");
    if (check.ok === false) assert.ok(logLines.some((l) => /could not be checked/.test(l)), "the failed probe is logged");
  }
  const { ctx: ctx3 } = makeCtx(makeBaseDir(), cfServiceResponder(V3_READY, v3InstallResponder));
  let askedV3 = 0;
  ctx3.checkFigafScopes = async () => { askedV3 += 1; return { ok: true, configured: true, granted: [], missing: [] }; };
  const r3 = await createFaidHandlers(ctx3)["faid:install"]({ appId: "arch" });
  assert.equal(r3.ok, true, JSON.stringify(r3));
  assert.equal(askedV3, 0, "a catalog without figafScopes triggers no check");
});

test("faid:requiredFigafScopes: the release's figafScopes (v5); [] for an older catalog", async () => {
  const { ctx } = makeCtx(makeV5Dir(), cfServiceResponder(V3_READY, v3InstallResponder));
  const r = await createFaidHandlers(ctx)["faid:requiredFigafScopes"]();
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.version, "0.6.0");
  assert.deepEqual(r.scopes, ["agent:read", "ctt:sync"]);
  const { ctx: ctx3 } = makeCtx(makeBaseDir(), cfServiceResponder(V3_READY, v3InstallResponder));
  const r3 = await createFaidHandlers(ctx3)["faid:requiredFigafScopes"]();
  assert.equal(r3.ok, true, JSON.stringify(r3));
  assert.deepEqual(r3.scopes, []);
});

// ─── one version per installation: an app that only a NEWER release has ──────
// 2026-09-07: release 0.6.1 added a second app while 0.6.0 was installed. The
// page (reading the latest catalog after a failed version probe) offered
// Install, and Install answered "unknown app id ... in release 0.6.0". Now the
// page lists such an app as pending, and Install says what to do.

function remoteTwoVersionCtx() {
  const oneApp = JSON.parse(JSON.stringify(CATALOG));
  oneApp.releaseVersion = "0.6.0";
  oneApp.apps[0].version = "0.6.0";
  const twoApps = JSON.parse(JSON.stringify(oneApp));
  twoApps.releaseVersion = "0.6.1";
  twoApps.apps[0].version = "0.6.1";
  twoApps.apps.push({
    id: "fp", name: "Functional Profiles Maintain", version: "0.6.1", description: "second app",
    cfApps: [{ name: "fp-frontend", artifact: "fp.zip", buildpack: "nodejs_buildpack", memory: "128M", requires: { xsuaa: "binding" } }],
    healthPath: "/health/connections",
  });
  const base = "https://store.example/faid";
  const bucket = {
    [`${base}/index.json`]: JSON.stringify({ latest: "0.6.1", versions: [
      { version: "0.6.1", publishedAt: "2026-09-07T20:21:00Z", catalog: "faid/0.6.1/catalog.json" },
      { version: "0.6.0", publishedAt: "2026-09-07T16:56:00Z", catalog: "faid/0.6.0/catalog.json" },
    ] }),
    [`${base}/0.6.0/catalog.json`]: JSON.stringify(oneApp),
    [`${base}/0.6.1/catalog.json`]: JSON.stringify(twoApps),
    // the release part of the XSUAA document, part of every release that requires XSUAA
    [`${base}/0.6.0/xs-security.json`]: "{\"xsappname\":\"figaf-faid\"}",
    [`${base}/0.6.1/xs-security.json`]: "{\"xsappname\":\"figaf-faid\"}",
  };
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "faid-remote-cache-"));
  const { ctx, calls, logLines } = makeCtx(null, (args) => {
    if (args[0] === "app" && args[2] === "--guid") return { code: 0, stdout: "g-backend\n" };
    if (args[0] === "curl" && /\/v3\/apps\/g-backend\/environment_variables$/.test(args[1])) {
      return { code: 0, stdout: JSON.stringify({ var: { [VERSION_ENV]: "0.6.0" } }) };
    }
    return { code: 0, stdout: "" };
  });
  ctx.host.resolveFaidReleaseSource = () => ({ kind: "remote", url: base, cacheDir });
  ctx.httpsJson = async (url) => { if (!bucket[url]) throw new Error(`HTTP 404 ${url}`); return JSON.parse(bucket[url]); };
  ctx.httpsDownload = async (url, dest) => { if (!bucket[url]) throw new Error(`HTTP 404 ${url}`); fs.writeFileSync(dest, bucket[url]); return dest; };
  return { ctx, calls, logLines };
}

test("faid:catalog: with 0.6.0 installed and 0.6.1 latest, the rows are 0.6.0's apps and the new app of 0.6.1 is listed as pending", async () => {
  const { ctx } = remoteTwoVersionCtx();
  const c = await createFaidHandlers(ctx)["faid:catalog"]({});
  assert.equal(c.ok, true, JSON.stringify(c));
  assert.equal(c.releaseVersion, "0.6.0");
  assert.equal(c.installed, "0.6.0");
  assert.equal(c.latest, "0.6.1");
  assert.deepEqual(c.apps.map((a) => a.id), ["arch"]);
  assert.deepEqual(c.pendingApps, [{ id: "fp", name: "Functional Profiles Maintain", description: "second app", version: "0.6.1" }]);
});

test("faid:install of an app that only the newer release has is refused with the Update hint, before any cf change; a really unknown id keeps the plain error", async () => {
  const { ctx, calls } = remoteTwoVersionCtx();
  const handlers = createFaidHandlers(ctx);
  const r = await handlers["faid:install"]({ appId: "fp" });
  assert.equal(r.ok, false);
  assert.match(r.error, /'fp' is new in release 0\.6\.1; this installation runs 0\.6\.0/);
  assert.match(r.error, /Update the installation to 0\.6\.1 first \(Release panel\), then Install/);
  assert.equal(r.step, "version");
  assert.ok(!calls.some((c) => ["push", "create-service", "bind-service", "set-env", "start", "stop", "update-service"].includes(c.args[0])), "nothing was changed in the space");
  const unknown = await handlers["faid:install"]({ appId: "nope" });
  assert.equal(unknown.ok, false);
  assert.match(unknown.error, /unknown app id 'nope' in release 0\.6\.0/);
});

test("faid:catalog: nothing pending when the installation is at the latest release", async () => {
  const { ctx } = remoteTwoVersionCtx();
  ctx.run = async (cmd, args) => {
    if (args[0] === "app" && args[2] === "--guid") return { code: 0, stdout: "g-backend\n" };
    if (args[0] === "curl" && /environment_variables$/.test(args[1])) return { code: 0, stdout: JSON.stringify({ var: { [VERSION_ENV]: "0.6.1" } }) };
    return { code: 0, stdout: "" };
  };
  const c = await createFaidHandlers(ctx)["faid:catalog"]({});
  assert.equal(c.ok, true, JSON.stringify(c));
  assert.equal(c.releaseVersion, "0.6.1");
  assert.deepEqual(c.apps.map((a) => a.id), ["arch", "fp"]);
  assert.deepEqual(c.pendingApps, []);
});

test("installed-version probe: a cf failure other than 'not found' is said in the drawer; 'not found' stays silent", async () => {
  const { ctx, logLines } = remoteTwoVersionCtx();
  ctx.run = async (cmd, args) => {
    if (args[0] === "app" && args[2] === "--guid") return { code: 1, stdout: "", stderr: "The token expired, was revoked, or the token ID is incorrect. Please log back in to re-authenticate." };
    return { code: 0, stdout: "" };
  };
  const c = await createFaidHandlers(ctx)["faid:catalog"]({});
  assert.equal(c.ok, true, JSON.stringify(c));
  assert.equal(c.installed, null);
  assert.equal(c.releaseVersion, "0.6.1", "unknown installed version: the page falls back to the latest release");
  assert.ok(logLines.some((l) => /cf app arch-backend --guid failed .*installed version is unknown/.test(l)), logLines.join("\n"));

  const quiet = remoteTwoVersionCtx();
  quiet.ctx.run = async (cmd, args) => {
    if (args[0] === "app" && args[2] === "--guid") return { code: 1, stdout: "App 'arch-backend' not found\nFAILED\n" };
    return { code: 0, stdout: "" };
  };
  await createFaidHandlers(quiet.ctx)["faid:catalog"]({});
  assert.ok(!quiet.logLines.some((l) => /installed version is unknown/.test(l)), "an empty space is not a warning");
});

// ─── bulk disable / enable (the page's "Disable selected" / "Enable selected") ─
// Several apps under ONE lock, one after the other; a failure of one app does
// not stop the others; the result lists every app.
const CATALOG_TWO_APPS = {
  ...CATALOG,
  apps: [
    CATALOG.apps[0],
    {
      id: "fp", name: "Functional Profiles", version: "0.2.0",
      cfApps: [{ name: "fp-frontend", artifact: "frontend.zip", buildpack: "nodejs_buildpack", memory: "128M", disk: "512M", requires: { xsuaa: "binding" } }],
    },
  ],
};

test("faid:disable { appIds }: stops every app in the given order under one lock; the running marker carries appIds", async () => {
  resetRunningAction();
  const dir = makeChannelDir(CATALOG_TWO_APPS);
  const { ctx, calls, events, logLines } = makeCtx(dir, () => ({ code: 0, stdout: "" }));
  const handlers = createFaidHandlers(ctx);

  const r = await handlers["faid:disable"]({ appIds: ["fp", "arch", "fp"] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.results.map((x) => [x.appId, x.ok]), [["fp", true], ["arch", true]]);
  assert.deepEqual(calls.filter((c) => c.args[0] === "stop").map((c) => c.args[1]), ["fp-frontend", "arch-frontend"]);

  // One lock for the whole batch: one start event, one end event.
  const running = events.filter((e) => e.channel === "faid:running");
  assert.equal(running.length, 2);
  assert.equal(running[0].payload.action, "disable");
  assert.equal(running[0].payload.appId, "fp, arch");
  assert.deepEqual(running[0].payload.appIds, ["fp", "arch"]);
  assert.equal(running[1].payload, null);
  assert.equal(runningAction(), null);

  assert.ok(logLines.includes("Stopping 2 apps: fp, arch …"));
  assert.ok(logLines.includes("disable fp: done"));
  assert.ok(logLines.includes("disable arch: done"));
  assert.ok(logLines.includes("disable of 2 apps: done"));
});

test("faid:enable { appIds }: a failing app does not stop the others; the result names the failures and ok is false", async () => {
  resetRunningAction();
  const dir = makeChannelDir(CATALOG_TWO_APPS);
  const { ctx, calls } = makeCtx(dir, (args) =>
    (args[0] === "start" && args[1] === "arch-frontend" ? { code: 1, stderr: "App arch-frontend not found" } : { code: 0, stdout: "" }));
  const handlers = createFaidHandlers(ctx);

  const r = await handlers["faid:enable"]({ appIds: ["arch", "fp"] });
  assert.equal(r.ok, false);
  assert.deepEqual(calls.filter((c) => c.args[0] === "start").map((c) => c.args[1]), ["arch-frontend", "fp-frontend"]);
  assert.deepEqual(r.results.map((x) => [x.appId, x.ok]), [["arch", false], ["fp", true]]);
  assert.match(r.error, /enable failed for 1 of 2 apps: arch \(cf start arch-frontend failed: .*not found\)/);
  // Where it failed, for the outcome panel: the first failure's step and CF app.
  assert.equal(r.step, "start");
  assert.equal(r.cfApp, "arch-frontend");
  assert.equal(r.command, "cf start arch-frontend");
  assert.equal(runningAction(), null);
});

test("faid:disable / faid:enable: an unknown app in the list is one failed entry; an empty list and a missing appId are refused before any cf call", async () => {
  resetRunningAction();
  const dir = makeChannelDir(CATALOG_TWO_APPS);
  const { ctx, calls } = makeCtx(dir, () => ({ code: 0, stdout: "" }));
  const handlers = createFaidHandlers(ctx);

  const empty = await handlers["faid:disable"]({ appIds: [] });
  assert.equal(empty.ok, false);
  assert.match(empty.error, /appIds is empty/);
  const none = await handlers["faid:enable"]({});
  assert.equal(none.ok, false);
  assert.match(none.error, /appId required/);
  assert.equal(calls.filter((c) => c.args[0] === "stop" || c.args[0] === "start").length, 0);

  const r = await handlers["faid:disable"]({ appIds: ["nope", "fp"] });
  assert.equal(r.ok, false);
  assert.equal(r.results[0].appId, "nope");
  assert.equal(r.results[0].ok, false);
  assert.equal(r.results[1].ok, true);
  assert.deepEqual(calls.filter((c) => c.args[0] === "stop").map((c) => c.args[1]), ["fp-frontend"]);

  // The one-app shape is unchanged: a plain { ok } result, appId in the marker.
  calls.length = 0;
  const one = await handlers["faid:disable"]({ appId: "arch" });
  assert.deepEqual(one, { ok: true });
  assert.deepEqual(calls.filter((c) => c.args[0] === "stop").map((c) => c.args[1]), ["arch-frontend"]);
});
