"use strict";
// faid-database.js — the FAID backend's own database role, administered by the
// manager. The ONLY module in the manager that talks to PostgreSQL (the `pg`
// package is required here and nowhere else); it administers, it never reads
// or writes application data.
//
// Why (figaf-faid decision 0012 section 10; docs/shared-database-plan.md):
// every binding user of a BTP postgresql-db instance runs as the group role
// `dbo` with full access to every schema, so a binding is never isolation. The
// FAID backend therefore gets NO binding. The manager creates the role
// `faid_app` (LOGIN, not a member of dbo), the schema `faid` (owned by dbo,
// USAGE + CREATE granted to the role) and writes the connection entry into the
// Credential Store (namespace `figaf-faid`, name `backend-database`). The
// backend reads that entry at start. The instance may be the Figaf Tool's or
// one made for FAID; the procedure is the same.
//
// The manager administers through ONE standing service key of the instance,
// `figaf-manager` (decided 2026-09-08, replacing a temporary key per action:
// the manager's cf login can create a key at any time, so a temporary key was
// no boundary, and a standing key is idempotent and lets the deploy read the
// CA certificate). The key lives in Cloud Foundry, is created on first use
// ("already exists" is success), read with `cf service-key` for one action
// and dropped from memory; it is deleted by the drop action and by the
// manager's uninstall. The key JSON, the dbo password and the generated
// password never reach the terminal stream, the CLI audit log or a result
// (SPEC section 10). The instance's CA chain is public: at deploy time the
// manager reads it from the key and sets it on the backend as an environment
// variable (certificateChain()); the Credential Store entry holds only the
// connection and the password.
//
// Actions: prepare (create or reconcile role + schema + grants, verify the
// boundary as faid_app, write the entry), rotate (new password, update the
// entry), drop (schema CASCADE + role, delete the entry), status (no database
// connection: the entry against the instance).

const crypto = require("crypto");
const credstoreClient = require("./credstore-client");

const SCHEMA = "faid";
const ROLE = "faid_app";
const NAMESPACE = "figaf-faid";
const ENTRY = "backend-database";
// The standing service key of the database instance that the manager uses.
const KEY_NAME = "figaf-manager";
// The environment variable of the backend that carries the instance's CA
// certificate chain (public; about 4.6 KB, too large for a Credential Store
// value, which holds about 4 KB).
const CA_ENV = "FAID_DATABASE_CA";
const IDENTIFIER_RE = /^[a-z][a-z0-9_]{0,62}$/;
// A Cloud Foundry service instance name as the manager accepts it: letters,
// digits, dot, underscore, dash; 1-50 characters; never a leading dash (it
// would read as a flag). Always passed to cf as one argv element.
const INSTANCE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,49}$/;
const PASSWORD_LENGTH = 32;
const PASSWORD_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
const PASSWORD_RE = /^[A-Za-z0-9]{16,128}$/;
const PERMISSION_DENIED = "42501";

// ─── pure helpers (unit-tested) ───────────────────────────────────────────────

/** { ok, name } or { ok:false, error } for a typed instance name. */
function validateInstanceName(name) {
  const s = String(name == null ? "" : name).trim();
  if (!s) return { ok: false, error: "the instance name is empty" };
  if (!INSTANCE_NAME_RE.test(s)) {
    return { ok: false, error: `'${s.slice(0, 60)}' is not a valid service instance name (letters, digits, '.', '_' and '-'; 1-50 characters; must start with a letter or digit)` };
  }
  return { ok: true, name: s };
}

/** Schema and role names are constants, still checked before interpolation. */
function validateIdentifier(id) {
  return IDENTIFIER_RE.test(String(id || ""));
}

/** 32 alphanumeric characters from crypto.randomInt. */
function generatePassword(length = PASSWORD_LENGTH) {
  let out = "";
  for (let i = 0; i < length; i++) out += PASSWORD_ALPHABET[crypto.randomInt(PASSWORD_ALPHABET.length)];
  return out;
}

/**
 * The credentials object of `cf service-key` output: the JSON after the
 * header line, unwrapped from { credentials: {...} } when present. Null when
 * there is no JSON.
 */
function parseServiceKeyOutput(stdout) {
  const text = String(stdout || "");
  const start = text.indexOf("{");
  if (start < 0) return null;
  try {
    let key = JSON.parse(text.slice(start));
    if (key && key.credentials && typeof key.credentials === "object") key = key.credentials;
    return key && typeof key === "object" ? key : null;
  } catch {
    return null;
  }
}

