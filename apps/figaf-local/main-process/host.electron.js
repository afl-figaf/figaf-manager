"use strict";
// Electron HostAdapter — implements the contract documented in
// packages/core/orchestrator.js (@typedef HostAdapter).
//
// All persistence (cliPaths.json, the writable copy of the deploy templates)
// lives under app.getPath("userData"). The deploy template source is bundled
// alongside the asar via electron-builder extraResources; in dev we resolve to
// the workspace's packages/deploy-templates/ directly.

const path = require("path");
const fs = require("fs");
const { app, dialog, clipboard, shell } = require("electron");

function cliPathsFile() {
  return path.join(app.getPath("userData"), "cliPaths.json");
}

let cliPathsCache = null;
function loadCliPaths() {
  if (cliPathsCache) return cliPathsCache;
  const out = { btp: null, cf: null };
  try {
    const obj = JSON.parse(fs.readFileSync(cliPathsFile(), "utf8"));
    if (obj.btp && fs.existsSync(obj.btp)) out.btp = obj.btp;
    if (obj.cf && fs.existsSync(obj.cf)) out.cf = obj.cf;
  } catch {}
  cliPathsCache = out;
  return out;
}

function saveCliPaths() {
  fs.mkdirSync(path.dirname(cliPathsFile()), { recursive: true });
  fs.writeFileSync(cliPathsFile(), JSON.stringify(cliPathsCache || { btp: null, cf: null }, null, 2));
}

function deployTemplateSrc() {
  // Packaged: electron-builder copies packages/deploy-templates/ to
  //           process.resourcesPath/deploy-templates/.
  // Dev:      resolve to the workspace's packages/deploy-templates/ via
  //           require.resolve of its package.json.
  const packed = process.resourcesPath
    ? path.join(process.resourcesPath, "deploy-templates")
    : null;
  if (packed && fs.existsSync(packed)) return packed;
  return path.dirname(require.resolve("@figaf/deploy-templates/package.json"));
}

function createHost({ getWindow }) {
  return {
    isHosted: false,
    getUserDataDir: () => app.getPath("userData"),

    getInstalledVersion: () => app.getVersion(),

    getUpdateStagingDir: () => path.join(app.getPath("temp"), "figaf-update"),

    // Self-redeploy is a hosted-only flow; the desktop self-update opens the
    // GitHub release page for a manual portable download. Returning null causes
    // update:selfTarget / update:pushSelf to short-circuit cleanly.
    getDeployTargetForSelf: () => null,

    // The desktop app is the one-time installer wizard, never the console.
    isConsoleUI: () => false,

    resolveBinary(name) {
      const paths = loadCliPaths();
      return paths[name] || name;
    },

    storeCliPath(name, value) {
      const paths = loadCliPaths();
      paths[name] = value;
      cliPathsCache = paths;
      saveCliPaths();
    },

    async pickFile(opts) {
      const win = getWindow && getWindow();
      const picked = await dialog.showOpenDialog(win || null, opts);
      if (picked.canceled || !picked.filePaths.length) return null;
      return picked.filePaths[0];
    },

    openExternal(url) {
      return shell.openExternal(url);
    },

    async readClipboard() {
      return clipboard.readText() || "";
    },

    async writeClipboard(text) {
      clipboard.writeText(typeof text === "string" ? text : "");
      return { ok: true };
    },

    resolveDeployTemplate() {
      return { kind: "bundle", src: deployTemplateSrc() };
    },

    // v2 XSUAA upgrade does not apply to the desktop installer. Returning
    // null makes the cloud-only handlers (cf:createXsuaa, cf:pushManager-
    // Approuter, etc.) fail closed with a friendly "not available" error.
    resolveManagerApprouterDir() {
      return null;
    },
  };
}

module.exports = { createHost };
