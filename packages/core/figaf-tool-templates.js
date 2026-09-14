"use strict";
// figaf-tool-templates.js - pure text helpers for the Figaf Tool deploy
// templates (manifest.yml, xs-security.json) that config:writeVars patches
// before `cf create-service` and `cf push`. No I/O; unit tests in
// figaf-tool-templates.test.js.
//
// The two service instances the Figaf Tool always binds have DEFAULT names
// the person may change on the Configuration screen (2026-09-08):
//   figaf-db     the PostgreSQL instance (may be the one the FAID backend
//                shares; an existing instance is reused, never re-created)
//   figaf-xsuaa  the XSUAA instance. XSUAA requires `xsappname` to be unique
//                per SUBACCOUNT, not per space, so the xsappname in
//                xs-security.json always FOLLOWS the instance name: two
//                Figaf Tools in one subaccount need two names.
//
// Additional environment variables (2026-09-14, gap G1): the Figaf image's
// start script reads far more variables than the template names, so the
// Configuration screen and the Update form carry a free-form key/value table
// whose rows are written into the app's `env:` block here. TEMPLATE_ENV_KEYS
// is the reserved set: the keys the template already owns (the table must not
// offer a second way to set them) and, at the same time, the keys
// update:readCurrentConfig subtracts from the live environment to find what
// somebody added by hand.

const DEFAULT_DB_SERVICE = "figaf-db";
const DEFAULT_XSUAA_SERVICE = "figaf-xsuaa";

// The eleven keys of the template's app `env:` block, plus the vars.yml names
// that reach the app through a `((placeholder))` rather than as an env key of
// their own. figaf-tool-templates.test.js asserts the first group still
// matches packages/deploy-templates/manifest.yml, so a template change from
// Figaf fails a test instead of drifting silently.
const TEMPLATE_ENV_KEYS = Object.freeze([
  "IRT_SERVER_PORT",
  "IRT_CONTAINER_PORT",
  "IRT_LOGON_MODE",
  "BTP_APP_ROUTER_URL",
  "IAS_XSUAA_XCHANGE_ENABLED",
  "LOCATION_ID",
  "LOGS_TOTAL_SIZE_CAP",
  "MAX_RAM_PERCENTAGE",
  "ENABLE_INSTANCE_MONITORING",
  "USE_CLOUD_CONNECTOR_FOR_SMTP_INTEGRATION",
  "CLOUD_CONNECTOR_DESTINATION_NAME_FOR_SMTP_INTEGRATION",
  // vars.yml only - no env key of the same name on the app
  "ID",
  "LANDSCAPE_APPS_DOMAIN",
  "DOCKER_IMAGE_VERSION",
  "DOCKER_USERNAME",
  "INSTANCE_MEMORY",
]);

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Comment or uncomment one optional service line of the app block
 * (`  - figaf-connectivity` with exactly two spaces, as in the template).
 */
function patchManifestService(text, serviceName, enable) {
  const re = new RegExp(`^(#?)(  - ${escapeRe(serviceName)})$`, "m");
  return text.replace(re, enable ? "$2" : "#$2");
}

/**
 * Rename every `- <from>` list entry of the manifest to `- <to>`, whatever
 * its indentation or comment marker (the XSUAA instance appears under the
 * app AND the router). A no-op when the names are equal.
 */
function renameManifestService(text, from, to) {
  if (!from || !to || from === to) return text;
  const re = new RegExp(`^(\\s*#?\\s*- )${escapeRe(from)}(\\s*)$`, "gm");
  return text.replace(re, `$1${to}$2`);
}

/**
 * The manifest for one deployment: optional PI/PO services toggled, the two
 * required instances renamed when the person chose other names. `text` must
 * be the PRISTINE template (config:writeVars keeps a copy), so the function
 * is idempotent over deployments in one container.
 */
function applyManifestServices(text, opts) {
  const o = opts || {};
  let out = text;
  out = patchManifestService(out, "figaf-connectivity", !!o.enableConnectivity);
  out = patchManifestService(out, "figaf-destination", !!o.enableDestination);
  out = renameManifestService(out, DEFAULT_DB_SERVICE, o.dbServiceName || DEFAULT_DB_SERVICE);
  out = renameManifestService(out, DEFAULT_XSUAA_SERVICE, o.xsuaaServiceName || DEFAULT_XSUAA_SERVICE);
  return out;
}

