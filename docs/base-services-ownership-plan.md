# The manager owns the base service instances — implementation plan (step 2)

Written 2026-09-08 (Arsenii with Claude), after the database-access work of
the same day showed the flaw: a manager screen feature (the editable
database name) was invisible until a platform release was published, because
the manager renders whatever the release catalog's `services` list says.
Status: **plan, not built**. Prerequisite for the next work on the console.

## 1. The problem

Today the release catalog (figaf-faid `release/catalog.template.json`)
carries two different kinds of information:

1. **What the release is**: version, apps, their zips and checksums, roles,
   the shared backend zip, the Figaf authorities. This belongs to the
   release. Correct.
2. **How the customer's space is set up**: the service instances with their
   names, default plans, allowed plans, `bindToManager`, `optional`,
   `group`, `sharedWith`, and since v6 `access` and `nameEditable`. This
   is infrastructure the manager creates and manages. It does not change per
   release, and it drives manager screens.

Consequences of 2 being in the catalog:

- A manager feature that needs a new flag is invisible until a release with
  that flag is published (today: the name field, the access pill, the
  Prepare button appeared only with release 0.7.0, which is not in the store).
- The same instance definitions are copied into every release, and into the
  e2e fixtures, and into `wipe-and-provision.ps1`.
- Frozen names (decision 0008) live in a file that is meant to change every
  release.

## 2. The decision this plan rests on

**The manager owns the base service instances.** Their definitions (offering,
default name, whether the name is editable, plans, who binds them, optional
groups) live in the manager, in one module. The catalog says only **what
the release's backend requires**, because that is a fact about the
backend's code: which instances it needs bound, and that it reaches the
database with its own role (release 0.7.0+) instead of a binding (0.6.x).

Decisions to take before building (Arsenii):

