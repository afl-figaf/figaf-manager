# App Manager — when an action fails

Purpose: the fixed procedure for a failed action in the Figaf App Manager
console (Install, Update installation, Re-deploy, Disable, Enable, Remove,
Health, Base services, Connections, reading the release store). Written after the 2026-09-03 failure, where an install failed
and the person saw "no logs, nothing". This file says where the evidence is,
who does what, and how a failure becomes a fix and a test.

Companion pieces: `e2e/tools/manager-log-failures.ps1` (reads the manager
log for you), figaf-faid `docs/d1/MANUAL-RUNBOOK.md` (the install procedure),
`SPEC.md` "Failed actions explain themselves" (the contract the console
follows), FigafManager `e2e/README.md` (the test tiers).

## The rule

Every action ends with a visible result.

- Success: the row or card changes (Running, Ready, Connected) and the
  terminal drawer ends with a green line `<action> <app>: done`.
- Failure: a red **Failed** panel appears at the top of the page and stays
  there until you press Dismiss or start the next action. It names the
  action and the app, WHERE it failed (step and CF app), what Cloud Foundry
  said, and the next step. The terminal drawer ends with a red line
  `<action> <app> FAILED at step "<step>" (<cf app>): <what cf said>`.

If an action ends with no panel and no change, that is a bug of the manager
itself. Report it like any other failure (below), with the words "silent
failure".

## Where the evidence is (three layers)

| Layer | Where | What it holds | Lives how long |
|---|---|---|---|
| 1. Failed panel | console page, top | action, where, error line, command, next step, **Copy report** | until Dismiss or the next action; gone on page reload |
| 2. Terminal drawer | bottom bar "CLI details" | every `cf` command of this browser session with its output; red = error | this page load only |
| 3. Manager log | `cf logs figaf-manager --recent`, or BTP cockpit -> app -> Logs | one JSON record per CLI call (`cli.spawn`: command; `cli.exit`: exit code + last output lines), one plain line `[action] <channel> failed ...` per failed action | the recent buffer only (minutes to hours); a log drain keeps history |

Layer 3 is the only one that survives a page reload. Read it soon after the
failure. Secret values never appear in any layer: `cf set-env` values, the
management user password, client secrets and service keys are masked before
they reach the terminal or the log.

## Procedure — the installing person

1. Read the **Failed** panel. The line "Next" is the first thing to try.
   Most failures have one plain cause: a base service not created yet, a
   Cloud Foundry session that ended, no free memory in the space, or a
   manager build that is too old.
2. Press **Show CLI output**. The last red lines are what Cloud Foundry said.
3. Fix the cause named in "Next" and run the action again. Try at most
   twice. Do not click around other actions to "make it work".
4. Still failing: press **Copy report** and send the text to Figaf (support
   ticket or chat). The report is complete: manager version, release
   version, org/space, action, step, error, command, next step. It contains
   no secrets.
5. Do NOT restart the manager while your browser session is active in
   token mode: the restart ends the session and the single-use token; you
   would need a new token from the log. (In SSO mode a restart only costs
   30-90 s.)
6. Do not click the blue banner "Installer update available": it replaces
   this manager with the standard installer.

## Procedure — Figaf support (Arsenii, or a Claude session on his behalf)

Read-only first. Nothing is restarted, pushed or deleted until the cause is
known and the installing person agrees.

1. Get the report text (step 4 above) or the panel content. It names the
   step and the CF app.
