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

const DEFAULT_DB_SERVICE = "figaf-db";
const DEFAULT_XSUAA_SERVICE = "figaf-xsuaa";

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
  patchManifestService,
  renameManifestService,
  applyManifestServices,
  setXsappname,
};