1. **Old catalogs.** Releases up to 0.7.0 carry a `services` list. Either
   the manager keeps a compatibility layer ("when the catalog carries
   `services`, use them; otherwise the built-in list"), about half a day and
   permanent code, or the manager refuses a catalog older than v7 with a
   clear message. Recommendation: **refuse**. No customer has an
   installation; 0.6.1 exists only in Figaf's own store; 0.7.0 was never
   published. The store gets 0.8.0 (v7) as the first release the new manager
   installs.
2. **Where the frozen names are recorded.** Decision 0008 stays the record;
   the manager module is the code. figaf-faid keeps no copy.

## 3. The new contract: catalog v7

The `services` list disappears. The backend and the apps declare what they
**require**, by kind, not by instance name:

```json
{
  "releaseVersion": "0.8.0",
  "figafScopes": ["agent:read", "b2b.partner-profile:read", "download", "ctt:sync"],
  "platform": {
    "name": "Shared backend (connector)",
    "cfApps": [ { "name": "figaf-faid-backend", "artifact": "backend.zip", "sha256": "...",
                  "buildpack": "nodejs_buildpack", "stack": "cflinuxfs5", "memory": "256M", "disk": "1024M",
                  "requires": { "database": "own-role", "xsuaa": "binding", "credstore": "binding" },
                  "optional": ["pipo"],
                  "env": { "FIGAF_PAGE_SIZE": "200" } } ]
  },
  "apps": [
    { "id": "b2b-archiving-setup", "name": "B2B Archiving Setup", "version": "0.8.0",
      "cfApps": [ { "name": "figaf-faid-apps-b2b-archiving-setup", "artifact": "...zip", "sha256": "...",
                    "buildpack": "nodejs_buildpack", "stack": "cflinuxfs5", "memory": "128M", "disk": "512M",
                    "requires": { "xsuaa": "binding" },
                    "destinationTo": "figaf-faid-backend", "destinationName": "figaf-faid-backend" } ],
      "configTargetCfApp": "figaf-faid-backend", "healthPath": "/health/connections",
      "roleCollections": ["FAID-B2BArchivingSetup-Viewer", "FAID-B2BArchivingSetup-Admin", "FAID-Platform-Admin"] }
  ]
}
```

Rules:

- `requires` maps a **kind** (`database`, `xsuaa`, `credstore`) to how the CF
  app consumes it: `"binding"` (the manager binds the instance) or
  `"own-role"` (database only: the backend gets the Credential Store entry
  and `FAID_DATABASE_CA`, never a binding). A kind the manager does not know
  is a catalog error before any cf call.
- `optional` names optional groups the CF app binds when their instances
  exist (`pipo` = connectivity + destination). No instance names in the
  catalog anywhere.
- `services`, `bindToManager`, `optional: true` on a service, `group`,
  `sharedWith`, `access`, `nameEditable` are gone. A catalog that still
  carries `services` is v6 or older: refused (decision 1) or handled by the
  compatibility layer.
- `xs-security.json` stays in the release: it is the apps' roles, release
  content.

## 4. The manager's built-in definitions

New module `packages/core/base-services.js`, the one source of the base
instances. Pure data plus small helpers, unit-tested.

| kind | offering | default name | name editable | plans (default first) | bound to | notes |
|---|---|---|---|---|---|---|
| `database` | `postgresql-db` | `figaf-db` | yes | `free`, `standard` | nobody (own role, `faid-database.js`) | may be the Figaf Tool's instance; the row states the bound apps and the consequence |
| `xsuaa` | `xsuaa` | `figaf-faid-xsuaa` | no | `application` | manager, backend, every app | composed document (release part + manager part), decision 0009 |
| `credstore` | `credstore` | `figaf-faid-credstore` | no | `free`, `standard` | manager, backend | basic auth config; the free plan allows one instance per subaccount |
| group `pipo` | `connectivity` / `lite`, `destination` / `lite` | `figaf-connectivity`, `figaf-destination` | later (separate task) | `lite` | backend, when present | shared with the Figaf Tool: reused, never replaced, never configured or deleted by the manager (decision 0012 section 4E) |

Helpers: `baseServices()` (the list), `serviceOfKind(kind)`,
`resolveNames(overrides, discovered)` (today's `resolveServiceNames`, moved),
`requirementsOf(catalog)` (every kind and group the release's CF apps
require, validated), `bindingsFor(cfApp, names)` (the instance names to
bind, own-role excluded).

Editable names: the mechanism of SPEC 4.2 (`names` next to `plans`,
discovery from the Credential Store entry, then the space, then the default)
stays; it moves from the catalog flag to the module's `nameEditable` column.
Extending it to the PI/PO pair is one column change plus a discovery source
(the backend's bindings).

## 5. Call sites in the manager that change

`packages/core/faid-apps.js` reads `catalog.services` in these places today
(line numbers of 2026-09-08):

| Where | Today | After |
|---|---|---|
| `ownRoleNames` (141), `resolveServiceNames` (156) | from `catalog.services` | from `base-services.js` and the CF apps' `requires` |
| `composedXsuaaConfig` (481), `ensureXsuaa` (540) | finds the `xsuaa` entry in the catalog for its config file | the release's `xs-security.json` is fixed by name; the instance from the module |
| `deployPart` bind loop (752) and the CA step (790) | `cfApp.services` / `optionalServices` are instance names | `bindingsFor(cfApp, names)`; own role from `requires.database === "own-role"` |
| `missingRequiredServices` (823), `preflight` (855-895) | names from `cfApp.services` | kinds from `requires`, names from the module |
| `effectiveServiceNames` (1087), `provisionServices` (1130) | iterates `catalog.services` | iterates the module's list filtered by `requirementsOf(catalog)` |
| `bindManagerService` (1234), `prepareManagerServices` (1541), `prepareSpaceServices` (1573) | `bindToManager` entries of the catalog | the module's "bound to manager" column |
| `faid:services` (1403-1411) | rows from the catalog | rows from the module, same row shape as today (the UI does not change) |

Other files:

- `packages/core/release-store.js` (92): catalog validation stops accepting
  `services`; validates `requires` and `optional` instead (kinds known,
  consumption known).
- `packages/ui/*`: no change in shape; `setup-checklist.js`,
  `screen-setup-page.jsx`, `screen-faid-apps.jsx` keep reading the rows of
  `faid:services`. Text that says "the instances this release needs" becomes
  "the instances the platform needs".
- `e2e/tools/wipe-and-provision.ps1`: names from one place (a tiny
  `node -p` over the module, or a copy with a comment pointing at it).
- `e2e/fixtures/*` and `e2e/tools/make-fixture-store.js`: fixture catalogs
  move to v7. The failure-visibility fixture keeps a `requires` kind whose
  instance the space lacks... this needs a new trick: today it names an
  instance that never exists. With built-in names, "missing" must come from
  another kind of refusal, for example a required stack the landscape lacks,
  or an `optional` group name the manager does not know. Decide in the build.
- `external-calls-audit.md`: no new command; rows mention the module.

## 6. figaf-faid

- `release/catalog.template.json` to v7 (section 3).
- `release/build.js`: `sourcesFromCatalog` unchanged (apps and platform);
  the template check refuses a `services` list; `renderCatalog` passes
  `requires` through. `build.test.js` follows.
- `release/README.md`: the catalog history gets v7.
- A decision record, `decisions/0018-manager-owns-base-services.md`: the
  ownership rule, the `requires` contract, the refusal of old catalogs.
- Decision 0008: the frozen instance names now point to the manager module
  as the code.
- `docs/SOLUTION.md`, `docs/d1/MANUAL-RUNBOOK.md`: the base instances are
  described once, as the manager's, not per release.

## 7. Tests

- `base-services.test.js`: the list, `requirementsOf` on a v7 catalog and
  its refusals (unknown kind, unknown consumption, old `services` list),
  `bindingsFor` (own role excluded, optional group only when present),
  `resolveNames`.
- `faid-apps.test.js` and `faid-apps-database.test.js`: the fake catalogs
  move to v7 (`requires`); the assertions on `cf create-service`,
  `bind-service`, plans, names, own role and preflight stay the same in
  meaning.
- `release-store.test.js`: v7 validation.
- UI tests unchanged (row shape unchanged).
- Read-only e2e: fixtures on v7. Install smoke with release 0.8.0.

## 8. Order of work

1. Decisions of section 2 (Arsenii).
2. Manager: `base-services.js` with tests; `faid-apps.js` and
   `release-store.js` on the module; unit suites green; fixtures on v7.
3. figaf-faid: template v7, build validation, decision 0018, docs; release
   0.8.0 built locally.
4. Read-only e2e, install smoke, one virgin run in the dev space with the
   manager in XSUAA mode (also the first live click on Prepare database
   access).
5. SPEC sections 2, 4, 5.2, 6 rewritten; publish 0.8.0.

## 9. Estimate

| Part | Time |
|---|---|
| Manager module and call sites, tests | 1.5 days |
| figaf-faid template, build, decision, docs | 0.5 day |
| Verification (e2e, smoke, virgin run) | 0.5 day |
| Compatibility layer for old catalogs, if wanted | + 0.5 day |

About 2.5 days without the compatibility layer.

## 10. Out of scope

- Editable names for the PI/PO pair, XSUAA and the Credential Store (a
  column change later; needs a discovery source per instance).
- The manager's own release publishing.
- Anything about the Figaf Tool's instances (Alex's flows).
