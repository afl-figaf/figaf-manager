/* global React, Ico */

// ═══════════════════════════════════════════════════════════
// FAID Apps manager — catalog dashboard
// One row per catalog app: status, versions, and the actions
// Install / Update / Configure / Health / Disable / Enable / Remove.
// Every action streams its cf commands into the terminal drawer.
// ═══════════════════════════════════════════════════════════

const FAID_STATUS_META = {
  "not-installed": { label: "Not installed", cls: "gray" },
  "running":       { label: "Running",       cls: "blue" },
  // A fresh install pushes with --no-start, so Cloud Foundry keeps the app
  // STOPPED until staging and start are through. "Installing…" says that,
  // instead of inviting a second Install (live 2026-09-04).
  "installing":    { label: "Installing…",   cls: "blue" },
  "stopped":       { label: "Stopped",       cls: "gray" },
  "partial":       { label: "Partial",       cls: "gray" },
  "mixed":         { label: "Mixed",         cls: "gray" },
};

// What the pill says while an action runs. Same words for the page that
// started it and for a page that only learned about it from the server.
const FAID_BUSY_LABEL = {
  install: "installing…", update: "updating…", disable: "stopping…",
  enable: "starting…", remove: "removing…", configure: "configuring…",
  health: "health check…",
};

function FaidStatusPill({ status }) {
  const meta = FAID_STATUS_META[status] || { label: status || "…", cls: "gray" };
  return <span className={`pill ${meta.cls}`}>{meta.label}</span>;
}

// The outcome of the LAST failed action (model: packages/ui/action-outcome.js).
// It stays until the operator dismisses it or starts the next action — the
// status refresh that follows every action must never remove it (live
// 2026-09-03: the error flashed for under a second, then "no logs, nothing").
function FaidActionOutcome({ outcome, onDismiss, onOpenTerminal }) {
  const [copied, setCopied] = React.useState(false);
  React.useEffect(() => { setCopied(false); }, [outcome]);
  if (!outcome || outcome.ok) return null;
  async function copy() {
    const api = typeof window !== "undefined" ? window.figaf : null;
    try {
      if (api && api.shell && api.shell.writeClipboard) await api.shell.writeClipboard(outcome.report);
      else if (navigator.clipboard) await navigator.clipboard.writeText(outcome.report);
      setCopied(true);
    } catch {
      // The report is also readable on the page; nothing else to do.
    }
  }
  const when = (() => { try { return new Date(outcome.at).toLocaleTimeString(); } catch { return ""; } })();
  return (
    <div className="action-outcome is-error" data-outcome="error" role="alert">
      <div className="ao-head">
        <span className="pill red">Failed</span>
        <strong className="ao-title">{outcome.title}</strong>
        {when && <span className="ao-time">{when}</span>}
      </div>
      <dl className="ao-facts">
        {(outcome.facts || []).map((f) => (
          <React.Fragment key={f.label}>
            <dt>{f.label}</dt>
            <dd className={f.label === "Command" ? "is-mono" : ""}>{f.value}</dd>
          </React.Fragment>
        ))}
        {outcome.hint && (
          <>
            <dt>Next</dt>
            <dd className="ao-hint">{outcome.hint}</dd>
          </>
        )}
      </dl>
      <div className="ao-actions">
        {onOpenTerminal && (
          <button className="btn" onClick={onOpenTerminal}>Show CLI output</button>
        )}
        <button className="btn" onClick={copy} disabled={!outcome.report}>{copied ? "Copied" : "Copy report"}</button>
        <button className="btn" onClick={onDismiss}>Dismiss</button>
      </div>
    </div>
  );
}

