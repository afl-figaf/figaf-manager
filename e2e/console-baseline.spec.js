"use strict";
// Console-frame specs (the default hosted frame since the redesign).
// The signed-in state comes from the seeded cf login (see global-setup.js);
// every cf-backed assertion runs against the real space. READ-ONLY: these
// specs never install, remove, or start a deploy.
//
// The local server runs in TOKEN mode (no XSUAA binding): the space counts as
// "not prepared", so the Setup page is the landing page and the pages that
// need a prepared space are disabled in the rail (docs/faid-apps-console/SPEC.md section 6).
// Deep links still open them - that is how the specs below reach them.

const { test, expect } = require("@playwright/test");

const isRpc = (name) => (r) => decodeURIComponent(r.url()).includes("/rpc/" + name);

test("unauthenticated visitor is redirected to /setup", async ({ browser }) => {
  const context = await browser.newContext({ storageState: undefined });
  const page = await context.newPage();
  const resp = await page.goto("/");
  expect(resp.url()).toContain("/setup");
  await context.close();
});

test("signed-in reload lands on the Setup page (#/setup) while the space is not prepared, no wizard", async ({ page }) => {
  await page.goto("/");
  // Auto sign-in: session resume or stored user; then the console landing page.
  await expect(page.locator("h1.pane-title")).toHaveText("Set up this installation");
  expect(page.url()).toContain("#/setup");
  // The rail is navigation now, not wizard steps: Setup + five pages.
  await expect(page.locator(".cnav-item")).toHaveCount(6);
  await expect(page.locator('.cnav-item[data-route="setup"]')).toHaveClass(/is-active/);
  // Signed-in footer shows who the manager works as.
  await expect(page.locator(".rail-foot")).toContainText("/");
});

test("setup page: five steps in the install order, step 1 current, the rest done or 'after step 1'; the progress pill and the rail agree", async ({ page }) => {
  await page.goto("/#/setup");
  const list = page.locator('[data-setup-page=""]');
  await expect(list).toContainText("Installation progress");
  await expect(list.locator('[data-setup-progress=""]')).toHaveText(/^\d of 5 done$/);
  const steps = list.locator(".setup-step");
  await expect(steps).toHaveCount(5);
  await expect(steps.nth(0)).toContainText("1. Prepare the space");
  await expect(steps.nth(1)).toContainText("2. Management user");
  await expect(steps.nth(2)).toContainText("3. Base services");
  await expect(steps.nth(3)).toContainText("4. Shared backend and first app");
  await expect(steps.nth(4)).toContainText("5. Figaf tool connection");
  await expect(list.locator(".setup-step.is-current")).toHaveCount(1);
  await expect(list.locator('.setup-step[data-step="prepare"]')).toHaveClass(/is-current/);
  // The local server runs in token mode, so step 1 is never done here and every
  // later step is blocked "after step 1" - unless the dev space already holds the
  // thing the step checks (a running shared backend, a stored user): a done step
  // is done whatever the mode, and shows neither the block nor a body.
  for (const id of ["mgmt-user", "services", "platform", "figaf-connection"]) {
    const step = list.locator(`.setup-step[data-step="${id}"]`);
    const done = /\bis-done\b/.test((await step.getAttribute("class")) || "");
    if (done) await expect(step).toContainText("done");
    else await expect(step).toContainText("after step 1");
    // Blocked and done steps show no body: no buttons, no forms.
    await expect(step.locator(".setup-step-body")).toHaveCount(0);
  }
  // Every open step explains itself (why-line); step 1 names the passcode and the restart.
  const openSteps = list.locator(".setup-step:not(.is-done)");
  expect(await list.locator(".setup-why").count()).toBe(await openSteps.count());
  const prepare = list.locator('.setup-step[data-step="prepare"]');
  await expect(prepare).toContainText("passcode");
  await expect(prepare).toContainText("30-90 s");
  // The rail's Setup entry carries the same count.
  await expect(page.locator('.cnav-item[data-route="setup"] .cnav-sub')).toHaveText(/^\d of 5 done$/);
});

