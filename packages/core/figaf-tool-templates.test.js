"use strict";
// Tests for the Figaf Tool template helpers (figaf-tool-templates.js):
// optional service toggles, renaming the two required instances, xsappname.
// Run via `node --test packages/core/figaf-tool-templates.test.js`.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const t = require("./figaf-tool-templates");

const TEMPLATES = path.join(__dirname, "..", "deploy-templates");
const MANIFEST = fs.readFileSync(path.join(TEMPLATES, "manifest.yml"), "utf8");
const XS_SECURITY = fs.readFileSync(path.join(TEMPLATES, "xs-security.json"), "utf8");

const lines = (text, re) => text.split(/\r?\n/).filter((l) => re.test(l));

test("defaults leave the template's service lines as they are", () => {
  const out = t.applyManifestServices(MANIFEST, {});
  assert.deepEqual(lines(out, /figaf-db/), ["  - figaf-db"]);
  assert.deepEqual(lines(out, /figaf-xsuaa/), ["  - figaf-xsuaa", "    - figaf-xsuaa"]);
  assert.deepEqual(lines(out, /figaf-connectivity/), ["#  - figaf-connectivity"]);
  assert.deepEqual(lines(out, /figaf-destination/), ["#  - figaf-destination"]);
});

test("the PI/PO services are uncommented when enabled and commented again when not", () => {
  const on = t.applyManifestServices(MANIFEST, { enableConnectivity: true, enableDestination: true });
  assert.deepEqual(lines(on, /figaf-connectivity/), ["  - figaf-connectivity"]);
  assert.deepEqual(lines(on, /figaf-destination/), ["  - figaf-destination"]);
  const off = t.applyManifestServices(on, {});
  assert.deepEqual(lines(off, /figaf-connectivity/), ["#  - figaf-connectivity"]);
});

test("renaming the database instance touches only its line", () => {
  const out = t.applyManifestServices(MANIFEST, { dbServiceName: "shared-pg" });
  assert.deepEqual(lines(out, /shared-pg/), ["  - shared-pg"]);
  assert.equal(lines(out, /figaf-db/).length, 0);
  assert.deepEqual(lines(out, /figaf-xsuaa/), ["  - figaf-xsuaa", "    - figaf-xsuaa"]);
});

test("renaming the XSUAA instance renames it under the app AND the router", () => {
  const out = t.applyManifestServices(MANIFEST, { xsuaaServiceName: "figaf-tool2-xsuaa" });
  assert.deepEqual(lines(out, /xsuaa/), ["  - figaf-tool2-xsuaa", "    - figaf-tool2-xsuaa"]);
});

test("renameManifestService is a no-op for equal or empty names and escapes regex characters", () => {
  assert.equal(t.renameManifestService(MANIFEST, "figaf-db", "figaf-db"), MANIFEST);
  assert.equal(t.renameManifestService(MANIFEST, "", "x"), MANIFEST);
  const dotted = MANIFEST.replace("  - figaf-db", "  - figaf.db");
  const out = t.renameManifestService(dotted, "figaf.db", "other");
  assert.deepEqual(lines(out, /other/), ["  - other"]);
  assert.equal(lines(out, /figafXdb/).length, 0);
});

test("setXsappname rewrites xsappname and keeps the rest of the document", () => {
  const r = t.setXsappname(XS_SECURITY, "figaf-tool2-xsuaa");
  assert.equal(r.ok, true);
  const doc = JSON.parse(r.text);
  assert.equal(doc.xsappname, "figaf-tool2-xsuaa");
  assert.equal(doc["tenant-mode"], "dedicated");
  assert.equal(doc.scopes.length, JSON.parse(XS_SECURITY).scopes.length);
  assert.equal(JSON.parse(t.setXsappname(XS_SECURITY, "").text).xsappname, "figaf-xsuaa");
});

test("setXsappname refuses a template that is not a JSON object", () => {
  assert.equal(t.setXsappname("{ not json", "x").ok, false);
  assert.equal(t.setXsappname("[1,2]", "x").ok, false);
});

// ─── Additional environment variables (gap G1, 2026-09-14) ──────────────────

