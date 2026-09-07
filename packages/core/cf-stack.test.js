"use strict";
// Tests for cf-stack.js: parsing `cf stacks`, the push arguments, the
// missing-stack sentence, and CF_STACK for the manager's own approuter.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { parseStackNames, ownStack, stackArgs, wantedStacks, missingStacks, missingStackError } = require("./cf-stack");

// Real output of cf CLI 8.x on eu10-004 (2026-09-07).
const CF_STACKS_OUTPUT = [
  "Getting stacks as ais@figaf.com...",
  "",
  "name         description",
  "cflinuxfs3   Cloud Foundry Linux-based filesystem (Ubuntu 18.04)",
  "cflinuxfs4   Cloud Foundry Linux-based filesystem (Ubuntu 22.04)",
  "cflinuxfs5   Cloud Foundry Linux-based filesystem (Ubuntu 24.04)",
  "",
].join("\n");

test("parseStackNames: the names from the table, header and preamble skipped", () => {
  assert.deepEqual(parseStackNames(CF_STACKS_OUTPUT), ["cflinuxfs3", "cflinuxfs4", "cflinuxfs5"]);
  assert.deepEqual(parseStackNames(CF_STACKS_OUTPUT.replace(/\n/g, "\r\n")), ["cflinuxfs3", "cflinuxfs4", "cflinuxfs5"], "CRLF");
  assert.deepEqual(parseStackNames(""), []);
  assert.deepEqual(parseStackNames("Getting stacks as x...\nFAILED\nNot logged in"), [], "no table, no names");
});

test("stackArgs / wantedStacks / missingStacks", () => {
  assert.deepEqual(stackArgs("cflinuxfs5"), ["-s", "cflinuxfs5"]);
  assert.deepEqual(stackArgs(undefined), []);
  assert.deepEqual(stackArgs(""), []);
  const cfApps = [{ name: "a", stack: "cflinuxfs5" }, { name: "b" }, { name: "c", stack: "cflinuxfs5" }, { name: "d", stack: "cflinuxfs4" }];
  assert.deepEqual(wantedStacks(cfApps), ["cflinuxfs5", "cflinuxfs4"]);
  assert.deepEqual(wantedStacks([]), []);
  assert.deepEqual(missingStacks(["cflinuxfs5"], ["cflinuxfs3", "cflinuxfs4"]), ["cflinuxfs5"]);
  assert.deepEqual(missingStacks(["cflinuxfs5"], ["cflinuxfs4", "cflinuxfs5"]), []);
});

test("missingStackError names the missing stack and what the landscape offers", () => {
  const msg = missingStackError(["cflinuxfs5"], ["cflinuxfs3", "cflinuxfs4"]);
  assert.match(msg, /needs the Cloud Foundry stack cflinuxfs5/);
  assert.match(msg, /cf stacks: cflinuxfs3, cflinuxfs4/);
  assert.match(missingStackError(["cflinuxfs5"], []), /\(none listed\)/);
});

test("ownStack: CF_STACK of the container, null outside CF", () => {
  assert.equal(ownStack({ CF_STACK: "cflinuxfs5" }), "cflinuxfs5");
  assert.equal(ownStack({ CF_STACK: "  " }), null);
  assert.equal(ownStack({}), null);
  assert.equal(ownStack(undefined), null);
});
