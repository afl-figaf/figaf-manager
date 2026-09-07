# Figaf Manager

[![CI](https://github.com/figaf/FigafManager/actions/workflows/ci.yml/badge.svg)](https://github.com/figaf/FigafManager/actions/workflows/ci.yml)
[![User manual](https://img.shields.io/badge/docs-user%20manual-0b7285)](https://figaf.github.io/FigafManager/)

📖 **[Read the user manual](https://figaf.github.io/FigafManager/)** — every screen of the cloud installer, in order, with screenshots.

[![Watch the figaf-manager walkthrough](https://img.youtube.com/vi/-bgWWQrEXGs/maxresdefault.jpg)](https://www.youtube.com/watch?v=-bgWWQrEXGs)

An app that deploys and manages the [Figaf Tool](https://figaf.com) in your **SAP BTP
Cloud Foundry** subaccount in a few clicks, ensuring minimal BTP manual work.

The repo is an npm-workspaces monorepo that ships **two** parallel installers
sharing one orchestration layer and one React renderer:

| App | Where it runs | How users get to it |
|---|---|---|
| **figaf-local**   | Windows desktop (Electron)             | Download the `.exe` from Releases and run it   |
| **figaf-manager** | A Cloud Foundry space (Express + WS)   | Push the cockpit zip once, then visit its URL  |

Both wrap `btp` and `cf` CLIs, ship the BTP deployment templates, and walk you
through prerequisites → login → service creation → `cf push` → ready-to-use URL.
The wizards diverge only at the host-environment seam (file dialogs, persistent
storage, deploy-template sourcing).

> **Status (2026-09-03).** The hosted **figaf-manager** is the product going
> forward: since September 2026 it also installs and manages the FAID Apps
> (branch `poc/faid-apps-manager`, see [docs/PROJECT-CONTEXT.md](docs/PROJECT-CONTEXT.md)).
> The desktop **figaf-local** is **frozen**: it keeps working and keeps building,
> but gets no new features; its release job in `release.yml` is already disabled.

### Quick reference (developers)

| Task | Command |
|------|---------|
| Install all dependencies | `npm install` |
| Run desktop app (dev) | `npm run start:local` |
| Run cloud app locally (dev) | `npm run start:manager` |
| Run tests | `npm test` |
| Build Windows app (portable `.exe`) | `npm run build:local` |
| Build BTP Cockpit `.zip` | `npm run build:manager` |

---

## What it does

1. **Checks your environment** — looks for `btp` and `cf` CLIs, Docker Hub
   reachability, and (figaf-local only) free disk space. If a CLI is missing,
   figaf-local downloads and installs it for you (kept under your user data
   folder, no admin rights, no PATH edits); figaf-manager ships the Linux
   binaries inside its zip.
2. **Signs you in** — `btp login --sso` opens your browser, then we discover
   your landscape and run `cf login --sso` with the one-time passcode.
3. **Lets you choose an action** — *Deploy Figaf Tool* (fresh install),
   *Update Figaf Tool* (refresh an existing deployment to the latest image),
   *Connect to Integration Suite* (wire up an existing deployment), and — on the
   cloud installer only — *Enable persistent SSO login* (the XSUAA upgrade,
   see [Securing the cloud installer](#securing-the-cloud-installer-figaf-manager)).
4. **Configures the deployment** — auto-detects the apps domain, the latest
   `figaf/app` Docker tag, and the available PostgreSQL plans; you fill in the
   ID and pick a plan.
5. **Provisions services in parallel** — creates `figaf-db` (PostgreSQL),
   `figaf-xsuaa` (OAuth2/role scopes), and assigns the `PI_Administrator` role
   collection to your user.
6. **Pushes the app** — `cf push --vars-file vars.yml`, then opens the deployed
   URL once it's live. The Finish screen also links straight to the new app's
   space in the BTP Cockpit.

A collapsible terminal drawer streams every CLI command in real time, so
nothing is hidden behind the GUI. Secrets (service keys, JWTs, setup tokens) are
redacted from the stream and from the audit log before they're ever shown or
written.

### The other actions

- **Update Figaf Tool** — detects the running deployment, seeds the form from
  its *live* `vars.yml` (so an update never silently changes memory, domain,
  location, or SMTP settings), lets you pick a target Docker tag and a `cf push`
  strategy (`recreate` vs. rolling), pulls the latest deploy templates, then
  applies the update and verifies it.
- **Connect to Integration Suite** — provisions the `it-rt` *api* and
  *integration-flow* services, creates and fetches their service keys, then
  configures BTP access. The **custom SAML IdP** path is complete (creates the
  cockpit trust configuration, resolves the IdP origin, builds the SSO URL, and
  assigns the `PI_*` role collections); the IAS / S-user / passport auth modes
  are still stubs.

---

## Requirements

- An **SAP BTP** subaccount with a **Cloud Foundry** environment instance and
  permissions to create services and push apps.
- Internet access to:
  - `tools.hana.ondemand.com` (BTP CLI download)
  - `github.com/cloudfoundry/cli/releases` (CF CLI download)
  - `hub.docker.com` (image tag lookup + image pull)
  - `github.com/figaf/Figaf-BTP-Deployment` (deploy templates — figaf-manager only)
- For figaf-local: Windows 10 / 11 (x64).
- For figaf-manager: a CF space you can push to (the wizard itself runs there).

---

## Install (end users)

### Desktop — figaf-local

Download the portable app from the [**Releases page**](../../releases/latest):

| File | Use it when |
|------|-------------|
| `Figaf-Installer-<v>-x64.exe` | **Just run it** — standalone portable app. Double-click to launch, no installation, no admin rights. |

Launch **Figaf Installer** and follow the wizard. No installation step — the portable exe is self-contained.

### Cloud — figaf-manager

You need **two files**:

| File | Where to get it |
|------|----------------|
| `figaf-manager-app-<version>.zip` | Attached to each [release](../../releases/latest), or built by `npm run build:manager` |
| `manifest.yml` | Attached to the same release, or `apps/figaf-manager/manifest.yml` from this repo — use as-is |

Deploy via BTP Cockpit: **Space → Applications → Deploy Application**, upload the `.zip` as the application archive and `manifest.yml` as the deployment descriptor, then click **Deploy**. Once green, open the assigned URL in a browser.

> **Tip:** `FIGAF_MANAGER_MAINTENANCE: 1` is set in `manifest.yml` by default. Comment it out before deploying to make the wizard immediately accessible.

The [**user manual**](https://figaf.github.io/FigafManager/) walks through everything from here — claiming the
installer with the setup token, signing in to BTP, and each wizard step.

---

## Securing the cloud installer (figaf-manager)

The cloud installer runs on a **public Cloud Foundry route** — anyone who learns
the URL could otherwise drive it. It ships with a two-phase auth gate so it's
never unauthenticated:

1. **Token gate (default, zero config).** On boot the app generates a one-time
   setup token and prints it **once** to stdout, tagged `[SETUP]`. Open the app
   URL, go to the `/setup` page, and paste the token from the BTP Cockpit
   **Logs** view. The first successful claim consumes the token, mints a signed
   session cookie, and closes `/setup` (it returns `410 Gone` afterward). No
   pre-deploy configuration and no `cf` CLI is required — reading the cockpit log
   is the only capability the gate depends on.
2. **Persistent SSO (optional, in-wizard upgrade).** After signing in, choose
   **Enable persistent SSO login**. The wizard provisions an XSUAA service and
   pushes a bundled [`@sap/approuter`](packages/manager-approuter/) in front of
   itself, then deep-links you to assign yourself the role collection in the
   cockpit (~30 s). From then on you reach the wizard through the approuter and
   authenticate with SAP IAS single sign-on — no more cockpit-log token.

The session cookie is signed with `FIGAF_AUTH_SECRET` (a per-boot random value
when unset). The manager also self-destructs after a configurable idle period.
See [docs/auth-gate-implementation-plan.md](docs/auth-gate-implementation-plan.md)
for the full design.

---

## Run from source (developers)

The repo is an npm workspace. Install once at the root:

```sh
npm install
```

That hoists shared deps and symlinks `@figaf/core`, `@figaf/ui`, and
`@figaf/deploy-templates` into each app.

### Start the Electron app (figaf-local)

```sh
npm run start:local
# equivalent to:  npm --workspace apps/figaf-local start
```

DevTools opens detached.

### Start the cloud app (figaf-manager) locally

```sh
npm run start:manager
# equivalent to:  npm --workspace apps/figaf-manager start
```

Then visit `http://localhost:8080`. In dev mode the host adapter falls back to
`btp` / `cf` on `$PATH` if `apps/figaf-manager/bin/` is empty.

### Build the Windows app

```sh
npm run build:local
```

Produces a single self-contained artifact in `apps/figaf-local/dist/` (no Node.js or Electron runtime needed on the target machine):

| File | Type |
|------|------|
| `Figaf-Installer-<version>-x64.exe` | **Portable** — double-click to run, no install |

The BTP deployment templates are bundled as `extraResources` inside it. The release workflow attaches this portable exe to the GitHub Release. Don't commit it — `dist/` is gitignored to keep the ~80 MB+ binary out of git history.

### Build the BTP Cockpit zip

```sh
npm run build:manager
```

Output: **`apps/figaf-manager/dist/figaf-manager-app-<version>.zip`**

The script downloads the pinned Linux `btp` + `cf` binaries (`btpCliVersion`, `cfCliVersion` in `apps/figaf-manager/package.json`) into `apps/figaf-manager/bin/` (cached; re-downloaded when a pin changes; the versions are recorded in `bin/VERSIONS.json`), stages a self-contained app tree under `.staging/` with the exact dependency versions from the workspace lockfile, then zips it. Upload the resulting `.zip` together with `apps/figaf-manager/manifest.yml` via BTP Cockpit *Deploy Application*.

---

## Project layout

```
figaf-installer/                          ← workspace root (npm workspaces)
├── apps/
│   ├── figaf-local/                      Electron desktop installer
│   │   ├── main-process/
│   │   │   ├── main.js                     BrowserWindow + frameless chrome
│   │   │   ├── preload.js                  contextBridge → window.figaf
│   │   │   ├── ipc-bridge.js               wires orchestrator handlers to ipcMain
│   │   │   └── host.electron.js            HostAdapter: dialog, userData, clipboard
│   │   └── package.json                  electron + electron-builder
│   └── figaf-manager/                    Cloud-hosted installer
│       ├── cloud/
│       │   ├── server.js                   Express RPC + WebSocket
│       │   ├── auth.js                      token-gate auth (setup token, session cookie)
│       │   ├── xsuaa-auth.js                v2 XSUAA/JWT verification
│       │   ├── client.js                    browser window.figaf shim (fetch + ws)
│       │   ├── index.html, setup.html       cloud renderer shell + /setup claim page
│       │   └── *.test.js                    auth, ws, xsuaa, restage tests (node:test)
│       ├── host.cloud.js                 HostAdapter: session-scoped, bundled bin
│       ├── bin/                          Linux btp + cf binaries (build-time)
│       ├── scripts/build-zip.js          assembles the cockpit zip
│       ├── manifest.yml                  CF deployment manifest (nodejs buildpack)
│       └── package.json                  express + ws
└── packages/
    ├── core/                             host-agnostic orchestrator
    │   ├── orchestrator.js                 ~38 IPC handlers + HostAdapter typedef
    │   ├── audit-log.js                     append-only audit log (with secret redaction)
    │   ├── redact-service-key.js            scrubs service-key / JWT material from output
    │   ├── saml-connect.js                  pure SAML/IdP-trust + cockpit deep-link logic
    │   ├── btp-target.js, cf-target.js      pure parsers for `btp` / `cf` target output
    │   ├── manifest-patch.js                rewrites the manifest app name for self-update
    │   ├── release-config.js                self-update release discovery (GitHub assets)
    │   ├── db-schemas.js                    PostgreSQL params + hyperscaler/trial defaults
    │   └── index.js
    ├── ui/                               shared React renderer (no bundler)
    │   ├── app.jsx                         <App/> wizard state machine (deploy/update/connect/xsuaa)
    │   ├── screens/                         one file per wizard step group (screen-*.jsx)
    │   ├── components.jsx                  shared primitives + frameless chrome
    │   ├── mode.js                         window.figafModeFlags (isHosted + features)
    │   ├── styles.css, electron-app.css
    │   ├── index.html                      Electron renderer shell
    │   └── figaf-logo.png
    ├── manager-approuter/                v2 @sap/approuter pushed in front of figaf-manager
    │   ├── server.js                        maintenance gate + approuter bootstrap
    │   └── maintenance.html
    └── deploy-templates/                 BTP CF deployment templates
        ├── manifest.yml                    approuter + figaf-app
        ├── vars.yml                        rewritten at runtime
        ├── db.json, xs-security.json
        └── approuter/                      @sap/approuter
```

For a deeper architectural reference (IPC surface, event channels, subprocess
invariants, host-adapter contract), see [CLAUDE.md](CLAUDE.md).

---

## Architecture at a glance

```mermaid
flowchart TB
    subgraph Local["figaf-local — Electron (Windows)"]
        direction TB
        R1["React Renderer"]
        M1["Main Process\nipc-bridge.js"]
        HE["host.electron.js\ndialog · userData · clipboard"]
        R1 -- "ipcRenderer.invoke" --> M1
        M1 -- "events" --> R1
        M1 --> HE
    end

    subgraph Cloud["figaf-manager — Cloud Foundry (browser)"]
        direction TB
        R2["React Renderer"]
        EX["Express + WebSocketServer\nserver.js"]
        HC["host.cloud.js\nsession-scoped · bundled bins"]
        R2 -- "fetch /rpc + ws /stream" --> EX
        EX -- "events" --> R2
        EX --> HC
    end

    HE --> ORC
    HC --> ORC

    subgraph Core["packages/core — shared (byte-identical handlers)"]
        ORC["orchestrator.js\n~38 IPC handlers"]
    end

    subgraph UI["packages/ui — shared React renderer"]
        APP["app.jsx · screens/ · components.jsx"]
    end

    ORC -.->|"spawns"| BTP["btp CLI (SAP SSO)"]
    ORC -.->|"spawns"| CF["cf CLI (CF Foundation)"]
    ORC -.->|"https"| WEB["DockerHub · GitHub\nBTP landscape APIs"]

    BTP --> BTPENV
    CF  --> BTPENV

    subgraph BTPENV["SAP BTP Cloud Foundry"]
        APPR["approuter (Node)"] --> APP2["figaf-app (Docker)"]
        APP2 --> XSUAA["figaf-xsuaa\n(OAuth2 / SAML)"]
        APP2 --> DB["figaf-db\n(PostgreSQL 16)"]
    end

    Local -. "loads" .-> UI
    Cloud -. "serves" .-> UI
```

Both renderers consume the **same** `window.figaf` IPC surface (`prereq.*`,
`btp.*`, `cf.*`, `config.*`, `shell.*`, `on(channel, handler)`). figaf-local
implements that surface with `ipcRenderer.invoke`; figaf-manager implements it
with `fetch("/rpc/:channel")` + `WebSocket("/stream")`. The orchestrator
handlers are byte-identical between the two — see
[packages/core/orchestrator.js](packages/core/orchestrator.js).

---

## What's bundled vs. what's downloaded

| | figaf-local | figaf-manager |
|---|---|---|
| BTP deployment templates | bundled (`extraResources`)         | downloaded at runtime from GitHub |
| `btp` + `cf` CLIs        | downloaded on first run if missing | bundled in `bin/` (Linux)         |

For figaf-local, missing CLIs are stored under your user data folder; absolute
paths persisted to `cliPaths.json`. PATH is never modified.

---

## Roadmap

- **Connect to Integration Suite — remaining IdP modes.** The flow is built and
  the custom SAML IdP path is complete; the **IAS**, **S-user**, and **passport**
  authentication modes are still stubs (`screen-connect-idp-{ias,suser,passport}.jsx`).
- **PI/PO connectivity** — `figaf-connectivity` and `figaf-destination`
  services are reserved (commented out) in
  [packages/deploy-templates/manifest.yml](packages/deploy-templates/manifest.yml)
  for cloud-connector-based PI/PO agent integration.

Both apps will pick up new wizard steps and IPC handlers automatically — see
*Conventions when editing* in [CLAUDE.md](CLAUDE.md).

---

## License

Unlicensed (private). The bundled BTP deployment templates are © Figaf and
distributed under their original license — see
[packages/deploy-templates/LICENSE](packages/deploy-templates/LICENSE).