test("setup step 1 (signed in): asks for the plans and the role assignment BEFORE the run; a dropdown only for a missing instance with a choice; nothing is clicked", async ({ page }) => {
  await page.goto("/#/setup");
  const body = page.locator('[data-body="prepare"]');
  await expect(body).toBeVisible();
  // Service plans: the three instances of the release. The dev space's state
  // varies between runs (wiped for a virgin run, or fully provisioned), so the
  // spec checks the rule, not one state: an existing instance shows "exists";
  // a missing one with more than one plan shows a dropdown with a note;
  // a missing one with a single plan (xsuaa) shows the plan only.
  const plans = body.locator('[data-panel="service-plans"]');
  await expect(plans).toContainText("Service plans");
  // Three required instances, one row each; the optional PI/PO pair (catalog v4,
  // decision 0011) is ONE group row with a checkbox that is off by default.
  await expect(plans.locator(".setup-plan-row[data-service]")).toHaveCount(3);
  const pipo = plans.locator('.setup-plan-row[data-service-group="pipo"]');
  await expect(pipo).toHaveCount(1);
  await expect(pipo.locator('input[type="checkbox"]')).not.toBeChecked();
  await expect(pipo).toContainText("figaf-connectivity");
  await expect(pipo).toContainText("figaf-destination");
  for (const name of ["figaf-faid-db", "figaf-faid-xsuaa", "figaf-faid-credstore"]) {
    const row = plans.locator(`.setup-plan-row[data-service="${name}"]`);
    await expect(row).toContainText(name);
    const exists = (await row.locator(".pill", { hasText: "exists" }).count()) === 1;
    const dropdowns = await row.locator("select").count();
    if (exists) {
      expect(dropdowns).toBe(0);
    } else if (name === "figaf-faid-xsuaa") {
      expect(dropdowns).toBe(0);                    // one plan: nothing to choose
      await expect(row).toContainText("plan application");
    } else {
      expect(dropdowns).toBe(1);                    // free / standard: the person decides
      await expect(row.locator("select")).toHaveValue("free");
      await expect(row).toContainText(/small limits|paid plan/);
    }
  }
  const anyChoice = (await plans.locator("select").count()) > 0;
  await expect(plans).toContainText(anyChoice ? "Plans that cost money are your decision" : "They all exist already");
  // Role assignment: no BTP login locally - the panel says so and offers it first.
  const role = body.locator('[data-panel="role-assign"]');
  await expect(role).toContainText("no BTP login");
  await expect(role).toContainText("before the last restart does not count");
  await expect(role.getByRole("button", { name: "Add BTP login first" })).toBeVisible();
  await expect(role.locator('input[type="checkbox"]')).toHaveCount(0);
  // The primary button names the consequence. It is NOT clicked.
  await expect(body.getByRole("button", { name: "Prepare the space without role assignment" })).toBeVisible();
  // The phases of the run are listed up front (no assign-role row without the BTP login).
  await expect(body.locator(".task-list .check-row")).toHaveCount(6); // cf target + 5 phases
  await expect(body).toContainText("Prepare the XSUAA instance");
  await expect(body).toContainText("Create the base services");
  await expect(body).toContainText("Deploy approuter");
  await expect(body).toContainText("Restart manager");
  await expect(body).not.toContainText("Assign role collection");
});

test("rail: the pages that need a prepared space are disabled in token mode and lead to the Setup; Session & access and About open", async ({ page }) => {
  await page.goto("/#/setup");
  for (const id of ["apps", "connections", "figaf-tool"]) {
    const item = page.locator(`.cnav-item[data-route="${id}"]`);
    await expect(item).toHaveClass(/is-disabled/);
    await expect(item).toHaveAttribute("data-locked", "1");
    await expect(item.locator(".cnav-sub")).toHaveText("after step 1 (Setup)");
  }
  // A person can still click the greyed-out entry; it leads to the Setup.
  // (force: Playwright's own actionability check refuses aria-disabled items.)
  await page.locator('.cnav-item[data-route="apps"]').click({ force: true });
  expect(page.url()).toContain("#/setup");
  await expect(page.locator("h1.pane-title")).toHaveText("Set up this installation");

  await page.locator('.cnav-item[data-route="session"]').click();
  await expect(page.locator("h1.pane-title")).toHaveText("Who the manager works as");
  expect(page.url()).toContain("#/session");

  await page.locator('.cnav-item[data-route="about"]').click();
  await expect(page.locator("h1.pane-title")).toHaveText("Figaf Manager");
  expect(page.url()).toContain("#/about");
});

