"use strict";
// Failed actions must explain themselves (project "failure-visibility",
// server :8088 with the fixture release — see global-setup.js).
//
// The fixture's platform base needs a service instance that does not exist,
// so every Install is REFUSED before any cf change: a real failure with zero
// side effects. Locks the 2026-09-03 lesson ("no logs, nothing"): a failed
// action stays on the page with what failed, what was said and what to do
// next; the status refresh that follows every action must not wipe it; the
// terminal drawer ends with a red summary line; a report can be copied.

const { test, expect } = require("@playwright/test");
const { execFileSync } = require("child_process");

const APP_ID = "b2b-archiving-setup-e2e";
const isRpc = (name) => (r) => decodeURIComponent(r.url()).includes("/rpc/" + name);

test.use({ permissions: ["clipboard-read", "clipboard-write"] });

test("a refused install stays visible (where / what / next), survives the status refresh, opens the terminal, copies a report, can be dismissed", async ({ page }) => {
  await page.goto("/#/apps");
  await expect(page.locator("h1.pane-title")).toHaveText("Figaf L3 applications");
  const row = page.locator(`.l3-app-row[data-app="${APP_ID}"]`);
  await expect(row).toContainText("Not installed");
  const panel = page.locator('[data-outcome="error"]');
  await expect(panel).toHaveCount(0);

  // Both waits BEFORE the click: the install answer, then the status refresh
  // the screen runs right after every action (the one that used to wipe the
  // error). The page-load status has already answered — the row says
  // "Not installed" — so the second wait can only catch the post-action one.
  const installDone = page.waitForResponse(isRpc("l3:install"));
  const statusAfter = page.waitForResponse(isRpc("l3:status"));
  await row.getByRole("button", { name: /^Install / }).click();

  const result = await (await installDone).json();
  expect(result.ok).toBe(false);
  expect(result.error).toMatch(/required service instance\(s\) missing: figaf-l3l4-e2e-missing/);

  // 1. The outcome panel: action + app, the error, the next step.
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("Install of B2B Archiving Setup (e2e fixture) failed");
  await expect(panel).toContainText("figaf-l3l4-e2e-missing");
  await expect(panel).toContainText("Create the base services first");

  // 2. The refresh comes back, the row is re-rendered — and the panel stays.
  await statusAfter;
  await expect(row).toContainText("Not installed");
  await expect(panel).toBeVisible();

  // 3. The terminal drawer ends the action with one red line.
  await panel.getByRole("button", { name: "Show CLI output" }).click();
  const terminal = page.locator(".terminal");
  await expect(terminal).toBeVisible();
  await expect(terminal).toContainText(`install ${APP_ID} FAILED: required service instance(s) missing`);
  await expect(terminal.locator(".t-err").last()).toContainText("FAILED");

  // 4. Copy report: a self-contained text for a support ticket.
  await panel.getByRole("button", { name: "Copy report" }).click();
  await expect(panel.getByRole("button", { name: "Copied" })).toBeVisible();
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toContain("Figaf App Manager - action report");
  expect(clip).toContain("release: 0.0.0-e2e");
  expect(clip).toContain("action: Install of B2B Archiving Setup (e2e fixture)");
  expect(clip).toContain("figaf-l3l4-e2e-missing");
  expect(clip).toContain("next: Create the base services first");
  expect(clip).not.toMatch(/Token:/);

  // 5. Dismiss removes it; nothing else changed.
  await panel.getByRole("button", { name: "Dismiss" }).click();
  await expect(panel).toHaveCount(0);
  await expect(row).toContainText("Not installed");
});

test("the refused install touched nothing in Cloud Foundry", async () => {
  const cf = process.platform === "win32" ? "cf.exe" : "cf";
  for (const name of ["figaf-l3l4-e2e-backend", "figaf-l3-e2e-frontend"]) {
    let exists = true;
    try { execFileSync(cf, ["app", name, "--guid"], { stdio: ["ignore", "pipe", "pipe"] }); } catch { exists = false; }
    expect(exists, `${name} must not exist`).toBe(false);
  }
});

test("a failed status refresh is shown too (the manager answers, the space listing fails)", async ({ page }) => {
  // The fixture server has a real cf login, so l3:status succeeds. This spec
  // only pins the UI contract on the RPC surface: a status error opens the
  // panel with the "Status refresh" title. It intercepts ONE status answer.
  await page.route("**/rpc/l3%3Astatus", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: false, error: "cf curl /v3/apps failed — are you logged in and targeted?" }) });
    await page.unroute("**/rpc/l3%3Astatus");
  });
  await page.goto("/#/apps");
  const panel = page.locator('[data-outcome="error"]');
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("Status refresh failed");
  await expect(panel).toContainText("Sign in again on Session & access");
});


// ─── one action at a time (2026-09-04) ──────────────────────────────────────
// Live failure: Install was pressed a second time while the shared backend
// was staging. Cloud Foundry keeps a freshly pushed app STOPPED for the whole
// staging time, so the row invited the second click; the second push replaced
// the package and the running build was dropped.

