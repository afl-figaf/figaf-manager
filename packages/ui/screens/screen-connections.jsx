/* global React, Ico */

// ═══════════════════════════════════════════════════════════
// System connections (decision 0006, figaf-l3-l4 repo)
// Level 1: the ONE Figaf tool of this installation.
// Level 2: SAP Integration Suite systems — the list comes live
// from the Figaf tool (/api/v1/agent/search); per system the
// operator pastes the it-rt (plan api) service key, the manager
// verifies it against SAP, then stores it in the Credential
// Store (namespace figaf-connections). L3 app backends read the
// entries at runtime — apps never collect credentials themselves.
// ═══════════════════════════════════════════════════════════

function ConnFigafForm({ status, figafSystems, busy, onSave, onCancel }) {
  const [values, setValues] = React.useState({
    baseUrl: (status && status.baseUrl) || "",
    clientId: (status && status.clientId) || "",
    clientSecret: "",
    accessClientId: "",
    accessClientSecret: "",
  });
  const [showAccess, setShowAccess] = React.useState(false);
  const set = (k) => (e) => setValues((v) => ({ ...v, [k]: e.target.value }));
  return (
    <div style={{ marginTop: 10, padding: 12, border: "1px solid var(--line)", borderRadius: 8 }}>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>Connect the Figaf tool</div>
      <div style={{ fontSize: 12, color: "var(--ink-3)", marginBottom: 10 }}>
        The API client is created in the Figaf tool's admin UI (public API client).
        The connection is verified against <span className="kbd">/api/v1/agent/search</span> before
        anything is stored. Nothing is saved when verification fails.
      </div>
      <div className="field">
        <div className="field-label">Figaf tool URL</div>
        <select
          className="input"
          value=""
          disabled={busy}
          style={{ marginBottom: 6 }}
          onChange={(e) => { if (e.target.value) setValues((v) => ({ ...v, baseUrl: e.target.value })); }}
        >
          <option value="">
            {figafSystems === null
              ? "Looking for Figaf Tool deployments…"
              : figafSystems.length === 0
                ? "No Figaf Tool deployments visible to this login — enter the URL below"
                : "Pick a discovered Figaf Tool deployment…"}
          </option>
          {(figafSystems || []).map((s) => (
            <option key={s.id} value={s.url}>{s.id} — {s.url}</option>
          ))}
        </select>
        <input className="input is-mono" type="text" autoComplete="off"
          value={values.baseUrl} placeholder="https://…" onChange={set("baseUrl")} />
      </div>
      <div className="field">
        <div className="field-label">API client id</div>
        <input className="input is-mono" type="text" autoComplete="off"
          value={values.clientId} onChange={set("clientId")} />
      </div>
      <div className="field">
        <div className="field-label">API client secret (secret)</div>
        <input className="input is-mono" type="password" autoComplete="off"
          value={values.clientSecret} onChange={set("clientSecret")} />
      </div>
      {!showAccess && (
        <button className="btn" style={{ fontSize: 12 }} disabled={busy} onClick={() => setShowAccess(true)}>
          Behind Cloudflare Access? Add the service token…
        </button>
      )}
      {showAccess && (
        <>
          <div className="field">
            <div className="field-label">Cloudflare Access client id (optional)</div>
            <input className="input is-mono" type="text" autoComplete="off"
              value={values.accessClientId} onChange={set("accessClientId")} />
          </div>
          <div className="field">
            <div className="field-label">Cloudflare Access client secret (optional, secret)</div>
            <input className="input is-mono" type="password" autoComplete="off"
              value={values.accessClientSecret} onChange={set("accessClientSecret")} />
          </div>
        </>
      )}
      <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
        <button className="btn btn-primary" disabled={busy} onClick={() => onSave(values)}>
          {busy ? "Verifying…" : "Verify & save"}
        </button>
        <button className="btn" disabled={busy} onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

function ConnSystemForm({ agent, busy, onSave, onCancel }) {
  const [keyJson, setKeyJson] = React.useState("");
  return (
    <div style={{ marginTop: 10, padding: 12, border: "1px solid var(--line)", borderRadius: 8 }}>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>
        Connect {agent.name || agent.systemId || agent.id}
      </div>
      <div style={{ fontSize: 12, color: "var(--ink-3)", marginBottom: 10 }}>
        Paste the full service key of a <span className="kbd">Process Integration Runtime (it-rt)</span> instance
        with plan <span className="kbd">api</span> for THIS tenant. The manager verifies it
        (OAuth token + <span className="kbd">GET /api/v1/$metadata</span>) and stores it only when it works.
        The key is a secret — it is hidden in the terminal and audit logs.
      </div>
      <textarea
        className="input is-mono"
        rows={7}
        autoComplete="off"
        spellCheck={false}
        style={{ width: "100%", resize: "vertical" }}
        placeholder='{ "oauth": { "url": "https://….it-cpi….hana.ondemand.com", "tokenurl": "https://….authentication…/oauth/token", "clientid": "…", "clientsecret": "…" } }'
        value={keyJson}
        onChange={(e) => setKeyJson(e.target.value)}
      />
      <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
        <button className="btn btn-primary" disabled={busy || !keyJson.trim()} onClick={() => onSave(keyJson)}>
          {busy ? "Verifying…" : "Verify & save"}
        </button>
        <button className="btn" disabled={busy} onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

// On-premise PI/PO (decision 0011). No credential is typed here: the PI user
// and password live in the BTP destination, the tunnel in the SAP Cloud
// Connector. The person gives the destination NAME; the shared backend checks
// it, because only the backend is bound to the destination service.
function ConnPipoForm({ agent, busy, onSave, onCancel }) {
  const current = (agent.connection && agent.connection.destinationName) || "";
  const [name, setName] = React.useState(current);
  const suggestion = `PO_TPM_${agent.systemId || agent.id}`;
  return (
    <div style={{ marginTop: 10, padding: 12, border: "1px solid var(--line)", borderRadius: 8 }} data-pipo-form={agent.id}>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>
        Connect {agent.name || agent.systemId || agent.id} (on-premise PI/PO)
      </div>
      <div style={{ fontSize: 12, color: "var(--ink-3)", marginBottom: 10 }}>
        Give the name of the BTP destination for this PI/PO system. You create that destination once in the BTP
        cockpit (Connectivity &gt; Destinations): <span className="kbd">ProxyType: OnPremise</span>, the PI user and
        password, and the property <span className="kbd">CloudConnectorLocationId</span> when more than one Cloud
        Connector is attached. The manager stores only the NAME - no secret. The shared backend then checks that the
        destination exists and reports its settings.
      </div>
      <input
        className="input is-mono"
        autoComplete="off"
        spellCheck={false}
        style={{ width: "100%" }}
        placeholder={suggestion}
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
        <button className="btn btn-primary" disabled={busy || !name.trim()} onClick={() => onSave(name)}>
          {busy ? "Checking…" : "Check & save"}
        </button>
        <button className="btn" disabled={busy} onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

function ConnAgentRow({ agent, busy, onConnect, onDisconnect }) {
  const [showForm, setShowForm] = React.useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = React.useState(false);
  const connected = agent.connected === true;
  // Two kinds of system (decision 0011): a cloud Integration Suite tenant is
  // connected with a service key, an on-premise PI/PO system with the name of
  // a BTP destination. `kind` comes from the agent's Figaf platform.
  const isPipo = agent.kind === "pipo";
  return (
    <div style={{ border: "1px solid var(--line)", borderRadius: 10, padding: 12, marginBottom: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <div style={{ fontWeight: 700 }}>{agent.name || agent.systemId || agent.id}</div>
        {agent.systemId && <span className="kbd">{agent.systemId}</span>}
        {agent.platform && <span className="pill gray">{agent.platform}</span>}
        <span className={`pill ${connected ? "blue" : "gray"}`}>
          {agent.connected === null ? "status unknown" : connected ? "Connected" : "Not connected"}
        </span>
        {busy && <span className="pill gray">working…</span>}
        <div className="spacer" style={{ flex: 1 }} />
        <div style={{ fontSize: 12, color: "var(--ink-3)" }}>
          {connected && agent.connection && (
            <>
              <span className="kbd">
                {isPipo ? agent.connection.destinationName : agent.connection.baseUrl}
              </span>
              {isPipo && agent.connection.locationId && <> · location {agent.connection.locationId}</>}
              {agent.connection.verifiedAt && <> · checked {new Date(agent.connection.verifiedAt).toLocaleString()}</>}
            </>
          )}
        </div>
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
        <button className="btn" disabled={busy} onClick={() => setShowForm((s) => !s)}>
          {connected ? (isPipo ? "Change destination" : "Replace key") : "Connect"}
        </button>
        {connected && !confirmDisconnect && (
          <button className="btn" disabled={busy} onClick={() => setConfirmDisconnect(true)}>Disconnect</button>
        )}
        {connected && confirmDisconnect && (
          <>
            <button className="btn" style={{ color: "var(--fg-red, #c0392b)" }} disabled={busy}
              onClick={() => { setConfirmDisconnect(false); onDisconnect(); }}>
              Confirm disconnect
            </button>
            <button className="btn" disabled={busy} onClick={() => setConfirmDisconnect(false)}>Keep</button>
          </>
        )}
      </div>
      {showForm && !isPipo && (
        <ConnSystemForm
          agent={agent}
          busy={busy}
          onCancel={() => setShowForm(false)}
          onSave={async (keyJson) => {
            const r = await onConnect(keyJson);
            if (r && r.ok) setShowForm(false);
          }}
        />
      )}
      {showForm && isPipo && (
        <ConnPipoForm
          agent={agent}
          busy={busy}
          onCancel={() => setShowForm(false)}
          onSave={async (destinationName) => {
            const r = await onConnect(destinationName);
            if (r && r.ok) setShowForm(false);
          }}
        />
      )}
    </div>
  );
}

function ScreenConnections({ ctx, onBack }) {
  const [figaf, setFigaf] = React.useState(null);        // connections:figafStatus result
  const [agents, setAgents] = React.useState(null);      // null = loading, {error} or {list}
  const [figafSystems, setFigafSystems] = React.useState(null); // l3:figafSystems (CF discovery)
  const [showFigafForm, setShowFigafForm] = React.useState(false);
  const [busy, setBusy] = React.useState(null);          // "figaf" | agentId | null
  const [lastError, setLastError] = React.useState(null);
  // A stored connection can still carry a real problem (decision 0011): a PI/PO
  // destination that exists but has the wrong ProxyType, no location id, or no
  // connectivity binding yet. It is saved AND said out loud.
  const [lastWarning, setLastWarning] = React.useState(null);
  // The PI/PO services are optional (decision 0011). Their state is only
  // interesting when this installation actually has a PI/PO system, so it is
  // read after the agent list, and only then.
  const [pipoServices, setPipoServices] = React.useState(null);

  const api = typeof window !== "undefined" ? window.figaf : null;

  const refresh = React.useCallback(async () => {
    if (!api || !api.connections) return;
    const st = await api.connections.figafStatus();
    setFigaf(st || { ok: false, error: "no response" });
    if (st && st.configured) {
      const r = await api.connections.listAgents();
      setAgents(r && r.ok ? { list: r.agents } : { error: (r && r.error) || "could not list agents" });
    } else {
      setAgents({ list: null });
    }
  }, [api]);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!api || !api.connections) { setFigaf({ ok: false, error: "connections surface unavailable" }); return; }
      await refresh();
      if (cancelled) return;
      if (api.l3 && api.l3.figafSystems) {
        const fs = await api.l3.figafSystems();
        if (!cancelled) setFigafSystems(fs && fs.ok ? fs.systems : []);
      }
    })();
    return () => { cancelled = true; };
  }, [api, refresh]);

  async function saveFigaf(values) {
    setBusy("figaf");
    setLastError(null);
    try {
      const r = await api.connections.saveFigaf(values);
      if (r && r.ok) { setShowFigafForm(false); await refresh(); }
      else setLastError((r && r.error) || "save failed");
      return r;
    } finally { setBusy(null); }
  }

  // One entry point for both kinds: a cloud tenant is saved with a service key,
  // an on-premise PI/PO system with a destination name (decision 0011).
  async function connectSystem(agent, input) {
    setBusy(agent.id);
    setLastError(null);
    setLastWarning(null);
    try {
      const common = { agentId: agent.id, agentSystemId: agent.systemId, agentName: agent.name };
      const r = agent.kind === "pipo"
        ? await api.connections.savePipoSystem({ ...common, destinationName: input })
        : await api.connections.saveSystem({ ...common, serviceKeyJson: input });
      if (r && r.ok) {
        if (r.warning) setLastWarning(`${agent.name || agent.id}: ${r.warning}`);
        await refresh();
      } else {
        const hint = r && r.hint ? ` — ${r.hint}` : "";
        setLastError(`${agent.name || agent.id}: ${(r && r.error) || "save failed"}${hint}`);
      }
      return r;
    } finally { setBusy(null); }
  }

  async function disconnectSystem(agent) {
    setBusy(agent.id);
    setLastError(null);
    try {
      const r = agent.kind === "pipo"
        ? await api.connections.deletePipoSystem({ agentId: agent.id })
        : await api.connections.deleteSystem({ agentId: agent.id });
      if (r && r.ok) await refresh();
      else setLastError(`${agent.name || agent.id}: ${(r && r.error) || "disconnect failed"}`);
    } finally { setBusy(null); }
  }

  const figafConfigured = figaf && figaf.configured;
  const agentList = (agents && agents.list) || [];
  const hasPipoAgent = agentList.some((a) => a.kind === "pipo");

  React.useEffect(() => {
    if (!hasPipoAgent || !api || !api.l3 || !api.l3.services) return;
    let cancelled = false;
    api.l3.services()
      .then((r) => {
        if (cancelled) return;
        const list = (r && r.ok && r.services) || [];
        setPipoServices(list.filter((s) => s.group === "pipo"));
      })
      .catch(() => { if (!cancelled) setPipoServices(null); });
    return () => { cancelled = true; };
  }, [hasPipoAgent]);

  const pipoMissing = (pipoServices || []).filter((s) => s.status !== "ready");

  return (
    <>
      <div className="pane-body">
        <div className="pane-head">
          <div className="pane-eyebrow">System connections</div>
          <h1 className="pane-title">Figaf tool &amp; SAP systems</h1>
          <p className="pane-desc">
            Connections are stored in the SAP Credential Store
            (namespace <span className="kbd">figaf-connections</span>) and read by the L3 apps at
            runtime. The manager is the only writer; every entry is verified against the real
            endpoint before it is stored.
          </p>
        </div>

        {lastError && (
          <div style={{ marginBottom: 12, padding: 10, border: "1px solid var(--fg-red, #c0392b)", borderRadius: 8, fontSize: 13 }}>
            {lastError}
          </div>
        )}

        {hasPipoAgent && pipoServices !== null && pipoMissing.length > 0 && (
          <div data-pipo-hint="" style={{ marginBottom: 12, padding: 10, border: "1px solid var(--line)", borderRadius: 8, fontSize: 13 }}>
            <strong>PI/PO systems need two more service instances.</strong> This installation lists an on-premise
            PI or PO system, but {pipoMissing.map((s) => s.name).join(" and ")} {pipoMissing.length > 1 ? "are" : "is"} not
            ready yet. Create {pipoMissing.length > 1 ? "them" : "it"} in <span className="kbd">Setup &gt; Base services</span>,
            then update the installation so the shared backend binds {pipoMissing.length > 1 ? "them" : "it"}. Without
            that the backend cannot reach a PI system through the SAP Cloud Connector.
            <a className="btn-link" style={{ marginLeft: 8 }} href="#/setup">Open Setup</a>
          </div>
        )}

        {lastWarning && (
          <div data-conn-warning="" style={{ marginBottom: 12, padding: 10, border: "1px solid var(--line)", borderRadius: 8, fontSize: 13 }}>
            <strong>Saved, with a warning.</strong> {lastWarning}
            <button className="btn-link" style={{ marginLeft: 8 }} onClick={() => setLastWarning(null)}>Dismiss</button>
          </div>
        )}

        {/* Level 1 — the Figaf tool */}
        <div style={{ border: "1px solid var(--line)", borderRadius: 10, padding: 14, marginBottom: 16 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <div style={{ fontWeight: 700 }}>Figaf tool</div>
            <span className={`pill ${figafConfigured ? "blue" : "gray"}`}>
              {figaf === null ? "…" : figafConfigured ? "Connected" : "Not connected"}
            </span>
            {busy === "figaf" && <span className="pill gray">working…</span>}
            <div className="spacer" style={{ flex: 1 }} />
            {figafConfigured && (
              <div style={{ fontSize: 12, color: "var(--ink-3)" }}>
                <span className="kbd">{figaf.baseUrl}</span>
                {" · "}client <span className="kbd">{figaf.clientId}</span>
                {figaf.agentCount != null && <> · {figaf.agentCount} agents</>}
              </div>
            )}
          </div>
          {figaf && figaf.bindingPresent === false && (
            <div style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 6 }}>
              The manager is not bound to a Credential Store instance — bind it first
              (same precondition as the stored management user).
            </div>
          )}
          {figaf && figaf.error && (
            <div style={{ fontSize: 12, color: "var(--fg-red, #c0392b)", marginTop: 6 }}>{figaf.error}</div>
          )}
          <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
            <button className="btn" disabled={busy === "figaf" || (figaf && figaf.bindingPresent === false)}
              onClick={() => setShowFigafForm((s) => !s)}>
              {figafConfigured ? "Replace connection" : "Connect"}
            </button>
          </div>
          {showFigafForm && (
            <ConnFigafForm
              status={figaf}
              figafSystems={figafSystems}
              busy={busy === "figaf"}
              onSave={saveFigaf}
              onCancel={() => setShowFigafForm(false)}
            />
          )}
        </div>

        {/* Level 2 — SAP systems (Figaf agents) */}
        <div style={{ fontWeight: 700, marginBottom: 8 }}>SAP Integration Suite systems</div>
        {!figafConfigured && (
          <div style={{ color: "var(--ink-3)", fontSize: 13 }}>
            Connect the Figaf tool first — the system list comes from its agent registry.
          </div>
        )}
        {figafConfigured && agents === null && <div style={{ color: "var(--ink-3)" }}>Loading agents…</div>}
        {figafConfigured && agents && agents.error && (
          <div style={{ color: "var(--fg-red, #c0392b)", fontSize: 13 }}>{agents.error}</div>
        )}
        {figafConfigured && agents && agents.list && agents.list.length === 0 && (
          <div style={{ color: "var(--ink-3)", fontSize: 13 }}>
            The Figaf tool reports no agents (connected systems). Add systems in the Figaf tool first.
          </div>
        )}
        {figafConfigured && agents && agents.list && agents.list.map((a) => (
          <ConnAgentRow
            key={a.id}
            agent={a}
            busy={busy === a.id}
            onConnect={(keyJson) => connectSystem(a, keyJson)}
            onDisconnect={() => disconnectSystem(a)}
          />
        ))}

        <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
          <button className="btn" onClick={refresh} disabled={!!busy}>Refresh</button>
        </div>
      </div>

      <div className="pane-foot">
        <div className="spacer" />
        {onBack && (
          <button className="btn" onClick={onBack} disabled={!!busy}>
            <Ico.ArrowLeft /> Back
          </button>
        )}
      </div>
    </>
  );
}

Object.assign(window, { ScreenConnections });
