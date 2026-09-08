/* global React, Ico, CheckRow, WizardFooter */

// ═══════════════════════════════════════════════════════════
// Update Figaf Tool — hosted-only branch.
// See update-figaf-tool-plan.md for the full design (D1–D8).
//
// ScreenUpdateConfig
//   Lets the operator confirm/edit the deployment ID, runs detection
//   (cf app <id>-app + cf curl /v3/apps/<guid>/droplets/current to
//   read the live image), picks a target tag from Docker Hub's *-btp
//   list, and exposes a "Skip XSUAA update" checkbox for the
//   role-collection-drift mitigation. On mount we also check
//   update:resumeStatus — if a prior run hasn't reached verified or
//   failed, we surface a banner offering Resume or Discard.
//
// ScreenUpdateProgress
//   Subscribes to update:phase + cli:line + cf:serviceStatus and runs
//   the flow sequentially: begin (refresh-templates) → writeVars →
//   updateXsuaa → deleteApps → createServices → pushApp("app") →
//   pushApp("router") → verify. begin is driven here (not on the config
//   screen) so its refresh-templates events land after this screen has
//   subscribed. createServices provisions figaf-connectivity /
//   figaf-destination when the PI checkboxes are on, before the push.
//   Idempotency lives in the orchestrator (each handler checks
//   update-state.json + does its own short-circuits), so a Retry button
//   just re-runs from the first non-done phase.
// ═══════════════════════════════════════════════════════════

const fg = () => (typeof window !== "undefined" && window.figaf) || null;

const UPDATE_PHASES = [
  { id: "refresh-templates", label: "Refresh deploy templates",  sub: "github.com/figaf/Figaf-BTP-Deployment · btp-users" },
  { id: "update-xsuaa",      label: "Update XSUAA service",      sub: "cf update-service <xsuaa instance> -c xs-security.json" },
  { id: "delete-apps",       label: "Delete current apps",       sub: "cf delete <id>-router/-app -f (recreate only)" },
  { id: "create-services",   label: "Create PI services",        sub: "cf create-service connectivity/destination lite" },
  { id: "push-app",          label: "Push app",                  sub: "cf push <id>-app" },
  { id: "push-router",       label: "Push router",               sub: "cf push <id>-router" },
  { id: "verify",            label: "Verify deployment",         sub: "/v3/apps/<id>-app/droplets/current + route check" },
];

