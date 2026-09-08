# One PostgreSQL role for the FAID backend — implementation plan

Written 2026-09-08 (Arsenii with Claude) after the talk with Ilya the same
day; reworked the same evening after two more decisions by Arsenii (section
1, items 7 and 8). Status: **built 2026-09-08** (manager: `faid-database.js`,
`faid-apps.js` v6 rules, Setup and Base services UI; figaf-faid: backend
credentials from the Credential Store, schema `faid`, catalog v6, release
0.7.0 built locally). The behavior is described in SPEC section 4.2; this
file stays only as the record of the decisions until Arsenii deletes it.
Still open: section 9. Reasons and platform facts: figaf-faid
`decisions/0012-shared-service-instances.md`, sections 9 and 10.

**Scope change to note.** The first version of this plan was "the cost option
for later"; release 1 would keep a bound, dedicated instance. Item 7 below
removes the binding path from the backend entirely. This work is therefore
**required before the first customer install**, not optional.

## 1. Goal and the decisions it rests on

Goal: the FAID backend uses one PostgreSQL instance in the customer's space
through its own limited database role. The instance may be the Figaf Tool's,
or one created for FAID. In both cases the FAID backend can reach schema
`faid` only, and never the Figaf Tool's data.

Decided (Arsenii, 2026-09-08):

1. The Figaf Tool and its binding are **not touched**. Where it is bound to
   the instance it works as `dbo` and uses schema `irt`.
2. FAID is **not** an owner of the database. Its backend gets a limited
   role that can reach schema `faid` only. Enforced by PostgreSQL.
3. The protection is one-directional: any app bound to the instance (the
   Figaf Tool today) keeps full power over it, including schema `faid`.
   Accepted for now; said on screen and in the record.
4. The manager connects to the database **only to administer** (create or
   reconcile the role, rotate the password, drop on teardown), never to read
   or write application data. One module owns the `pg` usage.
5. ~~Temporary service key per admin action~~ Replaced (Arsenii,
   2026-09-08, evening): the manager uses **one standing service key**
   `figaf-manager` of the instance. Reason: the manager's cf login can create
   a key at any time, so a temporary key was no access boundary; a standing
   key is idempotent (no key left behind by a crash) and lets the deploy read
   the CA chain for the backend. The key is created on first use, read per
   action, never stored by the manager, deleted by the drop action and by
   the manager's uninstall.
6. The `faid_app` password lives in the Credential Store only.
7. **The backend never binds the database.** It always connects with the
   role and password the manager created, read from the Credential Store
   at start. Whether the instance is also bound to the Figaf Tool, to
   nothing, or to something else does not change the backend or the
   manager's procedure. "Shared" and "dedicated" are no longer two modes;
   they are one fact about the instance that the screen states.
8. **Names are defaults, not constants.** The database instance is
   `figaf-db` by default and the person may give it any name in Setup
   step 1. The same rule will apply to the other instances
   (`figaf-connectivity`, `figaf-destination`, …) in a separate task; this
   plan builds the mechanism and applies it to the database only.

Platform facts (Ilya, from production use of this pattern on BTP):

- Every binding user of a BTP `postgresql-db` instance is a member of the
  group role `dbo` and runs as `dbo`: full access to every schema. A
  binding is never isolation. This is why item 7 removes the binding.
- Custom roles created with SQL over a binding connection are a supported,
  standard operation and survive maintenance. To confirm with SAP support
  before go-live (component BC-CP-BSB-POSTGRES): the binding user's exact
  privileges and the unbind behavior.
- `CREATE SCHEMA … AUTHORIZATION <role>` fails from the `dbo` connection on
  PostgreSQL 16. The schema is created plain (owned by `dbo`) and the role
  gets a grant.

Records to update (Arsenii; decision files are Figaf-owned): decision 0008
lists `figaf-faid-db` as a frozen identifier; item 8 replaces it with "default
`figaf-db`, editable". Decision 0012 section 9: the two modes collapse into
one procedure (item 7).

## 2. The design

```
   Figaf Tool app (if any)   Figaf Manager                  FAID backend
   binding, as today         temporary service key,         Credential Store entry,
   = dbo                     admin actions only = dbo       NO binding = faid_app
        │                          │                              │
        ▼                          ▼                              ▼
 ┌──────────────────────────────────────────────────────────────────────────┐
 │ PostgreSQL instance <name> (default figaf-db), one database, owner dbo   │
 │   schema irt   ◄── full access ── dbo        (present when the Tool     │
 │                                               uses this instance)        │
 │   schema faid  ◄── USAGE, CREATE only ── faid_app (not a member of dbo)  │
 │                    faid_app is denied on irt and on everything else      │
 └──────────────────────────────────────────────────────────────────────────┘
                                   │ writes host, port, dbname, user,
                                   │ password, schema, CA certificate,
                                   │ instance name and GUID
                                   ▼
                          Credential Store, namespace figaf-faid
                          name: backend-database   ◄── backend reads at start
```

