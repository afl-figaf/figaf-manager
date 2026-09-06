"use strict";
// Unit tests for the "Prepare the space" runner (packages/ui/prepare-space.js).
// Browser-globals script: a fake `window` is injected, the RPC surface is a
// recorder. Run via `node --test packages/ui/prepare-space.test.js`.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const SRC = fs.readFileSync(path.join(__dirname, "prepare-space.js"), "utf8");

function load() {
  const w = {};
  new Function("window", SRC)(w);
  return w;
}

// A recording api. `over` overrides single answers.
function fakeApi(over = {}) {
  const calls = [];
  const rec = (name, value) => (...args) => { calls.push({ name, args }); return Promise.resolve(typeof value === "function" ? value(...args) : value); };
  const api = {
    xsuaa: {
      upgradeStatus: rec("xsuaa:upgradeStatus", over.upgradeStatus || { ok: true, hasApprouterApp: false, route: "figaf-manager-x.cfapps.eu10-004.hana.ondemand.com", roleCollection: "FigafL3L4-Manager-Admin" }),
      assignRoleCollection: rec("xsuaa:assignRoleCollection", over.assign || ((role, user) => ({ ok: true, role, user }))),
    },
    cf: {
      createXsuaa: rec("cf:createXsuaa", over.createXsuaa || { ok: true, instance: "figaf-l3l4-xsuaa", created: true }),
      pushManagerApprouter: rec("cf:pushManagerApprouter", over.push || { ok: true }),
      mapRoute: rec("cf:mapRoute", over.mapRoute || { ok: true }),
      restage: rec("cf:restage", over.restage || { ok: true }),
    },
    l3: {
      prepareSpaceServices: rec("l3:prepareSpaceServices", over.services || { ok: true, created: ["figaf-l3l4-db", "figaf-l3l4-credstore"], bound: ["figaf-l3l4-credstore"], pending: ["figaf-l3l4-db"] }),
    },
  };
  return { api, calls };
}

function phaseRecorder() {
  const phases = [];
  return { phases, onPhase: (id, status, sub) => phases.push({ id, status, sub }) };
}

test("phase list: assign-role is included only when the automatic assignment is on; every phase starts pending", () => {
  const w = load();
  assert.deepEqual(w.figafPrepareSpacePhases(true).map((p) => p.id), ["create-xsuaa", "assign-role", "services", "push-approuter", "map-route", "restage"]);
  assert.deepEqual(w.figafPrepareSpacePhases(false).map((p) => p.id), ["create-xsuaa", "services", "push-approuter", "map-route", "restage"]);
  assert.ok(w.figafPrepareSpacePhases(true).every((p) => p.status === "pending" && p.label && p.sub));
  assert.match(w.figafPrepareSpacePhases(true).find((p) => p.id === "services").sub, /plans you picked/);
});

test("route split: host and domain; the -internal suffix is stripped; garbage is null", () => {
  const w = load();
  assert.deepEqual(w.figafSplitRoute("figaf-manager-ab.cfapps.eu10-004.hana.ondemand.com"), { hostname: "figaf-manager-ab", domain: "cfapps.eu10-004.hana.ondemand.com" });
  assert.deepEqual(w.figafSplitRoute("figaf-manager-ab-internal.cfapps.eu10.hana.ondemand.com"), { hostname: "figaf-manager-ab", domain: "cfapps.eu10.hana.ondemand.com" });
  assert.equal(w.figafSplitRoute(""), null);
  assert.equal(w.figafSplitRoute(null), null);
  assert.equal(w.figafSplitRoute("nodot"), null);
});

test("happy path with assignment: the six phases run in order, the chosen plans reach the services handler, the restage binds and unmaps", async () => {
  const w = load();
  const { api, calls } = fakeApi();
  const { phases, onPhase } = phaseRecorder();
  const r = await w.figafRunPrepareSpace({ api, plans: { "figaf-l3l4-db": "standard", "figaf-l3l4-credstore": "free" }, autoAssign: true, assignTo: "me@example.com", onPhase });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.restaging, true);
  assert.equal(r.assignSkipped, false);
  assert.equal(r.assignedTo, "me@example.com");
  assert.equal(r.assignFailed, null);
  assert.equal(r.servicesWarning, null);
  assert.deepEqual(r.services.pending, ["figaf-l3l4-db"]);
  assert.deepEqual(calls.map((c) => c.name), [
    "xsuaa:upgradeStatus", "cf:createXsuaa", "xsuaa:assignRoleCollection", "l3:prepareSpaceServices",
    "cf:pushManagerApprouter", "cf:mapRoute", "cf:restage",
  ]);
  assert.deepEqual(calls.find((c) => c.name === "l3:prepareSpaceServices").args[0], { plans: { "figaf-l3l4-db": "standard", "figaf-l3l4-credstore": "free" }, groups: [] });
  assert.deepEqual(calls.find((c) => c.name === "xsuaa:assignRoleCollection").args, ["FigafL3L4-Manager-Admin", "me@example.com"]);
  assert.deepEqual(calls.find((c) => c.name === "cf:mapRoute").args[0], { app: "figaf-manager-approuter", domain: "cfapps.eu10-004.hana.ondemand.com", hostname: "figaf-manager-x" });
  assert.deepEqual(calls.find((c) => c.name === "cf:restage").args[0], { app: "figaf-manager", bindXsuaa: true, skipIfBound: true, unmapRoute: { domain: "cfapps.eu10-004.hana.ondemand.com", hostname: "figaf-manager-x" } });
  // Every phase ended "done"; the services phase names what was created, bound and left creating.
  const last = {};
  for (const p of phases) last[p.id] = p;
  assert.deepEqual(Object.keys(last).sort(), ["assign-role", "create-xsuaa", "map-route", "push-approuter", "restage", "services"]);
  assert.ok(Object.values(last).every((p) => p.status === "done"), JSON.stringify(last));
  assert.match(last["services"].sub, /created figaf-l3l4-db, figaf-l3l4-credstore/);
  assert.match(last["services"].sub, /bound to the manager: figaf-l3l4-credstore/);
  assert.match(last["services"].sub, /still being created: figaf-l3l4-db/);
  // The auth-kick suppression is set before the restage.
  assert.equal(load().figafSuppressAuthKick, undefined);
});

