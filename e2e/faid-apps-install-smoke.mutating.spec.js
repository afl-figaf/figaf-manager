"use strict";
// INSTALL SMOKE — MUTATING. Runs only through playwright.mutating.config.js:
//
//     npm run test:e2e:install
//
// It installs the bundled release into the REAL space the local cf CLI is
// targeted at, through the console (platform base first, then the app),
// verifies both run with the release version, checks the health endpoint,
// removes the app through the console and finally deletes the platform base
// (cf CLI), so the space is left as it was found. E2E_KEEP_INSTALL=1 keeps
// the installed apps.
//
// Why it exists: the unit tests run the handlers with a fake `run`; only a
// real `cf push` from the manager PROCESS can show what the process brings
// into the push. The local server runs from apps/figaf-manager, which holds
// manifest.yml — the same shape as the CF container after a cockpit upload —
// so the 2026-09-03 manifest leak would fail here exactly as it did live.
//
// Gate rule (e2e/README.md): green before every manager build that is pushed
// or uploaded.

const { test, expect } = require("@playwright/test");
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const APP_ID = process.env.E2E_APP_ID || "b2b-archiving-setup";
const RELEASE_DIR = process.env.FIGAF_PLATFORM_ARTIFACTS_DIR || path.join(__dirname, "..", "apps", "figaf-manager", "platform-artifacts");
const catalog = JSON.parse(fs.readFileSync(path.join(RELEASE_DIR, "catalog.json"), "utf8").replace(/^﻿/, ""));
const app = catalog.apps.find((a) => a.id === APP_ID);
if (!app) throw new Error(`app '${APP_ID}' is not in ${RELEASE_DIR}/catalog.json`);
const platformCfApps = ((catalog.platform && catalog.platform.cfApps) || []).map((c) => c.name);
const appCfApps = app.cfApps.map((c) => c.name);
const KEEP = process.env.E2E_KEEP_INSTALL === "1";
const CF = process.platform === "win32" ? "cf.exe" : "cf";
const isRpc = (name) => (r) => decodeURIComponent(r.url()).includes("/rpc/" + name);

function cf(args) { return execFileSync(CF, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
function cfAppExists(name) { try { cf(["app", name, "--guid"]); return true; } catch { return false; } }

test.describe.configure({ mode: "serial" });

test.beforeAll(() => {
  console.log(`[smoke] release ${catalog.releaseVersion}, app ${APP_ID} ${app.version}; platform ${platformCfApps.join(", ")}; app ${appCfApps.join(", ")}`);
  console.log(`[smoke] cf target:\n${cf(["target"]).trim()}`);
  const present = [...platformCfApps, ...appCfApps].filter(cfAppExists);
  if (present.length) {
    throw new Error(
      `precondition failed: CF app(s) already exist in the targeted space: ${present.join(", ")}. ` +
      `The smoke installs and removes, so it needs a space without them. Remove them first: cf delete <name> -f -r`
    );
  }
});

test.afterAll(() => {
  if (KEEP) { console.log("[smoke] E2E_KEEP_INSTALL=1: the installed apps stay"); return; }
  // The console's Remove deletes only the app's own CF apps (the platform base
  // stays for other apps, by design). The smoke also deletes the platform
  // base, so the space is left as it was found.
  for (const name of [...appCfApps, ...platformCfApps]) {
    if (!cfAppExists(name)) continue;
    console.log(`[smoke] cleanup: cf delete ${name} -f -r`);
    try { cf(["delete", name, "-f", "-r"]); } catch (e) { console.warn(`[smoke] cleanup of ${name} failed: ${e.message}`); }
  }
});

test(`install ${APP_ID} ${app.version}: platform base + app end Running with the version stamped, health answers, every push isolated from any manifest`, async ({ page }) => {
  await page.goto("/#/apps");
  await expect(page.locator("h1.pane-title")).toHaveText("FAID Apps");
  const row = page.locator(`.faid-app-row[data-app="${APP_ID}"]`);
  const platformRow = page.locator("[data-platform-row]");
  const panel = page.locator('[data-outcome="error"]');
  await expect(row).toContainText("Not installed");
  await expect(platformRow).toContainText("Not installed");
  await expect(panel).toHaveCount(0);

  // Open the drawer first: the whole CLI log is then part of the trace.
  await page.locator(".terminal-bar").click();
  await expect(page.locator(".terminal")).toBeVisible();

  const installDone = page.waitForResponse(isRpc("faid:install"), { timeout: 12 * 60_000 });
  await row.getByRole("button", { name: `Install ${app.version}` }).click();
  const result = await (await installDone).json();
  // On failure the message carries the manager's own diagnosis (step, CF app, what cf said).
  expect(result, `install result: ${JSON.stringify(result, null, 2)}`).toMatchObject({ ok: true, version: app.version });

  // The rows agree.
  await expect(platformRow).toContainText("Running");
  await expect(platformRow).toContainText(`installed: ${catalog.releaseVersion}`);
  await expect(row).toContainText("Running");
  await expect(row).toContainText(`installed: ${app.version}`);
  await expect(panel).toHaveCount(0);

  // Push isolation: every cf push carried --no-manifest, no manifest was applied,
  // and the action closed with the green done line.
  const terminal = await page.locator(".terminal").innerText();
  const pushes = terminal.split("\n").filter((l) => /\bcf(?:\.exe)? push\b/.test(l));
  expect(pushes.length, terminal).toBeGreaterThanOrEqual(platformCfApps.length + appCfApps.length);
  for (const p of pushes) expect(p, p).toContain("--no-manifest");
  expect(terminal).not.toContain("Applying manifest file");
  expect(terminal).toContain(`install ${APP_ID}: done`);

  // Health: the platform base answers on its health path. Right after the
  // start the route can need a few seconds; retry the click a few times.
  if (app.healthPath) {
    let shown = false;
    for (let i = 0; i < 6 && !shown; i++) {
      const done = page.waitForResponse(isRpc("faid:health"), { timeout: 60_000 });
      await row.getByRole("button", { name: /health/i }).click();
      await done;
      shown = (await row.locator("pre").count()) > 0;
      if (!shown) {
        await panel.getByRole("button", { name: "Dismiss" }).click().catch(() => {});
        await page.waitForTimeout(10_000);
      }
    }
    expect(shown, "the health endpoint never answered with a body").toBe(true);
    await expect(row.locator("pre")).toContainText("postgres");
  }

  // Cloud Foundry agrees.
  for (const name of [...platformCfApps, ...appCfApps]) expect(cfAppExists(name), name).toBe(true);
});

test(`remove ${APP_ID} through the console: its CF apps go, the platform base stays`, async ({ page }) => {
  test.skip(KEEP, "E2E_KEEP_INSTALL=1");
  await page.goto("/#/apps");
  const row = page.locator(`.faid-app-row[data-app="${APP_ID}"]`);
  await expect(row).toContainText("Running");
  await row.getByRole("button", { name: "Remove" }).click();
  const removeDone = page.waitForResponse(isRpc("faid:remove"), { timeout: 5 * 60_000 });
  await row.getByRole("button", { name: "Confirm remove" }).click();
  const result = await (await removeDone).json();
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
  await expect(row).toContainText("Not installed");
  await expect(page.locator("[data-platform-row]")).toContainText("Running");
  await expect(page.locator('[data-outcome="error"]')).toHaveCount(0);
  for (const name of appCfApps) expect(cfAppExists(name), name).toBe(false);
  for (const name of platformCfApps) expect(cfAppExists(name), name).toBe(true);
});
