"use strict";
// Unit tests for the Figaf Tool service-instance model
// (packages/ui/figaf-tool-services.js). The module is a browser-globals
// script; we fake `window` and load it.
// Run via `node --test packages/ui/figaf-tool-services.test.js`.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const SRC = fs.readFileSync(path.join(__dirname, "figaf-tool-services.js"), "utf8");

function load() {
  const w = {};
  new Function("window", SRC)(w);
  return { services: w.figafToolServices, tasks: w.figafToolProvisioningTasks };
}

const ROWS = [
  { name: "figaf-db", offering: "postgresql-db", plan: "free", boundApps: ["figaf-faid-backend"], operation: "create succeeded" },
  { name: "figaf-faid-xsuaa", offering: "xsuaa", plan: "application", boundApps: [], operation: "create succeeded" },
  { name: "broken-db", offering: "postgresql-db", plan: "free", boundApps: [], operation: "create failed" },
];

test("empty space: both instances will be created, the plan is asked, defaults apply", () => {
  const { services } = load();
  const r = services({}, []);
  assert.equal(r.loaded, true);
  assert.equal(r.db.name, "figaf-db");
  assert.equal(r.xsuaa.name, "figaf-xsuaa");
  assert.equal(r.db.reuse, false);
  assert.equal(r.xsuaa.reuse, false);
  assert.equal(r.askDbPlan, true);
  assert.equal(r.xsappname, "figaf-xsuaa");
  assert.deepEqual(r.errors, []);
});

test("rows not loaded yet: not loaded, nothing reused, no errors", () => {
  const { services } = load();
  const r = services({ dbServiceName: "figaf-db" }, null);
  assert.equal(r.loaded, false);
  assert.equal(r.db.reuse, false);
  assert.equal(r.askDbPlan, true);
  assert.deepEqual(r.errors, []);
});

test("the shared figaf-db exists: reused with its plan, no plan asked; a new XSUAA is created", () => {
  const { services } = load();
  const r = services({ dbServiceName: " figaf-db ", xsuaaServiceName: "" }, ROWS);
  assert.equal(r.db.exists, true);
  assert.equal(r.db.reuse, true);
  assert.equal(r.db.plan, "free");
  assert.equal(r.askDbPlan, false);
  assert.equal(r.xsuaa.exists, false);
  assert.deepEqual(r.errors, []);
});

test("a renamed XSUAA instance moves the xsappname with it", () => {
  const { services } = load();
  const r = services({ xsuaaServiceName: "figaf-tool2-xsuaa" }, ROWS);
  assert.equal(r.xsuaa.name, "figaf-tool2-xsuaa");
  assert.equal(r.xsappname, "figaf-tool2-xsuaa");
  assert.equal(r.xsuaa.reuse, false);
});

test("an existing XSUAA instance is reused", () => {
  const { services } = load();
  const r = services({ xsuaaServiceName: "figaf-faid-xsuaa" }, ROWS);
  assert.equal(r.xsuaa.reuse, true);
  assert.deepEqual(r.errors, []);
});

test("a name that exists with another offering is refused", () => {
  const { services } = load();
  const r = services({ dbServiceName: "figaf-faid-xsuaa" }, ROWS);
  assert.equal(r.db.exists, true);
  assert.equal(r.db.reuse, false);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /is a xsuaa instance, not postgresql-db/);
});

test("an instance whose last operation failed is refused", () => {
  const { services } = load();
  const r = services({ dbServiceName: "broken-db" }, ROWS);
  assert.equal(r.db.reuse, false);
  assert.match(r.errors[0], /last operation failed \(create failed\)/);
});

test("an invalid name and equal names are refused before any cf call", () => {
  const { services } = load();
  assert.match(services({ dbServiceName: "-bad name" }, []).errors[0], /not a valid service instance name/);
  const same = services({ dbServiceName: "one", xsuaaServiceName: "one" }, []);
  assert.match(same.errors[0], /cannot share the name 'one'/);
});

test("provisioning tasks: reuse rows for existing instances, create rows otherwise, PI rows when enabled", () => {
  const { tasks } = load();
  const t1 = tasks({ dbServiceName: "figaf-db", dbPlan: "free", enableConnectivity: true }, ROWS);
  assert.deepEqual(t1.map((t) => t.id), ["vars", "db", "xsuaa", "roles", "connectivity"]);
  assert.equal(t1[1].title, "Reuse PostgreSQL service (figaf-db)");
  assert.match(t1[1].sub, /plan free/);
  assert.equal(t1[2].title, "Create XSUAA service (figaf-xsuaa)");
  assert.match(t1[2].sub, /xsappname figaf-xsuaa/);
  assert.ok(t1.every((t) => t.status === "pending"));

  const t2 = tasks({ dbServiceName: "new-db", dbPlan: "standard", xsuaaServiceName: "figaf-faid-xsuaa", enableDestination: true }, ROWS);
  assert.deepEqual(t2.map((t) => t.id), ["vars", "db", "xsuaa", "roles", "destination"]);
  assert.equal(t2[1].title, "Create PostgreSQL service (new-db)");
  assert.match(t2[1].sub, /postgresql-db standard/);
  assert.equal(t2[2].title, "Reuse XSUAA service (figaf-faid-xsuaa)");
});
