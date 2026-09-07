"use strict";
// The release store (figaf-faid decision 0010), end to end on the REMOTE
// code path: the manager on :8089 has FIGAF_FAID_RELEASE_URL pointing at a
// static server (:8090) that serves e2e/fixtures/store in the bucket layout,
// two versions (0.0.1, 0.0.2). No internet, and no cf change: the fixture's
// required service instance does not exist, so any Install is refused early.
//
// What is pinned here:
//   - the page names the source and lists installed / latest / every version;
//   - the catalog of the LATEST version is used on an empty space;
//   - every read of the store is a visible ">> GET" line, files are verified;
//   - Update refuses when nothing is installed, and refuses unknown versions;
//   - Install refuses a version other than latest on an empty space;
//   - Refresh releases reads index.json again.

const { test, expect } = require("@playwright/test");

const APP_ID = "b2b-archiving-setup-e2e-store";
const STORE = "http://127.0.0.1:8090/faid";

async function rpc(page, channel, body) {
  return page.evaluate(async ({ channel, body }) => {
    const r = await fetch("/rpc/" + encodeURIComponent(channel), {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}), credentials: "same-origin",
    });
    return r.json();
  }, { channel, body });
}

test("the page names the release store, its versions, and works with the latest one on an empty space", async ({ page }) => {
  await page.goto("/#/apps");
  await expect(page.locator("h1.pane-title")).toHaveText("FAID Apps");
  await expect(page.locator(".pane-desc")).toContainText("release 0.0.2");

  const panel = page.locator("[data-release-panel]");
  await expect(panel).toBeVisible();
  await expect(panel.locator("[data-release-source]")).toHaveText(STORE);
  await expect(panel.locator("[data-release-installed]")).toHaveText("—");
  await expect(panel.locator("[data-release-latest]")).toHaveText("0.0.2");
  await expect(panel).toContainText("0.0.1");
  await expect(panel).toContainText("0.0.2 (latest)");
  await expect(panel).toContainText("Nothing is installed yet. Install uses the latest release, 0.0.2.");
  await expect(panel.locator("[data-release-target]")).toHaveCount(0); // no dropdown without an installation

  const row = page.locator(`.faid-app-row[data-app="${APP_ID}"]`);
  await expect(row).toContainText("Not installed");
  await expect(row).toContainText("release: 0.0.2");
  await expect(row.getByRole("button", { name: "Install 0.0.2" })).toBeVisible();
  await expect(page.locator("[data-platform-row]")).toContainText("release: 0.0.2");

  // Transparency: an explicit refresh reads index.json again (the page's own
  // reads reuse a 30 s memo and the cached, verified files silently) and
  // shows the verification of the cached files. Downloads of a version happen
  // once per container; the first one was this server's boot page, so the
  // `>> GET …/catalog.json` lines are not part of this page's drawer.
  await page.locator(".terminal-bar").click();
  const terminal = page.locator(".terminal");
  const done = page.waitForResponse((r) => decodeURIComponent(r.url()).includes("/rpc/faid:releases"));
  await panel.getByRole("button", { name: "Refresh releases" }).click();
  await done;
  await expect(terminal).toContainText(`>> GET ${STORE}/index.json`);
  await expect(terminal).toContainText(`release 0.0.2 from ${STORE}: checking the cached files`);
  await expect(terminal).toContainText("catalog.json");
  await expect(terminal).toContainText("sha256 ok (cached)");
  // No zip is downloaded before an install needs it.
  expect(await terminal.innerText()).not.toContain("backend.zip");
});

test("Refresh releases reads index.json again; the page's own reads do not flood the drawer", async ({ page }) => {
  await page.goto("/#/apps");
  const panel = page.locator("[data-release-panel]");
  await expect(panel.locator("[data-release-latest]")).toHaveText("0.0.2");
  await page.locator(".terminal-bar").click();
  const terminal = page.locator(".terminal");
  const count = async () => (await terminal.innerText()).split(`>> GET ${STORE}/index.json`).length - 1;
  const before = await count();
  for (let i = 0; i < 2; i++) {
    const done = page.waitForResponse((r) => decodeURIComponent(r.url()).includes("/rpc/faid:releases"));
    await panel.getByRole("button", { name: "Refresh releases" }).click();
    await done;
  }
  await expect.poll(count).toBe(before + 2);
  // The page load itself (catalog, status, services, releases) produced no
  // "cached" chatter: those lines appear only on an explicit refresh.
  const text = await terminal.innerText();
  expect((text.match(/checking the cached files/g) || []).length).toBe(2);
});

test("Update refuses when nothing is installed and for unknown versions; Install refuses a version other than latest on an empty space; nothing changes", async ({ page }) => {
  await page.goto("/#/apps");
  await expect(page.locator(`.faid-app-row[data-app="${APP_ID}"]`)).toContainText("Not installed");

  const noInstall = await rpc(page, "faid:update", { version: "0.0.2" });
  expect(noInstall.ok).toBe(false);
  expect(noInstall.error).toMatch(/nothing is installed yet/);

  const unknown = await rpc(page, "faid:update", { version: "9.9.9" });
  expect(unknown.ok).toBe(false);
  expect(unknown.error).toMatch(/version 9\.9\.9 is not in the release store \(available: 0\.0\.2, 0\.0\.1\)/);

  const older = await rpc(page, "faid:install", { appId: APP_ID, version: "0.0.1" });
  expect(older.ok).toBe(false);
  expect(older.error).toMatch(/Install uses the latest release, 0\.0\.2, not 0\.0\.1/);

  // The normal early refusal of this fixture: the store worked, cf was not changed.
  const install = await rpc(page, "faid:install", { appId: APP_ID });
  expect(install.ok).toBe(false);
  expect(install.error).toMatch(/required service instance\(s\) missing: figaf-faid-e2e-missing/);

  const releases = await rpc(page, "faid:releases", {});
  expect(releases.ok).toBe(true);
  expect(releases.source).toMatchObject({ kind: "remote", location: STORE });
  expect(releases.installed).toBeNull();
  expect(releases.latest).toBe("0.0.2");
  expect(releases.versions.map((v) => v.version)).toEqual(["0.0.2", "0.0.1"]);
  expect(releases.versions.every((v) => v.selectable === false)).toBe(true);
  await expect(page.locator(`.faid-app-row[data-app="${APP_ID}"]`)).toContainText("Not installed");
});
