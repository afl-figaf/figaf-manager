# E2E specs (Playwright) — hosted manager against real Cloud Foundry

No mocks. The specs boot the REAL cloud server locally (`e2e/global-setup.js`)
with the REAL orchestrator, which runs the REAL `cf` CLI from PATH against
whatever space that CLI is logged into. UI changes are served straight from
`packages/ui` source, so the loop is: edit -> re-run specs. No build, no
`cf push`.

The local server runs from `apps/figaf-manager` — the directory that holds
`manifest.yml` — which is the same shape as the CF container after a cockpit
upload. What the manager PROCESS brings into a `cf push` shows up here
exactly as it does live (the 2026-09-03 manifest leak is the example).

## Three tiers, and when to run them

| Tier | Command | Touches CF? | Runs when |
|---|---|---|---|
| Unit (`node:test`, fake `run`) | `npm test` | no | every change |
| E2E read-only (console + failure visibility) | `npm run test:e2e` | reads only | every UI/handler change, before every commit |
| E2E install smoke (MUTATING) | `npm run test:e2e:install` | installs, then removes | **before every manager build that is pushed or uploaded** |

The install smoke is the only test that executes a real `cf push` from the
manager process. It is the gate that would have stopped the 2026-09-03
release. Do not skip it because "only docs changed in the manager" — the
zip is what ships.

Servers started by global-setup (choose with `E2E_SERVERS=main,failure,remote`):

- `main` on :8087 — the bundled release (`apps/figaf-manager/faid-artifacts`).
  It is a LOCAL release source (`FIGAF_FAID_ARTIFACTS_DIR`).
  Project `console` (read-only specs) and the install smoke run here.
- `failure` on :8088 — the fixture release `e2e/fixtures/release-missing-service`.
  Its platform base needs a service instance that does not exist, so every
  Install is refused BEFORE any cf change. Project `failure-visibility` runs
  here: a real failure, zero side effects.
- `remote` on :8089 — a REMOTE release source: `FIGAF_FAID_RELEASE_URL` points
  at a static file server on :8090 that serves `e2e/fixtures/store` (the
  bucket layout, versions 0.0.1 and 0.0.2; regenerate with
  `node e2e/tools/make-fixture-store.js`). Project `release-store` runs here:
  the same code path as Cloudflare R2, no internet, no cf change.

Run:

    npm run test:e2e                                   # read-only: console + failure-visibility
    npx playwright test e2e/console-baseline.spec.js   # one file
    npm run test:e2e:install                           # MUTATING install smoke (see below)
    E2E_KEEP_INSTALL=1 npm run test:e2e:install        # smoke that leaves the apps installed

Prerequisites on the dev machine:

- `cf` CLI on PATH, logged in (`cf login --sso`) and targeted at the dev
  space (today: org `Figaf ApS_figafpartner-1`, space `figaf-faid`).
- Node deps installed at the repo root (`npm install`).
- For the install smoke: the release built into `faid-artifacts/`
  (`node release/build.js --version x.y.z` in the figaf-faid repo) and a space WITHOUT the
  release's CF apps (the smoke refuses to start otherwise) but WITH the base
  service instances (`figaf-faid-db`, `-xsuaa`, `-credstore`). The smoke
  installs from the LOCAL build on purpose: it gates a release before it is
  published to the store (figaf-faid `release/README.md`).

## How auth works here (all real, nothing bypassed)

1. **Setup-token gate**: global-setup reads the single-use `[SETUP]` token
   from each server's stdout and claims it through the real `/setup/claim`
   endpoint, from a real browser context (the cookie is bound to IP + UA).
   The resulting storage state is shared by all specs of that project.
2. **cf login seeding (dev machine only)**: the server scopes each wizard
   session's CLI state to `<home>/sessions/<sid>/cli` (multi-user isolation
   in the hosted dyno). Locally there is exactly one user — the developer —
   so global-setup copies the developer's own `~/.cf/config.json` into that
   scoped directory. `session:state` then resumes the session as signed-in,
   exactly as it would after a passcode login. This is a harness convenience
   on the developer's own machine with the developer's own login; product
   code and its session isolation stay untouched.

   **Hazard (seen 2026-09-04).** The copied config carries the developer's
   refresh token. If the access token has already expired when the specs
   start, the first seeded session that refreshes gets a new token pair and
   the UAA revokes the old refresh token: for the other seeded server AND for
   the developer's own `cf`. Symptom: a red terminal line "The token expired,
   was revoked, or the token ID is incorrect", and `cf oauth-token` failing on
   the dev machine afterwards. Cure: `cf login --sso` again. Rule from now on:
   run `cf oauth-token > $null` (PowerShell; it refreshes the developer's
   token and prints nothing) right before `npm run test:e2e`, so the copies
   hold a fresh access token and never need to refresh during the run.

## Rules

- **Read-only by default.** Specs in the default suite must not change CF
  state (no install/remove/update/start/stop). State-changing specs are
  named `*.mutating.spec.js`, are ignored by the default config, and run
  only through `playwright.mutating.config.js` — deliberately, against a
  space you chose.
- **A failed action must be visible.** Any new action added to the console
  gets its failure path covered in `failure-visibility.spec.js` (extend the
  fixture release if needed): the outcome panel, the terminal summary line,
  the copyable report.
- One worker, no parallelism: all specs of a project share one server-side
  session.
- Assertions use generous timeouts: real `cf` calls take seconds; a fresh
  install takes minutes.

## Tools (`e2e/tools/`)

Dev-space helpers, run by a person, never by the specs:

- `wipe-and-provision.ps1 -Mode status|wipe|provision` — empties the dev
  space before a virgin run (guardrail: refuses any target other than
  `Figaf ApS_figafpartner-1` / `figaf-faid`). `provision` creates the base
  services from the bundled release's `xs-security.json`
  (`apps/figaf-manager/faid-artifacts/`, override with `-XsSecurity`); the
  customer path is the manager's Setup page, not this mode.
- `manager-log-failures.ps1` — reads `cf logs --recent` of the manager and
  prints the failed CLI calls and failed actions in readable form
  (`docs/faid-apps-console/TROUBLESHOOTING.md`).

The full virgin install procedure (D1) is figaf-faid `docs/d1/MANUAL-RUNBOOK.md`.
