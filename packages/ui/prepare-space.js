// "Prepare the space" - Setup step 1 of the hosted console (docs/faid-apps-console/SPEC.md
// 5.2). The whole run as ONE sequence over the window.figaf RPC surface, so
// the screen (screen-setup-page.jsx) only renders phases and the result.
// Pure logic, browser-globals like setup-checklist.js; prepare-space.test.js
// runs it under node:test with a fake api. No React, no DOM.
//
// Sequence (every phase is reported through onPhase(id, status, sub)):
//   create-xsuaa     cf:createXsuaa            create or update figaf-faid-xsuaa (always)
//   assign-role      xsuaa:assignRoleCollection  optional; non-fatal
//   services         faid:prepareSpaceServices     base services with the chosen plans;
//                                                Credential Store awaited + bound, database
//                                                started only; non-fatal. `groups`
//                                                adds OPTIONAL service groups the
//                                                person ticked (today: "pipo" =
//                                                connectivity + destination for
//                                                on-premise PI/PO, decision 0011).
//   push-approuter   cf:pushManagerApprouter     skipped when already deployed
//   map-route        cf:mapRoute                 approuter takes the public hostname
//   restage          cf:restage                  bind manager to XSUAA, unmap, restage once
//
// Input:  { api, plans, names, groups, autoAssign, assignTo, onPhase }
//         `names` = { catalogName: instanceName } for services with an editable
//         name (catalog v6: the database); empty = the catalog default.
// Output: { ok:true, restaging, alreadyBound, roleName, assignFailed, assignSkipped,
//           assignedTo, servicesWarning, services }        - the manager is restaging
//         { ok:false, phase, error }                        - stopped at `phase`

