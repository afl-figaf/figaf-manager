"use strict";
// base-services.js - the ONE source of the base service instances of a Figaf
// Platform installation (docs/base-services-ownership-plan.md, built
// 2026-09-08; figaf-faid decision 0018).
//
// The manager OWNS the base instances: their offering, default name, whether
// the person may rename them, the plans, who binds them, and the optional
// groups. This is infrastructure of the customer's space; it does not change
// per release, and it drives the manager's screens (Setup step 1 plans and
// names, Setup step 3 "Base services"). So it lives here, not in the release
// catalog: a screen feature that needs a new flag must not wait for a release.
//
// The release catalog (v7) says only what the release's CF apps REQUIRE, by
// KIND, never by instance name:
//
//   "requires": { "database": "own-role", "xsuaa": "binding", "credstore": "binding" }
//   "optional": ["pipo"]
//
//   kind        one of the KINDS below (database, xsuaa, credstore)
//   consumption "binding"  - the manager binds the instance to the CF app
//               "own-role" - database only: the backend gets the Credential
//                            Store entry and FAID_DATABASE_CA, never a binding
//                            (faid-database.js; decision 0012 section 10)
//   optional    optional GROUPS the CF app binds when their instances exist
//               ("pipo" = connectivity + destination for on-premise PI/PO)
//
// A catalog that still carries a `services` list (v6 or older), or a cfApp
// with `services` / `optionalServices` (instance names), is refused with one
// clear sentence: no compatibility layer (plan section 2, decision 1 - no
// customer has an installation; 0.8.0 is the first release the new manager
// installs). A kind, a consumption or a group the manager does not know is a
// catalog error before any cf call.
//
// Frozen names (decision 0008 is the record, this module is the code):
// `figaf-faid-xsuaa`, `figaf-faid-credstore`; the database name `figaf-db` is
// a DEFAULT the person may change (decision 0008 amendment of 2026-09-08);
// the PI/PO pair keeps the Figaf Tool's names (decision 0012 section 4E).
//
// Pure data plus small helpers; no I/O. Unit tests: base-services.test.js.

const { validateInstanceName } = require("./faid-database");

const KINDS = ["database", "xsuaa", "credstore"];
const CONSUMPTIONS = ["binding", "own-role"];

/**
 * The base instances, in the order the screens show them. `name` is the
 * DEFAULT instance name and the key of every `plans` / `names` / `only`
 * argument the UI sends (the row shape of faid:services). `kind` is what a
 * catalog `requires` names; optional instances are addressed by `group`.
 */
const BASE_SERVICES = Object.freeze([
  Object.freeze({
    kind: "database",
    offering: "postgresql-db",
    name: "figaf-db",
    nameEditable: true,
    plan: "free",
    // `plans` is the ALLOW-LIST and the order of preference: the first entry a
    // landscape actually offers is what a run falls back to when the default
    // is not on its marketplace (`trial` exists only on BTP trial accounts;
    // 2026-09-14). Never put a plan that costs money before a free one.
    plans: Object.freeze(["free", "trial", "standard"]),
    access: "own-role",
    bindToManager: false,
    optional: false,
    group: "",
    sharedWith: "",
    purpose: "PostgreSQL instance; the FAID backend gets its own role faid_app, limited to schema faid (never a binding). May be the Figaf Tool's instance.",
  }),
  Object.freeze({
    kind: "xsuaa",
    offering: "xsuaa",
    name: "figaf-faid-xsuaa",
    nameEditable: false,
    plan: "application",
    plans: Object.freeze(["application"]),
    access: "binding",
    bindToManager: false,
    optional: false,
    group: "",
    sharedWith: "",
    // The release part of the XSUAA document (the apps' roles) ships with
    // the release under this fixed name; the manager merges its own part in
    // (manager-xsuaa.js, decision 0009).
    configFile: "xs-security.json",
    purpose: "Roles of the manager and the FAID Apps (one XSUAA instance, decision 0009)",
  }),
  Object.freeze({
    kind: "credstore",
    offering: "credstore",
    name: "figaf-faid-credstore",
    nameEditable: false,
    plan: "free",
    // See the database's note on the order. A BTP trial subaccount offers
    // `trial` and `proxy` here; `proxy` is the Credential Store proxy, not a
    // store, so it is deliberately NOT in this list.
    plans: Object.freeze(["free", "trial", "standard"]),
    access: "binding",
    bindToManager: true,
    optional: false,
    group: "",
    sharedWith: "",
    // Basic authentication MUST be configured on the INSTANCE: the broker
    // rejects it on binding level (learned 2026-08-31).
    config: Object.freeze({ authentication: Object.freeze({ type: "basic" }) }),
    purpose: "SAP Credential Store for the connections and the manager's management user; the free plan allows one instance per subaccount",
  }),
  Object.freeze({
    kind: "connectivity",
    offering: "connectivity",
    name: "figaf-connectivity",
    nameEditable: false,
    plan: "lite",
    plans: Object.freeze(["lite"]),
    access: "binding",
    bindToManager: false,
    optional: true,
    group: "pipo",
    sharedWith: "figaf-tool",
    purpose: "SAP Cloud Connector tunnel to on-premise PI/PO systems",
  }),
  Object.freeze({
    kind: "destination",
    offering: "destination",
    name: "figaf-destination",
    nameEditable: false,
    plan: "lite",
    plans: Object.freeze(["lite"]),
    access: "binding",
    bindToManager: false,
    optional: true,
    group: "pipo",
    sharedWith: "figaf-tool",
    purpose: "BTP destinations of on-premise PI/PO systems",
  }),
]);

