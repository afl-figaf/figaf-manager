"use strict";
// Tests for base-services.js: the manager's own list of the base instances
// (catalog v7, docs/base-services-ownership-plan.md). Pure, no I/O.
//   - the list: frozen names, the editable database, the manager-bound
//     Credential Store, the optional PI/PO group
//   - requirementsOf on a v7 catalog, and its refusals: a `services` list
//     (v6 or older), instance names on a cfApp, an unknown kind, an unknown
//     consumption, own-role outside the database, the database as a binding,
//     an unknown optional group
//   - bindingsFor: own role excluded, optional group names carried
//   - resolveNames: defaults, an editable rename (validated), discovery
//   - releaseConfigFiles: xs-security.json only when XSUAA is required

const { test } = require("node:test");
const assert = require("node:assert/strict");

const bs = require("./base-services");

const V7 = {
  releaseVersion: "0.8.0",
  platform: {
    name: "Shared backend (connector)",
    cfApps: [{ name: "figaf-faid-backend", artifact: "backend.zip", requires: { database: "own-role", xsuaa: "binding", credstore: "binding" }, optional: ["pipo"] }],
  },
  apps: [{
    id: "b2b-archiving-setup", version: "0.8.0",
    cfApps: [{ name: "figaf-faid-apps-b2b-archiving-setup", artifact: "b2b-archiving-setup.zip", requires: { xsuaa: "binding" } }],
  }],
};

function withPlatformCfApp(patch) {
  const c = JSON.parse(JSON.stringify(V7));
  Object.assign(c.platform.cfApps[0], patch);
  return c;
}

test("the list: five base services, frozen names, the database editable and own-role, the Credential Store bound to the manager, the PI/PO pair optional and shared", () => {
  const list = bs.baseServices();
  assert.deepEqual(list.map((s) => s.name), ["figaf-db", "figaf-faid-xsuaa", "figaf-faid-credstore", "figaf-connectivity", "figaf-destination"]);
  assert.deepEqual(list.map((s) => s.kind), ["database", "xsuaa", "credstore", "connectivity", "destination"]);
  const by = Object.fromEntries(list.map((s) => [s.kind, s]));
  assert.equal(by.database.offering, "postgresql-db");
  assert.equal(by.database.nameEditable, true);
  assert.equal(by.database.access, "own-role");
  assert.deepEqual([...by.database.plans], ["free", "standard"]);
  assert.equal(by.database.plan, "free", "the default plan is first and free");
  assert.equal(by.xsuaa.plan, "application");
  assert.equal(by.xsuaa.configFile, "xs-security.json");
  assert.equal(by.credstore.bindToManager, true);
  assert.deepEqual(by.credstore.config, { authentication: { type: "basic" } });
  for (const k of ["connectivity", "destination"]) {
    assert.equal(by[k].optional, true);
    assert.equal(by[k].group, "pipo");
    assert.equal(by[k].sharedWith, "figaf-tool");
    assert.equal(by[k].plan, "lite");
  }
  assert.ok(list.filter((s) => s.bindToManager).length === 1, "only the Credential Store is bound to the manager");
  assert.ok(list.filter((s) => s.nameEditable).length === 1, "only the database name is editable today");
  assert.deepEqual(bs.GROUPS, ["pipo"]);
  assert.deepEqual(bs.KINDS, ["database", "xsuaa", "credstore"]);
  assert.equal(bs.serviceOfKind("xsuaa").name, "figaf-faid-xsuaa");
  assert.equal(bs.serviceOfKind("connectivity"), null, "optional services are addressed by group, not kind");
  assert.deepEqual(bs.servicesOfGroup("pipo").map((s) => s.name), ["figaf-connectivity", "figaf-destination"]);
  assert.equal(bs.serviceNamed("figaf-faid-credstore").kind, "credstore");
  assert.equal(bs.serviceNamed("nope"), null);
  assert.ok(Object.isFrozen(bs.BASE_SERVICES[0]), "the entries cannot be changed at runtime");
});