Three starting situations, one procedure:

| The instance `<name>` … | Setup step 1 | Then |
|---|---|---|
| exists and a Figaf Tool app is bound to it | accepted as it is; the row says "used by the Figaf Tool" and states the consequences | prepare the role (step 3) |
| exists and nothing FAID-related is bound to it | accepted as it is; the row says which apps are bound, if any | prepare the role (step 3) |
| does not exist | created with the chosen plan (`free` / `standard`); only started, about 7 minutes | prepare the role when ready (step 3) |

Fixed names: schema `faid`, role `faid_app`, Credential Store entry
`backend-database` in namespace `figaf-faid`, temporary key
`figaf-manager-admin-<unix seconds>`. Editable name: the instance.

## 3. The SQL the manager runs (as `dbo`)

Idempotent; safe to run again.

```sql
DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'faid_app') THEN
    ALTER ROLE "faid_app" WITH LOGIN PASSWORD '<generated>';
  ELSE
    CREATE ROLE "faid_app" WITH LOGIN PASSWORD '<generated>';
  END IF;
END $$;
CREATE SCHEMA IF NOT EXISTS "faid";
GRANT USAGE, CREATE ON SCHEMA "faid" TO "faid_app";
ALTER ROLE "faid_app" SET search_path TO "faid";
```

Verification, as `faid_app`, in the same action: connect; `SELECT
current_schema()` must return `faid`; when a schema other than `faid`,
`public` and the system schemas exists (as `dbo`: `information_schema.schemata`,
for example `irt`) and holds a table, `SELECT 1 FROM <schema>.<table> LIMIT 1`
must fail with permission denied. When no such table exists (a fresh instance
made for FAID) this check is skipped and the result says so.

Teardown (explicit action, confirmed by the person), one transaction with
`SET lock_timeout = '10s'` and `SET statement_timeout = '60s'`:

```sql
DROP SCHEMA IF EXISTS "faid" CASCADE;
DROP ROLE IF EXISTS "faid_app";
```

Rules for the SQL path:

- The password is generated (32 alphanumeric characters) and reused on a
  re-run when the Credential Store entry already exists, so a running
  backend is never surprised. Rotation is its own action.
- Schema and role names are constants; still validate against
  `^[a-z][a-z0-9_]{0,62}$` before interpolation (identifiers cannot be
  parameterised). The instance name never reaches SQL.
- The client runs with output captured; on error the result carries the
  PostgreSQL error code and message, never the statement text (it would
  carry the password).
- The `dbo` credentials are read from the temporary key, used, and dropped
  from memory; never logged, never written to a file or a result object.

## 4. Manager side (FigafManager, branch `poc/faid-apps-manager`)

### 4.1 Instance names: default, override, discovery

- The catalog's `name` is the **default**. Setup step 1 shows it in a text
  field the person may change. The value is validated as a Cloud Foundry
  instance name (`^[A-Za-z0-9][A-Za-z0-9._-]{0,49}$`) and always passed to
  `cf` as one argv element, never inside a shell string.
- **Prefill.** When a Figaf Tool app in the manager's space has a
  `postgresql-db` binding, the field is prefilled with that instance's name
  (reuse `faid:figafSystems` and `cf curl
  /v3/service_credential_bindings?app_guids=<guid>&include=service_instance`,
  as `update:readCurrentConfig` does). Otherwise the field holds `figaf-db`.
  The person may still type another name. This answers the old open point
  "preselect shared when a Tool instance is found": yes, by prefill.
- **Override mechanism, general.** Next to `plans` the handlers accept
  `names: { "<catalog name>": "<actual name>" }`:
  `faid:services({ names })`, `faid:provisionServices({ …, names })`,
  `faid:prepareSpaceServices({ plans, names, groups })`. One helper
  `instanceNames(catalog, overrides, discovered)` returns the map catalog
  name → actual name; every `cf service`, `cf create-service` and
  `cf bind-service` for a catalog service goes through it. `plans` stays
  keyed by the **catalog** name.
- **Discovery, never storage.** The manager keeps no file. After the
  database is prepared, its actual name and GUID come from the Credential
  Store entry (`instanceName`, `instanceGuid`). Until then the name is the
  field's value, sent with each call. For the other services (later task)
  the source is the backend's or the manager's bindings.