const GROUPS = Object.freeze([...new Set(BASE_SERVICES.filter((s) => s.optional).map((s) => s.group))]);

/** The base instances (a fresh array of the frozen entries). */
function baseServices() {
  return [...BASE_SERVICES];
}

/** The required (non-optional) base service of a kind, or null. */
function serviceOfKind(kind) {
  return BASE_SERVICES.find((s) => s.kind === kind && !s.optional) || null;
}

/** The optional base services of a group, in order. */
function servicesOfGroup(group) {
  return BASE_SERVICES.filter((s) => s.optional && s.group === group);
}

/** The base service with this default name, or null. */
function serviceNamed(name) {
  return BASE_SERVICES.find((s) => s.name === name) || null;
}

/** A base service the backend reaches with its own database role, never a binding. */
function ownRoleService(service) {
  return !!service && service.access === "own-role";
}

/** Does this CF app reach the database with its own role (catalog `requires.database`)? */
function requiresOwnRole(cfApp) {
  return !!(cfApp && cfApp.requires && cfApp.requires.database === "own-role");
}

const OLD_CATALOG_HINT = "this manager needs catalog v7 (requires per CF app; release 0.8.0 or newer)";

/**
 * Validate one cfApp's `requires` and `optional`. Returns { ok, requires,
 * optional } with normalized values, or { ok:false, error }. `where` names
 * the cfApp in the error.
 */
function validateCfAppRequirements(cfApp, where) {
  const label = where || (cfApp && cfApp.name) || "?";
  if (!cfApp || typeof cfApp !== "object") return { ok: false, error: `${label}: not a CF app entry` };
  if (cfApp.services !== undefined || cfApp.optionalServices !== undefined) {
    return { ok: false, error: `${label} names service instances (services / optionalServices) - catalog v6 or older; ${OLD_CATALOG_HINT}` };
  }
  const requires = {};
  if (cfApp.requires !== undefined) {
    if (!cfApp.requires || typeof cfApp.requires !== "object" || Array.isArray(cfApp.requires)) {
      return { ok: false, error: `${label}: 'requires' must be an object { kind: consumption }` };
    }
    for (const [kind, consumption] of Object.entries(cfApp.requires)) {
      if (!KINDS.includes(kind)) {
        return { ok: false, error: `${label} requires an unknown service kind '${kind}' (known: ${KINDS.join(", ")})` };
      }
      if (!CONSUMPTIONS.includes(consumption)) {
        return { ok: false, error: `${label} requires ${kind} as '${consumption}' - unknown consumption (known: ${CONSUMPTIONS.join(", ")})` };
      }
      if (consumption === "own-role" && kind !== "database") {
        return { ok: false, error: `${label} requires ${kind} as 'own-role', which only the database supports` };
      }
      if (consumption === "binding" && kind === "database") {
        return { ok: false, error: `${label} requires the database as a binding - the manager never binds a database instance (a binding runs as dbo, decision 0012); the backend reaches it with its own role ('own-role')` };
      }
      requires[kind] = consumption;
    }
  }
  const optional = [];
  if (cfApp.optional !== undefined) {
    if (!Array.isArray(cfApp.optional) || cfApp.optional.some((g) => typeof g !== "string")) {
      return { ok: false, error: `${label}: 'optional' must be an array of group names (known: ${GROUPS.join(", ")})` };
    }
    for (const g of cfApp.optional) {
      if (!GROUPS.includes(g)) return { ok: false, error: `${label} names an unknown optional group '${g}' (known: ${GROUPS.join(", ")})` };
      if (!optional.includes(g)) optional.push(g);
    }
  }
  return { ok: true, requires, optional };
}

/** Every cfApp of a catalog with a label: the platform's, then each app's. */
function catalogCfApps(catalog) {
  const out = [];
  const platform = catalog && catalog.platform;
  for (const c of (platform && Array.isArray(platform.cfApps) ? platform.cfApps : [])) out.push({ cfApp: c, where: `platform cfApp ${(c && c.name) || "?"}` });
  for (const app of (catalog && Array.isArray(catalog.apps) ? catalog.apps : [])) {
    for (const c of Array.isArray(app.cfApps) ? app.cfApps : []) out.push({ cfApp: c, where: `app '${app.id || "?"}' cfApp ${(c && c.name) || "?"}` });
  }
  return out;
}

