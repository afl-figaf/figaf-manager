# L3 console — open items and design notes

This file holds only what is still OPEN for the Figaf Manager's L3 console,
plus the design notes that are still in force. It is not a log. History is in
git (`git log -p docs/l3-console/OPEN-ITEMS.md`; before 2026-09-03 the file
was `spikes/app-manager-poc/FINDINGS.md` in the figaf-l3-l4 repo). Behavior
is in `SPEC.md`, reasons are in figaf-l3-l4 `decisions/`, run records in
figaf-l3-l4 `docs/d1/RUNBOOK-VIRGIN.md`. Platform-level notes (release model,
Figaf API client scopes) live in figaf-l3-l4 `docs/SOLUTION.md`.
Last edited 2026-09-04.

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
4. **R2 artifact store**: bucket + scoped credentials from Daniel (figaf-l3-l4
   decision 0003); then the catalog fetch from R2
   (`host.resolveL3ArtifactsDir()` is the seam) and the manager's own release
   publishing.
5. **Space Auditor** for the management user in the Figaf-tool spaces, so
   cross-space discovery of Figaf-tool deployments works under the technical
   user (a single-space user sees only its own space; manual URL entry is the
   fallback).
6. **Pre-existing failing cloud test** `btp:listGlobalAccounts with a single GA
   auto-selects it` — fails on master too; fix or quarantine. The cloud tests
   (`apps/figaf-manager/cloud/*.test.js`) are not part of `npm test` and so
   not part of CI.
7. **Pinning** (small parts done 2026-09-04): `btpCliVersion` and
   `cfCliVersion` in `apps/figaf-manager/package.json` fix the bundled CLIs;
   `build-zip.js` downloads exactly those versions, re-downloads when a pin
   changes, fails when the download does not match, and writes
   `bin/VERSIONS.json`; `engines.node` is `22.x` for the manager and its
   approuter; the staged `package.json` carries the exact top-level
   dependency versions from the workspace lockfile; the About page and the
   environment checks show the runtime versions against the pins. Still
   open: transitive npm dependencies float within the ranges of the pinned
   packages (a lockfile in staging needs a manager push test first); the
   buildpack is the landscape's system buildpack; stack `cflinuxfs4` is
   deprecated (new pushes end 2027-04, `cflinuxfs5` default from 2027-02);
   the Figaf-tool deploy templates are unversioned
   (`FIGAF-TOOL-MANAGEMENT-GAPS.md` 2.4). Seen in the first pinned build
   (2026-09-04): `@sap/xsenv` 4.2.0 declares Node up to 20 in its `engines`
   (npm warns on 22; check for a newer release), and the dev machine runs
   Node 24, so `npm install` warns about `engines.node` 22.x there (the
   container is what counts; CI builds with 22).
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
11. **Customer manual for the L3 console**: Alex's manual covers the
    Figaf-tool flow only. The customer prerequisites are in figaf-l3-l4
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

## Design notes still in force

### Desktop installer frozen (Arsenii, 2026-09-03)

`apps/figaf-local` keeps working and keeps building, but gets no new features.
The L3 console, the connections screen and the Setup page are hosted-only
(`mode.js`: `manageL3Apps`, `consoleUI`, `cfFirstLogin`). Shared changes must
still not break the desktop wizard. Its release job in `release.yml` is
already disabled. To be confirmed with Alex.

### The manager has no memory (fact, 2026-09-03)

The manager has no database. Its per-session user data lives under
`$HOME/sessions/<sessionId>` in the container and is gone after a restart or
restage. What survives a restart comes from three places only: the service
bindings (`VCAP_SERVICES`), the Credential Store (management user,
connections) and the Cloud Foundry space itself. For the L3 console this is by
design: the installed apps and their versions are read live from the space
(`cf env <app>`, the release version env var), so nothing needs to be stored.
For the Figaf-tool flows it is a gap: `vars.yml` and the update state under
the session directory are lost, so a re-entered flow starts blank.

One deliberate piece of memory was added on 2026-09-04: which lifecycle action
is running now (`l3-apps.js`, module scope — one lock for every session of the
container). It is gone after a restart, and that is acceptable: the console
then falls back to Cloud Foundry itself, where a part with a build in
`STAGING` still reads as `Installing…` (SPEC section 3).

### Auth roadmap (Arsenii, 2026-08-31, updated 2026-09-03)

Token mode exists only until the Secure-access step (now step 1). The
management user (Credential Store, option B of decision 0004 item 3) covers
unattended sign-in: restarts, scheduled updates, L4-triggered actions.
Attribution then comes from the manager's audit log (the XSUAA login says
who). Middle option to evaluate later: keep each person's own CF refresh
token per IAS user, so a passcode is needed only rarely and the technical
user is reserved for automation. Zero passcodes on a virgin space is
impossible: the first cf login is also the authorization moment.

### Naming rules confirmed

Release / artifact store (not "channel"); `figaf-l3l4-` = shared by L3 and
L4; `figaf-l3-<app-id>` = one L3 frontend; the shared backend connector is
"Shared backend" in the UI, CF app `figaf-l3l4-backend`; "approuter", not
"authentication proxy". Frozen identifiers: figaf-l3-l4 decisions 0008 and 0009.

### Environment facts

- `credstore` free plan: exactly one instance per subaccount; standard is the
  realistic plan (cost belongs in pricing).
- PostgreSQL: ~8 min to delete, ~7 min to create.
- The `it-rt/api` broker returned 500s on 2026-09-02; it is not part of the
  L3 install.
- Windows build machine: release zips must be made with figaf-l3-l4
  `release/zip-dir.js` (Unix permission bits), `build-zip.js` uses
  `System32\tar.exe`, JSON written without a BOM.
- The cockpit upload keeps `manifest.yml` inside the container; `cf push -p`
  strips it. The install smoke runs in the container's shape on purpose.
