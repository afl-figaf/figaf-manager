# FAID Apps console — open items and design notes

This file holds only what is still OPEN for the Figaf Manager's FAID Apps console,
plus the design notes that are still in force. It is not a log. History is in
git (`git log -p docs/faid-apps-console/OPEN-ITEMS.md`; before 2026-09-03 the file
was `spikes/app-manager-poc/FINDINGS.md` in the figaf-faid repo). Behavior
is in `SPEC.md`, reasons are in figaf-faid `decisions/`, run records in
figaf-faid `docs/d1/RUNBOOK-VIRGIN.md`. Platform-level notes (release model,
Figaf API client scopes) live in figaf-faid `docs/SOLUTION.md`.
Last edited 2026-09-08.

## Open items

1. **Run with a dedicated technical user.** Every virgin run so far (#1-#7)
   used Arsenii's own account as the stored management user.
2. **Figaf Tool flows** (Alex's deploy / update / connect) never tested through
   the console; one known bug: Figaf-tool login/settings not kept when
   re-entering the flow. Root cause: the manager keeps no state of its own
   (see "The manager has no memory" below). What is missing and the decisions
   it needs: `FIGAF-TOOL-MANAGEMENT-GAPS.md` (this folder), the input for the
   talk with Alex.
3. **Remove + reinstall repeatability** check (remove exists; reinstall after
   remove not yet done by hand).
4. **Release store, what is left** (the store itself is in use since
   2026-09-04, figaf-faid decision 0010): Daniel's confirmation that public
   downloads of platform builds are acceptable; a custom domain instead of
   `r2.dev` (Cloudflare: rate-limited, not for production; a change of
   `FIGAF_FAID_RELEASE_URL`); signed `release.json` later; the manager's own
   release publishing. Owed run: the install smoke against a manager whose
   source is the R2 URL (the smoke runs from the local build today), and one
   **Update installation** in the dev space (figaf-faid `docs/SOLUTION.md`
   3.4).
5. **Space Auditor** for the management user in the Figaf-tool spaces, so
   cross-space discovery of Figaf-tool deployments works under the technical
   user (a single-space user sees only its own space; manual URL entry is the
   fallback).
6. **Pre-existing failing cloud test** `btp:listGlobalAccounts with a single GA
   auto-selects it` — fails on master too; fix or quarantine. The cloud tests
   (`apps/figaf-manager/cloud/*.test.js`) are not part of `npm test` and so
   not part of CI.
7. **Two-app releases** (figaf-faid decision 0016, 2026-09-07): the fixture
   store now has two apps in 0.0.2 (one in 0.0.1) and `release-store.spec.js`
   proves both rows, both Install buttons, the union `figafScopes`, and that a
   refused install of the second app leaves the first row alone (read-only,
   green on 2026-09-07). Still owed, in the dev space through the install smoke: install
   of app B leaves app A running, remove of A leaves B and the backend, Update
   installation moves both. Also owed: a `failure-visibility` spec for the
   preflight refusal `figafScopes`; it is unreachable with the missing-service
   fixture (the service check comes first) and needs a fixture whose services
   exist plus a stored Figaf connection, so it stays unit-tested only.
7. **Pinning** (CLIs 2026-09-04; Node and stack 2026-09-07, figaf-faid
   decision 0015): `btpCliVersion` and `cfCliVersion` in
   `apps/figaf-manager/package.json` fix the bundled CLIs; `build-zip.js`
   downloads exactly those versions, re-downloads when a pin changes, fails
   when the download does not match, and writes `bin/VERSIONS.json`;
   `engines.node` is `24.x` for the manager and its approuter, CI and
   `.nvmrc` say 24; the manager's `manifest.yml` names the stack
   `cflinuxfs5`, the approuter follows it (`CF_STACK`, `cf-stack.js`), FAID
   apps take theirs from the release catalog; the staged `package.json`
   carries the exact top-level dependency versions from the workspace
   lockfile; the About page and the environment checks show the runtime
   versions against the pins. Still open: transitive npm dependencies float
   within the ranges of the pinned packages (a lockfile in staging needs a
   manager push test first); the buildpack is the landscape's system
   buildpack (the version it ships decides the exact Node 24 patch); the
   Figaf-tool deploy templates are unversioned and still say Node `22.x`
   with no stack (`FIGAF-TOOL-MANAGEMENT-GAPS.md` 2.4). Seen in the first
   pinned build (2026-09-04): `@sap/xsenv` 4.2.0 declares Node up to 20 in
   its `engines` (npm warns; check for a newer release). Not yet run: the
   first push of the manager and of a release on `cflinuxfs5` (the install
   smoke checks `cf app` reports the stack).
8. **Password login for persons** (Alex's login screen shows "Username &
   password - coming soon"): product decision open. Today by design only the
   passcode (the person's password never reaches the manager; works with
   2FA) and the technical user (unattended sign-in).
9. **No-2FA technical user**: acceptable for customers? Question for Daniel
   and Alex.
10. **Repo identity** (2026-09-03): the root package is still named
    `figaf-installer`; the architecture map in CLAUDE.md describes the
    Figaf-tool wizard and does not list the console files. The garbage
    removal itself is done (`docs/CLEANUP-2026-09-03.md`).
11. **Customer manual for the FAID Apps console**: Alex's manual covers the
    Figaf-tool flow only. The customer prerequisites are in figaf-faid
    `docs/d1/MANUAL-RUNBOOK.md`.
12. **E2E seeding and the refresh token** (2026-09-04): `e2e/global-setup.js`
    copies the developer's `~/.cf/config.json` into each seeded server
    session. When the access token has expired at start, the first session to
    refresh rotates the refresh token and the UAA revokes the copies,
    including the developer's own login (`cf oauth-token` then fails with
    "token expired, was revoked"). Cure today: `cf login --sso` again, then
    `cf oauth-token` right before the run (`e2e/README.md`). Fix to make:
    global-setup refreshes the token once before copying, or seeds one
    session only. Part of the test-suite discussion.

13. **`console-baseline.spec.js` step-4 assertion depends on the space**
    (2026-09-04): "setup page: five steps ... the rest 'after step 1'" expects
    step 4 (Shared backend and first app) to be blocked, but the checklist
    marks it done as soon as the platform row is `running` — so the spec fails
    in any space where the platform is already installed (our dev space since
    2026-09-04). Fix: assert the blocked steps that do not depend on installed
    apps, or run that spec against the fixture release. Part of the
    test-suite discussion.

14. **No target guard on the FAID Apps lifecycle handlers** (2026-09-04): the sign-in
    now pins the session to the manager's own org/space (SPEC section 5.3), so
    the normal path cannot install into the wrong space any more. The handlers
    themselves still trust the session: `faid:install`, `faid:update` and the
    remove/disable actions run `cf` against whatever space the session is
    targeting, and **Switch Org** can move it away (the Figaf-tool flows need
    that button). Only self-update checks (`update:selfTarget` compares the
    session against `VCAP_APPLICATION`). Fix: reuse that comparison as a
    pre-condition in `faid-apps.js` and refuse with a clear message, instead of
    installing somewhere else. Small, and worth doing before a customer runs
    the console.
15. **The Failed panel can show a cf WARNING instead of the reason**
    (2026-09-06, install of release 0.4.4): `cliFailureDetail()` in
    `packages/core/faid-apps.js` takes the last 3 stderr lines, and cf CLI 8.19
    prints the `cflinuxfs4 is DEPRECATED` warning LAST, after `Start
    unsuccessful` (that warning is gone for pushes on `cflinuxfs5`, item 7,
    but any cf WARNING has the same effect). The panel said the stack was the problem; the real cause
    (a failed schema migration) was only in `cf logs <app> --recent`. Fix:
    drop `WARNING:` lines (and their continuation) before taking the tail,
    and after a failed `start` step append the app's last `[APP/PROC/WEB]
    ERR` lines from `cf logs <app> --recent` to the detail. Extend
    `faid-apps.test.js` ("a failed cf start keeps the pointer") with a stderr
    that ends in the warning.

16. **The backend's database access (catalog v6, 2026-09-08; SPEC 4.2).**
    Built and tested: unit tests, the read-only e2e suite, the install
    smoke (backend started from the entry inside CF), a server-side
    render of the Base services card, and a live run of `faid-database.js`
    against the dev space through a `cf ssh` tunnel (`docs/shared-database-plan.md`
    section 6). The manager holds one standing service key `figaf-manager`
    on the instance (Arsenii, 2026-09-08). Still open: (a) the manager's own screens in XSUAA mode in
    the dev space (Setup step 3 **Prepare database access**, rotate, drop) -
    a virgin run with release 0.7.0; (b) decision 0008 amendment for the
    editable default name `figaf-db`, and decision 0012 section 9 (one
    procedure, no modes) - done 2026-09-08 (0008 amended, 0012 section 11);
    (c) the SAP support ticket on the binding user's privileges
    (BC-CP-BSB-POSTGRES) before go-live; (d) Daniel's sign-off on one
    backup and restore point when the Figaf Tool's instance is chosen (a
    BTP restore is per instance and creates a new one: the Tool must be
    bound again, the manager shows "stale" and needs Prepare again); (e)
    settled: nobody runs the backend without the manager (Arsenii,
    2026-09-08), so there is no local override; (f) editable names for the other instances on top of the `names`
    mechanism (a separate task); (g) release 0.7.0 is built locally, not
    published.

17. **The manager owns the base service instances** (2026-09-08; plan
    `docs/base-services-ownership-plan.md`, figaf-faid decision 0018). Built
    the same day in both repositories: `packages/core/base-services.js` is
    the one source of the base instances; the catalog (v7) says only what
    each CF app `requires` by kind and which optional groups it binds; a
    catalog of v6 or older is refused (no compatibility layer - no customer
    has an installation); the e2e fixtures refuse an install through a stack
    no landscape offers instead of a missing instance; `wipe-and-provision.ps1`
    reads the module. Unit suites green (SPEC sections 2 and 4 rewritten).
    Read-only e2e suite green against 0.8.0; 0.8.0 published to the store
    and verified (2026-09-08; `publish.js` learned to plan `xs-security.json`
    from `requires`, or it would have been left out). Still open: (a) the
    install smoke against 0.8.0 (the dev space is empty; it needs the base
    instances and the database access first); (b) one virgin run in the dev
    space with the manager in XSUAA mode (also the first live click on
    Prepare database access, item 16a); (c) the tag `faid-v0.8.0` exists
    locally in figaf-faid, branch and tag not pushed. The store's 0.5.0 to
    0.6.1 are v6 or older and are refused by this manager - the first release
    it installs is 0.8.0.

18. **Cards grouped by business area** (2026-09-10). The FAID Apps page
    shows cards in the sections Installed / Not installed / New in V
    (`packages/ui/faid-cards.js`). The App Manager of the prototypes
    (figaf-layer3, `app/appmanager`) groups its apps by business area
    instead (Archiving, Mappings, Partner Onboarding, ...), with a fixed
    list in its own code. The catalog (v7) has no such field, and the
    manager must not hold a list of app ids. Open: add a `group` (or
    `area`) field per app to the catalog in figaf-faid (`release/
    catalog.template.json`, `release/build.js`), then group the cards by it
    inside each section. Owner of the wording: Emil.

## Design notes still in force

### Desktop installer frozen (Arsenii, 2026-09-03)

`apps/figaf-local` keeps working and keeps building, but gets no new features.
The FAID Apps console, the connections screen and the Setup page are hosted-only
(`mode.js`: `manageFaidApps`, `consoleUI`, `cfFirstLogin`). Shared changes must
still not break the desktop wizard. Its release job in `release.yml` is
already disabled. To be confirmed with Alex.

### The manager has no memory (fact, 2026-09-03)

The manager has no database. Its per-session user data lives under
`$HOME/sessions/<sessionId>` in the container and is gone after a restart or
restage. What survives a restart comes from three places only: the service
bindings (`VCAP_SERVICES`), the Credential Store (management user,
connections) and the Cloud Foundry space itself. For the FAID Apps console this is by
design: the installed apps and their versions are read live from the space
(`cf env <app>`, the release version env var), so nothing needs to be stored.
For the Figaf-tool flows it is a gap: `vars.yml` and the update state under
the session directory are lost, so a re-entered flow starts blank.

One deliberate piece of memory was added on 2026-09-04: which lifecycle action
is running now (`faid-apps.js`, module scope — one lock for every session of the
container). It is gone after a restart, and that is acceptable: the console
then falls back to Cloud Foundry itself, where a part with a build in
`STAGING` still reads as `Installing…` (SPEC section 3).

### Auth roadmap (Arsenii, 2026-08-31, updated 2026-09-03)

Token mode exists only until the Secure-access step (now step 1). The
management user (Credential Store, option B of decision 0004 item 3) covers
unattended sign-in: restarts, scheduled updates, agent-triggered actions.
Attribution then comes from the manager's audit log (the XSUAA login says
who). Middle option to evaluate later: keep each person's own CF refresh
token per IAS user, so a passcode is needed only rarely and the technical
user is reserved for automation. Zero passcodes on a virgin space is
impossible: the first cf login is also the authorization moment.

### Naming rules confirmed

Release / release store (not "channel"); `figaf-faid-` = shared by FAID Apps and FAID Agents; `figaf-faid-apps-<app-id>` = one FAID Apps frontend; the shared backend connector is
"Shared backend" in the UI, CF app `figaf-faid-backend`; "approuter", not
"authentication proxy". Frozen identifiers: figaf-faid decisions 0008, 0009 and 0014 (product names).

### Environment facts

- `credstore` free plan: exactly one instance per subaccount; standard is the
  realistic plan (cost belongs in pricing).
- PostgreSQL: ~8 min to delete, ~7 min to create.
- The `it-rt/api` broker returned 500s on 2026-09-02; it is not part of the
  FAID Apps install.
- Windows build machine: release zips must be made with figaf-faid
  `release/zip-dir.js` (Unix permission bits), `build-zip.js` uses
  `System32\tar.exe`, JSON written without a BOM.
- The cockpit upload keeps `manifest.yml` inside the container; `cf push -p`
  strips it. The install smoke runs in the container's shape on purpose.