/**
 * A pg connection config from a BTP postgresql-db service key (or binding):
 * hostname/host, port, dbname/database, username/user, password, sslrootcert.
 * Null when a required field is missing.
 */
function connectionFromKey(key) {
  if (!key || typeof key !== "object") return null;
  const host = key.hostname || key.host;
  const database = key.dbname || key.database;
  const user = key.username || key.user;
  const password = key.password;
  const port = Number(key.port || 5432);
  if (!host || !database || !user || !password) return null;
  const ca = key.sslrootcert || key.certificate || key.ca_certificate || null;
  return {
    host, port, database, user, password,
    ssl: ca ? { ca, rejectUnauthorized: true } : { rejectUnauthorized: true },
    sslrootcert: ca,
  };
}

/**
 * `cf service <name>` (cf CLI v8) as one object: exists, guid, offering, plan,
 * status word ("ready" | "in-progress" | "failed" | "unknown" | "missing"),
 * the raw last-operation text and the bound app names.
 */
function parseCfService(exitCode, stdout) {
  const text = String(stdout || "");
  if (exitCode !== 0) return { exists: false, status: "missing", guid: null, offering: null, plan: null, operation: "", boundApps: [] };
  const field = (label) => {
    const m = new RegExp(`^\\s*${label}:\\s*(.*)$`, "im").exec(text);
    return m ? m[1].trim() : "";
  };
  const operation = field("status").toLowerCase();
  let status = "unknown";
  if (/succeeded/.test(operation)) status = "ready";
  else if (/in progress/.test(operation)) status = "in-progress";
  else if (/failed/.test(operation)) status = "failed";
  const boundApps = [];
  const boundBlock = /Showing bound apps:\s*\n([\s\S]*?)(?:\n\s*\n|$)/i.exec(text);
  if (boundBlock && !/no bound apps/i.test(boundBlock[1])) {
    const lines = boundBlock[1].split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    // First line is the table header ("name  binding name  status  message").
    for (const line of lines.slice(1)) {
      const name = line.split(/\s{2,}/)[0];
      if (name && name !== "name") boundApps.push(name);
    }
  }
  return {
    exists: true,
    status,
    guid: field("guid") || null,
    offering: field("offering") || null,
    plan: field("plan") || null,
    operation,
    boundApps,
  };
}

/**
 * `cf services` (cf CLI v8) as rows: { name, offering, plan, boundApps[],
 * operation }. Columns are read by the header's column positions, so values
 * with spaces ("create succeeded", "a, b") stay whole. [] when the header is
 * not found.
 */
function parseCfServices(stdout) {
  const lines = String(stdout || "").split(/\r?\n/);
  const headerIdx = lines.findIndex((l) => /^name\s+offering\s+plan\s+bound apps/i.test(l.trim()));
  if (headerIdx < 0) return [];
  const header = lines[headerIdx];
  const cols = ["name", "offering", "plan", "bound apps", "last operation", "broker", "upgrade available"];
  const starts = cols.map((c) => header.indexOf(c)).filter((i) => i >= 0);
  const rows = [];
  for (const line of lines.slice(headerIdx + 1)) {
    if (!line.trim()) continue;
    const cell = (i) => line.slice(starts[i], i + 1 < starts.length ? starts[i + 1] : undefined).trim();
    const name = cell(0);
    if (!name) continue;
    rows.push({
      name,
      offering: cell(1),
      plan: cell(2),
      boundApps: cell(3) ? cell(3).split(",").map((s) => s.trim()).filter(Boolean) : [],
      operation: cell(4),
    });
  }
  return rows;
}

/** The SQL of one prepare run (idempotent). `password` must match PASSWORD_RE. */
function prepareStatements(password) {
  if (!validateIdentifier(ROLE) || !validateIdentifier(SCHEMA)) throw new Error("invalid identifier");
  if (!PASSWORD_RE.test(password)) throw new Error("invalid generated password");
  return [
    { step: "role", sql: `DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = '${ROLE}') THEN
    ALTER ROLE "${ROLE}" WITH LOGIN PASSWORD '${password}';
  ELSE
    CREATE ROLE "${ROLE}" WITH LOGIN PASSWORD '${password}';
  END IF;
END $$;` },
    { step: "schema", sql: `CREATE SCHEMA IF NOT EXISTS "${SCHEMA}";` },
    { step: "grant", sql: `GRANT USAGE, CREATE ON SCHEMA "${SCHEMA}" TO "${ROLE}";` },
    { step: "grant", sql: `ALTER ROLE "${ROLE}" SET search_path TO "${SCHEMA}";` },
  ];
}

