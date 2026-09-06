// Step model of the Setup page (#/setup) in the hosted console.
// Pure logic, browser-globals like mode.js: screen-setup-page.jsx and
// console.jsx render the result, setup-checklist.test.js runs it under
// node:test. No React, no I/O.
//
// Input `data` = the four results the console fetches:
//   services: l3:services            -> { ok, services: [{ name, status, bindToManager, boundToManager }] }
//   stored:   login:storedUserStatus -> { available, bindingPresent }
//   l3:       l3:status              -> { ok, platform: { status } }
//   figaf:    connections:figafStatus-> { configured }
// plus `ssoDone` (window.figafXsuaaMode). Every value may be missing.
//
// Order (docs/l3-console/SPEC.md section 6, 2026-09-03):
//   1 Prepare the space   creates the instances (plans asked here), turns on
//                         SAP IAS sign-in, restarts the manager once; the
//                         database is started here and finishes later
//   2 Management user     stored right after the IAS sign-in, on this page
//   3 Base services       status of the instances (the database finishing),
//                         repair actions when something is missing
//   4 Shared backend and first app   Install on L3 Applications
//   5 Figaf tool connection          Connections
// Everything after step 1 is blocked until step 1 is done: one token, one
// passcode, one restart.
//
// Output: { steps, done, total, complete, current }. Each step:
//   { id, n, title, why, when, done, blocked, current, cta }
//   blocked  = "" or the reason ("after step 1")
//   current  = first step that is neither done nor blocked
//   cta      = label of the step's button on the Setup page (null = none)

(function () {
  "use strict";

  function figafSetupSteps(data, opts) {
    data = data || {};
    var ssoDone = !!(opts && opts.ssoDone);
    var stored = data.stored || null;
    var bindingActive = !!(stored && stored.bindingPresent);
    var storedDone = !!(stored && stored.available);
    var figafDone = !!(data.figaf && data.figaf.configured);
    var platform = data.l3 && data.l3.ok ? data.l3.platform : null;
    var platformDone = !!(platform && platform.status === "running");

    // Optional instances (catalog v4: connectivity / destination for on-premise
    // PI/PO) are left out of the step state on purpose: an installation without
    // a PI system is complete, so a missing optional instance must never keep
    // step 3 open or block step 4. The Base services panel still lists them.
    var allSvc = data.services && data.services.ok ? (data.services.services || []) : null;
    var svc = allSvc ? allSvc.filter(function (s) { return !s.optional; }) : null;
    var hasServices = !!(svc && svc.length > 0);
    var allReady = hasServices && svc.every(function (s) { return s.status === "ready"; });
    var notReady = hasServices ? svc.filter(function (s) { return s.status !== "ready"; }) : [];
    var creating = notReady.filter(function (s) { return s.status === "in-progress"; });
    var missing = notReady.filter(function (s) { return s.status !== "in-progress"; });
    var credstore = hasServices ? svc.filter(function (s) { return s.bindToManager; })[0] || null : null;
    var credBound = !!(credstore && credstore.boundToManager === true);
    var names = function (list) { return list.map(function (s) { return s.name; }).join(", "); };

    var afterPrepare = ssoDone ? "" : "after step 1";
    var steps = [];

    steps.push({
      id: "prepare",
      n: 1,
      title: "Prepare the space",
      why: "Creates the service instances this release needs (database, roles, Credential Store), " +
        "turns on SAP IAS sign-in through an approuter, and restarts the manager once.",
      when: "Needs your Cloud Foundry sign-in (one-time passcode). About 4 minutes; the manager is " +
        "offline for 30-90 s at the end. The database keeps being created in the background.",
      done: ssoDone,
      blocked: "",
      cta: "Prepare the space",
    });

    steps.push({
      id: "mgmt-user",
      n: 2,
      title: "Management user",
      why: "A technical Cloud Foundry user, stored in the Credential Store. The manager signs in by " +
        "itself after every restart, so nobody needs a passcode again.",
      when: "Enter the user and its password below. The manager verifies them against Cloud Foundry before storing.",
      done: storedDone,
      blocked: storedDone ? "" : (!ssoDone ? afterPrepare : (bindingActive ? "" : "Credential Store binding not active")),
      cta: null,
    });

    var servicesStepN = 0;
    if (hasServices) {
      servicesStepN = steps.length + 1;
      var servicesDone = allReady && (!credstore || (credBound && bindingActive));
      var when = "";
      if (missing.length) {
        when = missing.length + " of " + svc.length + " instance" + (missing.length === 1 ? "" : "s") +
          " missing or failed (" + names(missing) + "). Pick the plan and create " + (missing.length === 1 ? "it" : "them") + " below.";
      } else if (creating.length) {
        when = "Still being created: " + names(creating) + " (started in step 1, a few minutes). This page refreshes by itself.";
      } else if (credstore && !credBound) {
        when = "Instances ready. The Credential Store is not bound to the manager: click \"Bind to manager\" below, then restart.";
      } else if (credstore && !bindingActive) {
        when = "Bound. Restart the manager (below) to activate the binding.";
      }
      steps.push({
        id: "services",
        n: servicesStepN,
        title: "Base services",
        why: "The service instances of this release, created in step 1. The database takes a few minutes.",
        when: when,
        done: servicesDone,
        blocked: servicesDone ? "" : afterPrepare,
        cta: null,
      });
    }

    steps.push({
      id: "platform",
      n: steps.length + 1,
      title: "Shared backend and first app",
      why: "Install the first app on L3 Applications. The shared backend connector every app uses is " +
        "deployed with it, automatically.",
      when: hasServices ? "Waits until every base service is ready." : "",
      done: platformDone,
      blocked: platformDone ? "" : (!ssoDone ? afterPrepare : (hasServices && !allReady ? "after step " + servicesStepN : "")),
      cta: "Open L3 Applications",
    });

    steps.push({
      id: "figaf-connection",
      n: steps.length + 1,
      title: "Figaf tool connection",
      why: "URL and API client of your Figaf tool, stored in the Credential Store. Apps read the system " +
        "list through the shared backend; no secret is typed into an app.",
      when: "",
      done: figafDone,
      blocked: figafDone ? "" : (!ssoDone ? afterPrepare : (bindingActive ? "" : "Credential Store binding not active")),
      cta: "Open Connections",
    });

    var currentSet = false;
    var current = null;
    for (var i = 0; i < steps.length; i++) {
      var st = steps[i];
      st.current = !currentSet && !st.done && !st.blocked;
      if (st.current) { currentSet = true; current = st; }
    }

    var doneCount = steps.filter(function (s) { return s.done; }).length;
    return { steps: steps, done: doneCount, total: steps.length, complete: doneCount === steps.length, current: current };
  }

  if (typeof window !== "undefined") window.figafSetupSteps = figafSetupSteps;
})();
