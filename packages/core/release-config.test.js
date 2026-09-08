"use strict";
// Pure-logic tests for release-config helpers. No I/O.
// Run via `node --test packages/core/release-config.test.js`.

const { test } = require("node:test");
const assert = require("node:assert/strict");

// Module reads process.env.FIGAF_RELEASE_REPO at require-time, so reset
// the cache between tests to exercise both branches.
function loadFresh(envValue) {
  if (envValue == null) delete process.env.FIGAF_RELEASE_REPO;
  else process.env.FIGAF_RELEASE_REPO = envValue;
  delete require.cache[require.resolve("./release-config")];
  return require("./release-config");
}

test("compareSemver: equal versions", () => {
  const { compareSemver } = loadFresh();
  assert.equal(compareSemver("1.0.0", "1.0.0"), 0);
  assert.equal(compareSemver("0.0.0", "0.0.0"), 0);
});

test("compareSemver: simple ordering", () => {
  const { compareSemver } = loadFresh();
  assert.equal(compareSemver("1.0.0", "1.0.1"), -1);
  assert.equal(compareSemver("1.0.1", "1.0.0"),  1);
  assert.equal(compareSemver("1.0.0", "1.1.0"), -1);
  assert.equal(compareSemver("1.1.0", "1.0.0"),  1);
  assert.equal(compareSemver("1.0.0", "2.0.0"), -1);
  assert.equal(compareSemver("2.0.0", "1.0.0"),  1);
});

test("compareSemver: ten-vs-two segment lexicographic trap", () => {
  // Must compare numerically, not lex: "10" > "2".
  const { compareSemver } = loadFresh();
  assert.equal(compareSemver("1.2.0", "1.10.0"), -1);
  assert.equal(compareSemver("1.10.0", "1.2.0"),  1);
});

test("compareSemver: missing parts default to 0", () => {
  const { compareSemver } = loadFresh();
  assert.equal(compareSemver("1", "1.0.0"), 0);
  assert.equal(compareSemver("1.0", "1.0.0"), 0);
  assert.equal(compareSemver("", "0.0.0"), 0);
});

test("compareSemver: malformed input is NaN-safe", () => {
  const { compareSemver } = loadFresh();
  assert.equal(compareSemver("garbage", "garbage"), 0);
  assert.equal(compareSemver(null, undefined), 0);
});

test("compareSemver: the FAID dev channel (x.y.z-dev.N, figaf-faid decision 0017)", () => {
  const { compareSemver } = loadFresh();
  // a dev build of the next version is newer than the current release ...
  assert.equal(compareSemver("0.6.2-dev.9", "0.6.1"), 1);
  // ... and older than the release it leads to
  assert.equal(compareSemver("0.6.2-dev.9", "0.6.2"), -1);
  assert.equal(compareSemver("0.6.2", "0.6.2-dev.9"), 1);
  // two dev builds compare by their number, not as text
  assert.equal(compareSemver("0.6.2-dev.10", "0.6.2-dev.9"), 1);
  assert.equal(compareSemver("0.6.2-dev.9", "0.6.2-dev.10"), -1);
  assert.equal(compareSemver("0.6.2-dev.4", "0.6.2-dev.4"), 0);
  // the update rule "only upwards" follows: dev.9 -> dev.10 -> 0.6.2 -> 0.6.3-dev.1
  assert.equal(compareSemver("0.6.3-dev.1", "0.6.2"), 1);
});

test("RELEASE_REPO defaults to the figaf code repo (single-repo releases)", () => {
  const { RELEASE_REPO, RELEASE_LATEST_URL } = loadFresh(null);
  assert.equal(RELEASE_REPO, "figaf/FigafManager");
  assert.equal(
    RELEASE_LATEST_URL,
    "https://api.github.com/repos/figaf/FigafManager/releases/latest"
  );
});

test("FIGAF_RELEASE_REPO env overrides the default", () => {
  const { RELEASE_REPO, RELEASE_LATEST_URL } = loadFresh("acme/staging-repo");
  assert.equal(RELEASE_REPO, "acme/staging-repo");
  assert.equal(
    RELEASE_LATEST_URL,
    "https://api.github.com/repos/acme/staging-repo/releases/latest"
  );
});

test("CLOUD_ASSET_REGEX: matches the build-zip naming", () => {
  const { CLOUD_ASSET_REGEX } = loadFresh();
  const m = CLOUD_ASSET_REGEX.exec("figaf-manager-app-1.2.3.zip");
  assert.ok(m, "should match");
  assert.equal(m[1], "1.2.3");
  assert.equal(CLOUD_ASSET_REGEX.exec("figaf-manager-app-1.2.3.tar.gz"), null);
  assert.equal(CLOUD_ASSET_REGEX.exec("Figaf-Installer-Setup-1.2.3-x64.exe"), null);
});

test("DESKTOP_ASSET_REGEX: matches the PORTABLE exe naming", () => {
  const { DESKTOP_ASSET_REGEX } = loadFresh();
  // The published desktop asset is the portable exe (no "Setup").
  const m = DESKTOP_ASSET_REGEX.exec("Figaf-Installer-1.2.3-x64.exe");
  assert.ok(m, "should match the portable name");
  assert.equal(m[1], "1.2.3");
  // A "Setup"-style NSIS name must NOT match — we don't build or publish it,
  // and if some future build did, the self-update must not point at it.
  assert.equal(DESKTOP_ASSET_REGEX.exec("Figaf-Installer-Setup-1.2.3-x64.exe"), null);
  assert.equal(DESKTOP_ASSET_REGEX.exec("figaf-manager-app-1.2.3.zip"), null);
});
