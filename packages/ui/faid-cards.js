// The FAID Apps page (screen-faid-apps.jsx): how the app cards are grouped,
// counted and selected. Pure logic, browser-globals like setup-checklist.js:
// the screen renders the result, faid-cards.test.js runs it under node:test.
// No React, no I/O.
//
// Input:
//   apps      the apps of the installation's release (faid:catalog `apps`)
//   statuses  { [appId]: faid:status row }; `status` is one of
//             not-installed | running | installing | stopped | partial | mixed
//   pending   faid:catalog `pendingApps` (apps that only a newer release has)
//   loaded    true once faid:status answered at least once
//
// Sections (the layout of the App Manager in figaf-layer3: groups with a
// count, a grid of cards in each): "Installed" holds every app that has CF
// apps in the space (running, stopped, installing, partial, mixed), "Not
// installed" the rest, "New in V" the pending apps. Before the first status
// answer, every app is in one section without a title, so nothing jumps from
// "Not installed" to "Installed" when the status arrives. Catalog order
// inside a section.

(function () {
  "use strict";

  var INSTALLED = { running: true, installing: true, stopped: true, partial: true, mixed: true };

  function statusOf(statuses, app) {
    var row = statuses && statuses[app.id];
    return row && row.status ? row.status : null;
  }

  function isInstalled(status) {
    return !!(status && INSTALLED[status]);
  }

  function figafFaidSections(apps, statuses, pending, loaded) {
    apps = apps || [];
    pending = pending || [];
    var sections = [];
    if (!loaded) {
      if (apps.length) sections.push({ id: "all", title: null, apps: apps });
    } else {
      var installed = apps.filter(function (a) { return isInstalled(statusOf(statuses, a)); });
      var available = apps.filter(function (a) { return !isInstalled(statusOf(statuses, a)); });
      if (installed.length) sections.push({ id: "installed", title: "Installed", apps: installed });
      if (available.length) sections.push({ id: "available", title: "Not installed", apps: available });
    }
    if (pending.length) {
      sections.push({ id: "pending", title: "New in " + pending[0].version + ", available after the update", apps: pending });
    }
    return sections;
  }

  // The numbers of the stats strip. `installing` is shown apart: it is
  // neither running nor stopped for good.
  function figafFaidCounts(apps, statuses) {
    var c = { total: 0, running: 0, stopped: 0, notInstalled: 0, installing: 0, other: 0 };
    (apps || []).forEach(function (a) {
      c.total++;
      var s = statusOf(statuses, a);
      if (s === "running") c.running++;
      else if (s === "stopped") c.stopped++;
      else if (s === "installing") c.installing++;
      else if (s === "not-installed" || s === null) c.notInstalled++;
      else c.other++; // partial, mixed: some CF apps up, some down
    });
    return c;
  }

  // Which of the selected apps "Disable selected" stops and "Enable selected"
  // starts. Only a running app can be stopped and only a stopped one started;
  // the others in the selection are left alone (and the bar says so).
  // Selected ids that are not on the page any more are dropped.
  function figafFaidSelection(selectedIds, apps, statuses) {
    var known = {};
    (apps || []).forEach(function (a) { known[a.id] = true; });
    var out = { selected: [], toDisable: [], toEnable: [], unchanged: [] };
    (selectedIds || []).forEach(function (id) {
      if (!known[id]) return;
      out.selected.push(id);
      var s = statuses && statuses[id] ? statuses[id].status : null;
      if (s === "running") out.toDisable.push(id);
      else if (s === "stopped") out.toEnable.push(id);
      else out.unchanged.push(id);
    });
    return out;
  }

  // The ids a "Select all" in the Installed section selects: every app that
  // can be stopped or started right now.
  function figafFaidSelectable(apps, statuses) {
    return (apps || []).filter(function (a) {
      var s = statusOf(statuses, a);
      return s === "running" || s === "stopped";
    }).map(function (a) { return a.id; });
  }

  // Two letters for the card icon: the initials of the first two words of
  // the name ("B2B Archiving Setup" gives "BA"), or the first two letters.
  function figafFaidInitials(name) {
    var words = String(name || "").trim().split(/\s+/).filter(Boolean);
    if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
    return String(words[0] || "?").slice(0, 2).toUpperCase();
  }

  var api = {
    figafFaidSections: figafFaidSections,
    figafFaidCounts: figafFaidCounts,
    figafFaidSelection: figafFaidSelection,
    figafFaidSelectable: figafFaidSelectable,
    figafFaidInitials: figafFaidInitials,
  };
  if (typeof window !== "undefined") Object.assign(window, api);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
