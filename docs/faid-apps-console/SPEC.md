# Figaf Manager for FAID Apps — specification (current state)

Status: current state of the FAID Apps console in `figaf/FigafManager`, branch
`poc/faid-apps-manager` (pushed 2026-09-03, not merged into master). This file
describes how the manager behaves TODAY, by topic. It is edited in place when
behavior changes; superseded text is removed, not kept. Reasons for the design
are in the figaf-faid repo (`decisions/`); the human install procedure is
figaf-faid `docs/d1/MANUAL-RUNBOOK.md`; run records are figaf-faid
`docs/d1/RUNBOOK-VIRGIN.md`; what to do when an action fails is
`TROUBLESHOOTING.md` and what is still open is `OPEN-ITEMS.md` (this folder).
Last edited 2026-09-10 (the FAID Apps page shows cards in sections and
stops or starts several apps in one go, section 3.1; before, 2026-09-08:
catalog v7, the manager owns the base service instances,
`packages/core/base-services.js`, sections 2 and 4; the backend's own database
role and the editable database instance name, section 4.2).

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

## 2. Release, catalog (v7) and the release store

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

Catalog v7 (2026-09-08, figaf-faid decision 0018; plan
`docs/base-services-ownership-plan.md`): **the manager owns the base service
instances**. Their definitions (offering, default name, whether the name is
editable, plans, who binds them, the optional groups) live in ONE module,
`packages/core/base-services.js` (section 4). The catalog carries no
`services` list any more; every CF app says only what it **requires**, by
kind: `"requires": { "database": "own-role", "xsuaa": "binding", "credstore":
"binding" }` and `"optional": ["pipo"]`. A catalog that still carries
`services` (v6 or older), or instance names on a CF app, is refused by the
release store with one sentence ("this manager needs catalog v7"); there is no
compatibility layer (no customer has an installation; 0.8.0 is the first
release the new manager installs). Why: a manager screen feature that needed a
new service flag was invisible until a release carried the flag (the editable
database name, 2026-09-08).

### 2.1 The release source

Exactly one source per manager process, named on the FAID Apps page:

