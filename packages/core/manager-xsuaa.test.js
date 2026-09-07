"use strict";
// Tests for manager-xsuaa.js (figaf-faid decision 0009: one XSUAA instance
// for the manager and the apps).

const { test } = require("node:test");
const assert = require("node:assert/strict");

const mx = require("./manager-xsuaa");

const RELEASE = {
  xsappname: "figaf-faid",
  "tenant-mode": "dedicated",
  description: "apps",
  scopes: [
    { name: "$XSAPPNAME.FAIDPlatformAccess", description: "baseline" },
    { name: "$XSAPPNAME.FAIDB2BArchivingSetupAdmin", description: "app admin" },
  ],
  "role-templates": [
    { name: "FAIDB2BArchivingSetupAdmin", "scope-references": ["$XSAPPNAME.FAIDPlatformAccess", "$XSAPPNAME.FAIDB2BArchivingSetupAdmin"] },
  ],
  "role-collections": [
    { name: "FAID-B2BArchivingSetup-Admin", "role-template-references": ["$XSAPPNAME.FAIDB2BArchivingSetupAdmin"] },
  ],
  "oauth2-configuration": { "redirect-uris": ["https://*.__CF_APPS_DOMAIN__/**"] },
};

test("xsappnameBase strips the tenant suffix of a binding", () => {
  assert.equal(mx.xsappnameBase("figaf-faid!t12345"), "figaf-faid");
  assert.equal(mx.xsappnameBase("figaf-faid"), "figaf-faid");
  assert.equal(mx.xsappnameBase(""), "");
  assert.equal(mx.xsappnameBase(null), "");
});

test("operatorScopeName: shared instance -> FAIDManagerOperator; legacy or unknown -> FigafManagerOperator", () => {
  assert.equal(mx.operatorScopeName("figaf-faid!t1"), "FAIDManagerOperator");
  assert.equal(mx.operatorScopeName("figaf-faid"), "FAIDManagerOperator");
  assert.equal(mx.operatorScopeName("figaf-manager-xsuaa!t1"), "FigafManagerOperator");
  assert.equal(mx.operatorScopeName("something-else"), "FigafManagerOperator");
  assert.equal(mx.operatorScopeName(undefined), "FigafManagerOperator");
});

test("adminCollectionFor: shared -> FAID-Manager-Admin, legacy -> FigafManagerAdmin", () => {
  assert.equal(mx.adminCollectionFor("figaf-faid-xsuaa"), "FAID-Manager-Admin");
  assert.equal(mx.adminCollectionFor("figaf-manager-xsuaa"), "FigafManagerAdmin");
});

test("composeXsSecurity: release + manager part = union by name, xsappname shared, placeholder filled, token validity from the manager part", () => {
  const r = mx.composeXsSecurity({ release: RELEASE, appsDomain: "cfapps.eu10-004.hana.ondemand.com" });
  assert.equal(r.ok, true, r.error);
  const d = r.doc;
  assert.equal(d.xsappname, "figaf-faid");
  assert.equal(d["tenant-mode"], "dedicated");
  const scopeNames = d.scopes.map((s) => s.name);
  assert.ok(scopeNames.includes("$XSAPPNAME.FAIDPlatformAccess"));
  assert.ok(scopeNames.includes("$XSAPPNAME.FAIDManagerOperator"));
  assert.ok(scopeNames.includes("$XSAPPNAME.FAIDManagerAdmin"));
  // The release entries come first (the apps' order is kept).
  assert.equal(scopeNames[0], "$XSAPPNAME.FAIDPlatformAccess");
  assert.deepEqual(
    d["role-collections"].map((c) => c.name),
    ["FAID-B2BArchivingSetup-Admin", "FAID-Manager-Operator", "FAID-Manager-Admin"],
  );
  assert.deepEqual(d["role-templates"].map((t) => t.name), ["FAIDB2BArchivingSetupAdmin", "FAIDManagerOperator", "FAIDManagerAdmin"]);
  assert.deepEqual(d["oauth2-configuration"]["redirect-uris"], ["https://*.cfapps.eu10-004.hana.ondemand.com/**"]);
  assert.equal(d["oauth2-configuration"]["token-validity"], 3600);
  assert.equal(d["oauth2-configuration"]["refresh-token-validity"], 86400);
  assert.ok(!JSON.stringify(d).includes("__CF_APPS_DOMAIN__"));
});

test("composeXsSecurity: a name defined by both sides is taken from the release (the release wins)", () => {
  const release = { ...RELEASE, scopes: [...RELEASE.scopes, { name: "$XSAPPNAME.FAIDManagerOperator", description: "from the release" }] };
  const r = mx.composeXsSecurity({ release, appsDomain: "cfapps.x" });
  assert.equal(r.ok, true);
  const op = r.doc.scopes.filter((s) => s.name === "$XSAPPNAME.FAIDManagerOperator");
  assert.equal(op.length, 1);
  assert.equal(op[0].description, "from the release");
});

test("composeXsSecurity: no release present -> the manager part alone, xsappname shared", () => {
  const r = mx.composeXsSecurity({ release: null, appsDomain: "cfapps.x" });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.doc.xsappname, "figaf-faid");
  assert.deepEqual(r.doc["role-collections"].map((c) => c.name), ["FAID-Manager-Operator", "FAID-Manager-Admin"]);
  assert.deepEqual(r.doc["oauth2-configuration"]["redirect-uris"], ["https://*.cfapps.x/**"]);
});

test("composeXsSecurity: a release with another xsappname is refused (decision 0008)", () => {
  const r = mx.composeXsSecurity({ release: { ...RELEASE, xsappname: "figaf-other-release" }, appsDomain: "cfapps.x" });
  assert.equal(r.ok, false);
  assert.match(r.error, /must be 'figaf-faid'/);
});

test("composeXsSecurity: placeholder present but no domain -> clear error, nothing composed", () => {
  const r = mx.composeXsSecurity({ release: RELEASE });
  assert.equal(r.ok, false);
  assert.match(r.error, /cfapps domain/);
});

test("composeXsSecurity: extra top-level keys of the release pass through; redirect URIs are united without duplicates", () => {
  const release = {
    ...RELEASE,
    attributes: [{ name: "x", valueType: "string" }],
    "oauth2-configuration": { "redirect-uris": ["https://*.__CF_APPS_DOMAIN__/**", "https://other.example/**"] },
  };
  const r = mx.composeXsSecurity({ release, appsDomain: "cfapps.x" });
  assert.equal(r.ok, true);
  assert.deepEqual(r.doc.attributes, [{ name: "x", valueType: "string" }]);
  assert.deepEqual(r.doc["oauth2-configuration"]["redirect-uris"], ["https://*.cfapps.x/**", "https://other.example/**"]);
});

test("the bundled manager part carries the frozen identifiers of decision 0009", () => {
  const p = mx.MANAGER_PART;
  assert.equal(p.xsappname, "figaf-faid");
  assert.deepEqual(p.scopes.map((s) => s.name), ["$XSAPPNAME.FAIDManagerOperator", "$XSAPPNAME.FAIDManagerAdmin"]);
  assert.deepEqual(p["role-collections"].map((c) => c.name), ["FAID-Manager-Operator", "FAID-Manager-Admin"]);
  const admin = p["role-templates"].find((t) => t.name === "FAIDManagerAdmin");
  assert.ok(admin["scope-references"].includes("$XSAPPNAME.FAIDManagerOperator"), "Admin includes Operator");
});
