#!/usr/bin/env node
"use strict";
// Builds e2e/fixtures/store/: a release STORE in the bucket layout of
// figaf-faid release/publish.js, with two versions, for release-store.spec.js.
//
//   faid/index.json
//   faid/<version>/catalog.json, release.json, xs-security.json, *.zip
//
// The catalogs name CF apps that never exist in the dev space and a Cloud
// Foundry STACK no landscape offers (catalog v7 has no instance names any
// more: the base instances are the manager's, base-services.js), so the page
// shows "Not installed" and every Install is refused at the stack check,
// before any cf change (same safety as release-missing-service). Version 0.0.1 has one app; 0.0.2 adds a second
// one (figaf-faid decision 0016: a release carries several apps, and an
// update can bring a new app). Run once; the output is committed:
//
//     node e2e/tools/make-fixture-store.js

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const OUT = path.join(__dirname, "..", "fixtures", "store", "faid");
const VERSIONS = ["0.0.1", "0.0.2"];
const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

const SECOND_APP_FROM = "0.0.2";
// E2E FIXTURE - a stack no landscape offers: every Install fails at the stack
// check (preflight, before any service or role call), so nothing in the space changes.
const MISSING_STACK = "cflinuxfs-e2e-missing";

function catalogFor(version, backendZip, frontendZip, secondZip) {
  const apps = [{
    id: "b2b-archiving-setup-e2e-store",
    name: "B2B Archiving Setup (e2e store fixture)",
    version,
    description: `Fixture release ${version} served from a local release store for release-store.spec.js. Install is always refused (the release names a stack no landscape offers).`,
    cfApps: [{ name: "figaf-faid-apps-e2e-store-frontend", artifact: "b2b-archiving-setup-e2e-store.zip", sha256: sha(frontendZip), buildpack: "nodejs_buildpack", stack: MISSING_STACK, memory: "64M", requires: { xsuaa: "binding" } }],
    healthPath: "/health",
  }];
  if (secondZip) {
    apps.push({
      id: "functional-profiles-maintain-e2e-store",
      name: "Functional Profiles Maintain (e2e store fixture)",
      version,
      description: `Second app of fixture release ${version}: new in this version, so an update brings a new row. Install is always refused (the release names a stack no landscape offers).`,
      cfApps: [{ name: "figaf-faid-apps-e2e-store-second", artifact: "functional-profiles-maintain-e2e-store.zip", sha256: sha(secondZip), buildpack: "nodejs_buildpack", stack: MISSING_STACK, memory: "64M", requires: { xsuaa: "binding" } }],
      healthPath: "/health",
      roleCollections: ["FAID-E2E-Second-Viewer"],
    });
  }
  return {
    releaseVersion: version,
    figafScopes: secondZip ? ["agent:read", "b2b.partner-profile:read", "download", "ctt:sync"] : ["agent:read"],
    // Catalog v7: the backend requires XSUAA and the Credential Store as
    // bindings, so the store must deliver xs-security.json with the catalog.
    platform: {
      name: "Platform base (e2e store fixture)",
      cfApps: [{ name: "figaf-faid-e2e-store-backend", artifact: "backend.zip", sha256: sha(backendZip), buildpack: "nodejs_buildpack", stack: MISSING_STACK, memory: "64M", requires: { xsuaa: "binding", credstore: "binding" } }],
    },
    apps,
  };
}

fs.rmSync(OUT, { recursive: true, force: true });
const index = { latest: VERSIONS[VERSIONS.length - 1], updatedAt: "2026-09-04T12:00:00.000Z", versions: [] };
for (const v of VERSIONS) {
  const dir = path.join(OUT, v);
  fs.mkdirSync(dir, { recursive: true });
  // Not real zips: nothing here is ever extracted (Install is refused first).
  const backendZip = Buffer.from(`e2e fixture backend ${v}\n`);
  const frontendZip = Buffer.from(`e2e fixture frontend ${v}\n`);
  const secondZip = v >= SECOND_APP_FROM ? Buffer.from(`e2e fixture second frontend ${v}\n`) : null;
  const xs = Buffer.from(JSON.stringify({ xsappname: "figaf-faid", "oauth2-configuration": { "redirect-uris": ["https://*.__CF_APPS_DOMAIN__/**"] } }, null, 2) + "\n");
  const catalog = Buffer.from(JSON.stringify(catalogFor(v, backendZip, frontendZip, secondZip), null, 2) + "\n");
  const files = [
    ["backend.zip", backendZip], ["b2b-archiving-setup-e2e-store.zip", frontendZip],
    ...(secondZip ? [["functional-profiles-maintain-e2e-store.zip", secondZip]] : []),
    ["xs-security.json", xs], ["catalog.json", catalog],
  ];
  for (const [name, buf] of files) fs.writeFileSync(path.join(dir, name), buf);
  const release = {
    releaseVersion: v,
    publishedAt: `2026-09-0${VERSIONS.indexOf(v) + 1}T12:00:00.000Z`,
    files: files.map(([name, buf]) => ({ name, size: buf.length, sha256: sha(buf) })),
    source: { repository: "FigafManager e2e fixture", commit: "0000000000000000000000000000000000000000", branch: "fixture" },
  };
  fs.writeFileSync(path.join(dir, "release.json"), JSON.stringify(release, null, 2) + "\n");
  index.versions.push({ version: v, publishedAt: release.publishedAt, catalog: `faid/${v}/catalog.json` });
}
index.versions.reverse();
fs.writeFileSync(path.join(OUT, "index.json"), JSON.stringify(index, null, 2) + "\n");
process.stdout.write(`fixture store written to ${OUT} (${VERSIONS.join(", ")})\n`);