test("requirementsOf: a v7 catalog gives the kinds, their consumption, the groups and the base services in the module's order", () => {
  const r = bs.requirementsOf(V7);
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.kinds, ["database", "xsuaa", "credstore"]);
  assert.deepEqual(r.consumption, { database: "own-role", xsuaa: "binding", credstore: "binding" });
  assert.deepEqual(r.groups, ["pipo"]);
  assert.deepEqual(r.services.map((s) => s.name), ["figaf-db", "figaf-faid-xsuaa", "figaf-faid-credstore", "figaf-connectivity", "figaf-destination"]);
  assert.deepEqual(bs.releaseConfigFiles(V7), ["xs-security.json"]);
});

test("requirementsOf: a release without the PI/PO group lists three instances; a release whose CF apps require nothing lists none", () => {
  const noPipo = withPlatformCfApp({ optional: [] });
  const r = bs.requirementsOf(noPipo);
  assert.deepEqual(r.services.map((s) => s.name), ["figaf-db", "figaf-faid-xsuaa", "figaf-faid-credstore"]);
  assert.deepEqual(r.groups, []);
  const nothing = { releaseVersion: "0.0.1", apps: [{ id: "x", version: "0.0.1", cfApps: [{ name: "x-fe", artifact: "x.zip" }] }] };
  const n = bs.requirementsOf(nothing);
  assert.equal(n.ok, true);
  assert.deepEqual(n.kinds, []);
  assert.deepEqual(n.services, []);
  assert.deepEqual(bs.releaseConfigFiles(nothing), []);
  const frontendOnly = { releaseVersion: "0.0.1", apps: [{ id: "x", version: "0.0.1", cfApps: [{ name: "x-fe", artifact: "x.zip", requires: { xsuaa: "binding" } }] }] };
  assert.deepEqual(bs.requirementsOf(frontendOnly).services.map((s) => s.name), ["figaf-faid-xsuaa"]);
  assert.deepEqual(bs.releaseConfigFiles(frontendOnly), ["xs-security.json"]);
});

test("requirementsOf refuses a catalog of v6 or older: a 'services' list, or instance names on a cfApp", () => {
  const old = { ...V7, services: [{ name: "figaf-db", offering: "postgresql-db", plan: "free" }] };
  const r = bs.requirementsOf(old);
  assert.equal(r.ok, false);
  assert.match(r.error, /'services' list \(catalog v6 or older\); this manager needs catalog v7/);
  const names = withPlatformCfApp({ requires: undefined, services: ["figaf-faid-xsuaa"] });
  assert.match(bs.requirementsOf(names).error, /platform cfApp figaf-faid-backend names service instances .*catalog v6 or older/);
  const opt = JSON.parse(JSON.stringify(V7));
  opt.apps[0].cfApps[0].optionalServices = ["figaf-destination"];
  assert.match(bs.requirementsOf(opt).error, /app 'b2b-archiving-setup' cfApp figaf-faid-apps-b2b-archiving-setup names service instances/);
});

test("requirementsOf refuses an unknown kind, an unknown consumption, own-role outside the database, the database as a binding, an unknown group, and a malformed shape", () => {
  assert.match(bs.requirementsOf(withPlatformCfApp({ requires: { hana: "binding" } })).error, /unknown service kind 'hana' \(known: database, xsuaa, credstore\)/);
  assert.match(bs.requirementsOf(withPlatformCfApp({ requires: { xsuaa: "env" } })).error, /requires xsuaa as 'env' - unknown consumption \(known: binding, own-role\)/);
  assert.match(bs.requirementsOf(withPlatformCfApp({ requires: { credstore: "own-role" } })).error, /requires credstore as 'own-role', which only the database supports/);
  assert.match(bs.requirementsOf(withPlatformCfApp({ requires: { database: "binding" } })).error, /never binds a database instance/);
  assert.match(bs.requirementsOf(withPlatformCfApp({ optional: ["sap-hana"] })).error, /unknown optional group 'sap-hana' \(known: pipo\)/);
  assert.match(bs.requirementsOf(withPlatformCfApp({ requires: ["xsuaa"] })).error, /'requires' must be an object/);
  assert.match(bs.requirementsOf(withPlatformCfApp({ optional: "pipo" })).error, /'optional' must be an array of group names/);
  assert.equal(bs.requirementsOf(null).ok, false);
});

