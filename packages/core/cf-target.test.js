"use strict";
// Pure-logic tests for the `cf api` / `cf target` stdout parser.
// Run via `node --test packages/core/cf-target.test.js`.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { parseCfApi, parseCfTarget, normalizeApiUrl, resolveSelfPin, explainPinnedLoginFailure } = require("./cf-target");

// ── Captured live from cf-cli v8.18 (cf api) ──────────────────────────────
const SAMPLE_CF_API = [
  "API endpoint:   https://api.cf.us10-001.hana.ondemand.com",
  "API version:    3.220.0",
].join("\n");

// ── Captured live from cf-cli v8.18 (cf target, logged in) ────────────────
const SAMPLE_CF_TARGET_LOGGED_IN = [
  "API endpoint:   https://api.cf.us10-001.hana.ondemand.com",
  "API version:    3.220.0",
  "user:           afl@figaf.com",
  "org:            9c492946trial",
  "space:          dev",
].join("\n");

// ── Captured live from cf-cli v8.18 (after `cf logout`) ───────────────────
// stderr (cf target's exit code is 1 here, stderr carries the message):
const SAMPLE_CF_TARGET_LOGGED_OUT_STDERR =
  "FAILED\nNot logged in. Use 'cf.exe login' or 'cf.exe login --sso' to log in.";

test("parseCfApi extracts the endpoint URL", () => {
  const r = parseCfApi(SAMPLE_CF_API);
  assert.equal(r.apiUrl, "https://api.cf.us10-001.hana.ondemand.com");
});

test("parseCfApi returns null apiUrl on garbage input", () => {
  assert.equal(parseCfApi("").apiUrl, null);
  assert.equal(parseCfApi("nothing relevant").apiUrl, null);
});

test("parseCfTarget extracts apiUrl, user, org, space when logged in", () => {
  const r = parseCfTarget(SAMPLE_CF_TARGET_LOGGED_IN);
  assert.equal(r.loggedIn, true);
  assert.equal(r.apiUrl, "https://api.cf.us10-001.hana.ondemand.com");
  assert.equal(r.user, "afl@figaf.com");
  assert.equal(r.orgName, "9c492946trial");
  assert.equal(r.spaceName, "dev");
});

test("parseCfTarget detects logged-out via stderr 'Not logged in' marker", () => {
  // Caller passes stdout+stderr concatenated; the substring match wins.
  const r = parseCfTarget(SAMPLE_CF_TARGET_LOGGED_OUT_STDERR);
  assert.equal(r.loggedIn, false);
  assert.equal(r.user, null);
  assert.equal(r.orgName, null);
  assert.equal(r.spaceName, null);
});

test("parseCfTarget detects logged-out when only some fields present (e.g. api endpoint without org)", () => {
  // cf target prints API endpoint even when not logged in — only user/org/space
  // are missing. Treat the absence of user as logged-out.
  const text = [
    "API endpoint:   https://api.cf.us10-001.hana.ondemand.com",
    "API version:    3.220.0",
  ].join("\n");
  const r = parseCfTarget(text);
  assert.equal(r.loggedIn, false);
});

test("parseCfTarget is tolerant of whitespace and casing variations in keys", () => {
  // Older cf-cli versions used `api endpoint:` (lowercase). Accept both.
  const text = [
    "api endpoint:   https://api.cf.us10-001.hana.ondemand.com",
    "User:           afl@figaf.com",
    "Org:            myorg",
    "Space:          dev",
  ].join("\n");
  const r = parseCfTarget(text);
  assert.equal(r.apiUrl, "https://api.cf.us10-001.hana.ondemand.com");
  assert.equal(r.user, "afl@figaf.com");
  assert.equal(r.orgName, "myorg");
  assert.equal(r.spaceName, "dev");
  assert.equal(r.loggedIn, true);
});

test("normalizeApiUrl strips trailing slash and lowercases scheme+host", () => {
  assert.equal(
    normalizeApiUrl("HTTPS://API.CF.us10-001.HANA.ONDEMAND.COM/"),
    "https://api.cf.us10-001.hana.ondemand.com"
  );
  assert.equal(normalizeApiUrl(""), "");
  assert.equal(normalizeApiUrl(null), "");
});

// ── resolveSelfPin: the manager's own space as the automatic CF target ──────

const SELF = {
  apiUrl: "https://api.cf.eu10-004.hana.ondemand.com",
  orgName: "Figaf ApS_figafpartner-1",
  spaceName: "figaf-l3-l4",
};

test("resolveSelfPin: hosted manager, login to its own endpoint -> pin its org/space", () => {
  assert.deepEqual(resolveSelfPin(SELF, SELF.apiUrl), {
    org: "Figaf ApS_figafpartner-1",
    space: "figaf-l3-l4",
  });
});

test("resolveSelfPin: a trailing slash or upper case on the endpoint still pins", () => {
  assert.deepEqual(resolveSelfPin(SELF, "https://API.cf.eu10-004.hana.ondemand.com/"), {
    org: "Figaf ApS_figafpartner-1",
    space: "figaf-l3-l4",
  });
});

test("resolveSelfPin: another CF landscape -> no pin (the picker stays, Figaf-tool flow)", () => {
  assert.equal(resolveSelfPin(SELF, "https://api.cf.us10-001.hana.ondemand.com"), null);
});

test("resolveSelfPin: desktop mode (no self target) -> no pin", () => {
  assert.equal(resolveSelfPin(null, SELF.apiUrl), null);
});

test("resolveSelfPin: incomplete VCAP target -> no pin", () => {
  assert.equal(resolveSelfPin({ apiUrl: SELF.apiUrl, orgName: "O" }, SELF.apiUrl), null);
  assert.equal(resolveSelfPin({ orgName: "O", spaceName: "S" }, SELF.apiUrl), null);
});

test("resolveSelfPin: no requested endpoint -> no pin", () => {
  assert.equal(resolveSelfPin(SELF, ""), null);
  assert.equal(resolveSelfPin(SELF, null), null);
});

// ── explainPinnedLoginFailure ───────────────────────────────────────────────

const PIN = { org: "Figaf ApS_figafpartner-1", space: "figaf-l3-l4" };

test("explainPinnedLoginFailure: space not found -> names the space and the fix", () => {
  const msg = explainPinnedLoginFailure("FAILED\nSpace 'figaf-l3-l4' not found\n", PIN);
  assert.match(msg, /figaf-l3-l4/);
  assert.match(msg, /Space Developer/);
});

test("explainPinnedLoginFailure: org not found -> names the org and the fix", () => {
  const msg = explainPinnedLoginFailure("FAILED\nOrganization 'Figaf ApS_figafpartner-1' not found\n", PIN);
  assert.match(msg, /Figaf ApS_figafpartner-1/);
  assert.match(msg, /administrator/);
});

test("explainPinnedLoginFailure: a rejected passcode is NOT reported as a missing role", () => {
  assert.equal(explainPinnedLoginFailure("Credentials were rejected, please try again.", PIN), null);
  assert.equal(explainPinnedLoginFailure("Invalid passcode", PIN), null);
});

test("explainPinnedLoginFailure: no pin -> no message (the picker explained itself)", () => {
  assert.equal(explainPinnedLoginFailure("Space 'x' not found", null), null);
});