function ScreenUpdateConfig({ ctx, setCtx, onNext, onBack }) {
  const upd = ctx.update || {};
  const [deployId, setDeployId] = React.useState(upd.deployId || "figaf-tool");
  const [detection, setDetection] = React.useState(upd.detection || null);
  const [detecting, setDetecting] = React.useState(false);
  const [scanning, setScanning] = React.useState(true);
  const [tags, setTags] = React.useState(upd.availableTags || []);
  const [targetTag, setTargetTag] = React.useState(upd.targetTag || "");
  const [skipXsuaa, setSkipXsuaa] = React.useState(!!upd.skipXsuaa);
  const [vars, setVars] = React.useState(upd.vars || {});
  const [varsPartial, setVarsPartial] = React.useState(false);
  const [strategy, setStrategy] = React.useState(upd.strategy || "recreate");
  const [resume, setResume] = React.useState(null);
  const [error, setError] = React.useState(null);
  const [showAdvanced, setShowAdvanced] = React.useState(false);
  const setVar = (patch) => setVars(v => ({ ...v, ...patch }));

  // Pull the live app's current vars.yml values so the advanced form defaults
  // to what's actually running (not the template). Returns the merged vars so
  // callers that also need them synchronously (resume → setCtx) don't race the
  // async setVars. Best-effort: a partial read just leaves template gaps.
  async function loadCurrentConfig(id) {
    const api = fg();
    if (!api) return {};
    try {
      const c = await api.update.readCurrentConfig({ deployId: id });
      if (c && c.ok) {
        setVars(v => ({ ...v, ...(c.vars || {}) }));
        setVarsPartial(!!c.partial);
        return c.vars || {};
      }
    } catch {}
    return {};
  }

  async function rescan() {
    setScanning(true);
    setDetection(null);
    try {
      const scan = await fg()?.update.detectDeployment({});
      if (scan) setDetection(scan);
    } catch {}
    setScanning(false);
  }

  React.useEffect(() => {
    const api = fg();
    if (!api) return;
    (async () => {
      const [tagRes, resumeRes, scanRes] = await Promise.allSettled([
        api.config.dockerHubBtpTags(),
        api.update.resumeStatus(),
        api.update.detectDeployment({}),
      ]);
      if (tagRes.status === "fulfilled" && tagRes.value?.ok && Array.isArray(tagRes.value.tags)) {
        setTags(tagRes.value.tags);
      }
      if (resumeRes.status === "fulfilled" && resumeRes.value?.ok && resumeRes.value.hasInFlight) {
        setResume(resumeRes.value.state || null);
      }
      const scan = scanRes.status === "fulfilled" ? scanRes.value : null;
      if (scan) setDetection(scan);
      setScanning(false);
    })();
  }, []);

  async function detect() {
    const api = fg();
    if (!api) return;
    setError(null);
    setDetecting(true);
    try {
      const r = await api.update.detectDeployment({ deployId });
      setDetection(r);
      if (r && r.found) {
        await loadCurrentConfig(deployId);
        if (r.app && r.app.image && !targetTag) {
          const colon = r.app.image.indexOf(":");
          if (colon > 0) setTargetTag(r.app.image.slice(colon + 1));
        }
      }
    } catch (e) {
      setError(e.message || String(e));
    }
    setDetecting(false);
  }

  async function discardResume() {
    const api = fg();
    if (!api) return;
    try { await api.update.clear(); } catch {}
    setResume(null);
  }

  async function pickCandidate(c) {
    setDeployId(c.id);
    setDetection({ ok: true, found: true, deployId: c.id, app: { name: c.app, image: c.image, exists: true }, router: { name: c.router, exists: !!c.router } });
    if (c.image) {
      const colon = c.image.indexOf(":");
      if (colon > 0) setTargetTag(c.image.slice(colon + 1));
    }
    await loadCurrentConfig(c.id);
  }

  // Persist the operator's choices and advance to the progress screen. The
  // actual work — including the refresh-templates phase (update:begin) — is
  // driven entirely by ScreenUpdateProgress's runFlow, so every update:phase
  // event fires *after* that screen has subscribed. Driving begin here instead
  // (the old behavior) emitted refresh-templates running/done before the
  // progress screen mounted, leaving its first row stuck on "pending".
  function startUpdate() {
    if (!targetTag) { setError("Pick a target tag"); return; }
    setError(null);
    const currentImage = detection && detection.app ? detection.app.image : null;
    setCtx(c => ({
      ...c,
      update: {
        ...(c.update || {}),
        deployId,
        detection,
        availableTags: tags,
        targetTag,
        skipXsuaa,
        vars,
        strategy,
        resumeState: null,
        previousImage: currentImage,
        verify: null,
      },
    }));
    onNext();
  }

  async function resumeUpdate() {
    if (!resume) return;
    const id = resume.deployId || deployId;
    setDeployId(id);
    if (resume.targetImageTag) setTargetTag(resume.targetImageTag);
    // A resume may follow a dyno restart, in which case in-session vars were
    // lost. Re-read the live config so writeVars doesn't fall back to template
    // defaults. Strategy is persisted server-side in update-state.json.
    const liveVars = await loadCurrentConfig(id);
    const st = resume.strategy || strategy;
    setStrategy(st);
    setCtx(c => ({
      ...c,
      update: {
        ...(c.update || {}),
        deployId: id,
        targetTag: resume.targetImageTag || targetTag,
        vars: { ...(c.update?.vars || {}), ...liveVars },
        strategy: st,
        resumeState: resume,
        previousImage: c.update?.previousImage || null,
      },
    }));
    onNext();
  }

  const currentImage = detection && detection.app ? detection.app.image : null;
  const found = detection && detection.found;
  const candidates = (detection && detection.candidates) || [];

  return (
    <>
      <div className="pane-body">
        <div className="pane-head">
          <div className="pane-eyebrow">Step 4 · Configure update</div>
          <h1 className="pane-title">Update Figaf Tool</h1>
          <p className="pane-desc">
            Pull the latest deploy templates from GitHub and redeploy <span className="kbd">{deployId}-app</span> and <span className="kbd">{deployId}-router</span> on a new Docker image. Choose how the swap happens below — by default the apps are recreated so the update fits within a trial org's memory quota.
          </p>
        </div>

        {resume && (
          <div className="card" style={{ padding: 14, marginBottom: 14, borderLeft: "3px solid var(--fg-blue)" }}>
            <div style={{ fontSize: 13, color: "var(--ink-0)", marginBottom: 6 }}>
              <strong>Resume in-flight update?</strong>
            </div>
            <div style={{ fontSize: 12, color: "var(--ink-2)", marginBottom: 10 }}>
              A previous run of <span className="kbd">{resume.deployId}</span> stopped at phase <span className="kbd">{resume.phase}</span>
              {resume.lastError ? <> with error: <em>{resume.lastError}</em></> : null}.
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button className="btn btn-primary" onClick={resumeUpdate}>Resume</button>
              <button className="btn" onClick={discardResume}>Discard &amp; start over</button>
            </div>
          </div>
        )}

        <div className="card" style={{ padding: 18, marginBottom: 14 }}>
          {scanning ? (
            <div style={{ fontSize: 13, color: "var(--ink-2)" }}>Scanning for Figaf deployments…</div>
          ) : found ? (
            <div style={{ fontSize: 12.5, color: "var(--ink-2)" }}>
              <div>
                <strong style={{ color: "var(--ink-0)" }}>{detection.app.name}</strong>{" "}
                <span className="pill green">found</span>
              </div>
              <div style={{ marginTop: 4, fontFamily: "var(--font-mono)" }}>
                {currentImage ? <>Current image: <span style={{ color: "var(--fg-blue)" }}>{currentImage}</span></> : "Current image: (unknown)"}
              </div>
              <div style={{ marginTop: 2 }}>
                {detection.router && detection.router.exists
                  ? <>Router <span className="kbd">{detection.router.name}</span> present.</>
                  : <>Router <span className="kbd">{deployId}-router</span> not found — push will create it.</>}
              </div>
              <button className="btn" style={{ marginTop: 10, fontSize: 12 }} onClick={rescan}>
                ← Change deployment
              </button>
            </div>
          ) : candidates.length > 0 ? (
            <div>
              <div style={{ fontSize: 12.5, color: "var(--ink-2)", marginBottom: 8 }}>
                Found {candidates.length} Figaf deployment{candidates.length === 1 ? "" : "s"} in this space:
              </div>
              {candidates.map((c) => (
                <button
                  key={c.id}
                  className="btn"
                  style={{ display: "block", width: "100%", textAlign: "left", marginBottom: 6 }}
                  onClick={() => pickCandidate(c)}
                >
                  <div style={{ fontFamily: "var(--font-mono)", fontSize: 12.5 }}>{c.id}</div>
                  <div style={{ fontSize: 11.5, color: "var(--ink-3)" }}>{c.image}</div>
                </button>
              ))}
            </div>
          ) : (
            <>
              <div style={{ fontSize: 12.5, color: "var(--ink-3)", marginBottom: 12 }}>
                No Figaf deployments found in this space. Enter the deployment ID manually.
              </div>
              <label className="field-label">Deployment ID</label>
              <div style={{ display: "flex", gap: 8 }}>
                <input
                  className="input is-mono"
                  value={deployId}
                  onChange={(e) => setDeployId(e.target.value.trim())}
                  style={{ flex: 1 }}
                  placeholder="figaf-tool"
                />
                <button className="btn" onClick={detect} disabled={detecting || !deployId}>
                  {detecting ? "Detecting…" : "Detect"}
                </button>
              </div>
              {detection && !found && candidates.length === 0 && (
                <div style={{ marginTop: 10, fontSize: 12.5, color: "var(--ink-3)" }}>
                  No matching deployment found. Check the ID, or switch to the Deploy flow to install fresh.
                </div>
              )}
            </>
          )}
        </div>

        <div className="card" style={{ padding: 18, marginBottom: 14 }}>
          <label className="field-label">Target Docker image tag</label>
          <select
            className="input is-mono"
            value={targetTag}
            onChange={(e) => setTargetTag(e.target.value)}
            style={{ width: "100%" }}
          >
            <option value="">— choose —</option>
            {tags.map((t) => {
              const isCurrent = currentImage && currentImage.endsWith(":" + t);
              return <option key={t} value={t}>{t}{isCurrent ? "  (current)" : ""}</option>;
            })}
          </select>
          <div style={{ marginTop: 8, fontSize: 11.5, color: "var(--ink-3)" }}>
            Selecting the current tag is allowed — useful if you want to re-apply XSUAA role drift fixes without changing the image.
          </div>
        </div>

        <div className="card" style={{ padding: 18, marginBottom: 14 }}>
          <label style={{ display: "flex", alignItems: "flex-start", gap: 10, cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={skipXsuaa}
              onChange={(e) => setSkipXsuaa(e.target.checked)}
              style={{ marginTop: 2 }}
            />
            <span>
              <div style={{ fontSize: 13, color: "var(--ink-0)" }}>Skip XSUAA update</div>
              <div style={{ fontSize: 11.5, color: "var(--ink-3)" }}>
                Leaves <span className="kbd">{vars.xsuaaServiceName || "figaf-xsuaa"}</span> untouched. Pick this if you've hand-edited role collections in the cockpit and don't want them reset to the template defaults.
              </div>
            </span>
          </label>
        </div>

        <div className="card" style={{ padding: 18, marginBottom: 14 }}>
          <label className="field-label">Deployment strategy</label>
          <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 6 }}>
            <label style={{ display: "flex", alignItems: "flex-start", gap: 10, cursor: "pointer" }}>
              <input type="radio" name="upd-strategy" checked={strategy === "recreate"} onChange={() => setStrategy("recreate")} style={{ marginTop: 2 }} />
              <span>
                <div style={{ fontSize: 13, color: "var(--ink-0)" }}>Recreate <span className="pill green">works on trial</span></div>
                <div style={{ fontSize: 11.5, color: "var(--ink-3)" }}>
                  Deletes <span className="kbd">{deployId}-router</span> and <span className="kbd">{deployId}-app</span>, then pushes the new image fresh. Frees the org's memory before staging, so it works on trial / tight quotas — a brief outage while the app restarts. Your database and its data are untouched. This is the upgrade path Figaf recommends.
                </div>
              </span>
            </label>
            <label style={{ display: "flex", alignItems: "flex-start", gap: 10, cursor: "pointer" }}>
              <input type="radio" name="upd-strategy" checked={strategy === "rolling"} onChange={() => setStrategy("rolling")} style={{ marginTop: 2 }} />
              <span>
                <div style={{ fontSize: 13, color: "var(--ink-0)" }}>Rolling <span className="pill blue">zero downtime</span></div>
                <div style={{ fontSize: 11.5, color: "var(--ink-3)" }}>
                  Pushes over the running app — the new instance starts alongside the old one and takes over once healthy. No downtime, but CF stages the new droplet while the old one is still up, so it needs ~2× the app's memory free and can hit the org quota on trial accounts.
                </div>
              </span>
            </label>
          </div>
        </div>

        <div style={{ marginBottom: 14 }}>
          <button
            type="button"
            className="btn"
            onClick={() => setShowAdvanced(s => !s)}
            style={{ width: "100%", justifyContent: "space-between" }}
          >
            <span>Advanced — deployment variables{found ? " (loaded from live app)" : ""}</span>
            <span style={{ color: "var(--ink-3)" }}>{showAdvanced ? "▴" : "▾"}</span>
          </button>
          {showAdvanced && (
            <div className="card" style={{ padding: 18, marginTop: 8 }}>
              <div style={{ fontSize: 11.5, color: "var(--ink-3)", marginBottom: 14 }}>
                These default to the values currently running on <span className="kbd">{deployId}-app</span>, so an update won't change them unless you do here. <span className="kbd">ID</span> and <span className="kbd">DOCKER_IMAGE_VERSION</span> are set from the fields above.
              </div>

              {varsPartial && (
                <div style={{ padding: "10px 12px", borderRadius: 6, background: "rgba(234,179,8,0.1)", border: "1px solid rgba(234,179,8,0.3)", fontSize: 12, color: "var(--ink-2)", marginBottom: 14 }}>
                  Some live values couldn't be read — template defaults are shown for those. Review them before continuing.
                </div>
              )}

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 10 }}>
                <div className="field">
                  <label className="field-label">Landscape apps domain</label>
                  <input className="input is-mono" value={vars.domain ?? ""} onChange={(e) => setVar({ domain: e.target.value })} placeholder="cfapps.us10-001.hana.ondemand.com" />
                </div>
                <div className="field">
                  <label className="field-label">Location ID</label>
                  <input className="input is-mono" value={vars.locationId ?? ""} onChange={(e) => setVar({ locationId: e.target.value })} placeholder="(optional)" maxLength={20} />
                </div>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 10 }}>
                <div className="field">
                  <label className="field-label">Instance memory</label>
                  <input className="input is-mono" value={vars.instanceMemory ?? ""} onChange={(e) => setVar({ instanceMemory: e.target.value })} placeholder="1500M" />
                  <div className="field-hint">Units: K, M, G. Defaults to the app's live allocation.</div>
                </div>
                <div className="field">
                  <label className="field-label">Max RAM percentage</label>
                  <input className="input is-mono" value={vars.maxRamPercentage ?? ""} onChange={(e) => setVar({ maxRamPercentage: e.target.value })} placeholder="50" />
                </div>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 10 }}>
                <div className="field">
                  <label className="field-label">Logs total size cap</label>
                  <input className="input is-mono" value={vars.logsTotalSizeCap ?? ""} onChange={(e) => setVar({ logsTotalSizeCap: e.target.value })} placeholder="2GB" />
                </div>
                <div className="field">
                  <label className="field-label">Enable instance monitoring</label>
                  <div style={{ display: "flex", gap: 8, alignItems: "center", padding: "10px 0" }}>
                    <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", fontSize: 13 }}>
                      <input type="checkbox" checked={vars.enableInstanceMonitoring === true} onChange={(e) => setVar({ enableInstanceMonitoring: e.target.checked })} style={{ cursor: "pointer" }} />
                      Enable Glowroot monitoring
                    </label>
                  </div>
                </div>
              </div>

              <div className="field">
                <label className="field-label">Use cloud connector for SMTP integration</label>
                <div style={{ display: "flex", gap: 12, alignItems: "center", padding: "8px 0" }}>
                  <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
                    <input type="radio" name="upd-smtp" checked={vars.useCloudConnectorForSmtpIntegration !== true} onChange={() => setVar({ useCloudConnectorForSmtpIntegration: false })} style={{ cursor: "pointer" }} />
                    <span style={{ fontSize: 13 }}>No</span>
                  </label>
                  <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
                    <input type="radio" name="upd-smtp" checked={vars.useCloudConnectorForSmtpIntegration === true} onChange={() => setVar({ useCloudConnectorForSmtpIntegration: true })} style={{ cursor: "pointer" }} />
                    <span style={{ fontSize: 13 }}>Yes</span>
                  </label>
                </div>
              </div>

              {vars.useCloudConnectorForSmtpIntegration === true && (
                <div className="field" style={{ marginTop: 8 }}>
                  <label className="field-label">Cloud connector destination name</label>
                  <input className="input is-mono" value={vars.cloudConnectorDestinationNameForSmtpIntegration ?? ""} onChange={(e) => setVar({ cloudConnectorDestinationNameForSmtpIntegration: e.target.value })} placeholder="smtp-destination" />
                </div>
              )}

              <div className="field" style={{ marginTop: 14 }}>
                <label className="field-label">Database service name</label>
                {vars.dbServiceName ? (
                  <>
                    <input
                      className="input is-mono"
                      value={vars.dbServiceName}
                      readOnly
                      style={{ opacity: 0.7, cursor: "default" }}
                    />
                    <div className="field-hint">PostgreSQL service instance bound to the app. Auto-detected from the live deployment — cannot be changed during an update.</div>
                  </>
                ) : (
                  <>
                    <input
                      className="input is-mono"
                      value={vars.dbServiceName ?? ""}
                      onChange={(e) => setVar({ dbServiceName: e.target.value.trim() })}
                      placeholder="e.g. figaf-db"
                      style={{ borderColor: "var(--error, #e11d48)" }}
                    />
                    <div style={{ marginTop: 8, padding: "10px 12px", borderRadius: 6, background: "rgba(225,29,72,0.07)", border: "1px solid rgba(225,29,72,0.3)", fontSize: 12, color: "var(--ink-1)" }}>
                      <strong style={{ color: "var(--error, #e11d48)" }}>Database name not detected.</strong> Enter the exact name of the PostgreSQL service instance bound to <span className="kbd">{deployId}-app</span>. Getting this wrong could cause the updated app to bind to a different database.
                    </div>
                  </>
                )}
              </div>

              <div className="field" style={{ marginTop: 14 }}>
                <label className="field-label">CF services</label>
                <div style={{ fontSize: 11.5, color: "var(--ink-3)", marginBottom: 10 }}>
                  <strong>figaf-connectivity</strong> and <strong>figaf-destination</strong> are required for PI/PO integration via SAP Cloud Connector. Auto-detected from the currently running app; the service instances must exist in the CF space.
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                  <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "not-allowed", opacity: 0.6, fontSize: 13 }}>
                    <input type="checkbox" checked disabled style={{ cursor: "not-allowed" }} />
                    <span><span className="kbd">{vars.dbServiceName || "figaf-db"}</span> <span className="pill gray">required</span></span>
                  </label>
                  <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "not-allowed", opacity: 0.6, fontSize: 13 }}>
                    <input type="checkbox" checked disabled style={{ cursor: "not-allowed" }} />
                    <span><span className="kbd">{vars.xsuaaServiceName || "figaf-xsuaa"}</span> <span className="pill gray">required</span></span>
                  </label>
                  <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 13 }}>
                    <input type="checkbox" checked={!!vars.enableConnectivity} onChange={(e) => setVar({ enableConnectivity: e.target.checked })} style={{ cursor: "pointer" }} />
                    <span><span className="kbd">figaf-connectivity</span> <span className="pill blue">PI connection</span></span>
                  </label>
                  <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 13 }}>
                    <input type="checkbox" checked={!!vars.enableDestination} onChange={(e) => setVar({ enableDestination: e.target.checked })} style={{ cursor: "pointer" }} />
                    <span><span className="kbd">figaf-destination</span> <span className="pill blue">PI connection</span></span>
                  </label>
                </div>
              </div>
            </div>
          )}
        </div>

        {error && (
          <div className="card" style={{ padding: 12, marginBottom: 12, borderLeft: "3px solid var(--error, #e11d48)", fontSize: 12.5, color: "var(--ink-1)" }}>
            <strong style={{ color: "var(--error, #e11d48)" }}>Error:</strong> {error}
          </div>
        )}
      </div>

      <WizardFooter
        onBack={onBack}
        onNext={startUpdate}
        nextDisabled={!targetTag || !found || !vars.dbServiceName}
        nextLabel="Start update"
      />
    </>
  );
}