/**
 * What a release requires of the space (catalog v7), validated. Returns
 *   { ok, kinds, consumption, groups, services }
 *     kinds        the required kinds, in KINDS order
 *     consumption  { kind: "binding" | "own-role" }
 *     groups       the optional groups any CF app names, in GROUPS order
 *     services     the base services this release needs (required kinds and
 *                  the services of the groups), in the module's order
 * or { ok:false, error } for a v6-or-older catalog and for unknown kinds,
 * consumptions or groups. A catalog whose CF apps require nothing is fine:
 * empty lists (the Setup omits step 3).
 */
function requirementsOf(catalog) {
  if (!catalog || typeof catalog !== "object") return { ok: false, error: "no catalog" };
  if (catalog.services !== undefined) {
    return { ok: false, error: `the catalog carries a 'services' list (catalog v6 or older); ${OLD_CATALOG_HINT}` };
  }
  const consumption = {};
  const groupSet = new Set();
  for (const { cfApp, where } of catalogCfApps(catalog)) {
    const v = validateCfAppRequirements(cfApp, where);
    if (!v.ok) return v;
    for (const [kind, how] of Object.entries(v.requires)) consumption[kind] = how;
    for (const g of v.optional) groupSet.add(g);
  }
  const kinds = KINDS.filter((k) => k in consumption);
  const groups = GROUPS.filter((g) => groupSet.has(g));
  const services = BASE_SERVICES.filter((s) => (s.optional ? groups.includes(s.group) : kinds.includes(s.kind)));
  return { ok: true, kinds, consumption, groups, services };
}

/** The release config files the manager needs for the required instances (today: xs-security.json when XSUAA is required). */
function releaseConfigFiles(catalog) {
  const req = requirementsOf(catalog);
  if (!req.ok) return [];
  return req.services.map((s) => s.configFile).filter(Boolean);
}

/**
 * Default names -> actual instance names. `overrides` ({ defaultName:
 * actualName }) may rename a service with `nameEditable` (validated as a cf
 * instance name); `discovered` holds names found in the space or in the
 * Credential Store entry (the override wins). Returns { ok, names } with an
 * entry for EVERY base service, or { ok:false, error }.
 */
function resolveNames(overrides, discovered) {
  const names = {};
  const over = overrides && typeof overrides === "object" ? overrides : {};
  const found = discovered && typeof discovered === "object" ? discovered : {};
  for (const s of BASE_SERVICES) {
    let actual = s.name;
    const o = over[s.name] != null ? String(over[s.name]).trim() : "";
    if (o !== "" && o !== s.name) {
      if (!s.nameEditable) return { ok: false, error: `the name of ${s.name} cannot be changed` };
      const v = validateInstanceName(o);
      if (!v.ok) return { ok: false, error: `${s.name}: ${v.error}` };
      actual = v.name;
    } else if (found[s.name]) {
      actual = found[s.name];
    }
    names[s.name] = actual;
  }
  for (const key of Object.keys(over)) {
    if (!(key in names)) return { ok: false, error: `unknown service ${key} in names` };
  }
  return { ok: true, names };
}

/**
 * The instance names one CF app binds: `required` = the kinds it consumes
 * as a binding (an own-role database is never here), `optional` = the
 * instances of the groups it names (bound only when they exist). `names`
 * is the map of resolveNames (defaults when omitted).
 */
function bindingsFor(cfApp, names) {
  const nm = names && typeof names === "object" ? names : {};
  const actual = (s) => nm[s.name] || s.name;
  const required = [];
  const optional = [];
  const req = (cfApp && cfApp.requires) || {};
  for (const kind of KINDS) {
    if (req[kind] !== "binding") continue;
    const s = serviceOfKind(kind);
    if (s) required.push(actual(s));
  }
  for (const g of Array.isArray(cfApp && cfApp.optional) ? cfApp.optional : []) {
    for (const s of servicesOfGroup(g)) optional.push(actual(s));
  }
  return { required, optional };
}

/**
 * Which base services a provisioning run wants: a required one always, an
 * optional one only when its group is asked for (`groups`).
 */
function wantedService(service, groups) {
  if (!service || !service.optional) return true;
  const asked = Array.isArray(groups) ? groups : [];
  return asked.includes(service.group || "");
}

module.exports = {
  KINDS,
  CONSUMPTIONS,
  GROUPS,
  BASE_SERVICES,
  baseServices,
  serviceOfKind,
  servicesOfGroup,
  serviceNamed,
  ownRoleService,
  requiresOwnRole,
  validateCfAppRequirements,
  requirementsOf,
  releaseConfigFiles,
  resolveNames,
  bindingsFor,
  wantedService,
};
