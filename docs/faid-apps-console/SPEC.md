# Figaf Manager for FAID Apps — specification (current state)

Status: current state of the FAID Apps console in `figaf/FigafManager`, branch
`poc/faid-apps-manager` (pushed 2026-09-03, not merged into master). This file
describes how the manager behaves TODAY, by topic. It is edited in place when
behavior changes; superseded text is removed, not kept. Reasons for the design
are in the figaf-faid repo (`decisions/`); the human install procedure is
figaf-faid `docs/d1/MANUAL-RUNBOOK.md`; run records are figaf-faid
`docs/d1/RUNBOOK-VIRGIN.md`; what to do when an action fails is
`TROUBLESHOOTING.md` and what is still open is `OPEN-ITEMS.md` (this folder).
Last edited 2026-09-04 (the release store and one version per installation,
figaf-faid decision 0010; the CF sign-in targets the manager's own space by
itself, section 5.3).

Delivery unit: the versioned FAID release installed by the manager, not
an MTAR (figaf-faid `decisions/0007-delivery-unit-platform-release.md`,
accepted 2026-09-06; the governance text follows).

## 1. Purpose

A BTP-hosted manager app lists the FAID releases in the Figaf
release store, installs, updates, disables, enables, removes and checks the FAID Apps
in its own Cloud Foundry space from a browser, with every CLI
command and every download visible, and without stored personal credentials.
It also creates the service instances the platform needs, sets up its own
persistent sign-in, and holds the system connections the apps use.

## 2. Release, catalog (v5) and the release store

A RELEASE is a versioned set: `catalog.json`, `release.json` (checksums and
the source commit), `xs-security.json` and one zip per CF app. Releases live
in the RELEASE STORE (figaf-faid decision 0010): the Cloudflare R2 bucket
behind a public URL, written only by figaf-faid `release/publish.js`. The
word "channel" is retired. figaf-faid `release/build.js` builds
a release; the developer procedure is figaf-faid `release/README.md`.

