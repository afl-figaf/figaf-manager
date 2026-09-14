/* global React, Ico,
   WinFrame, FigafMark, TerminalDrawer, SelfUpdateBanner, UpdatePreflightModal,
   ScreenLogin, ScreenFaidApps, ScreenConnections, ScreenSetupPage,
   ScreenSession, ScreenAbout, ScreenFigafToolHub */
// Console frame (hosted mode): a persistent left-rail navigation instead of
// the one-time wizard. Pages are the existing screens; the three Figaf Tool
// flows (deploy / update / connect) keep their step sequence and render
// INSIDE the Figaf Tool page as a local stepper.
// Frame selection happens in app.jsx via features.consoleUI.
//
// The Setup page (#/setup, docs/faid-apps-console/SPEC.md section 6) owns the installation
// of a fresh space. Until step 1 (Prepare the space) is done - i.e. while the
// manager runs in token mode - it is the landing page and the pages that
// need a prepared space are disabled in the rail. A deep link still opens
// them, with a notice that points back to the Setup.

const CONSOLE_ROUTES = [
  { id: "setup",       hash: "#/setup",       label: "Setup",            sub: "Prepare · sign-in · services", needsCf: false },
  { id: "apps",        hash: "#/apps",        label: "FAID Apps",  sub: "Install · update · health",    needsCf: true,  afterPrepare: true },
  { id: "connections", hash: "#/connections", label: "Connections",      sub: "Figaf tool · SAP systems",     needsCf: true,  afterPrepare: true },
  { id: "figaf-tool",  hash: "#/figaf-tool",  label: "Figaf Tool",       sub: "Deploy · update · connect",    needsCf: true,  afterPrepare: true },
  { id: "session",     hash: "#/session",     label: "Session & access", sub: "Sign-in · management user",    needsCf: false },
  { id: "about",       hash: "#/about",       label: "About & updates",  sub: "Version · checks",             needsCf: false },
];

// The wizard branches that are flows inside the Figaf Tool page.
const FIGAF_TOOL_FLOWS = { deploy: 1, update: 1, connect: 1 };
// The old persistent-SSO route: the work moved to the Setup page.
const LEGACY_SSO_HASH = "#/session/sso-upgrade";
// "#/session/add-btp": Session & access opens with the BTP sign-in form. Used by
// the Setup page's "Add BTP login first"; screen-session.jsx returns to the
// Setup when the BTP login completes.
const ADD_BTP_SUBROUTE = "add-btp";
const LOCKED_HINT = "Available after step 1 of the Setup (Prepare the space)";

const consoleXsuaaMode = () => typeof window !== "undefined" && window.figafXsuaaMode === true;

// "#/session/add-btp" -> { id: "session", sub: "add-btp" }. An empty or unknown
// hash lands on the Setup while the space is not prepared, on the apps after.
function consoleLocationFromHash(hash) {
  const h = String(hash || "");
  if (h === LEGACY_SSO_HASH) return { id: "setup", sub: "" };
  const exact = CONSOLE_ROUTES.find((x) => x.hash === h);
  if (exact) return { id: exact.id, sub: "" };
  const parent = CONSOLE_ROUTES.find((x) => h.indexOf(x.hash + "/") === 0);
  if (parent) return { id: parent.id, sub: h.slice(parent.hash.length + 1) };
  return { id: consoleXsuaaMode() ? "apps" : "setup", sub: "" };
}
function consoleRouteFromHash(hash) { return consoleLocationFromHash(hash).id; }