test("deep link #/apps still opens the dashboard, with the setup notice; the base services are a one-line status, the panel lives on the Setup", async ({ page }) => {
  await page.goto("/#/apps");
  await expect(page.locator("h1.pane-title")).toHaveText("FAID Apps");
  const notice = page.locator('[data-setup-notice=""]');
  await expect(notice).toContainText("Setup not finished");
  await expect(notice).toContainText("Next: step 1, Prepare the space");
  // One line per instance with its real state; the repair link appears only
  // when something is not ready (the dev space's state varies between runs).
  const summary = page.locator('[data-services-summary=""]');
  await expect(summary).toContainText("Base services");
  await expect(summary.locator(".pill")).toHaveText(/^(all ready|\d not ready)$/);
  await expect(summary).toContainText(/figaf-faid-db: (ready|missing|in-progress|failed)/);
  await expect(summary).toContainText("figaf-faid-xsuaa:");
  await expect(summary).toContainText("figaf-faid-credstore:");
  const allReady = (await summary.locator(".pill").textContent()) === "all ready";
  await expect(summary.getByRole("button", { name: "Repair in Setup (step 3)" })).toHaveCount(allReady ? 0 : 1);
  // No creation button and no checklist banner on the dashboard any more.
  await expect(page.getByRole("button", { name: /Create missing services/ })).toHaveCount(0);
  await expect(page.locator(".setup-checklist")).toHaveCount(0);
  await notice.getByRole("button", { name: "Open Setup" }).click();
  expect(page.url()).toContain("#/setup");
});

test("setup page re-reads the management-user and Figaf states when it is shown again", async ({ page }) => {
  // Run #3 finding 4: after storing the management user elsewhere, the step
  // stayed "current step" until a page reload. The page must read those two
  // states again every time it comes back into view.
  await page.goto("/#/setup");
  await expect(page.locator('[data-setup-page=""]')).toBeVisible();
  await page.locator('.cnav-item[data-route="session"]').click();
  await expect(page.locator("h1.pane-title")).toHaveText("Who the manager works as");
  const storedRead = page.waitForRequest(isRpc("login:storedUserStatus"));
  const figafRead = page.waitForRequest(isRpc("connections:figafStatus"));
  await page.locator('.cnav-item[data-route="setup"]').click();
  await Promise.all([storedRead, figafRead]);
  await expect(page.locator('[data-setup-page=""]')).toBeVisible();
});

test("session page: access map first, then CF session, BTP, management user - and no Secure access card any more", async ({ page }) => {
  await page.goto("/#/session");
  await expect(page.locator("h1.pane-title")).toHaveText("Who the manager works as");
  const map = page.locator(".access-map");
  await expect(map).toContainText("How this manager signs you in");
  await expect(map.locator(".access-row")).toHaveCount(4);
  for (const name of ["Browser access", "Cloud Foundry login", "SAP BTP login", "Management user"]) {
    await expect(map.locator(`.access-row[data-access="${name}"] .access-purpose`)).not.toBeEmpty();
  }
  // Locally the manager runs in token mode: bootstrap mode, setup token, until step 1 of the Setup.
  await expect(map).toContainText("bootstrap mode");
  await expect(map.locator('.access-row[data-access="Browser access"]')).toContainText("setup token");
  await expect(map.locator('.access-row[data-access="Browser access"]')).toContainText("step 1 of the Setup");
  await expect(map.locator('.access-row[data-access="Cloud Foundry login"]')).toContainText("signed in");
  await expect(page.getByText("Cloud Foundry session")).toBeVisible();
  await expect(page.getByText("SAP BTP session")).toBeVisible();
  await expect(page.getByText("Management user (automatic sign-in)")).toBeVisible();
  await expect(page.locator('[data-card="persistent-sso"]')).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Start upgrade" })).toHaveCount(0);
});

test("the old route #/session/sso-upgrade opens the Setup", async ({ page }) => {
  await page.goto("/#/session/sso-upgrade");
  await expect(page.locator("h1.pane-title")).toHaveText("Set up this installation");
  expect(page.url()).toContain("#/setup");
});