function rotateStatement(password) {
  if (!validateIdentifier(ROLE)) throw new Error("invalid identifier");
  if (!PASSWORD_RE.test(password)) throw new Error("invalid generated password");
  return `ALTER ROLE "${ROLE}" WITH LOGIN PASSWORD '${password}';`;
}

/** The teardown, one transaction with timeouts. */
function teardownStatements() {
  if (!validateIdentifier(ROLE) || !validateIdentifier(SCHEMA)) throw new Error("invalid identifier");
  return [
    "BEGIN;",
    "SET lock_timeout = '10s';",
    "SET statement_timeout = '60s';",
    `DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE;`,
    `DROP ROLE IF EXISTS "${ROLE}";`,
    "COMMIT;",
  ];
}

/**
 * The Credential Store entry value (what the backend reads). The CA
 * certificate is NOT inside (too large for one value, and public): the
 * manager sets it on the backend as FAID_DATABASE_CA at deploy time.
 */
function entryValue({ connection, password, instanceName, instanceGuid }) {
  return {
    host: connection.host,
    port: connection.port,
    dbname: connection.database,
    user: ROLE,
    password,
    schema: SCHEMA,
    instanceName,
    instanceGuid: instanceGuid || null,
  };
}

/**
 * A safe error text from a pg error: SQLSTATE code and message, with any
 * secret replaced. Never the statement text.
 */
function pgErrorText(err, secrets = []) {
  let msg = String((err && err.message) || err || "unknown error");
  for (const s of secrets) if (s) msg = msg.split(s).join("<hidden>");
  const code = err && err.code ? ` [${err.code}]` : "";
  return `${msg}${code}`;
}

// ─── the module ──────────────────────────────────────────────────────────────

/**
 * The entry store on the manager's Credential Store binding. `binding` and
 * `client` are injectable (tests); the default reads VCAP_SERVICES.
 */
function createEntryStore({ client = credstoreClient, binding, fetchImpl } = {}) {
  const bindingOf = () => (binding !== undefined ? binding : client.findCredstoreBinding());
  return {
    available: () => !!bindingOf(),
    async read() {
      const b = bindingOf();
      if (!b) return null;
      const cred = await client.readCredential(b, { namespace: NAMESPACE, name: ENTRY }, fetchImpl);
      if (!cred || !cred.value) return null;
      try { return JSON.parse(cred.value); } catch { return null; }
    },
    async write(value) {
      const b = bindingOf();
      if (!b) throw new Error("the Credential Store is not bound to the manager");
      await client.writeCredential(b, { namespace: NAMESPACE, name: ENTRY, value: JSON.stringify(value), username: ROLE }, fetchImpl);
    },
    async delete() {
      const b = bindingOf();
      if (!b) throw new Error("the Credential Store is not bound to the manager");
      await client.deleteCredential(b, { namespace: NAMESPACE, name: ENTRY }, fetchImpl);
    },
  };
}

/**
 * @param {object} deps
 * @param {Function} deps.run        orchestrator subprocess helper (cf)
 * @param {Function} deps.log        (source, type, text)
 * @param {Function} deps.resolveCf  () => cf binary
 * @param {object}   [deps.entryStore]  createEntryStore() result (tests inject one)
 * @param {object}   [deps.pg]        { Client } (tests inject a fake; default require("pg"))
 * @param {Function} [deps.now]       () => ms
 * @param {Function} [deps.newPassword] () => string
 */
