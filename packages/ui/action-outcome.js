// Action outcome for the hosted console: what the operator sees when an
// action FAILS. Pure logic, browser-globals like setup-checklist.js:
// screen-l3-apps.jsx renders the result, action-outcome.test.js runs it
// under node:test. No React, no I/O.
//
// Why: on 2026-09-03 an install failed inside `cf push` and the console
// showed nothing usable - the generic error was wiped by the status refresh
// within a second, and the text Cloud Foundry printed never reached the
// result. Rule since then: every failed action produces an outcome that
// (1) names the action and the app, (2) says WHERE it failed (step, CF app),
// (3) quotes what Cloud Foundry said, (4) gives the next step in plain
// words, (5) carries a report text the operator can copy and send to Figaf.
// It stays on the page until the operator dismisses it.
//
// Input:
//   { action, appName, result, managerVersion, releaseVersion, org, space, at }
//   result = the RPC result: { ok, error, step?, cfApp?, failedApp?, command?, detail? }
// Output (failure):
//   { ok:false, title, where, error, detail, command, hint, facts:[{label,value}], report, at }
// Output (success): { ok:true, title, at }

(function () {
  "use strict";

  var ACTION_LABEL = {
    install: "Install", update: "Update", disable: "Disable", enable: "Enable",
    remove: "Remove", configure: "Configure", health: "Health check", status: "Status refresh",
    provision: "Create base services", bind: "Bind Credential Store to the manager", restart: "Restart manager",
  };

  var STEP_LABEL = {
    extract: "unpack the release artifact",
    push: "upload the app to Cloud Foundry (cf push)",
    bind: "bind a service instance",
    env: "set the app environment",
    start: "start the app",
    stop: "stop the app",
    "delete": "delete the app",
  };

  // Known failure patterns -> the next step in plain words. First match wins.
  // Matched against error + detail. Keep the list short and factual.
  var HINTS = [
    {
      id: "manifest-leak",
      re: /Buildpack and Buildpacks fields cannot be used together|Applying manifest file/i,
      hint: "The manager's own manifest.yml was applied to the app push. This manager build is too old: builds from 2026-09-03 on push with --no-manifest. Deploy the current manager build, then try again.",
    },
    {
      id: "busy",
      re: /is already running \(started/i,
      hint: "The manager runs one action at a time. Wait until the running action finishes - the app row shows its state - and try again. Do not deploy twice at once: the second push replaces the package Cloud Foundry is staging and both attempts fail.",
    },
    {
      id: "services-missing",
      re: /required service instance\(s\) missing/i,
      hint: "Create the base services first (Setup page, step 3), wait until every instance is Ready, then try again.",
    },
    {
      id: "checksum",
      re: /checksum mismatch/i,
      hint: "The release inside this manager build is damaged. Build the manager zip again and deploy it.",
    },
    {
      id: "session",
      re: /not logged in|are you logged in|no api endpoint|please log in|authentication has expired|token expired|\b401\b|unauthorized/i,
      hint: "The Cloud Foundry session ended. Sign in again on Session & access, then try again.",
    },
    {
      id: "quota",
      re: /insufficient resources|memory.*quota|quota.*exceeded|exceeds (?:organization|space) memory|exceeded .*memory limit/i,
      hint: "The space has no free memory quota. Remove unused apps or raise the quota in the BTP cockpit, then try again.",
    },
    {
      id: "bind",
      re: /bind-service .* failed|does the service instance exist/i,
      hint: "The service instance is missing or not Ready in this space. Check the base services on the Setup page, step 3.",
    },
    {
      id: "start",
      re: /start unsuccessful|failed to start|start app timeout|health check|crashed|staging (?:error|failed)|see the staging log/i,
      hint: "The app was uploaded but did not start. The staging and start log is in the terminal drawer; `cf logs <app> --recent` shows the app's own output.",
    },
    {
      id: "no-route",
      re: /no route|could not resolve the route/i,
      hint: "The shared backend is not deployed or not started. Install it first (Install deploys the shared backend before the app).",
    },
  ];

  var DEFAULT_HINT = "Open the terminal drawer: the last red lines are the Cloud Foundry error. If the message does not help, copy this report and send it to Figaf.";

  function str(v) { return v == null ? "" : String(v); }

  function figafActionOutcome(input) {
    var i = input || {};
    var r = i.result || {};
    var action = ACTION_LABEL[i.action] || str(i.action) || "Action";
    var target = str(i.appName);
    var subject = action + (target ? " of " + target : "");
    var at = str(i.at) || new Date().toISOString();
    if (r && r.ok) return { ok: true, title: subject + " finished", at: at };

    var error = str(r.error) || str(i.error) || "unknown error";
    var detail = str(r.detail);
    var step = str(r.step);
    var cfApp = str(r.cfApp) || str(r.failedApp);
    var command = str(r.command);
    var haystack = error + "\n" + detail;
    var match = null;
    for (var k = 0; k < HINTS.length; k++) {
      if (HINTS[k].re.test(haystack)) { match = HINTS[k]; break; }
    }
    var hint = match ? match.hint : DEFAULT_HINT;
    var where = [
      step ? "step: " + (STEP_LABEL[step] || step) : "",
      cfApp ? "CF app: " + cfApp : "",
    ].filter(Boolean).join(" - ");

    var facts = [];
    if (where) facts.push({ label: "Where", value: where });
    facts.push({ label: "Error", value: error });
    if (command) facts.push({ label: "Command", value: command });

    var report = [
      "Figaf App Manager - action report",
      "time: " + at,
      "manager: " + (str(i.managerVersion) || "?") + "  release: " + (str(i.releaseVersion) || "?"),
      "target: " + ([str(i.org), str(i.space)].filter(Boolean).join(" / ") || "?"),
      "action: " + subject,
      where ? "where: " + where : null,
      "error: " + error,
      detail && error.indexOf(detail) < 0 ? "cf said: " + detail : null,
      command ? "command: " + command : null,
      "next: " + hint,
    ].filter(Boolean).join("\n");

    return {
      ok: false,
      title: subject + " failed",
      where: where,
      error: error,
      detail: detail,
      command: command,
      hint: hint,
      hintId: match ? match.id : "default",
      facts: facts,
      report: report,
      at: at,
    };
  }

  if (typeof window !== "undefined") window.figafActionOutcome = figafActionOutcome;
})();