test("a second lifecycle action is refused while one is running, and changes nothing", async ({ page }) => {
  await page.goto("/#/apps");
  await expect(page.locator("h1.pane-title")).toHaveText("Figaf L3 applications");

  // Two installs fired together: the first takes the lock and spawns cf, the
  // second must be refused. Retried a few times so a slow first spawn cannot
  // make this flaky.
  let pair = null;
  for (let attempt = 0; attempt < 5 && !pair; attempt++) {
    const results = await page.evaluate(async (appId) => {
      const call = () => fetch("/rpc/l3%3Ainstall", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appId }),
        credentials: "same-origin",
      }).then((r) => r.json());
      return Promise.all([call(), call()]);
    }, APP_ID);
    if (results.some((r) => r && r.busy)) pair = results;
  }
  expect(pair, "one of two parallel installs must be refused as busy").not.toBeNull();
  const busy = pair.find((r) => r.busy);
  expect(busy.ok).toBe(false);
  expect(busy.error).toMatch(/install of b2b-archiving-setup-e2e is already running \(started/);
  expect(busy.running.action).toBe("install");
  // The other one is the normal early refusal of this fixture — no cf change.
  const other = pair.find((r) => !r.busy);
  expect(other.error).toMatch(/required service instance\(s\) missing/);

  // Nothing runs any more, and the row is untouched.
  const running = await page.evaluate(() =>
    fetch("/rpc/l3%3Arunning", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}", credentials: "same-origin" }).then((r) => r.json()));
  expect(running.running).toBeNull();
  await expect(page.locator(`.l3-app-row[data-app="${APP_ID}"]`)).toContainText("Not installed");
});

test("a deploy started elsewhere shows as Installing… and every action button is off", async ({ page }) => {
  // The manager reports the in-flight action with every status, so a page
  // that did not start it (a reload, a second tab) shows it too. Simulated on
  // the RPC seam — the same contract l3:status carries live.
  await page.route("**/rpc/l3%3Astatus", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        running: { action: "install", appId: APP_ID, startedAt: Date.now() - 40_000 },
        platform: {
          id: "platform", name: "Platform base (e2e fixture)", status: "installing",
          installedVersion: null, catalogVersion: "0.0.0-e2e",
          parts: [{ name: "figaf-l3l4-e2e-backend", exists: true, state: "STOPPED", staging: true, route: null }],
        },
        apps: [{
          id: APP_ID, name: "B2B Archiving Setup (e2e fixture)", status: "installing",
          installedVersion: null, catalogVersion: "0.0.0-e2e",
          parts: [{ name: "figaf-l3-e2e-frontend", exists: false, state: null, route: null }],
        }],
      }),
    });
  });
  await page.goto("/#/apps");
  const row = page.locator(`.l3-app-row[data-app="${APP_ID}"]`);
  await expect(row).toContainText("Installing…");
  await expect(row).toContainText("installing…");                 // the busy pill
  await expect(page.locator("[data-platform-row]")).toContainText("staging");
  // No button on the row may invite a second deploy.
  for (const b of await row.getByRole("button").all()) {
    expect(await b.isDisabled(), `${(await b.textContent()) || ""} must be disabled`).toBe(true);
  }
  await page.unroute("**/rpc/l3%3Astatus");
});


// ─── Update installation (release store, decision 0010) ─────────────────────
// The fixture server is a LOCAL release source with one version and an empty
// space (nothing installed). Update installation must be refused before any
// cf change, and the refusal must be visible like every other failed action.

test("a refused Update installation is visible: panel with the version rule, terminal line, report; nothing changes", async ({ page }) => {
  // The real l3:releases of this fixture offers nothing to update (nothing is
  // installed). Pretend the fixture version is installed and up to date, so
  // the panel shows the repair action "Re-deploy everything" (the same
  // l3:update {version} call as an update); the real handler then refuses it
  // - the failure path.
  await page.route("**/rpc/l3%3Areleases", async (route) => {
    await route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify({
        ok: true, source: { kind: "local", location: "fixture", label: "fixture (local directory, development)" },
        installed: "0.0.0-e2e", latest: "0.0.0-e2e", current: "0.0.0-e2e", updateAvailable: false,
        versions: [{ version: "0.0.0-e2e", publishedAt: null, installed: true, latest: true, selectable: true, reason: null }],
      }),
    });
  });
  await page.goto("/#/apps");
  const panel = page.locator("[data-release-panel]");
  await expect(panel.locator("[data-release-uptodate]")).toContainText("Up to date. Nothing newer than 0.0.0-e2e");
  await expect(panel.locator("[data-release-target]")).toHaveCount(0); // up to date: no dropdown, no "Update installation"
  await expect(panel.getByRole("button", { name: /^Update installation/ })).toHaveCount(0);
  await panel.getByRole("button", { name: "Re-deploy everything at 0.0.0-e2e" }).click();
  const done = page.waitForResponse(isRpc("l3:update"));
  await panel.getByRole("button", { name: "Confirm: re-deploy everything at 0.0.0-e2e" }).click();
  const result = await (await done).json();
  expect(result.ok).toBe(false);
  expect(result.error).toMatch(/nothing is installed yet/);

  const outcome = page.locator('[data-outcome="error"]');
  await expect(outcome).toBeVisible();
  await expect(outcome).toContainText("Update of installation to 0.0.0-e2e failed");
  await expect(outcome).toContainText("nothing is installed yet");
  await expect(outcome).toContainText("One version per installation");
  await outcome.getByRole("button", { name: "Show CLI output" }).click();
  await expect(page.locator(".terminal")).toBeVisible();
  await expect(page.locator(".terminal")).toContainText("update installation to 0.0.0-e2e FAILED");
  await expect(page.locator(`.l3-app-row[data-app="${APP_ID}"]`)).toContainText("Not installed");
  await page.unroute("**/rpc/l3%3Areleases");
});