function FaidConfigForm({ app, busy, figafSystems, onApply, onCancel }) {
  const [values, setValues] = React.useState({});
  const fields = app.configForm || [];
  return (
    <div style={{ marginTop: 10, padding: 12, border: "1px solid var(--line)", borderRadius: 8 }}>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>Configure {app.name}</div>
      <div style={{ fontSize: 12, color: "var(--ink-3)", marginBottom: 10 }}>
        Values are applied with <span className="kbd">cf set-env</span> and never shown in the
        terminal or logs. Leave a field empty to keep its current value. The app restarts after apply.
      </div>
      {fields.map((f) => (
        <div className="field" key={f.key}>
          <div className="field-label">{f.key}{f.secret ? " (secret)" : ""}</div>
          {f.type === "figaf-system" && (
            <select
              className="input"
              value=""
              disabled={busy}
              style={{ marginBottom: 6 }}
              onChange={(e) => {
                if (e.target.value) setValues((v) => ({ ...v, [f.key]: e.target.value }));
              }}
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
          )}
          <input
            className="input is-mono"
            type={f.secret ? "password" : "text"}
            autoComplete="off"
            value={values[f.key] || ""}
            placeholder={f.hint || (f.secret ? "unchanged" : "unchanged")}
            onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
          />
        </div>
      ))}
      <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
        <button className="btn btn-primary" disabled={busy} onClick={() => onApply(values)}>
          Apply &amp; restart
        </button>
        <button className="btn" disabled={busy} onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

// ─── Release panel (decision 0010) ──────────────────────────────────────────
// Where releases come from, what is installed, what the store offers, and the
// ONE action that changes the installation's version: Update installation.
// Install of an app never changes the version (it uses the installed one);
// the dropdown lists only versions Update may choose (installed or higher).
function FaidReleasePanel({ releases, busy, onRefresh, onUpdate }) {
  const [picked, setPicked] = React.useState("");
  const [confirm, setConfirm] = React.useState(false);
  const ok = !!(releases && releases.ok);
  const installed = ok ? releases.installed : null;
  // Only versions ABOVE the installed one are an update. The installed version
  // itself is also allowed by the server (equal = re-deploy everything), but
  // that is a repair, shown as a plain secondary action, never as "Update".
  const newer = (ok ? releases.versions : []).filter((v) => v.selectable && !v.installed);
  const target = newer.some((v) => v.version === picked) ? picked : (newer.length ? (releases.updateAvailable ? releases.latest : newer[0].version) : "");
  React.useEffect(() => { setConfirm(false); }, [target, releases]);
  const fmtWhen = (iso) => { try { return iso ? new Date(iso).toLocaleDateString() : ""; } catch { return ""; } };
  return (
    <div data-release-panel="" style={{ border: "1px solid var(--line)", borderRadius: 10, padding: 12, marginBottom: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <div style={{ fontWeight: 700 }}>Release</div>
        {releases && releases.ok && releases.updateAvailable && <span className="pill blue">update available: {releases.latest}</span>}
        {releases && releases.ok && !releases.updateAvailable && releases.installed && <span className="pill green">up to date</span>}
        <div className="spacer" style={{ flex: 1 }} />
        <div style={{ fontSize: 12, color: "var(--ink-3)" }}>
          installed: <span className="kbd" data-release-installed="">{(releases && releases.ok && releases.installed) || "—"}</span>
          {" · "}latest: <span className="kbd" data-release-latest="">{(releases && releases.ok && releases.latest) || "?"}</span>
        </div>
      </div>
      <div style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 6 }}>
        {!releases && "Reading the release store…"}
        {releases && !releases.ok && <><strong>The release store cannot be read.</strong> {releases.error}</>}
        {releases && releases.ok && (
          <>
            Source: <span className="kbd" data-release-source="">{releases.source ? releases.source.location : "?"}</span>
            {releases.source && releases.source.kind === "local" ? " (local directory, development)" : ""}.
            {" "}Versions in the store: {releases.versions.map((v) => (
              <span key={v.version} style={{ marginRight: 10 }} title={v.reason || (v.publishedAt ? `published ${fmtWhen(v.publishedAt)}` : "")}>
                <span className="kbd">{v.version}</span>{v.installed ? " (installed)" : ""}{v.latest ? " (latest)" : ""}
              </span>
            ))}
          </>
        )}
      </div>
      <div style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 6 }}>
        Install adds an app at the installed version. <strong>Update installation</strong> moves the shared backend and
        every installed app to the chosen release, backend first. Older versions cannot be chosen (rollback is not supported).
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap", alignItems: "center" }}>
        {ok && installed && newer.length > 0 && (
          <>
            <select className="input" data-release-target="" style={{ width: "auto" }} value={target} disabled={busy} onChange={(e) => setPicked(e.target.value)}>
              {newer.map((v) => (
                <option key={v.version} value={v.version}>{v.version}{v.latest ? " (latest)" : ""}</option>
              ))}
            </select>
            {!confirm && (
              <button className="btn btn-primary" disabled={busy || !target} onClick={() => setConfirm(true)}>
                Update installation to {target}
              </button>
            )}
            {confirm && (
              <>
                <button className="btn btn-primary" disabled={busy} onClick={() => { setConfirm(false); onUpdate(target); }}>
                  Confirm: update to {target}
                </button>
                <button className="btn" disabled={busy} onClick={() => setConfirm(false)}>Cancel</button>
              </>
            )}
          </>
        )}
        {ok && installed && newer.length === 0 && (
          <>
            <span data-release-uptodate="" style={{ fontSize: 12, color: "var(--ink-3)" }}>
              Up to date. Nothing newer than {installed} in the store.
            </span>
            {!confirm && (
              <button className="btn" disabled={busy} onClick={() => setConfirm(true)} title="Repair: push the shared backend and every installed app again from the installed release">
                Re-deploy everything at {installed}
              </button>
            )}
            {confirm && (
              <>
                <button className="btn" disabled={busy} onClick={() => { setConfirm(false); onUpdate(installed); }}>
                  Confirm: re-deploy everything at {installed}
                </button>
                <button className="btn" disabled={busy} onClick={() => setConfirm(false)}>Cancel</button>
              </>
            )}
          </>
        )}
        {ok && !installed && (
          <span style={{ fontSize: 12, color: "var(--ink-3)" }}>Nothing is installed yet. Install uses the latest release, {releases.latest}.</span>
        )}
        <button className="btn" disabled={busy} onClick={onRefresh}>Refresh releases</button>
      </div>
    </div>
  );
}