test("figaf tool hub offers neither the SSO upgrade nor the Setup's work", async ({ page }) => {
  await page.goto("/#/figaf-tool");
  await expect(page.locator("h1.pane-title")).toHaveText("Figaf Tool deployments");
  await expect(page.getByRole("button", { name: "Start upgrade" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Prepare the space/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Start update" })).toBeVisible();
});

test("/health reports token state without the value (token mode, claimed by this harness)", async ({ page }) => {
  const r = await page.request.get("/health");
  expect(r.status()).toBe(200);
  const j = await r.json();
  expect(j.mode).toBe("token");
  expect(j.tokenMinted).toBe(true);
  expect(j.claimed).toBe(true);
  expect(JSON.stringify(j)).not.toMatch(/Token:/);
});

test("about page shows version, update state, and environment checks", async ({ page }) => {
  await page.goto("/#/about");
  await expect(page.locator(".pane-desc .kbd")).toContainText("v");
  await expect(page.getByText("Manager updates")).toBeVisible();
  await expect(page.getByText("Environment checks")).toBeVisible();
  // The hosted checks: bundled CLIs + container marked ok, Docker Hub probed.
  await expect(page.getByText("bundled in container").first()).toBeVisible();
  // Versions card (2026-09-04): what the manager runs with, against the build's pins.
  await expect(page.getByText("Versions", { exact: true })).toBeVisible();
  await expect(page.getByText("Node.js runtime")).toBeVisible();
  await expect(page.getByText("cf CLI", { exact: true })).toBeVisible();
  // The cf row carries a real version once the check ran (the dev machine's cf).
  await expect(page.locator('[data-version-row="cf CLI"] .kbd')).not.toHaveText("…", { timeout: 30000 });
});

test("figaf tool hub starts the update flow as a local stepper, and abandon returns", async ({ page }) => {
  await page.goto("/#/figaf-tool");
  await expect(page.locator("h1.pane-title")).toHaveText("Figaf Tool deployments");
  await page.getByRole("button", { name: "Start update" }).click();
  // The flow renders inside the page with a local stepper strip.
  await expect(page.locator(".flow-strip")).toBeVisible();
  await expect(page.locator(".flow-chip.is-active")).toContainText("Configure update");
  await expect(page.locator("h1.pane-title")).toHaveText("Update Figaf Tool");
  // Leaving the flow returns to the hub.
  await page.getByRole("button", { name: "← Figaf Tool overview" }).click();
  await expect(page.locator("h1.pane-title")).toHaveText("Figaf Tool deployments");
});

test("deep link #/connections opens directly after auto sign-in, with the setup notice", async ({ page }) => {
  await page.goto("/#/connections");
  await expect(page.locator("h1.pane-title")).toHaveText("Figaf tool & SAP systems");
  await expect(page.locator('[data-setup-notice=""]')).toContainText("Setup not finished");
});

test("fresh session, token mode: the Setup opens with the sign-in card INSIDE step 1 - no separate gate page, no wizard wording", async ({ browser }) => {
  // Keep the claimed auth cookie but drop the wizard-session cookie: the next
  // request mints a fresh server session with no cf login and (locally) no
  // stored user. This is what a new person sees right after the token claim.
  const context = await browser.newContext({ storageState: "e2e/.auth/state.json" });
  await context.clearCookies({ name: "figaf_session" });
  const page = await context.newPage();
  await page.goto("/");
  await expect(page.locator("h1.pane-title")).toHaveText("Set up this installation");
  expect(page.url()).toContain("#/setup");
  const signin = page.locator('[data-body="prepare-signin"]');
  await expect(signin).toContainText("First, sign in to Cloud Foundry");
  const cards = signin.locator(".login-cards > .card");
  await expect(cards).toHaveCount(2);
  await expect(cards.nth(0)).toContainText("Cloud Foundry CLI");
  await expect(cards.nth(0)).toContainText("required");
  await expect(cards.nth(0).getByRole("button", { name: /Get passcode in browser/ })).toBeVisible();
  await expect(cards.nth(1)).toContainText("SAP BTP CLI");
  await expect(cards.nth(1)).toContainText("Optional");
  await expect(page.getByText("Step 2", { exact: false })).toHaveCount(0);
  await expect(page.getByText("Sign-in method")).toHaveCount(0);
  // Nothing after step 1 is offered.
  await expect(page.getByRole("button", { name: /Prepare the space/ })).toHaveCount(0);
  await expect(page.locator('.cnav-item[data-route="apps"]')).toHaveClass(/is-disabled/);
  await context.close();
});

test("fresh session, deep link to a page that needs cf: the gate renders as a gate (no wizard wording)", async ({ browser }) => {
  const context = await browser.newContext({ storageState: "e2e/.auth/state.json" });
  await context.clearCookies({ name: "figaf_session" });
  const page = await context.newPage();
  await page.goto("/#/apps");
  await expect(page.locator("h1.pane-title")).toHaveText("Sign in to Cloud Foundry");
  await expect(page.getByText("Step 2", { exact: false })).toHaveCount(0);
  await expect(page.getByText("Sign-in method")).toHaveCount(0);
  const cards = page.locator(".login-cards > .card");
  await expect(cards).toHaveCount(2);
  await expect(cards.nth(0)).toContainText("Cloud Foundry CLI");
  await expect(cards.nth(0).getByRole("button", { name: /Get passcode in browser/ })).toBeVisible();
  await expect(cards.nth(1).getByRole("button", { name: "Sign in with SSO instead" })).toBeVisible();
  await expect(page.locator(".pane-foot")).toHaveCount(0);
  // The rail stays usable: About needs no CF session.
  await page.locator('.cnav-item[data-route="about"]').click();
  await expect(page.locator("h1.pane-title")).toHaveText("Figaf Manager");
  await context.close();
});
