# External Calls Audit

**Source of truth:** `packages/core/orchestrator.js` (runtime) and `apps/figaf-manager/scripts/build-zip.js` (build-time).
**Scope key:** `both` = figaf-local + figaf-manager · `desktop` = figaf-local (Electron) only · `cloud` = figaf-manager only

---

## BTP CLI (`btp`)

Binary resolved via `host.resolveBinary("btp")`.
- Desktop: persisted path in `userData/cliPaths.json`, else falls back to `$PATH`
- Cloud: bundled at `apps/figaf-manager/bin/btp` (Linux x86-64)

| # | Command | IPC handler | Scope | Notes |
|---|---------|-------------|-------|-------|
| 1 | `btp --version` | `prereq:installBtp`, `prereq:locateCli`, `prereq:bundledVersions` | both | Run after download/locate to verify the binary; `bundledVersions` compares the reported version with the build's pin (`bin/VERSIONS.json`) for the About page and the environment checks |
| 2 | `btp set config --login.showglobalaccounts true` | `btp:loginStart` | both | Forces GA prompt so the flow is deterministic; runs once before `btp login` |
| 3 | `btp login --url https://cli.btp.cloud.sap --sso` | `btp:loginStart` | both | Long-lived spawn; stdout/stderr piped through GA-prompt detector + SSO-URL extractor |
| 4 | `btp target --hierarchy true` (stdin interaction) | `btp:listGlobalAccounts`, `btp:selectGlobalAccount` | both | Long-lived spawn via `runTargetHierarchy()`; chosen index written to stdin |
| 5 | `btp target --subaccount <guid>` | `applySubaccountSelection` | both | Called after `btp:selectSubaccount` to sync CLI target |
| 6 | `btp --format json get accounts/global-account` | `btp:selectGlobalAccount` | both | Reads subdomain / guid / licenseType of the targeted GA |
| 7 | `btp --format json list accounts/subaccount` | `btp:listEnvInstances` | both | Lists all subaccounts in the current GA |
| 8 | `btp --format json list accounts/environment-instance --subaccount <guid>` | `btp:listEnvInstances` | both | Per-subaccount CF environment probe (called once per subaccount in a loop) |
| 9 | `btp logout` | `btp:cancelLogin`, `btp:logout`, `btp:selectGlobalAccount` (error path) | both | |
| 10 | `btp list security/user [--subaccount <guid>]` | `btp:listUsers` | both | |
| 11 | `btp assign security/role-collection <role> --to-user <user> [--subaccount <guid>]` | `btp:assignRole` | both | Role: defaults to `IRTAdmin` |
| 12 | `btp assign security/role-collection <rc> --to-user <user> --subaccount <sub>` | `xsuaa:assignRoleCollection` | cloud | rc defaults to `FigafManagerAdmin`; no `--of-idp` (uses primary IDP) |
| 13 | `btp --format json list accounts/subscription --subaccount <guid>` | `connect:integrationSuiteUrl` | both | `quiet:true` suppresses terminal output (~160 KB base64 icons) |
| 14 | `btp --format json list accounts/subscription --subaccount <guid>` | `connect:createIasService` (poll loop) | both | Polls every 10s, 15-min timeout |
| 15 | `btp --format json list security/trust --subaccount <guid>` | `connect:resolveIdpOrigin` | both | |
| 16 | `btp assign security/role-collection <role> --subaccount <sub> --of-idp <originKey> --to-group <group>` | `connect:assignPiRole` | both | PI role collections for SAML group |
| 17 | `btp subscribe accounts/subaccount --subaccount <guid> --to-app sap-identity-services-onboarding --plan default --parameters <tmpFile>` | `connect:createIasService` | both | `--parameters` uses a temp file to avoid Windows shell-quoting issues |
| 18 | `btp --format json list security/available-idp --subaccount <guid>` | `connect:establishIasTrust` | both | |
| 19 | `btp create security/trust --idp <tenant> --subaccount <sub> --name "SAP Cloud Identity Services"` | `connect:establishIasTrust` | both | |
| 20 | `btp delete security/role-collection FigafManagerOperator --force [--subaccount <guid>]` | `cf:uninstallManager` | cloud | Fire-and-forget teardown after manager self-deletes |
| 21 | `btp delete security/role-collection FigafManagerAdmin --force [--subaccount <guid>]` | `cf:uninstallManager` | cloud | Same teardown sequence as above |

