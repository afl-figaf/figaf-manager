"use strict";
// Cloud HostAdapter — implements the contract documented in
// packages/core/orchestrator.js (@typedef HostAdapter).
//
// Each session gets its own user-data directory under $HOME/sessions/<sessionId>
// (the orchestrator writes the unpacked deploy template there). CLI binaries
// are bundled at /app/bin/{btp,cf} in the container; the dev fallback uses
// whatever is on PATH so a Mac/Windows dev machine can still run the server.
// pickFile/openExternal/readClipboard are no-ops on the server — the browser
// shim in cloud/client.js handles those client-side.

const path = require("path");
const fs = require("fs");
const os = require("os");
const { spawnSync } = require("child_process");

// Version: read from the package.json that ships with figaf-manager. In a
// staged/zipped build that file sits two levels up from cloud/ (… /app/
// package.json); in `npm start` from a checkout it's the workspace
// app's package.json. Either way require() resolves at module load.
const PKG_VERSION = (() => {
  try { return require(path.join(__dirname, "package.json")).version || "0.0.0"; }
  catch { return "0.0.0"; }
})();

// Parse VCAP_APPLICATION once at module load. CF populates it before our
// process starts; if it's missing we're either running in dev (npm start
// outside CF) or something is very wrong — either way return null and let
// callers fail with a clear "not in CF" message.
const VCAP_TARGET = (() => {
  const raw = process.env.VCAP_APPLICATION;
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return {
      apiUrl:    v.cf_api || "",
      orgName:   v.organization_name || "",
      spaceName: v.space_name || "",
      appName:   v.application_name || "",
      uris:      Array.isArray(v.uris) ? v.uris.slice() : [],
    };
  } catch { return null; }
})();

function createHost({ sessionId }) {
  return {
    isHosted: true,
    getUserDataDir: () => path.join(os.homedir(), "sessions", sessionId),

    getInstalledVersion: () => PKG_VERSION,

    // Versions recorded by scripts/build-zip.js into bin/VERSIONS.json (the
    // pinned btp and cf CLI versions, the Node engine, the pinned npm
    // dependencies, the build time). Null in a checkout without a build.
    getBundledVersions() {
      // Same rule as resolveBinary: on win32 the CLIs come from PATH, so the
      // build record does not describe what runs — report "no record".
      if (process.platform === "win32") return null;
      try { return JSON.parse(fs.readFileSync(path.join(__dirname, "bin", "VERSIONS.json"), "utf8")); }
      catch { return null; }
    },

    getUpdateStagingDir: () => path.join(os.tmpdir(), "figaf-update-" + sessionId),

    getDeployTargetForSelf: () => (VCAP_TARGET ? { ...VCAP_TARGET } : null),

    // Same switch server.js injects into the page as window.figafConsoleUI:
    // the console frame is the default, FIGAF_CONSOLE_UI=0 restores Alex's
    // classic wizard. The orchestrator needs it because the console installs
    // into its OWN space while the wizard deploys where the operator picks.
    isConsoleUI: () => process.env.FIGAF_CONSOLE_UI !== "0",

    resolveBinary(name) {
      // The bundled bin/ binaries are Linux builds (packed into the cloud
      // zip). A CF container is always Linux, so win32 can only be a dev
      // machine — use the CLIs from PATH there even when bin/ is populated.
      if (process.platform === "win32") return name;
      const bundled = path.join(__dirname, "bin", name);
      if (!fs.existsSync(bundled) && process.env.NODE_ENV !== "production") {
        // Dev fallback: rely on PATH (Mac/Windows dev machines)
        return name;
      }
      return bundled;
    },

    openExternal: () => Promise.resolve(),
    pickFile:     () => Promise.resolve(null),
    readClipboard:() => Promise.resolve(""),
    writeClipboard:() => Promise.resolve({ ok: false, error: "use browser API" }),

    resolveDeployTemplate: () => ({
      kind: "github",
      src:
        process.env.FIGAF_DEPLOYMENT_ZIP_URL ||
        "https://github.com/figaf/Figaf-BTP-Deployment/archive/refs/heads/btp-users.zip",
    }),

    /**
     * Where the FAID releases come from (figaf-faid decision 0010).
     * Exactly one source, in this order:
     *   1. FIGAF_FAID_ARTIFACTS_DIR  a local directory holding ONE release in the
     *      flat shape build.js writes (development, e2e fixtures);
     *   2. FIGAF_FAID_RELEASE_URL    the artifact store (manifest.yml; the bucket
     *      layout of figaf-faid release/publish.js: index.json, <version>/…);
     *   3. faid-artifacts/ next to this file, when a developer built a release
     *      into the checkout and set nothing (development convenience; the
     *      shipped zip does not contain it any more).
     * Returns { kind:"local", dir } | { kind:"remote", url, cacheDir } | null.
     * With null the faid:* handlers report "no release source configured".
     */
    resolveFaidReleaseSource() {
      const dir = process.env.FIGAF_FAID_ARTIFACTS_DIR;
      if (dir) return { kind: "local", dir, origin: "FIGAF_FAID_ARTIFACTS_DIR" };
      const url = (process.env.FIGAF_FAID_RELEASE_URL || "").trim();
      if (url) {
        return { kind: "remote", url: url.replace(/\/+$/, ""), cacheDir: path.join(os.tmpdir(), "figaf-faid-releases"), origin: "FIGAF_FAID_RELEASE_URL" };
      }
      const bundled = path.join(__dirname, "faid-artifacts");
      if (fs.existsSync(path.join(bundled, "catalog.json"))) return { kind: "local", dir: bundled, origin: "faid-artifacts/ next to the server" };
      return null;
    },

    /**
     * v2 XSUAA upgrade: bundled manager-approuter directory. In the cloud
     * zip the build-zip pipeline stages it as a single tarball entry
     * (manager-approuter.tar.gz, sibling of host.cloud.js) so the cockpit
     * upload stays under its 5,000-resource cap. On first access we extract
     * the tarball into /app/manager-approuter/ and cache the extraction;
     * subsequent calls short-circuit. Returns null when no v2 payload is
     * present — orchestrator handlers surface "redeploy with v2 zip" so an
     * operator running a v1-era zip on a v2 server.js sees a friendly
     * error rather than a confusing path failure.
     */
    resolveManagerApprouterDir() {
      const extracted = path.join(__dirname, "manager-approuter");
      if (fs.existsSync(extracted)) return extracted;

      const tarball = path.join(__dirname, "manager-approuter.tar.gz");
      if (fs.existsSync(tarball)) {
        fs.mkdirSync(extracted, { recursive: true });
        const r = spawnSync("tar", ["-xzf", tarball, "-C", extracted], { stdio: "inherit" });
        if (r.status !== 0) {
          try { fs.rmSync(extracted, { recursive: true, force: true }); } catch {}
          return null;
        }
        return extracted;
      }

      // Dev fallback: workspace-root packages/manager-approuter when this
      // file is run via `node cloud/server.js` from a checkout.
      const devCandidate = path.join(__dirname, "..", "..", "packages", "manager-approuter");
      if (fs.existsSync(devCandidate)) return devCandidate;
      return null;
    },
  };
}

module.exports = { createHost };
