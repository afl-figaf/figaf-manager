# Figaf-tool management through the manager — gaps before release 1

Written 2026-09-03 for the talk between Arsenii and Alex. Question to answer:
what does the hosted manager still lack to deploy, update and connect the
**Figaf tool** from the console frame, in a customer's space, as reliably as
it installs the FAID Apps? Facts come from the code on branch
`poc/faid-apps-manager`. Each gap ends with the decision it needs.

## 1. What exists today (facts)

- **Flows** (Alex's product, wizard frame): *Deploy Figaf Tool*, *Update Figaf
  Tool*, *Connect to Integration Suite*, *Enable persistent SSO login*, and the
  manager's self-update. The update flow is hosted-only
  (`update:*` handlers refuse desktop mode).
- **Detection** (`update:detectDeployment`): probes `<id>-app` and
  `<id>-router` with `cf app` in the **current space**; if the id is unknown,
  lists candidates through `cf curl /v3/apps` in that space. The running image
  tag comes from `/v3/apps/<guid>/droplets/current`.
- **Live configuration** (`update:readCurrentConfig`): read back from the
  deployed app's environment variables (`/v3/apps/<guid>/environment_variables`):
  `LOCATION_ID`, `MAX_RAM_PERCENTAGE`, `LOGS_TOTAL_SIZE_CAP`,
  `ENABLE_INSTANCE_MONITORING`, the SMTP cloud-connector settings, and the apps
  domain derived from `BTP_APP_ROUTER_URL`. Values that are not in the
  environment (Docker Hub user name, instance memory, the PostgreSQL plan) are
  not recoverable this way.
- **Additional environment variables** (since 2026-09-14, `TEMPLATE_ENV_KEYS`,
  `validateEnvRows` and `applyManifestEnv` in
  `packages/core/figaf-tool-templates.js`): the Configuration screen and the
  Update form carry a free-form key/value table. `config:writeVars` writes the
  rows into the app block of `manifest.yml` (from the pristine copy, so a
  second deployment in one container starts clean), which covers the fresh
  deploy and the update through the one push both already use.
  `update:readCurrentConfig` returns every live variable outside
  `TEMPLATE_ENV_KEYS` as `additionalEnv`, so a variable somebody set with
  `cf set-env` by hand is visible for the first time; `update:writeVars` runs
  `cf unset-env` for a row the operator removed, because `cf push` with a
  manifest never removes a variable the manifest stopped naming. The names
  themselves (`ADDITIONAL_IRT_PARAMETERS`, `IRT_ROOT_LOGGING_LEVEL`, the
  keystore group, …) are documentation, not a list in the manager; the table
  refuses only the keys the template already owns. Secret-looking values are
  accepted: the audit log redacts them by key name
  (`packages/core/audit-log.js`) and the value travels in a file, never on a
  command line, so it does not reach the terminal drawer.
- **Deploy templates**: `manifest.yml`, `vars.yml`, `xs-security.json`,
  `db.json` and the approuter come from the GitHub repository
  `figaf/Figaf-BTP-Deployment`, branch `btp-users`, downloaded as a zip on
  first use per container (`resolveDeployDir`; override
  `FIGAF_DEPLOYMENT_ZIP_URL`). The update flow forces a fresh download.
- **State the manager keeps**: none that survives a restart. `vars.yml` and
  `figaf-tool-update/update-state.json` live under the session directory
  `$HOME/sessions/<sessionId>`, which is wiped on restart or restage
  (`OPEN-ITEMS.md`, "The manager has no memory").
- **Sign-in the flows assume**: the operator's own Cloud Foundry session
  (passcode) and, for role assignment and IAS, a BTP CLI login. Both are lost
  on restart.
- **Console frame** (since 2026-09-02): the Figaf-tool flows are reachable
  from the rail (`screen-figaf-tool.jsx`), but they were built for the
  one-time wizard frame and were never run end to end in the console.
- **Service instances of a deployment** (since 2026-09-08,
  `packages/ui/figaf-tool-services.js`, `packages/core/figaf-tool-templates.js`):
  the database (`figaf-db`) and the XSUAA instance (`figaf-xsuaa`) have
  editable names on the Configuration screen. An instance that exists in
  the space is reused as it is: no plan and no PostgreSQL parameters are
  asked for an existing database (usually the one shared with the FAID
  backend), no `cf create-service` runs for an existing XSUAA instance. The
  `xsappname` in `xs-security.json` follows the XSUAA instance name, because
  XSUAA wants it unique per subaccount. `manifest.yml` and `xs-security.json`
  are patched from a pristine copy (`<file>.template`), so a second deploy
  in one container starts clean. The update flow finds the bound XSUAA and
  database instances by offering (`cf services`), so a renamed deployment
  can be updated.

## 2. Gaps

### 2.1 Never tested through the console

Fact: no run record exists for Deploy, Update or Connect through the console
frame. One known bug: the Figaf-tool login and settings are not kept when the
person leaves the flow and comes back.
Why it matters: the console is what customers will see; the wizard frame is
going away.
Decision: run Deploy and Update once in the dev space through the console and
record it like the virgin runs (figaf-faid `docs/d1/RUNBOOK-VIRGIN.md`);
then decide whether the Figaf-tool pages are **in** release 1 or **hidden**
behind a flag until they pass.

### 2.2 No persisted deployment metadata

Fact: the manager stores nothing about a Figaf-tool deployment. After a
restart it re-derives what it can from the deployed app's environment; the
rest (Docker Hub user, memory, plan, chosen tag, half-finished update) is gone.
Narrower since 2026-09-14: everything that IS in the app's environment now
comes back, including variables the manager never knew about (see the
additional environment variables above). What stays open is what the
environment does not hold. `DOCKER_USERNAME` is the sharp edge: an update
re-downloads `vars.yml` with the field empty and `config:writeVars` skips
empty values, so the updated app pushes without a Docker Hub user and can hit
the pull rate limit. It is readable from `/v3/apps/<guid>/packages`
(`data.username`) — the same shape as option (b) below.
The FAID Apps console does not have this problem because a release version env var
on each app is the whole state.
Why it matters: "update never silently changes memory, domain, location or
SMTP" is the promise of the update flow; it needs the previous values.
Options: (a) write a metadata entry per deployment into the Credential Store
(the manager already owns a namespace there); (b) put the missing values into
the deployed app's own environment or CF metadata labels at deploy time, so
they can be read back like the others; (c) keep the current best-effort
re-derivation and ask the person for the rest.
Decision: pick (a) or (b); (b) keeps the runtime independent of the manager,
which is the rule for the FAID Apps too.

### 2.3 Which identity runs Figaf-tool operations — DECIDED 2026-09-08 (Arsenii)

The stored management user signs in to Cloud Foundry only. It deploys and
updates the Figaf tool wherever it has Space Developer (customer
prerequisite, figaf-faid `docs/d1/MANUAL-RUNBOOK.md` item 4). The three
steps that use the BTP CLI — role-collection assignment (`btp assign`), the
IAS service and the IAS trust (`connect:createIasService`,
`connect:establishIasTrust`) — stay **person-only**: they run under the
person's own `btp login --sso`, which is never stored and is gone after a
restart. The console says so next to each blocked button.

Why not an unattended `btp login` with the stored user: it would need
Subaccount Administrator rights for a password-only account without 2FA
(the subaccount operations are subaccount-level), a stored global-account
subdomain and subaccount id, and a security decision by Daniel and the
customer. Revisit when a scheduled or agent-triggered update needs a role
change; the alternative then is a role-collection mapping to the customer's
identity-provider groups, which removes per-user assignment altogether.
Cross-space discovery under the technical user (Space Auditor) stays
`OPEN-ITEMS.md` item 5.

### 2.4 Templates are unversioned and fetched from GitHub at run time

Fact: the templates are the HEAD of a GitHub branch, downloaded by the
customer's container. The manager's own zip is versioned; the templates it
applies are not. Self-update also calls `api.github.com`; tag lookup calls
Docker Hub. The templates' approuter still declares Node `22.x` and no
stack, so the Figaf tool's router gets the landscape's default stack
(`cflinuxfs4`, deprecated); the manager and the FAID release moved to Node
`24.x` and `cflinuxfs5` on 2026-09-07 (figaf-faid decision 0015). The copy in
`packages/deploy-templates/` is not what runs; change the GitHub templates
(Alex) together with their versioning.
Why it matters: "one build, one version, one delivery" (governance decision
2). An update can pick up template changes nobody released. Customers with
restricted egress cannot reach GitHub; `FIGAF_DEPLOYMENT_ZIP_URL` and
`FIGAF_DISABLE_SELF_UPDATE` are the only knobs today.
Decision: ship the templates versioned inside the manager release (the same
shape as the FAID release catalog), or version them in the source repository
by tag and pin the tag in the manager. Either way the Docker Hub and GitHub
calls need a documented offline story.

### 2.5 Connect to Integration Suite is partly a stub

Fact: the custom SAML IdP path is complete; the IAS, S-user and passport
modes are stubs (`screen-connect-idp-{ias,suser,passport}.jsx`). PI/PO
connectivity services are reserved but commented out in the template.
Decision: which modes does release 1 support? Hide the stubs.

### 2.6 Legacy installations and the shared XSUAA instance

Fact: existing Figaf Manager installations are bound to `figaf-manager-xsuaa`
(legacy mode, decision 0009). New installations use `figaf-faid-xsuaa`. The
approuter accepts both scopes; no migration exists.
Decision: when and how legacy installations move (rebind, restage, reassign
the collection), and whether Alex or the FAID stream owns it.

### 2.7 Two Figaf Tools in one subaccount

Facts (verified 2026-09-08 in the dev subaccount, org `figafpartner-1`):
space `dev` holds a Figaf Tool with `figaf-xsuaa` (xsappname
`figaf-xsuaa!t157978`) and the role collections `IRTAdmin`, `IRTUser` and
the rest. A deploy into space `figaf-faid` then fails twice: with the
default XSUAA name at the xsappname (`Application with xsappname
figaf-xsuaa!t157978 already exists`; the failed instance stays in the space
as `create failed` and must be deleted), and with another XSUAA name at the
role collections (`Role Collection IRTAdmin already exists in this
subaccount. Please choose a different name.`). Role collections are
subaccount-wide. The existing instance cannot be reused from another
space: the `xsuaa` offering is not shareable (`cf curl
/v3/service_offerings?names=xsuaa` -> `shareable: false`), so
`cf share-service` is refused and a binding across spaces does not exist.
Why it matters: a customer with a test and a production Figaf Tool in one
subaccount hits the same wall; so does our dev subaccount today.
Options: (a) unique names per deployment - a new XSUAA name, the
xsappname that follows it (built), and every role collection suffixed with
`_<xsuaa instance name>`; SAP's own answer for the same application in
several spaces of one subaccount; (b) one set of role collections that
holds the roles of BOTH apps - the second deployment's `xs-security.json`
declares no `role-collections`, and the new app's roles are added to the
existing collections (cockpit, or `btp` under the person's login); one
`IRTAdmin` then grants admin in both Figaf Tools; (c) one Figaf Tool per
subaccount, documented as a prerequisite - what customers do today.
Decision (Alex and Arsenii): open on 2026-09-08. Until then the manager
shows the broker's sentence as it is, and the Configuration screen marks a
failed instance as "not usable".

### 2.8 Manual

Fact: the published manual describes the wizard frame screen by screen. The
console frame changes navigation, sign-in order and the Setup page.
Decision: one manual for the console (Figaf tool and FAID Apps), or two.

## 3. Gaps on the Figaf tool side (L2 API)

Recorded in figaf-faid `docs/SOLUTION.md` 5.1: there is no published
`/api/v1` endpoint to create or list API clients, and none that reports a
client's scopes. Until they exist, connecting the manager to a Figaf tool
means typing a client id and secret created by hand in the Figaf tool's admin
UI. Backlog items for the Figaf tool, not workarounds.

## 4. Proposed order

1. Test run of Deploy and Update through the console in the dev space; record it.
2. Decide 2.3 (identity) and 2.2 (metadata) together; they shape the prerequisites.
3. Decide 2.1: in or hidden for release 1.
4. Version the templates (2.4).
5. Manual (2.8) after the console pages are final.
