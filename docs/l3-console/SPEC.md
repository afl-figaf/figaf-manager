# Figaf App Manager for L3 apps — specification (current state)

Status: current state of the L3 console in `figaf/FigafManager`, branch
`poc/l3-app-manager` (pushed 2026-09-03, not merged into master). This file
describes how the manager behaves TODAY, by topic. It is edited in place when
behavior changes; superseded text is removed, not kept. Reasons for the design
are in the figaf-l3-l4 repo (`decisions/`); the human install procedure is
figaf-l3-l4 `docs/d1/MANUAL-RUNBOOK.md`; run records are figaf-l3-l4
`docs/d1/RUNBOOK-VIRGIN.md`; what to do when an action fails is
`TROUBLESHOOTING.md` and what is still open is `OPEN-ITEMS.md` (this folder).
Last edited 2026-09-03 (evening: Setup page, plans asked in step 1, database
started in step 1).

Not decided here: whether a zip release installed by the manager
replaces the MTAR as the delivery unit (GOVERNANCE decision 2). That is
decision 0007, a team decision.

## 1. Purpose

A BTP-hosted manager app installs, updates, disables, enables, removes and
checks L3 applications in its own Cloud Foundry space from a browser, with
every CLI command visible, and without stored personal credentials. It also
creates the service instances the platform needs, sets up its own persistent
sign-in, and holds the system connections the apps use.

## 2. Release and catalog (v3)

A RELEASE is a versioned set: `catalog.json` plus one zip per CF app. It lives
in an ARTIFACT STORE (today: bundled in the manager zip at `l3-artifacts/`;
later: Cloudflare R2, decision 0003). The word "channel" is retired.
figaf-l3-l4 `release/build-artifacts.ps1` builds a release from the playground.

```json
{
  "releaseVersion": "0.4.0",
  "services": [
    { "name": "figaf-l3l4-db", "offering": "postgresql-db", "plan": "free",
      "plans": ["free", "standard"], "purpose": "Application database" },
    { "name": "figaf-l3l4-xsuaa", "offering": "xsuaa", "plan": "application",
      "configFile": "xs-security.json", "purpose": "Roles of the L3 apps" },
    { "name": "figaf-l3l4-credstore", "offering": "credstore", "plan": "free",
      "plans": ["free", "standard"], "config": { "authentication": { "type": "basic" } },
      "purpose": "Credential Store", "bindToManager": true }
  ],
  "platform": {
    "name": "Shared backend (connector)",
    "cfApps": [ { "name": "figaf-l3l4-backend", "artifact": "backend.zip", "sha256": "...",
                  "buildpack": "nodejs_buildpack", "memory": "256M", "disk": "1024M",
                  "services": ["figaf-l3l4-db", "figaf-l3l4-xsuaa"],
                  "optionalServices": ["figaf-l3l4-credstore"], "env": { } } ]
  },
  "apps": [
    { "id": "b2b-archiving-setup", "name": "B2B Archiving Setup", "version": "0.4.0",
      "cfApps": [ { "name": "figaf-l3-b2b-archiving-setup", "artifact": "b2b-archiving-setup.zip",
                    "sha256": "...", "buildpack": "nodejs_buildpack", "memory": "128M", "disk": "512M",
                    "services": ["figaf-l3l4-xsuaa"], "env": { },
                    "destinationTo": "figaf-l3l4-backend", "destinationName": "figaf-l3l4-backend" } ],
      "configTargetCfApp": "figaf-l3l4-backend",
      "healthPath": "/health/connections",
      "roleCollections": ["FigafL3L4-B2BArchivingSetup-Viewer", "FigafL3L4-B2BArchivingSetup-Admin", "FigafL3L4-Platform-Admin"] }
  ]
}
```

Rules:

- `platform` = the shared backend connector, deployed and updated BEFORE any
  frontend, never touched by disable / enable / remove of an app. A catalog
  without `platform` keeps the older per-app behavior.