// Environment checks, run silently at console boot (the wizard ran them on
// the Welcome step). Mirrors ScreenWelcome's hosted branch: the CLIs are
// bundled, only Docker Hub is really probed.
async function runConsoleChecks(setCtx) {
  const api = typeof window !== "undefined" ? window.figaf : null;
  if (!api || !api.prereq) return;
  const mark = (id, patch) =>
    setCtx((c) => ({ ...c, prereqs: c.prereqs.map((p) => (p.id === id ? { ...p, ...patch } : p)) }));
  setCtx((c) => ({ ...c, prereqsStarted: true }));
  mark("btp", { status: "running", sub: "bundled in container" });
  mark("cf", { status: "running", sub: "bundled in container" });
  mark("disk", { status: "done", sub: "container filesystem ready" });
  // The bundled CLIs report their own version; the build's pin (bin/VERSIONS.json)
  // is the expectation. A mismatch or a CLI that does not start is a failed check.
  try {
    const v = api.prereq.bundledVersions ? await api.prereq.bundledVersions() : null;
    const row = (x, name) => {
      if (!x || !x.ok) return { status: "error", sub: `${name} did not start${x && x.raw ? `: ${x.raw}` : ""}` };
      const ver = x.version || x.raw || "version unknown";
      if (x.expected && x.matches === false) return { status: "error", sub: `bundled in container · ${name} ${ver}, but the build pinned ${x.expected}` };
      return { status: "done", sub: `bundled in container · ${name} ${ver}` };
    };
    if (v) {
      mark("btp", row(v.btp, "btp"));
      mark("cf", row(v.cf, "cf"));
      setCtx((c) => ({ ...c, versions: v }));
    } else {
      mark("btp", { status: "done", sub: "bundled in container" });
      mark("cf", { status: "done", sub: "bundled in container" });
    }
  } catch (e) {
    mark("btp", { status: "error", sub: e.message });
    mark("cf", { status: "error", sub: e.message });
  }
  mark("net", { status: "running" });
  try {
    const r = await api.prereq.dockerHub();
    if (r && r.ok) mark("net", { status: "done", sub: r.latest ? `hub.docker.com · ${r.latest}` : "docker hub reachable" });
    else mark("net", { status: "error", sub: (r && r.error) || "unreachable" });
  } catch (e) {
    mark("net", { status: "error", sub: e.message });
  }
}

// A route with `afterPrepare` unlocks once out of token mode (xsuaaMode), but
// some of them track a LATER Setup step that can still be blocked then (seen
// 2026-09-14: a trial space whose Credential Store never got created still
// showed FAID Apps as available, because only xsuaaMode gated the rail - the
// Setup page itself already knew step 4 was blocked). Route -> that step id.
const ROUTE_SETUP_STEP = { apps: "platform", connections: "figaf-connection" };

function ConsoleRail({ activeRoute, onNavigate, flowActive, aboutBadge, ctx, version, setupSub, setupDot, xsuaaMode, setup }) {
  return (
    <aside className="rail">
      <div className="rail-brand">
        <FigafMark size={26} />
        <div className="rail-brand-text">
          <span className="t1">Figaf Manager</span>
          <span className="t2">SAP BTP · Cloud Foundry</span>
        </div>
      </div>

      <nav className="cnav">
        {CONSOLE_ROUTES.map((r) => {
          const stepId = ROUTE_SETUP_STEP[r.id];
          const step = stepId && setup ? setup.steps.find((s) => s.id === stepId) : null;
          // Fail closed: without the step model (script not loaded yet) a
          // tracked route stays locked rather than defaulting to open.
          const stepBlocked = !!stepId && !!(step ? step.blocked && !step.done : true);
          const tokenLocked = !xsuaaMode;
          const locked = !!r.afterPrepare && (tokenLocked || stepBlocked);
          const lockedSub = tokenLocked ? "after step 1 (Setup)" : ((step && step.blocked) || LOCKED_HINT);
          const lockedTitle = tokenLocked ? LOCKED_HINT : ((step && step.blocked) || LOCKED_HINT);
          const go = () => onNavigate(locked ? "setup" : r.id);
          return (
            <div
              key={r.id}
              data-route={r.id}
              data-locked={locked ? "1" : undefined}
              className={`cnav-item ${activeRoute === r.id ? "is-active" : ""} ${locked ? "is-disabled" : ""}`}
              onClick={go}
              role="link"
              aria-disabled={locked || undefined}
              title={locked ? lockedTitle : undefined}
              tabIndex={0}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") go(); }}
            >
              <div className="cnav-label">
                {r.label}
                {r.id === "figaf-tool" && flowActive && <span className="cnav-dot blue" title="A flow is in progress" />}
                {r.id === "setup" && setupDot && <span className="cnav-dot blue" title="The setup is not finished" />}
                {r.id === "about" && aboutBadge && <span className="cnav-dot red" title={aboutBadge} />}
              </div>
              <div className="cnav-sub">{r.id === "setup" && setupSub ? setupSub : locked ? lockedSub : r.sub}</div>
            </div>
          );
        })}
      </nav>

      <div className="rail-foot" style={{ flexDirection: "column", alignItems: "flex-start", gap: 2 }}>
        {ctx.login.cfStatus === "done" ? (
          <>
            <span>{ctx.login.user}</span>
            <span>{ctx.login.org} / {ctx.login.space}</span>
          </>
        ) : (
          <span>not signed in</span>
        )}
        <span>{version ? `v${version}` : ""} · figaf.com</span>
      </div>
    </aside>
  );
}