---

## CF CLI (`cf`)

Binary resolved via `host.resolveBinary("cf")`.
- Desktop: persisted path in `userData/cliPaths.json`, else falls back to `$PATH`
- Cloud: bundled at `apps/figaf-manager/bin/cf` (Linux x86-64)

> **Non-command note:** `cf:suggestedApiUrl` (CF-only login pre-fill) performs no
> spawn. It returns `VCAP_APPLICATION.cf_api` (read in-process via the host's
> `getDeployTargetForSelf`) so the renderer can pre-fill the manual API-URL
> field when BTP login is skipped. That value then feeds `cf login -a` (row 2 below).
> Cloud-only; desktop returns `""`.

### Login & Targeting

| # | Command | IPC handler | Scope | Notes |
|---|---------|-------------|-------|-------|
| 1 | `cf --version` / `cf version` | `prereq:installCf`, `prereq:locateCli`, `prereq:bundledVersions` | both | Verify after download/locate; `bundledVersions` compares the reported version with the build's pin (`bin/VERSIONS.json`) |
| 2 | `cf login -a https://api.<landscape>.hana.ondemand.com --sso` | `cf:loginStart` | both | Long-lived spawn; parses "Select an org / space" picker output |
| 3 | `cf logout` | `btp:cancelLogin`, `btp:logout`, `cf:logout` | both | |
| 4 | `cf target` | `cf:targetOrgSpace` | both | Reads org/space/user from output |
| 5 | `cf orgs` | `cf:switchOrgStart` | both | Enumerates all orgs the authenticated user can see; populates `state.cfSwitchOrgList` and emits `cf:orgChoice` |
| 6 | `cf target -o <orgName>` | `cf:switchSelectOrg` | both | Retargets CF CLI to the selected org; precedes `cf spaces` call |
| 7 | `cf spaces` | `cf:switchSelectOrg` | both | Lists spaces in the newly targeted org; if this fails, `cf target` (no args) is run to re-sync state |
| 8 | `cf target -o <orgName> -s <spaceName>` | `cf:switchSelectSpace` | both | Commits the chosen org+space as the active CF target; updates `state.org` / `state.space` and emits `cf:switchOrgDone` |

### Discovery

| # | Command | IPC handler | Scope | Notes |
|---|---------|-------------|-------|-------|
| 5 | `cf domains` | `cf:domains` | both | Filters to `cfapps.*` domains |
| 6 | `cf marketplace -e postgresql-db` | `cf:marketplacePostgresql` | both | |
| 7 | `cf marketplace -e <offering>` | `cf:marketplaceCheck` | both | |
| 7a | `cf org <orgName> --guid` | `cf:cockpitUrl` | both | Resolve org GUID for the Finish-screen cockpit deep-link |
| 7b | `cf space <spaceName> --guid` | `cf:cockpitUrl` | both | Resolve space GUID for the Finish-screen cockpit deep-link |

### Service Lifecycle

| # | Command | IPC handler | Scope | Notes |
|---|---------|-------------|-------|-------|
| 8 | `cf create-service <offering> <plan> <name> [-c <configFile>]` | `cf:createService` | both | |
| 9 | `cf service <name>` | `cf:service`, `cf:pollService` | both | `cf:pollService`: polls every 10s, 15-min timeout |
| 10 | `cf create-service-key <service> <key>` | `cf:createServiceKey` | both | |
| 11 | `cf service-key <service> <key>` | `cf:serviceKey` | both | Direct spawn (not via `run()`); stdout routed through `redactServiceKeyLine` before terminal emission |
| 12 | `cf update-service figaf-xsuaa -c <xsPath>` | `update:updateXsuaa` | cloud | Polls every 5s, 10-min timeout |
| 13 | `cf create-service xsuaa application figaf-manager-xsuaa -c <xs-security.json>` | `cf:createXsuaa` | cloud | XSUAA v2 upgrade; polls every 5s, 10-min timeout |
| 14 | `cf service figaf-manager-xsuaa` | `cf:createXsuaa`, `xsuaa:upgradeStatus` | cloud | |
| 15 | `cf delete-service figaf-manager-xsuaa -f` | `cf:uninstallManager` | cloud | |

### App Lifecycle

