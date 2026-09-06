"use strict";
// Tests for the system-connections handlers (decision 0006 vertical slice).
// The credstore client and fetch are injected fakes — no network, no store.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  CONNECTIONS_NAMESPACE,
  FIGAF_TOOL_CREDENTIAL,
  systemCredentialName,
  pipoCredentialName,
  isPiPlatform,
  cleanDestinationName,
  parseServiceKey,
  createConnectionsHandlers,
} = require("./connections");

// ─── pure helpers ────────────────────────────────────────────────────────────

test("parseServiceKey accepts a raw it-rt api key", () => {
  const r = parseServiceKey(JSON.stringify({
    url: "https://tenant.it-cpi.example/",
    uaa: { clientid: "sb-x", clientsecret: "s3cret", url: "https://sub.authentication.example" },
  }));
  assert.equal(r.baseUrl, "https://tenant.it-cpi.example");
  assert.equal(r.tokenUrl, "https://sub.authentication.example/oauth/token");
  assert.equal(r.clientId, "sb-x");
  assert.equal(r.clientSecret, "s3cret");
});

test("parseServiceKey unwraps the cf service-key 'credentials' wrapper", () => {
  const r = parseServiceKey(JSON.stringify({
    credentials: { url: "https://t.example", uaa: { clientid: "a", clientsecret: "b", url: "https://u.example" } },
  }));
  assert.equal(r.baseUrl, "https://t.example");
  assert.equal(r.clientId, "a");
});

test("parseServiceKey accepts the current oauth-block it-rt key", () => {
  const r = parseServiceKey(JSON.stringify({
    oauth: {
      url: "https://tenant.it-cpi018-rt.example",
      tokenurl: "https://sub.authentication.example/oauth/token",
      clientid: "sb-y", clientsecret: "sec2",
    },
  }));
  assert.equal(r.baseUrl, "https://tenant.it-cpi018-rt.example");
  assert.equal(r.tokenUrl, "https://sub.authentication.example/oauth/token"); // verbatim, no suffix added
  assert.equal(r.clientId, "sb-y");
  assert.equal(r.clientSecret, "sec2");
});

test("parseServiceKey accepts a flat key", () => {
  const r = parseServiceKey(JSON.stringify({
    url: "https://t.example", tokenurl: "https://u.example/oauth/token", clientid: "a", clientsecret: "b",
  }));
  assert.equal(r.tokenUrl, "https://u.example/oauth/token");
  assert.equal(r.clientId, "a");
});

test("parseServiceKey rejects invalid JSON and incomplete keys", () => {
  assert.ok(parseServiceKey("{not json").error);
  assert.ok(parseServiceKey(JSON.stringify({ url: "https://t.example" })).error);
  assert.ok(parseServiceKey(JSON.stringify({ oauth: { url: "https://t.example" } })).error);
});

test("systemCredentialName encodes unsafe characters and requires an id", () => {
  assert.equal(systemCredentialName("3f9a-uuid"), "3f9a-uuid/api");
  assert.equal(systemCredentialName("Demo Dev"), "Demo_20Dev/api");
  assert.throws(() => systemCredentialName("  "));
});

// ─── handler harness ─────────────────────────────────────────────────────────

const BINDING = { url: "https://store.example/api/v1/credentials", username: "u", password: "p" };

function fakeCredstore(stored = {}) {
  const calls = { writes: [], deletes: [] };
  return {
    calls,
    findCredstoreBinding: () => BINDING,
    async readCredential(_binding, { namespace, name }) {
      assert.equal(namespace, CONNECTIONS_NAMESPACE);
      const value = stored[name];
      return value === undefined ? null : { name, value, username: null };
    },
    async writeCredential(_binding, { namespace, name, value, username }) {
      assert.equal(namespace, CONNECTIONS_NAMESPACE);
      calls.writes.push({ name, value, username });
      stored[name] = value;
    },
    async deleteCredential(_binding, { namespace, name }) {
      assert.equal(namespace, CONNECTIONS_NAMESPACE);
      calls.deletes.push(name);
      delete stored[name];
    },
  };
}