// One line on a page that was opened before the setup is finished (deep link
// or bookmark): where the installation stands and where to continue.
function SetupNotice({ setup, onOpen }) {
  if (!setup || setup.complete) return null;
  const cur = setup.current;
  return (
    <div className="setup-notice" data-setup-notice="">
      <Ico.Info />
      <span>
        Setup not finished: {setup.done} of {setup.total} done{cur ? <>. Next: step {cur.n}, {cur.title}</> : null}.
      </span>
      <div className="spacer" style={{ flex: 1 }} />
      <button className="btn" onClick={onOpen}>Open Setup</button>
    </div>
  );
}

function ConsoleFrame({ app }) {
  const {
    ctx, setCtx, logs, appendLog,
    step, setStepRaw, STEPS, renderScreenById,
    terminalOpen, setTerminalOpen, currentCmd,
  } = app;

  const [loc, setLoc] = React.useState(() =>
    consoleLocationFromHash(typeof window === "undefined" ? "" : window.location.hash));
  const route = loc.id;
  const sub = loc.sub;
  // The four states the Setup model needs. `stored` and `figaf` need no cf
  // login (Credential Store reads); `faid` and `services` do.
  const [data, setData] = React.useState({});
  const [releaseVersion, setReleaseVersion] = React.useState(null);

  const xsuaaMode = consoleXsuaaMode();
  const signedIn = ctx.login.cfStatus === "done";
  const flowActive = !!FIGAF_TOOL_FLOWS[ctx.choice] && step >= 3;   // flows on the Figaf Tool page

  const navigate = React.useCallback((id, subroute) => {
    const r = CONSOLE_ROUTES.find((x) => x.id === id);
    if (!r) return;
    const hash = subroute ? `${r.hash}/${subroute}` : r.hash;
    if (window.location.hash !== hash) window.location.hash = hash; // hashchange updates state
    else setLoc({ id, sub: subroute || "" });
  }, []);

  // Keep state and address bar in sync (back button, hand-edited hash).
  React.useEffect(() => {
    const onHash = () => setLoc(consoleLocationFromHash(window.location.hash));
    window.addEventListener("hashchange", onHash);
    // Normalize the address on first load (empty hash → the landing page).
    const r = CONSOLE_ROUTES.find((x) => x.id === route);
    const want = r ? (sub ? `${r.hash}/${sub}` : r.hash) : "";
    if (want && window.location.hash !== want) window.history.replaceState(null, "", want);
    return () => window.removeEventListener("hashchange", onHash);
    // eslint-disable-next-line
  }, []);

  // Environment checks: once per console boot, silently.
  React.useEffect(() => {
    if (!ctx.prereqsStarted) runConsoleChecks(setCtx);
    // eslint-disable-next-line
  }, []);

  // The two states OTHER pages change (management user on Session & access,
  // Figaf connection on Connections) are read again every time the Setup or
  // the dashboard comes back into view (run #3 finding 4). No cf login needed.
  const readExternal = React.useCallback(async () => {
    const api = window.figaf;
    if (!api) return;
    const [figaf, stored] = await Promise.all([
      api.connections.figafStatus().catch((e) => ({ ok: false, error: e.message })),
      api.login.storedUserStatus().catch(() => ({ available: false, bindingPresent: false })),
    ]);
    setData((d) => ({ ...d, figaf, stored }));
  }, []);
  // The cf-backed states: apps and service instances.
  const readCf = React.useCallback(async () => {
    const api = window.figaf;
    if (!api || !api.faid) return;
    const [faid, services] = await Promise.all([
      api.faid.status().catch((e) => ({ ok: false, error: e.message })),
      (api.faid.services ? api.faid.services() : Promise.resolve(null)).catch(() => null),
    ]);
    setData((d) => ({ ...d, faid, services }));
  }, []);

  React.useEffect(() => {
    if (route === "setup" || route === "apps" || route === "connections") readExternal();
  }, [route, readExternal]);
  // The dashboard (#/apps) fetches status and services itself and reports
  // them through onFaidStatus / onFaidServices - no second call from the frame
  // (the failure-visibility spec intercepts exactly one status answer).
  React.useEffect(() => {
    if (!signedIn) return;
    if (route === "setup" || route === "connections") readCf();
    // eslint-disable-next-line
  }, [signedIn, route]);
  // The rail locks FAID Apps / Connections until their Setup step is
  // confirmed ready (fail closed, see ROUTE_SETUP_STEP in ConsoleRail) - so
  // that confirmation must not wait for a visit to Setup or Connections
  // first, e.g. when a rail click is the very first thing done after signing
  // in this session.
  React.useEffect(() => {
    if (signedIn && xsuaaMode) readCf();
    // eslint-disable-next-line
  }, [signedIn, xsuaaMode]);
  React.useEffect(() => {
    const api = window.figaf;
    if (!api || !api.faid || releaseVersion !== null) return;
    api.faid.catalog().then((c) => setReleaseVersion(c && c.ok ? c.releaseVersion || "" : "")).catch(() => setReleaseVersion(""));
  }, [releaseVersion]);

  // The dashboard reports every fresh faid:status / faid:services (after
  // install / remove / refresh); keep the model in step without re-fetching.
  const onFaidStatus = React.useCallback((s) => { setData((d) => ({ ...d, faid: s })); }, []);
  const onFaidServices = React.useCallback((s) => { setData((d) => ({ ...d, services: s })); }, []);

  const setup = buildSetupChecklist(data, { navigate });
  const dataLoaded = data.stored !== undefined;

  // The gate rule of the Setup (SPEC section 6): a page that needs cf, the
  // manager in XSUAA mode with a Credential Store bound and no user stored -
  // the Setup (step 2) is the right place, not the passcode card.
  React.useEffect(() => {
    if (signedIn || ctx.login.autoStatus === "trying" || !xsuaaMode) return;
    const r = CONSOLE_ROUTES.find((x) => x.id === route);
    if (!r || !r.needsCf) return;
    const st = data.stored;
    if (st && st.bindingPresent && !st.available) navigate("setup");
    // eslint-disable-next-line
  }, [route, signedIn, ctx.login.autoStatus, data.stored]);

  const startFlow = React.useCallback((choiceId) => {
    setCtx((c) => ({ ...c, choice: choiceId }));
    setStepRaw(3); // base steps 0-2 are not rendered in the console; 3 = first tail step
    navigate("figaf-tool");
  }, [setCtx, setStepRaw, navigate]);

  const abandonFlow = React.useCallback(() => {
    setCtx((c) => ({ ...c, choice: null }));
    setStepRaw(2);
  }, [setCtx, setStepRaw]);

  // A wizard branch rendered as a local stepper inside a console page.
  const renderFlow = (backLabel) => {
    const tail = STEPS.slice(3);
    const flowIndex = Math.min(step, STEPS.length - 1) - 3;
    const stepId = STEPS[Math.min(step, STEPS.length - 1)].id;
    return (
      <>
        <div className="flow-strip">
          <button className="btn-link" onClick={abandonFlow}>{backLabel}</button>
          <div className="spacer" style={{ flex: 1 }} />
          {tail.map((s, i) => (
            <span key={s.id} className={`flow-chip ${i === flowIndex ? "is-active" : i < flowIndex ? "is-done" : ""}`}>
              {s.label}
            </span>
          ))}
        </div>
        {renderScreenById(stepId)}
      </>
    );
  };

  // ── page content ──────────────────────────────────────────────────────────
  const activeRouteDef = CONSOLE_ROUTES.find((r) => r.id === route) || CONSOLE_ROUTES[0];
  let page = null;

  if (activeRouteDef.needsCf && !signedIn) {
    // Auth gate: the addressed page waits behind the sign-in card. While the
    // automatic sign-in (session resume / stored user) is still being tried,
    // show that instead of flashing the login form.
    page = ctx.login.autoStatus === "trying" ? (
      <div className="pane-body">
        <div className="pane-head">
          <div className="pane-eyebrow">Signing in</div>
          <h1 className="pane-title">Connecting to Cloud Foundry…</h1>
          <p className="pane-desc">Resuming your session, or signing in with the stored management user.</p>
        </div>
      </div>
    ) : (
      <ScreenLogin ctx={ctx} setCtx={setCtx} onNext={() => {}} appendLog={appendLog} gate />
    );
  } else if (route === "setup") {
    page = (
      <ScreenSetupPage
        ctx={ctx}
        setCtx={setCtx}
        appendLog={appendLog}
        data={data}
        setup={setup}
        navigate={navigate}
        onRefreshExternal={readExternal}
        onRefreshCf={readCf}
        onOpenTerminal={() => setTerminalOpen(true)}
        releaseVersion={releaseVersion || null}
      />
    );
  } else if (route === "apps") {
    page = (
      <>
        {dataLoaded && <SetupNotice setup={setup} onOpen={() => navigate("setup")} />}
        <ScreenFaidApps
          ctx={ctx}
          setCtx={setCtx}
          onConnections={() => navigate("connections")}
          onOpenSetup={() => navigate("setup")}
          onStatus={onFaidStatus}
          onServices={onFaidServices}
          onOpenTerminal={() => setTerminalOpen(true)}
        />
      </>
    );
  } else if (route === "connections") {
    page = (
      <>
        {dataLoaded && <SetupNotice setup={setup} onOpen={() => navigate("setup")} />}
        <ScreenConnections ctx={ctx} setCtx={setCtx} />
      </>
    );
  } else if (route === "figaf-tool") {
    page = flowActive
      ? renderFlow("← Figaf Tool overview")
      : <ScreenFigafToolHub ctx={ctx} onStartFlow={startFlow} onGoSession={() => navigate("session")} />;
  } else if (route === "session") {
    page = <ScreenSession ctx={ctx} setCtx={setCtx} appendLog={appendLog} addBtpFromRoute={sub === ADD_BTP_SUBROUTE} />;
  } else if (route === "about") {
    page = (
      <ScreenAbout
        ctx={ctx}
        setCtx={setCtx}
        onRunChecks={() => {
          setCtx((c) => ({ ...c, prereqs: c.prereqs.map((p) => ({ ...p, status: "pending" })), prereqsStarted: false }));
          runConsoleChecks(setCtx);
        }}
      />
    );
  }

  const prereqFailed = (ctx.prereqs || []).some((p) => p.status === "error");
  const updateAvailable = !!(ctx.selfUpdate && ctx.selfUpdate.check && ctx.selfUpdate.check.ok && ctx.selfUpdate.check.updateAvailable);
  const aboutBadge = prereqFailed ? "an environment check failed" : (updateAvailable ? "a manager update is available" : null);

  const currentStepId = flowActive && route === "figaf-tool" ? STEPS[Math.min(step, STEPS.length - 1)].id : route;
  const suppressSelfUpdate =
    typeof window !== "undefined" && window.figafIsLongRunningFlow
      ? window.figafIsLongRunningFlow(ctx, currentStepId)
      : false;

  const setupSub = !dataLoaded ? null : setup ? (setup.complete ? "complete" : `${setup.done} of ${setup.total} done`) : null;

  return (
    <WinFrame>
      <ConsoleRail
        activeRoute={route}
        onNavigate={navigate}
        flowActive={flowActive}
        aboutBadge={aboutBadge}
        ctx={ctx}
        xsuaaMode={xsuaaMode}
        setup={setup}
        setupSub={setupSub}
        setupDot={!!(dataLoaded && setup && !setup.complete)}
        version={
          (typeof window !== "undefined" && window.figafVersion) ||
          (ctx.selfUpdate && ctx.selfUpdate.check ? ctx.selfUpdate.check.current : null)
        }
      />
      <div className="pane">
        <SelfUpdateBanner ctx={ctx} setCtx={setCtx} suppress={suppressSelfUpdate} />
        {page}
        <TerminalDrawer
          open={terminalOpen}
          onToggle={() => setTerminalOpen((o) => !o)}
          lines={logs}
          currentCmd={currentCmd}
        />
      </div>
      {ctx.selfUpdate && ctx.selfUpdate.preflightOpen && (
        <UpdatePreflightModal
          onClose={() => setCtx((c) => ({ ...c, selfUpdate: { ...c.selfUpdate, preflightOpen: false } }))}
        />
      )}
    </WinFrame>
  );
}

// The step model of the Setup (setup-checklist.js) plus the console's
// navigation actions per step. Never null once the model script is loaded:
// the model copes with missing inputs.
function buildSetupChecklist(data, { navigate }) {
  const build = typeof window !== "undefined" ? window.figafSetupSteps : null;
  if (typeof build !== "function") return null;
  const result = build(data || {}, { ssoDone: consoleXsuaaMode() });
  const actions = {
    "prepare": () => navigate("setup"),
    "mgmt-user": () => navigate("setup"),
    "services": () => navigate("setup"),
    "platform": () => navigate("apps"),
    "figaf-connection": () => navigate("connections"),
  };
  for (const s of result.steps) s.action = actions[s.id] || null;
  return result;
}

Object.assign(window, { ConsoleFrame });
