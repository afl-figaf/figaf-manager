const { contextBridge, ipcRenderer } = require("electron");

// Installer version — read synchronously from the app's package.json (CI
// stamps it from the release tag at build time, and electron-builder bundles
// it into the asar). Exposed as window.figafVersion so the renderer shows it
// instantly, mirroring the cloud server's injection. sandbox:false (see
// main.js webPreferences) permits this require.
const APP_VERSION = (() => {
  try { return require("../package.json").version || null; } catch { return null; }
})();

const listeners = new Map();

function on(channel, handler) {
  const wrapped = (_evt, payload) => handler(payload);
  ipcRenderer.on(channel, wrapped);
  let set = listeners.get(channel);
  if (!set) { set = new Set(); listeners.set(channel, set); }
  set.add(wrapped);
  return () => {
    ipcRenderer.removeListener(channel, wrapped);
    set.delete(wrapped);
  };
}

contextBridge.exposeInMainWorld("figaf", {
  window: {
    minimize: () => ipcRenderer.invoke("win:minimize"),
    toggleMax: () => ipcRenderer.invoke("win:toggleMax"),
    close: () => ipcRenderer.invoke("win:close"),
  },

  prereq: {
    whichBtp: () => ipcRenderer.invoke("prereq:whichBtp"),
    whichCf: () => ipcRenderer.invoke("prereq:whichCf"),
    bundledVersions: () => ipcRenderer.invoke("prereq:bundledVersions"),
    dockerHub: () => ipcRenderer.invoke("prereq:dockerHub"),
    disk: () => ipcRenderer.invoke("prereq:disk"),
    getCliPaths: () => ipcRenderer.invoke("prereq:getCliPaths"),
    clearCliPath: (cli) => ipcRenderer.invoke("prereq:clearCliPath", { cli }),
    installBtp: () => ipcRenderer.invoke("prereq:installBtp"),
    installCf: () => ipcRenderer.invoke("prereq:installCf"),
    openBtpDownloadPage: () => ipcRenderer.invoke("prereq:openBtpDownloadPage"),
    locateCli: (cli) => ipcRenderer.invoke("prereq:locateCli", { cli }),
  },

  btp: {
    loginStart: () => ipcRenderer.invoke("btp:loginStart"),
    submitChoice: (choice) => ipcRenderer.invoke("btp:submitChoice", { choice }),
    cancelLogin: () => ipcRenderer.invoke("btp:cancelLogin"),
    listGlobalAccounts: () => ipcRenderer.invoke("btp:listGlobalAccounts"),
    selectGlobalAccount: (index) => ipcRenderer.invoke("btp:selectGlobalAccount", { index }),
    selectSubaccount: (guid) => ipcRenderer.invoke("btp:selectSubaccount", { guid }),
    logout: () => ipcRenderer.invoke("btp:logout"),
    listEnvInstances: () => ipcRenderer.invoke("btp:listEnvInstances"),
    listUsers: () => ipcRenderer.invoke("btp:listUsers"),
    assignRole: (user, role) => ipcRenderer.invoke("btp:assignRole", { user, role }),
  },

  cf: {
    loginStart: (apiUrl) => ipcRenderer.invoke("cf:loginStart", { apiUrl }),
    suggestedApiUrl: () => ipcRenderer.invoke("cf:suggestedApiUrl"),
    ownTarget: (apiUrl) => ipcRenderer.invoke("cf:ownTarget", { apiUrl }),
    submitPasscode: (code) => ipcRenderer.invoke("cf:submitPasscode", { code }),
    selectOrg: (index) => ipcRenderer.invoke("cf:selectOrg", { index }),
    selectSpace: (index) => ipcRenderer.invoke("cf:selectSpace", { index }),
    logout: () => ipcRenderer.invoke("cf:logout"),
    targetOrgSpace: () => ipcRenderer.invoke("cf:targetOrgSpace"),
    switchOrgStart:    ()      => ipcRenderer.invoke("cf:switchOrgStart"),
    switchSelectOrg:   (index) => ipcRenderer.invoke("cf:switchSelectOrg", { index }),
    switchSelectSpace: (index) => ipcRenderer.invoke("cf:switchSelectSpace", { index }),
    domains: () => ipcRenderer.invoke("cf:domains"),
    marketplacePostgresql: () => ipcRenderer.invoke("cf:marketplacePostgresql"),
    createService: (args) => ipcRenderer.invoke("cf:createService", args),
    service: (name) => ipcRenderer.invoke("cf:service", { name }),
    pollService: (name) => ipcRenderer.invoke("cf:pollService", { name }),
    createServiceKey: (a) => ipcRenderer.invoke("cf:createServiceKey", a),
    serviceKey:       (a) => ipcRenderer.invoke("cf:serviceKey", a),
    marketplaceCheck: (a) => ipcRenderer.invoke("cf:marketplaceCheck", a),
    push: () => ipcRenderer.invoke("cf:push"),
    // v2 XSUAA upgrade (no-ops on desktop — the handlers return
    // "not available in desktop mode" but we expose the surface to keep the
    // window.figaf shape symmetric between the two apps).
    createXsuaa:           () => ipcRenderer.invoke("cf:createXsuaa"),
    pushManagerApprouter:  () => ipcRenderer.invoke("cf:pushManagerApprouter"),
    mapRoute:              (a) => ipcRenderer.invoke("cf:mapRoute", a),
    unmapRoute:            (a) => ipcRenderer.invoke("cf:unmapRoute", a),
    restage:               (a) => ipcRenderer.invoke("cf:restage", a),
    uninstallManager:      (a) => ipcRenderer.invoke("cf:uninstallManager", a || {}),
    cockpitUrl:            () => ipcRenderer.invoke("cf:cockpitUrl"),
  },

  xsuaa: {
    upgradeStatus:                 () => ipcRenderer.invoke("xsuaa:upgradeStatus"),
    assignRoleCollection:          (role, user) => ipcRenderer.invoke("xsuaa:assignRoleCollection", { role, user }),
    assignRoleCollectionPreflight: () => ipcRenderer.invoke("xsuaa:assignRoleCollectionPreflight"),
    roleAssignmentPrecheck:        () => ipcRenderer.invoke("xsuaa:roleAssignmentPrecheck"),
  },

  // Update Figaf Tool — hosted-only flow. Handlers gate on host.isHosted and
  // return a safe error in desktop mode; surface is exposed here for shape
  // parity with the cloud client.
  //
  // update.checkSelf is the exception: it works in BOTH hosts (it discovers
  // newer Figaf Installer releases on GitHub). The renderer reads `host` on
  // the response to decide which CTA to show.
  update: {
    checkSelf:        () => ipcRenderer.invoke("update:checkSelf"),
    selfTarget:       () => ipcRenderer.invoke("update:selfTarget"),
    downloadSelf:     (a) => ipcRenderer.invoke("update:downloadSelf", a || {}),
    extractSelf:      (a) => ipcRenderer.invoke("update:extractSelf", a || {}),
    pushSelf:         (a) => ipcRenderer.invoke("update:pushSelf", a || {}),
    resumeStatus:     () => ipcRenderer.invoke("update:resumeStatus"),
    detectDeployment: (a) => ipcRenderer.invoke("update:detectDeployment", a || {}),
    readCurrentConfig: (a) => ipcRenderer.invoke("update:readCurrentConfig", a || {}),
    begin:            (a) => ipcRenderer.invoke("update:begin", a || {}),
    clear:            () => ipcRenderer.invoke("update:clear"),
    writeVars:        (a) => ipcRenderer.invoke("update:writeVars", a || {}),
    updateXsuaa:      (a) => ipcRenderer.invoke("update:updateXsuaa", a || {}),
    deleteApps:       (a) => ipcRenderer.invoke("update:deleteApps", a || {}),
    createServices:   (a) => ipcRenderer.invoke("update:createServices", a || {}),
    pushApp:          (a) => ipcRenderer.invoke("update:pushApp", a || {}),
    verify:           (a) => ipcRenderer.invoke("update:verify", a || {}),
  },

  // Stored management user + session resume (surface parity with the cloud
  // client; on desktop the credstore binding is absent → friendly errors).
  login: {
    storedUserStatus:    () => ipcRenderer.invoke("login:storedUserStatus"),
    withStoredUser:      () => ipcRenderer.invoke("login:withStoredUser"),
    storeManagementUser: (a) => ipcRenderer.invoke("login:storeManagementUser", a || {}),
  },
  session: {
    state: () => ipcRenderer.invoke("session:state"),
  },

  // FAID Apps manager — surface parity with the cloud client. On desktop
  // the handlers work too when an artifact channel dir is configured via
  // host.resolvePlatformArtifactsDir (not implemented yet → friendly error).
  faid: {
    catalog:   (a) => ipcRenderer.invoke("faid:catalog", a || {}),
    status:    () => ipcRenderer.invoke("faid:status"),
    running:   () => ipcRenderer.invoke("faid:running"),
    releases:  (a) => ipcRenderer.invoke("faid:releases", a || {}),
    figafSystems: () => ipcRenderer.invoke("faid:figafSystems"),
    services:           ()  => ipcRenderer.invoke("faid:services"),
    provisionServices:  (a) => ipcRenderer.invoke("faid:provisionServices", a || {}),
    bindManagerService: (a) => ipcRenderer.invoke("faid:bindManagerService", a || {}),
    restartSelf:        ()  => ipcRenderer.invoke("faid:restartSelf"),
    ensureXsuaa:            (a) => ipcRenderer.invoke("faid:ensureXsuaa", a || {}),
    prepareManagerServices: (a) => ipcRenderer.invoke("faid:prepareManagerServices", a || {}),
    prepareSpaceServices:   (a) => ipcRenderer.invoke("faid:prepareSpaceServices", a || {}),
    install:   (a) => ipcRenderer.invoke("faid:install", a || {}),
    update:    (a) => ipcRenderer.invoke("faid:update", a || {}),
    disable:   (a) => ipcRenderer.invoke("faid:disable", a || {}),
    enable:    (a) => ipcRenderer.invoke("faid:enable", a || {}),
    remove:    (a) => ipcRenderer.invoke("faid:remove", a || {}),
    configure: (a) => ipcRenderer.invoke("faid:configure", a || {}),
    health:    (a) => ipcRenderer.invoke("faid:health", a || {}),
  },

  // System connections (decision 0006) — surface parity with the cloud client.
  // On desktop these need a credstore binding, which does not exist → the
  // handlers answer with a friendly error.
  connections: {
    figafStatus:  ()  => ipcRenderer.invoke("connections:figafStatus"),
    saveFigaf:    (a) => ipcRenderer.invoke("connections:saveFigaf", a || {}),
    deleteFigaf:  ()  => ipcRenderer.invoke("connections:deleteFigaf"),
    listAgents:   ()  => ipcRenderer.invoke("connections:listAgents"),
    saveSystem:   (a) => ipcRenderer.invoke("connections:saveSystem", a || {}),
    deleteSystem: (a) => ipcRenderer.invoke("connections:deleteSystem", a || {}),
  },

  connect: {
    templatePath: (name) => ipcRenderer.invoke("connect:templatePath", { name }),
    integrationSuiteUrl: () => ipcRenderer.invoke("connect:integrationSuiteUrl"),
    trustConfigUrl: () => ipcRenderer.invoke("connect:trustConfigUrl"),
    resolveIdpOrigin: (idpName) => ipcRenderer.invoke("connect:resolveIdpOrigin", { idpName }),
    assignPiRole: (a) => ipcRenderer.invoke("connect:assignPiRole", a || {}),
    samlSsoUrl: () => ipcRenderer.invoke("connect:samlSsoUrl"),
    createIasService: () => ipcRenderer.invoke("connect:createIasService"),
    establishIasTrust: () => ipcRenderer.invoke("connect:establishIasTrust"),
  },

  config: {
    dockerHubLatestBtpTag: () => ipcRenderer.invoke("config:dockerHubLatestBtpTag"),
    dockerHubBtpTags: () => ipcRenderer.invoke("config:dockerHubBtpTags"),
    readVars: () => ipcRenderer.invoke("config:readVars"),
    writeVars: (vars) => ipcRenderer.invoke("config:writeVars", vars),
    readDbConfig: () => ipcRenderer.invoke("config:readDbConfig"),
    writeDbConfig: (payload) => ipcRenderer.invoke("config:writeDbConfig", payload),
    dbSchema: (payload) => ipcRenderer.invoke("config:dbSchema", payload),
    deployDir: () => ipcRenderer.invoke("config:deployDir"),
  },

  shell: {
    openPasscodeUrl: (landscape) => ipcRenderer.invoke("shell:openPasscodeUrl", { landscape }),
    openExternal: (url) => ipcRenderer.invoke("shell:openExternal", { url }),
    readClipboard: () => ipcRenderer.invoke("shell:readClipboard"),
    writeClipboard:  (text) => ipcRenderer.invoke("shell:writeClipboard", { text }),
  },

  on,
});

// Mirror the cloud server's window.figafVersion injection so both hosts expose
// the installed version the same way to the renderer.
contextBridge.exposeInMainWorld("figafVersion", APP_VERSION);