| # | Command | IPC handler | Scope | Notes |
|---|---------|-------------|-------|-------|
| 16 | `cf push --vars-file vars.yml` | `cf:push` | both | Main Figaf Tool deploy (figaf-app + approuter) |
| 17 | `cf push figaf-manager-approuter -p <approuterDir> -m 128M -k 256M --no-route --no-start --no-manifest` | `cf:pushManagerApprouter` | cloud | XSUAA v2 upgrade |
| 18 | `cf push <deployId>-<role> [--strategy rolling] --vars-file vars.yml -f manifest.yml` | `update:pushApp` | cloud | Update flow; role is `app` or `router` |
| 19 | `cf delete <appName> -f` | `cf:deleteApp`, `update:deleteApps` | both/cloud | `cf:deleteApp` is both; `update:deleteApps` is cloud |
| 20 | `cf delete <name> -r -f` | `cf:uninstallManager` | cloud | Delete with routes (`-r`) |
| 21 | `cf app <name>` | `update:detectDeployment`, `update:verify`, `xsuaa:upgradeStatus` | cloud | |
| 22 | `cf app --guid <name>` | `update:detectDeployment`, `update:verify`; every `faid:*` handler (as `cf app <backend> --guid` in `installedPlatformState`: installed version and "backend deployed", memoized) | cloud | |

| 23 | `cf start figaf-manager-approuter` | `cf:pushManagerApprouter` | cloud | |
| 24 | `cf bind-service figaf-manager-approuter figaf-manager-xsuaa` | `cf:pushManagerApprouter` | cloud | |
| 25 | `cf bind-service <appName> figaf-manager-xsuaa` | `cf:restage` | cloud | |
| 26 | `cf unbind-service figaf-manager-approuter figaf-manager-xsuaa` | `cf:uninstallManager` | cloud | |
| 27 | `cf unbind-service figaf-manager figaf-manager-xsuaa` | `cf:uninstallManager` | cloud | |
| 28 | `cf restage <appName>` | `cf:restage` | cloud | Direct spawn; returns before restage completes (dyno bounces) |
| 29 | `cf map-route <app> <domain> --hostname <hostname>` | `cf:pushManagerApprouter`, `cf:mapRoute` | cloud | |
| 30 | `cf unmap-route <app> <domain> --hostname <hostname>` | `cf:unmapRoute`, `cf:restage` | cloud | |
| 31 | `cf set-env figaf-manager-approuter destinations <json>` | `cf:pushManagerApprouter` | cloud | Inline destination for `@sap/approuter` |
| 32 | `cf set-env figaf-manager-approuter destinations_figaf_manager_internal_url <url>` | `cf:pushManagerApprouter` | cloud | |
| 32a | `cf api` | `update:selfTarget` | cloud | Read endpoint to confirm cf CLI matches manager's VCAP_APPLICATION before self-redeploy |
| 32b | `cf target` | `update:selfTarget` | cloud | Read current org/space/user for the same pre-flight |
| 32c | `cf target -o <vcap.org> -s <vcap.space>` | `update:pushSelf` | cloud | Defense-in-depth re-target from VCAP_APPLICATION before push |
| 32d | `cf push <appName> -f <patched-manifest> -p <extractedDir> --strategy rolling` | `update:pushSelf` | cloud | Self-redeploy of figaf-manager; manifest's `name:` is rewritten to the operator's actual app name |
| 32e | `cf push figaf-manager-approuter -p <approuterDir> --strategy rolling --no-manifest` | `update:pushSelf` | cloud | Co-redeploy of approuter when v2 XSUAA is active; AWAITED before the manager push |

### CF v3 API (via `cf curl`)

