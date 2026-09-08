/* global React, Ico */

const fg = () => (typeof window !== "undefined" && window.figaf) || null;

// Shared by both Finish screens: fetch the BTP cockpit deep-link for the
// current CF space once on mount. Stays null if the orchestrator can't derive
// it (e.g. a cf --guid lookup failed) — the cell is hidden in that case.
function useCockpitUrl() {
  const [url, setUrl] = React.useState(null);
  React.useEffect(() => {
    const api = fg();
    if (!api || !api.cf || !api.cf.cockpitUrl) return;
    let alive = true;
    api.cf.cockpitUrl()
      .then((r) => { if (alive && r && r.ok && r.url) setUrl(r.url); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);
  return url;
}

// "BTP Cockpit" detail cell — clickable, opens the CF space's Applications
// page externally. Renders nothing until/unless a URL is available.
function CockpitCell({ url }) {
  if (!url) return null;
  return (
    <div className="cell" style={{ gridColumn: "1 / -1", borderRight: 0 }}>
      <div className="k">BTP Cockpit</div>
      <div
        className="v"
        style={{ color: "var(--fg-blue)", cursor: "pointer", overflowWrap: "anywhere" }}
        onClick={() => fg()?.shell.openExternal(url)}
        title="Open the CF space in the BTP cockpit"
      >
        {url}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// 7. Completion
// ═══════════════════════════════════════════════════════════
function ScreenDone({ ctx, setCtx, setStep, STEPS }) {
  const isUpdate = ctx.choice === "update";
  if (isUpdate) return <ScreenDoneUpdate ctx={ctx} setCtx={setCtx} setStep={setStep} STEPS={STEPS} />;

  const appUrl = `https://${ctx.config.id || "figaf-tool"}.${ctx.config.domain || `cfapps.${ctx.login.landscape.replace(/^cf-/, '')}.hana.ondemand.com`}`;
  const open = () => fg()?.shell.openExternal(appUrl);
  const isHosted = window.figafModeFlags.isHosted;
  const showXsuaaUpgrade = !!(window.figafModeFlags.features && window.figafModeFlags.features.xsuaaUpgrade);

  function backToChoice() {
    if (!setCtx || !setStep) return;
    // Reset the branch so STEPS collapses back to baseSteps, then jump to the
    // choice screen (index 2: [welcome, login, choice]).
    setCtx(c => ({ ...c, choice: null }));
    setStep(2);
  }

  function beginXsuaaUpgrade() {
    if (!setCtx || !setStep) return;
    // Flip the wizard branch to xsuaaSteps. The new STEPS layout is
    // [welcome, login, choice, xsuaa-upgrade, xsuaa-assign-role, done];
    // jump to index 3 (xsuaa-upgrade) — the first xsuaa-branch screen.
    setCtx(c => ({ ...c, choice: "xsuaa-upgrade" }));
    setStep(3);
  }

  const [deleteState, setDeleteState] = React.useState("idle"); // idle | running | done | error
  const cockpitUrl = useCockpitUrl();

  async function handleDeleteManager() {
    const api = fg();
    if (!api) return;
    setDeleteState("running");
    try {
      const r = await api.cf.deleteApp({ name: "figaf-manager" });
      if (r && r.ok === false) {
        setDeleteState("error");
      } else {
        setDeleteState("done");
      }
    } catch {
      setDeleteState("error");
    }
  }

  return (
    <>
      <div className="pane-body">
        <div className="success-splash">
          <div className="success-ring">
            <div className="sr-inner">
              <Ico.Check style={{ width: 24, height: 24, strokeWidth: 2.5 }} />
            </div>
          </div>
          <h1 className="pane-title" style={{ textAlign: "center" }}>Figaf is live.</h1>
          <p className="pane-desc" style={{ textAlign: "center", maxWidth: "48ch" }}>
            Your deployment is running on SAP BTP Cloud Foundry. Open the tool to sign in and start configuring your test suites.
          </p>
        </div>

        <div className="summary-grid" style={{ marginBottom: 18 }}>
          <div className="cell"><div className="k">App URL</div><div className="v" style={{ color: "var(--fg-blue)" }}>{appUrl}</div></div>
          <div className="cell"><div className="k">Image tag</div><div className="v">figaf/app:{ctx.config.dockerVersion || ctx.config.locationId}</div></div>
          <div className="cell"><div className="k">Database</div><div className="v">{ctx.config.dbServiceName || "figaf-db"}{ctx.dbReused ? " · existing instance" : ` · ${ctx.config.dbPlan}`}</div></div>
          <div className="cell"><div className="k">Auth</div><div className="v">{ctx.config.xsuaaServiceName || "figaf-xsuaa"}{ctx.xsuaaReused ? " · existing instance" : ""}</div></div>
          <div className="cell"><div className="k">Org / Space</div><div className="v">{ctx.login.org || "—"} / {ctx.login.space || "—"}</div></div>
          <div className="cell"><div className="k">Location ID</div><div className="v">{ctx.config.locationId || "—"}</div></div>
          <CockpitCell url={cockpitUrl} />
        </div>

        {isHosted && deleteState === "done" && (
          <div style={{ padding: "12px 16px", borderRadius: 8, background: "var(--fg-blue-soft, rgba(21,101,216,0.07))", border: "1px solid rgba(21,101,216,0.18)", fontSize: 13, color: "var(--ink-2)" }}>
            <strong style={{ color: "var(--ink-0)" }}>Manager app deleted.</strong>{" "}
            This tab will stop responding shortly — that's expected. You can close it.
          </div>
        )}
      </div>

      <div className="pane-foot">
        {isHosted && deleteState !== "done" && (
          <button
            className="btn"
            style={{ color: "var(--error, #e11d48)", borderColor: "rgba(225,29,72,0.3)" }}
            onClick={handleDeleteManager}
            disabled={deleteState === "running"}
          >
            <Ico.Trash />
            {deleteState === "running" ? "Deleting…" : deleteState === "error" ? "Delete failed — retry" : "Delete this manager app"}
          </button>
        )}
        {showXsuaaUpgrade && (
          <button className="btn" onClick={beginXsuaaUpgrade} title="Replace the cockpit-log token with SAP IAS SSO via XSUAA">
            <Ico.Shield /> Enable persistent SSO login
          </button>
        )}
        <div className="spacer" />
        <button className="btn btn-primary" onClick={backToChoice}>
          <Ico.ArrowLeft /> Back to actions
        </button>
        <button className="btn btn-primary" onClick={open}>
          Open Figaf Tool <Ico.External />
        </button>
      </div>
    </>
  );
}

function ScreenDoneUpdate({ ctx, setCtx, setStep }) {
  const upd = ctx.update || {};
  const verify = upd.verify || {};
  const previousImage = upd.previousImage || "(unknown)";
  const currentImage = verify.appImage || (upd.targetTag ? `figaf/app:${upd.targetTag}` : "(unknown)");
  const route = verify.route;
  const url = route ? (route.startsWith("http") ? route : `https://${route}`) : null;
  const [clearing, setClearing] = React.useState(false);
  const cockpitUrl = useCockpitUrl();

  function openRoute() {
    if (url) fg()?.shell.openExternal(url);
  }

  async function clearAndReset() {
    setClearing(true);
    try { await fg()?.update?.clear?.(); } catch {}
    setClearing(false);
    setCtx(c => ({
      ...c,
      choice: null,
      update: { deployId: "figaf-tool", detection: null, availableTags: [], targetTag: "", skipXsuaa: false, resumeState: null, previousImage: null, verify: null },
    }));
    if (setStep) setStep(2);
  }

  return (
    <>
      <div className="pane-body">
        <div className="success-splash">
          <div className="success-ring">
            <div className="sr-inner">
              <Ico.Check style={{ width: 24, height: 24, strokeWidth: 2.5 }} />
            </div>
          </div>
          <h1 className="pane-title" style={{ textAlign: "center" }}>Update complete.</h1>
          <p className="pane-desc" style={{ textAlign: "center", maxWidth: "52ch" }}>
            Figaf Tool is now running the new image. Rolling push kept the old instance serving until the new one passed its health check — no downtime.
          </p>
        </div>

        <div className="summary-grid" style={{ marginBottom: 18 }}>
          <div className="cell"><div className="k">Deployment ID</div><div className="v">{upd.deployId}</div></div>
          <div className="cell"><div className="k">App URL</div><div className="v" style={{ color: "var(--fg-blue)" }}>{url || "—"}</div></div>
          <div className="cell"><div className="k">Previous image</div><div className="v">{previousImage}</div></div>
          <div className="cell"><div className="k">Current image</div><div className="v">{currentImage}</div></div>
          <div className="cell"><div className="k">Router</div><div className="v">{verify.routerHealth || "—"}</div></div>
          <div className="cell"><div className="k">Org / Space</div><div className="v">{ctx.login.org || "—"} / {ctx.login.space || "—"}</div></div>
          <CockpitCell url={cockpitUrl} />
        </div>
      </div>

      <div className="pane-foot">
        <button className="btn" onClick={clearAndReset} disabled={clearing}>
          <Ico.Refresh /> {clearing ? "Clearing…" : "Start another action"}
        </button>
        <div className="spacer" />
        {url && (
          <button className="btn btn-primary" onClick={openRoute}>
            Open Figaf Tool <Ico.External />
          </button>
        )}
      </div>
    </>
  );
}

Object.assign(window, { ScreenDone });