(function () {
  "use strict";

  var PHASES = [
    { id: "create-xsuaa",   label: "Prepare the XSUAA instance",   sub: "cf create-service / update-service xsuaa application figaf-faid-xsuaa - roles of the manager and the apps" },
    { id: "assign-role",    label: "Assign role collection",       sub: "btp assign security/role-collection (optional)" },
    { id: "services",       label: "Create the base services",     sub: "cf create-service with the plans you picked; Credential Store bound to the manager; the database keeps creating in the background" },
    { id: "push-approuter", label: "Deploy approuter",             sub: "cf push figaf-manager-approuter (bundled in the manager)" },
    { id: "map-route",      label: "Hand off public route",        sub: "the approuter takes over the public URL" },
    { id: "restage",        label: "Restart manager",              sub: "the manager binds to XSUAA and restarts once - 30-90 s offline" },
  ];
  var DEFAULT_ROLE = "FAID-Manager-Admin";

  function figafPrepareSpacePhases(includeAssign) {
    return PHASES.filter(function (p) { return p.id !== "assign-role" || includeAssign; })
      .map(function (p) { return { id: p.id, label: p.label, sub: p.sub, status: "pending" }; });
  }

  // "<host>.<domain>" -> { hostname, domain }; a "-internal" suffix (the
  // manager already behind an approuter) is stripped. Null when unusable.
  function figafSplitRoute(route) {
    var s = String(route || "");
    var dot = s.indexOf(".");
    if (dot <= 0) return null;
    var host = s.slice(0, dot);
    if (/-internal$/.test(host)) host = host.slice(0, -"-internal".length);
    return { hostname: host, domain: s.slice(dot + 1) };
  }

  async function figafRunPrepareSpace(input) {
    var api = input.api;
    var onPhase = typeof input.onPhase === "function" ? input.onPhase : function () {};
    var plans = input.plans || {};
    var names = input.names && typeof input.names === "object" ? input.names : {};
    var groups = Array.isArray(input.groups) ? input.groups : [];
    var autoAssign = !!input.autoAssign;
    var assignTo = String(input.assignTo || "").trim();
    var mark = function (id, status, sub) { onPhase(id, status, sub); };

    var pre = null;
    try { pre = await api.xsuaa.upgradeStatus(); } catch (e) { pre = null; }
    var roleName = (pre && pre.roleCollection) || DEFAULT_ROLE;

    // 1. XSUAA - always: create when missing, update when present.
    mark("create-xsuaa", "running");
    var r1 = await api.cf.createXsuaa();
    if (!r1 || !r1.ok) {
      var e1 = (r1 && r1.error) || "failed";
      mark("create-xsuaa", "error", e1);
      return { ok: false, phase: "create-xsuaa", error: "prepare XSUAA: " + e1 };
    }
    var inst = r1.instance || "figaf-faid-xsuaa";
    mark("create-xsuaa", "done", r1.legacy ? "legacy instance already bound - nothing to create"
      : r1.updated ? inst + " updated with the current roles" : inst + " created");

    // 2. Role assignment - optional, non-fatal. Runs right after the instance
    // exists so the collection is assigned BEFORE the approuter enforces XSUAA.
    var assignFailed = null;
    var assignedTo = null;
    if (autoAssign) {
      mark("assign-role", "running", "btp assign " + roleName + " --to-user " + assignTo);
      var ar = await api.xsuaa.assignRoleCollection(roleName, assignTo);
      if (!ar || ar.ok === false) {
        assignFailed = (ar && ar.error) || "unknown";
        mark("assign-role", "error", assignFailed);
      } else {
        assignedTo = ar.user || assignTo;
        var via = ar.subaccountSource === "xsuaa-service-key" ? " (subaccount taken from the XSUAA service key)" : "";
        mark("assign-role", "done", "assigned " + ar.role + " to " + assignedTo + via);
      }
    }

    // 3. Base services with the chosen plans - non-fatal: SSO does not need
    // them; on a failure the result says what to repair in Setup step 3.
    var servicesWarning = null;
    var services = null;
    mark("services", "running");
    try {
      services = api.faid && api.faid.prepareSpaceServices
        ? await api.faid.prepareSpaceServices({ plans: plans, names: names, groups: groups })
        : { ok: true, created: [], bound: [], pending: [], note: "not available in this build" };
    } catch (e) {
      services = { ok: false, error: (e && e.message) || "prepareSpaceServices failed" };
    }
    if (!services || services.ok === false) {
      servicesWarning = (services && services.error) || "unknown error";
      mark("services", "error", servicesWarning);
    } else {
      var parts = [];
      if (services.created && services.created.length) parts.push("created " + services.created.join(", "));
      if (services.bound && services.bound.length) parts.push("bound to the manager: " + services.bound.join(", ") + " (active after the restart)");
      if (services.pending && services.pending.length) parts.push("still being created: " + services.pending.join(", "));
      mark("services", "done", parts.length ? parts.join("; ") : (services.note || "nothing to do"));
    }

    // 4. Approuter.
    if (!pre || !pre.hasApprouterApp) {
      mark("push-approuter", "running");
      var r2 = await api.cf.pushManagerApprouter();
      if (!r2 || !r2.ok) {
        var e2 = (r2 && r2.error) || "failed";
        mark("push-approuter", "error", e2);
        return { ok: false, phase: "push-approuter", error: "pushManagerApprouter: " + e2 };
      }
      mark("push-approuter", "done");
    } else {
      mark("push-approuter", "done", "approuter already deployed");
    }

    // 5. Route hand-off.
    var split = figafSplitRoute(pre && pre.route);
    if (!split) {
      mark("map-route", "error", "route unknown");
      return { ok: false, phase: "map-route", error: "Could not determine the manager's public route. Inspect cf app figaf-manager in the cockpit." };
    }
    mark("map-route", "running");
    var m1 = await api.cf.mapRoute({ app: "figaf-manager-approuter", domain: split.domain, hostname: split.hostname });
    if (!m1 || !m1.ok) {
      mark("map-route", "error");
      return { ok: false, phase: "map-route", error: "mapRoute: " + ((m1 && (m1.stderr || m1.error)) || "failed") };
    }
    mark("map-route", "done", "approuter now serves the public route");

    // 6. Bind + unmap + restage in ONE call (the answer flows back over the
    // open connection even after the manager left the public route). The
    // auth-kick is suppressed BEFORE the call: the dyno may start dying while
    // the response is in flight.
    if (typeof window !== "undefined") window.figafSuppressAuthKick = true;
    mark("restage", "running", "the manager will be offline for 30-90 s");
    var r3 = await api.cf.restage({
      app: "figaf-manager",
      bindXsuaa: true,
      skipIfBound: true,
      unmapRoute: { domain: split.domain, hostname: split.hostname },
    });
    if (!r3 || r3.ok === false) {
      var e3 = (r3 && r3.error) || "failed";
      mark("restage", "error", e3);
      return { ok: false, phase: "restage", error: "restage: " + e3 };
    }
    mark("restage", "done", r3.alreadyBound ? "manager already in XSUAA mode" : "restart started");

    return {
      ok: true,
      restaging: true,
      alreadyBound: !!r3.alreadyBound,
      roleName: roleName,
      assignFailed: assignFailed,
      assignSkipped: !autoAssign,
      assignedTo: assignedTo,
      servicesWarning: servicesWarning,
      services: services,
    };
  }

  if (typeof window !== "undefined") {
    window.figafPrepareSpacePhases = figafPrepareSpacePhases;
    window.figafSplitRoute = figafSplitRoute;
    window.figafRunPrepareSpace = figafRunPrepareSpace;
  }
})();
