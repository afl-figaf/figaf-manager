// window.figaf browser shim for the CF-hosted context.
// Loaded by cloud/index.html BEFORE app.jsx, AFTER the mode-flag injection script.
// Mirrors the IPC surface in main-process/preload.js, but over fetch + WebSocket:
//   RPC calls  → POST /rpc/:channel  (session cookie travels same-origin)
//   Events     → WebSocket /stream   (server pushes { channel, payload } JSON frames)
//
// Differences from the Electron preload:
//   shell.openExternal / openPasscodeUrl  → window.open (user's local browser)
//   shell.readClipboard                   → navigator.clipboard.readText()
//   window.minimize / toggleMax / close   → no-ops

(function () {
  "use strict";

  // ─── Auth-kick handling ────────────────────────────────────────────────────
  // Plan §1.5 + §1.7 commit 7, extended in §2.7 row 12 for v2 XSUAA mode.
  // The cloud server can reject this client at two seams:
  //   - HTTP 401 from POST /rpc/* when the auth cookie/JWT is missing/expired.
  //   - HTTP 403 from POST /rpc/* (XSUAA mode only) when the JWT is valid but
  //     lacks FigafManagerOperator scope.
  //   - WS close codes:
  //       4003 = unauth'd (no cookie / no JWT / invalid JWT)
  //       4004 = JWT valid but scope missing (XSUAA mode only)
  // Either signal means: redirect, but the TARGET differs by mode:
  //   - token mode (v1): redirect to /setup so the operator can re-claim
  //   - xsuaa mode (v2): redirect to /     which the approuter intercepts
  //                      and triggers an IAS re-login (or 403 on NO_SCOPE)
  // Idempotent — multiple kicks queue one redirect.

  var xsuaaMode = (typeof window !== "undefined") && window.figafXsuaaMode === true;

  var kicked = false;
  function handleAuthKick(reason, opts) {
    // Suppression escape hatch for the XSUAA upgrade success state: the
    // restage phase intentionally tears the dyno down, the WS drops, and a
    // reconnect attempt gets auth-bounced by the freshly XSUAA-gated server.
    // We must NOT redirect — the operator is meant to click "Continue to
    // wizard" themselves so they can read the success copy first. Checked
    // BEFORE the `kicked` latch so the guard stays reentrant: as long as the
    // flag remains true, all subsequent kicks during the restage window are
    // silently dropped. The flag is set by screen-xsuaa.jsx when entering
    // the success state; it self-clears on Continue (window.location reloads
    // the page, which re-evaluates the IIFE with a fresh closure).
    if (typeof window !== "undefined" && window.figafSuppressAuthKick) return;
    if (kicked) return;
    kicked = true;
    var noScope = opts && opts.noScope;
    try { window.sessionStorage.setItem("figaf:auth-kicked", noScope ? "no-scope" : "1"); } catch (_) {}
    var bus = subscribers.get("btp:browserAuth");
    if (bus) bus.forEach(function (h) { try { h({ reason: reason || "kicked", noScope: !!noScope }); } catch (_) {} });
    // Redirect target depends on mode:
    //   xsuaa + noScope  → reload / (approuter will render 403 page)
    //   xsuaa (other)    → reload / (approuter re-triggers IAS)
    //   token            → /setup (claim flow)
    var target = xsuaaMode ? "/" : "/setup";
    setTimeout(function () {
      try { window.location.href = target; } catch (_) {}
    }, 800);
  }

  // ─── WebSocket event bus ───────────────────────────────────────────────────

  var subscribers = new Map(); // channel → Set<handler>

  function openStream() {
    var proto = location.protocol === "https:" ? "wss" : "ws";
    var ws = new WebSocket(proto + "://" + location.host + "/stream");

    ws.addEventListener("open", function () {
      console.log("[figaf] stream connected");
    });

    ws.addEventListener("message", function (evt) {
      try {
        var msg = JSON.parse(evt.data);
        if (msg.pong) return;
        var handlers = subscribers.get(msg.channel);
        if (handlers) handlers.forEach(function (h) { h(msg.payload); });
      } catch (_) {}
    });

    ws.addEventListener("close", function (evt) {
      // 4003: unauthenticated (no/invalid cookie or JWT) — auth-kick redirect.
      // 4004: XSUAA mode — JWT valid but FigafManagerOperator scope missing.
      // Note: when the server rejects pre-upgrade with HTTP 401, the browser
      // surfaces it as a generic close + error rather than a clean 4003/4004.
      if (evt.code === 4003) {
        handleAuthKick("ws-4003");
        return;
      }
      if (evt.code === 4004) {
        handleAuthKick("ws-4004", { noScope: true });
        return;
      }
      if (evt.code === 4001) {
        // Legacy/no-session: leave as-is (no reconnect, no redirect).
        return;
      }
      // Reconnect on unexpected close (e.g., dyno restart). Slight back-off.
      if (!kicked) setTimeout(openStream, 2000);
    });

    ws.addEventListener("error", function () {});
  }

  openStream();

  // ─── RPC helper ───────────────────────────────────────────────────────────

  function rpc(channel, args) {
    return fetch("/rpc/" + encodeURIComponent(channel), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(args != null ? args : {}),
      credentials: "same-origin",
    }).then(function (r) {
      if (r.status === 401) {
        handleAuthKick("rpc-401");
        return { ok: false, error: "unauthenticated" };
      }
      if (r.status === 403) {
        // XSUAA mode: JWT valid, scope missing. Redirect to / (approuter
        // will render a 403 page; re-login won't help) and flag the kick.
        handleAuthKick("rpc-403", { noScope: true });
        return { ok: false, error: "forbidden" };
      }
      return r.json().catch(function () { return { ok: false, error: "HTTP " + r.status }; });
    });
  }

  // ─── window.figaf ─────────────────────────────────────────────────────────

  window.figaf = {
    prereq: {
      whichBtp:             function ()  { return rpc("prereq:whichBtp"); },
      whichCf:              function ()  { return rpc("prereq:whichCf"); },
      bundledVersions:      function ()  { return rpc("prereq:bundledVersions"); },
      getCliPaths:          function ()  { return rpc("prereq:getCliPaths"); },
      clearCliPath:         function (a) { return rpc("prereq:clearCliPath", a); },
      installBtp:           function ()  { return rpc("prereq:installBtp"); },
      installCf:            function ()  { return rpc("prereq:installCf"); },
      locateCli:            function (a) { return rpc("prereq:locateCli", a); },
      dockerHub:            function ()  { return rpc("prereq:dockerHub"); },
      disk:                 function ()  { return rpc("prereq:disk"); },
      openBtpDownloadPage:  function ()  { return rpc("prereq:openBtpDownloadPage"); },
    },

    btp: {
      loginStart:           function ()  { return rpc("btp:loginStart"); },
      submitChoice:         function (choice) { return rpc("btp:submitChoice", { choice: choice }); },
      cancelLogin:          function ()  { return rpc("btp:cancelLogin"); },
      listGlobalAccounts:   function ()      { return rpc("btp:listGlobalAccounts"); },
      selectGlobalAccount:  function (index) { return rpc("btp:selectGlobalAccount", { index: index }); },
      selectSubaccount:     function (guid) { return rpc("btp:selectSubaccount", { guid: guid }); },
      logout:               function ()  { return rpc("btp:logout"); },
      listEnvInstances:     function ()  { return rpc("btp:listEnvInstances"); },
      listUsers:            function ()  { return rpc("btp:listUsers"); },
      assignRole:           function (user, role) { return rpc("btp:assignRole", { user: user, role: role }); },
    },

    cf: {
      loginStart:           function (apiUrl) { return rpc("cf:loginStart", { apiUrl: apiUrl }); },
      suggestedApiUrl:      function ()  { return rpc("cf:suggestedApiUrl"); },
      ownTarget:            function (apiUrl) { return rpc("cf:ownTarget", { apiUrl: apiUrl }); },
      submitPasscode:       function (code) { return rpc("cf:submitPasscode", { code: code }); },
      selectOrg:            function (index) { return rpc("cf:selectOrg", { index: index }); },
      selectSpace:          function (index) { return rpc("cf:selectSpace", { index: index }); },
      logout:               function ()  { return rpc("cf:logout"); },
      targetOrgSpace:       function ()  { return rpc("cf:targetOrgSpace"); },
      switchOrgStart:       function ()      { return rpc("cf:switchOrgStart"); },
      switchSelectOrg:      function (index) { return rpc("cf:switchSelectOrg", { index: index }); },
      switchSelectSpace:    function (index) { return rpc("cf:switchSelectSpace", { index: index }); },
      domains:              function ()  { return rpc("cf:domains"); },
      marketplacePostgresql:function ()  { return rpc("cf:marketplacePostgresql"); },
      createService:        function (a) { return rpc("cf:createService", a); },
      service:              function (name) { return rpc("cf:service", { name: name }); },
      services:             function ()  { return rpc("cf:services"); },
      pollService:          function (name) { return rpc("cf:pollService", { name: name }); },
      createServiceKey:     function (a) { return rpc("cf:createServiceKey", a); },
      serviceKey:           function (a) { return rpc("cf:serviceKey", a); },
      marketplaceCheck:     function (a) { return rpc("cf:marketplaceCheck", a); },
      push:                 function ()  { return rpc("cf:push"); },
      deleteApp:            function (a) { return rpc("cf:deleteApp", a); },
      // v2 XSUAA upgrade — see auth-gate-implementation-plan.md §2.
      createXsuaa:           function ()  { return rpc("cf:createXsuaa"); },
      pushManagerApprouter:  function ()  { return rpc("cf:pushManagerApprouter"); },
      mapRoute:              function (a) { return rpc("cf:mapRoute", a); },
      unmapRoute:            function (a) { return rpc("cf:unmapRoute", a); },
      restage:               function (a) { return rpc("cf:restage", a); },
      uninstallManager:      function (a) { return rpc("cf:uninstallManager", a || {}); },
      cockpitUrl:           function ()  { return rpc("cf:cockpitUrl"); },
    },

    xsuaa: {
      upgradeStatus:                 function ()  { return rpc("xsuaa:upgradeStatus"); },
      assignRoleCollection:          function (role, user) { return rpc("xsuaa:assignRoleCollection", { role: role, user: user }); },
      assignRoleCollectionPreflight: function ()  { return rpc("xsuaa:assignRoleCollectionPreflight"); },
      roleAssignmentPrecheck:        function ()  { return rpc("xsuaa:roleAssignmentPrecheck"); },
    },

    update: {
      checkSelf:        function ()  { return rpc("update:checkSelf"); },
      selfTarget:       function ()  { return rpc("update:selfTarget"); },
      downloadSelf:     function (a) { return rpc("update:downloadSelf", a || {}); },
      extractSelf:      function (a) { return rpc("update:extractSelf", a || {}); },
      pushSelf:         function (a) { return rpc("update:pushSelf", a || {}); },
      resumeStatus:     function ()  { return rpc("update:resumeStatus"); },
      detectDeployment: function (a) { return rpc("update:detectDeployment", a || {}); },
      readCurrentConfig: function (a) { return rpc("update:readCurrentConfig", a || {}); },
      begin:            function (a) { return rpc("update:begin", a || {}); },
      clear:            function ()  { return rpc("update:clear"); },
      writeVars:        function (a) { return rpc("update:writeVars", a || {}); },
      updateXsuaa:      function (a) { return rpc("update:updateXsuaa", a || {}); },
      deleteApps:       function (a) { return rpc("update:deleteApps", a || {}); },
      createServices:   function (a) { return rpc("update:createServices", a || {}); },
      pushApp:          function (a) { return rpc("update:pushApp", a || {}); },
      verify:           function (a) { return rpc("update:verify", a || {}); },
    },

    // Stored management user + session resume (FAID Apps manager).
    login: {
      storedUserStatus:    function ()  { return rpc("login:storedUserStatus"); },
      withStoredUser:      function ()  { return rpc("login:withStoredUser"); },
      storeManagementUser: function (a) { return rpc("login:storeManagementUser", a || {}); },
    },
    session: {
      state: function () { return rpc("session:state"); },
    },

    // FAID Apps manager — catalog-driven install/manage of FAID Apps.
    faid: {
      catalog:   function (a) { return rpc("faid:catalog", a || {}); },
      status:    function ()  { return rpc("faid:status"); },
      running:   function ()  { return rpc("faid:running"); },
      // The release store (decision 0010): source, installed / latest / every version.
      releases:  function (a) { return rpc("faid:releases", a || {}); },
      figafSystems: function () { return rpc("faid:figafSystems"); },
      // The base service instances (packages/core/base-services.js) the release requires; created by the manager.
      services:           function (a) { return rpc("faid:services", a || {}); },
      databaseStatus:     function ()  { return rpc("faid:databaseStatus"); },
      databasePrepare:    function (a) { return rpc("faid:databasePrepare", a || {}); },
      databaseRotate:     function ()  { return rpc("faid:databaseRotate"); },
      databaseDrop:       function (a) { return rpc("faid:databaseDrop", a || {}); },
      provisionServices:  function (a) { return rpc("faid:provisionServices", a || {}); },
      bindManagerService: function (a) { return rpc("faid:bindManagerService", a || {}); },
      // Bind an optional instance (PI/PO) to the shared backend + restart it.
      bindPlatformService: function (a) { return rpc("faid:bindPlatformService", a || {}); },
      restartSelf:        function ()  { return rpc("faid:restartSelf"); },
      // One XSUAA instance + secure access first (decision 0009).
      ensureXsuaa:            function (a) { return rpc("faid:ensureXsuaa", a || {}); },
      prepareManagerServices: function (a) { return rpc("faid:prepareManagerServices", a || {}); },
      prepareSpaceServices:   function (a) { return rpc("faid:prepareSpaceServices", a || {}); },
      install:   function (a) { return rpc("faid:install", a || {}); },
      update:    function (a) { return rpc("faid:update", a || {}); },
      disable:   function (a) { return rpc("faid:disable", a || {}); },
      enable:    function (a) { return rpc("faid:enable", a || {}); },
      remove:    function (a) { return rpc("faid:remove", a || {}); },
      configure: function (a) { return rpc("faid:configure", a || {}); },
      health:    function (a) { return rpc("faid:health", a || {}); },
      // PI/PO (decision 0011): the shared backend checks a BTP destination.
      destinationCheck: function (a) { return rpc("faid:destinationCheck", a || {}); },
    },

    // System connections (decision 0006): Figaf tool + SAP systems in the
    // Credential Store. Save calls carry secrets — HTTPS body only, redacted
    // in the RPC audit (server.js).
    connections: {
      figafStatus:  function ()  { return rpc("connections:figafStatus"); },
      saveFigaf:    function (a) { return rpc("connections:saveFigaf", a || {}); },
      deleteFigaf:  function ()  { return rpc("connections:deleteFigaf"); },
      listAgents:   function ()  { return rpc("connections:listAgents"); },
      saveSystem:   function (a) { return rpc("connections:saveSystem", a || {}); },
      deleteSystem: function (a) { return rpc("connections:deleteSystem", a || {}); },
      // On-premise PI/PO (decision 0011): a destination name, no secret.
      savePipoSystem:   function (a) { return rpc("connections:savePipoSystem", a || {}); },
      deletePipoSystem: function (a) { return rpc("connections:deletePipoSystem", a || {}); },
    },

    connect: {
      templatePath:         function (name) { return rpc("connect:templatePath", { name: name }); },
      integrationSuiteUrl:  function ()     { return rpc("connect:integrationSuiteUrl"); },
      trustConfigUrl:       function ()     { return rpc("connect:trustConfigUrl"); },
      resolveIdpOrigin:     function (idpName) { return rpc("connect:resolveIdpOrigin", { idpName: idpName }); },
      assignPiRole:         function (a)    { return rpc("connect:assignPiRole", a || {}); },
      samlSsoUrl:           function ()     { return rpc("connect:samlSsoUrl"); },
      createIasService:     function ()     { return rpc("connect:createIasService"); },
      establishIasTrust:    function ()     { return rpc("connect:establishIasTrust"); },
    },

    config: {
      dockerHubLatestBtpTag:function ()  { return rpc("config:dockerHubLatestBtpTag"); },
      dockerHubBtpTags:     function ()  { return rpc("config:dockerHubBtpTags"); },
      deployDir:            function ()  { return rpc("config:deployDir"); },
      readVars:             function ()  { return rpc("config:readVars"); },
      writeVars:            function (a) { return rpc("config:writeVars", a); },
      readDbConfig:         function ()  { return rpc("config:readDbConfig"); },
      writeDbConfig:        function (a) { return rpc("config:writeDbConfig", a); },
      dbSchema:             function (a) { return rpc("config:dbSchema", a); },
    },

    shell: {
      openExternal:    function (url) { window.open(url, "_blank", "noopener,noreferrer"); return Promise.resolve(); },
      openPasscodeUrl: function (landscape) {
        var lp = (landscape || "").replace(/^cf-/, "cf.");
        var url = "https://login." + lp + ".hana.ondemand.com/passcode";
        window.open(url, "_blank", "noopener,noreferrer");
        return Promise.resolve({ ok: true, url: url });
      },
      readClipboard:   function () {
        if (navigator.clipboard && navigator.clipboard.readText) {
          return navigator.clipboard.readText().then(function (text) { return { ok: true, text: text }; });
        }
        return Promise.resolve({ ok: false, text: "" });
      },
      writeClipboard:  function (text) {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          return navigator.clipboard.writeText(String(text || "")).then(
            function () { return { ok: true }; },
            function (e) { return { ok: false, error: e && e.message }; }
          );
        }
        return Promise.resolve({ ok: false, error: "clipboard API unavailable" });
      },
    },

    // No-ops: there is no native window to control in a browser tab
    window: {
      minimize:  function () {},
      toggleMax: function () {},
      close:     function () {},
    },

    on: function (channel, handler) {
      if (!subscribers.has(channel)) subscribers.set(channel, new Set());
      subscribers.get(channel).add(handler);
      return function () {
        var s = subscribers.get(channel);
        if (s) s.delete(handler);
      };
    },
  };
})();