2. Read the manager log in readable form (PowerShell, cf logged in and
   targeted at the customer's space, or a saved log file):

   ```powershell
   cd C:\Figaf\Projects\FigafManager\e2e\tools
   .\manager-log-failures.ps1                 # failed CLI calls + failed actions
   .\manager-log-failures.ps1 -All            # every CLI call in the buffer
   .\manager-log-failures.ps1 -LogFile C:\tmp\manager.log
   ```

   Each failed call prints as: time, `exit <code>`, the command, and the
   last lines the CLI printed. This is the same content as the panel, plus
   every call before and after it.
3. Look at the space: `cf apps`, `cf services`, `cf service <name>`,
   `cf app <name>`. For an app that was pushed but did not start:
   `cf logs <app> --recent` (the app's own output, e.g. a crash on boot).
   For the platform base after a start: probe
   `https://<backend route>/health/connections` with a browser or
   `Invoke-WebRequest` (it answers 503 with a JSON body when a connection is
   not configured — that is a result, not a failure).
4. Match the symptom against the table below. If it is a new one: it is a
   manager bug or a missing hint. Fix it in the FigafManager branch:
   reproduce with the e2e harness first (the local server has the same
   working-directory shape as the container), fix, unit tests, `npm run
   test:e2e`, then the install smoke `npm run test:e2e:install` against the
   dev space, then build the zip. Add the new symptom to the hint list in
   `packages/ui/action-outcome.js` (with a unit test) and to the table below.
5. Hand the new build to the installing person with the exact step to
   repeat. Record the case: `SPEC.md` (the new behavior), `OPEN-ITEMS.md` only if something stays open, and the run
   record in figaf-faid `docs/d1/RUNBOOK-VIRGIN.md` if it happened during a run.

## Known failures

| The panel says | Cause | Fix |
|---|---|---|
| `cf push <app> failed: For application '<app>': Buildpack and Buildpacks fields cannot be used together.` (log shows `Applying manifest file /home/vcap/app/manifest.yml`) | Manager build older than 2026-09-03 deployed through the BTP cockpit upload. The cockpit keeps the manager's own `manifest.yml` in the container (`cf push` would have stripped it), and the manager's `cf push` picked it up as the base of the FAID app. | Deploy the current manager build (pushes with `--no-manifest`), then Install again. Nothing was created by the failed push. |
| `required service instance(s) missing: <names> — create them first (Setup, step 3)` | Base services not created yet, or still creating. | Base services card -> Create missing services; wait for "all ready"; Install again. |
| `this release needs the Cloud Foundry stack cflinuxfs5, which this landscape does not offer (cf stacks: …)` | The release names the stack of every CF app (figaf-faid decision 0015; `cflinuxfs5` since release 0.5.0) and the landscape has not received it yet. Nothing was pushed. | `cf stacks` on the landscape; ask SAP when the stack arrives, or ask Figaf for a release built for an available stack. |
| `bind-service <name> failed — does the service instance exist in this space?` | The instance is missing, or in state "create failed". | `cf service <name>`; the Base services card deletes a failed instance and creates it again on the next click. |
| `cf curl /v3/apps failed — are you logged in and targeted?` / `Not logged in` | The Cloud Foundry session of the manager ended (restart, expiry). | Session & access -> sign in again (stored management user, or passcode). |
| `cf start <app> failed — see the staging log in the terminal: Start unsuccessful` (or `: WARNING: The stack 'cflinuxfs4' is 'DEPRECATED' …` — the cf CLI prints that warning LAST on stderr, so it can hide the real reason; OPEN-ITEMS 15) | The app crashed on start (bad env, missing binding, code error, failed schema migration). | Terminal drawer for the staging log; `cf logs <app> --recent` for the app's own output (`[APP/PROC/WEB/0] ERR` lines). |
| `cf start figaf-faid-backend failed …` and `cf logs figaf-faid-backend --recent` shows `schema migrations FAILED: relation "b2b_archiving_configs" already exists` | The database still holds the table that release 0.4.1 created at runtime. From release 0.4.4 migration 0001 creates it and refuses to run over the old one (figaf-faid decision 0013, item 6: fail closed; nobody but Figaf has a 0.4.1 database). | Delete the database instance and let Setup step 3 create it again (`cf unbind-service figaf-faid-backend figaf-faid-db`, `cf delete-service figaf-faid-db -f`, ~8 + ~7 minutes), or a full wipe. Then Install again. |
| `... memory limit ...` / `insufficient resources` | The space's memory quota is full. | Remove unused apps or raise the quota (BTP cockpit -> space -> quota). |
| `checksum mismatch for <file>: release.json says … the download is …` / `checksum mismatch for <artifact> — the release is corrupt` | A file in the release store does not match the checksum published with it (damaged upload, or changed after publishing). The manager deleted the download; nothing was deployed. | Press **Refresh releases** and try again. If it repeats, Figaf publishes the release again as a NEW version (`release/publish.js` refuses to overwrite). With a local release directory: build the release again. |
| `cannot read <url>/index.json: …` (panel: "The release store cannot be read") | The space cannot reach the release store URL (`FIGAF_FAID_RELEASE_URL` in the manager's `manifest.yml`), or the store has no `index.json` under that prefix. | Open the URL in a browser; check egress from the space; compare the URL with the one figaf-faid `release/README.md` names. Nothing was changed. |
| `download of <file> failed: HTTP 404` | The version's catalog names a file the store does not hold (an unfinished publish, or a store that was edited by hand). | `node release/publish.js --verify <version>` in figaf-faid shows which file is missing; publish the release again as a new version. |
| `No release source configured: set FIGAF_FAID_RELEASE_URL …` | The manager runs without `FIGAF_FAID_RELEASE_URL` (a `manifest.yml` older than 2026-09-04) and without a local release directory. | Deploy the current manager build; its `manifest.yml` carries the store URL. |
| `version X is not in the release store (available: …)` / `… lower than the installed … rollback is not supported` / `Install uses the installed version …` / `nothing is installed yet — install an app first` | The version rule of decision 0010: one version per installation. Install adds an app at the installed version (latest on an empty space); Update installation moves everything upwards. | Press **Refresh releases**; choose a version the Release panel offers. |
| `<action> of <app> is already running (started <time> ago)` | A second action was started while one was running (a page reload, a second tab, or a second sign-in). The manager runs one lifecycle action at a time. | Wait until the running action ends - the app row shows `Installing…` and the parts show `staging`. Nothing was changed by the refused call. |
| The row says `Installing…` and every button is off, but you started nothing | Cloud Foundry is staging a build of this app (a fresh install keeps the CF app STOPPED until staging and start are through), or another page started the action. | Wait. The page refreshes itself every 10 s while an action runs. `cf logs <app> --recent` shows the staging output. |
| `could not resolve the route of figaf-faid-backend` | The frontend was deployed while the platform base has no route (not started, or deleted by hand). | Install again (the platform base is deployed first, every time). |

## Why the 2026-09-03 case was invisible, and what changed

- The error text the console showed was generic (`cf push X failed`) and the
  status refresh that follows every action cleared it within a second.
  Now: the result carries the step, the CF app, the command and the CLI's
  last lines; the panel stays until dismissed; the refresh never clears it.
- The terminal drawer had the CLI lines, but it was closed and nothing
  pointed at it. Now: the panel has **Show CLI output**, and every action
  ends with one summary line in the drawer.
- The manager log had the facts (`cli.exit` record with `stderrTail`), but
  as JSON blobs between router lines. Now: `manager-log-failures.ps1` prints
  them readable, and every failed action also writes one plain
  `[action] ... failed` line.
- No test executed a real `cf push` from the manager process, so nothing
  could see what the process brings into the push. Now: the install smoke
  (`npm run test:e2e:install`) is the gate before every build that ships.
