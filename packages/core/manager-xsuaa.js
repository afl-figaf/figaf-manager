"use strict";
// One XSUAA instance for the Figaf Manager and the FAID Apps (figaf-platform
// decision 0009). The manager's roles live in the same instance as the apps'
// roles: xsappname `figaf-faid`, instance `figaf-faid-xsuaa` (frozen names,
// decision 0008).
//
// Two parts, two owners:
//   - manager part: ./manager-xsuaa-part.json (ships with the manager)
//   - release part: xs-security.json in the platform release (ships with the apps)
// composeXsSecurity() builds the full document whenever the manager creates or
// updates the instance (Setup step 1 "Prepare the space", Setup step 3, before every
// install/update). Union by name, the release entry wins on a name clash,
// xsappname is always the shared one.
//
// Legacy: Alex's shipped installations are bound to `figaf-manager-xsuaa`
// (xsappname `figaf-manager-xsuaa`, scope FigafManagerOperator). Nothing
// creates that instance any more, but the manager keeps accepting it.
//
// Pure module: no I/O, no process access. Unit-tested in manager-xsuaa.test.js.

const MANAGER_PART = require("./manager-xsuaa-part.json");

const SHARED_INSTANCE = "figaf-faid-xsuaa";
const SHARED_XSAPPNAME = "figaf-faid";
const SHARED_OPERATOR_SCOPE = "FAIDManagerOperator";
const SHARED_ADMIN_SCOPE = "FAIDManagerAdmin";
const SHARED_OPERATOR_COLLECTION = "FAID-Manager-Operator";
const SHARED_ADMIN_COLLECTION = "FAID-Manager-Admin";

const LEGACY_INSTANCE = "figaf-manager-xsuaa";
const LEGACY_XSAPPNAME = "figaf-manager-xsuaa";
const LEGACY_OPERATOR_SCOPE = "FigafManagerOperator";
const LEGACY_ADMIN_COLLECTION = "FigafManagerAdmin";
const LEGACY_OPERATOR_COLLECTION = "FigafManagerOperator";

// Same placeholder as faid-apps.js (decision 0008): filled with the landscape's
// shared `cfapps.` domain by whoever creates or updates the instance.
const APPS_DOMAIN_PLACEHOLDER = "__CF_APPS_DOMAIN__";

/**
 * The xsappname as written in xs-security.json. A binding reports it with a
 * tenant suffix (`figaf-faid!t12345`); strip everything from the first `!`.
 */
function xsappnameBase(name) {
  const s = String(name || "");
  const bang = s.indexOf("!");
  return bang >= 0 ? s.slice(0, bang) : s;
}

function isSharedXsappname(name) {
  return xsappnameBase(name) === SHARED_XSAPPNAME;
}

function isLegacyXsappname(name) {
  return xsappnameBase(name) === LEGACY_XSAPPNAME;
}

/**
 * The scope the manager requires for its operator, by the xsappname of the
 * bound instance. Shared instance -> FAIDManagerOperator; the legacy
 * instance (and anything unknown, to stay compatible with old installations)
 * -> FigafManagerOperator.
 */
function operatorScopeName(xsappname) {
  return isSharedXsappname(xsappname) ? SHARED_OPERATOR_SCOPE : LEGACY_OPERATOR_SCOPE;
}

/** Role collection the SSO step assigns by default, per instance. */
function adminCollectionFor(instanceName) {
  return instanceName === LEGACY_INSTANCE ? LEGACY_ADMIN_COLLECTION : SHARED_ADMIN_COLLECTION;
}

function unionByName(releaseList, managerList) {
  const out = Array.isArray(releaseList) ? releaseList.map((e) => ({ ...e })) : [];
  const seen = new Set(out.map((e) => e && e.name));
  for (const e of Array.isArray(managerList) ? managerList : []) {
    if (!e || !e.name || seen.has(e.name)) continue;
    out.push({ ...e });
    seen.add(e.name);
  }
  return out;
}

/**
 * Compose the full xs-security document.
 *
 * @param {object} opts
 * @param {object|null} opts.release     the release's xs-security.json (parsed), or null when no release is present
 * @param {object} [opts.managerPart]    defaults to the bundled manager part
 * @param {string} [opts.appsDomain]     the landscape's cfapps domain; required when a placeholder is present
 * @returns {{ ok: true, doc: object } | { ok: false, error: string }}
 */
function composeXsSecurity({ release, managerPart, appsDomain } = {}) {
  const mp = managerPart || MANAGER_PART;
  const rel = release || null;
  if (rel && rel.xsappname && xsappnameBase(rel.xsappname) !== SHARED_XSAPPNAME) {
    return { ok: false, error: `release xs-security.json has xsappname '${rel.xsappname}'; it must be '${SHARED_XSAPPNAME}' (decision 0008)` };
  }
  const relOauth = (rel && rel["oauth2-configuration"]) || {};
  const mpOauth = mp["oauth2-configuration"] || {};
  const redirects = [];
  for (const u of [...(relOauth["redirect-uris"] || []), ...(mpOauth["redirect-uris"] || [])]) {
    if (u && !redirects.includes(u)) redirects.push(u);
  }
  const doc = {
    xsappname: SHARED_XSAPPNAME,
    "tenant-mode": (rel && rel["tenant-mode"]) || mp["tenant-mode"] || "dedicated",
    description: (rel && rel.description) || mp.description || "",
    scopes: unionByName(rel && rel.scopes, mp.scopes),
    "role-templates": unionByName(rel && rel["role-templates"], mp["role-templates"]),
    "role-collections": unionByName(rel && rel["role-collections"], mp["role-collections"]),
    "oauth2-configuration": { ...mpOauth, ...relOauth, "redirect-uris": redirects },
  };
  // Any other top-level keys of the release (e.g. "attributes") pass through.
  if (rel) {
    for (const k of Object.keys(rel)) {
      if (!(k in doc)) doc[k] = rel[k];
    }
  }
  let text = JSON.stringify(doc, null, 2);
  if (text.includes(APPS_DOMAIN_PLACEHOLDER)) {
    if (!appsDomain) return { ok: false, error: `xs-security needs the landscape's cfapps domain to fill ${APPS_DOMAIN_PLACEHOLDER}` };
    text = text.split(APPS_DOMAIN_PLACEHOLDER).join(appsDomain);
  }
  return { ok: true, doc: JSON.parse(text) };
}

module.exports = {
  MANAGER_PART,
  SHARED_INSTANCE,
  SHARED_XSAPPNAME,
  SHARED_OPERATOR_SCOPE,
  SHARED_ADMIN_SCOPE,
  SHARED_OPERATOR_COLLECTION,
  SHARED_ADMIN_COLLECTION,
  LEGACY_INSTANCE,
  LEGACY_XSAPPNAME,
  LEGACY_OPERATOR_SCOPE,
  LEGACY_ADMIN_COLLECTION,
  LEGACY_OPERATOR_COLLECTION,
  APPS_DOMAIN_PLACEHOLDER,
  xsappnameBase,
  isSharedXsappname,
  isLegacyXsappname,
  operatorScopeName,
  adminCollectionFor,
  composeXsSecurity,
};
