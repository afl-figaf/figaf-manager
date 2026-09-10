/* global React, Ico */

// ═══════════════════════════════════════════════════════════
// FAID Apps manager — catalog dashboard
// One CARD per catalog app (icon, status, title, description, version, the
// actions Install / Re-deploy / Configure / Health / Disable / Enable /
// Remove, a folded Details block), in sections: Installed, Not installed,
// New in the next release. Several installed apps can be stopped or started
// in one go: tick them, then "Disable selected" / "Enable selected".
// The grouping and the selection rules live in faid-cards.js (pure, tested).
// Every action streams its cf commands into the terminal drawer.
// ═══════════════════════════════════════════════════════════

const FAID_STATUS_META = {
  "not-installed": { label: "Not installed", cls: "gray" },
  "running":       { label: "Running",       cls: "green" },
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
function FaidReleasePanel({ releases, busy, pendingApps, onRefresh, onUpdate }) {
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
        Install adds an app at the installed version.
        {ok && installed && newer.length > 0 && (
          <> <strong>Update installation</strong> moves the shared backend and every installed app to the chosen
          release. Older versions cannot be chosen.</>
        )}
        {(pendingApps || []).length > 0 && (
          <span data-pending-summary="">
            {" "}New in <span className="kbd">{pendingApps[0].version}</span>, available after the update: <strong>{pendingApps.map((a) => a.name).join(", ")}</strong>.
          </span>
        )}
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

// One app. `selectable` = the app can be stopped or started now, so it gets
// the checkbox of the bulk actions; `selected` / `onSelect` are the page's.
function FaidAppCard({ app, status, busy, busyLabel, figafSystems, cockpit, selectable, selected, onSelect, onAction }) {
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

  // The CF apps of this card (live parts when the status is known, else the
  // catalog names) and the first route: the link a person actually uses.
  const parts = status ? status.parts : app.cfApps.map((c) => ({ name: c.name }));
  const route = installed ? (parts.find((p) => p.route) || {}).route : null;
  const initials = typeof window !== "undefined" && window.figafFaidInitials ? window.figafFaidInitials(app.name) : "";

  return (
    <div className={`faid-card${selected ? " is-selected" : ""}`} data-app={app.id} data-status={st || "unknown"}>
      <div className="faid-card-top">
        {selectable && (
          <label className="faid-card-pick" title="Select this app for Disable selected / Enable selected">
            <input
              type="checkbox"
              checked={!!selected}
              aria-label={`Select ${app.name}`}
              onChange={(e) => onSelect(e.target.checked)}
            />
          </label>
        )}
        <div className={`faid-card-icon is-${st || "unknown"}`} aria-hidden="true">{initials}</div>
        <div className="spacer" style={{ flex: 1 }} />
        <FaidStatusPill status={st} />
        {busy && <span className="pill gray">{busyLabel || "working…"}</span>}
      </div>

      <div className="faid-card-body">
        <div className="faid-card-title">{app.name}</div>
        {app.description && <div className="faid-card-desc">{app.description}</div>}
        <div className="faid-card-meta">
          {installed && status.installedVersion && (
            <span data-installed-version="">
              installed: <span className="kbd">{status.installedVersion}</span>
            </span>
          )}
          {behind && (
            <span className="pill blue" title={`The installation runs ${app.version}; this app still runs ${status.installedVersion}. Re-deploy moves it.`}>
              behind the installation ({app.version})
            </span>
          )}
        </div>
      </div>

      <div className="faid-card-actions">
        {!installed && (
          <button className="btn btn-primary" disabled={locked} onClick={() => onAction("install")}>
            Install {app.version}
          </button>
        )}
        {route && (
          <a className="btn btn-primary" href={"https://" + route} target="_blank" rel="noopener noreferrer" data-open-app="">
            Open app ↗
          </a>
        )}
        {installed && (
          <button className="btn" disabled={locked} onClick={() => onAction("update")} title="Push this app again from the installed release">
            {behind ? `Re-deploy at ${app.version}` : "Re-deploy"}
          </button>
        )}
        {installed && (app.configForm || []).length > 0 && (
          <button className="btn" disabled={locked} onClick={() => setShowConfig((v) => !v)}>Configure</button>
        )}
        {installed && app.healthPath && (
          <button className="btn" disabled={locked} onClick={health_}>Health</button>
        )}
        {st === "running" && (
          <button className="btn" disabled={locked} onClick={() => onAction("disable")} title="cf stop of this app's CF apps">Disable</button>
        )}
        {st === "stopped" && (
          <button className="btn" disabled={locked} onClick={() => onAction("enable")} title="cf start of this app's CF apps">Enable</button>
        )}
        {installed && !confirmRemove && (
          <button className="btn btn-danger faid-card-remove" disabled={locked} onClick={() => setConfirmRemove(true)}>Remove</button>
        )}
        {installed && confirmRemove && (
          <div className="faid-card-confirm">
            <span>Delete the Cloud Foundry apps of {app.name}?</span>
            <button
              className="btn btn-danger"
              disabled={locked}
              onClick={() => { setConfirmRemove(false); onAction("remove"); }}
            >
              Confirm remove
            </button>
            <button className="btn" disabled={locked} onClick={() => setConfirmRemove(false)}>Keep</button>
          </div>
        )}
      </div>

      <div className="faid-card-extra">
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

        <FaidRowDetails app={app} parts={parts} cockpit={cockpit} />
      </div>
    </div>
  );
}

// An app that only a NEWER release has (one version per installation,
// decision 0010): no Install button; the way there is Update installation.
function FaidPendingCard({ app, release }) {
  const initials = typeof window !== "undefined" && window.figafFaidInitials ? window.figafFaidInitials(app.name) : "";
  return (
    <div className="faid-card is-pending" data-app={app.id} data-pending="1">
      <div className="faid-card-top">
        <div className="faid-card-icon is-pending" aria-hidden="true">{initials}</div>
        <div className="spacer" style={{ flex: 1 }} />
        <span className="pill blue" title={`Not in ${release}, the release this installation runs. Update the installation (Release panel) to get it.`}>
          new in {app.version} · after the update
        </span>
      </div>
      <div className="faid-card-body">
        <div className="faid-card-title">{app.name}</div>
        {app.description && <div className="faid-card-desc">{app.description}</div>}
        <div className="faid-card-meta">Install becomes possible after Update installation to {app.version}.</div>
      </div>
      <div className="faid-card-actions" />
    </div>
  );
}

// The technical part of a row, folded by default: the CF apps with their
// state, and the role collections a BTP administrator assigns to users.
// "Copy names" puts the role names on the clipboard. The cockpit link is the
// space page of the existing cf:cockpitUrl (no new URL); it is fetched once
// per page, and only when a person opens a Details block.
function FaidRowDetails({ app, parts, cockpit }) {
  const [copied, setCopied] = React.useState(false);
  const roles = app.roleCollections || [];
  const api = typeof window !== "undefined" ? window.figaf : null;
  async function copyRoles() {
    const text = roles.join(", ");
    try {
      if (api && api.shell && api.shell.writeClipboard) await api.shell.writeClipboard(text);
      else if (navigator.clipboard) await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  }
  return (
    <details style={{ marginTop: 10, fontSize: 12, color: "var(--ink-3)" }} data-row-details=""
      onToggle={(e) => { if (e.target.open && cockpit && cockpit.load) cockpit.load(); }}>
      <summary style={{ cursor: "pointer", userSelect: "none" }}>Details</summary>
      <div style={{ marginTop: 6 }}>
        Cloud Foundry apps:{" "}
        {parts.map((p) => (
          <span key={p.name} style={{ marginRight: 12 }}>
            <span className="kbd">{p.name}</span>
            {" "}{p.exists === false ? "absent" : (p.staging ? "staging" : (p.state || "").toLowerCase())}
            {p.route ? <> · <a href={"https://" + p.route} target="_blank" rel="noopener noreferrer">{p.route}</a></> : null}
          </span>
        ))}
      </div>
      {roles.length > 0 && (
        <div style={{ marginTop: 6, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }} data-access-roles="">
          <span>Access roles, assigned to users in the BTP cockpit (Security → Role Collections):</span>
          {roles.map((r) => <span key={r} className="kbd">{r}</span>)}
          <button className="btn-link" onClick={copyRoles} style={{ fontSize: 12 }}>{copied ? "Copied" : "Copy names"}</button>
          {cockpit && cockpit.url && (
            <a href={cockpit.url} target="_blank" rel="noopener noreferrer" style={{ fontSize: 12 }}>Open BTP cockpit ↗</a>
          )}
        </div>
      )}
    </details>
  );
}

// ─── Base services (the manager's own list, packages/core/base-services.js) ──
// The service INSTANCES the platform needs, created by the manager when
// missing. PostgreSQL takes minutes: the terminal drawer shows the waiting.
const FAID_SERVICE_STATUS_META = {
  "ready":       { label: "Ready",         cls: "green" },
  "missing":     { label: "Missing",       cls: "gray" },
  "in-progress": { label: "Creating…",     cls: "blue" },
  "failed":      { label: "Failed",        cls: "gray" },
  "unknown":     { label: "Unknown state", cls: "gray" },
};

// The state of the backend's database access (catalog v6, faid-database.js).
const FAID_DB_ACCESS_META = {
  "prepared":     { label: "access prepared",     cls: "green" },
  "not-prepared": { label: "access not prepared", cls: "gray" },
  "stale":        { label: "access entry stale",  cls: "gray" },
  "unknown":      { label: "access unknown",      cls: "gray" },
};

function BaseServicesCard({ services, busy, onProvision, onBind, onBindPlatform, onRestart, onRefresh, onDatabasePrepare, onDatabaseRotate, onDatabaseDrop }) {
  const api = typeof window !== "undefined" ? window.figaf : null;
  const [plans, setPlans] = React.useState({});
  // The instance name for "Prepare database access" while nothing is prepared
  // yet (catalog v6): prefilled with what faid:services found, editable.
  const [dbName, setDbName] = React.useState(null);
  const [confirmDrop, setConfirmDrop] = React.useState(false);
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
  if (!services || services.length === 0) return null; // the release requires no instance

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
        Service instances the Figaf Platform needs in the space. Created by the manager with plain
        <span className="kbd">cf create-service</span>; plans that cost money are your choice.
        {!ssoMode && (
          <span data-token-mode-note=""> Before step 1 (Prepare the space) nothing here restarts the manager: that step creates the
          instances and binds them to the manager itself.</span>
        )}
      </div>
      {required.map((s) => {
        const meta = FAID_SERVICE_STATUS_META[s.status] || FAID_SERVICE_STATUS_META.unknown;
        const own = s.access === "own-role";
        const access = own ? (s.databaseAccess || { state: "unknown", prepared: false }) : null;
        const accessMeta = own ? (FAID_DB_ACCESS_META[access.state] || FAID_DB_ACCESS_META.unknown) : null;
        const instanceName = s.instanceName || s.name;
        const typedName = dbName != null ? dbName : instanceName;
        const canEditName = own && !!s.nameEditable && !access.prepared;
        return (
          <div key={s.name} style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 0", borderTop: "1px solid var(--line)", marginTop: 7, flexWrap: "wrap" }} data-service-row={s.name} data-database-access={own ? access.state : undefined}>
            {canEditName ? (
              <input className="input is-mono" data-instance-name={s.name} value={typedName} disabled={!!busy} spellCheck={false} style={{ width: 200 }}
                title="The PostgreSQL instance the FAID backend uses (default figaf-db)" onChange={(e) => setDbName(e.target.value)} />
            ) : (
              <span className="kbd">{instanceName}</span>
            )}
            <span className={`pill ${meta.cls}`}>{meta.label}</span>
            {own && <span className={`pill ${accessMeta.cls}`} data-access-pill="">{accessMeta.label}</span>}
            <span style={{ fontSize: 12, color: "var(--ink-3)" }}>
              {s.offering} · {s.status === "missing" && s.plans.length > 1 ? "plan:" : `plan ${s.actualPlan || s.plan}`}
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
            {own && s.status === "ready" && !access.prepared && ssoMode && onDatabasePrepare && (
              <button className="btn btn-primary" data-action="database-prepare" disabled={!!busy}
                title={`cf create-service-key ${typedName} <temporary>, SQL as the owner, verification as faid_app, Credential Store entry, cf delete-service-key`}
                onClick={() => onDatabasePrepare(String(typedName || "").trim())}>
                {busy === "database-prepare" ? "Preparing…" : "Prepare database access"}
              </button>
            )}
            {own && s.status === "ready" && !access.prepared && !ssoMode && (
              <span style={{ fontSize: 12, color: "var(--ink-3)" }} data-gated="database-prepare">access prepared after step 1 (needs the Credential Store binding)</span>
            )}
            {own && access.prepared && ssoMode && onDatabasePrepare && (
              <button className="btn" data-action="database-prepare-again" disabled={!!busy} title="Runs the same SQL again (idempotent); the password is kept"
                onClick={() => onDatabasePrepare(instanceName)}>{busy === "database-prepare" ? "Preparing…" : "Prepare again"}</button>
            )}
            {own && access.prepared && ssoMode && onDatabaseRotate && (
              <button className="btn" data-action="database-rotate" disabled={!!busy} title="New password for faid_app; the entry is updated; the shared backend is restarted when deployed"
                onClick={onDatabaseRotate}>{busy === "database-rotate" ? "Rotating…" : "Rotate password"}</button>
            )}
            {own && access.prepared && ssoMode && onDatabaseDrop && !confirmDrop && (
              <button className="btn" data-action="database-drop" disabled={!!busy} onClick={() => setConfirmDrop(true)}>Drop the FAID schema…</button>
            )}
            {own && (
              <div style={{ width: "100%", fontSize: 12, color: "var(--ink-3)" }} data-database-note="">
                The FAID backend connects as <span className="kbd">faid_app</span>, limited to schema <span className="kbd">faid</span>; the instance is never bound to a FAID app.
                {s.status !== "missing" && (s.boundApps || []).length > 0 && <> Bound today: <strong>{s.boundApps.join(", ")}</strong> - every bound app runs as <span className="kbd">dbo</span> with full access, including schema <span className="kbd">faid</span>; one backup and restore point for everything in this instance.</>}
                {access.state === "stale" && access.reason && <> <strong>Entry stale:</strong> {access.reason}.</>}
                {access.state === "unknown" && access.reason && <> ({access.reason})</>}
                {access.prepared && <> Entry <span className="kbd">figaf-faid/backend-database</span> for instance <span className="kbd">{access.instanceName}</span>.</>}
              </div>
            )}
            {own && confirmDrop && (
              <div style={{ width: "100%", padding: 10, border: "1px solid var(--line)", borderRadius: 8, fontSize: 13 }} data-confirm="database-drop">
                <strong>Drop schema faid and role faid_app on {instanceName}?</strong> Every table of the FAID Apps in this instance is deleted; the
                Figaf Tool's data is not touched. A deployed shared backend fails at its next start until you prepare the access again.
                <div style={{ marginTop: 8, display: "flex", gap: 8 }}>
                  <button className="btn btn-primary" data-action="database-drop-confirm" disabled={!!busy} onClick={() => { setConfirmDrop(false); onDatabaseDrop(); }}>Yes, drop the FAID schema</button>
                  <button className="btn" disabled={!!busy} onClick={() => setConfirmDrop(false)}>Cancel</button>
                </div>
              </div>
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
  // An own-role database (catalog v6) is ready only when its access is prepared.
  const required = services.filter((s) => !s.optional);
  const ready = (s) => s.status === "ready" && (s.access !== "own-role" || !!(s.databaseAccess && s.databaseAccess.prepared));
  const notReady = required.filter((s) => !ready(s));
  return (
    <div data-services-summary="" style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", fontSize: 12, color: "var(--ink-3)", marginBottom: 14 }}>
      <span style={{ fontWeight: 600, color: "var(--ink-2)" }}>Base services</span>
      {notReady.length === 0
        ? <span className="pill green">all ready</span>
        : <span className="pill gray">{notReady.length} not ready</span>}
      <span>{required.map((s) => `${s.instanceName || s.name}: ${s.status}${s.access === "own-role" ? ` (access ${(s.databaseAccess && s.databaseAccess.state) || "unknown"})` : ""}`).join(" · ")}</span>
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
  // Base services (base-services.js): null = not loaded, [] = the release requires none.
  // Shown as a one-line summary here; created and repaired on the Setup page.
  const [services, setServices] = React.useState(null);
  // The apps a person ticked for "Disable selected" / "Enable selected";
  // faid-cards.js decides what each button does with them.
  const [selected, setSelected] = React.useState([]);
  // The apps of the bulk action THIS page started (busy pill of each card).
  const [busyIds, setBusyIds] = React.useState(null);
  // True once faid:status answered. Before that the cards stay in one
  // untitled section (faid-cards.js), so nothing jumps when the status lands.
  const [statusLoaded, setStatusLoaded] = React.useState(false);

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
        setStatusLoaded(true);
        if (onStatus) onStatus(s);
      } else if (s && s.error) {
        failed("status", null, s);
      }
    } finally {
      setRefreshing(false);
    }
  }, [api, onStatus]);

  // The catalog of the release this installation runs (faid:catalog). It is
  // read at mount and again after every action that can change the installed
  // version (Install on an empty space, Update installation, Remove of the
  // last app): rows, pending apps and the Release panel must all describe the
  // same release. Until 2026-09-09 it was read once, so after an update the
  // page kept the old catalog and told the person to update again.
  const loadCatalog = React.useCallback(async () => {
    if (!api || !api.faid) { setCatalog({ error: "platform surface unavailable" }); return null; }
    const c = await api.faid.catalog();
    setCatalog(c && c.ok ? c : { error: (c && c.error) || "catalog load failed" });
    if (c && !c.ok) setReleases({ ok: false, error: c.error || "catalog load failed", source: c.source || null });
    return c;
  }, [api]);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      const c = await loadCatalog();
      if (cancelled || !c || !c.ok) return;
      refresh();
      refreshServices();
      refreshReleases();
      // Discover Figaf Tool deployments only when some app's form wants one.
      const wantsFigaf = c.apps.some((a) => (a.configForm || []).some((f) => f.type === "figaf-system"));
      if (wantsFigaf && api.faid.figafSystems) {
        const fs = await api.faid.figafSystems();
        if (!cancelled) setFigafSystems(fs && fs.ok ? fs.systems : []);
      }
    })();
    return () => { cancelled = true; };
  }, [api, loadCatalog, refresh, refreshServices, refreshReleases]);

  // Everything this page shows, read again: the button "Refresh" in the head.
  // The release store itself is re-read by "Refresh releases" (refresh: true).
  const refreshAll = React.useCallback(() => {
    loadCatalog();
    refresh();
    refreshServices();
    refreshReleases();
  }, [loadCatalog, refresh, refreshServices, refreshReleases]);

  // The BTP cockpit link for the Details blocks (cf:cockpitUrl, two cf calls):
  // asked once per page, and only when a person opens a Details block.
  const [cockpitUrl, setCockpitUrl] = React.useState(null);
  const cockpitAsked = React.useRef(false);
  const cockpit = React.useMemo(() => ({
    url: cockpitUrl,
    load: () => {
      if (cockpitAsked.current || !api || !api.cf || !api.cf.cockpitUrl) return;
      cockpitAsked.current = true;
      api.cf.cockpitUrl().then((r) => { if (r && r.ok && r.url) setCockpitUrl(r.url); }).catch(() => {});
    },
  }), [api, cockpitUrl]);

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
      if (action !== "health") { loadCatalog(); refresh(); refreshReleases(); }
    }
  }

  // A selected app that can no longer be stopped or started (removed, being
  // deployed, gone from the release) leaves the selection.
  React.useEffect(() => {
    if (!catalog || !catalog.apps || typeof window === "undefined" || !window.figafFaidSelectable) return;
    const ok = new Set(window.figafFaidSelectable(catalog.apps, statuses));
    setSelected((prev) => (prev.every((id) => ok.has(id)) ? prev : prev.filter((id) => ok.has(id))));
  }, [catalog, statuses]);

  // Disable selected / Enable selected: ONE faid:disable / faid:enable call
  // with the list. The manager holds one lock for the whole batch and works
  // the apps one after the other, so a reload in the middle does not cut it.
  // A failure of one app does not stop the others; the failed ones stay
  // selected, so the next try is one click.
  async function doBulk(action, appIds) {
    if (!api || !api.faid || busyApp || running || !appIds || !appIds.length) return { ok: false, error: "busy" };
    const target = `${appIds.length} app${appIds.length === 1 ? "" : "s"}`;
    setBusyApp("selection");
    setBusyIds(appIds);
    setBusyLabel(FAID_BUSY_LABEL[action] || "working…");
    setOutcome(null);
    try {
      const r = await api.faid[action]({ appIds });
      if (r && !r.ok && r.error) {
        failed(action, target, r);
        const stillFailed = (r.results || []).filter((x) => !x.ok).map((x) => x.appId);
        setSelected(stillFailed.length ? stillFailed : appIds);
      } else {
        setSelected([]);
      }
      return r;
    } catch (e) {
      const r = { ok: false, error: (e && e.message) || "action failed" };
      failed(action, target, r);
      return r;
    } finally {
      setBusyApp(null);
      setBusyIds(null);
      setBusyLabel("");
      refresh();
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
      loadCatalog();
      refresh();
      refreshReleases();
    }
  }

  // What the page shows, computed from the catalog and the live status
  // (faid-cards.js). `locked` = an action runs, here or in another page.
  const helpers = typeof window !== "undefined" ? window : {};
  const apps = catalog && !catalog.error && catalog.apps ? catalog.apps : [];
  const pendingApps = (catalog && !catalog.error && catalog.pendingApps) || [];
  const sections = helpers.figafFaidSections
    ? helpers.figafFaidSections(apps, statuses, pendingApps, statusLoaded)
    : (apps.length ? [{ id: "all", title: null, apps }] : []);
  const counts = helpers.figafFaidCounts ? helpers.figafFaidCounts(apps, statuses) : null;
  const selection = helpers.figafFaidSelection
    ? helpers.figafFaidSelection(selected, apps, statuses)
    : { selected: [], toDisable: [], toEnable: [], unchanged: [] };
  const selectableIds = helpers.figafFaidSelectable ? helpers.figafFaidSelectable(apps, statuses) : [];
  const locked = !!busyApp || !!running;

  // One lifecycle action at a time in the whole manager: every deploy
  // touches the shared backend, so a run on ANY app locks every card. The
  // card of the app being worked on says what happens; the others wait.
  function isMine(app) {
    if (busyApp === app.id) return true;
    if (busyIds && busyIds.includes(app.id)) return true;
    if (running) return running.appIds ? running.appIds.includes(app.id) : running.appId === app.id;
    return false;
  }
  function cardLabel(app) {
    if (isMine(app)) return busyLabel || FAID_BUSY_LABEL[running && running.action] || "working…";
    if (running) {
      const what = running.appId === "platform" ? "the installation" : running.appId;
      return `waiting — ${FAID_BUSY_LABEL[running.action] || "an action"} ${what}`;
    }
    if (busyIds) return `waiting — ${busyLabel || "working…"} ${busyIds.join(", ")}`;
    return busyApp ? "waiting — updating the installation" : "";
  }
  function toggleSelected(appId, on) {
    setSelected((prev) => (on ? (prev.includes(appId) ? prev : [...prev, appId]) : prev.filter((id) => id !== appId)));
  }

  return (
    <>
      <div className="pane-body">
       <div className="faid-page">
        <div className="pane-head" style={{ display: "flex", alignItems: "flex-start", gap: 16, flexWrap: "wrap" }}>
          <div style={{ flex: 1, minWidth: 280 }}>
            <div className="pane-eyebrow">Manage FAID Apps</div>
            <h1 className="pane-title">FAID Apps</h1>
            <p className="pane-desc">
              Installed into <span className="kbd">{ctx.login.org || "?"} / {ctx.login.space || "?"}</span>.
              Every action runs plain <span className="kbd">cf</span> commands; the terminal drawer shows them.
              A failed action stays on this page until you dismiss it.
            </p>
          </div>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 12, flexShrink: 0 }}>
            <div style={{ display: "flex", gap: 8 }}>
              <button className="btn" onClick={refreshAll} disabled={refreshing || !!busyApp} title="Read the catalog, the app status, the base services and the release store again">
                {refreshing ? "Refreshing…" : "Refresh"}
              </button>
              {onConnections && (
                <button className="btn" onClick={onConnections} disabled={!!busyApp} title="The system connections the apps use (Credential Store)">
                  Connections
                </button>
              )}
            </div>
            {catalog && !catalog.error && counts && (
              <div className="faid-stats" data-faid-stats="" style={{ marginBottom: 0 }}>
                <div className="faid-stat"><strong>{counts.total}</strong><span>Apps in release</span></div>
                <div className="faid-stat is-running"><strong>{statusLoaded ? counts.running : "…"}</strong><span>Running</span></div>
                <div className="faid-stat is-stopped"><strong>{statusLoaded ? counts.stopped : "…"}</strong><span>Stopped</span></div>
                <div className="faid-stat"><strong>{statusLoaded ? counts.notInstalled : "…"}</strong><span>Not installed</span></div>
                {counts.installing > 0 && <div className="faid-stat is-installing"><strong>{counts.installing}</strong><span>Installing</span></div>}
                {counts.other > 0 && <div className="faid-stat"><strong>{counts.other}</strong><span>Partly running</span></div>}
              </div>
            )}
          </div>
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
            pendingApps={pendingApps}
            busy={locked}
            onRefresh={() => refreshReleases({ refresh: true })}
            onUpdate={doInstallationUpdate}
          />
        )}

        {catalog && catalog.platform && (
          <div data-platform-row="" className="faid-backend">
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <div style={{ fontWeight: 700 }}>{catalog.platform.name || "Shared backend"}</div>
              <FaidStatusPill status={platformStatus ? platformStatus.status : null} />
              {platformStatus && platformStatus.installedVersion && (
                <span style={{ fontSize: 12, color: "var(--ink-3)" }} data-installed-version="">
                  installed: <span className="kbd">{platformStatus.installedVersion}</span>
                </span>
              )}
              {running && (running.action === "install" || running.action === "update") && (
                <span className="pill gray">{FAID_BUSY_LABEL[running.action]}</span>
              )}
            </div>
            <div style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 6 }}>
              Used by every app. No separate action is needed:
              {platformStatus && platformStatus.installedVersion
                ? <> Update installation moves it first, before the app frontends.</>
                : <> it is installed together with the first app, at <span className="kbd">{catalog.releaseVersion || "?"}</span>.</>}
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

        {sections.map((section) => {
          const installedSection = section.id === "installed";
          return (
            <div className="faid-section" key={section.id} data-section={section.id}>
              {section.title && (
                <div className="faid-section-head">
                  <h2 className="faid-section-title">
                    {section.title} <span className="faid-section-count">{section.apps.length}</span>
                  </h2>
                  {installedSection && selectableIds.length > 0 && (
                    <div className="faid-section-tools">
                      {selection.selected.length === 0 && (
                        <span className="setup-hint">Tick apps to stop or start several at once.</span>
                      )}
                      <button className="btn-link" onClick={() => setSelected(selectableIds)}>Select all</button>
                    </div>
                  )}
                </div>
              )}
              {installedSection && selection.selected.length > 0 && (
                <div className="faid-selection" data-selection-bar="">
                  <strong>{selection.selected.length} selected</strong>
                  {selection.unchanged.length > 0 && (
                    <span className="faid-selection-note">{selection.unchanged.length} of them cannot be stopped or started right now.</span>
                  )}
                  <div className="spacer" style={{ flex: 1 }} />
                  <button
                    className="btn"
                    disabled={locked || selection.toDisable.length === 0}
                    title="cf stop for every selected running app, one after the other"
                    onClick={() => doBulk("disable", selection.toDisable)}
                  >
                    Disable selected ({selection.toDisable.length})
                  </button>
                  <button
                    className="btn"
                    disabled={locked || selection.toEnable.length === 0}
                    title="cf start for every selected stopped app, one after the other"
                    onClick={() => doBulk("enable", selection.toEnable)}
                  >
                    Enable selected ({selection.toEnable.length})
                  </button>
                  <button className="btn btn-ghost" onClick={() => setSelected([])}>Clear selection</button>
                </div>
              )}
              <div className="faid-grid">
                {section.apps.map((app) => (
                  section.id === "pending"
                    ? <FaidPendingCard key={app.id} app={app} release={catalog.releaseVersion} />
                    : (
                      <FaidAppCard
                        key={app.id}
                        app={app}
                        status={statuses[app.id]}
                        busy={locked}
                        busyLabel={cardLabel(app)}
                        figafSystems={figafSystems}
                        cockpit={cockpit}
                        selectable={selectableIds.includes(app.id)}
                        selected={selected.includes(app.id)}
                        onSelect={(on) => toggleSelected(app.id, on)}
                        onAction={(action, extra) => doAction(app, action, extra)}
                      />
                    )
                ))}
              </div>
            </div>
          );
        })}

       </div>
      </div>

      <div className="pane-foot">
        <div className="spacer" />
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