- `services` = the instances the manager creates when missing. `plan` is the
  default, `plans` what the admin may choose (plans that cost money are the
  admin's decision). `configFile` ships next to the catalog; `config` is
  inline JSON. Both reach `cf create-service -c` as a FILE.
  `bindToManager` = bound to the manager itself (the Credential Store).
- `sha256` per artifact is verified before extraction; a mismatch deploys
  nothing.
- Names are frozen (decision 0008): CF apps `figaf-l3l4-backend`,
  `figaf-l3-<app-id>`; instances `figaf-l3l4-db/-xsuaa/-credstore`; approuter
  destination `figaf-l3l4-backend`. `channelVersion` is read as a legacy
  alias of `releaseVersion`.
- The release's `xs-security.json` holds the APPS' roles only; the manager
  merges its own roles in (section 5).

## 3. Lifecycle operations

RPC channels are `l3:*`, implemented in `packages/core/l3-apps.js`. Every cf
call is shown in the terminal drawer; secret values are masked there and in
the audit log.

| Operation | Behind it |
|---|---|
| `l3:catalog`, `l3:status` | catalog + live state per CF app from `cf curl /v3/apps` (scoped to the targeted space), installed version from the env var `FIGAF_APP_VERSION`, the in-flight action (`running`), and per part `staging` (a STOPPED part with a build in `STAGING`, one `cf curl /v3/builds`) |
| `l3:running` | the lifecycle action running now, or null. No cf call. For a page that did not start it (reload, second tab, second session) |
| `l3:services`, `l3:provisionServices({plans, only, waitOnly})` | `cf service <name>`; `cf create-service` for missing instances, poll every 10 s until `succeeded` (15 min limit); a `failed` instance is deleted and created again. With `waitOnly`, only those names are awaited; the others are started and reported as `pending` |
| `l3:bindManagerService`, `l3:restartSelf` | `cf bind-service <manager> <name>`; `cf restart <manager>` (fire-and-forget) |
| `l3:ensureXsuaa({updateOnly})` | create or `cf update-service figaf-l3l4-xsuaa` with the composed document (section 5) |
| `l3:prepareSpaceServices({plans})` | Setup step 1: create every missing catalog instance except XSUAA with the plans the person chose; wait only for the manager-bound ones (Credential Store) and bind them, no restart; the database is started and left creating (`pending`) (section 5.2) |
| `l3:prepareManagerServices` | legacy: the wizard frame's SSO upgrade (Credential Store only, default plan). Not used by the console |
| `l3:install`, `l3:update` | see below |
| `l3:disable`, `l3:enable`, `l3:remove` | `cf stop` / `cf start` / `cf delete -f -r` of the app's own CF apps, frontend first on teardown |
| `l3:health` | HTTPS GET `<route><healthPath>` on `configTargetCfApp`; a non-2xx answer WITH a body is a result, not a failure |
| `l3:configure` | `cf set-env` (whitelisted keys, masked) + restart; kept for rare infrastructure fixes, no form in the UI (behavior settings live in the app, decision 0006) |
| `l3:figafSystems` | discover Figaf-tool deployments visible to the cf login (`figaf/app:*`, `ilnfigaf/app:*` images; `FIGAF_TOOL_IMAGE_PREFIXES`) |

Install / update algorithm:

0. One lifecycle action at a time. `l3:install`, `l3:update`, `l3:disable`,
   `l3:enable`, `l3:remove` and `l3:configure` share one lock, held in module
   scope (so it covers every browser session of the container; an entry older
   than 30 minutes is treated as gone). A second action is refused with
   `{ ok:false, busy:true, running, error }` and changes nothing. Why: the
   console's own busy state lives in ONE page, and a fresh install keeps the
   CF app STOPPED for the whole staging time — on 2026-09-04 Install was
   pressed again while the shared backend was staging; the second push
   replaced the package and Cloud Foundry dropped the running build.
   While an action runs, the manager sends `l3:running` to every page of the
   session (payload `null` when it ends), `l3:status` carries `running`, and
   the console shows the status **Installing…** with every action button off
   and a status refresh every 10 s.
1. Refuse when a REQUIRED instance (any name in a cfApp's `services`) is
   missing: "create them first (Setup, step 3)".
2. Role refresh: `l3:ensureXsuaa({ updateOnly: true })` — the shared XSUAA
   instance gets the roles of the current release and of the manager. A
   failure stops the install (step `roles`).
3. Shared backend first, then the app's CF apps. Per CF app: verify sha256,
   extract, `cf push <name> -p <dir> -b <buildpack> -m -k --no-start
   --no-manifest` (fresh) or `cf push` without `--no-start` (update);
   `cf bind-service` for `services` and for `optionalServices` that exist;
   `cf set-env` for `env`, `FIGAF_APP_VERSION`, and for frontends the
   approuter `destinations` JSON pointing at the live backend route
   (`forwardAuthToken: true`); `cf start`.
4. `--no-manifest` is mandatory (push isolation): without it the cf CLI
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
blocked; nothing on it can restart the manager in token mode. L3 Applications
shows only a one-line status of the instances with a link to the Setup.

Reusing an existing PostgreSQL instance works by NAME: an instance called
`figaf-l3l4-db` is bound, never re-created. Only an instance dedicated to this
platform may be reused (a previous installation, or an empty pre-created
one), never the Figaf tool's database or one another application writes to.

## 5. Sign-in and access

### 5.1 One XSUAA instance (decision 0009)

`figaf-l3l4-xsuaa` (xsappname `figaf-l3l4`) carries the roles of the manager
AND of the apps. The manager composes the document from two parts:

- manager part `packages/core/manager-xsuaa-part.json`: scopes
  `FigafL3L4ManagerOperator` / `-Admin`, role templates with the same names,
  role collections `FigafL3L4-Manager-Operator` / `-Admin`, token validity
  3600 s / 86400 s;
- release part: the release's `xs-security.json`.

`composeXsSecurity()` (`packages/core/manager-xsuaa.js`): union by name, the
release wins on a name clash, xsappname always `figaf-l3l4` (another one is
refused), redirect URIs united, `__CF_APPS_DOMAIN__` filled with the
landscape's `cfapps.` domain (`cf curl /v3/domains`; no such domain = clear
error, nothing created). Used on create and on every update.

`figaf-manager-xsuaa` is not created any more. A manager bound to it (Alex's
shipped installations) keeps working: every `xsuaa:*` handler talks to the
bound instance; the approuter `xs-app.json` accepts either
`FigafL3L4ManagerOperator` or `FigafManagerOperator`; the JWT check picks the
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
| Service plans | `l3:services` | one dropdown per instance that is missing and has more than one plan (PostgreSQL, Credential Store: `free` / `standard`, each with a one-line note); existing instances are shown as "exists" |
| Role assignment | `xsuaa:roleAssignmentPrecheck` | as before: with a BTP login the collection is assigned automatically to the named person; without it the button says so ("... without role assignment") |
| Prepare the XSUAA instance | `cf:createXsuaa` -> `l3:ensureXsuaa` | create or update `figaf-l3l4-xsuaa`, composed document; always runs |
| Assign role collection (optional) | `xsuaa:assignRoleCollection` | `btp assign security/role-collection FigafL3L4-Manager-Admin --to-user <e-mail>`; needs a BTP login in THIS session (a restart forgets it); subaccount GUID from the BTP login or from a throw-away service key of the instance |
| Create the base services | `l3:prepareSpaceServices({plans})` | every missing instance except XSUAA, with the chosen plans; the Credential Store is awaited and bound to the manager (no restart); the database is started and NOT awaited; non-fatal (the success state explains the repair path: Setup step 3) |
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
| 4 | Shared backend and first app | button **Open L3 Applications** (Install deploys the shared backend before the app) | platform running | step 3 (all instances ready) |
| 5 | Figaf tool connection | button **Open Connections** | configured | step 1; binding active |

Step 3 is omitted for a release without `services`. Each step has a why-line
(what it gives) and a when-line (what it needs). The management-user and
Figaf states are read again every time the Setup or L3 Applications page is
shown; install and services states arrive from the pages themselves.

When every step is done the page shows "Installation complete", the landing
page becomes L3 Applications, and the Setup entry stays in the rail as the
status and repair page.

Order enforcement, seen by a new person on a fresh space:

- In token mode the rail entries L3 Applications, Connections and Figaf Tool
  are disabled ("after step 1"); clicking them opens the Setup. A deep link
  (bookmark) still opens the page, with a notice "Setup not finished - N of M
  done, next: <step>" and a button **Open Setup**. (The e2e harness runs in
  token mode and reaches the pages this way.)
