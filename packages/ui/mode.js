// Mode + feature-flag module for the shared renderer.
// Loaded once per page, before app.jsx, by both apps' index.html shells.
//
// In cloud mode, server.js injects `window.figafMode = "hosted"` before this
// script runs. In Electron mode, that flag is absent, so isHosted defaults to
// false. Add new conditionals here rather than scattering `isHosted` ternaries
// across screens.

(function () {
  "use strict";
  var hosted = (typeof window !== "undefined") && window.figafMode === "hosted";
  // v2: window.figafXsuaaMode is injected by server.js (hosted) if VCAP_SERVICES
  // has an xsuaa binding. The upgrade is only OFFERABLE in the token-gate
  // (pre-upgrade) world AND only after a deploy has succeeded — so the
  // feature flag here is "the upgrade button should appear" not "the wizard
  // is already in XSUAA mode." app.jsx reads it after ctx.deployDone is set.
  var xsuaaMode = (typeof window !== "undefined") && window.figafXsuaaMode === true;

  window.figafModeFlags = {
    isHosted: hosted,
    isXsuaaMode: xsuaaMode,
    features: {
      cliInstall:    !hosted,           // figaf-local: install/locate btp+cf at runtime
      diskCheck:     !hosted,           // figaf-local: free-disk prereq probe
      windowChrome:  !hosted,           // figaf-local: frameless titlebar + drag region
      selfDelete:    hosted,            // figaf-manager: "Delete this manager app" button on Done
      // figaf-manager: "Skip BTP login" affordance. Lets an operator without a
      // global account connect straight to Cloud Foundry (Update-only flow).
      cfOnlyLogin:   hosted,
      // v2: in hosted+token mode (the upgrade hasn't run yet), surface the
      // "Enable persistent SSO login" button on the Done screen. In XSUAA
      // mode the upgrade is already done — flag is false. In Electron the
      // wizard doesn't deploy itself, so the entire concept is N/A.
      xsuaaUpgrade:  hosted && !xsuaaMode,
      // Update Figaf Tool branch — hosted only. Desktop operators just
      // re-run the installer; only the cloud manager needs an in-place
      // rolling-update flow.
      updateFigafTool: true,
      // Self-update (update the wizard itself). On in both hosts; cloud can
      // disable via FIGAF_DISABLE_SELF_UPDATE=1 in manifest.yml for air-
      // gapped deployments that can't reach api.github.com.
      selfUpdateBanner:
        !(typeof window !== "undefined" && window.figafDisableSelfUpdate === true),
      // FAID Apps manager: catalog-driven install/manage of FAID Apps.
      // Hosted only — the artifact channel is bundled into the cockpit zip.
      manageFaidApps:  hosted,
      // Console frame: persistent left-rail navigation instead of the
      // one-time wizard. Hosted only — desktop really is a one-time
      // installer and keeps the wizard frame. server.js injects
      // window.figafConsoleUI from FIGAF_CONSOLE_UI (default on; set
      // FIGAF_CONSOLE_UI=0 in the manifest to restore the classic wizard).
      consoleUI: hosted && window.figafConsoleUI !== false,
      // Console sign-in gate, first sign-in: Cloud Foundry is the primary
      // action (the FAID Apps install needs only cf); the BTP login is optional
      // (persistent-SSO role assignment, Figaf Tool deployments). Same
      // condition as consoleUI - the wizard frame keeps BTP first.
      cfFirstLogin: hosted && window.figafConsoleUI !== false,
    },
  };

  // Banner suppression helper — used by <SelfUpdateBanner/> to hide itself
  // while the operator is mid-flow (deploying, upgrading XSUAA, etc). The
  // reason we suppress is operator-experience: interrupting an active deploy
  // with "hey, update the wizard?" is hostile, and a stale banner during a
  // 10-minute service-create wait is just noise.
  //
  // NOTE: login (btp/cf "running") is deliberately NOT a suppressing flow.
  // Login is long-running and multi-prompt (SSO, account/org/space selection),
  // but knowing an update is available *before* investing in login is useful,
  // not disruptive — and toggling on the login status made the banner flicker
  // out exactly when the operator was picking an account/org. Keep it visible.
  //
  // Add an entry here when introducing a new long-running flow rather than
  // letting the banner peek through in surprising places.
  window.figafIsLongRunningFlow = function (ctx, stepId) {
    if (!ctx) return false;
    if (ctx.setupRunning) return true; // the Setup page is preparing the space
    if (ctx.prereqsStarted && (ctx.prereqs || []).some(p => p.status === "pending" || p.status === "running")) return true;
    if (ctx.pushStatus === "running") return true;
    if (ctx.deployStarted && ctx.pushStatus !== "done" && ctx.pushStatus !== "error" && ctx.pushStatus !== "idle") return true;
    if (ctx.update && ctx.update.resumeState) return true;
    if (ctx.selfUpdate && ctx.selfUpdate.preflightOpen) return true;
    var noisy = {
      "xsuaa-upgrade": 1, "xsuaa-assign-role": 1,
      "connect-idp-custom-trust": 1, "connect-idp-custom-assign": 1,
      "updateProgress": 1,
    };
    if (stepId && noisy[stepId]) return true;
    return false;
  };
})();
