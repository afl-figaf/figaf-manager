"use strict";
// Unit tests for the action outcome model (packages/ui/action-outcome.js).
// The module is a browser-globals script; we fake `window` and load it.
// Run via `node --test packages/ui/action-outcome.test.js`.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const SRC = fs.readFileSync(path.join(__dirname, "action-outcome.js"), "utf8");

function load() {
  const w = {};
  new Function("window", SRC)(w);
  return w.figafActionOutcome;
}

const BASE = { managerVersion: "26.5.0", releaseVersion: "0.4.0", org: "Figaf ApS_figafpartner-1", space: "figaf-l3-l4", at: "2026-09-03T10:49:33.000Z" };

test("the live 2026-09-03 failure: action, where, cf's words, the manifest hint, and a complete report", () => {
  const o = load()({
    ...BASE,
    action: "install",
    appName: "B2B Archiving Setup",
    result: {
      ok: false,
      error: "cf push figaf-l3l4-backend failed: For application 'figaf-l3l4-backend': Buildpack and Buildpacks fields cannot be used together.",
      step: "push",
      cfApp: "figaf-l3l4-backend",
      failedApp: "figaf-l3l4-backend",
      command: "cf push figaf-l3l4-backend -p /x --no-manifest -b nodejs_buildpack -m 256M -k 1024M --no-start",
      detail: "For application 'figaf-l3l4-backend': Buildpack and Buildpacks fields cannot be used together.",
    },
  });
  assert.equal(o.ok, false);
  assert.equal(o.title, "Install of B2B Archiving Setup failed");
  assert.equal(o.where, "step: upload the app to Cloud Foundry (cf push) - CF app: figaf-l3l4-backend");
  assert.equal(o.hintId, "manifest-leak");
  assert.match(o.hint, /--no-manifest/);
  assert.deepEqual(o.facts.map((f) => f.label), ["Where", "Error", "Command"]);
  // The report is complete and self-contained: someone who only gets the
  // text can see version, target, action, place, error, command, next step.
  for (const line of [
    "Figaf App Manager - action report",
    "time: 2026-09-03T10:49:33.000Z",
    "manager: 26.5.0  release: 0.4.0",
    "target: Figaf ApS_figafpartner-1 / figaf-l3-l4",
    "action: Install of B2B Archiving Setup",
    "where: step: upload the app to Cloud Foundry (cf push) - CF app: figaf-l3l4-backend",
    "error: cf push figaf-l3l4-backend failed: For application",
    "command: cf push figaf-l3l4-backend -p /x --no-manifest",
    "next: The manager's own manifest.yml",
  ]) {
    assert.ok(o.report.includes(line), `report must contain: ${line}\n---\n${o.report}`);
  }
  // detail is already inside error -> not repeated as "cf said"
  assert.ok(!o.report.includes("cf said:"));
});

test("early refusal (required services missing): no step, the services hint, nothing about cf", () => {
  const o = load()({
    ...BASE, action: "install", appName: "B2B Archiving Setup",
    result: { ok: false, error: "required service instance(s) missing: figaf-l3l4-db — create them first (Setup, step 3)" },
  });
  assert.equal(o.hintId, "services-missing");
  assert.equal(o.where, "");
  assert.deepEqual(o.facts.map((f) => f.label), ["Error"]);
  assert.ok(!o.report.includes("where:"));
  assert.ok(!o.report.includes("command:"));
});

test("hints: session lost, quota, bind, start, checksum, no route; unknown text gets the terminal-drawer default", () => {
  const f = load();
  const hintFor = (error, detail) => f({ action: "update", appName: "X", result: { ok: false, error, detail } }).hintId;
  assert.equal(hintFor("cf curl /v3/apps failed — are you logged in and targeted?", "Not logged in. Use 'cf login' or 'cf login --sso' to log in."), "session");
  // the status handler's own text, without any cf detail (what the console shows on a lost session)
  assert.equal(hintFor("cf curl /v3/apps failed — are you logged in and targeted?"), "session");
  assert.equal(hintFor("cf push x failed", "You have exceeded your organization's memory limit: app requested more memory than available"), "quota");
  assert.equal(hintFor("bind-service db failed — does the service instance exist in this space?: Service instance db not found"), "bind");
  assert.equal(hintFor("cf start x failed — see the staging log in the terminal: Start unsuccessful"), "start");
  assert.equal(hintFor("checksum mismatch for backend.zip — the release is corrupt"), "checksum");
  // The release store (decision 0010): unreachable store, failed download, version rules.
  assert.equal(hintFor("cannot read https://store.example/l3/index.json: getaddrinfo ENOTFOUND store.example"), "store-unreachable");
  assert.equal(hintFor("download of backend.zip failed: HTTP 404"), "store-unreachable");
  assert.equal(hintFor("No release source configured: set FIGAF_L3_RELEASE_URL (the release store) or FIGAF_L3_ARTIFACTS_DIR (a local release directory)"), "store-unreachable");
  assert.equal(hintFor("version 0.4.0 is lower than the installed 0.4.1 — rollback is not supported (forward-only migrations); choose 0.4.1 or higher"), "version-rule");
  assert.equal(hintFor("version 9.9.9 is not in the release store (available: 0.4.1)"), "version-rule");
  assert.equal(hintFor("nothing is installed yet — install an app first; Install uses the latest release"), "version-rule");
  assert.equal(hintFor("could not resolve the route of figaf-l3l4-backend — is the platform base deployed and started?"), "no-route");
  // Refused because another action is running (one action at a time, 2026-09-04)
  assert.equal(hintFor("install of arch is already running (started 2 min ago) — wait until it finishes."), "busy");
  const d = f({ action: "remove", appName: "X", result: { ok: false, error: "something nobody expected" } });
  assert.equal(d.hintId, "default");
  assert.match(d.hint, /terminal drawer/);
  assert.match(d.hint, /send it to Figaf/);
});

test("base-services actions and unknown actions get readable titles; a success is a plain 'finished'", () => {
  const f = load();
  assert.equal(f({ action: "provision", appName: "Base services", result: { ok: false, error: "x" } }).title, "Create base services of Base services failed");
  assert.equal(f({ action: "restart", result: { ok: false, error: "x" } }).title, "Restart manager failed");
  assert.equal(f({ action: "frobnicate", appName: "Y", result: { ok: false, error: "x" } }).title, "frobnicate of Y failed");
  const ok = f({ action: "install", appName: "Y", result: { ok: true, version: "1" }, at: "t" });
  assert.deepEqual(ok, { ok: true, title: "Install of Y finished", at: "t" });
});

test("missing pieces never break it: no result, no error text, nulls", () => {
  const f = load();
  const o = f({ action: "install", appName: "Y" });
  assert.equal(o.ok, false);
  assert.equal(o.error, "unknown error");
  assert.equal(o.hintId, "default");
  assert.ok(o.report.includes("manager: ?  release: ?"));
  assert.ok(o.report.includes("target: ?"));
  const n = f(null);
  assert.equal(n.title, "Action failed");
});
