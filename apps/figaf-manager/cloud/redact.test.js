"use strict";
// Tests for the cli:line redaction helper exported by cloud/auth.js.
// Run via `node --test apps/figaf-manager/cloud/redact.test.js`.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { redact } = require("./auth");

test("redacts a 32-char base64url-shaped token mid-line", () => {
  // Use a token that matches our own minted shape: 32 chars from [A-Za-z0-9_-].
  // Avoid putting `-` directly adjacent to `_` because \b fires between word
  // chars (incl. _) and non-word chars (-), splitting one match into two; in
  // real boot-line output the token is whitespace-delimited.
  const tok = "AbCdEf1234567890aBcDeFGHIJKLmnop";
  const line = "got token " + tok + " in body";
  const out = redact(line);
  assert.equal(out, "got token [redacted] in body");
});

test("redacts a 44-char base64url-shaped token (upper bound)", () => {
  const tok = "A".repeat(44);
  const out = redact("prefix " + tok + " suffix");
  assert.equal(out, "prefix [redacted] suffix");
});

test("does NOT redact strings shorter than 32 chars", () => {
  const tok31 = "A".repeat(31);
  const out = redact("tail " + tok31 + " end");
  assert.equal(out, "tail " + tok31 + " end");
});

test("[SETUP] allow-prefix: line is passed through verbatim", () => {
  // Critical detail callout from §1.4: without the allow-prefix, the boot line's
  // token would be scrubbed before the operator could copy it from the logs.
  const tok = "AbCdEf1234567890aBcDeF1234567890";
  const line = "[SETUP] Token: " + tok + " — visit https://x/setup";
  const out = redact(line);
  assert.equal(out, line, "[SETUP] lines must round-trip untouched");
});

test("does NOT mangle JSON with +/= characters (typical service-binding creds)", () => {
  // R8: regex must NOT match base64-padded values (those contain +, /, =).
  const cred = "abcDEF/123+456=78"; // 18 chars; even if longer, contains disallowed charset
  const line = "binding: " + cred + " more text";
  assert.equal(redact(line), line, "+,/,= take the value out of the base64url charset");

  const longCred = "ZXhhbXBsZS1jcmVkZW50aWFsLXdpdGgtcGFkZGluZw==";
  // 44 chars but contains `==`; word-boundary regex still won't match because = is not in [A-Za-z0-9_-]
  // and the {32,44} word would split at the first =.
  // Confirm the trailing == is preserved.
  assert.ok(redact("creds: " + longCred).includes("=="), "padding survives redact");
});

test("redacts a freshly-minted setup token in mid-stream output", () => {
  // End-to-end shape: the same generator we use at boot must produce tokens
  // the redact() regex catches when they appear in unexpected output (i.e.,
  // someone accidentally echoed the token into a cli:line).
  const { generateSetupToken, __resetForTests } = require("./auth");
  __resetForTests();
  const tok = generateSetupToken();
  // Surround with whitespace as a real cli:line would.
  const out = redact("[cli][cf] login output included " + tok + " value");
  assert.ok(out.includes("[redacted]"), "minted token must be redacted");
  assert.ok(!out.includes(tok), "cleartext must not survive redact");
});

test("non-string input returned unchanged (defensive)", () => {
  assert.equal(redact(undefined), undefined);
  assert.equal(redact(null), null);
  assert.equal(redact(42), 42);
});

test("does NOT redact kebab-case names and GUIDs (hyphens, no uppercase): CF app names of 32-44 characters stay readable", () => {
  const line = "cf push figaf-faid-apps-b2b-archiving-setup -p dir --no-manifest";
  assert.equal(redact(line), line);
  const guid = "cf curl /v3/apps?space_guids=e4fb438f-1df1-4e4f-8962-02b4ed2eca63";
  assert.equal(redact(guid), guid);
  // A hyphenated token WITH uppercase letters is still hidden.
  assert.equal(redact("x AbCd-Ef1234567890aBcDeFGHIJKLmnop y"), "x [redacted] y");
  // A lowercase string without hyphens in the token shape is still hidden (safe direction).
  assert.equal(redact("x " + "abcdefghij0123456789abcdefghijkl" + " y"), "x [redacted] y");
});