/**
 * Normalize and check the free-form environment rows the screens send.
 * `rows` is either { KEY: value } or [{ key, value }] (the table keeps an
 * ordered array so an empty trailing row can exist while typing); empty keys
 * are dropped, so a half-typed row never reaches the manifest.
 * Returns { ok, env } or { ok:false, error }.
 */
function validateEnvRows(rows) {
  const list = Array.isArray(rows)
    ? rows.map((r) => [r && r.key, r && r.value])
    : Object.entries(rows || {});
  const env = {};
  for (const [rawKey, rawValue] of list) {
    const key = rawKey == null ? "" : String(rawKey).trim();
    if (!key) continue;
    const value = rawValue == null ? "" : String(rawValue);
    if (!ENV_KEY_RE.test(key)) {
      return { ok: false, error: `"${key}" is not a valid environment variable name - letters, digits and _, not starting with a digit` };
    }
    if (TEMPLATE_ENV_KEYS.includes(key)) {
      return { ok: false, error: `${key} is set by the deployment template - use its own field on this screen instead of an additional variable` };
    }
    if (Object.prototype.hasOwnProperty.call(env, key)) {
      return { ok: false, error: `${key} is listed twice` };
    }
    // `cf push --vars-file` substitutes ((NAME)) ANYWHERE in the manifest,
    // including inside a literal value, and a newline would break the block.
    if (/[\u0000-\u001f\u007f]/.test(value)) {
      return { ok: false, error: `the value of ${key} cannot contain line breaks or control characters` };
    }
    if (value.includes("((")) {
      return { ok: false, error: `the value of ${key} cannot contain "((" - Cloud Foundry would replace ((NAME)) from vars.yml` };
    }
    env[key] = value;
  }
  return { ok: true, env };
}

const ENV_BLOCK_RE = /^(\s*)env:\s*$/;

/** A YAML single-quoted scalar: the one quoting that needs no other escape. */
function yamlQuote(value) {
  return "'" + String(value == null ? "" : value).replace(/'/g, "''") + "'";
}

/**
 * Append `KEY: 'value'` lines to the `env:` block of the FIRST application of
 * the manifest (the Figaf Tool app). The router further down has an `env:`
 * block of its own (`destinations`, `httpHeaders`) that must stay untouched,
 * which is why this takes the first block and not every one.
 *
 * Line-based like the rest of this module: the manifest is a controlled
 * artifact with a known shape (see manifest-patch.js on why this repo does not
 * pull in a YAML parser for it). `text` must be the PRISTINE template, so the
 * result is idempotent over deployments in one container.
 */
function applyManifestEnv(text, env) {
  const keys = Object.keys(env || {});
  if (!keys.length) return text;
  const lines = String(text).split("\n");
  const start = lines.findIndex((l) => ENV_BLOCK_RE.test(l));
  if (start < 0) throw new Error("manifest.yml: the first application has no env: block");
  const indent = ENV_BLOCK_RE.exec(lines[start])[1];
  let entryIndent = null;
  let end = start + 1;
  for (; end < lines.length; end++) {
    const line = lines[end];
    if (!line.trim()) continue; // a blank line inside the block
    const lead = /^[ \t]*/.exec(line)[0];
    if (lead.length <= indent.length) break; // the next key of the application
    if (entryIndent === null) entryIndent = lead;
  }
  // Blank lines before the next key belong after the block, not inside it.
  while (end > start + 1 && !lines[end - 1].trim()) end--;
  const pad = entryIndent === null ? indent + "  " : entryIndent;
  lines.splice(end, 0, ...keys.map((k) => `${pad}${k}: ${yamlQuote(env[k])}`));
  return lines.join("\n");
}

/**
 * xs-security.json with `xsappname` set to the XSUAA instance name. Returns
 * { ok, text } or { ok:false, error } when the template is not JSON.
 */
function setXsappname(jsonText, name) {
  let doc;
  try { doc = JSON.parse(jsonText); }
  catch (e) { return { ok: false, error: `xs-security.json is not valid JSON: ${e.message}` }; }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return { ok: false, error: "xs-security.json is not a JSON object" };
  doc.xsappname = name || DEFAULT_XSUAA_SERVICE;
  return { ok: true, text: JSON.stringify(doc, null, 2) + "\n" };
}

module.exports = {
  DEFAULT_DB_SERVICE,
  DEFAULT_XSUAA_SERVICE,
  TEMPLATE_ENV_KEYS,
  patchManifestService,
  renameManifestService,
  applyManifestServices,
  validateEnvRows,
  applyManifestEnv,
  setXsappname,
};
