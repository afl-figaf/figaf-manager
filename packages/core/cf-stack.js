"use strict";
// Cloud Foundry STACKS — the root file system an app container runs on
// (cflinuxfs4 = Ubuntu 22.04, cflinuxfs5 = Ubuntu 24.04).
//
// Who decides the stack:
//   - A FAID release names the stack of every CF app in its catalog
//     (`cfApps[].stack`, figaf-faid decision 0015). The manager passes it to
//     `cf push -s`. A cfApp without `stack` gets the landscape's default
//     stack, as before (older catalogs keep working).
//   - The manager itself gets its stack from its manifest.yml. Its approuter
//     follows the manager: CF sets CF_STACK in every container, so the
//     approuter push takes the stack the manager runs on. Outside CF
//     (desktop, dev checkout) there is no CF_STACK and no `-s` is passed.
//
// Why a pre-check: `cf push -s <unknown>` fails only after the upload, with a
// short CAPI message. `cf stacks` before the first push turns that into a
// clear sentence that names the stacks this landscape offers. The check is
// skipped (with a warning) when `cf stacks` itself fails — the push then
// reports the problem.

/**
 * The stack names from `cf stacks` output. The table starts after the
 * `name  description` header; earlier lines ("Getting stacks as …") and
 * blank lines are ignored.
 */
function parseStackNames(stdout) {
  const names = [];
  let inTable = false;
  for (const raw of String(stdout || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (!inTable) {
      if (/^name\s+description/i.test(line)) inTable = true;
      continue;
    }
    const name = line.split(/\s+/)[0];
    if (name && name !== "OK" && name !== "FAILED") names.push(name);
  }
  return names;
}

/** The stack this process runs on (CF sets CF_STACK), or null outside CF. */
function ownStack(env = process.env) {
  const s = env && env.CF_STACK ? String(env.CF_STACK).trim() : "";
  return s || null;
}

/** `cf push` arguments for a stack: `-s <stack>`, or nothing when unset. */
function stackArgs(stack) {
  return stack ? ["-s", String(stack)] : [];
}

/** The distinct stacks the given catalog cfApps ask for, in catalog order. */
function wantedStacks(cfApps) {
  const seen = new Set();
  const out = [];
  for (const c of cfApps || []) {
    if (c && c.stack && !seen.has(c.stack)) { seen.add(c.stack); out.push(c.stack); }
  }
  return out;
}

/** The stacks in `wanted` that `available` does not offer. */
function missingStacks(wanted, available) {
  const have = new Set(available || []);
  return (wanted || []).filter((s) => !have.has(s));
}

/** The sentence the console shows when a landscape lacks a stack the release needs. */
function missingStackError(missing, available) {
  const offers = available && available.length ? available.join(", ") : "(none listed)";
  return `this release needs the Cloud Foundry stack ${missing.join(", ")}, which this landscape does not offer (cf stacks: ${offers}) — ` +
    "ask SAP when the stack arrives on this landscape, or install a release built for an available stack";
}

module.exports = { parseStackNames, ownStack, stackArgs, wantedStacks, missingStacks, missingStackError };