function ScreenUpdateProgress({ ctx, setCtx, onNext, onBack }) {
  const upd = ctx.update || {};
  const deployId = upd.deployId || "figaf-tool";
  const targetTag = upd.targetTag || "";
  const skipXsuaa = !!upd.skipXsuaa;
  const vars = upd.vars || {};
  const strategy = upd.strategy || "recreate";
  const xsuaaName = vars.xsuaaServiceName || "figaf-xsuaa";

  // Only show the create-services row when the operator actually selected a PI
  // service — otherwise update:createServices short-circuits and the row would
  // just read "no PI services selected", which is noise on a plain update.
  const wantsServices = !!(vars.enableConnectivity || vars.enableDestination);
  const phaseDefs = React.useMemo(
    () => UPDATE_PHASES.filter(p => p.id !== "create-services" || wantsServices),
    [wantsServices]
  );

  const [phases, setPhases] = React.useState(() => phaseDefs.map(p => ({ ...p, status: "pending" })));
  const [error, setError] = React.useState(null);
  const [running, setRunning] = React.useState(false);
  const [done, setDone] = React.useState(false);
  const startedRef = React.useRef(false);

  const markPhase = React.useCallback((id, patch) => {
    setPhases(prev => prev.map(p => p.id === id ? { ...p, ...patch } : p));
  }, []);

  React.useEffect(() => {
    const api = fg();
    if (!api || !api.on) return;
    const offPhase = api.on("update:phase", (msg) => {
      if (!msg || !msg.phase) return;
      const status = msg.state === "running" ? "running" : msg.state === "done" ? "done" : "error";
      const patch = { status };
      if (msg.error)  patch.sub = msg.error;
      if (msg.detail) patch.sub = msg.detail;
      markPhase(msg.phase, patch);
    });
    const offSvc = api.on("cf:serviceStatus", (msg) => {
      if (msg && msg.name === xsuaaName) markPhase("update-xsuaa", { sub: `status: ${msg.status}` });
    });
    return () => { offPhase && offPhase(); offSvc && offSvc(); };
  }, [markPhase, xsuaaName]);

  const runFlow = React.useCallback(async () => {
    const api = fg();
    if (!api) return;
    setRunning(true);
    setError(null);

    try {
      // refresh-templates phase: force-refresh the deploy dir + init
      // update-state.json. Driven here (not on the config screen) so its
      // update:phase events land after this screen has subscribed.
      const bg = await api.update.begin({ deployId, targetImageTag: targetTag, strategy });
      if (!bg || bg.ok === false) { setError((bg && bg.error) || "refresh templates failed"); setRunning(false); return; }

      const wv = await api.update.writeVars({ deployId, dockerTag: targetTag, vars });
      if (!wv.ok) { setError(wv.error || "writeVars failed"); setRunning(false); return; }

      const ux = await api.update.updateXsuaa({ deployId, skip: skipXsuaa, xsuaaServiceName: xsuaaName });
      if (!ux.ok) { setError(ux.error || "updateXsuaa failed"); setRunning(false); return; }

      // Recreate strategy frees the org quota by deleting both apps before the
      // push; no-op under rolling. Must run before either push so the staging
      // overlap can't trip the trial memory limit.
      const da = await api.update.deleteApps({ deployId, strategy });
      if (!da.ok) { setError(da.error || "deleteApps failed"); setRunning(false); return; }

      // Create + activate figaf-connectivity / figaf-destination when the PI
      // checkboxes are on. config:writeVars already bound them in manifest.yml,
      // so the instances must exist before the push or it fails with
      // "Service instance 'figaf-connectivity' not found". No-op otherwise.
      const cs = await api.update.createServices({ deployId, vars });
      if (!cs.ok) { setError(cs.error || "createServices failed"); setRunning(false); return; }

      const pa = await api.update.pushApp({ deployId, role: "app", strategy });
      if (!pa.ok) { setError(pa.error || "pushApp(app) failed"); setRunning(false); return; }

      const pr = await api.update.pushApp({ deployId, role: "router", strategy });
      if (!pr.ok) { setError(pr.error || "pushApp(router) failed"); setRunning(false); return; }

      const vf = await api.update.verify({ deployId });
      if (!vf.ok) { setError(vf.error || "verify failed"); setRunning(false); return; }

      setCtx(c => ({ ...c, update: { ...(c.update || {}), verify: vf } }));
      setRunning(false);
      setDone(true);
    } catch (e) {
      setError(e.message || String(e));
      setRunning(false);
    }
  }, [deployId, targetTag, skipXsuaa, xsuaaName, vars, strategy, setCtx]);

  React.useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    runFlow();
  }, [runFlow]);

  async function abort() {
    const api = fg();
    try { await api?.update?.clear(); } catch {}
    if (onBack) onBack();
  }

  return (
    <>
      <div className="pane-body">
        <div className="pane-head">
          <div className="pane-eyebrow">Step 5 · Apply update</div>
          <h1 className="pane-title">
            {done ? "Update applied" : error ? "Update halted" : "Updating Figaf Tool…"}
          </h1>
          <p className="pane-desc">
            {done
              ? <>Update completed with target tag <span className="kbd">{targetTag}</span>. The new instance is healthy and serving the public route.</>
              : error
                ? "A phase failed. The orchestrator has persisted state under update-state.json — retry resumes from the failed phase."
                : <>Updating <span className="kbd">{deployId}-app</span> and <span className="kbd">{deployId}-router</span> to <span className="kbd">{targetTag}</span>. Expand the CLI drawer to watch progress.</>}
          </p>
        </div>

        <div className="card" style={{ padding: "4px 18px" }}>
          <div className="checklist">
            {phases.map(p => <CheckRow key={p.id} {...p} />)}
          </div>
        </div>

        {error && (
          <div className="card" style={{ padding: 14, marginTop: 14, borderLeft: "3px solid var(--error, #e11d48)" }}>
            <div style={{ fontSize: 13, color: "var(--error, #e11d48)", marginBottom: 6 }}>
              <strong>Error:</strong> {error}
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <button className="btn btn-primary" disabled={running} onClick={() => {
                setPhases(phaseDefs.map(p => ({ ...p, status: "pending" })));
                runFlow();
              }}>Retry from failed phase</button>
              <button className="btn" onClick={abort}>Abort &amp; clear state</button>
            </div>
          </div>
        )}

        {!done && !error && (
          <div style={{ marginTop: 16, display: "flex", gap: 10, alignItems: "center", fontSize: 12, color: "var(--ink-3)" }}>
            <Ico.Terminal style={{ color: "var(--fg-blue)" }} />
            <span>Rolling push keeps the old instance live until the new one's health check passes.</span>
          </div>
        )}
      </div>

      <WizardFooter
        onBack={onBack}
        onNext={onNext}
        nextDisabled={!done}
        nextLabel={done ? "Finish" : running ? "Updating…" : "Halted"}
        backLabel="Cancel"
      />
    </>
  );
}

Object.assign(window, { ScreenUpdateConfig, ScreenUpdateProgress });
