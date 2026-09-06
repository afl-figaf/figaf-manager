"use strict";
// System connections (decision 0006 vertical slice, figaf-l3-l4 repo).
//
// The manager is the ONLY WRITER of connection entries; L3 app backends READ
// them at runtime straight from the SAP Credential Store. That store is the
// hand-off between the two sides — the manager never touches an app database.
//
// Credential Store layout (namespace `figaf-connections`, password-type,
// `value` holds a JSON string):
//   figaf-tool       — Level 1, the one Figaf tool of this installation:
//                      { baseUrl, tokenUrl, clientId, clientSecret,
//                        accessClientId?, accessClientSecret?, verifiedAt,
//                        agentCount }
//   <agentId>/api    — Level 2, one per connected SAP Integration Suite
//                      system (agentId = Figaf agent id from
//                      POST /api/v1/agent/search):
//                      { kind:"api", agentId, agentSystemId, agentName,
//                        baseUrl, tokenUrl, clientId, clientSecret, verifiedAt }
//   <agentId>/pipo   — Level 2, one per on-premise PI/PO system (Figaf agent
//                      with platform "PRO"), decision 0011:
//                      { kind:"pipo", agentId, agentSystemId, agentName,
//                        destinationName, proxyType, locationId, verifiedAt }
//                      NO SECRET: the PI user and password live in the BTP
//                      destination, the tunnel in the SAP Cloud Connector.
//
// Every save VERIFIES the credentials against the real endpoint first
// (Figaf: OAuth token + agent/search; SAP: OAuth token + GET /api/v1/$metadata;
// PI/PO: the shared backend reads the destination through its own binding)
// and only stores what worked. No secret value is ever returned to the
// renderer, logged, or echoed in an error message.
//
// KEEP IN SYNC: the reader side lives in the figaf-l3-l4 repo,
// spikes/archiving-setup-playground/backend/srv/lib/platform-connections.js —
// namespace, credential names, and the JSON value shape must match.

const credstoreClientDefault = require("./credstore-client");

const CONNECTIONS_NAMESPACE = "figaf-connections";
const FIGAF_TOOL_CREDENTIAL = "figaf-tool";
// Same scope set the L3 backend connector uses for its Figaf public-API login.
const DEFAULT_FIGAF_SCOPE = "agent:read ctt:sync";
const STATUS_CACHE_MS = 60 * 1000; // credstore reads are rate-limited
const MAX_STATUS_READS = 20;

// ─── pure helpers (unit-tested in connections.test.js) ───────────────────────

function cleanUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function isHttpsUrl(value) {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

/** Credential name for one system's `api` entry. MUST match the reader side. */
function systemCredentialName(agentId) {
  const segment = encodeURIComponent(String(agentId || "").trim()).replace(/%/g, "_");
  if (!segment) throw new Error("agentId is required");
  return `${segment}/api`;
}

/**
 * Credential name for one system's `pipo` entry (on-premise PI/PO, decision
 * 0011). MUST match the reader side. Same agent id, different suffix: a system
 * is either an Integration Suite tenant (`/api`) or a PI/PO system (`/pipo`).
 */
function pipoCredentialName(agentId) {
  const segment = encodeURIComponent(String(agentId || "").trim()).replace(/%/g, "_");
  if (!segment) throw new Error("agentId is required");
  return `${segment}/pipo`;
}

/** Figaf agent platform that means "on-premise SAP PI/PO" (everything else is cloud). */
function isPiPlatform(platform) {
  return String(platform || "").toUpperCase() === "PRO";
}

/**
 * A BTP destination name: what a person types in the cockpit. Kept strict so a
 * typo fails here and not inside a runtime call.
 */
function cleanDestinationName(value) {
  const name = String(value || "").trim();
  if (!name) return { error: "the destination name is required" };
  if (!/^[A-Za-z0-9._-]{1,200}$/.test(name)) {
    return { error: "a destination name may only contain letters, digits, dot, underscore and hyphen" };
  }
  return { name };
}

/** Cloudflare Access service-token headers, when the Figaf tool sits behind Access. */
function accessHeaders(entry) {
  return entry && entry.accessClientId && entry.accessClientSecret
    ? { "cf-access-client-id": entry.accessClientId, "cf-access-client-secret": entry.accessClientSecret }
    : {};
}

/** Tolerant agent-array extraction (same shapes the L3 connector accepts). */
function extractAgents(response) {
  if (Array.isArray(response)) return response;
  for (const key of ["content", "value", "items", "data", "agents", "results"]) {
    if (Array.isArray(response && response[key])) return response[key];
  }
  return [];
}

/**
 * Parse a pasted `it-rt` (plan `api`) service-key JSON into connection fields.
 * Accepts the shapes SAP actually issues:
 *   1. current it-rt keys:  { oauth: { url, tokenurl, clientid, clientsecret } }
 *   2. uaa-style keys:      { url, uaa: { url, clientid, clientsecret } }
 *   3. flat keys:           { url, tokenurl, clientid, clientsecret }
 * plus the `cf service-key` output wrapper ({ credentials: { ... } }).
 */
function parseServiceKey(text) {
  let key;
  try {
    key = JSON.parse(String(text || ""));
  } catch {
    return { error: "the pasted text is not valid JSON" };
  }
  if (key && typeof key.credentials === "object" && key.credentials) key = key.credentials;
  if (!key || typeof key !== "object" || Array.isArray(key)) {
    return { error: "the pasted text is not a service-key object" };
  }

  // Shape 1 — the oauth block (what the BTP cockpit shows for it-rt/api today).
  const oauth = key.oauth && typeof key.oauth === "object" ? key.oauth : null;
  if (oauth) {
    const baseUrl = cleanUrl(oauth.url || key.url);
    const tokenUrl = cleanUrl(oauth.tokenurl || oauth.tokenUrl);
    const clientId = String(oauth.clientid || oauth.clientId || "").trim();
    const clientSecret = String(oauth.clientsecret || oauth.clientSecret || "").trim();
    if (baseUrl && tokenUrl && clientId && clientSecret) return { baseUrl, tokenUrl, clientId, clientSecret };
    return { error: "the oauth block must contain url, tokenurl, clientid, and clientsecret — paste the full it-rt (plan api) key" };
  }

  // Shape 2 — uaa-style: the token URL is derived from the uaa server URL.
  const uaa = key.uaa && typeof key.uaa === "object" ? key.uaa : null;
  if (uaa) {
    const baseUrl = cleanUrl(key.url);
    const uaaUrl = cleanUrl(uaa.url);
    const clientId = String(uaa.clientid || uaa.clientId || "").trim();
    const clientSecret = String(uaa.clientsecret || uaa.clientSecret || "").trim();
    if (baseUrl && uaaUrl && clientId && clientSecret) {
      return { baseUrl, tokenUrl: `${uaaUrl}/oauth/token`, clientId, clientSecret };
    }
    return { error: "the uaa block must contain url, clientid, and clientsecret (plus the top-level url) — paste the full it-rt (plan api) key" };
  }

  // Shape 3 — flat.
  const baseUrl = cleanUrl(key.url);
  const tokenUrl = cleanUrl(key.tokenurl || key.tokenUrl);
  const clientId = String(key.clientid || key.clientId || "").trim();
  const clientSecret = String(key.clientsecret || key.clientSecret || "").trim();
  if (baseUrl && tokenUrl && clientId && clientSecret) return { baseUrl, tokenUrl, clientId, clientSecret };

  return { error: "unrecognized service key — expected an it-rt (plan api) key, normally { \"oauth\": { \"url\", \"tokenurl\", \"clientid\", \"clientsecret\" } }" };
}

// ─── handler factory ─────────────────────────────────────────────────────────

/**
 * @param {object} ctx
 * @param {object}   [ctx.credstore]  credstore-client module (injectable for tests)
 * @param {Function} [ctx.fetchImpl]  fetch (injectable for tests)
 * @param {Function} [ctx.log]        cli:line logger (source, type, text)
 * @param {Function} [ctx.probeDestination]  async (name) => { ok, found, proxyType,
 *   locationId, error? }. Verification of a PI/PO entry is DELEGATED to the
 *   shared backend (decision 0011): only the backend is bound to the
 *   destination service, so only it can read a destination. Wired in
 *   orchestrator.js to the l3:destinationCheck handler.
 */
function createConnectionsHandlers(ctx = {}) {
  const credstore = ctx.credstore || credstoreClientDefault;
  const fetchImpl = ctx.fetchImpl || fetch;
  const log = ctx.log || (() => {});
  const probeDestination = ctx.probeDestination || null;

  // name → { entry: object|null, at: epoch ms }. Spares the store's rate limit
  // when the agent list is refreshed; writes and deletes invalidate directly.
  const _cache = new Map();

  function _binding() {
    return credstore.findCredstoreBinding();
  }

  async function _readEntry(binding, name, { fresh } = {}) {
    const hit = _cache.get(name);
    if (!fresh && hit && Date.now() - hit.at <= STATUS_CACHE_MS) return hit.entry;
    const credential = await credstore.readCredential(
      binding, { namespace: CONNECTIONS_NAMESPACE, name }, fetchImpl
    );
    let entry = null;
    if (credential && credential.value) {
      try { entry = JSON.parse(credential.value); } catch { entry = null; }
    }
    _cache.set(name, { entry, at: Date.now() });
    return entry;
  }

  async function _writeEntry(binding, name, entry, username) {
    await credstore.writeCredential(
      binding,
      { namespace: CONNECTIONS_NAMESPACE, name, value: JSON.stringify(entry), username },
      fetchImpl
    );
    _cache.set(name, { entry, at: Date.now() });
  }

  async function _deleteEntry(binding, name) {
    await credstore.deleteCredential(binding, { namespace: CONNECTIONS_NAMESPACE, name }, fetchImpl);
    _cache.set(name, { entry: null, at: Date.now() });
  }

  /** OAuth client-credentials token. Error messages carry status only, never the secret. */
  async function _fetchToken(tokenUrl, clientId, clientSecret, { scope, extraHeaders } = {}) {
    const params = { grant_type: "client_credentials" };
    if (scope) params.scope = scope;
    const response = await fetchImpl(tokenUrl, {
      method: "POST",
      headers: {
        Authorization: "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        ...(extraHeaders || {}),
      },
      body: new URLSearchParams(params).toString(),
    });
    if (!response.ok) {
      throw new Error(`token request to ${new URL(tokenUrl).host} failed: HTTP ${response.status}`);
    }
    let payload;
    try { payload = JSON.parse(await response.text()); }
    catch { throw new Error("token endpoint returned invalid JSON"); }
    if (!payload.access_token) throw new Error("token response did not contain access_token");
    return payload.access_token;
  }

  /** Verify a Figaf-tool entry live; returns the agent array (throws on failure). */
  async function _verifyFigaf(entry) {
    const token = await _fetchToken(entry.tokenUrl, entry.clientId, entry.clientSecret, {
      scope: DEFAULT_FIGAF_SCOPE, extraHeaders: accessHeaders(entry),
    });
    const response = await fetchImpl(`${entry.baseUrl}/api/v1/agent/search`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        ...accessHeaders(entry),
      },
      body: JSON.stringify({ includeDecentralAdapterEngines: true }),
    });
    if (!response.ok) {
      throw new Error(`POST /api/v1/agent/search failed: HTTP ${response.status} — is this an API client of the Figaf public API?`);
    }
    let payload;
    try { payload = JSON.parse(await response.text()); } catch { payload = []; }
    return extractAgents(payload);
  }

  /** Verify one system's `api` entry live: token + OData $metadata (throws on failure). */
  async function _verifySystem(entry) {
    const token = await _fetchToken(entry.tokenUrl, entry.clientId, entry.clientSecret);
    const response = await fetchImpl(`${entry.baseUrl}/api/v1/$metadata`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/xml" },
    });
    if (!response.ok) {
      throw new Error(`GET /api/v1/$metadata failed: HTTP ${response.status} — is the key an it-rt key with plan "api"?`);
    }
  }

  function _mapAgent(a) {
    return {
      id: String(a.id || a.guid || a.agentId || ""),
      guid: String(a.guid || a.id || ""),
      systemId: String(a.systemId || a.systemID || ""),
      name: String(a.name || a.displayName || ""),
      platform: String(a.platform || a.platformType || "").toUpperCase(),
    };
  }

  return {
    /** Masked Level 1 status — no secret ever leaves this handler. */
    async "connections:figafStatus"() {
      const binding = _binding();
      if (!binding) return { ok: true, configured: false, bindingPresent: false, reason: "no credential-store binding" };
      try {
        const entry = await _readEntry(binding, FIGAF_TOOL_CREDENTIAL);
        if (!entry) return { ok: true, configured: false, bindingPresent: true };
        return {
          ok: true, configured: true, bindingPresent: true,
          baseUrl: entry.baseUrl || "", clientId: entry.clientId || "",
          hasAccessPair: Boolean(entry.accessClientId),
          verifiedAt: entry.verifiedAt || null, agentCount: entry.agentCount ?? null,
        };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    },

    /** Verify + store the installation's Figaf tool connection (Level 1). */
    async "connections:saveFigaf"({ baseUrl, tokenUrl, clientId, clientSecret, accessClientId, accessClientSecret } = {}) {
      const binding = _binding();
      if (!binding) return { ok: false, error: "the manager is not bound to a Credential Store instance" };
      const entry = {
        baseUrl: cleanUrl(baseUrl),
        clientId: String(clientId || "").trim(),
        clientSecret: String(clientSecret || ""),
        accessClientId: String(accessClientId || "").trim() || undefined,
        accessClientSecret: String(accessClientSecret || "").trim() || undefined,
      };
      if (!entry.baseUrl || !entry.clientId || !entry.clientSecret) {
        return { ok: false, error: "Figaf URL, API client id, and API client secret are required" };
      }
      if (!isHttpsUrl(entry.baseUrl)) return { ok: false, error: "the Figaf URL must be an https:// URL" };
      entry.tokenUrl = cleanUrl(tokenUrl) || `${entry.baseUrl}/oauth/token`;
      let agents;
      try {
        agents = await _verifyFigaf(entry);
      } catch (e) {
        return { ok: false, error: `verification failed — nothing was stored: ${e.message}` };
      }
      entry.verifiedAt = new Date().toISOString();
      entry.agentCount = agents.length;
      try {
        await _writeEntry(binding, FIGAF_TOOL_CREDENTIAL, entry, entry.clientId);
      } catch (e) {
        return { ok: false, error: e.message };
      }
      log("connections", "ok", `Figaf tool connection verified and stored (${entry.baseUrl}, ${agents.length} agents visible)`);
      return { ok: true, agentCount: agents.length };
    },

    async "connections:deleteFigaf"() {
      const binding = _binding();
      if (!binding) return { ok: false, error: "the manager is not bound to a Credential Store instance" };
      try {
        await _deleteEntry(binding, FIGAF_TOOL_CREDENTIAL);
      } catch (e) {
        return { ok: false, error: e.message };
      }
      log("connections", "line", "Figaf tool connection removed from the Credential Store");
      return { ok: true };
    },

    /**
     * The Connections dashboard row set: agents live from the Figaf tool,
     * each with its stored-connection status (no secrets in the response).
     */
    async "connections:listAgents"() {
      const binding = _binding();
      if (!binding) return { ok: false, error: "the manager is not bound to a Credential Store instance" };
      let figaf;
      try {
        figaf = await _readEntry(binding, FIGAF_TOOL_CREDENTIAL);
      } catch (e) {
        return { ok: false, error: e.message };
      }
      if (!figaf) return { ok: false, needsFigaf: true, error: "connect the Figaf tool first" };
      let rawAgents;
      try {
        rawAgents = await _verifyFigaf(figaf);
      } catch (e) {
        return { ok: false, error: `could not list agents from the Figaf tool: ${e.message}` };
      }
      const agents = [];
      let reads = 0;
      for (const raw of rawAgents.map(_mapAgent).filter((a) => a.id)) {
        let connected = null; // null = unknown (read failed or read budget spent)
        let connection = null;
        const pi = isPiPlatform(raw.platform);
        if (reads < MAX_STATUS_READS) {
          reads++;
          try {
            const name = pi ? pipoCredentialName(raw.id) : systemCredentialName(raw.id);
            const entry = await _readEntry(binding, name);
            connected = Boolean(entry);
            if (entry) {
              connection = pi
                ? {
                    kind: "pipo",
                    destinationName: entry.destinationName || "",
                    locationId: entry.locationId || "",
                    proxyType: entry.proxyType || "",
                    verifiedAt: entry.verifiedAt || null,
                  }
                : { kind: "api", baseUrl: entry.baseUrl || "", verifiedAt: entry.verifiedAt || null };
            }
          } catch {
            connected = null;
          }
        }
        agents.push({ ...raw, kind: pi ? "pipo" : "api", connected, connection });
      }
      return { ok: true, figafBaseUrl: figaf.baseUrl || "", agents };
    },

    /**
     * Verify + store one system's Integration Suite `api` connection (Level 2).
     * Preferred input: the pasted it-rt (plan api) service-key JSON.
     */
    async "connections:saveSystem"({ agentId, agentSystemId, agentName, serviceKeyJson, baseUrl, tokenUrl, clientId, clientSecret } = {}) {
      const binding = _binding();
      if (!binding) return { ok: false, error: "the manager is not bound to a Credential Store instance" };
      const id = String(agentId || "").trim();
      if (!id) return { ok: false, error: "agentId is required" };
      let fields;
      if (String(serviceKeyJson || "").trim()) {
        fields = parseServiceKey(serviceKeyJson);
        if (fields.error) return { ok: false, error: fields.error };
      } else {
        fields = {
          baseUrl: cleanUrl(baseUrl), tokenUrl: cleanUrl(tokenUrl),
          clientId: String(clientId || "").trim(), clientSecret: String(clientSecret || ""),
        };
        if (!fields.baseUrl || !fields.tokenUrl || !fields.clientId || !fields.clientSecret) {
          return { ok: false, error: "paste the it-rt service key JSON, or fill base URL, token URL, client id, and client secret" };
        }
      }
      if (!isHttpsUrl(fields.baseUrl) || !isHttpsUrl(fields.tokenUrl)) {
        return { ok: false, error: "base URL and token URL must be https:// URLs" };
      }
      const entry = {
        kind: "api",
        agentId: id,
        agentSystemId: String(agentSystemId || "").trim(),
        agentName: String(agentName || "").trim(),
        ...fields,
      };
      try {
        await _verifySystem(entry);
      } catch (e) {
        return { ok: false, error: `verification failed — nothing was stored: ${e.message}` };
      }
      entry.verifiedAt = new Date().toISOString();
      try {
        await _writeEntry(binding, systemCredentialName(id), entry, entry.clientId);
      } catch (e) {
        return { ok: false, error: e.message };
      }
      log("connections", "ok", `System connection verified and stored (${entry.agentName || id} → ${entry.baseUrl})`);
      return { ok: true, agentId: id, baseUrl: entry.baseUrl };
    },

    async "connections:deleteSystem"({ agentId } = {}) {
      const binding = _binding();
      if (!binding) return { ok: false, error: "the manager is not bound to a Credential Store instance" };
      const id = String(agentId || "").trim();
      if (!id) return { ok: false, error: "agentId is required" };
      try {
        await _deleteEntry(binding, systemCredentialName(id));
      } catch (e) {
        return { ok: false, error: e.message };
      }
      log("connections", "line", `System connection removed (${id})`);
      return { ok: true };
    },

    /**
     * Verify + store one on-premise PI/PO system (Level 2, decision 0011).
     * The person types the name of a BTP destination they created in the
     * cockpit; NO credential is entered here and none is stored - the PI user
     * lives in the destination, the tunnel in the SAP Cloud Connector, and the
     * Cloud Connector location id in the destination's
     * `CloudConnectorLocationId` property.
     *
     * Verification is delegated to the shared backend, the only side bound to
     * the destination service. It reports whether the destination exists, its
     * ProxyType and its location id. Nothing is stored when the check fails:
     * the destination name IS the whole entry, so an unverified entry would be
     * a guess.
     */
    async "connections:savePipoSystem"({ agentId, agentSystemId, agentName, destinationName } = {}) {
      const binding = _binding();
      if (!binding) return { ok: false, error: "the manager is not bound to a Credential Store instance" };
      const id = String(agentId || "").trim();
      if (!id) return { ok: false, error: "agentId is required" };
      const dest = cleanDestinationName(destinationName);
      if (dest.error) return { ok: false, error: dest.error };
      if (!probeDestination) {
        return { ok: false, error: "this build cannot check destinations - no backend probe is wired" };
      }
      let probe;
      try {
        probe = await probeDestination(dest.name);
      } catch (e) {
        probe = { ok: false, error: e.message };
      }
      if (!probe || !probe.ok) {
        return {
          ok: false,
          error: `the destination could not be checked - nothing was stored: ${(probe && probe.error) || "unknown error"}`,
          hint: (probe && probe.hint) || undefined,
        };
      }
      if (!probe.found) {
        return {
          ok: false,
          error: `the shared backend does not see a destination called "${dest.name}" - nothing was stored`,
          hint: "Create it in the BTP cockpit (Connectivity > Destinations) with ProxyType OnPremise and the property CloudConnectorLocationId, then check again.",
        };
      }
      const entry = {
        kind: "pipo",
        agentId: id,
        agentSystemId: String(agentSystemId || "").trim(),
        agentName: String(agentName || "").trim(),
        destinationName: dest.name,
        proxyType: String(probe.proxyType || ""),
        locationId: String(probe.locationId || ""),
        verifiedAt: new Date().toISOString(),
      };
      try {
        await _writeEntry(binding, pipoCredentialName(id), entry, dest.name);
      } catch (e) {
        return { ok: false, error: e.message };
      }
      log("connections", "ok", `PI/PO connection stored (${entry.agentName || id} -> destination ${dest.name})`);
      return {
        ok: true, agentId: id, destinationName: dest.name,
        proxyType: entry.proxyType, locationId: entry.locationId,
        warning: probe.warning || null,
      };
    },

    async "connections:deletePipoSystem"({ agentId } = {}) {
      const binding = _binding();
      if (!binding) return { ok: false, error: "the manager is not bound to a Credential Store instance" };
      const id = String(agentId || "").trim();
      if (!id) return { ok: false, error: "agentId is required" };
      try {
        await _deleteEntry(binding, pipoCredentialName(id));
      } catch (e) {
        return { ok: false, error: e.message };
      }
      log("connections", "line", `PI/PO connection removed (${id})`);
      return { ok: true };
    },
  };
}

module.exports = {
  CONNECTIONS_NAMESPACE,
  FIGAF_TOOL_CREDENTIAL,
  cleanUrl,
  systemCredentialName,
  pipoCredentialName,
  isPiPlatform,
  cleanDestinationName,
  extractAgents,
  parseServiceKey,
  createConnectionsHandlers,
};