test("bindingsFor: the kinds consumed as a binding, never the own-role database; the optional groups' instances; names follow the resolved map", () => {
  const backend = V7.platform.cfApps[0];
  assert.deepEqual(bs.bindingsFor(backend), { required: ["figaf-faid-xsuaa", "figaf-faid-credstore"], optional: ["figaf-connectivity", "figaf-destination"] });
  assert.deepEqual(bs.bindingsFor(V7.apps[0].cfApps[0]), { required: ["figaf-faid-xsuaa"], optional: [] });
  assert.deepEqual(bs.bindingsFor({ name: "x" }), { required: [], optional: [] });
  const names = bs.resolveNames({ "figaf-db": "customer-pg" }, {}).names;
  assert.deepEqual(bs.bindingsFor(backend, names).required, ["figaf-faid-xsuaa", "figaf-faid-credstore"], "the database is never bound, also when it has another name");
  assert.equal(bs.requiresOwnRole(backend), true);
  assert.equal(bs.requiresOwnRole(V7.apps[0].cfApps[0]), false);
  assert.equal(bs.ownRoleService(bs.serviceOfKind("database")), true);
  assert.equal(bs.ownRoleService(bs.serviceOfKind("xsuaa")), false);
});

test("resolveNames: defaults for every base service; an editable one may be renamed (validated); a fixed one may not; a discovered name fills in; the override wins", () => {
  const d = bs.resolveNames({}, {});
  assert.equal(d.ok, true);
  assert.deepEqual(d.names, { "figaf-db": "figaf-db", "figaf-faid-xsuaa": "figaf-faid-xsuaa", "figaf-faid-credstore": "figaf-faid-credstore", "figaf-connectivity": "figaf-connectivity", "figaf-destination": "figaf-destination" });
  assert.equal(bs.resolveNames({ "figaf-db": " my-db " }, {}).names["figaf-db"], "my-db");
  assert.equal(bs.resolveNames({}, { "figaf-db": "found-db" }).names["figaf-db"], "found-db");
  assert.equal(bs.resolveNames({ "figaf-db": "found-db" }, { "figaf-db": "other" }).names["figaf-db"], "found-db", "the override wins over discovery");
  assert.equal(bs.resolveNames({ "figaf-db": "" }, { "figaf-db": "found-db" }).names["figaf-db"], "found-db", "an empty override is no override");
  assert.equal(bs.resolveNames({ "figaf-db": "figaf-db" }, { "figaf-db": "found-db" }).names["figaf-db"], "found-db", "typing the default is no override");
  const bad = bs.resolveNames({ "figaf-db": "a b" }, {});
  assert.equal(bad.ok, false);
  assert.match(bad.error, /figaf-db: .*not a valid service instance name/);
  const fixed = bs.resolveNames({ "figaf-faid-xsuaa": "other-xsuaa" }, {});
  assert.equal(fixed.ok, false);
  assert.match(fixed.error, /cannot be changed/);
  assert.match(bs.resolveNames({ nope: "x" }, {}).error, /unknown service nope in names/);
  assert.equal(bs.resolveNames(null, undefined).ok, true);
});

test("wantedService: a required service always, an optional one only when its group is asked for", () => {
  const db = bs.serviceOfKind("database");
  const dest = bs.serviceNamed("figaf-destination");
  assert.equal(bs.wantedService(db, undefined), true);
  assert.equal(bs.wantedService(db, ["pipo"]), true);
  assert.equal(bs.wantedService(dest, undefined), false);
  assert.equal(bs.wantedService(dest, []), false);
  assert.equal(bs.wantedService(dest, ["other"]), false);
  assert.equal(bs.wantedService(dest, ["pipo"]), true);
});