- A catalog service entry gains `"access": "own-role"` and
  `"nameEditable": true` (catalog v6, section 5). Only the database carries
  them today. `nameEditable` is what the UI reads to show the text field, so
  the other services get their field by a catalog change plus their
  discovery source, nothing else.

### 4.2 Setup step 1

Database row, next to the plan dropdowns:

- Text field "PostgreSQL instance", default or prefilled as in 4.1.
- Live status under the field, from `faid:services({ names })`: "will be
  created (plan …)", "exists · plan … · used by the Figaf Tool app <id>-app",
  or "exists · plan … · bound to: <apps> / nothing". The plan dropdown is
  shown only when the instance does not exist.
- One consequence line whenever the instance already exists: "The FAID
  backend gets its own role `faid_app`, limited to schema `faid`. Every app
  bound to this instance runs as `dbo` and keeps full access, including
  schema `faid`. One backup and restore point for everything in this
  instance; plan, connection limit and engine version are shared."
- `faid:prepareSpaceServices` creates the instance when missing (as today,
  only started) or accepts it when present ("already exists" is success,
  decision 0012 rule 4E-1). It never binds the database to anything.

### 4.3 Base services (Setup step 3)

Database row: "`<name>` · plan … · role `faid_app` · schema `faid`", plus an
access status from `faid:databaseStatus` (no database connection): **not
prepared** (no entry), **prepared** (entry exists, its `instanceGuid` matches
`cf service <name> --guid`), or **stale** (entry names an instance that no
longer exists). Buttons:

- **Prepare database access** when the instance is ready and the status is
  not prepared (`faid:databasePrepare`). Also usable as "Prepare again".
- **Rotate password** (`faid:databaseRotate`).
- Under a confirmation that names the instance: **Drop the FAID schema**
  (`faid:databaseDrop`).

The step is **done** when every required instance is ready AND the database
access is prepared (`setup-checklist.js`). The prepare needs the Credential
Store binding of the manager, which is active only after the restart at the
end of step 1; that is why it lives in step 3 and not in step 1.

### 4.4 New module `packages/core/faid-database.js`

The only file that requires `pg`. Exports:

- `prepareDatabaseAccess({ instanceName })` — the whole sequence:
  `cf service <name> --guid`, `cf create-service-key`, `cf service-key`
  (read, masked, `auditStdout: false`), connect as `dbo`, run the SQL of
  section 3, verify as `faid_app`, write the Credential Store entry, `cf
  delete-service-key`. Returns `{ ok, step, error, detail }` in the shape
  of SPEC section 9 (failed actions explain themselves), with steps
  `guid`, `key`, `connect`, `role`, `schema`, `grant`, `verify`, `store`,
  `cleanup`. The key is deleted in a `finally` block, also on failure.
- `rotateDatabasePassword()` — same frame on the instance the entry names;
  `ALTER ROLE … PASSWORD`, update the entry, then `cf restart
  figaf-faid-backend` when the backend exists.
- `dropDatabaseSchema()` — same frame; the teardown SQL; deletes the entry.
- `databaseAccessStatus({ instanceName })` — no database connection: reads
  the entry and probes the instance; returns the row for the panel.

Handlers in `faid-apps.js`: `faid:databasePrepare`, `faid:databaseRotate`,
`faid:databaseDrop`, `faid:databaseStatus`. All under the one lifecycle lock.
Registered in `orchestrator.js`, exposed in `cloud/client.js` and
`preload.js` (the desktop refuses them like every hosted-only handler).

Credential Store entry (`credstore-client.writeCredential`), namespace
`figaf-faid`, name `backend-database`, value JSON:
`{ host, port, dbname, user: "faid_app", password, schema: "faid",
sslrootcert?, instanceGuid, instanceName }`. Host, port and dbname are
instance-level and stable across binding rotations; they are refreshed on
every prepare run.

### 4.5 Install and update

