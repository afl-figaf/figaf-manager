# Project context — the Figaf Manager and the L3/L4 platform

> For Claude sessions and developers in this repository. Written 2026-09-03 by
> the L3/L4 stream (Arsenii). Kept short and current; history lives in git.
> Read this first, then `docs/l3-console/SPEC.md`, then `CLAUDE.md`.

## 1. What Figaf is building

Figaf sells the **Figaf tool** ("FiGov"), a governance product for SAP
Integration Suite: change management and transports, B2B management, tracked
objects, testing. Since August 2026 Figaf also builds an AI-driven app platform
on top of it, in four layers:

- **L1** SAP Integration Suite. The runtime. Figaf governs it, never replaces it.
- **L2** the Figaf tool. System of record and gatekeeper. Slow, careful releases.
- **L3** small web apps for humans: one page, one clear purpose each.
- **L4** Python agents and MCP tools that automate tasks; a human approves risky actions.

L3 and L4 may act on governed data only through the Figaf tool's published API
(`/api/v1`). The plain web-UI API (`/api`) is forbidden.

## 2. What this repository is

Two products share one code base here:

1. **Figaf Manager** (Alex Florea's product, master branch): deploys and
   updates the Figaf tool in a customer's own BTP Cloud Foundry space. It
   runs the bundled `btp` and `cf` CLIs from inside its container, signs in
   with a one-time SSO passcode, and stores no personal credentials.
   Two hosts: `apps/figaf-local` (Windows desktop, Electron) and
   `apps/figaf-manager` (hosted in Cloud Foundry, browser UI).
2. **L3 App Manager console** (branch `poc/l3-app-manager`, since
   2026-09-01): the hosted manager also installs, updates and removes the L3
   apps of the platform from a release, creates the service instances the
   platform needs, sets up its own persistent SAP IAS sign-in, and holds the
   system connections the apps use (Credential Store). Hosted only; the
   desktop installer keeps the classic Figaf-tool wizard.

The decision behind this: one management node for everything a customer runs
from Figaf (figaf-l3-l4 decision 0004). The manager is the product that ships
first; app development follows (Ilya, 2026-09-03).

**The desktop installer is frozen** (Arsenii, 2026-09-03): it keeps working and
keeps building, but gets no new features. Its release job in `release.yml` was
already disabled. Alex's strategy notes of May 2026 reached the same
conclusion (hosted app first, desktop as a fallback); they were removed on
2026-09-03 and live in git history (`docs/CLEANUP-2026-09-03.md`).

## 3. The first customer: Danfoss

Danfoss migrates from SAP PI to Integration Suite Trading Partner Management.
Scale: about 2,500 operation mappings, 3,000 trading partners and 12,000 to
14,000 TPM agreements. The quotation is accepted; the contract was not signed
as of 2026-09-03. After signing, the first delivery window is 6 to 8 weeks.
The Danfoss installation will be the first customer installation of the
manager plus the L3 platform. So every install must work as a virgin-system
install in a fresh BTP space, by the customer's own administrator, with every
CLI command visible. Nothing is built *for Danfoss* before signing; the
platform and the manager are built now.

## 4. People

- **Alex Florea** — author and owner of the Figaf Manager (Figaf-tool flows).
- **Arsenii Istlentev** — owns the L3/L4 development and delivery process; drives the L3 console work here with Claude.
- **Emil Jessen** — built the L3/L4 prototypes; owns the business logic and the app content.
- **Ilya Nesterov** — architecture; reviews briefly, mostly unavailable until about November 2026.
- **Daniel Graversen** — CEO; wants "right over fast", one manageable deployment, security assurance.

## 5. Rules that apply to work in this repository

The platform's governance file is figaf-l3-l4 `docs/GOVERNANCE.md`. It is
owned by Figaf and read-only for Claude. It is not copied here on purpose:
one text, one owner. The rules that touch the manager:

- **BTP only.** No plain-Docker delivery. BTP services (XSUAA, Credential Store) may be required from customers.
- **No stored personal credentials.** One-time passcode per session, or a technical management user in the Credential Store. Secrets never appear in logs, the terminal stream, the audit log or results.
- **Figaf public API only** (`/api/v1`) when the manager or the apps talk to the Figaf tool.
- **Customers receive builds, never sources.** Versioned artifacts with checksums from a Figaf-owned store.
- **Every install must work on a virgin space.** Documented, repeatable, every step a command or a click.
- **Frozen identifiers** (figaf-l3-l4 decisions 0008 and 0009): xsappname `figaf-l3l4`, one XSUAA instance `figaf-l3l4-xsuaa` for the manager and all apps, scope prefix `FigafL3L4`, CF apps `figaf-l3l4-backend` and `figaf-l3-<app-id>`. Never rename; add.
- **Approuter routes stay backward-compatible across minor versions** (Alex's rule in `CLAUDE.md`, "Conventions when editing").
- **Tests**: `node:test` only, no new framework; the three tiers in `e2e/README.md`; the install smoke runs before every manager build that is pushed or uploaded; a failed action must be visible to the person.
- **Documents**: plain English, short sentences; a spec describes current behavior by topic and is edited in place; open items hold only what is open; history lives in git.

## 6. Where things live

| Topic | Repository and path |
|---|---|
| Manager code, L3 console, tests | this repo: `packages/`, `apps/figaf-manager/`, `e2e/` |
| L3 console behavior (spec), open items, failure procedure | this repo: `docs/l3-console/` |
| Governance, project knowledge, decisions | figaf-l3-l4: `docs/GOVERNANCE.md`, `docs/PROJECT-KNOWLEDGE.md`, `decisions/` |
| Solution documentation of the platform (architecture, status, plan) | figaf-l3-l4: `docs/SOLUTION.md` |
| Release build and publishing (catalog + app zips + `xs-security.json`) | figaf-l3-l4: `release/build.js` writes into `apps/figaf-manager/l3-artifacts/` here (the local source for tests); `release/publish.js` publishes to the release store; the procedure is `release/README.md` there |
| The release store the manager reads | `FIGAF_L3_RELEASE_URL` in `apps/figaf-manager/manifest.yml`; the reader is `packages/core/release-store.js` (figaf-l3-l4 decision 0010) |
| Virgin install procedure (D1) and run records | figaf-l3-l4: `docs/d1/` |
| App specs and the first app's source (playground) | figaf-l3-l4: `specs/`, `spikes/archiving-setup-playground/` |

The contract between the two repositories is the **release catalog** (v3)
and the **store layout** (`index.json`, `<version>/…`), described in
`docs/l3-console/SPEC.md` section 2. figaf-l3-l4 produces and publishes
them, the manager consumes them.

## 7. Facts a session needs

- Dev space: org `Figaf ApS_figafpartner-1`, space `figaf-l3-l4`, landscape eu10-004. Never target Emil's `figaf-dev` space.
- Dev machine: cf CLI 8.7.11 (winget package `CloudFoundry.CLI.v8`), MultiApps plugin 3.11.1, mbt 1.2.47. The manager bundles btp 2.106.1 and cf 8.19.0 (Linux builds; pinned in `apps/figaf-manager/package.json`, recorded in `bin/VERSIONS.json`).
- Manager version 26.5.0; release 0.4.1 (B2B Archiving Setup + shared backend)
  is in the release store (Cloudflare R2, public read URL) since 2026-09-04.
  The manager reads releases from there; its zip bundles no release.
  One version per installation: Install adds an app at the installed
  version, Update installation moves everything to a newer release.
- Virgin runs #1 to #7 passed in the dev space (record: figaf-l3-l4 `docs/d1/RUNBOOK-VIRGIN.md`). Run #7 (2026-09-03) proved the install order of decision 0009: one token, one passcode, one restart, one XSUAA instance.
- The branch `poc/l3-app-manager` is pushed to GitHub but not merged into master. Merging is coordinated with Alex.
- The distance to production and the plan: figaf-l3-l4 `docs/SOLUTION.md` section 1.
