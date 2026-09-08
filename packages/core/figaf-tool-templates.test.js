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