function createFaidDatabase({ run, log, resolveCf, entryStore, pg, now = Date.now, newPassword = generatePassword }) {
  const store = entryStore || createEntryStore();
  const cf = () => resolveCf();
  const tail = (r) => String((r && (r.stderr || r.stdout)) || "").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && l !== "FAILED").slice(-2).join(" | ").slice(0, 300);
  function pgClient() {
    const lib = pg || require("pg");
    return lib.Client;
  }

  /** `cf service <name>` as an object (one call). */
  async function describeInstance(name) {
    const r = await run(cf(), ["service", name], { source: "cf", quiet: true });
    return parseCfService(r.code, r.stdout);
  }

  /**
   * The owner connection of the instance from the manager's standing service
   * key `figaf-manager`: created when missing ("already exists" is success),
   * read quietly. Returns { ok, connection } or { ok:false, step:"key", error, command }.
   * The connection carries the dbo password: callers use it and drop it.
   */
  async function ownerConnection(instanceName) {
    const c = await run(cf(), ["create-service-key", instanceName, KEY_NAME], { source: "cf" });
    if (c.code !== 0 && !/already exists/i.test(`${c.stdout}\n${c.stderr}`)) {
      return { ok: false, step: "key", error: `cf create-service-key ${instanceName} ${KEY_NAME} failed: ${tail(c)}`, command: `cf create-service-key ${instanceName} ${KEY_NAME}` };
    }
    const k = await run(cf(), ["service-key", instanceName, KEY_NAME], {
      source: "cf",
      quiet: true,
      auditStdout: false,
      logCmd: `cf service-key ${instanceName} ${KEY_NAME}  (output not shown: contains the database owner credentials)`,
    });
    const key = k.code === 0 ? parseServiceKeyOutput(k.stdout) : null;
    const connection = connectionFromKey(key);
    if (!connection) {
      return { ok: false, step: "key", error: `cf service-key ${instanceName} ${KEY_NAME} gave no usable PostgreSQL credentials (${k.code === 0 ? "unexpected key shape" : tail(k)})`, command: `cf service-key ${instanceName} ${KEY_NAME}` };
    }
    return { ok: true, connection };
  }

  /** Delete the standing key (drop, uninstall). A missing key is fine. */
  async function deleteKey(instanceName) {
    const d = await run(cf(), ["delete-service-key", instanceName, KEY_NAME, "-f"], { source: "cf" });
    if (d.code !== 0 && !/not found|does not exist/i.test(`${d.stdout}\n${d.stderr}`)) {
      log("faid", "warn", `cf delete-service-key ${instanceName} ${KEY_NAME} failed (${tail(d)})`);
      return false;
    }
    return true;
  }

  /**
   * The CA certificate chain of the instance (public), for the backend's
   * FAID_DATABASE_CA at deploy time. From the standing key; the owner
   * password is dropped right away.
   */
  async function certificateChain({ instanceName } = {}) {
    const v = validateInstanceName(instanceName);
    if (!v.ok) return { ok: false, step: "key", error: v.error };
    const o = await ownerConnection(v.name);
    if (!o.ok) return o;
    if (!o.connection.sslrootcert) return { ok: false, step: "key", error: `the service key of ${v.name} carries no CA certificate (sslrootcert)` };
    return { ok: true, sslrootcert: o.connection.sslrootcert, envName: CA_ENV };
  }

  /**
   * Run `fn(dboClient, connection)` as the owner of the instance. Failures
   * come back as { ok:false, step, error, command? }.
   */
  async function withAdminConnection(instanceName, fn) {
    const o = await ownerConnection(instanceName);
    if (!o.ok) return o;
    const connection = o.connection;
    const secrets = [connection.password];
    const Client = pgClient();
    const client = new Client({ host: connection.host, port: connection.port, database: connection.database, user: connection.user, password: connection.password, ssl: connection.ssl, connectionTimeoutMillis: 20_000, statement_timeout: 60_000 });
    try {
      await client.connect();
    } catch (e) {
      return { ok: false, step: "connect", error: `PostgreSQL connection to ${connection.host}:${connection.port}/${connection.database} as the owner failed: ${pgErrorText(e, secrets)}` };
    }
    try {
      return await fn(client, connection);
    } finally {
      await client.end().catch(() => {});
    }
  }

  /** Run statements one by one; the first failure names its step. */
  async function runStatements(client, statements, secrets) {
    for (const st of statements) {
      try {
        await client.query(st.sql);
      } catch (e) {
        return { ok: false, step: st.step, error: `${st.step} failed: ${pgErrorText(e, secrets)}` };
      }
    }
    return { ok: true };
  }

  /**
   * As faid_app: connect, current_schema() must be `faid`, and a table of
   * another schema (found as dbo first) must be denied. No such table (a fresh
   * instance made for FAID): the isolation check is skipped and said so.
   */
  async function verifyAsRole(dboClient, connection, password) {
    let foreign = null;
    try {
      const r = await dboClient.query(
        "SELECT table_schema, table_name FROM information_schema.tables WHERE table_type = 'BASE TABLE' AND table_schema NOT IN ($1, 'public', 'pg_catalog', 'information_schema') ORDER BY table_schema, table_name LIMIT 1",
        [SCHEMA]
      );
      foreign = r && r.rows && r.rows[0] ? { schema: r.rows[0].table_schema, table: r.rows[0].table_name } : null;
    } catch (e) {
      return { ok: false, step: "verify", error: `could not list the other schemas' tables: ${pgErrorText(e, [connection.password])}` };
    }
    const Client = pgClient();
    const role = new Client({ host: connection.host, port: connection.port, database: connection.database, user: ROLE, password, ssl: connection.ssl, connectionTimeoutMillis: 20_000, statement_timeout: 30_000 });
    const secrets = [password, connection.password];
    try {
      await role.connect();
    } catch (e) {
      return { ok: false, step: "verify", error: `connection as ${ROLE} failed: ${pgErrorText(e, secrets)}` };
    }
    try {
      let current = null;
      try {
        const r = await role.query("SELECT current_schema() AS schema");
        current = r && r.rows && r.rows[0] ? r.rows[0].schema : null;
      } catch (e) {
        return { ok: false, step: "verify", error: `current_schema() as ${ROLE} failed: ${pgErrorText(e, secrets)}` };
      }
      if (current !== SCHEMA) {
        return { ok: false, step: "verify", error: `current_schema() as ${ROLE} is ${JSON.stringify(current)}, expected "${SCHEMA}"` };
      }
      if (!foreign) {
        return { ok: true, verify: { currentSchema: current, isolationChecked: false, checkedTable: null, note: "no table of another schema exists in this database yet; the denial check is skipped" } };
      }
      if (!validateIdentifier(foreign.schema) && !/^[A-Za-z_][A-Za-z0-9_$]*$/.test(foreign.schema)) {
        return { ok: true, verify: { currentSchema: current, isolationChecked: false, checkedTable: null, note: "the other schema's name cannot be quoted safely; the denial check is skipped" } };
      }
      const q = (id) => '"' + String(id).replace(/"/g, '""') + '"';
      try {
        await role.query(`SELECT 1 FROM ${q(foreign.schema)}.${q(foreign.table)} LIMIT 1`);
      } catch (e) {
        if (e && e.code === PERMISSION_DENIED) {
          return { ok: true, verify: { currentSchema: current, isolationChecked: true, checkedTable: `${foreign.schema}.${foreign.table}`, note: `${ROLE} is denied on ${foreign.schema}.${foreign.table} (permission denied, as required)` } };
        }
        return { ok: false, step: "verify", error: `the denial check on ${foreign.schema}.${foreign.table} failed for another reason: ${pgErrorText(e, secrets)}` };
      }
      return { ok: false, step: "verify", error: `${ROLE} could read ${foreign.schema}.${foreign.table} — the isolation is NOT in place; nothing was written to the Credential Store. Check the role's memberships (it must not be a member of dbo).` };
    } finally {
      await role.end().catch(() => {});
    }
  }

  /**
   * Prepare the backend's database access on `instanceName`: role, schema,
   * grants, verification, entry. Idempotent; the password is reused when an
   * entry exists (a running backend is never surprised).
   */
  async function prepare({ instanceName } = {}) {
    const v = validateInstanceName(instanceName);
    if (!v.ok) return { ok: false, step: "instance", error: v.error };
    const name = v.name;
    if (!store.available()) {
      return { ok: false, step: "store", error: "the Credential Store is not bound to the manager (or the binding is not active yet), so the database access entry cannot be written — finish Setup step 1 and let the manager restart, then try again" };
    }
    const inst = await describeInstance(name);
    if (!inst.exists) return { ok: false, step: "instance", error: `service instance ${name} does not exist in this space (Setup step 1 creates it; step 3 lists it)`, command: `cf service ${name}` };
    if (inst.offering && inst.offering !== "postgresql-db") return { ok: false, step: "instance", error: `service instance ${name} is a ${inst.offering} instance, not postgresql-db`, command: `cf service ${name}` };
    if (inst.status !== "ready") return { ok: false, step: "instance", error: `service instance ${name} is not ready (${inst.operation || inst.status}) — wait until it is, then try again`, command: `cf service ${name}` };

    let existing = null;
    try {
      existing = await store.read();
    } catch (e) {
      return { ok: false, step: "store", error: `could not read the Credential Store entry ${ENTRY}: ${e.message}` };
    }
    const reuse = !!(existing && typeof existing.password === "string" && PASSWORD_RE.test(existing.password));
    const password = reuse ? existing.password : newPassword();
    if (!PASSWORD_RE.test(password)) return { ok: false, step: "role", error: "the generated password is not usable" };

    log("faid", "line", `Preparing database access on ${name}: role ${ROLE}, schema ${SCHEMA}${reuse ? " (password kept from the existing entry)" : ""} …`);
    const r = await withAdminConnection(name, async (client, connection) => {
      const secrets = [password, connection.password];
      const s = await runStatements(client, prepareStatements(password), secrets);
      if (!s.ok) return s;
      const ver = await verifyAsRole(client, connection, password);
      if (!ver.ok) return ver;
      try {
        await store.write(entryValue({ connection, password, instanceName: name, instanceGuid: inst.guid }));
      } catch (e) {
        return { ok: false, step: "store", error: `writing the Credential Store entry ${ENTRY} failed: ${e.message}` };
      }
      return { ok: true, verify: ver.verify };
    });
    if (!r.ok) {
      log("faid", "error", `Database access on ${name} NOT prepared (${r.step}): ${r.error}`);
      return { ...r, instanceName: name };
    }
    log("faid", "line", `Database access prepared: ${name} · role ${ROLE} · schema ${SCHEMA} · entry ${NAMESPACE}/${ENTRY} written. ${r.verify.note}`);
    return { ok: true, instanceName: name, instanceGuid: inst.guid, role: ROLE, schema: SCHEMA, passwordReused: reuse, verify: r.verify };
  }

  /** New password for faid_app; the entry is updated. The caller restarts the backend. */
  async function rotate() {
    if (!store.available()) return { ok: false, step: "store", error: "the Credential Store is not bound to the manager (or the binding is not active yet)" };
    let existing = null;
    try { existing = await store.read(); } catch (e) { return { ok: false, step: "store", error: `could not read the Credential Store entry ${ENTRY}: ${e.message}` }; }
    if (!existing || !existing.instanceName) return { ok: false, step: "store", error: "database access is not prepared (no entry) — nothing to rotate" };
    const name = existing.instanceName;
    const inst = await describeInstance(name);
    if (!inst.exists || inst.status !== "ready") return { ok: false, step: "instance", error: `service instance ${name} (from the entry) is ${inst.exists ? inst.operation || inst.status : "missing"}`, command: `cf service ${name}` };
    const password = newPassword();
    log("faid", "line", `Rotating the password of ${ROLE} on ${name} …`);
    const r = await withAdminConnection(name, async (client, connection) => {
      const secrets = [password, connection.password];
      const s = await runStatements(client, [{ step: "role", sql: rotateStatement(password) }], secrets);
      if (!s.ok) return s;
      const ver = await verifyAsRole(client, connection, password);
      if (!ver.ok) return ver;
      try {
        await store.write(entryValue({ connection, password, instanceName: name, instanceGuid: inst.guid }));
      } catch (e) {
        return { ok: false, step: "store", error: `writing the Credential Store entry ${ENTRY} failed: ${e.message} — the role already has the new password; run Rotate again` };
      }
      return { ok: true };
    });
    if (!r.ok) {
      log("faid", "error", `Password rotation on ${name} failed (${r.step}): ${r.error}`);
      return { ...r, instanceName: name };
    }
    log("faid", "line", `Password of ${ROLE} rotated; entry ${NAMESPACE}/${ENTRY} updated. The backend reads it at its next start.`);
    return { ok: true, instanceName: name, instanceGuid: inst.guid, restartRequired: true };
  }

  /** DROP SCHEMA faid CASCADE + DROP ROLE faid_app; the entry is deleted. */
  async function drop() {
    if (!store.available()) return { ok: false, step: "store", error: "the Credential Store is not bound to the manager (or the binding is not active yet)" };
    let existing = null;
    try { existing = await store.read(); } catch (e) { return { ok: false, step: "store", error: `could not read the Credential Store entry ${ENTRY}: ${e.message}` }; }
    if (!existing || !existing.instanceName) return { ok: false, step: "store", error: "database access is not prepared (no entry) — nothing to drop" };
    const name = existing.instanceName;
    const inst = await describeInstance(name);
    if (!inst.exists) {
      // The instance is gone (and its keys with it): only the entry is left to remove.
      try { await store.delete(); } catch (e) { return { ok: false, step: "store", error: `deleting the entry failed: ${e.message}` }; }
      log("faid", "line", `Instance ${name} no longer exists; the stale entry ${NAMESPACE}/${ENTRY} was deleted.`);
      return { ok: true, instanceName: name, instanceGone: true };
    }
    if (inst.status !== "ready") return { ok: false, step: "instance", error: `service instance ${name} is ${inst.operation || inst.status}`, command: `cf service ${name}` };
    log("faid", "warn", `Dropping schema ${SCHEMA} (with every table in it) and role ${ROLE} on ${name} …`);
    const r = await withAdminConnection(name, async (client, connection) => {
      const secrets = [connection.password];
      const statements = teardownStatements().map((sql, i) => ({ step: i === 3 ? "schema" : i === 4 ? "role" : "teardown", sql }));
      const s = await runStatements(client, statements, secrets);
      if (!s.ok) {
        await client.query("ROLLBACK;").catch(() => {});
        return s;
      }
      return { ok: true };
    });
    if (!r.ok) {
      log("faid", "error", `Drop on ${name} failed (${r.step}): ${r.error}`);
      return { ...r, instanceName: name };
    }
    try { await store.delete(); } catch (e) { return { ok: false, step: "store", error: `schema and role are dropped, but deleting the entry failed: ${e.message}`, instanceName: name }; }
    const keyGone = await deleteKey(name);
    log("faid", "line", `Schema ${SCHEMA} and role ${ROLE} dropped on ${name}; entry ${NAMESPACE}/${ENTRY} deleted${keyGone ? `; service key ${KEY_NAME} deleted` : ""}.`);
    return { ok: true, instanceName: name, keyDeleted: keyGone };
  }

  /**
   * The state of the database access, without a database connection:
   *   unknown       the Credential Store binding is not active (token mode)
   *   not-prepared  no entry
   *   stale         the entry names an instance that is gone, or another GUID
   *   prepared      the entry matches a ready instance
   * `instanceName` is the entry's instance (null without an entry).
   */
  async function status() {
    const base = { ok: true, role: ROLE, schema: SCHEMA, namespace: NAMESPACE, entry: ENTRY };
    if (!store.available()) return { ...base, state: "unknown", prepared: false, instanceName: null, instanceGuid: null, reason: "Credential Store binding not active" };
    let existing = null;
    try { existing = await store.read(); } catch (e) { return { ...base, state: "unknown", prepared: false, instanceName: null, instanceGuid: null, reason: `could not read the entry: ${e.message}` }; }
    if (!existing || !existing.instanceName) return { ...base, state: "not-prepared", prepared: false, instanceName: null, instanceGuid: null, reason: "no entry" };
    const inst = await describeInstance(existing.instanceName);
    if (!inst.exists) return { ...base, state: "stale", prepared: false, instanceName: existing.instanceName, instanceGuid: existing.instanceGuid || null, reason: `instance ${existing.instanceName} no longer exists` };
    if (existing.instanceGuid && inst.guid && existing.instanceGuid !== inst.guid) {
      return { ...base, state: "stale", prepared: false, instanceName: existing.instanceName, instanceGuid: existing.instanceGuid, reason: `instance ${existing.instanceName} was re-created (another GUID); prepare again` };
    }
    return { ...base, state: inst.status === "ready" ? "prepared" : "stale", prepared: inst.status === "ready", instanceName: existing.instanceName, instanceGuid: inst.guid, instanceStatus: inst.status, reason: inst.status === "ready" ? "" : `instance ${existing.instanceName} is ${inst.operation || inst.status}` };
  }

  return { prepare, rotate, drop, status, describeInstance, certificateChain, deleteKey };
}

module.exports = {
  SCHEMA,
  ROLE,
  NAMESPACE,
  ENTRY,
  KEY_NAME,
  CA_ENV,
  INSTANCE_NAME_RE,
  validateInstanceName,
  validateIdentifier,
  generatePassword,
  parseServiceKeyOutput,
  connectionFromKey,
  parseCfService,
  parseCfServices,
  prepareStatements,
  rotateStatement,
  teardownStatements,
  entryValue,
  pgErrorText,
  createEntryStore,
  createFaidDatabase,
};
