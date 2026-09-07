"use strict";
// Boots the real cloud server(s) locally, claims each single-use setup token,
// and seeds every browser session's scoped CF_HOME with the developer's own
// cf login (see e2e/README.md — dev machine only, never product code).
// Returns a teardown function that stops the servers.
//
// Servers (pick with E2E_SERVERS=main,failure,remote; default: all three):
//   main     :8087  the locally built release (apps/figaf-manager/platform-artifacts,
//                   a LOCAL release source). The read-only console specs and
//                   the deliberate install smoke (*.mutating.spec.js) run here.
//   failure  :8088  the fixture release e2e/fixtures/release-missing-service
//                   (local source): its platform base needs a service instance
//                   that does not exist, so every Install is refused EARLY,
//                   before any cf change. failure-visibility.spec.js runs here.
//   remote   :8089  a REMOTE release source: FIGAF_PLATFORM_RELEASE_URL points at a
//                   static file server on :8090 that serves the fixture store
//                   e2e/fixtures/store (bucket layout, two versions; built by
//                   e2e/tools/make-fixture-store.js). release-store.spec.js
//                   runs here: the same code path as Cloudflare R2, no
//                   internet, no cf change (the fixture's service is missing).
//
// All servers run with apps/figaf-manager as their working directory — the
// same shape as the CF container (manifest.yml next to the server). A
// manifest leaking into `cf push` therefore shows up locally exactly as it
// did live on 2026-09-03.

const { chromium } = require("@playwright/test");
const { spawn } = require("child_process");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const STORE_PORT = 8090;
const STORE_DIR = path.join(__dirname, "fixtures", "store");

const SERVERS = {
  main: {
    port: 8087,
    state: "state.json",
    env: { FIGAF_PLATFORM_ARTIFACTS_DIR: path.join(__dirname, "..", "apps", "figaf-manager", "platform-artifacts") },
  },
  failure: {
    port: 8088,
    state: "state-failure.json",
    env: { FIGAF_PLATFORM_ARTIFACTS_DIR: path.join(__dirname, "fixtures", "release-missing-service") },
  },
  remote: {
    port: 8089,
    state: "state-remote.json",
    // An empty FIGAF_PLATFORM_ARTIFACTS_DIR counts as unset (host.cloud.js), so the
    // developer's own environment cannot turn this server into a local source.
    env: { FIGAF_PLATFORM_ARTIFACTS_DIR: "", FIGAF_PLATFORM_RELEASE_URL: `http://127.0.0.1:${STORE_PORT}/platform` },
  },
};

// The fixture release store: plain files under e2e/fixtures/store, served as
// a bucket would serve them (GET <url>/platform/index.json, <url>/platform/<v>/<file>).
function startStoreServer() {
  const types = { ".json": "application/json", ".zip": "application/zip" };
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent((req.url || "/").split("?")[0]).replace(/^\/+/, "");
    const file = path.normalize(path.join(STORE_DIR, rel));
    if (!file.startsWith(STORE_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
      return;
    }
    res.writeHead(200, { "Content-Type": types[path.extname(file)] || "application/octet-stream", "Content-Length": fs.statSync(file).size });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(STORE_PORT, "127.0.0.1", () => resolve(server));
  });
}

async function bootServer(name, def) {
  const tag = `[e2e:${name}]`;
  const appDir = path.join(__dirname, "..", "apps", "figaf-manager");
  const base = `http://127.0.0.1:${def.port}`;
  const child = spawn(process.execPath, ["cloud/server.js"], {
    cwd: appDir,
    env: { ...process.env, ...def.env, PORT: String(def.port) },
    stdio: ["ignore", "pipe", "pipe"],
  });

  // The setup token is printed exactly once to stdout at boot.
  let out = "";
  const token = await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${tag} no [SETUP] token within 15s. Server output:\n` + out)),
      15_000
    );
    const onData = (d) => {
      out += d.toString();
      const m = /\[SETUP\] Token: (\S+)/.exec(out);
      if (m) { clearTimeout(timer); resolve(m[1]); }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`${tag} server exited early (code ${code}). Output:\n` + out));
    });
  });
  await new Promise((resolve, reject) => {
    const t0 = Date.now();
    (function poll() {
      if (/listening on :/.test(out)) return resolve();
      if (Date.now() - t0 > 15_000) return reject(new Error(`${tag} server not listening. Output:\n` + out));
      setTimeout(poll, 100);
    })();
  });

  // Claim from a real browser context: the auth cookie is HMAC-bound to the
  // claiming IP + user agent, so the claim must use the same UA the specs use.
  const browser = await chromium.launch();
  const context = await browser.newContext({ baseURL: base });
  const page = await context.newPage();
  const resp = await page.request.post("/setup/claim", { data: { token } });
  if (!resp.ok()) {
    throw new Error(`${tag} setup claim failed: HTTP ${resp.status()} ${await resp.text()}`);
  }

  // Load the app once so the server mints the wizard session (figaf_session
  // cookie + server-side state), then seed that session's scoped CF_HOME with
  // the developer's own cf login so `session:state` resumes as signed-in.
  await page.goto("/");
  const sid = await page.evaluate(
    () => window.figafSession && window.figafSession.sessionId
  );
  if (!sid || !/^[0-9a-f]{32}$/.test(String(sid))) {
    throw new Error(`${tag} could not read the wizard session id from the page`);
  }
  const cfConfig = path.join(os.homedir(), ".cf", "config.json");
  if (fs.existsSync(cfConfig)) {
    // cf reads $CF_HOME/.cf/config.json — note the .cf level.
    const dstDir = path.join(os.homedir(), "sessions", sid, "cli", ".cf");
    fs.mkdirSync(dstDir, { recursive: true });
    fs.copyFileSync(cfConfig, path.join(dstDir, "config.json"));
  } else {
    // Specs that need a signed-in session will fail with a clear message.
    console.warn(`${tag} no ~/.cf/config.json — run \`cf login\` once; continuing without a seeded session`);
  }

  fs.mkdirSync(path.join(__dirname, ".auth"), { recursive: true });
  await context.storageState({ path: path.join(__dirname, ".auth", def.state) });
  await browser.close();
  return child;
}

module.exports = async () => {
  const wanted = (process.env.E2E_SERVERS || "main,failure,remote").split(",").map((s) => s.trim()).filter(Boolean);
  const children = [];
  let storeServer = null;
  const stopAll = () => {
    for (const c of children) { try { c.kill(); } catch { /* already gone */ } }
    if (storeServer) { try { storeServer.close(); } catch { /* already closed */ } }
  };
  try {
    if (wanted.includes("remote")) {
      if (!fs.existsSync(path.join(STORE_DIR, "platform", "index.json"))) throw new Error(`fixture store missing: run node e2e/tools/make-fixture-store.js`);
      storeServer = await startStoreServer();
    }
    for (const name of wanted) {
      if (!SERVERS[name]) throw new Error(`unknown e2e server '${name}' (known: ${Object.keys(SERVERS).join(", ")})`);
      children.push(await bootServer(name, SERVERS[name]));
    }
  } catch (e) {
    stopAll();
    throw e;
  }
  return async () => { stopAll(); };
};