/** Routes fetch calls by URL substring. Each route: { status, body } or a function(url, options). */
function fakeFetch(routes) {
  const seen = [];
  const impl = async (url, options = {}) => {
    seen.push({ url: String(url), options });
    for (const [needle, route] of Object.entries(routes)) {
      if (String(url).includes(needle)) {
        const r = typeof route === "function" ? route(url, options) : route;
        return { ok: r.status >= 200 && r.status < 300, status: r.status, text: async () => r.body ?? "" };
      }
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  impl.seen = seen;
  return impl;
}

const FIGAF_ENTRY = JSON.stringify({
  baseUrl: "https://figaf.example", tokenUrl: "https://figaf.example/oauth/token",
  clientId: "api-client", clientSecret: "figaf-secret",
});

const TOKEN_OK = { status: 200, body: JSON.stringify({ access_token: "tok" }) };
const AGENTS_OK = { status: 200, body: JSON.stringify([{ id: "a1", systemId: "DemoDev", name: "Demo Dev", platform: "CPI" }]) };

// ─── saveFigaf ───────────────────────────────────────────────────────────────

test("saveFigaf verifies before storing and stores a verified entry", async () => {
  const credstore = fakeCredstore();
  const fetchImpl = fakeFetch({ "/oauth/token": TOKEN_OK, "/api/v1/agent/search": AGENTS_OK });
  const h = createConnectionsHandlers({ credstore, fetchImpl });
  const r = await h["connections:saveFigaf"]({
    baseUrl: "https://figaf.example/", clientId: "api-client", clientSecret: "figaf-secret",
  });
  assert.equal(r.ok, true);
  assert.equal(r.agentCount, 1);
  assert.equal(credstore.calls.writes.length, 1);
  const write = credstore.calls.writes[0];
  assert.equal(write.name, FIGAF_TOOL_CREDENTIAL);
  const entry = JSON.parse(write.value);
  assert.equal(entry.baseUrl, "https://figaf.example");
  assert.equal(entry.tokenUrl, "https://figaf.example/oauth/token");
  assert.ok(entry.verifiedAt);
  // the RPC response itself must never carry the secret
  assert.ok(!JSON.stringify(r).includes("figaf-secret"));
});

test("saveFigaf stores nothing when verification fails, and leaks no secret", async () => {
  const credstore = fakeCredstore();
  const fetchImpl = fakeFetch({ "/oauth/token": { status: 401, body: "" } });
  const h = createConnectionsHandlers({ credstore, fetchImpl });
  const r = await h["connections:saveFigaf"]({
    baseUrl: "https://figaf.example", clientId: "c", clientSecret: "super-secret",
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /verification failed/);
  assert.ok(!r.error.includes("super-secret"));
  assert.equal(credstore.calls.writes.length, 0);
});

test("saveFigaf rejects non-https URLs without any network call", async () => {
  const credstore = fakeCredstore();
  const fetchImpl = fakeFetch({});
  const h = createConnectionsHandlers({ credstore, fetchImpl });
  const r = await h["connections:saveFigaf"]({ baseUrl: "http://figaf.example", clientId: "c", clientSecret: "s" });
  assert.equal(r.ok, false);
  assert.equal(fetchImpl.seen.length, 0);
});

// ─── figafStatus ─────────────────────────────────────────────────────────────

test("figafStatus is masked and reports not-configured cleanly", async () => {
  const credstore = fakeCredstore({ [FIGAF_TOOL_CREDENTIAL]: FIGAF_ENTRY });
  const h = createConnectionsHandlers({ credstore, fetchImpl: fakeFetch({}) });
  const r = await h["connections:figafStatus"]();
  assert.equal(r.configured, true);
  assert.equal(r.baseUrl, "https://figaf.example");
  assert.ok(!JSON.stringify(r).includes("figaf-secret"));

  const empty = createConnectionsHandlers({ credstore: fakeCredstore(), fetchImpl: fakeFetch({}) });
  const r2 = await empty["connections:figafStatus"]();
  assert.deepEqual({ ok: r2.ok, configured: r2.configured }, { ok: true, configured: false });
});

// ─── listAgents ──────────────────────────────────────────────────────────────

test("listAgents needs the Figaf connection first", async () => {
  const h = createConnectionsHandlers({ credstore: fakeCredstore(), fetchImpl: fakeFetch({}) });
  const r = await h["connections:listAgents"]();
  assert.equal(r.ok, false);
  assert.equal(r.needsFigaf, true);
});

test("listAgents merges the live agent list with stored connection status", async () => {
  const stored = {
    [FIGAF_TOOL_CREDENTIAL]: FIGAF_ENTRY,
    "a1/api": JSON.stringify({ kind: "api", agentId: "a1", baseUrl: "https://t1.example", verifiedAt: "2026-09-01T00:00:00Z" }),
  };
  const fetchImpl = fakeFetch({
    "/oauth/token": TOKEN_OK,
    "/api/v1/agent/search": {
      status: 200,
      body: JSON.stringify([
        { id: "a1", systemId: "DemoDev", name: "Demo Dev", platform: "CPI" },
        { id: "a2", systemId: "DemoProd", name: "Demo Prod", platform: "CPI" },
      ]),
    },
  });
  const h = createConnectionsHandlers({ credstore: fakeCredstore(stored), fetchImpl });
  const r = await h["connections:listAgents"]();
  assert.equal(r.ok, true);
  assert.equal(r.agents.length, 2);
  const a1 = r.agents.find((a) => a.id === "a1");
  const a2 = r.agents.find((a) => a.id === "a2");
  assert.equal(a1.connected, true);
  assert.equal(a1.connection.baseUrl, "https://t1.example");
  assert.equal(a2.connected, false);
  assert.ok(!JSON.stringify(r).includes("figaf-secret"));
});

// ─── saveSystem / deleteSystem ───────────────────────────────────────────────

const KEY_JSON = JSON.stringify({
  url: "https://tenant.example",
  uaa: { clientid: "sb-it", clientsecret: "is-secret", url: "https://auth.example" },
});

test("saveSystem verifies token + $metadata, then stores under <agentId>/api", async () => {
  const credstore = fakeCredstore();
  const fetchImpl = fakeFetch({
    "auth.example/oauth/token": TOKEN_OK,
    "/api/v1/$metadata": { status: 200, body: "<edmx/>" },
  });
  const h = createConnectionsHandlers({ credstore, fetchImpl });
  const r = await h["connections:saveSystem"]({
    agentId: "a1", agentSystemId: "DemoDev", agentName: "Demo Dev", serviceKeyJson: KEY_JSON,
  });
  assert.equal(r.ok, true);
  assert.equal(credstore.calls.writes.length, 1);
  assert.equal(credstore.calls.writes[0].name, "a1/api");
  const entry = JSON.parse(credstore.calls.writes[0].value);
  assert.equal(entry.kind, "api");
  assert.equal(entry.agentSystemId, "DemoDev");
  assert.equal(entry.tokenUrl, "https://auth.example/oauth/token");
  assert.ok(entry.verifiedAt);
  assert.ok(!JSON.stringify(r).includes("is-secret"));
});

test("saveSystem stores nothing when the $metadata probe fails", async () => {
  const credstore = fakeCredstore();
  const fetchImpl = fakeFetch({
    "auth.example/oauth/token": TOKEN_OK,
    "/api/v1/$metadata": { status: 403, body: "" },
  });
  const h = createConnectionsHandlers({ credstore, fetchImpl });
  const r = await h["connections:saveSystem"]({ agentId: "a1", serviceKeyJson: KEY_JSON });
  assert.equal(r.ok, false);
  assert.match(r.error, /verification failed/);
  assert.equal(credstore.calls.writes.length, 0);
});

test("deleteSystem removes the entry by encoded name", async () => {
  const credstore = fakeCredstore({ "Demo_20Dev/api": "{}" });
  const h = createConnectionsHandlers({ credstore, fetchImpl: fakeFetch({}) });
  const r = await h["connections:deleteSystem"]({ agentId: "Demo Dev" });
  assert.equal(r.ok, true);
  assert.deepEqual(credstore.calls.deletes, ["Demo_20Dev/api"]);
});

// ─── PI/PO connections (decision 0011) ───────────────────────────────────────
// A PI/PO entry holds NO secret: the PI user lives in the BTP destination, the
// tunnel in the SAP Cloud Connector. The manager cannot read a destination
// itself (it is not bound to the destination service), so verification is
// delegated to the shared backend through ctx.probeDestination.

test("pipoCredentialName / isPiPlatform / cleanDestinationName", () => {
  assert.equal(pipoCredentialName("a1"), "a1/pipo");
  assert.equal(pipoCredentialName("we ird/id"), "we_20ird_2Fid/pipo");
  assert.throws(() => pipoCredentialName("  "), /agentId is required/);
  assert.equal(isPiPlatform("PRO"), true);
  assert.equal(isPiPlatform("pro"), true);
  assert.equal(isPiPlatform("CPI"), false);
  assert.equal(isPiPlatform(undefined), false);
  assert.equal(cleanDestinationName(" PO_TPM_DEV ").name, "PO_TPM_DEV");
  assert.ok(cleanDestinationName("").error);
  assert.ok(cleanDestinationName("has space").error);
  assert.ok(cleanDestinationName("semi;colon").error);
});

const PROBE_OK = async () => ({ ok: true, found: true, proxyType: "OnPremise", locationId: "pi-dev" });

test("savePipoSystem stores the destination name under <agentId>/pipo, with no secret", async () => {
  const credstore = fakeCredstore();
  const h = createConnectionsHandlers({ credstore, fetchImpl: fakeFetch({}), probeDestination: PROBE_OK });
  const r = await h["connections:savePipoSystem"]({
    agentId: "a9", agentSystemId: "PO_DEV", agentName: "PO Dev", destinationName: " PO_TPM_DEV ",
  });
  assert.equal(r.ok, true);
  assert.equal(r.destinationName, "PO_TPM_DEV");
  assert.equal(r.locationId, "pi-dev");
  assert.equal(credstore.calls.writes.length, 1);
  const write = credstore.calls.writes[0];
  assert.equal(write.name, "a9/pipo");
  const entry = JSON.parse(write.value);
  assert.equal(entry.kind, "pipo");
  assert.equal(entry.agentId, "a9");
  assert.equal(entry.destinationName, "PO_TPM_DEV");
  assert.equal(entry.proxyType, "OnPremise");
  assert.ok(entry.verifiedAt);
  // The entry shape is a contract with the reader side: no credential fields.
  assert.deepEqual(
    Object.keys(entry).sort(),
    ["agentId", "agentName", "agentSystemId", "destinationName", "kind", "locationId", "proxyType", "verifiedAt"]
  );
});

test("savePipoSystem stores NOTHING when the backend cannot check", async () => {
  const credstore = fakeCredstore();
  const h = createConnectionsHandlers({
    credstore, fetchImpl: fakeFetch({}),
    probeDestination: async () => ({ ok: false, error: "no route on figaf-l3l4-backend", hint: "Install the platform first" }),
  });
  const r = await h["connections:savePipoSystem"]({ agentId: "a9", destinationName: "PO_TPM_DEV" });
  assert.equal(r.ok, false);
  assert.match(r.error, /nothing was stored/);
  assert.match(r.error, /no route/);
  assert.equal(r.hint, "Install the platform first");
  assert.equal(credstore.calls.writes.length, 0);
});

test("savePipoSystem stores NOTHING when the destination does not exist", async () => {
  const credstore = fakeCredstore();
  const h = createConnectionsHandlers({
    credstore, fetchImpl: fakeFetch({}),
    probeDestination: async () => ({ ok: true, found: false }),
  });
  const r = await h["connections:savePipoSystem"]({ agentId: "a9", destinationName: "PO_TPM_TYPO" });
  assert.equal(r.ok, false);
  assert.match(r.error, /does not see a destination called "PO_TPM_TYPO"/);
  assert.match(r.hint, /BTP cockpit/);
  assert.equal(credstore.calls.writes.length, 0);
});

test("savePipoSystem passes a warning back but still stores (the destination exists)", async () => {
  const credstore = fakeCredstore();
  const h = createConnectionsHandlers({
    credstore, fetchImpl: fakeFetch({}),
    probeDestination: async () => ({ ok: true, found: true, proxyType: "Internet", locationId: "", warning: "ProxyType is \"Internet\"" }),
  });
  const r = await h["connections:savePipoSystem"]({ agentId: "a9", destinationName: "PO_TPM_DEV" });
  assert.equal(r.ok, true);
  assert.match(r.warning, /Internet/);
  assert.equal(credstore.calls.writes.length, 1);
});

test("savePipoSystem rejects a bad destination name before calling the backend", async () => {
  let probed = false;
  const credstore = fakeCredstore();
  const h = createConnectionsHandlers({
    credstore, fetchImpl: fakeFetch({}),
    probeDestination: async () => { probed = true; return { ok: true, found: true }; },
  });
  const r = await h["connections:savePipoSystem"]({ agentId: "a9", destinationName: "PO TPM DEV" });
  assert.equal(r.ok, false);
  assert.equal(probed, false);
  assert.equal(credstore.calls.writes.length, 0);
});

test("savePipoSystem refuses when no backend probe is wired", async () => {
  const credstore = fakeCredstore();
  const h = createConnectionsHandlers({ credstore, fetchImpl: fakeFetch({}) });
  const r = await h["connections:savePipoSystem"]({ agentId: "a9", destinationName: "PO_TPM_DEV" });
  assert.equal(r.ok, false);
  assert.match(r.error, /no backend probe/);
  assert.equal(credstore.calls.writes.length, 0);
});

test("deletePipoSystem removes the /pipo entry only", async () => {
  const credstore = fakeCredstore({ "a9/pipo": JSON.stringify({ kind: "pipo" }), "a9/api": JSON.stringify({ kind: "api" }) });
  const h = createConnectionsHandlers({ credstore, fetchImpl: fakeFetch({}) });
  const r = await h["connections:deletePipoSystem"]({ agentId: "a9" });
  assert.equal(r.ok, true);
  assert.deepEqual(credstore.calls.deletes, ["a9/pipo"]);
});

test("listAgents reads /pipo for a PRO agent and /api for the others", async () => {
  const stored = {
    [FIGAF_TOOL_CREDENTIAL]: FIGAF_ENTRY,
    "a1/api": JSON.stringify({ kind: "api", baseUrl: "https://t1.example", verifiedAt: "2026-09-01T00:00:00Z" }),
    "a2/pipo": JSON.stringify({ kind: "pipo", destinationName: "PO_TPM_DEV", locationId: "pi-dev", proxyType: "OnPremise", verifiedAt: "2026-09-04T00:00:00Z" }),
  };
  const fetchImpl = fakeFetch({
    "/oauth/token": TOKEN_OK,
    "/api/v1/agent/search": {
      status: 200,
      body: JSON.stringify([
        { id: "a1", systemId: "DemoDev", name: "Demo Dev", platform: "CPI" },
        { id: "a2", systemId: "PO_DEV", name: "PO Dev", platform: "PRO" },
        { id: "a3", systemId: "PO_QA", name: "PO QA", platform: "PRO" },
      ]),
    },
  });
  const h = createConnectionsHandlers({ credstore: fakeCredstore(stored), fetchImpl });
  const r = await h["connections:listAgents"]();
  assert.equal(r.ok, true);
  const [a1, a2, a3] = ["a1", "a2", "a3"].map((id) => r.agents.find((a) => a.id === id));
  assert.equal(a1.kind, "api");
  assert.equal(a1.connected, true);
  assert.equal(a1.connection.baseUrl, "https://t1.example");
  assert.equal(a2.kind, "pipo");
  assert.equal(a2.connected, true);
  assert.equal(a2.connection.destinationName, "PO_TPM_DEV");
  assert.equal(a2.connection.locationId, "pi-dev");
  assert.equal(a3.kind, "pipo");
  assert.equal(a3.connected, false);
});