| # | Command | IPC handler | Scope | Notes |
|---|---------|-------------|-------|-------|
| 33 | `cf curl /v3/service_credential_bindings?service_instance_names=figaf-manager-xsuaa&app_names=figaf-manager` | `xsuaa:upgradeStatus` | cloud | Detect if manager is already bound |
| 34 | `cf curl /v3/service_credential_bindings?service_instance_names=figaf-manager-xsuaa&app_names=<appName>` | `cf:restage` (skipIfBound) | cloud | Short-circuit if already bound |
| 35 | `cf curl /v3/apps?per_page=500` | `update:detectDeployment` | cloud | Enumerate all apps in the space |
| 36 | `cf curl /v3/apps/<guid>/droplets/current` | `update:detectDeployment`, `update:verify` | cloud | Read current Docker image tag |
| 37 | `cf curl /v3/apps/<guid>/environment_variables` | `update:readCurrentConfig` | cloud | Read live config to pre-fill update form |
| 38 | `cf curl /v3/apps/<guid>/processes/web` | `update:readCurrentConfig` | cloud | Read memory / instances |
| 39 | `cf curl /v3/service_credential_bindings?app_guids=<guid>&include=service_instance` | `update:readCurrentConfig` | cloud | Read service bindings |
| 39a | `cf curl /v3/service_credential_bindings?type=app&service_instance_names=<instance>&app_names=<app>` | `faid:services` | cloud | `boundToManager` (Credential Store ↔ manager) and, catalog v4, `boundToBackend` (optional PI/PO instance ↔ shared backend); one call per instance |

---

## Other Process Spawns

| # | Command | Called from | Scope | Notes |
|---|---------|-------------|-------|-------|
| 1 | `where btp` / `which btp` | `prereq:whichBtp` | desktop | Locate btp on `$PATH` |
| 2 | `where cf` / `which cf` | `prereq:whichCf` | desktop | Locate cf on `$PATH` |
| 3 | `tar -xzf <tarPath> -C <tmpDir>` | `prereq:installBtp` | desktop | Extract downloaded btp Windows tarball |
| 4 | `powershell -NoProfile -Command Expand-Archive -Path <zip> -DestinationPath <dir> -Force` | `extractZip` helper | desktop (Win32) | Extract cf zip archive |
| 5 | `unzip -o <zip> -d <dir>` | `extractZip` helper | desktop (non-Win32) | Extract cf zip archive |
| 6 | `df -BG .` | `prereq:disk` | desktop (non-Win32) | Check available disk space |
| 7 | `powershell -NoProfile -Command (Get-PSDrive <drive>).Free` | `prereq:disk` | desktop (Win32) | Check available disk space |
| 8 | `tar -xzf manager-approuter.tar.gz -C manager-approuter/` | `host.cloud.js:resolveManagerApprouterDir` | cloud | Extract bundled manager-approuter tarball on first access |
| 9 | `tar -xzf <btpTar> -C <binDir> --strip-components=1` *(build-time)* | `build-zip.js:extractTarGz` | build | Download btp Linux binary |
| 10 | `npm install --omit=dev --no-package-lock --no-audit --no-fund` *(build-time)* | `build-zip.js:stage` (via `execSync`) | build | Install public deps in staging tree |

---

## HTTPS Calls

All runtime calls go through `https.get` (Node built-in). No third-party HTTP library.

### Runtime — `packages/core/orchestrator.js`

| # | URL / Pattern | Helper | IPC handler | Scope | Auth / Headers |
|---|--------------|--------|-------------|-------|----------------|
| 1 | `https://tools.hana.ondemand.com/additional/btp-cli-windows-amd64-2.106.1.tar.gz` | `httpsDownload` | `prereq:installBtp` | desktop | EULA cookie: `eula_3_2_agreed=tools.hana.ondemand.com/developer-license-3_2.txt` |
| 2 | `https://api.github.com/repos/cloudfoundry/cli/releases/latest` | `httpsJson` | `prereq:installCf` | desktop | `User-Agent: Figaf-Manager` |
| 3 | `asset.browser_download_url` (from GitHub, `*winx64.zip`) | `httpsDownload` | `prereq:installCf` | desktop | EULA cookie (for redirect chain) |
| 4 | `https://hub.docker.com/v2/repositories/figaf/app/tags?name=btp&page_size=1&ordering=last_updated` | `httpsJson` | `prereq:dockerHub`, `config:dockerHubLatestBtpTag` | both | `User-Agent: Figaf-Manager` |
| 5 | `https://hub.docker.com/v2/repositories/figaf/app/tags?name=btp&page_size=10&ordering=last_updated` | `httpsJson` | `config:dockerHubBtpTags` | both | `User-Agent: Figaf-Manager` |
| 6 | `https://github.com/figaf/Figaf-BTP-Deployment/archive/refs/heads/btp-users.zip` (or `$FIGAF_DEPLOYMENT_ZIP_URL`) | `httpsDownload` | `resolveDeployDir` | cloud | EULA cookie; follows up to 5 redirects |
| 7 | `https://<subdomain>.authentication.<region>.hana.ondemand.com/saml/metadata` | `httpsText` | `connect:samlSsoUrl` | both | `User-Agent: Figaf-Manager`; follows up to 5 redirects; max 512 KB body |
| 7a | `https://api.github.com/repos/figaf/FigafManager/releases/latest` (or `$FIGAF_RELEASE_REPO`) | `httpsJson` | `update:checkSelf` | both | `User-Agent: Figaf-Manager`; fails open on 404/network error |
| 7b | `<release.assets[].browser_download_url>` matching `figaf-manager-app-<v>.zip` | `httpsDownload` | `update:downloadSelf` | cloud | URL is validated server-side against the result of the most recent `update:checkSelf` — renderer cannot pass an arbitrary URL |