function FaidAppRow({ app, status, busy, busyLabel, figafSystems, onAction }) {
  const [showConfig, setShowConfig] = React.useState(false);
  const [confirmRemove, setConfirmRemove] = React.useState(false);
  const [health, setHealth] = React.useState(null);

  const st = status ? status.status : null;
  const installed = st && st !== "not-installed";
  // The app is not at the installation's version: a half-finished update, or
  // a frontend installed before a backend-only update. Re-deploy fixes it.
  const behind =
    installed && status.installedVersion && status.catalogVersion && status.installedVersion !== status.catalogVersion;
  // Every action is off while this app (or any other) is being deployed, and
  // also while Cloud Foundry is staging a build we did not start ourselves.
  const locked = busy || st === "installing";

  async function health_() {
    setHealth({ loading: true });
    const r = await onAction("health");
    setHealth(r || { ok: false, error: "no response" });
  }

  return (
    <div className="faid-app-row" data-app={app.id} style={{ border: "1px solid var(--line)", borderRadius: 10, padding: 14, marginBottom: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <div style={{ fontWeight: 700 }}>{app.name}</div>
        <FaidStatusPill status={st} />
        {busy && <span className="pill gray">{busyLabel || "working…"}</span>}
        <div className="spacer" style={{ flex: 1 }} />
        <div style={{ fontSize: 12, color: "var(--ink-3)" }}>
          installed: <span className="kbd">{(status && status.installedVersion) || "—"}</span>
          {" · "}release: <span className="kbd">{app.version}</span>
          {behind && <span className="pill blue" style={{ marginLeft: 6 }}>behind the installation</span>}
        </div>
      </div>

      {app.description && (
        <div style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 4 }}>{app.description}</div>
      )}

      <div style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 6 }}>
        {(status ? status.parts : app.cfApps.map((c) => ({ name: c.name }))).map((p) => (
          <span key={p.name} style={{ marginRight: 12 }}>
            <span className="kbd">{p.name}</span>
            {" "}{p.exists === false ? "absent" : (p.staging ? "staging" : (p.state || "").toLowerCase())}
            {p.route ? <> · <a href={"https://" + p.route} target="_blank" rel="noopener noreferrer">{p.route}</a></> : null}
          </span>
        ))}
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
        {!installed && (
          <button className="btn btn-primary" disabled={locked} onClick={() => onAction("install")}>
            Install {app.version}
          </button>
        )}
        {installed && (
          <button className="btn" disabled={locked} onClick={() => onAction("update")}>
            {behind ? `Re-deploy at ${app.version}` : "Re-deploy"}
          </button>
        )}
        {installed && (app.configForm || []).length > 0 && (
          <button className="btn" disabled={locked} onClick={() => setShowConfig((s) => !s)}>Configure</button>
        )}
        {installed && app.healthPath && (
          <button className="btn" disabled={locked} onClick={health_}>Health</button>
        )}
        {st === "running" && (
          <button className="btn" disabled={locked} onClick={() => onAction("disable")}>Disable</button>
        )}
        {st === "stopped" && (
          <button className="btn" disabled={locked} onClick={() => onAction("enable")}>Enable</button>
        )}
        {installed && !confirmRemove && (
          <button className="btn" disabled={locked} onClick={() => setConfirmRemove(true)}>Remove</button>
        )}
        {installed && confirmRemove && (
          <>
            <button
              className="btn"
              style={{ color: "var(--fg-red, #c0392b)" }}
              disabled={locked}
              onClick={() => { setConfirmRemove(false); onAction("remove"); }}
            >
              Confirm remove
            </button>
            <button className="btn" disabled={locked} onClick={() => setConfirmRemove(false)}>Keep</button>
          </>
        )}
      </div>

      {showConfig && (
        <FaidConfigForm
          app={app}
          figafSystems={figafSystems}
          busy={locked}
          onCancel={() => setShowConfig(false)}
          onApply={async (values) => {
            const r = await onAction("configure", { env: values });
            if (r && r.ok) setShowConfig(false);
          }}
        />
      )}

      {health && (
        <div style={{ marginTop: 10, fontSize: 12 }}>
          {health.loading ? (
            <span style={{ color: "var(--ink-3)" }}>Checking {app.healthPath} …</span>
          ) : (
            <>
              <div style={{ color: "var(--ink-3)", marginBottom: 4 }}>
                {health.url || app.healthPath} —{" "}
                {health.ok
                  ? "all connections ok"
                  : health.httpStatus
                    ? `HTTP ${health.httpStatus} — some connections are not ok (details below)`
                    : `error: ${health.error || "?"}`}
              </div>
              {health.body != null && (
                <pre style={{ margin: 0, padding: 10, background: "var(--terminal-bg, #111)", color: "var(--terminal-fg, #ddd)", borderRadius: 8, overflowX: "auto", maxHeight: 220 }}>
                  {typeof health.body === "string" ? health.body : JSON.stringify(health.body, null, 2)}
                </pre>
              )}
            </>
          )}
        </div>
      )}

      {(app.roleCollections || []).length > 0 && (
        <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 8 }}>
          Access roles (assign to users in the BTP cockpit): {app.roleCollections.join(", ")}
        </div>
      )}
    </div>
  );
}