test("without assignment: no btp call, assignSkipped; an already deployed approuter is not pushed again", async () => {
  const w = load();
  const { api, calls } = fakeApi({ upgradeStatus: { ok: true, hasApprouterApp: true, route: "m-internal.cfapps.x.hana.ondemand.com" } });
  const { phases, onPhase } = phaseRecorder();
  const r = await w.figafRunPrepareSpace({ api, plans: {}, autoAssign: false, assignTo: "", onPhase });
  assert.equal(r.ok, true);
  assert.equal(r.assignSkipped, true);
  assert.ok(!calls.some((c) => c.name === "xsuaa:assignRoleCollection"));
  assert.ok(!calls.some((c) => c.name === "cf:pushManagerApprouter"));
  assert.equal(phases.find((p) => p.id === "push-approuter").sub, "approuter already deployed");
  assert.equal(calls.find((c) => c.name === "cf:mapRoute").args[0].hostname, "m");
});

test("a failed role assignment and a failed services step are NON-fatal: the run reaches the restage and reports both", async () => {
  const w = load();
  const { api } = fakeApi({
    assign: { ok: false, error: "btp: not logged in" },
    services: { ok: false, error: "figaf-l3l4-credstore: Service plan free: only one instance allowed per subaccount" },
  });
  const { phases, onPhase } = phaseRecorder();
  const r = await w.figafRunPrepareSpace({ api, plans: {}, autoAssign: true, assignTo: "me@example.com", onPhase });
  assert.equal(r.ok, true);
  assert.equal(r.assignFailed, "btp: not logged in");
  assert.match(r.servicesWarning, /only one instance allowed/);
  assert.equal(phases.find((p) => p.id === "assign-role" && p.status === "error").sub, "btp: not logged in");
  assert.equal(phases.filter((p) => p.id === "restage").pop().status, "done");
});

test("a failed XSUAA preparation stops the run before anything else; a failed restage is reported with its phase", async () => {
  const w = load();
  const a = fakeApi({ createXsuaa: { ok: false, error: "no cfapps.* domain in this landscape" } });
  const r = await w.figafRunPrepareSpace({ api: a.api, plans: {}, autoAssign: false, onPhase: () => {} });
  assert.equal(r.ok, false);
  assert.equal(r.phase, "create-xsuaa");
  assert.match(r.error, /no cfapps/);
  assert.deepEqual(a.calls.map((c) => c.name), ["xsuaa:upgradeStatus", "cf:createXsuaa"]);

  const b = fakeApi({ restage: { ok: false, error: "bind-service failed: quota" } });
  const r2 = await w.figafRunPrepareSpace({ api: b.api, plans: {}, autoAssign: false, onPhase: () => {} });
  assert.equal(r2.ok, false);
  assert.equal(r2.phase, "restage");
  assert.match(r2.error, /quota/);
});

test("no usable route: the run stops at map-route with a clear message, nothing is mapped or restaged", async () => {
  const w = load();
  const { api, calls } = fakeApi({ upgradeStatus: { ok: true, hasApprouterApp: false, route: null } });
  const r = await w.figafRunPrepareSpace({ api, plans: {}, autoAssign: false, onPhase: () => {} });
  assert.equal(r.ok, false);
  assert.equal(r.phase, "map-route");
  assert.match(r.error, /public route/);
  assert.ok(!calls.some((c) => c.name === "cf:mapRoute" || c.name === "cf:restage"));
});

test("already bound manager: the result says so (no pointless wait for a mode flip)", async () => {
  const w = load();
  const { api } = fakeApi({ restage: { ok: true, alreadyBound: true } });
  const r = await w.figafRunPrepareSpace({ api, plans: {}, autoAssign: false, onPhase: () => {} });
  assert.equal(r.ok, true);
  assert.equal(r.alreadyBound, true);
});

// Optional service groups (catalog v4, decision 0011): the person ticks
// "on-premise PI/PO" in step 1 and the group travels to the handler. Without
// the tick nothing optional is created - the `groups: []` assertion above.
test("prepare-space: the chosen optional service groups reach l3:prepareSpaceServices", async () => {
  const w = load();
  const { api, calls } = fakeApi();
  const r = await w.figafRunPrepareSpace({
    api, plans: {}, groups: ["pipo"], autoAssign: false, assignTo: "", onPhase: () => {},
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  const call = calls.find((c) => c.name === "l3:prepareSpaceServices");
  assert.deepEqual(call.args[0].groups, ["pipo"]);
});