| Setting | Kind | Used for |
|---|---|---|
| `FIGAF_FAID_RELEASE_URL` (manifest.yml, e.g. `https://pub-<id>.r2.dev/faid`) | remote | every shipped manager; a custom domain or a mirror is a change of this value |
| the same URL ending in `/faid-dev` | remote | a manager used to TEST changes (Emil's space, the dev space): the dev channel, figaf-faid decision 0017 |
| `FIGAF_FAID_ARTIFACTS_DIR` (a directory with ONE release in the flat build shape) | local | development, the e2e fixtures, the install smoke; wins over the URL when set |
| `faid-artifacts/` next to `host.cloud.js`, nothing set | local | a developer's `npm start` after a local build |

The manager zip bundles NO release any more (`build-zip.js` refuses to build
without the URL in `manifest.yml`). No fallback from one source to another.

Store layout (the contract with figaf-faid): `<url>/index.json` =
`{ latest, versions: [{ version, publishedAt }] }`; `<url>/<version>/` holds
`catalog.json`, `release.json`, `xs-security.json`, the zips. Versions are
immutable.

Two channels, two prefixes, each with its own `index.json` (figaf-faid
decision 0017, 2026-09-08): `faid/` holds the release versions `x.y.z`;
`faid-dev/` holds the dev versions `x.y.z-dev.N` that Jenkins publishes from
any branch (N = the Jenkins build number). The manager treats both the same;
only the version rule differs: `x.y.z-dev.N` is accepted, sorts below `x.y.z`
and above `x.y.(z-1)`, and two dev builds compare by N. So on the dev channel
**Update installation** moves `0.6.2-dev.9` to `0.6.2-dev.10`, and a manager
that is later pointed at `faid/` moves `0.6.2-dev.10` to `0.6.2` upwards.
Dev versions are immutable like release versions (the cache is keyed by
version). No other suffix is valid (`-rc.1`, `-e2e` are refused).

### 2.2 Read, verify, cache (`packages/core/release-store.js`)

- `index.json` is read on every page load (remembered 30 s; **Refresh
  releases** reads it now). It is the only object that changes.
- A version's small files (`catalog.json`, `xs-security.json` when a CF app
  requires XSUAA) are downloaded
  once into `<tmp>/figaf-faid-releases/<version>/` and checked against the
  sha256 in `release.json` every time they are used. Zips are downloaded when
  an install or update needs them and checked against the sha256 in the
  catalog before extraction. A mismatch deletes the file and fails the
  action; nothing half-verified is used. At most 2 versions stay cached (the
  installed one and the one an update moves to): the cache shares the
  container disk quota (`manifest.yml`, `disk_quota: 2G`) with the droplet
  and the per-session directories.
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
  as a dashed row with the pill "new in V · after the update" and no Install
  button (`faid:catalog` `pendingApps`, from the latest catalog); the Release
  panel names all of them in one line ("New in V, available after the
  update: A, B"). Install of such an app is refused
  with "'X' is new in release V; this installation runs W ... Update the
  installation to V first", never with a bare "unknown app id". The way in
  is Update installation to V, then Install.
- **The page follows the installation.** The catalog is read at mount and
  again after every lifecycle action and on the head's **Refresh**, together
  with the status and the release list. So after Update installation the
  rows, the pending apps and the Release panel describe the new release
  without a page reload (until 2026-09-09 the catalog was read once, and the
  page kept asking for an update that was already done).
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
  "releaseVersion": "0.8.0",
  "figafScopes": ["agent:read", "b2b.partner-profile:read", "download", "ctt:sync"],
  "platform": {
    "name": "Shared backend (connector)",
    "cfApps": [ { "name": "figaf-faid-backend", "artifact": "backend.zip", "sha256": "...",
                  "buildpack": "nodejs_buildpack", "stack": "cflinuxfs5", "memory": "256M", "disk": "1024M",
                  "requires": { "database": "own-role", "xsuaa": "binding", "credstore": "binding" },
                  "optional": ["pipo"], "env": { } } ]
  },
  "apps": [
    { "id": "b2b-archiving-setup", "name": "B2B Archiving Setup", "version": "0.8.0",
      "cfApps": [ { "name": "figaf-faid-apps-b2b-archiving-setup", "artifact": "b2b-archiving-setup.zip",
                    "sha256": "...", "buildpack": "nodejs_buildpack", "stack": "cflinuxfs5", "memory": "128M", "disk": "512M",
                    "requires": { "xsuaa": "binding" }, "env": { },
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
- `requires` per CF app = a map KIND -> CONSUMPTION. Kinds: `database`,
  `xsuaa`, `credstore` (the manager's `base-services.js` knows them).
  Consumption `"binding"`: the manager binds the module's instance to the CF
  app. `"own-role"` (database only): the backend gets the Credential Store
  entry and `FAID_DATABASE_CA`, never a binding (section 4.2). The database
  as a binding is refused (a binding runs as `dbo`, decision 0012). A kind or
  consumption the manager does not know is a catalog error before any cf
  call.
- `optional` per CF app = optional GROUPS whose instances the CF app binds
  when they exist. Today one group, `pipo` (section 4.1). An unknown group
  is a catalog error.
- No instance name, plan, config or flag is in the catalog any more; they
  are the manager's (section 4). The release still ships `xs-security.json`
  (the apps' roles, release content, a fixed name) when a CF app requires
  `xsuaa`; the store delivers it with the catalog.
- `sha256` per artifact is verified before extraction; a mismatch deploys
  nothing.
- Names are frozen (decision 0008 is the record, `base-services.js` the
  code): CF apps `figaf-faid-backend`, `figaf-faid-apps-<app-id>`;
  instances `figaf-faid-xsuaa/-credstore`; approuter destination
  `figaf-faid-backend`. The database instance is the exception: default
  `figaf-db`, editable (decision 0008 amended 2026-09-08).
  `channelVersion` is read as a legacy alias of `releaseVersion`.
- The release's `xs-security.json` holds the APPS' roles only; the manager
  merges its own roles in (section 5).

## 3. Lifecycle operations

RPC channels are `faid:*`, implemented in `packages/core/faid-apps.js`. Every cf
call is shown in the terminal drawer; secret values are masked there and in
the audit log.

### 3.1 The FAID Apps page (`#/apps`, `packages/ui/screens/screen-faid-apps.jsx`)

The layout follows the App Manager of the prototypes (figaf-layer3,
`app/appmanager`): a stats strip, sections with a count, and a grid of cards.
The grouping, the counts and the selection rules are pure functions in
`packages/ui/faid-cards.js` (tested in `faid-cards.test.js`); the screen only
renders them.

- One column of at most 1400 px (`.faid-page`, `console.css`); the card grid
  (`.faid-grid`) fills it with cards of at least 330 px, so three or four
  cards stand next to each other on a wide screen and one on a narrow one.
- Head: title, one short paragraph, the buttons **Refresh** (catalog,
  status, base services, release list; no forced store read) and
  **Connections**, and under them the stats strip (`[data-faid-stats]`):
  apps in the release, running, stopped, not installed; "installing" and
  "partly running" appear only when they are not zero. Until the first
  status answer the state numbers show "…".
- Then the failed-action panel (section 9), the base services line, the
  Release panel (section 2.3), the shared backend row (`.faid-backend`), and
  the sections.
- Sections (`[data-section]`): **Installed** (every app whose CF apps exist
  in the space: running, stopped, installing, partial, mixed), **Not
  installed**, and **New in V, available after the update** (the pending
  apps of a newer release). Each has a title with a count; empty sections
  are left out; catalog order inside a section. Until the first status
  answer every app is in one section without a title, so no card jumps when
  the status arrives.
- A card (`.faid-card[data-app]`, `data-status`): a two-letter icon (the
  initials of the name, green when running), the status pill, the busy pill
  while an action runs; the name, the description from the catalog, and a
  meta line. The word `installed:` is the only version label on cards: the
  version the CF app reports (`FIGAF_APP_VERSION`). A card that is not
  installed carries its version on the Install button only. An app that is
  not at the installation's version gets the pill "behind the installation
  (V)" and the button **Re-deploy at V**. The Release panel keeps
  `installed:` and `latest:`.
- Card actions: **Install V** (primary) when not installed; **Open app ↗**
  (primary, the first route, `[data-open-app]`) when installed; then
  Re-deploy, Configure, Health, Disable / Enable; **Remove** stands apart on
  the right in the danger style (`.btn-danger`) and asks "Delete the Cloud
  Foundry apps of X?" with **Confirm remove** / **Keep**. Below the actions:
  the Configure form and the Health result when opened, and a folded
  **Details** block with the CF apps and their state (`started` / `stopped`
  / `staging` / `absent`) and routes, and the role collections with **Copy
  names** (clipboard) and **Open BTP cockpit ↗** (the space page of
  `cf:cockpitUrl`, asked once per page and only when a Details block is
  opened; absent when the URL cannot be built).
- A pending card (`.faid-card.is-pending`, `data-pending`) is dashed, has
  the pill "new in V · after the update" and no action.
- **Several apps in one go.** Every card whose app can be stopped or started
  now (status running or stopped) has a checkbox; **Select all** in the
  Installed section's head ticks all of them. With at least one ticked, the
  selection bar (`[data-selection-bar]`) shows "N selected", says how many
  of them cannot be stopped or started right now, and offers **Disable
  selected (n)** (the running ones), **Enable selected (n)** (the stopped
  ones) and **Clear selection**. A button with 0 is off. One click sends ONE
  `faid:disable` / `faid:enable` with `appIds`; the manager holds one lock
  for the whole batch and works the apps one after the other, so a reload in
  the middle does not cut the batch. A failure of one app does not stop the
  others; the failed ones stay selected and the failed-action panel names
  them ("disable failed for 1 of 3 apps: X (...)"). The selection is
  cleared when every app succeeded, and an app that can no longer be
  stopped or started leaves it by itself.
- While any action runs (here, in another tab, or started elsewhere and
  learned from `faid:running`), every action button of every card is off;
  the card of the app being worked on shows what happens, the others show
  "waiting".
- The shared backend row shows its CF app and state inline (no Details),
  the installed version next to the name, and one sentence: installed with
  the first app at V, or moved first by Update installation.

| Operation | Behind it |
|---|---|
| `faid:catalog({version?})`, `faid:status` | the catalog of the installation's version (installed, else latest; section 2.3) with `source`, `installed`, `latest`; live state per CF app from `cf curl /v3/apps` (scoped to the targeted space), installed version from the env var `FIGAF_APP_VERSION`, the in-flight action (`running`), per part `staging` (a STOPPED part with a build in `STAGING`, one `cf curl /v3/builds`), and `release` (the version the rows were computed against) |
| `faid:releases({refresh?})` | the release store: `source`, `installed`, `latest`, `current`, `updateAvailable`, `versions[]` with `selectable` / `reason` (section 2.3). `refresh` re-reads `index.json` now. No cf call beyond the installed-version probe |
| `faid:running` | the lifecycle action running now, or null. No cf call. For a page that did not start it (reload, second tab, second session) |
| `faid:services({names?})`, `faid:provisionServices({plans, only, waitOnly, names?})` | the rows are the base services of `base-services.js` that the release's CF apps require (section 4); `cf service <instance>`; `cf create-service` for missing instances, poll every 10 s until `succeeded` (15 min limit); a `failed` instance is deleted and created again (never the `own-role` database: it is reported and left alone). With `waitOnly`, only those names are awaited; the others are started and reported as `pending`. `names` = `{ defaultName: instanceName }` for `nameEditable` services; `plans`, `only` and `waitOnly` stay keyed by the module's DEFAULT name. Per row `name` (default), `kind`, `instanceName` (actual, section 4.2), `nameSource`, `candidates`, `boundApps`, `actualPlan`, `access`, `nameEditable`, `databaseAccess` (own-role rows), `boundToManager` (Credential Store, one `cf curl /v3/service_credential_bindings`); for optional instances also `backendDeployed` (from the same `cf app <backend> --guid` probe that reads the installed version, no extra call) and `boundToBackend` (the same curl against the shared backend, one per instance), so the panel offers the bind only when it is needed (section 4.1) |
| `faid:databaseStatus`, `faid:databasePrepare({instanceName})`, `faid:databaseRotate`, `faid:databaseDrop({confirm:true})` | the backend's database access (section 4.2, `packages/core/faid-database.js`): status without a database connection; prepare = temporary service key, SQL as the owner, verification as `faid_app`, Credential Store entry, key deleted; rotate = new password, entry updated, `cf restart <backend>` when deployed; drop = `DROP SCHEMA faid CASCADE`, `DROP ROLE faid_app`, entry deleted. Prepare, rotate and drop take the lifecycle lock. Hosted only |
| `faid:bindManagerService`, `faid:restartSelf` | `cf bind-service <manager> <name>`; `cf restart <manager>` (fire-and-forget) |
| `faid:ensureXsuaa({updateOnly})` | create or `cf update-service figaf-faid-xsuaa` with the composed document (section 5) |
| `faid:prepareSpaceServices({plans, names, groups})` | Setup step 1: create every missing catalog instance except XSUAA with the plans the person chose and under the names typed for editable ones (v6); an instance that exists under that name is accepted as it is; wait only for the manager-bound ones (Credential Store) and bind them, no restart; the database is started and left creating (`pending`) (section 5.2) |
| `faid:prepareManagerServices` | legacy: the wizard frame's SSO upgrade (Credential Store only, default plan). Not used by the console |
| `faid:install({appId, version?})` | one app at the installed version (latest on an empty space); see below |
| `faid:update({version})` / `faid:update({appId})` | installation-wide update to `version` (lock name `platform`) / re-deploy of one app at the installed version; see below and section 2.3 |
| `faid:disable({appId} \| {appIds})`, `faid:enable({appId} \| {appIds})`, `faid:remove({appId})` | `cf stop` / `cf start` / `cf delete -f` of the app's own CF apps, frontend first on teardown. With `appIds`: the listed apps one after the other under ONE lock (the running marker carries `appIds`; its `appId` is the list as text); a failure of one app does not stop the others; the result is `{ ok, results: [{ appId, ok, error, step, cfApp, command }], error }` with `ok` true only when every app succeeded, and `step` / `cfApp` / `command` of the first failure |
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
   skips the check), or when a REQUIRED instance (a kind a cfApp `requires`
   as a binding, the own-role database left out) is missing: "create them
   first (Setup, step 3)", or when the database access is not prepared (no
   Credential Store entry, or its instance is gone or not ready; step
   `database`: "Setup step 3, Prepare database access"), or when the
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
   pushes nothing for that part), verify sha256 again, extract into the
   session directory (removed again after the part, success or failure),
   `cf push <name> -p <dir> -b <buildpack> -s <stack> -m -k --no-start --no-manifest`
   (fresh; `-s` only when the catalog names a stack) or
   `cf push` without `--no-start` (update); `cf bind-service` for the kinds
   the CF app `requires` as a binding and for the instances of its `optional`
   groups that exist, NEVER for the `own-role` database (a line says so);
   `cf set-env` for `env`,
   `FIGAF_APP_VERSION` (the release version), and for frontends the approuter
   `destinations` JSON pointing at the live backend route
   (`forwardAuthToken: true`); `cf start`.
5. `--no-manifest` is mandatory (push isolation): without it the cf CLI
   applies the manager's own `manifest.yml`, which a cockpit upload leaves in
   the container (live failure 2026-09-03).

## 4. Base services

The base instances are the MANAGER'S OWN (catalog v7, figaf-faid decision
0018): `packages/core/base-services.js` is the one source of their offering,
default name, whether the name is editable, plans (default first; the paid
plan is never chosen by the manager), who binds them, and the optional
groups. The release only says which kinds its CF apps require and how
(section 2); the rows of `faid:services`, the Setup step 1 plans and names,
and every `cf create-service` / `cf bind-service` come from the module.

| kind | offering | default name | name editable | plans | bound to | note |
|---|---|---|---|---|---|---|
| `database` | `postgresql-db` | `figaf-db` | yes | `free`, `standard` | nobody: the backend's own role (section 4.2) | may be the Figaf Tool's instance; the row states the bound apps and the consequence |
| `xsuaa` | `xsuaa` | `figaf-faid-xsuaa` | no | `application` | manager, backend, every app | composed document (release part `xs-security.json` + manager part), section 5.1 |
| `credstore` | `credstore` | `figaf-faid-credstore` | no | `free`, `standard` | manager (`bindToManager`), backend | basic authentication on the instance; the free plan allows one instance per subaccount |
| group `pipo` | `connectivity` / `destination` | `figaf-connectivity`, `figaf-destination` | no (later) | `lite` | backend, when present | shared with the Figaf Tool: reused, never replaced, configured or deleted by the manager (section 4.1) |

Frozen names: decision 0008 is the record, the module is the code. Extending
the editable name to another instance is one column change plus a discovery
source (a separate task, section 12).

The instances the release requires are created in Setup step 1 (section 5.2)
with the plans the person picks there. Plans that cost money are never chosen by the
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

### 4.2 The database: the backend's own role, an editable instance name

Why (figaf-faid decision 0012 section 10; the plan was
`docs/shared-database-plan.md`): every binding user of a BTP `postgresql-db`
instance runs as the group role `dbo` with full access to every schema. A
binding is never isolation. So the FAID backend gets NO binding of the
database. The manager creates the role `faid_app` (LOGIN, not a member of
`dbo`), the schema `faid` (owned by `dbo`; `USAGE` and `CREATE` granted to
the role), and writes `{ host, port, dbname, user: "faid_app", password,
schema: "faid", instanceName, instanceGuid }` into the Credential Store
(namespace `figaf-faid`, name `backend-database`). The instance's CA
certificate chain (public; about 4.6 KB, three certificates) is not in the
entry: a Credential Store value holds about 4 KB (HTTP 413 above it,
measured 2026-09-08). When the manager deploys the shared backend it reads
the chain from its service key and sets it on the backend as the environment
variable `FAID_DATABASE_CA` (`cf set-env`, value masked in the terminal).
The backend reads the entry at start, verifies the server with that chain
(no variable = no start, never an unverified connection) and sets `search_path` to `faid` on
every connection; its migrations refuse a connection whose
`current_schema()` is not `faid`. The instance may be the Figaf Tool's
(schema `irt`), or one made for FAID; the procedure is the same. The
protection is one-directional: every app bound to the instance (the Figaf
Tool) keeps full access, including schema `faid`; the row says so.

The instance name. The module's default (`figaf-db`) is the DEFAULT. Setup
step 1 shows it in a text field the person may change (validated as a cf
instance name, `^[A-Za-z0-9][A-Za-z0-9._-]{0,49}$`, always one argv element).
The actual name is discovered, never stored: the page's override, else the
Credential Store entry (`instanceName`, `instanceGuid`), else the space
(`cf services`: exactly one PostgreSQL instance, or one with the default
name, or one bound to a `<id>-app` = the Figaf Tool's pattern), else the
default. An instance that exists under the chosen name is accepted as it is
(never re-created, never deleted, never `update-service`d); a missing one is
created with the chosen plan (started in step 1, about 7 minutes). The same
`names` mechanism will serve the other instances later (a separate task).

Base services (step 3), database row: instance name, cf status, an access
pill (`access prepared` / `access not prepared` / `access entry stale` /
`access unknown` while the Credential Store binding is not active), plan,
bound apps, and the note. Buttons in XSUAA mode: **Prepare database access**
(instance ready, access not prepared; the name field is still editable
here), **Prepare again** (idempotent; the password is kept), **Rotate
password** (new password, entry updated, shared backend restarted when
deployed), **Drop the FAID schema...** under a confirmation that names the
instance (`DROP SCHEMA faid CASCADE`, `DROP ROLE faid_app`, entry deleted;
a deployed backend fails at its next start until Prepare runs again). The
prepare needs the manager's Credential Store binding, which is active only
after the restart at the end of step 1: that is why it lives in step 3.
Step 3 is done only when every required instance is ready AND the access is
prepared; step 4 is blocked until then; Install and Update refuse before
any push while it is not (section 3, step 2).

The manager administers through ONE standing service key of the instance,
named `figaf-manager` (Arsenii, 2026-09-08; it replaced a temporary key per
action: the manager's cf login can create a key at any time, so a temporary
key was no boundary, and a standing key is idempotent and lets the deploy
read the CA chain). The key lives in Cloud Foundry: `cf create-service-key`
on first use ("already exists" is success), `cf service-key` read quietly
with `auditStdout: false` for one action, dropped from memory afterwards;
deleted by **Drop the FAID schema** and by the manager's uninstall. On the
Figaf Tool's instance the customer's admin sees that key; the row says so.
The generated password (32 alphanumeric characters) is reused on a
re-run when the entry exists, so a running backend is never surprised. The
prepare verifies as `faid_app`: `current_schema()` is `faid`, and one table
of another schema (when one exists; found as the owner) answers `permission
denied`; a readable table is a refusal and nothing is stored. Failures name
their step (`instance`, `store`, `key`, `connect`, `role`, `schema`,
`grant`, `verify`) with the SQLSTATE and message, never the
statement text. `packages/core/faid-database.js` is the only module that
requires `pg`; it administers, it never reads or writes application data.
The instance is reachable only from inside the Cloud Foundry landscape (the
manager runs there; a laptop needs a `cf ssh -L` tunnel through an app in
the space, see the live run of 2026-09-08 in `docs/shared-database-plan.md`).

`faid:remove` of an app never touches the database; the schema and role stay
until a person drops them. The manager never deletes a database instance,
also one it created (`cf delete-service` by hand).

### 4.1 Optional services: on-premise PI/PO (decision 0011)

The module marks the PI/PO pair `optional` under the group `pipo`; a
release's CF app names the group in `optional` (today the shared backend).
Optional instances are never created by the normal runs:
`faid:prepareSpaceServices` and `faid:provisionServices` skip them unless the
caller passes `groups: ["pipo"]` or names the instance in `only`. They also never count as "missing": an
installation without a PI/PO system is complete, so they do not hold step 3
open and do not block step 4 (`setup-checklist.js` filters them out).

Today one group, `pipo`, with two instances:

| Instance | Offering / plan | Why |
|---|---|---|
| `figaf-connectivity` | `connectivity` / `lite` | the SAP Cloud Connector tunnel |
| `figaf-destination` | `destination` / `lite` | the destinations of PI/PO systems |

Both are SHARED with the Figaf tool (decision 0012), under Alex's names: an
instance that already exists is reused, never replaced, and nothing here ever
updates its configuration or deletes it. The shared backend names the group
(`"optional": ["pipo"]`), so the backend binds them when they exist and
starts without them when they do not.

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
    (`faid:bindPlatformService`). This exists because the optional group's
    instances are bound while the backend is PUSHED, and an Update
    installation is refused when the store holds nothing newer. It binds the
    instance to the shared backend and restarts THAT app (a CF binding only
    reaches an app after a restart; the manager is not restarted), takes the
    same lock as a deploy, and accepts only the instances of the groups the
    backend names in `optional`.

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
| Service plans | `faid:services({names})` | the base instances the release requires (section 4): one dropdown per instance that is missing and has more than one plan (PostgreSQL, Credential Store: `free` / `standard`, each with a one-line note); existing instances are shown as "exists" with their plan. The database row has a text field for the instance name (default `figaf-db`, prefilled with the space's PostgreSQL instance when there is one); leaving the field asks `faid:services` again for the typed name, so the row shows whether it exists, its plan and bound apps, and the consequence line (section 4.2) |
| Role assignment | `xsuaa:roleAssignmentPrecheck` | as before: with a BTP login the collection is assigned automatically to the named person; without it the button says so ("... without role assignment") |
| Prepare the XSUAA instance | `cf:createXsuaa` -> `faid:ensureXsuaa` | create or update `figaf-faid-xsuaa`, composed document; always runs |
| Assign role collection (optional) | `xsuaa:assignRoleCollection` | `btp assign security/role-collection FAID-Manager-Admin --to-user <e-mail>`; needs a BTP login in THIS session (a restart forgets it); subaccount GUID from the BTP login or from a throw-away service key of the instance |
| Create the base services | `faid:prepareSpaceServices({plans, names, groups})` | every missing instance except XSUAA, with the chosen plans and the typed names; an existing database under the typed name is accepted as it is; the Credential Store is awaited and bound to the manager (no restart); the database is started and NOT awaited, and never bound; non-fatal (the success state explains the repair path: Setup step 3) |
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
| 3 | Base services | the panel of section 4 (status list, self-refresh every 10 s while creating, repair actions when missing / failed / unbound, **Prepare database access** for the database, section 4.2) | all ready; Credential Store bound and active; database access prepared | step 1 |
| 4 | Shared backend and first app | button **Open FAID Apps** (Install deploys the shared backend before the app) | platform running | step 3 (all instances ready) |
| 5 | Figaf tool connection | button **Open Connections** | configured | step 1; binding active |

Step 3 is omitted for a release whose CF apps require no service instance.
When the release cannot be read at all (`faid:services` fails: a catalog
older than v7, an unreachable store), step 1 says so in its when-line and
shows the error where the service plans would be; **Prepare the space** is
disabled until the manager reads a release again. Nothing is hidden silently.
Each step has a why-line
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
`stop` / `delete` / `roles` / `database`; the database actions of section
4.2: `instance` / `store` / `key` / `connect` / `role` / `schema` / `grant` /
`verify` / `restart`), the exact command (masked; for `download` the
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
- The database owner (`dbo`) credential exists for the manager as one
  standing service key `figaf-manager` in Cloud Foundry, read for one admin
  action and never stored by the manager; the `faid_app` password lives in
  the Credential Store only; the CA chain is public and travels as an
  environment variable of the backend. Every `cf service-key` read is in
  the manager's audit log (section 4.2). The database instance is never
  bound to a FAID app.
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
- Editable names for the other instances (`figaf-connectivity`,
  `figaf-destination`, XSUAA, Credential Store): one `nameEditable` column
  change in `base-services.js` plus a discovery source per instance (the
  bindings) on top of the `names` mechanism of section 4.2.
- Deleting a database instance from the manager, also one it created.
- Figaf-tool management parity (env vars, manifest parameters, persisted
  deployment metadata) — requirements to be written (plan Step 2).