// ─── Base services (catalog v3) ──────────────────────────────────────────────
// The service INSTANCES the platform needs, created by the manager when
// missing. PostgreSQL takes minutes: the terminal drawer shows the waiting.
const FAID_SERVICE_STATUS_META = {
  "ready":       { label: "Ready",         cls: "green" },
  "missing":     { label: "Missing",       cls: "gray" },
  "in-progress": { label: "Creating…",     cls: "blue" },
  "failed":      { label: "Failed",        cls: "gray" },
  "unknown":     { label: "Unknown state", cls: "gray" },
};

function BaseServicesCard({ services, busy, onProvision, onBind, onBindPlatform, onRestart, onRefresh }) {
  const api = typeof window !== "undefined" ? window.figaf : null;
  const [plans, setPlans] = React.useState({});
  const [bindingLive, setBindingLive] = React.useState(null); // login:storedUserStatus.bindingPresent
  const [confirmRestart, setConfirmRestart] = React.useState(false);
  // Token mode (before Setup step 1, Prepare the space): nothing on this card may restart
  // the manager - a restart would cost a second setup token (decision 0009).
  // Step 1 creates and binds the Credential Store itself.
  const ssoMode = typeof window !== "undefined" && window.figafXsuaaMode === true;

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const st = api && api.login && api.login.storedUserStatus ? await api.login.storedUserStatus() : null;
        if (!cancelled) setBindingLive(st ? !!st.bindingPresent : null);
      } catch { if (!cancelled) setBindingLive(null); }
    })();
    return () => { cancelled = true; };
  }, [services]);

  if (services === null) {
    return (
      <div style={{ border: "1px dashed var(--line)", borderRadius: 10, padding: 12, marginBottom: 14, color: "var(--ink-3)" }}>
        Checking base services…
      </div>
    );
  }
  if (!services || services.length === 0) return null; // v2 release: nothing declared

  // Catalog v4 (decision 0011): optional instances are a separate block. They
  // never count as "missing" - an installation without a PI/PO system is
  // complete - and "Create missing services" never touches them.
  const required = services.filter((s) => !s.optional);
  const optional = services.filter((s) => s.optional);
  const missing = required.filter((s) => s.status === "missing");
  const allReady = required.every((s) => s.status === "ready");
  const credstore = required.find((s) => s.bindToManager);

  return (
    <div style={{ border: "1px dashed var(--line)", borderRadius: 10, padding: 12, marginBottom: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <div style={{ fontWeight: 700 }}>Base services</div>
        {allReady ? <span className="pill green">all ready</span> : <span className="pill gray">{missing.length} missing</span>}
        <div className="spacer" style={{ flex: 1 }} />
        <button className="btn" onClick={onRefresh} disabled={busy}>Refresh</button>
        <button
          className="btn btn-primary"
          onClick={() => onProvision(plans, missing.map((s) => s.name))}
          disabled={busy || missing.length === 0}
          title={missing.length ? `cf create-service for: ${missing.map((s) => s.name).join(", ")}` : "nothing to create"}
        >
          {busy === "provision" ? "Creating… (PostgreSQL takes minutes)" : `Create missing services${missing.length ? ` (${missing.length})` : ""}`}
        </button>
      </div>
      <div style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 4 }}>
        Service instances this release needs in the space. Created by the manager with plain
        <span className="kbd">cf create-service</span>; plans that cost money are your choice.
        {!ssoMode && (
          <span data-token-mode-note=""> Before step 1 (Prepare the space) nothing here restarts the manager: that step creates the
          instances and binds them to the manager itself.</span>
        )}
      </div>
      {required.map((s) => {
        const meta = FAID_SERVICE_STATUS_META[s.status] || FAID_SERVICE_STATUS_META.unknown;
        return (
          <div key={s.name} style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 0", borderTop: "1px solid var(--line)", marginTop: 7, flexWrap: "wrap" }}>
            <span className="kbd">{s.name}</span>
            <span className={`pill ${meta.cls}`}>{meta.label}</span>
            <span style={{ fontSize: 12, color: "var(--ink-3)" }}>
              {s.offering} · {s.status === "missing" && s.plans.length > 1 ? "plan:" : `plan ${s.plan}`}
            </span>
            {s.status === "missing" && s.plans.length > 1 && (
              <select
                className="select"
                value={plans[s.name] || s.plan}
                disabled={!!busy}
                onChange={(e) => setPlans((p) => ({ ...p, [s.name]: e.target.value }))}
                style={{ width: "auto" }}
              >
                {s.plans.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            )}
            <span style={{ fontSize: 12, color: "var(--ink-3)" }}>{s.purpose}</span>
            <div className="spacer" style={{ flex: 1 }} />
            {s.bindToManager && s.status === "ready" && s.boundToManager === false && ssoMode && (
              <button className="btn" onClick={() => onBind(s.name)} disabled={!!busy}>
                {busy === "bind" ? "Binding…" : "Bind to manager"}
              </button>
            )}
            {s.bindToManager && s.status === "ready" && s.boundToManager === false && !ssoMode && (
              <span style={{ fontSize: 12, color: "var(--ink-3)" }} data-gated="bind">bound by step 1 (Prepare the space)</span>
            )}
            {s.bindToManager && s.status === "ready" && s.boundToManager === true && bindingLive === false && (
              <span style={{ fontSize: 12, color: "var(--ink-3)" }}>bound · restart needed</span>
            )}
            {s.bindToManager && s.status === "ready" && s.boundToManager === true && bindingLive === true && (
              <span className="pill green">bound to manager</span>
            )}
          </div>
        );
      })}
      {optional.length > 0 && (
        <div style={{ marginTop: 12, paddingTop: 10, borderTop: "1px solid var(--line)" }} data-optional-services="">
          <div style={{ fontWeight: 600, fontSize: 13 }}>Optional: on-premise PI/PO systems</div>
          <div style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 2 }}>
            SAP PI and PO systems are reached through the SAP Cloud Connector. These two free instances make that
            possible, and they are SHARED with the Figaf tool: an instance that already exists is reused, never
            replaced. The shared backend binds them when it is installed, so on a fresh install there is nothing
            to do here. Only an instance created AFTER the backend was installed needs
            <strong>Bind to backend &amp; restart backend</strong>: a binding reaches an app only after a restart,
            so the button does both (about 30-60 s of downtime for the FAID Apps; the manager itself is not restarted).
          </div>
          {optional.map((s) => {
            const meta = FAID_SERVICE_STATUS_META[s.status] || FAID_SERVICE_STATUS_META.unknown;
            return (
              <div key={s.name} style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 0", borderTop: "1px solid var(--line)", marginTop: 7, flexWrap: "wrap" }} data-optional-service={s.name}>
                <span className="kbd">{s.name}</span>
                <span className={`pill ${meta.cls}`}>{meta.label}</span>
                <span style={{ fontSize: 12, color: "var(--ink-3)" }}>{s.offering} - plan {s.plan}</span>
                <span style={{ fontSize: 12, color: "var(--ink-3)" }}>{s.purpose}</span>
                {s.sharedWith === "figaf-tool" && <span className="pill gray">shared with the Figaf tool</span>}
                <div className="spacer" style={{ flex: 1 }} />
                {s.status === "missing" && (
                  <button
                    className="btn"
                    disabled={!!busy}
                    title={`cf create-service ${s.offering} ${s.plan} ${s.name}`}
                    onClick={() => onProvision(plans, [s.name])}
                  >
                    {busy === "provision" ? "Creating…" : "Create"}
                  </button>
                )}
                {s.status === "ready" && s.backendDeployed === false && (
                  <span style={{ fontSize: 12, color: "var(--ink-3)" }} data-gated="bind-platform">bound automatically when the platform is installed</span>
                )}
                {s.status === "ready" && s.backendDeployed === true && s.boundToBackend === true && (
                  <span className="pill green">bound to backend</span>
                )}
                {s.status === "ready" && s.backendDeployed === true && s.boundToBackend !== true && onBindPlatform && (
                  <button
                    className="btn"
                    disabled={!!busy}
                    title={`cf bind-service <shared backend> ${s.name}, then cf restart <shared backend>`}
                    onClick={() => onBindPlatform(s.name)}
                  >
                    {busy === "bind-platform" ? "Binding…" : "Bind to backend & restart backend"}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
      {credstore && credstore.boundToManager === true && bindingLive === false && !ssoMode && (
        <div style={{ marginTop: 10, padding: 10, border: "1px solid var(--line)", borderRadius: 8, fontSize: 13 }} data-gated="restart">
          <strong>Binding not active yet.</strong> It becomes active with the restart at the end of step 1
          (Prepare the space). No separate restart here: in token mode a restart would cost a new setup token.
        </div>
      )}
      {credstore && credstore.boundToManager === true && bindingLive === false && ssoMode && (
        <div style={{ marginTop: 10, padding: 10, border: "1px solid var(--line)", borderRadius: 8, fontSize: 13 }}>
          <strong>Restart needed.</strong> The Credential Store is bound to the manager, but a binding only
          becomes active after a restart. The restart ends this session; reload the page in about 30
          seconds and sign in again with SAP IAS.
          {!confirmRestart ? (
            <div style={{ marginTop: 8 }}>
              <button className="btn" onClick={() => setConfirmRestart(true)} disabled={!!busy}>Restart manager…</button>
            </div>
          ) : (
            <div style={{ marginTop: 8, display: "flex", gap: 8 }}>
              <button className="btn btn-primary" onClick={onRestart} disabled={!!busy}>Yes, restart now</button>
              <button className="btn" onClick={() => setConfirmRestart(false)} disabled={!!busy}>Cancel</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// One line on the dashboard: the state of the base services, and the way to
// the Setup (step 3) when something is not ready. The full panel (create,
// bind, restart) lives on the Setup page.
function BaseServicesSummary({ services, onOpenSetup }) {
  if (services === null) {
    return <div data-services-summary="" style={{ fontSize: 12, color: "var(--ink-3)", marginBottom: 14 }}>Checking base services…</div>;
  }
  if (!services || services.length === 0) return null;
  // Optional instances (PI/PO) are not part of "ready": see BaseServicesCard.
  const required = services.filter((s) => !s.optional);
  const notReady = required.filter((s) => s.status !== "ready");
  return (
    <div data-services-summary="" style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", fontSize: 12, color: "var(--ink-3)", marginBottom: 14 }}>
      <span style={{ fontWeight: 600, color: "var(--ink-2)" }}>Base services</span>
      {notReady.length === 0
        ? <span className="pill green">all ready</span>
        : <span className="pill gray">{notReady.length} not ready</span>}
      <span>{required.map((s) => `${s.name}: ${s.status}`).join(" · ")}</span>
      {notReady.length > 0 && onOpenSetup && (
        <button className="btn-link" onClick={onOpenSetup}>Repair in Setup (step 3)</button>
      )}
    </div>
  );
}

// onStatus (optional): receives every fresh faid:status result, so a host frame
// (the console's Setup model) can follow install/remove without polling.
// onServices (optional): the same for faid:services results.
// onOpenSetup (optional): opens the Setup page (repair of the base services).
// onOpenTerminal (optional): opens the terminal drawer (the console frame
// passes it so the outcome panel can offer "Show CLI output").
function ScreenFaidApps({ ctx, setCtx, onBack, onConnections, onOpenSetup, onStatus, onServices, onOpenTerminal }) {
  const [catalog, setCatalog] = React.useState(null);   // { releaseVersion, platform, apps } | { error }
  const [statuses, setStatuses] = React.useState({});   // appId → status row
  const [platformStatus, setPlatformStatus] = React.useState(null); // catalog-v2 platform row
  // The release store (decision 0010): faid:releases result, or { ok:false, error }.
  const [releases, setReleases] = React.useState(null);
  const [refreshing, setRefreshing] = React.useState(false);
  const [busyApp, setBusyApp] = React.useState(null);   // appId currently running an action
  const [busyLabel, setBusyLabel] = React.useState("");
  // The action the MANAGER says is running: { action, appId, startedAt } or
  // null. It comes with every faid:status and on the faid:running event, so a
  // page that just reloaded (or a second tab) also shows "installing…" and
  // keeps its buttons off. Without it, the operator sees a stopped app and
  // clicks Install again — the second push then replaces the package Cloud
  // Foundry is staging and both attempts fail (live 2026-09-04).
  const [running, setRunning] = React.useState(null);
  // The outcome of the LAST action (action-outcome.js model). Set when an
  // action fails; cleared ONLY by Dismiss or by the start of the next action.
  // Never cleared by the status refresh (see FaidActionOutcome).
  const [outcome, setOutcome] = React.useState(null);
  const failed = React.useCallback((action, target, r) => {
    const build = (typeof window !== "undefined" && window.figafActionOutcome) || null;
    const input = {
      action,
      appName: target,
      result: r || { ok: false, error: "no response from the manager" },
      managerVersion: typeof window !== "undefined" ? window.figafVersion : null,
      releaseVersion: catalog && catalog.releaseVersion,
      org: ctx.login.org,
      space: ctx.login.space,
      at: new Date().toISOString(),
    };
    setOutcome(build ? build(input) : {
      ok: false,
      title: `${action}${target ? " of " + target : ""} failed`,
      facts: [{ label: "Error", value: (r && r.error) || "unknown error" }],
      hint: "Open the terminal drawer: the last red lines are the Cloud Foundry error.",
      report: JSON.stringify(input, null, 2),
      at: input.at,
    });
  }, [catalog, ctx.login.org, ctx.login.space]);
  // Discovered Figaf Tool deployments for "figaf-system" config fields.
  // null = not loaded yet; [] = looked and found none (manual entry stays).
  const [figafSystems, setFigafSystems] = React.useState(null);
  // Catalog v3 base services: null = not loaded, [] = release declares none.
  // Shown as a one-line summary here; created and repaired on the Setup page.
  const [services, setServices] = React.useState(null);

  const api = typeof window !== "undefined" ? window.figaf : null;

  const refreshServices = React.useCallback(async () => {
    if (!api || !api.faid || !api.faid.services) { setServices([]); return; }
    try {
      const s = await api.faid.services();
      const list = s && s.ok ? s.services : [];
      setServices(list);
      if (onServices) onServices(s);
    } catch {
      setServices([]);
    }
  }, [api, onServices]);

  const refreshReleases = React.useCallback(async (opts) => {
    if (!api || !api.faid || !api.faid.releases) { setReleases({ ok: false, error: "release surface unavailable" }); return; }
    try {
      const r = await api.faid.releases(opts || {});
      setReleases(r || { ok: false, error: "no response from the manager" });
    } catch (e) {
      setReleases({ ok: false, error: (e && e.message) || "release store read failed" });
    }
  }, [api]);

  const refresh = React.useCallback(async () => {
    if (!api || !api.faid) return;
    setRefreshing(true);
    try {
      const s = await api.faid.status();
      if (s && s.ok) {
        const map = {};
        for (const row of s.apps) map[row.id] = row;
        setStatuses(map);
        setPlatformStatus(s.platform || null);
        setRunning(s.running || null);
        if (onStatus) onStatus(s);
      } else if (s && s.error) {
        failed("status", null, s);
      }
    } finally {
      setRefreshing(false);
    }
  }, [api, onStatus]);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!api || !api.faid) { setCatalog({ error: "platform surface unavailable" }); return; }
      const c = await api.faid.catalog();
      if (cancelled) return;
      setCatalog(c && c.ok ? c : { error: (c && c.error) || "catalog load failed" });
      if (c && !c.ok) setReleases({ ok: false, error: c.error || "catalog load failed", source: c.source || null });
      if (c && c.ok) {
        refresh();
        refreshServices();
        refreshReleases();
        // Discover Figaf Tool deployments only when some app's form wants one.
        const wantsFigaf = c.apps.some((a) => (a.configForm || []).some((f) => f.type === "figaf-system"));
        if (wantsFigaf && api.faid.figafSystems) {
          const fs = await api.faid.figafSystems();
          if (!cancelled) setFigafSystems(fs && fs.ok ? fs.systems : []);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [api, refresh, refreshServices, refreshReleases]);

  // The manager announces every start and end of a lifecycle action. The
  // event reaches every page of this session, including one that reloaded
  // while an install was running.
  React.useEffect(() => {
    if (!api || !api.on) return undefined;
    const off = api.on("faid:running", (p) => {
      const next = p && p.action ? p : null;
      setRunning(next);
      if (!next) refresh();   // it just finished — show the new state
    });
    return off;
  }, [api, refresh]);

  // While an action runs, nothing else would move this page: a fresh install
  // leaves the app STOPPED for minutes. Poll the status until it is over.
  const runningKey = running ? `${running.action}:${running.appId}:${running.startedAt}` : "";
  React.useEffect(() => {
    if (!runningKey) return undefined;
    const t = setInterval(() => { refresh(); }, 10000);
    return () => clearInterval(t);
  }, [runningKey, refresh]);

  async function doAction(app, action, extra) {
    if (!api || !api.faid || busyApp) return { ok: false, error: "busy" };
    // One action at a time, also across pages: the row's buttons are off
    // while the manager reports a running action, and this is the guard for
    // any other caller. A health check is included on purpose — its answer
    // would be about an app that is being replaced.
    if (running) return { ok: false, error: "busy" };
    setBusyApp(app.id);
    setBusyLabel(FAID_BUSY_LABEL[action] || "working…");
    setOutcome(null);
    try {
      const r = await api.faid[action]({ appId: app.id, ...(extra || {}) });
      // Health answers non-2xx WITH a diagnostic body and no `error` — that
      // is a result, not a failed action; only a real error opens the panel.
      if (r && !r.ok && r.error) failed(action, app.name, r);
      return r;
    } catch (e) {
      const r = { ok: false, error: (e && e.message) || "action failed" };
      failed(action, app.name, r);
      return r;
    } finally {
      setBusyApp(null);
      setBusyLabel("");
      if (action !== "health") { refresh(); refreshReleases(); }
    }
  }

  // Update installation (decision 0010): the shared backend, then every
  // installed frontend, to `version`. Locked server-side as "platform"; the
  // rows read that from `running` and keep their buttons off.
  async function doInstallationUpdate(version) {
    if (!api || !api.faid || busyApp || running) return { ok: false, error: "busy" };
    setBusyApp("platform");
    setBusyLabel("updating…");
    setOutcome(null);
    try {
      const r = await api.faid.update({ version });
      if (r && !r.ok && r.error) failed("update", `installation to ${version}`, r);
      return r;
    } catch (e) {
      const r = { ok: false, error: (e && e.message) || "update failed" };
      failed("update", `installation to ${version}`, r);
      return r;
    } finally {
      setBusyApp(null);
      setBusyLabel("");
      refresh();
      refreshReleases();
    }
  }

  return (
    <>
      <div className="pane-body">
        <div className="pane-head">
          <div className="pane-eyebrow">Manage FAID Apps</div>
          <h1 className="pane-title">FAID Apps</h1>
          <p className="pane-desc">
            Installed into <span className="kbd">{ctx.login.org || "?"} / {ctx.login.space || "?"}</span>.
            Apps install from the release store
            {catalog && catalog.releaseVersion ? <>, release <span className="kbd">{catalog.releaseVersion}</span></> : null}.
            Every action runs plain <span className="kbd">cf</span> commands; every download is listed too — open the terminal drawer to follow along.
            A failed action stays on this page, with what Cloud Foundry said, until you dismiss it.
          </p>
        </div>

        <FaidActionOutcome outcome={outcome} onDismiss={() => setOutcome(null)} onOpenTerminal={onOpenTerminal} />

        {!catalog && <div style={{ color: "var(--ink-3)" }}>Loading catalog…</div>}
        {catalog && catalog.error && (
          <div style={{ color: "var(--ink-3)" }}>
            <strong>No app catalog available.</strong> {catalog.error}
          </div>
        )}

        {catalog && !catalog.error && (
          <BaseServicesSummary services={services} onOpenSetup={onOpenSetup} />
        )}

        {catalog && !catalog.error && (
          <FaidReleasePanel
            releases={releases}
            busy={!!busyApp || !!running}
            onRefresh={() => refreshReleases({ refresh: true })}
            onUpdate={doInstallationUpdate}
          />
        )}

        {catalog && catalog.platform && (
          <div data-platform-row="" style={{ border: "1px dashed var(--line)", borderRadius: 10, padding: 12, marginBottom: 14 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <div style={{ fontWeight: 700 }}>{catalog.platform.name || "Shared backend"}</div>
              <FaidStatusPill status={platformStatus ? platformStatus.status : null} />
              {running && (running.action === "install" || running.action === "update") && (
                <span className="pill gray">{FAID_BUSY_LABEL[running.action]}</span>
              )}
              <div className="spacer" style={{ flex: 1 }} />
              <div style={{ fontSize: 12, color: "var(--ink-3)" }}>
                installed: <span className="kbd">{(platformStatus && platformStatus.installedVersion) || "—"}</span>
                {" · "}release: <span className="kbd">{catalog.releaseVersion || "?"}</span>
              </div>
            </div>
            <div style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 6 }}>
              The shared backend connector, used by every app. It is deployed with the first
              app and moved to a newer release by Update installation, always BEFORE the app
              frontends — no separate action needed.
              {" "}
              {(platformStatus ? platformStatus.parts : catalog.platform.cfApps).map((p) => (
                <span key={p.name} style={{ marginRight: 12 }}>
                  <span className="kbd">{p.name}</span>
                  {" "}{p.exists === false ? "absent" : (p.staging ? "staging" : ((p.state || "").toLowerCase() || ""))}
                </span>
              ))}
            </div>
          </div>
        )}

        {catalog && catalog.apps && catalog.apps.map((app) => {
          // One lifecycle action at a time in the whole manager: every deploy
          // touches the shared backend, so a run on ANY app blocks this row.
          const mine = busyApp === app.id || (running && running.appId === app.id);
          const label = mine
            ? (busyLabel || FAID_BUSY_LABEL[running && running.action] || "working…")
            : (running
              ? `waiting — ${FAID_BUSY_LABEL[running.action] || "an action"} ${running.appId === "platform" ? "the installation" : running.appId}`
              : (busyApp ? "waiting — updating the installation" : ""));
          return (
            <FaidAppRow
              key={app.id}
              app={app}
              status={statuses[app.id]}
              busy={!!busyApp || !!running}
              busyLabel={label}
              figafSystems={figafSystems}
              onAction={(action, extra) => doAction(app, action, extra)}
            />
          );
        })}

        <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
          <button className="btn" onClick={refresh} disabled={refreshing || !!busyApp}>
            {refreshing ? "Refreshing…" : "Refresh status"}
          </button>
        </div>
      </div>

      <div className="pane-foot">
        <div className="spacer" />
        {onConnections && (
          <button className="btn" onClick={onConnections} disabled={!!busyApp}>
            Connections
          </button>
        )}
        {onBack && (
          <button className="btn" onClick={onBack} disabled={!!busyApp}>
            <Ico.ArrowLeft /> Back
          </button>
        )}
      </div>
    </>
  );
}

// BaseServicesCard and FaidActionOutcome are reused by the Setup page
// (screen-setup-page.jsx, step 3).
Object.assign(window, { ScreenFaidApps, BaseServicesCard, FaidActionOutcome });
