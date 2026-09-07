# CLAUDE.md

> **Session start (added 2026-09-03 for the Figaf Platform stream).** Before any task:
> 1. Read `docs/PROJECT-CONTEXT.md` — who Figaf is, the Figaf Platform, Danfoss as the first customer, the rules that apply here.
> 2. Read `docs/faid-apps-console/SPEC.md` — the current behavior of the FAID Apps console. `OPEN-ITEMS.md` and `TROUBLESHOOTING.md` sit next to it.
> 3. Then use the conventions below. They were written for the Figaf-tool wizard (Alex's product). The FAID Apps console lives in `packages/ui/console.jsx`, `packages/core/faid-apps.js`, `connections.js`, `credstore-client.js`, `manager-xsuaa.js` and `e2e/`.
>
> The governance rules of the Figaf Platform live in the figaf-platform repo (`docs/GOVERNANCE.md`). They are Figaf-owned and read-only.
>
> **Naming (figaf-platform decision 0014, 2026-09-07).** In UI text and documents: **Figaf Platform**, **Figaf Tool**, **FAID Apps** (Figaf AI-Driven Apps), **FAID Agents**. In technical names: `faid`, `faid-apps`, `faid-agents`, `platform` (for example `figaf-faid-backend`, `figaf-faid-apps-<app-id>`, scope prefix `FAID`, RPC channels `faid:*`, `FIGAF_PLATFORM_RELEASE_URL`). The old terms L2, L3 and L4 are banned in code, UI, identifiers and current documents; nothing carrying them may reach a customer.

Architecture backbone for **Figaf Installer** — an npm-workspaces monorepo that
ships **two parallel wizards** for deploying the [Figaf Tool](https://figaf.com)
to **SAP BTP Cloud Foundry**:

- **figaf-local** — a Windows Electron desktop installer.
- **figaf-manager** — a BTP-hosted (Express + WebSocket) installer that runs in
  a Cloud Foundry space and is driven from the user's browser.

Both share their entire orchestration layer and React renderer; they only
diverge at the host-environment seam (file dialogs, persistent storage, deploy
template sourcing).

---

## Packaging

- Pinned versions (2026-09-04): `btpCliVersion` and `cfCliVersion` in
  `apps/figaf-manager/package.json` are the only source of the bundled CLI
  versions; `build-zip.js` downloads exactly them, re-downloads when a pin
  changes, fails when the download does not match, and writes
  `bin/VERSIONS.json` (also the pinned npm versions and the Node engine).
  The staged `package.json` gets the exact top-level dependency versions from
  the workspace `package-lock.json`. `engines.node` is `22.x` for the manager
  and `packages/manager-approuter`; CI builds with Node 22. The About page
  shows the runtime versions against these pins (`prereq:bundledVersions`).

---

## Docs

- `docs/faid-apps-console/FIGAF-TOOL-MANAGEMENT-GAPS.md` — Figaf-tool management gaps (next to `SPEC.md`).
- `docs/CLEANUP-2026-09-03.md` — what was deleted from this repo on 2026-09-03 and why.

---

## Conventions when editing

- **Add a new IPC handler**: register it in `packages/core/orchestrator.js`'s
  `handlers` map. It is automatically wired by both apps:
  - `apps/figaf-local/main-process/ipc-bridge.js` iterates `Object.entries(handlers)`.
  - `apps/figaf-manager/cloud/server.js` looks up `sess.handlers[channel]` per RPC.
  Then expose it on `window.figaf` in **both**:
  - `apps/figaf-local/main-process/preload.js` (`ipcRenderer.invoke(...)`)
  - `apps/figaf-manager/cloud/client.js` (`rpc(...)`)
- **Stream output to the terminal drawer**: use `run(cmd, args, { source })` in
  the orchestrator — it handles fan-out automatically. Manual `spawn()` (the
  long-lived `cf login` and `btp login` procs) must wire stdout/stderr to
  `log(source, type, line)`.
- **New wizard step**: add to `baseSteps` / `deploySteps` / `connectSteps` in
  `packages/ui/app.jsx`, write a `Screen<X>` in a new `packages/ui/screens/screen-<name>.jsx`
  (assign to `window` at the bottom), add the `<script>` tag to both `index.html` files,
  then switch on `id` in `<App/>`. Both apps pick it up automatically.
- **Mode-conditional UI**: declare a flag in `packages/ui/mode.js`, then read it
  from `window.figafModeFlags.features.<flag>`. Don't inline `isHosted` ternaries.
- **No bundler**: don't `import`/`export` in renderer code. JSX files declare
  globals on `window` and reach each other that way.
- **Path persistence over PATH**: when adding a new external CLI, follow the
  `cliPaths.json` pattern in `host.electron.js` — never assume `$PATH`.
- **External calls audit**: whenever you add, remove, or change a call that belongs
  to any of the categories below, update `/external-calls-audit.md` in the same
  commit. The categories are:
  - A `run()` call or direct `spawn()` / `spawnSync()` / `execSync()` — new CLI
    command or changed args/flags
  - An `httpsJson` / `httpsDownload` / `httpsText` call, or a new `https.get` —
    new or changed URL
  - A URL that is opened in the browser via `host.openExternal()` or returned to
    the UI for the user to visit (cockpit deep-links, passcode URLs, etc.)
  - A build-time download in `apps/figaf-manager/scripts/build-zip.js`
  For each entry include: the exact command / URL pattern, the IPC handler (or
  script function) it lives in, and the scope (`both` / `desktop` / `cloud` /
  `build`).
- **Self-update across minor versions — xs-app.json compatibility convention**:
  the wizard can redeploy itself via `update:pushSelf` (manager) and, when v2
  XSUAA is active, the sibling `figaf-manager-approuter` via the same flow.
  Push order is approuter-first then manager, with `--strategy rolling`. The
  intermediate state during a self-update is therefore *always* "new approuter
  ↔ old manager" — never the reverse. To keep that transient state safe,
  **`packages/manager-approuter/xs-app.json` route changes MUST be
  backwards-compatible across minor versions**: new routes are fine, removing
  or renaming an existing route is a breaking change and requires a major
  version bump + an operator-visible banner message warning that sign-in will
  briefly interrupt. Same rule applies to `packages/deploy-templates/approuter/
  xs-app.json` for the deployed Figaf Tool's own approuter when that update
  path lands.

## Roadmap markers in code

- `ScreenChoice` exposes a "Connect to Integration Suite" branch that currently
  drops to `done`. The plan is to grow this into a separate flow (`connectSteps`
  in `packages/ui/app.jsx` + corresponding screens). Both apps will pick it up.
- `xs-app.json` and `manifest.yml` in `packages/deploy-templates/` already
  contain commented-out `figaf-connectivity` / `figaf-destination` services for
  PI/PO agent integration — re-enable when that scenario is wired into the wizard.
