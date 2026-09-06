/* global React, ReactDOM,
   WinFrame, StepperRail, WizardFooter, TerminalDrawer,
   ScreenWelcome, ScreenLogin, ScreenChoice, ScreenConfig, ScreenProgress, ScreenDeploy, ScreenDone,
   ScreenXsuaaUpgrade, ScreenXsuaaAssignRole,
   ScreenUpdateConfig, ScreenUpdateProgress,
   ScreenConnectProvision, ScreenConnectIdp,
   ScreenConnectIdpSuser, ScreenConnectIdpPassport, ScreenConnectIdpIas,
   ScreenConnectIdpCustomTrust, ScreenConnectIdpCustomAssign,
   ScreenL3Apps, ScreenConnections, ConsoleFrame,
   UpdatePreflightModal, SelfUpdateBanner */

function App() {
  const [step, setStepRaw] = React.useState(0);
  const [terminalOpen, setTerminalOpen] = React.useState(false);

  const isHosted = window.figafModeFlags.isHosted;
  // Console frame (hosted): persistent navigation instead of the wizard.
  // Desktop keeps the wizard — it really is a one-time installer.
  const consoleUI = !!(isHosted && window.figafModeFlags.features.consoleUI);

  const [ctx, setCtx] = React.useState({
    prereqsStarted: false,
    deployStarted: false,
    prereqs: isHosted ? [
      // In hosted mode the CLIs are bundled and disk is irrelevant; only check Docker Hub
      { id: "btp",  status: "pending", title: "SAP BTP CLI",          sub: "bundled in container" },
      { id: "cf",   status: "pending", title: "Cloud Foundry CLI",    sub: "bundled in container" },
      { id: "net",  status: "pending", title: "Docker Hub reachable", sub: "hub.docker.com · latest Figaf image tag" },
      { id: "disk", status: "pending", title: "Container ready",      sub: "filesystem check" },
    ] : [
      { id: "btp",  status: "pending", title: "SAP BTP CLI",          sub: "btp login detected on PATH" },
      { id: "cf",   status: "pending", title: "Cloud Foundry CLI",    sub: "cf login detected on PATH" },
      { id: "net",  status: "pending", title: "Docker Hub reachable", sub: "hub.docker.com · latest Figaf image tag" },
      { id: "disk", status: "pending", title: "Disk space",           sub: "≥ 2 GB available for deployment artifacts" },
    ],
    login: {
      // Hosted: the boot effect below always tries an automatic sign-in
      // (session resume, then stored user). Starting in "trying" keeps the
      // console's gate from flashing the login form on every reload.
      autoStatus: isHosted ? "trying" : undefined,
      btpStatus: "idle",
      cfStatus: "idle",
      // CF-only mode: operator skipped BTP login and connects straight to
      // Cloud Foundry. Gates the choice screen down to Update-only.
      cfOnly: false,
      passcodeRequested: false,
      passcode: "",
      // Explanation of the last cf-login failure, when the server had one
      // (for example: no role in the manager's own space).
      cfError: "",
      user: "",
      landscape: "",
      apiUrl: "",
      subaccount: "",
      subdomain: "",
      provider: "",
      org: "",
      space: "",
    },
    choice: null,
    config: {
      id: "figaf-tool",
      domain: "",
      locationId: "",
      dbPlan: "trial",
      dockerVersion: "",
      instanceMemory: "3700M",
      maxRamPercentage: "50",
      logsTotalSizeCap: "2GB",
      enableInstanceMonitoring: true,
      useCloudConnectorForSmtpIntegration: false,
      cloudConnectorDestinationNameForSmtpIntegration: "",
      // PostgreSQL service params (db.json). trialPg is undefined until
      // ScreenConfig seeds it from the login subdomain; dbParams collects the
      // per-field overrides the operator types into the form.
      trialPg: undefined,
      dbParams: {},
    },
    dbPlans: [
      { name: "trial",       description: "Trial PostgreSQL service offering",              free: true,  size: "shared" },
      { name: "development", description: "Small dev database · single AZ · 4 GB storage", free: false, size: "S"    },
      { name: "standard",    description: "Production · HA · 32 GB storage · backups",      free: false, size: "M"    },
    ],
    tasks: [
      { id: "vars",  status: "pending", title: "Update vars.yml",                     sub: "ID · LANDSCAPE_APPS_DOMAIN · LOCATION_ID · DOCKER_IMAGE_VERSION" },
      { id: "db",    status: "pending", title: "Create PostgreSQL service",             sub: "cf create-service postgresql-db · poll every 10s" },
      { id: "xsuaa", status: "pending", title: "Create XSUAA service (figaf-xsuaa)",   sub: "cf create-service xsuaa application" },
      { id: "roles", status: "pending", title: "Assign role collection",               sub: "btp assign security/role-collection IRTAdmin (after XSUAA)" },
    ],
    pushStatus: "idle",
    pushStarted: false,
    // Populated by ScreenUpdateConfig + ScreenUpdateProgress when the
    // operator picks the "Update Figaf Tool" branch on the choice screen.
    update: {
      deployId: "figaf-tool",
      detection: null,
      availableTags: [],
      targetTag: "",
      skipXsuaa: false,
      // vars.yml fields seeded from the LIVE app via update:readCurrentConfig
      // (not the template defaults) so an update never silently changes memory,
      // domain, location, or SMTP settings. strategy picks the cf push mode.
      vars: {},
      strategy: "recreate",
      resumeState: null,
      previousImage: null,
      verify: null,
    },
    // Populated by the Connect-to-Integration-Suite branch (ScreenConnect*).
    // tasks: 4-row checklist driving ScreenConnectProvision.
    // keys: parsed service-key JSONs; cleared when the operator backs out.
    // idpMode: selected on ScreenConnectIdp, drives which stub renders next.
    connect: {
      marketplaceOk: null,
      tasks: [
        { id: "create-api",   status: "pending", title: "Create it-rt/api service",              sub: "cf create-service it-rt api figaf-api" },
        { id: "create-iflow", status: "pending", title: "Create it-rt/integration-flow service", sub: "cf create-service it-rt integration-flow figaf-iflow" },
        { id: "key-api",      status: "pending", title: "Create + fetch API service key",        sub: "cf create-service-key + cf service-key" },
        { id: "key-iflow",    status: "pending", title: "Create + fetch iFlow service key",      sub: "cf create-service-key + cf service-key" },
      ],
      keys: { api: null, iflow: null },
      idpMode: null,
      iasUrl: null,
      // Custom-IDP branch state.
      idpName: "figaf-saml",
      samlGroup: "Admin",
      originKey: null,
      trustList: null,
      piRoles: [
        { id: "PI_Administrator",         status: "pending" },
        { id: "PI_Business_Expert",       status: "pending" },
        { id: "PI_Integration_Developer", status: "pending" },
      ],
      sso: { status: "idle", url: null, alias: null, error: null },
    },
    // Self-update — wizard's own update banner / pre-flight modal state.
    // Populated by update:checkSelf in PR 5 and the preflight modal in PR 2.
    selfUpdate: {
      preflightOpen: false,
    },
  });

  const [logs, setLogs] = React.useState([
    { type: "dim", text: "# Figaf Manager" },
    { type: "dim", text: "# Ready to check environment" },
  ]);
  const appendLog = React.useCallback((lines) => {
    setLogs(prev => [...prev, ...lines]);
  }, []);

  // Subscribe to main-process CLI stream
  React.useEffect(() => {
    const api = typeof window !== "undefined" ? window.figaf : null;
    if (!api || !api.on) return;
    const typeMap = { cmd: "cmd", line: "out", err: "err", ok: "ok", warn: "warn", dim: "dim" };
    const off = api.on("cli:line", (msg) => {
      if (!msg) return;
      const t = typeMap[msg.type] || "out";
      setLogs(prev => [...prev, { type: t, text: msg.text }]);
    });
    return () => off && off();
  }, []);

  // Expose imperative open/close for the self-update pre-flight modal so PR 2
  // is testable via DevTools before the banner (PR 5) is wired:
  //   window.figafShowPreflight()  → opens
  //   window.figafHidePreflight()  → closes
  React.useEffect(() => {
    window.figafShowPreflight = () =>
      setCtx(c => ({ ...c, selfUpdate: { ...c.selfUpdate, preflightOpen: true } }));
    window.figafHidePreflight = () =>
      setCtx(c => ({ ...c, selfUpdate: { ...c.selfUpdate, preflightOpen: false } }));
    return () => {
      delete window.figafShowPreflight;
      delete window.figafHidePreflight;
    };
  }, []);

  // Lane-1 routing: `#/apps` is the L3 dashboard's own address and
  // `#/connections` the system-connections page's. The target is remembered
  // here and consumed by the navigation effect below once a cf login exists
  // (resumed, auto, or manual).
  const pendingRoute = React.useRef(
    typeof window === "undefined" ? null :
    window.location.hash === "#/apps" ? "manage" :
    window.location.hash === "#/connections" ? "connections" : null
  );

  // Session resume — runs ONCE at app start. A page reload must not force an
  // authenticated operator back through Welcome/Sign-in: if the server-side
  // session still holds a working cf login (verified with a real `cf target`),
  // seed the login context and open directly on "What would you like to do?".
  // Resumes in CF-only mode; the operator can still go Back to add BTP login.
  React.useEffect(() => {
    const api = typeof window !== "undefined" ? window.figaf : null;
    if (!api || !api.session || !api.session.state) return;
    let cancelled = false;
    // The console's auth gate shows "connecting…" while this runs, instead of
    // flashing the sign-in form. Cleared on every exit path below.
    const clearAuto = () => {
      if (!cancelled && consoleUI) {
        setCtx(c => ({ ...c, login: { ...c.login, autoStatus: undefined } }));
      }
    };
    if (consoleUI) {
      setCtx(c => ({ ...c, login: { ...c.login, autoStatus: "trying" } }));
    }
    (async () => {
      let s = null;
      try { s = await api.session.state(); } catch { clearAuto(); return; }
      if (cancelled) return;
      // No live session: try the stored management user. In the console this
      // always runs (a console signs itself in); in the wizard only for a
      // deep link (#/apps bookmark). Safe: the page itself is behind IAS SSO
      // + the operator role, and the button does the same in one click.
      if ((!s || !s.ok || !s.cfLoggedIn) && (consoleUI || pendingRoute.current) && api.login) {
        try {
          const st = await api.login.storedUserStatus();
          if (!cancelled && st && st.available) {
            const r = await api.login.withStoredUser();
            if (!cancelled && r && r.ok) {
              const m2 = /^https?:\/\/api\.(.+)\.hana\.ondemand\.com/i.exec(r.apiUrl || "");
              setCtx(c => ({
                ...c,
                login: {
                  ...c.login,
                  autoStatus: undefined,
                  cfOnly: true,
                  cfStatus: "done", // the navigation effect below routes to #/apps
                  user: r.user || "",
                  org: r.org || "",
                  space: r.space || "",
                  apiUrl: r.apiUrl || "",
                  landscape: m2 ? m2[1] : c.login.landscape,
                },
              }));
              return;
            }
          }
        } catch { /* fall through to the normal flow */ }
        clearAuto();
        return;
      }
      if (!s || !s.ok || !s.cfLoggedIn) { clearAuto(); return; }
      const apiUrl = s.apiUrl || "";
      const m = /^https?:\/\/api\.(.+)\.hana\.ondemand\.com/i.exec(apiUrl);
      // When the server session also holds a BTP login, resume it too — so
      // Deploy / Connect / SSO-upgrade stay available after a reload.
      const btp = s.btp && s.btp.loggedIn ? s.btp : null;
      setCtx(c => ({
        ...c,
        login: {
          ...c.login,
          autoStatus: undefined,
          cfOnly: !btp,
          cfStatus: "done",
          btpStatus: btp ? "done" : c.login.btpStatus,
          landscape: (btp && btp.landscape) || (m ? m[1] : c.login.landscape),
          subaccount: (btp && btp.subaccount) || c.login.subaccount,
          subdomain: (btp && btp.subdomain) || c.login.subdomain,
          provider: (btp && btp.provider) || c.login.provider,
          user: s.user || "",
          org: s.org || "",
          space: s.space || "",
          apiUrl,
        },
      }));
      // Wizard only: land on "What would you like to do?". The console derives
      // its page from the address hash instead.
      if (!consoleUI && !pendingRoute.current) setStepRaw(2); // baseSteps: 0 welcome · 1 login · 2 choice
      // (with a pending #/apps target, the navigation effect below jumps further)
    })();
    return () => { cancelled = true; };
  }, []);

  // Navigation effect for the #/apps and #/connections deep links: the moment
  // a cf login exists (resumed, stored-user, or typed passcode), consume the
  // pending target and open the right manage-lane page directly.
  React.useEffect(() => {
    if (consoleUI) return; // the console routes by hash itself
    if (ctx.login.cfStatus !== "done" || !pendingRoute.current) return;
    const target = pendingRoute.current;
    pendingRoute.current = null;
    setCtx(c => ({ ...c, choice: "manage" }));
    // baseSteps(3) + manageSteps → index 3 = l3-apps, index 4 = l3-connections
    setStepRaw(target === "connections" ? 4 : 3);
  }, [ctx.login.cfStatus]);


  // Self-update version check — runs ONCE at app start. The result feeds both
  // the welcome-screen check row (<SelfUpdateCheckRow/>) and the floating
  // banner (<SelfUpdateBanner/>), so we fetch once and share via ctx. Fails
  // open: a 404/network error becomes { ok:false }, which the views render as
  // a neutral "unreachable" state — never a hard error, never a blocked wizard.
  React.useEffect(() => {
    const api = typeof window !== "undefined" ? window.figaf : null;
    if (!api || !api.update || !api.update.checkSelf) return;
    let cancelled = false;
    (async () => {
      let result;
      try { result = await api.update.checkSelf(); }
      catch (e) { result = { ok: false, error: (e && e.message) || "check failed" }; }
      if (!cancelled) setCtx(c => ({ ...c, selfUpdate: { ...c.selfUpdate, check: result } }));
    })();
    return () => { cancelled = true; };
  }, []);

  const baseSteps = [
    { id: "welcome",  label: "Welcome",            sub: "Check prerequisites" },
    { id: "login",    label: "Sign in",            sub: "BTP · Cloud Foundry" },
    { id: "choice",   label: "Choose action",      sub: "Deploy or connect" },
  ];

  const deploySteps = [
    { id: "config",   label: "Configuration",      sub: "vars.yml · DB plan" },
    { id: "progress", label: "Provision",          sub: "Services & roles" },
    { id: "deploy",   label: "Deploy",             sub: "cf push" },
    { id: "done",     label: "Finish",             sub: "Open Figaf Tool" },
  ];

  const connectTail =
    ctx.connect.idpMode === "custom-idp"
      ? [
          { id: "connect-idp-custom-trust",  label: "Create trust",  sub: "Cockpit SAML config" },
          { id: "connect-idp-custom-assign", label: "Assign & link", sub: "Roles · SSO URL" },
        ]
      : [{ id: "connect-idp-stub", label: "Configure", sub: "Mode-specific setup" }];

  const connectSteps = [
    { id: "connect-provision", label: "Provision",   sub: "it-rt · service keys" },
    { id: "connect-idp",       label: "BTP access",  sub: "Pick auth mode" },
    ...connectTail,
    { id: "done",              label: "Finish",      sub: "Integration Suite linked" },
  ];

  // v2: dedicated branch for the XSUAA upgrade flow. Entered either from
  // ScreenChoice (third option, hosted+token mode) or from ScreenDone after
  // a deploy finishes.
  const xsuaaSteps = [
    { id: "xsuaa-upgrade",     label: "Authentication",  sub: "Create XSUAA + approuter" },
    { id: "xsuaa-assign-role", label: "Role assignment", sub: "Cockpit deep-link" },
    { id: "done",              label: "Finish",          sub: "Persistent SSO live" },
  ];

  const updateSteps = [
    { id: "updateConfig",   label: "Configure update", sub: "Target tag · advanced vars" },
    { id: "updateProgress", label: "Apply update",     sub: "XSUAA · rolling push · verify" },
    { id: "done",           label: "Finish",           sub: "New image live" },
  ];

  // L3 App Manager (PoC): dashboard + connections, not a wizard tail.
  const manageSteps = [
    { id: "l3-apps",        label: "Manage apps", sub: "Install · update · disable" },
    { id: "l3-connections", label: "Connections", sub: "Figaf tool · SAP systems" },
  ];

  // The stepper rail shows only the 3 base steps (Welcome / Sign in / Choose
  // action) until the operator picks an option on the choice screen. As soon
  // as ctx.choice flips, STEPS expands to include the chosen branch's tail.
  const STEPS =
    ctx.choice === "deploy"        ? [...baseSteps, ...deploySteps] :
    ctx.choice === "connect"       ? [...baseSteps, ...connectSteps] :
    ctx.choice === "xsuaa-upgrade" ? [...baseSteps, ...xsuaaSteps] :
    ctx.choice === "update"        ? [...baseSteps, ...updateSteps] :
    ctx.choice === "manage"        ? [...baseSteps, ...manageSteps] :
    baseSteps;

  const currentStep = Math.min(step, STEPS.length - 1);
  const setStep = (n) => setStepRaw(Math.max(0, Math.min(STEPS.length - 1, n)));

  const maxReached = Math.max(currentStep, 0);
  const currentCmd = logs.slice().reverse().find(l => l.type === "cmd")?.text || "Ready.";

  const next = () => setStep(currentStep + 1);
  const back = () => setStep(currentStep - 1);

  // Renders the screen for a step id. The wizard frame uses it for every
  // step; the console frame reuses it for the Figaf Tool flow tails, so the
  // flow screens stay identical in both frames.
  const renderScreenById = (id) => {
    switch (id) {
      case "welcome":           return <ScreenWelcome ctx={ctx} setCtx={setCtx} onNext={next} />;
      case "login":             return <ScreenLogin ctx={ctx} setCtx={setCtx} onNext={next} appendLog={appendLog} />;
      case "choice":            return <ScreenChoice ctx={ctx} setCtx={setCtx} onNext={next} onBack={back} />;
      case "config":            return <ScreenConfig ctx={ctx} setCtx={setCtx} onNext={next} onBack={back} appendLog={appendLog} />;
      case "progress":          return <ScreenProgress ctx={ctx} setCtx={setCtx} onNext={next} onBack={back} appendLog={appendLog} />;
      case "deploy":            return <ScreenDeploy ctx={ctx} setCtx={setCtx} onNext={next} onBack={back} appendLog={appendLog} />;
      case "xsuaa-upgrade":     return <ScreenXsuaaUpgrade ctx={ctx} setCtx={setCtx} onNext={next} onBack={back} setStep={setStepRaw} STEPS={STEPS} />;
      case "xsuaa-assign-role": return <ScreenXsuaaAssignRole ctx={ctx} setCtx={setCtx} onNext={next} onBack={back} />;
      case "l3-apps":           return <ScreenL3Apps ctx={ctx} setCtx={setCtx} onBack={back} onConnections={next} />;
      case "l3-connections":    return <ScreenConnections ctx={ctx} setCtx={setCtx} onBack={back} />;
      case "updateConfig":      return <ScreenUpdateConfig ctx={ctx} setCtx={setCtx} onNext={next} onBack={back} />;
      case "updateProgress":    return <ScreenUpdateProgress ctx={ctx} setCtx={setCtx} onNext={next} onBack={back} />;
      case "connect-provision": return <ScreenConnectProvision ctx={ctx} setCtx={setCtx} onNext={next} onBack={back} appendLog={appendLog} />;
      case "connect-idp":       return <ScreenConnectIdp ctx={ctx} setCtx={setCtx} onNext={next} onBack={back} />;
      case "connect-idp-stub":
        switch (ctx.connect && ctx.connect.idpMode) {
          case "s-user":       return <ScreenConnectIdpSuser    ctx={ctx} setCtx={setCtx} onNext={next} onBack={back} />;
          case "sap-passport": return <ScreenConnectIdpPassport ctx={ctx} setCtx={setCtx} onNext={next} onBack={back} />;
          case "ias":          return <ScreenConnectIdpIas      ctx={ctx} setCtx={setCtx} onNext={next} onBack={back} />;
          default:             return null;
        }
      case "connect-idp-custom-trust":  return <ScreenConnectIdpCustomTrust  ctx={ctx} setCtx={setCtx} onNext={next} onBack={back} />;
      case "connect-idp-custom-assign": return <ScreenConnectIdpCustomAssign ctx={ctx} setCtx={setCtx} onNext={next} onBack={back} appendLog={appendLog} />;
      case "done":              return <ScreenDone ctx={ctx} setCtx={setCtx} setStep={setStepRaw} STEPS={STEPS} />;
      default: return null;
    }
  };
  const Screen = renderScreenById(STEPS[currentStep].id);

  const currentStepId = STEPS[currentStep] && STEPS[currentStep].id;

  // Keep the address bar honest: the L3 dashboard carries #/apps, the
  // connections page #/connections; leaving them clears the hash.
  // replaceState avoids polluting the browser history.
  React.useEffect(() => {
    if (typeof window === "undefined") return;
    if (consoleUI) return; // the console owns the address bar
    const OWN_HASHES = { "l3-apps": "#/apps", "l3-connections": "#/connections" };
    const wanted = OWN_HASHES[currentStepId];
    if (wanted) {
      if (window.location.hash !== wanted) window.history.replaceState(null, "", wanted);
    } else if (Object.values(OWN_HASHES).includes(window.location.hash) && !pendingRoute.current) {
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
    }
  }, [currentStepId]);
  // Suppress the floating banner during long-running flows AND on the welcome
  // screen — on welcome the in-checklist <SelfUpdateCheckRow/> owns the
  // presentation (desktop carries its own Download button; cloud defers to
  // this banner after login), so a second floating CTA there would be
  // redundant.
  const suppressSelfUpdate =
    currentStepId === "welcome" ||
    (typeof window !== "undefined" && window.figafIsLongRunningFlow
      ? window.figafIsLongRunningFlow(ctx, currentStepId)
      : false);

  if (consoleUI) {
    return (
      <ConsoleFrame
        app={{
          ctx, setCtx, logs, appendLog,
          step: currentStep, setStepRaw, STEPS, renderScreenById,
          terminalOpen, setTerminalOpen, currentCmd,
        }}
      />
    );
  }

  return (
    <WinFrame>
      <StepperRail
        steps={STEPS}
        current={currentStep}
        maxReached={maxReached}
        onNavigate={(i) => setStep(i)}
        version={
          (typeof window !== "undefined" && window.figafVersion) ||
          (ctx.selfUpdate && ctx.selfUpdate.check ? ctx.selfUpdate.check.current : null)
        }
      />
      <div className="pane">
        <SelfUpdateBanner
          ctx={ctx}
          setCtx={setCtx}
          suppress={suppressSelfUpdate}
        />
        {Screen}
        <TerminalDrawer
          open={terminalOpen}
          onToggle={() => setTerminalOpen(o => !o)}
          lines={logs}
          currentCmd={currentCmd}
        />
      </div>
      {ctx.selfUpdate && ctx.selfUpdate.preflightOpen && (
        <UpdatePreflightModal
          onClose={() => setCtx(c => ({ ...c, selfUpdate: { ...c.selfUpdate, preflightOpen: false } }))}
        />
      )}
    </WinFrame>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