test("TEMPLATE_ENV_KEYS still matches the keys of the template's app env block", () => {
  // Guards against drift: the template comes from the figaf/Figaf-BTP-Deployment
  // repository, so a key added or removed there must fail here rather than turn
  // into a variable the manager silently offers twice (or never subtracts from
  // the live environment).
  const all = MANIFEST.split(/\r?\n/);
  const start = all.findIndex((l) => /^\s*env:\s*$/.test(l));
  const keys = [];
  for (const line of all.slice(start + 1)) {
    if (!/^\s{4}\S/.test(line)) break;
    keys.push(line.trim().split(":")[0]);
  }
  assert.ok(keys.length > 0);
  for (const k of keys) assert.ok(t.TEMPLATE_ENV_KEYS.includes(k), `${k} must be reserved`);
  // The extras are the vars.yml names that reach the app as ((placeholders)).
  assert.deepEqual(
    t.TEMPLATE_ENV_KEYS.filter((k) => !keys.includes(k)),
    ["ID", "LANDSCAPE_APPS_DOMAIN", "DOCKER_IMAGE_VERSION", "DOCKER_USERNAME", "INSTANCE_MEMORY"]
  );
});

test("applyManifestEnv appends to the app's env block and never touches the router's", () => {
  const out = t.applyManifestEnv(MANIFEST, { IRT_ROOT_LOGGING_LEVEL: "DEBUG", IRT_DB_SSLMODE: "require" });
  const all = out.split(/\r?\n/);
  const added = all.indexOf("    IRT_ROOT_LOGGING_LEVEL: 'DEBUG'");
  assert.ok(added > 0);
  assert.equal(all[added + 1], "    IRT_DB_SSLMODE: 'require'");
  // Still inside the first application: the next non-env key follows.
  assert.equal(all[added + 2], "  docker:");
  // The router's own env block is untouched.
  assert.ok(out.includes("    httpHeaders: >"));
  assert.equal(lines(out, /IRT_ROOT_LOGGING_LEVEL/).length, 1);
  // Nothing to add is a no-op, so a deployment without extras is byte-identical.
  assert.equal(t.applyManifestEnv(MANIFEST, {}), MANIFEST);
});

test("applyManifestEnv quotes values YAML cannot take raw", () => {
  const out = t.applyManifestEnv(MANIFEST, {
    A: "-Done=1 -Dtwo=2",
    B: "it's #2: yes",
    C: "",
  });
  assert.ok(out.includes("    A: '-Done=1 -Dtwo=2'"));
  assert.ok(out.includes("    B: 'it''s #2: yes'"));
  assert.ok(out.includes("    C: ''"));
});

test("applyManifestEnv refuses a manifest without an env block instead of dropping the rows", () => {
  assert.throws(() => t.applyManifestEnv("---\napplications:\n- name: x\n", { A: "1" }), /env:/);
});

test("validateEnvRows takes both shapes, drops half-typed rows, keeps order", () => {
  assert.deepEqual(t.validateEnvRows({ B: "2", A: "1" }).env, { B: "2", A: "1" });
  const r = t.validateEnvRows([{ key: " A ", value: "1" }, { key: "", value: "" }, { key: "B", value: "" }]);
  assert.deepEqual(r.env, { A: "1", B: "" });
  assert.deepEqual(Object.keys(r.env), ["A", "B"]);
  assert.deepEqual(t.validateEnvRows(null).env, {});
});

test("validateEnvRows refuses bad names, the template's own keys, duplicates and values cf would rewrite", () => {
  assert.match(t.validateEnvRows({ "A B": "1" }).error, /not a valid environment variable name/);
  assert.match(t.validateEnvRows({ "1A": "1" }).error, /not a valid environment variable name/);
  assert.match(t.validateEnvRows({ LOCATION_ID: "x" }).error, /set by the deployment template/);
  assert.match(t.validateEnvRows({ DOCKER_USERNAME: "x" }).error, /set by the deployment template/);
  assert.match(t.validateEnvRows([{ key: "A", value: "1" }, { key: "A", value: "2" }]).error, /listed twice/);
  // ((NAME)) is substituted from vars.yml ANYWHERE in the manifest.
  assert.match(t.validateEnvRows({ A: "x((ID))y" }).error, /\(\(/);
  assert.match(t.validateEnvRows({ A: "one\ntwo" }).error, /line breaks or control characters/);
  assert.equal(t.validateEnvRows({ A: "plain-((-not-a-var" }).ok, false);
});
