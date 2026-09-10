// Step model of the Setup page (#/setup) in the hosted console.
// Pure logic, browser-globals like mode.js: screen-setup-page.jsx and
// console.jsx render the result, setup-checklist.test.js runs it under
// node:test. No React, no I/O.
//
// Input `data` = the four results the console fetches:
//   services: faid:services            -> { ok, services: [{ name, status, bindToManager, boundToManager,
//                                          optional, backendDeployed, boundToBackend }] }
//   stored:   login:storedUserStatus -> { available, bindingPresent }
//   faid:     faid:status              -> { ok, platform: { status } }
//   figaf:    connections:figafStatus-> { configured }
// plus `ssoDone` (window.figafXsuaaMode). Every value may be missing.
//
// Order (docs/faid-apps-console/SPEC.md section 6, 2026-09-03):
//   1 Prepare the space   creates the instances (plans asked here), turns on
//                         SAP IAS sign-in, restarts the manager once; the
//                         database is started here and finishes later
//   2 Management user     stored right after the IAS sign-in, on this page
//   3 Base services       status of the instances (the database finishing),
//                         repair actions when something is missing
//   4 Shared backend and first app   Install on FAID Apps
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
    // Decision 0016: a stored client that lacks an authority the release needs
    // is not done - Install and Update would refuse it.
    var figafMissing = (data.figaf && data.figaf.missingScopes) || [];
    var figafDone = !!(data.figaf && data.figaf.configured) && figafMissing.length === 0;
    var platform = data.faid && data.faid.ok ? data.faid.platform : null;
    var platformDone = !!(platform && platform.status === "running");

    // Optional instances (catalog v4: connectivity / destination for on-premise
    // PI/PO) are left out of the step state on purpose: an installation without
    // a PI system is complete, so a missing optional instance must never keep
    // step 3 open or block step 4. The Base services panel still lists them.
    // faid:services failed (the release could not be read - for example a
    // catalog older than v7, or the store unreachable): the instances cannot
    // be listed, so step 3 cannot be computed. Say so on step 1 instead of
    // showing a shorter list without a word (seen 2026-09-08 with store 0.6.1).
    var servicesError = data.services && data.services.ok === false
      ? String(data.services.error || "the release could not be read") : "";
    var allSvc = data.services && data.services.ok ? (data.services.services || []) : null;
    var svc = allSvc ? allSvc.filter(function (s) { return !s.optional; }) : null;
    var hasServices = !!(svc && svc.length > 0);
    var allReady = hasServices && svc.every(function (s) { return s.status === "ready"; });
    var notReady = hasServices ? svc.filter(function (s) { return s.status !== "ready"; }) : [];
    var creating = notReady.filter(function (s) { return s.status === "in-progress"; });
    var missing = notReady.filter(function (s) { return s.status !== "in-progress"; });
    var credstore = hasServices ? svc.filter(function (s) { return s.bindToManager; })[0] || null : null;
    var credBound = !!(credstore && credstore.boundToManager === true);
    // Catalog v6: the backend's database is reached with its own role; the
    // Credential Store entry must be prepared (Base services, "Prepare
    // database access") before the platform can be installed.
    var dbNotPrepared = hasServices ? svc.filter(function (s) {
      return s.access === "own-role" && !(s.databaseAccess && s.databaseAccess.prepared);
    }) : [];
    var dbReady = dbNotPrepared.length === 0;
    var names = function (list) { return list.map(function (s) { return s.name; }).join(", "); };

    var afterPrepare = ssoDone ? "" : "after step 1";
    var steps = [];

    steps.push({
      id: "prepare",
      n: 1,
      title: "Prepare the space",
      why: "Creates the service instances the Figaf Platform needs (database, roles, Credential Store), " +
        "turns on SAP IAS sign-in through an approuter, and restarts the manager once.",
      when: servicesError
        ? "The release could not be read, so the service instances cannot be listed or created: " + servicesError +
          " Point the manager at a release it can read (release store or local directory), then reload this page."
        : "Needs your Cloud Foundry sign-in (one-time passcode). About 4 minutes; the manager is " +
          "offline for 30-90 s at the end. The database keeps being created in the background.",
      done: ssoDone,
      blocked: "",
      cta: "Prepare the space",
      error: servicesError || "",
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
      var servicesDone = allReady && dbReady && (!credstore || (credBound && bindingActive));
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
      } else if (!dbReady) {
        var dbInst = dbNotPrepared[0].instanceName || dbNotPrepared[0].name;
        var dbState = (dbNotPrepared[0].databaseAccess && dbNotPrepared[0].databaseAccess.state) || "not-prepared";
        when = dbState === "stale"
          ? "The database access entry is stale (" + ((dbNotPrepared[0].databaseAccess && dbNotPrepared[0].databaseAccess.reason) || "instance changed") + "). Click \"Prepare database access\" for " + dbInst + " below."
          : "Instances ready. The database access is not prepared: click \"Prepare database access\" for " + dbInst + " below (role faid_app, schema faid, Credential Store entry).";
      }
      steps.push({
        id: "services",
        n: servicesStepN,
        title: "Base services",
        why: "The service instances of the Figaf Platform, created in step 1. The database takes a few minutes; then its access for the FAID backend is prepared here (own role, schema faid).",
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
      why: "Install the first app on FAID Apps. The shared backend connector every app uses is " +
        "deployed with it, automatically.",
      when: hasServices ? "Waits until every base service is ready and the database access is prepared." : "",
      done: platformDone,
      blocked: platformDone ? "" : (!ssoDone ? afterPrepare : (hasServices && (!allReady || !dbReady) ? "after step " + servicesStepN : "")),
      cta: "Open FAID Apps",
    });

    steps.push({
      id: "figaf-connection",
      n: steps.length + 1,
      title: "Figaf tool connection",
      why: "URL and API client of your Figaf tool, stored in the Credential Store. Apps read the system " +
        "list through the shared backend; no secret is typed into an app.",
      when: figafMissing.length
        ? "The stored API client lacks the authorities " + figafMissing.join(", ") + " that this release needs. " +
          "Add them in the Figaf tool (Settings > API clients), then Replace connection."
        : "",
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