Catalog v5 (2026-09-07, figaf-faid decision 0016) adds `figafScopes`: the
authorities the installation's ONE Figaf API client must carry, the union over
every app of the release (written by the build from the connector's list).
The manager verifies them when the Figaf connection is stored and before
every install and update (section 3, step 2; section 7). Older catalogs
without the field verify nothing.

### 2.1 The release source

Exactly one source per manager process, named on the FAID Apps page:

| Setting | Kind | Used for |
|---|---|---|
| `FIGAF_FAID_RELEASE_URL` (manifest.yml, e.g. `https://pub-<id>.r2.dev/faid`) | remote | every shipped manager; a custom domain or a mirror is a change of this value |
| `FIGAF_FAID_ARTIFACTS_DIR` (a directory with ONE release in the flat build shape) | local | development, the e2e fixtures, the install smoke; wins over the URL when set |
| `faid-artifacts/` next to `host.cloud.js`, nothing set | local | a developer's `npm start` after a local build |

The manager zip bundles NO release any more (`build-zip.js` refuses to build
without the URL in `manifest.yml`). No fallback from one source to another.

Store layout (the contract with figaf-faid): `<url>/index.json` =
`{ latest, versions: [{ version, publishedAt }] }`; `<url>/<version>/` holds
`catalog.json`, `release.json`, `xs-security.json`, the zips. Versions are
immutable.

### 2.2 Read, verify, cache (`packages/core/release-store.js`)

- `index.json` is read on every page load (remembered 30 s; **Refresh
  releases** reads it now). It is the only object that changes.
- A version's small files (`catalog.json`, the `configFile`s) are downloaded
  once into `<tmp>/figaf-faid-releases/<version>/` and checked against the
  sha256 in `release.json` every time they are used. Zips are downloaded when
  an install or update needs them and checked against the sha256 in the
  catalog before extraction. A mismatch deletes the file and fails the
  action; nothing half-verified is used. At most 4 versions stay cached.
- Every network read is one dim line in the terminal drawer: `>> GET <url>`,
  then `<file> <bytes>, sha256 ok`. Cached, verified files add no line (the
  page reads the release on every status refresh); **Refresh releases**
  shows their verification (`… sha256 ok (cached)`). The installed-version
  probe (`cf app <backend> --guid`) runs silently: a backend that is not
  deployed yet is a normal state, shown as installed "—", not a red line.
- The store is not reachable: every page read fails with `cannot read
  <url>/index.json: <reason>`; the Release panel says so; Install and Update
  are refused; nothing in the space changes.

### 2.3 One version per installation

- The INSTALLED version is `FIGAF_APP_VERSION` on the shared backend CF app
  (read live, remembered 5 s, forgotten after every action). The manager
  stores nothing.
- **Install app X** deploys the app at the installed version; on an empty
  space at `latest`. A `version` argument is accepted only when it names
  exactly that version.
- **Update installation to V** (`faid:update { version }`): the shared backend,
  then every frontend that is installed in the space, in catalog order.
  Only `V >= installed`; equal = re-deploy everything. Apps not installed are
  not installed by it. On the page: with a newer version in the store, a
  dropdown of the newer versions and the primary button **Update
  installation to V**; when up to date, the text "Up to date. Nothing newer
  than X in the store." and the plain repair button **Re-deploy everything
  at X** (same call, `V = installed`). Both ask for a confirmation.
- **Re-deploy** (`faid:update { appId }`): one app again, at the installed
  version (shared backend pushed first, as with Install).
- **An app that only a newer release has** (2026-09-07: release 0.6.1 added
  Functional Profiles Maintain while 0.6.0 was installed): the page lists it
  as a dashed row "new in V" without an Install button (`faid:catalog`
  `pendingApps`, from the latest catalog). Install of such an app is refused
  with "'X' is new in release V; this installation runs W ... Update the
  installation to V first", never with a bare "unknown app id". The way in
  is Update installation to V, then Install.
- If the probe of the installed version fails for a reason other than "App
  not found" (an expired login, a timeout), the installed version is unknown
  for 5 s and the page shows the latest release; the drawer says so
  (`cf app <backend> --guid failed ...`).
- Before an installation exists, `latest` is used for the service instances
  and the roles (Setup step 1).
- `faid:releases` returns the source, installed, latest, `updateAvailable`, and
  per version whether Update may choose it and why not.

```json
{
  "releaseVersion": "0.4.0",
  "services": [
    { "name": "figaf-faid-db", "offering": "postgresql-db", "plan": "free",
      "plans": ["free", "standard"], "purpose": "Application database" },
    { "name": "figaf-faid-xsuaa", "offering": "xsuaa", "plan": "application",
      "configFile": "xs-security.json", "purpose": "Roles of the FAID Apps" },
    { "name": "figaf-faid-credstore", "offering": "credstore", "plan": "free",
      "plans": ["free", "standard"], "config": { "authentication": { "type": "basic" } },
      "purpose": "Credential Store", "bindToManager": true }
  ],
  "platform": {
    "name": "Shared backend (connector)",
    "cfApps": [ { "name": "figaf-faid-backend", "artifact": "backend.zip", "sha256": "...",
                  "buildpack": "nodejs_buildpack", "stack": "cflinuxfs5", "memory": "256M", "disk": "1024M",
                  "services": ["figaf-faid-db", "figaf-faid-xsuaa"],
                  "optionalServices": ["figaf-faid-credstore"], "env": { } } ]
  },
  "apps": [
    { "id": "b2b-archiving-setup", "name": "B2B Archiving Setup", "version": "0.4.0",
      "cfApps": [ { "name": "figaf-faid-apps-b2b-archiving-setup", "artifact": "b2b-archiving-setup.zip",
                    "sha256": "...", "buildpack": "nodejs_buildpack", "stack": "cflinuxfs5", "memory": "128M", "disk": "512M",
                    "services": ["figaf-faid-xsuaa"], "env": { },
                    "destinationTo": "figaf-faid-backend", "destinationName": "figaf-faid-backend" } ],
      "configTargetCfApp": "figaf-faid-backend",
      "healthPath": "/health/connections",
      "roleCollections": ["FAID-B2BArchivingSetup-Viewer", "FAID-B2BArchivingSetup-Admin", "FAID-Platform-Admin"] }
  ]
}
```

Rules:

- `platform` = the shared backend connector, deployed and updated BEFORE any
  frontend, never touched by disable / enable / remove of an app. A catalog
  without `platform` keeps the older per-app behavior.
- `stack` per CF app (figaf-faid decision 0015, releases from 0.5.0:
  `cflinuxfs5`) = the Cloud Foundry stack the app is pushed with (`cf push
  -s`). Before the first push the manager checks `cf stacks`; a landscape
  without the stack gets a clear refusal and nothing is pushed. A cfApp
  without `stack` gets the landscape's default stack (older catalogs). On
  Update installation an app moves to the catalog's stack with its push.
- `services` = the instances the manager creates when missing. `plan` is the
  default, `plans` what the admin may choose (plans that cost money are the
  admin's decision). `configFile` ships next to the catalog; `config` is
  inline JSON. Both reach `cf create-service -c` as a FILE.
  `bindToManager` = bound to the manager itself (the Credential Store).
- `sha256` per artifact is verified before extraction; a mismatch deploys
  nothing.
- Names are frozen (decision 0008): CF apps `figaf-faid-backend`,
  `figaf-faid-apps-<app-id>`; instances `figaf-faid-db/-xsuaa/-credstore`; approuter
  destination `figaf-faid-backend`. `channelVersion` is read as a legacy
  alias of `releaseVersion`.
- The release's `xs-security.json` holds the APPS' roles only; the manager
  merges its own roles in (section 5).

## 3. Lifecycle operations

RPC channels are `faid:*`, implemented in `packages/core/faid-apps.js`. Every cf
call is shown in the terminal drawer; secret values are masked there and in
the audit log.

| Operation | Behind it |
|---|---|
| `faid:catalog({version?})`, `faid:status` | the catalog of the installation's version (installed, else latest; section 2.3) with `source`, `installed`, `latest`; live state per CF app from `cf curl /v3/apps` (scoped to the targeted space), installed version from the env var `FIGAF_APP_VERSION`, the in-flight action (`running`), per part `staging` (a STOPPED part with a build in `STAGING`, one `cf curl /v3/builds`), and `release` (the version the rows were computed against) |
| `faid:releases({refresh?})` | the release store: `source`, `installed`, `latest`, `current`, `updateAvailable`, `versions[]` with `selectable` / `reason` (section 2.3). `refresh` re-reads `index.json` now. No cf call beyond the installed-version probe |
| `faid:running` | the lifecycle action running now, or null. No cf call. For a page that did not start it (reload, second tab, second session) |
| `faid:services`, `faid:provisionServices({plans, only, waitOnly})` | `cf service <name>`; `cf create-service` for missing instances, poll every 10 s until `succeeded` (15 min limit); a `failed` instance is deleted and created again. With `waitOnly`, only those names are awaited; the others are started and reported as `pending`. Per row `boundToManager` (Credential Store, one `cf curl /v3/service_credential_bindings`); for optional instances (catalog v4) also `backendDeployed` (from the same `cf app <backend> --guid` probe that reads the installed version, no extra call) and `boundToBackend` (the same curl against the shared backend, one per instance), so the panel offers the bind only when it is needed (section 4.1) |
| `faid:bindManagerService`, `faid:restartSelf` | `cf bind-service <manager> <name>`; `cf restart <manager>` (fire-and-forget) |
| `faid:ensureXsuaa({updateOnly})` | create or `cf update-service figaf-faid-xsuaa` with the composed document (section 5) |
| `faid:prepareSpaceServices({plans})` | Setup step 1: create every missing catalog instance except XSUAA with the plans the person chose; wait only for the manager-bound ones (Credential Store) and bind them, no restart; the database is started and left creating (`pending`) (section 5.2) |
| `faid:prepareManagerServices` | legacy: the wizard frame's SSO upgrade (Credential Store only, default plan). Not used by the console |
| `faid:install({appId, version?})` | one app at the installed version (latest on an empty space); see below |
| `faid:update({version})` / `faid:update({appId})` | installation-wide update to `version` (lock name `platform`) / re-deploy of one app at the installed version; see below and section 2.3 |
| `faid:disable`, `faid:enable`, `faid:remove` | `cf stop` / `cf start` / `cf delete -f -r` of the app's own CF apps, frontend first on teardown |
| `faid:health` | HTTPS GET `<route><healthPath>` on `configTargetCfApp`; a non-2xx answer WITH a body is a result, not a failure |
| `faid:configure` | `cf set-env` (whitelisted keys, masked) + restart; kept for rare infrastructure fixes, no form in the UI (behavior settings live in the app, decision 0006) |
| `faid:figafSystems` | discover Figaf-tool deployments visible to the cf login (`figaf/app:*`, `ilnfigaf/app:*` images; `FIGAF_TOOL_IMAGE_PREFIXES`) |

Install / update algorithm:

0. One lifecycle action at a time. `faid:install`, `faid:update`, `faid:disable`,
   `faid:enable`, `faid:remove` and `faid:configure` share one lock, held in module
   scope (so it covers every browser session of the container; an entry older
   than 30 minutes is treated as gone). A second action is refused with
   `{ ok:false, busy:true, running, error }` and changes nothing. Why: the
   console's own busy state lives in ONE page, and a fresh install keeps the
   CF app STOPPED for the whole staging time — on 2026-09-04 Install was
   pressed again while the shared backend was staging; the second push
   replaced the package and Cloud Foundry dropped the running build.
   While an action runs, the manager sends `faid:running` to every page of the
   session (payload `null` when it ends), `faid:status` carries `running`, and
   the console shows the status **Installing…** with every action button off
   and a status refresh every 10 s.
1. Resolve the release (section 2.3): the version rule decides which one;
   its catalog and config files are downloaded and verified. A version that
   the rule refuses (unknown, lower than installed, not the installed one for
   Install) is a failed result before any cf call.
2. Refuse when the landscape lacks a stack the catalog names (`cf stacks`
   once per action; step `stack`, nothing pushed; a failing `cf stacks` only
   skips the check), or when a REQUIRED instance (any name in a cfApp's
   `services`) is missing: "create them first (Setup, step 3)", or when the
   stored Figaf API client lacks an authority of the release's `figafScopes`
   (step `figafScopes`, `connections:figafScopesCheck`: one token request,
   the answer's `scope` field is compared). No stored Figaf connection is not
   a blocker; a probe that fails is logged and the action goes on.
3. Role refresh: `faid:ensureXsuaa({ updateOnly: true, version })` — the shared
   XSUAA instance gets the roles of the release being deployed and of the
   manager. A failure stops the install (step `roles`).
4. Shared backend first, then the app's CF apps (Update installation: then
   every installed app's CF apps). Per CF app: download the zip from the
   store when not cached and verify its sha256 (step `download`; a failure
   pushes nothing for that part), verify sha256 again, extract, `cf push
   <name> -p <dir> -b <buildpack> -s <stack> -m -k --no-start --no-manifest`
   (fresh; `-s` only when the catalog names a stack) or
   `cf push` without `--no-start` (update); `cf bind-service` for `services`
   and for `optionalServices` that exist; `cf set-env` for `env`,
   `FIGAF_APP_VERSION` (the release version), and for frontends the approuter
   `destinations` JSON pointing at the live backend route
   (`forwardAuthToken: true`); `cf start`.
5. `--no-manifest` is mandatory (push isolation): without it the cf CLI
   applies the manager's own `manifest.yml`, which a cockpit upload leaves in
   the container (live failure 2026-09-03).

## 4. Base services

The release's instances are created in Setup step 1 (section 5.2) with the
plans the person picks there. Plans that cost money are never chosen by the
manager. PostgreSQL is only STARTED in step 1 (asynchronous, about 7 minutes);
it finishes in the background while the person signs in with IAS and stores
the management user.

The "Base services" panel is Setup step 3 (section 6). It lists the instances
with status (`ready` / `missing` / `in-progress` / `failed`), refreshes itself
every 10 s while an instance is being created, and is the REPAIR path: a plan
dropdown and **Create missing services** for missing or failed instances, and
for the Credential Store **Bind to manager** and **Restart manager** when the
binding is missing (failure path of step 1). Before step 1 the panel is
blocked; nothing on it can restart the manager in token mode. FAID Apps
shows only a one-line status of the instances with a link to the Setup.

Reusing an existing PostgreSQL instance works by NAME: an instance called
`figaf-faid-db` is bound, never re-created. Only an instance dedicated to this
platform may be reused (a previous installation, or an empty pre-created
one), never the Figaf tool's database or one another application writes to.

### 4.1 Optional services: on-premise PI/PO (catalog v4, decision 0011)

A catalog service may carry `optional: true` and a `group`. Optional instances
are never created by the normal runs: `faid:prepareSpaceServices` and
`faid:provisionServices` skip them unless the caller passes `groups: ["pipo"]`
or names the instance in `only`. They also never count as "missing": an
installation without a PI/PO system is complete, so they do not hold step 3
open and do not block step 4 (`setup-checklist.js` filters them out).

Today one group, `pipo`, with two instances:

| Instance | Offering / plan | Why |
|---|---|---|
| `figaf-connectivity` | `connectivity` / `lite` | the SAP Cloud Connector tunnel |
| `figaf-destination` | `destination` / `lite` | the destinations of PI/PO systems |

Both are SHARED with the Figaf tool (decision 0012), under Alex's names: an
instance that already exists is reused, never replaced, and nothing here ever
updates its configuration or deletes it. Both are in the shared backend's
`optionalServices`, so the backend binds them when they exist and starts
without them when they do not.

Two ways in:

- **Setup step 1** — one checkbox, OFF by default, next to the service plans.
  Ticking it adds `groups: ["pipo"]` to the run, so the instances exist before
  the backend is ever pushed and no later restart is needed.
- **Base services (step 3)** — a separate "Optional: on-premise PI/PO systems"
  block with one **Create** button per instance
  (`faid:provisionServices({ only: [name] })`). A ready instance then shows ONE
  of three things, from `faid:services` (`backendDeployed`, `boundToBackend`):
  - backend not deployed yet (a fresh install, before step 4): the note
    "bound automatically when the platform is installed" — the push in step 4
    binds every optional instance that exists, nothing to do here;
  - backend deployed and bound: the pill "bound to backend";
  - backend deployed, binding missing (the instance was created AFTER the
    backend was pushed): **Bind to backend & restart backend**
    (`faid:bindPlatformService`). This exists because `optionalServices` are
    bound while the backend is PUSHED, and an Update installation is refused
    when the store holds nothing newer. It binds the instance to the shared
    backend and restarts THAT app (a CF binding only reaches an app after a
    restart; the manager is not restarted), takes the same lock as a deploy,
    and accepts only names the catalog lists in the platform's
    `optionalServices`.

## 5. Sign-in and access

### 5.1 One XSUAA instance (decision 0009)

`figaf-faid-xsuaa` (xsappname `figaf-faid`) carries the roles of the manager
AND of the apps. The manager composes the document from two parts:

- manager part `packages/core/manager-xsuaa-part.json`: scopes
  `FAIDManagerOperator` / `-Admin`, role templates with the same names,
  role collections `FAID-Manager-Operator` / `-Admin`, token validity
  3600 s / 86400 s;
- release part: the release's `xs-security.json`.

`composeXsSecurity()` (`packages/core/manager-xsuaa.js`): union by name, the
release wins on a name clash, xsappname always `figaf-faid` (another one is
refused), redirect URIs united, `__CF_APPS_DOMAIN__` filled with the
landscape's `cfapps.` domain (`cf curl /v3/domains`; no such domain = clear
error, nothing created). Used on create and on every update.

`figaf-manager-xsuaa` is not created any more. A manager bound to it (Alex's
shipped installations) keeps working: every `xsuaa:*` handler talks to the
bound instance; the approuter `xs-app.json` accepts either
`FAIDManagerOperator` or `FigafManagerOperator`; the JWT check picks the
scope from the bound xsappname. The teardown (`cf:uninstallManager`) deletes
the instance and the manager collections only for the legacy instance.

### 5.2 Prepare the space = Setup step 1 (`#/setup`)

The step runs on the Setup page (section 6), body of step 1. Runner:
`packages/ui/prepare-space.js` (`figafRunPrepareSpace`, pure sequence over the
RPC surface, unit-tested with a fake api). Before the run the page asks for
everything it needs; the run itself needs no input.

| Part | Handler | Effect |
|---|---|---|
| Sign in to Cloud Foundry | `ScreenLogin` embedded in step 1 | one-time passcode, once; the BTP login stays optional |
| Service plans | `faid:services` | one dropdown per instance that is missing and has more than one plan (PostgreSQL, Credential Store: `free` / `standard`, each with a one-line note); existing instances are shown as "exists" |
| Role assignment | `xsuaa:roleAssignmentPrecheck` | as before: with a BTP login the collection is assigned automatically to the named person; without it the button says so ("... without role assignment") |
| Prepare the XSUAA instance | `cf:createXsuaa` -> `faid:ensureXsuaa` | create or update `figaf-faid-xsuaa`, composed document; always runs |
| Assign role collection (optional) | `xsuaa:assignRoleCollection` | `btp assign security/role-collection FAID-Manager-Admin --to-user <e-mail>`; needs a BTP login in THIS session (a restart forgets it); subaccount GUID from the BTP login or from a throw-away service key of the instance |
| Create the base services | `faid:prepareSpaceServices({plans})` | every missing instance except XSUAA, with the chosen plans; the Credential Store is awaited and bound to the manager (no restart); the database is started and NOT awaited; non-fatal (the success state explains the repair path: Setup step 3) |
| Deploy approuter | `cf:pushManagerApprouter` | `cf push figaf-manager-approuter --no-manifest`, bound to the instance, internal route mapped to the manager, `destinations` env set |
| Hand off public route | `cf:mapRoute` | the approuter takes the public hostname |
| Restart manager | `cf:restage` | bind the manager to the instance, unmap its public route, `cf restage` once (30-90 s); the page polls `/_manager-health` until `mode: "xsuaa"`, then **Continue** reloads `/#/setup` |

Result: one setup token, one passcode, one restart, no silent plan choice.
After the IAS sign-in the Setup page opens on step 2 (management user). The
role must be assigned (automatically, or by hand in the cockpit) before the
IAS sign-in succeeds.

`ScreenXsuaaUpgrade` (`screen-xsuaa.jsx`) remains for the wizard frame only
(`FIGAF_CONSOLE_UI=0`, Alex's product); the console does not use it.

### 5.3 Sign-ins, in one picture (access map on Session & access)

- **Browser access**: setup token from the app logs (token mode, until Setup
  step 1 is done: single-use, 30 min, dies on restart, one browser per boot;
  `/health` reports `tokenMinted` / `claimed`, never the value; the server
  page `/setup` explains recovery) OR SAP IAS through the approuter (XSUAA
  mode: `/setup/claim` answers 410). Note the two "setup"s: `/setup` is the
  token claim page of the server; `#/setup` is the console's Setup page.
- **Cloud Foundry login**: required; one-time SSO passcode, or automatic with
  the management user. The gate shows Cloud Foundry first and required, BTP
  second and optional.
- **Neither CF sign-in asks for an org or a space** (2026-09-04). The console
  installs into the manager's OWN space (section 1), and the hosted manager
  reads that space from `VCAP_APPLICATION`, so both sign-ins target it
  themselves: the stored user with `cf target -o -s`, the passcode with
  `cf login -o <org> -s <space>`. The pin is computed by `resolveSelfPin`
  (`packages/core/cf-target.js`) and the card shows the fixed target instead
  of a picker (`cf:ownTarget`). A pinned login that fails because the person
  has no role in that space says so and names the fix (Space Developer);
  a rejected passcode is never reported that way
  (`explainPinnedLoginFailure`). The org/space picker of `cf login` stays for
  the three cases the pin does not cover:
  1. the desktop app - no `VCAP_APPLICATION`, nothing to pin to;
  2. a login to a CF endpoint that is not the manager's own - the Figaf tool
     may live on another landscape;
  3. Alex's classic wizard frame (`FIGAF_CONSOLE_UI=0`), which deploys the
     Figaf tool into a space the operator picks, so the manager's own space
     would be the wrong answer there. `host.isConsoleUI()` decides, and a
     host without that method keeps the picker.

  **Switch Org** on Session & access still moves a signed-in session to
  another org/space on purpose (the Figaf-tool flows need it) - the FAID Apps
  lifecycle handlers do not check the target yet, see OPEN-ITEMS 14.
- **SAP BTP login**: optional; only for the automatic role assignment and for
  Figaf-tool deployments. Forgotten on every restart.
- **Management user**: a technical CF user (Space Developer, no 2FA) stored
  in the Credential Store (namespace `figaf-manager`, entry
  `cf-management-user`). Set up and replaced through the UI: the candidate is
  verified with ITS OWN password in a throw-away `CF_HOME` (`cf api` / `cf
  auth` / `cf target`), then written encrypted (JWE). The manager signs in
  with it after every restart (`cf auth` with the password only in the child
  environment). `store-management-user.ps1` remains an automation fallback.

Session rules: each browser session has its own `CF_HOME` and
`BTP_CLIENTCONFIG` (multi-user isolation in one container); a reload resumes
a live cf login; deep links (`#/apps`, `#/connections`, `#/session/...`)
survive the gate.

## 6. Setup page (`#/setup`)

One page owns the installation: `packages/ui/screens/screen-setup-page.jsx`,
step model `packages/ui/setup-checklist.js` (pure, unit-tested). It is the
landing page while the space is not prepared (token mode), the page the
Continue button of step 1 reloads to, and the page the sign-in gate opens
when the manager is in XSUAA mode with a Credential Store bound and no
management user stored. The steps are listed in the install order; the
current step is expanded with its form or action, done steps are compact and
green, later steps are compact and gray with the reason ("after step 1").

| n | step | body when current | done when | blocked until |
|---|------|-------------------|-----------|---------------|
| 1 | Prepare the space | token mode without a CF login: the sign-in card (passcode). With a login: service plans, role assignment, **Prepare the space** button, progress rows, success state with **Continue** | XSUAA mode | - |
| 2 | Management user | form: technical user + password, **Verify & store**; the manager then signs itself in. Link "sign in with a passcode instead" for the failure path (no Credential Store) | stored | step 1; Credential Store binding active |
| 3 | Base services | the panel of section 4 (status list, self-refresh every 10 s while creating, repair actions when missing / failed / unbound) | all ready; Credential Store bound and active | step 1 |
| 4 | Shared backend and first app | button **Open FAID Apps** (Install deploys the shared backend before the app) | platform running | step 3 (all instances ready) |
| 5 | Figaf tool connection | button **Open Connections** | configured | step 1; binding active |

Step 3 is omitted for a release without `services`. Each step has a why-line
(what it gives) and a when-line (what it needs). The management-user and
Figaf states are read again every time the Setup or FAID Apps page is
shown; install and services states arrive from the pages themselves.

When every step is done the page shows "Installation complete", the landing
page becomes FAID Apps, and the Setup entry stays in the rail as the
status and repair page.

Order enforcement, seen by a new person on a fresh space:

- In token mode the rail entries FAID Apps, Connections and Figaf Tool
  are disabled ("after step 1"); clicking them opens the Setup. A deep link
  (bookmark) still opens the page, with a notice "Setup not finished - N of M
  done, next: <step>" and a button **Open Setup**. (The e2e harness runs in
  token mode and reaches the pages this way.)
- FAID Apps has no setup banner and no service-creation button any more;
  Session & access has no "Secure access" card any more.
- The legacy route `#/session/sso-upgrade` opens `#/setup`.

## 7. Connections (decision 0006)

The manager is the only writer of system connections; the apps' backend reads
them. Credential Store namespace `figaf-connections`:

- `figaf-tool` — the one Figaf tool of the installation: `{ baseUrl, tokenUrl,
  clientId, clientSecret, accessClientId?, accessClientSecret?, verifiedAt,
  agentCount }`. Verified before storing: OAuth token + `POST
  /api/v1/agent/search` + the client's authorities against the release's
  `figafScopes` (decision 0016: ONE client with the union every app needs;
  the Figaf token endpoint ignores a requested scope and answers with
  `scope` = the client's authorities, which is the check). A client that
  lacks one is refused with the names of what is missing and what it has.
  `figafStatus` probes the authorities live (cached 60 s) and reports
  `requiredScopes`, `grantedScopes`, `missingScopes`; the Connections card and
  the Setup checklist show a missing authority and the fix.
- `<agentId>/api` — one per connected Integration Suite system: `{ kind:
  "api", agentId, agentSystemId, agentName, baseUrl, tokenUrl, clientId,
  clientSecret, verifiedAt }`, from a pasted `it-rt` `api` service key
  (`uaa` and `oauth` key shapes accepted). Verified: token + `GET
  /api/v1/$metadata`.
- `<agentId>/pipo` — one per on-premise PI/PO system (decision 0011):
  `{ kind: "pipo", agentId, agentSystemId, agentName, destinationName,
  proxyType, locationId, verifiedAt }`. **No secret**: the PI user and password
  live in the BTP destination, the tunnel in the SAP Cloud Connector, and the
  Cloud Connector location id in the destination's `CloudConnectorLocationId`
  property. The person types only the destination name.

Which kind an agent gets is decided by its Figaf platform: `PRO` = on-premise
PI/PO (`/pipo`), everything else = cloud tenant (`/api`). One system is never
both.

**Who creates the destination.** The customer, in the BTP cockpit
(Connectivity > Destinations). The manager never writes destinations: the
Cloud Connector mapping is a manual on-premise step anyway, so both halves of
the setup stay in one place. The runbook carries the steps.

**How a PI/PO entry is verified.** By delegation, because the manager is not
bound to the destination service and the shared backend is. `savePipoSystem`
calls `faid:destinationCheck`, which GETs `<backend route>/health/destination?name=…`.
The backend answers from its own binding (`srv/lib/destinations.js`), with a
fixed set of safe fields only — never `User`, `Password` or `authTokens`, and
any user:password part of the URL is stripped. One call proves the binding,
the destination and its Cloud Connector settings at once.

Three outcomes, three different messages:

| Backend answer | Stored? | The person sees |
|---|---|---|
| `ok:false` (no binding, no route, no token) | no | why the CHECK failed, plus what to repair |
| `ok:true, found:false` | no | "the shared backend does not see a destination called X", plus how to create it |
| `ok:true, found:true` | yes | stored; a `warning` (ProxyType not OnPremise, no location id, connectivity not bound) is shown next to the success |

A found destination is stored even with a warning: the name is right, the
setup around it is not finished. A destination that is not found is never
stored — the name IS the whole entry, so an unverified one would be a guess.

Handlers (`packages/core/connections.js`): `connections:figafStatus` (masked),
`saveFigaf`, `deleteFigaf`, `listAgents` (live from the Figaf tool, 60 s
cache; reads `/pipo` for `PRO` agents and `/api` for the rest),
`saveSystem`, `deleteSystem`, `savePipoSystem`, `deletePipoSystem`. RPC audit
redacts the secret fields. UI: `screen-connections.jsx` (`#/connections`),
Figaf card + one row per agent with Connect / Replace key or Change
destination / Disconnect, and — only when a `PRO` agent is listed and the
`pipo` instances are not ready — a hint pointing at Setup > Base services.

App side (shared backend, figaf-faid `connector/srv/lib/platform-connections.js`): reads the
entries with a 60 s cache; credential source is an explicit SELECTOR in the
wizard ("App Manager connection" default when stored, "Enter key manually"
as a deliberate override); the backend enforces the source and never mixes
them; no source = legacy precedence for old frontends (decision 0005 gate).
The `api` and `pipo` kinds are manager-managed; DMS / Service Manager /
Destination keys stay in the app (next 0006 phase). The reader side of `pipo`
is `platformConn.pipoConnection(agentId)`, and `/health/connections` reports a
`pipo` section: one destination lookup per stored entry, neutral when the
installation has none. API client scopes are installation-level and ONE
list per release (`figafScopes`, catalog v5): never per-app credentials, no
per-app override (figaf-faid decision 0016 and `docs/SOLUTION.md` 2.4).

## 8. Console frame (hosted only)

Left rail = navigation: Setup (`#/setup`, landing while the space is not
prepared; sub label "N of M done") · FAID Apps (`#/apps`, landing once
prepared) · Connections · Figaf Tool · Session & access (`#/session`,
sub-route `add-btp`) · About & updates. Hash routes; a page that needs cf
waits behind the sign-in gate; silent auto sign-in (session resume, then
stored user).
About & updates shows the versions the manager runs with (`prereq:bundledVersions`,
2026-09-04): the Node runtime, the btp and cf CLIs as they report themselves,
each against the version the build pinned in `bin/VERSIONS.json`, the pinned
npm dependencies and the build time. The environment checks for the two CLIs
turn red when a CLI does not start or reports another version than the pin.
Alex's Figaf Tool flows (deploy / update / connect) run as local steppers
inside the Figaf Tool page. The desktop installer keeps the wizard;
`FIGAF_CONSOLE_UI=0` restores it in the cloud. Do not click the blue
"Installer update available" banner on this branch: it replaces the manager
with Alex's standard release.

## 9. Failed actions explain themselves

Every action ends with a visible result. Handler result on failure:
`{ ok:false, error, step?, cfApp?, command?, detail?, failedApp? }` — where
it failed (`download` / `extract` / `push` / `bind` / `env` / `start` /
`stop` / `delete` / `roles`), the exact command (masked; for `download` the
file and the store), the CLI's last lines (`detail`, up to 400 characters). Console: a red **Failed** panel (`packages/ui/action-outcome.js`)
with action + app, where, error, command, a plain-English hint for known
patterns, buttons Show CLI output / Copy report / Dismiss; it survives the
status refresh. Terminal drawer: one summary line, green `<action> <app>:
done` or red `... FAILED at step "<step>" (<cf app>): <what cf said>`. Server
log: one `[action] ... failed` line per failed action plus the `cli.exit`
JSON record. Procedure: `TROUBLESHOOTING.md`.

## 10. Security invariants

- No personal credential is stored. The passcode is used once per session;
  the management user is a technical account.
- Secret values never appear in the terminal stream, the CLI audit log, the
  RPC audit, or a result object (masking, `auditStdout: false` for service
  keys, redaction of `connections:save*` and `login:storeManagementUser`).
- Verify before store: the management user, the Figaf client, and every
  service key are checked against the real endpoint first.
- No shell concatenation: every CLI call is `spawn()` with an argument array.
- Per-session CLI state; XSUAA mode is decided by the bound instance in
  `VCAP_SERVICES`, never by an environment flag.

## 11. Tests (three tiers, FigafManager `e2e/README.md`)

| Tier | Command | Touches CF? | When |
|---|---|---|---|
| Unit (`node:test`, handlers with a fake `run`; the release store with an in-memory bucket; UI models `setup-checklist`, `prepare-space`, `action-outcome`, `sso-role-assign` with a fake window/api) | `npm test` (root); `node --test apps/figaf-manager/cloud/*.test.js` (cloud) | no | every change |
| E2E read-only (console specs against the local build; `failure-visibility` against a fixture release whose install is refused; `release-store` against a fixture store served on 127.0.0.1, the remote code path without internet) | `npm run test:e2e` | reads | every UI or handler change, before every commit |
| E2E install smoke (mutating: real install through the console into the dev space, then remove) | `npm run test:e2e:install` | installs, removes | **before every manager build that is pushed or uploaded** |

Rules: a new console action gets its failure path in `failure-visibility.spec.js`;
a new known failure gets a hint in `action-outcome.js`, a unit test line, and
a row in `TROUBLESHOOTING.md`. Known: one pre-existing cloud test
(`btp:listGlobalAccounts ... auto-selects`) fails on master too.

## 12. Out of scope today / backlog

- Release store hardening: a signature on `release.json` checked with a
  public key inside the manager; a download token header if the bucket
  stops being public; a custom domain instead of `r2.dev` (a change of
  `FIGAF_FAID_RELEASE_URL`). The manager's own release publishing.
- Apps installed in the space but absent from the target catalog are not
  reported by Update installation (the new catalog does not know them).
- Migration of legacy installations from `figaf-manager-xsuaa` to the shared
  instance.
- Role assignment to users (no API; cockpit, or `btp assign` by a person).
- Rollback (decommissioned: forward-only migrations, decision in SOLUTION 3.1).
- DMS / Service Manager / Destination credential kinds in the manager.
- "Use an existing instance" dropdown on the Base services card.
- Figaf-tool management parity (env vars, manifest parameters, persisted
  deployment metadata) — requirements to be written (plan Step 2).
