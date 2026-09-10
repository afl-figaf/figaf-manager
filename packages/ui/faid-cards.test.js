"use strict";
// Unit tests for the card grouping of the FAID Apps page (packages/ui/faid-cards.js).
// Run via `node --test packages/ui/faid-cards.test.js`.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  figafFaidSections, figafFaidCounts, figafFaidSelection, figafFaidSelectable, figafFaidInitials,
} = require("./faid-cards");

const apps = [
  { id: "a", name: "B2B Archiving Setup" },
  { id: "b", name: "Functional Profiles Maintain" },
  { id: "c", name: "Connection Check" },
  { id: "d", name: "Partner Assignment" },
];
const statuses = {
  a: { status: "running" },
  b: { status: "stopped" },
  c: { status: "not-installed" },
  // d: no status row yet (a fresh release added it): not installed
};
const pending = [{ id: "p", name: "Scenario Assignment", version: "0.9.0" }];

test("sections: installed apps first, then not installed, then the pending apps of the newer release; catalog order inside", () => {
  const s = figafFaidSections(apps, statuses, pending, true);
  assert.deepEqual(s.map((x) => [x.id, x.title, x.apps.map((a) => a.id)]), [
    ["installed", "Installed", ["a", "b"]],
    ["available", "Not installed", ["c", "d"]],
    ["pending", "New in 0.9.0, available after the update", ["p"]],
  ]);
});

test("sections: before the first status answer every app is in one untitled section, so cards do not jump", () => {
  const s = figafFaidSections(apps, {}, [], false);
  assert.deepEqual(s.map((x) => [x.id, x.title, x.apps.length]), [["all", null, 4]]);
  // Empty sections are left out.
  const only = figafFaidSections([apps[0]], statuses, [], true);
  assert.deepEqual(only.map((x) => x.id), ["installed"]);
  assert.deepEqual(figafFaidSections([], {}, [], true), []);
});

test("sections: installing, partial and mixed count as installed (CF apps exist in the space)", () => {
  const st = { a: { status: "installing" }, b: { status: "partial" }, c: { status: "mixed" } };
  const s = figafFaidSections(apps, st, [], true);
  assert.deepEqual(s[0].apps.map((a) => a.id), ["a", "b", "c"]);
  assert.deepEqual(s[1].apps.map((a) => a.id), ["d"]);
});

test("counts: the stats strip numbers", () => {
  assert.deepEqual(figafFaidCounts(apps, statuses), { total: 4, running: 1, stopped: 1, notInstalled: 2, installing: 0, other: 0 });
  assert.deepEqual(figafFaidCounts(apps, { a: { status: "installing" }, b: { status: "mixed" } }),
    { total: 4, running: 0, stopped: 0, notInstalled: 2, installing: 1, other: 1 });
  assert.deepEqual(figafFaidCounts([], {}), { total: 0, running: 0, stopped: 0, notInstalled: 0, installing: 0, other: 0 });
});

test("selection: running apps go to Disable, stopped ones to Enable, others are left alone; unknown ids are dropped", () => {
  const sel = figafFaidSelection(["a", "b", "c", "gone"], apps, statuses);
  assert.deepEqual(sel, { selected: ["a", "b", "c"], toDisable: ["a"], toEnable: ["b"], unchanged: ["c"] });
  assert.deepEqual(figafFaidSelection([], apps, statuses).selected, []);
});

test("selectable: Select all takes every app that can be stopped or started now", () => {
  assert.deepEqual(figafFaidSelectable(apps, statuses), ["a", "b"]);
  assert.deepEqual(figafFaidSelectable(apps, { a: { status: "installing" } }), []);
});

test("initials for the card icon", () => {
  assert.equal(figafFaidInitials("B2B Archiving Setup"), "BA");
  assert.equal(figafFaidInitials("Validator"), "VA");
  assert.equal(figafFaidInitials(""), "?");
});