### Runtime — Constructed URLs (opened in browser, not fetched by the server)

| # | URL Pattern | Handler | Notes |
|---|------------|---------|-------|
| 8 | `https://tools.hana.ondemand.com/#cloud` | `prereq:openBtpDownloadPage` | Passed to `host.openExternal()` |
| 9 | `https://cli.btp.cloud.sap` | `btp:loginStart` | Passed as `--url` arg to btp CLI |
| 10 | `https://api.<landscape>.hana.ondemand.com` | `cf:loginStart` | Passed as `-a` arg to cf CLI; also returned in `applySubaccountSelection` response |
| 11 | `https://login.<landscape>.hana.ondemand.com/passcode` | `shell:openPasscodeUrl` | Passed to `host.openExternal()` |
| 12 | `https://<hostname>-internal.<domain>` | `cf:pushManagerApprouter` | Internal approuter destination env var; never fetched by Node |
| 13 | `https://<cockpitBase>/#/globalaccount/<gaGuid>/subaccount/<subGuid>/roles` | `connect:trustConfigUrl` | Returned to UI |
| 14 | `https://<cockpitBase>/#/globalaccount/<gaGuid>/subaccount/<subGuid>/users` | `xsuaa:assignRoleCollectionPreflight` | Returned to UI |
| 14b | `https://<cockpitBase>/#/globalaccount/<gaGuid>/subaccount/<subGuid>/org/<orgGuid>/space/<spaceGuid>/applications` | `cf:cockpitUrl` | Returned to UI; opened via `shell.openExternal` from the Finish screens. `cockpitBase` from `cockpitBaseFromLicense(state.licenseType)` |
| 14a | `https://github.com/figaf/FigafManager/releases/...` (release `html_url`, or matched asset `browser_download_url`) | `shell:openExternal` (desktop self-update CTA in `triggerSelfUpdate`) | Passed to `host.openExternal()`. URL comes from the `update:checkSelf` response (GitHub-provided). Opened so the operator can download the new portable exe and replace their copy — a running portable can't self-overwrite |

### Build-time — `apps/figaf-manager/scripts/build-zip.js`

| # | URL | Purpose | Auth / Headers |
|---|-----|---------|----------------|
| 15 | `https://tools.hana.ondemand.com/additional/btp-cli-linux-amd64-<version>.tar.gz` | Download btp Linux binary for the cloud zip | EULA cookie |
| 16 | `https://packages.cloudfoundry.org/stable?release=linux64-binary&version=<cfCliVersion>&source=github` | Download the pinned cf CLI Linux binary for the cloud zip. The redirect chain must resolve to `cf8-cli_<cfCliVersion>_linux_x86-64.tgz`, otherwise the build fails. Both pins live in `apps/figaf-manager/package.json`; the result is recorded in `bin/VERSIONS.json` | None |

---

## Summary by Category

| Category | Count | Scope |
|----------|-------|-------|
| BTP CLI commands | 21 | both / cloud |
| CF CLI commands (direct) | 43 | both / cloud |
| CF v3 API (`cf curl`) | 8 | cloud only |

| Other process spawns (system) | 8 | desktop / cloud / build |
| HTTPS fetches (runtime) | 10 | both / cloud / desktop |
| URLs opened in browser (not fetched) | 7 | both / cloud / desktop |
| HTTPS fetches (build-time) | 2 | build only |

All `run()` calls use `spawn()` with `shell: false` and an explicit args array — no shell interpolation of user-supplied values.  
The two long-lived spawns (`btp login`, `cf login`) communicate via stdin writes of pre-validated index/choice values only.