- L3 Applications has no setup banner and no service-creation button any more;
  Session & access has no "Secure access" card any more.
- The legacy route `#/session/sso-upgrade` opens `#/setup`.

## 7. Connections (decision 0006)

The manager is the only writer of system connections; the apps' backend reads
them. Credential Store namespace `figaf-connections`:

- `figaf-tool` — the one Figaf tool of the installation: `{ baseUrl, tokenUrl,
  clientId, clientSecret, accessClientId?, accessClientSecret?, verifiedAt,
  agentCount }`. Verified before storing: OAuth token + `POST
  /api/v1/agent/search`. Needs API client scope `agent:read` today.
- `<agentId>/api` — one per connected Integration Suite system: `{ kind:
  "api", agentId, agentSystemId, agentName, baseUrl, tokenUrl, clientId,
  clientSecret, verifiedAt }`, from a pasted `it-rt` `api` service key
  (`uaa` and `oauth` key shapes accepted). Verified: token + `GET
  /api/v1/$metadata`.

Handlers (`packages/core/connections.js`): `connections:figafStatus` (masked),
`saveFigaf`, `deleteFigaf`, `listAgents` (live from the Figaf tool, 60 s
cache), `saveSystem`, `deleteSystem`. RPC audit redacts the secret fields.
UI: `screen-connections.jsx` (`#/connections`), Figaf card + one row per
agent with Connect / Replace / Disconnect.

