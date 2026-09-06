#!/usr/bin/env node
"use strict";
// Builds e2e/fixtures/store/: a release STORE in the bucket layout of
// figaf-l3-l4 release/publish.js, with two versions, for release-store.spec.js.
//
//   l3/index.json
//   l3/<version>/catalog.json, release.json, xs-security.json, *.zip
//
// The catalogs name CF apps that never exist in the dev space and a service
// instance that never exists, so the page shows "Not installed" and every
// Install is refused before any cf change (same safety as
// release-missing-service). Run once; the output is committed:
//
//     node e2e/tools/make-fixture-store.js

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const OUT = path.join(__dirname, "..", "fixtures", "store", "l3");
const VERSIONS = ["0.0.1", "0.0.2"];
const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

function catalogFor(version, backendZip, frontendZip) {
  return {
    releaseVersion: version,
    services: [
      { name: "figaf-l3l4-e2e-missing", offering: "postgresql-db", plan: "free",
        purpose: "E2E FIXTURE - this instance must never exist; its absence makes every Install fail early, before any cf change" },
      { name: "figaf-l3l4-e2e-xsuaa", offering: "xsuaa", plan: "application", configFile: "xs-security.json",
        purpose: "E2E FIXTURE - a config file the store must deliver with the catalog" },
    ],
    platform: {
      name: "Platform base (e2e store fixture)",
      cfApps: [{ name: "figaf-l3l4-e2e-store-backend", artifact: "backend.zip", sha256: sha(backendZip), buildpack: "nodejs_buildpack", memory: "64M", services: ["figaf-l3l4-e2e-missing"] }],
    },
    apps: [{
      id: "b2b-archiving-setup-e2e-store",
      name: "B2B Archiving Setup (e2e store fixture)",
      version,
      description: `Fixture release ${version} served from a local release store for release-store.spec.js. Install is always refused (required service missing).`,
      cfApps: [{ name: "figaf-l3-e2e-store-frontend", artifact: "b2b-archiving-setup-e2e-store.zip", sha256: sha(frontendZip), buildpack: "nodejs_buildpack", memory: "64M", services: ["figaf-l3l4-e2e-missing"] }],
      healthPath: "/health",
    }],
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
  const xs = Buffer.from(JSON.stringify({ xsappname: "figaf-l3l4", "oauth2-configuration": { "redirect-uris": ["https://*.__CF_APPS_DOMAIN__/**"] } }, null, 2) + "\n");
  const catalog = Buffer.from(JSON.stringify(catalogFor(v, backendZip, frontendZip), null, 2) + "\n");
  const files = [
    ["backend.zip", backendZip], ["b2b-archiving-setup-e2e-store.zip", frontendZip], ["xs-security.json", xs], ["catalog.json", catalog],
  ];
  for (const [name, buf] of files) fs.writeFileSync(path.join(dir, name), buf);
  const release = {
    releaseVersion: v,
    publishedAt: `2026-09-0${VERSIONS.indexOf(v) + 1}T12:00:00.000Z`,
    files: files.map(([name, buf]) => ({ name, size: buf.length, sha256: sha(buf) })),
    source: { repository: "FigafManager e2e fixture", commit: "0000000000000000000000000000000000000000", branch: "fixture" },
  };
  fs.writeFileSync(path.join(dir, "release.json"), JSON.stringify(release, null, 2) + "\n");
  index.versions.push({ version: v, publishedAt: release.publishedAt, catalog: `l3/${v}/catalog.json` });
}
index.versions.reverse();
fs.writeFileSync(path.join(OUT, "index.json"), JSON.stringify(index, null, 2) + "\n");
process.stdout.write(`fixture store written to ${OUT} (${VERSIONS.join(", ")})\n`);
