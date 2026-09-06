"use strict";
// E2E harness for the hosted manager (see e2e/README.md).
// e2e/global-setup.js starts the REAL cloud server twice — :8087 with the
// bundled release, :8088 with a fixture release whose every install is
// refused early — and both run the REAL orchestrator with the REAL cf CLI
// from PATH against the space that CLI is logged into. No mocks.
//
// This default suite is READ-ONLY: it never installs, removes, or deploys.
// Mutating specs (*.mutating.spec.js — the install smoke that pushes into the
// real space) run only through playwright.mutating.config.js
// (`npm run test:e2e:install`).
const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.js",
  timeout: 60_000,
  expect: { timeout: 20_000 },
  // All specs of a project share one server-side wizard session (same
  // storageState), so they must not run concurrently.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    trace: "retain-on-failure",
  },
  projects: [
    {
      // The console against the locally built release (read-only).
      name: "console",
      testIgnore: ["**/failure-visibility.spec.js", "**/release-store.spec.js", "**/*.mutating.spec.js"],
      use: { baseURL: "http://127.0.0.1:8087", storageState: "e2e/.auth/state.json" },
    },
    {
      // Failed actions must explain themselves: driven against the fixture
      // release on :8088, where Install is refused before any cf change.
      name: "failure-visibility",
      testMatch: ["**/failure-visibility.spec.js"],
      use: { baseURL: "http://127.0.0.1:8088", storageState: "e2e/.auth/state-failure.json" },
    },
    {
      // The release store (decision 0010): the manager on :8089 reads a
      // remote store served from e2e/fixtures/store on :8090.
      name: "release-store",
      testMatch: ["**/release-store.spec.js"],
      use: { baseURL: "http://127.0.0.1:8089", storageState: "e2e/.auth/state-remote.json" },
    },
  ],
});