App side (playground backend `srv/lib/platform-connections.js`): reads the
entries with a 60 s cache; credential source is an explicit SELECTOR in the
wizard ("App Manager connection" default when stored, "Enter key manually"
as a deliberate override); the backend enforces the source and never mixes
them; no source = legacy precedence for old frontends (decision 0005 gate).
Only the `api` kind is manager-managed today; DMS / Service Manager /
Destination keys stay in the app (next 0006 phase). API client scopes stay
installation-level: the catalog will declare per app the Figaf scopes it
needs; never per-app credentials (design note in figaf-l3-l4 `docs/SOLUTION.md` 2.5).

## 8. Console frame (hosted only)

Left rail = navigation: Setup (`#/setup`, landing while the space is not
prepared; sub label "N of M done") · L3 Applications (`#/apps`, landing once
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
it failed (`extract` / `push` / `bind` / `env` / `start` / `stop` / `delete`
/ `roles`), the exact command (masked), the CLI's last lines (`detail`, up to
400 characters). Console: a red **Failed** panel (`packages/ui/action-outcome.js`)
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
| Unit (`node:test`, handlers with a fake `run`; UI models `setup-checklist`, `prepare-space`, `action-outcome`, `sso-role-assign` with a fake window/api) | `npm test` (root); `node --test apps/figaf-manager/cloud/*.test.js` (cloud) | no | every change |
| E2E read-only (console specs + `failure-visibility` against a fixture release whose install is refused) | `npm run test:e2e` | reads | every UI or handler change, before every commit |
| E2E install smoke (mutating: real install through the console into the dev space, then remove) | `npm run test:e2e:install` | installs, removes | **before every manager build that is pushed or uploaded** |

Rules: a new console action gets its failure path in `failure-visibility.spec.js`;
a new known failure gets a hint in `action-outcome.js`, a unit test line, and
a row in `TROUBLESHOOTING.md`. Known: one pre-existing cloud test
(`btp:listGlobalAccounts ... auto-selects`) fails on master too.

## 12. Out of scope today / backlog

- Remote artifact store (R2) and the manager's own release publishing.
- Migration of legacy installations from `figaf-manager-xsuaa` to the shared
  instance.
- Role assignment to users (no API; cockpit, or `btp assign` by a person).
- Rollback (decommissioned: forward-only migrations, decision in SOLUTION 3.1).
- DMS / Service Manager / Destination credential kinds in the manager.
- "Use an existing instance" dropdown on the Base services card.
- Figaf-tool management parity (env vars, manifest parameters, persisted
  deployment metadata) — requirements to be written (plan Step 2).