- Preflight (SPEC section 3 step 2): a catalog service with `access:
  "own-role"` counts as satisfied when the entry `backend-database` exists
  and `cf service <entry.instanceName>` reports it ready. Otherwise the
  refusal names the missing piece ("database access not prepared — Setup
  step 3, Prepare database access").
- The manager **never** issues `cf bind-service` for a service with
  `access: "own-role"`, even if an older catalog lists it in a cfApp's
  `services`. A binding would be `dbo` and end the isolation. A unit test
  asserts it.
- Nothing else changes: apps, XSUAA, Update installation stay as they are.

### 4.6 Remove

`faid:remove` of the last app and of the backend does not touch the
database. The schema and role stay until a person runs **Drop the FAID
schema**. The manager never deletes or `update-service`s the instance
(decision 0012 section 4E), also when it created the instance itself; a
FAID-only instance is removed by hand (`cf delete-service`) for now.

### 4.7 Packaging and audit

- `pg` added to `apps/figaf-manager/package.json` (pinned exact version,
  as every dependency there; `build-zip.js` stages it).
- `external-calls-audit.md`: new rows for `cf service <name> --guid`, `cf
  create-service-key`, `cf service-key`, `cf delete-service-key`, and one
  row "PostgreSQL over TLS to the FAID database instance, admin actions
  only, `faid-database.js`".
- Masking: the key JSON, the generated password and the `dbo` password
  never appear in the terminal stream, the CLI audit log, the RPC audit or a
  result (SPEC section 10). `logCmd` strings replace the values.

## 5. Release and FAID backend side (figaf-faid)

- **Catalog v6** (`release/catalog.template.json`): the database entry
  becomes `{ "name": "figaf-db", "offering": "postgresql-db", "plan":
  "free", "plans": ["free", "standard"], "access": "own-role",
  "nameEditable": true, "purpose": … }`. The backend's cfApp `services`
  list drops the database (it keeps `figaf-faid-xsuaa` and
  `figaf-faid-credstore`; the Credential Store is **required** (Arsenii,
  2026-09-08): the database credentials come from it, so the backend
  refuses to start without the binding). The manager
  reads `access` and `nameEditable`; older catalogs without them behave as
  before, except that no `own-role` service is ever bound (4.5).
- `srv/lib/connections.js`, `postgresCredentials()`: read the Credential
  Store entry `backend-database` (namespace `figaf-faid`) through the
  existing `credstore-adapter` and build `{ host, port, database, user,
  password, ssl }` from it. The `VCAP_SERVICES` postgres path is removed. A
  leftover `postgresql-db` binding is ignored with one warning line. No
  entry: refuse to start with one clear log line ("no database access
  entry; run Setup step 3, Prepare database access in the Figaf Manager").
- No other way to give the backend its credentials: the backend is always
  deployed by the manager (Arsenii, 2026-09-08). No local override.
- `search_path`: set on every connection of the pool (`options: '-c
  search_path=faid'` on the pool config). The role's own default does the
  same; the backend sets it anyway so a wrong role setting cannot move the
  data.
- `srv/lib/schema-migrations.js`: runs through the same credentials; the
  migrations carry no schema prefix already. Add a startup check that
  `current_schema()` is `faid` and refuse to migrate otherwise.
- `server.js` health line for postgres: "via Credential Store entry
  backend-database, role faid_app".
- Existing data: none to keep (Arsenii, 2026-09-08). Nothing is released
  yet; the dev space's `figaf-faid-db` is dropped and the space is prepared
  again with the new procedure. No data move, no compatibility code.
- `docs/SOLUTION.md` 2.3 (data and schema migrations) and
  `docs/d1/MANUAL-RUNBOOK.md` item 8 describe the one procedure and the
  three starting situations of section 2.

## 6. Tests

Unit (node:test, fakes):

- `faid-database.test.js`: the full prepare sequence with a fake `run` and a
  fake `pg` client — guid read, key created, SQL statements in order, verify
  step, entry written, key deleted; key deleted also when `connect` or
  `role` fails; password reused when the entry exists; no password in any
  logged line or result; identifier validation; status prepared / not
  prepared / stale.
- `faid-apps.test.js`: `names` override reaches `cf service`, `cf
  create-service` and the plan validation (plans keyed by catalog name);
  an invalid name is refused before any `cf` call; preflight satisfied by
  the entry; no `bind-service` ever for an `own-role` service (new and old
  catalog shape); remove leaves the database alone.
- `setup-checklist.test.js`: step 3 stays open while the database access is
  not prepared.
- `prepare-space.test.js`: the runner passes `names` through.
- Backend: `postgresCredentials()` reads the entry, refuses without it,
  ignores a leftover binding; `search_path` is set; migrations refuse a
  wrong `current_schema()`.

E2E read-only (fixture catalog moves to v6 with `figaf-db`;
`console-baseline.spec.js` follows): Setup step 1 shows the instance name
field with `figaf-db` (no Tool app in the e2e space) and the Base services
row shows "not prepared".

**Live run 2026-09-08 (done, from the laptop through a `cf ssh` tunnel;
`faid-database.js` with the real `cf` and the real `pg`, the entry in the
real Credential Store instance `figaf-faid-credstore`):** the instance is
reachable only from inside Cloud Foundry (a direct connection from the
laptop timed out; a tiny staticfile app with `cf enable-ssh` and `cf ssh -N
-L 15432:<rds host>:8916` brought it to the laptop). Results on `figaf-db`
(free plan, created by `cf create-service`, about 7 minutes): prepare on the
fresh instance ok (denial check skipped, said so); schema `irt` with one table
created as `dbo` to simulate the Figaf Tool; prepare again ok with the
password kept and "faid_app is denied on irt.agents (permission denied, as
required)"; as `faid_app`: `current_schema()` = `faid`, own table created,
`SELECT` on `irt.agents` 42501, `CREATE TABLE irt.x` 42501, `CREATE TABLE
public.x` 42501, `DROP SCHEMA irt` "must be owner", `CREATE ROLE` 42501;
rotate ok (new password connects, old one refused 28P01); status
`prepared`; drop ok (entry deleted, status `not-prepared`); prepare again ok.
Two facts changed the code: the Credential Store accepts about 4 KB per
value (HTTP 413 above), so the CA chain (4.6 KB) does not go into the
entry (first as parts `backend-database-ca-1..3`, then, after Arsenii's
review, as the backend's environment variable `FAID_DATABASE_CA` set by the
manager at deploy time from its standing key); and `dbo` becomes a member
of the role it creates (PostgreSQL 16 creator membership), which is
expected and harmless. The install smoke (`npm run test:e2e:install`, local manager with
the Credential Store service key as its binding) then installed release
0.7.0: the shared backend started inside Cloud Foundry from the entry, ran
its migrations in schema `faid`, answered the health check, the app was
installed and removed. Two more findings on the way: node-pg-migrate puts
its bookkeeping table in `public` unless given `schema`/`migrationsSchema`
(now `faid`; `faid_app` was correctly denied there), and the manager's
terminal redaction hid the 35-character app name
`figaf-faid-apps-b2b-archiving-setup` as a token (rule tightened in
`cloud/auth.js`: kebab-case names and GUIDs pass, and a token starting or
ending with "-" is no longer missed). Not yet run: the manager's own
screens in XSUAA mode in the dev space (Setup step 3 button, Base services
row); the read-only e2e suite and a server-side render check of the card
cover the UI.

Live run in the dev space (record like the virgin runs), both situations:

1. Instance in use by the Figaf Tool: prefill shows its name; prepare;
   install the platform; confirm in `cf env figaf-faid-backend` that no
   database binding exists; confirm as `faid_app` that `irt` is denied;
   rotate; Update installation; drop.
2. Fresh instance with a custom name: created in step 1, prepared in step 3,
   the same checks (the `irt` check is reported as skipped).

## 7. Order of work

1. figaf-faid: catalog v6 and the backend changes of section 5 in one
   release (the binding path goes, the Credential Store source and schema
   `faid` come). Needed before the first customer install.
2. SAP support ticket: confirm the binding user's privileges and unbind
   behavior. Can run in parallel with everything below.
3. Manager: `faid-database.js` with unit tests; the four handlers;
   packaging and audit rows.
4. Manager: the `names` mechanism (4.1), Setup step 1 row (4.2), Base
   services row and buttons (4.3), checklist, preflight and bind rules
   (4.5).
5. Live run in the dev space, both situations; spec update (SPEC sections
   2, 3, 4, 6, 10); runbook item 8; decision records 0008 and 0012
   (Arsenii); delete this file.

Size estimate: manager three to four days (the names mechanism adds about a
day), backend one day, plus the live run.

## 8. Out of scope

- Editable names for the other instances (`figaf-connectivity`,
  `figaf-destination`, `figaf-faid-xsuaa`, `figaf-faid-credstore`): a
  separate task on top of the mechanism of 4.1. Their discovery source is
  the bindings, not the Credential Store.
- Deleting a database instance from the manager, also one made for FAID.
- Limiting the Figaf Tool itself to schema `irt` (would need the Tool to run
  without its binding and take credentials from environment variables; a
  real workaround, rejected for now).
- Moving data from an old bound `figaf-faid-db` (schema `public`) into
  schema `faid`. Nothing is released; the dev instance is dropped.

## 9. Open points

- SAP support confirmation (section 1). Not a blocker for building; a
  blocker for go-live.
- Daniel's sign-off on one backup and restore point when the Figaf Tool's
  instance is chosen (decision 0012 item 7.3). The consequence line of 4.2
  is on screen either way.
- Decision 0008 amendment for the editable default name (Arsenii).
