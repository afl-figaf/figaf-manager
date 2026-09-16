/* global React, Ico, CheckRow, ScreenLogin, BaseServicesCard, FaidActionOutcome, InfoHint, Disclosure */
// Console page: Setup (#/setup) - docs/faid-apps-console/SPEC.md section 6.
// ONE page owns the installation of a fresh space. The steps come from the
// pure model (setup-checklist.js, built by console.jsx); this file renders
// them and gives each open step its body:
//   1 Prepare the space   plans + role assignment + the run (prepare-space.js).
//                         The two CLI sign-ins are NOT in here: they live in
//                         the band above the checklist (ScreenLogin band),
//                         because a session is a precondition, not a step.
//   2 Management user     the store form (no passcode button on this page)
//   3 Base services       the panel of screen-faid-apps.jsx (status + repair)
//   4 / 5                 a button to the page where the work happens
// Written for a person who sees the manager for the first time on an empty
// space: one visible path, the next button is always the obvious one.

const fgSetup = () => (typeof window !== "undefined" && window.figaf) || null;
const setupXsuaaMode = () => typeof window !== "undefined" && window.figafXsuaaMode === true;

// Step 1's run state (ctx.prepareSpace). Here as a fallback only: app.jsx
// seeds it. See PrepareSpaceStep for why it does not live in the component.
const EMPTY_PREPARE = { started: false, phases: [], error: null, outcome: null };

// Short, factual notes per plan. The catalog names the plans; the manager
// never picks a paid plan by itself.
const PLAN_NOTES = {
  "postgresql-db": { free: "for trials and demos, small limits", trial: "the plan of a BTP trial account, small limits", standard: "paid plan, for real use" },
  credstore:       { free: "one instance per subaccount, small limits", trial: "the plan of a BTP trial account, small limits", standard: "paid plan, for real use" },
  connectivity:    { lite: "free" },
  destination:     { lite: "free" },
};

// Optional service groups (catalog v4, decision 0011). A group is a set of
// instances the platform needs only for a certain kind of system, so the
// person turns it on; nothing optional is created unless they do.
const SERVICE_GROUPS = {
  pipo: {
    title: "Also create the services for on-premise PI/PO systems",
    short: "Two free instances, shared with the Figaf tool. Leave this off if you have no PI or PO system.",
    text: "SAP PI and PO systems are reached through the SAP Cloud Connector. That needs two free service instances "
        + "(connectivity and destination). They are SHARED with the Figaf tool: if it already created them in this "
        + "space, they are reused, never replaced. You can add them later in Base services, which then restarts the "
        + "shared backend once.",
  },
};
function groupInfo(key) {
  return SERVICE_GROUPS[key] || { title: `Also create the optional services (${key})`, short: "", text: "" };
}
// The plans to offer for an instance that does not exist yet: the ones this
// LANDSCAPE really has (faid:services asks `cf marketplace -e`), else the
// module's full list when it could not be read. A BTP trial has no `free`
// plan, so showing the module's list there offered a plan that cannot be
// created (2026-09-14).
function offeredPlans(s) {
  const avail = s && s.availablePlans;
  return avail && avail.length ? avail : ((s && s.plans) || []);
}
// The plan a row will be created with unless the person picks another one.
function defaultPlan(s) {
  const list = offeredPlans(s);
  return list.includes(s.plan) ? s.plan : (list[0] || s.plan);
}
function planNote(offering, plan) {
  const o = PLAN_NOTES[offering];
  return (o && o[plan]) || "";
}

// The consequence of an own-role database (catalog v6, decision 0012 section
// 10). The line that explains why the backend needs no password of yours stays
// visible; what it means for an instance you already have is one click away.
function DatabaseAccessNote({ s, exists, others }) {
  const bound = (s.boundApps || []).filter(Boolean);
  const more = bound.length > 0 || (others && others.length > 0);
  return (
    <>
      <span style={{ display: "block", fontSize: 12, color: "var(--ink-3)" }} data-database-note="">
        {exists ? "Reused as it is." : "Created with the plan above (about 7 minutes, in the background)."}{" "}
        The FAID backend gets its own role <span className="kbd">faid_app</span>, limited to schema <span className="kbd">faid</span>; it never binds this instance.
      </span>
      {more && (
        <Disclosure label="What that means for this instance">
          {bound.length > 0 && (
            <p>
              Bound today: <strong>{bound.join(", ")}</strong>. Every app bound to this instance runs as <span className="kbd">dbo</span> and
              keeps full access, including schema <span className="kbd">faid</span>.
            </p>
          )}
          {bound.length > 0 && (
            <p>One backup and restore point for everything in this instance; plan, connection limit and engine version are shared.</p>
          )}
          {others && others.length > 0 && <p>Other PostgreSQL instances in this space: {others.join(", ")}.</p>}
        </Disclosure>
      )}
    </>
  );
}

// ── Step 1, part 1: which plans, and which instance for an editable name. One
// dropdown per MISSING instance with more than one plan; existing instances are
// shown as they are. A service with `nameEditable` (the database, base-services.js)
// gets a text field: the catalog name is the default; the space's PostgreSQL
// instance is prefilled when there is one; the person may type any name.
function ServicePlansPanel({ services, plans, setPlans, groups, setGroups, names, setNames, onNamesChanged, nameError, disabled }) {
  if (services === null) {
    return (
      <div className="setup-panel" data-panel="service-plans">
        <div className="setup-panel-title">Service plans</div>
        <div style={{ color: "var(--ink-3)", fontSize: 13 }}>Checking the service instances of the platform…</div>
      </div>
    );
  }
  if (!services || services.length === 0) return null;
  // Optional instances are not part of the plan list: they are decided by the
  // group checkboxes below, and their plans are free with no choice.
  const required = services.filter((s) => !s.optional);
  const optionalGroups = [];
  for (const s of services) {
    if (s.optional && s.group && !optionalGroups.includes(s.group)) optionalGroups.push(s.group);
  }
  const choosable = required.filter((s) => s.status === "missing" && offeredPlans(s).length > 1);
  const toggleGroup = (key, on) => setGroups((prev) => {
    const next = (prev || []).filter((g) => g !== key);
    if (on) next.push(key);
    return next;
  });
  return (
    <div className="setup-panel" data-panel="service-plans">
      <div className="setup-panel-title">Service plans</div>
      <p className="setup-panel-text">
        The service instances the Figaf Platform needs. {choosable.length
          ? "Pick the plan for each one that does not exist yet — plans that cost money are your decision."
          : "They all exist already; this step only binds them and adds the current roles."}
      </p>
      {required.map((s) => {
        const exists = s.status !== "missing";
        const plan = plans[s.name] || defaultPlan(s);
        const canChoose = !exists && offeredPlans(s).length > 1;
        const editable = !!s.nameEditable;
        const instanceName = s.instanceName || s.name;
        const typed = names && names[s.name] != null ? names[s.name] : instanceName;
        const others = (s.candidates || []).map((c) => c.name).filter((n) => n !== instanceName);
        const note = planNote(s.offering, exists ? (s.actualPlan || s.plan) : plan);
        return (
          <div key={s.name} className="setup-plan-row is-compact" data-service={s.name} data-instance={instanceName}>
            <div className="setup-plan-name">
              {editable ? (
                <input
                  className="input is-mono"
                  data-instance-name={s.name}
                  value={typed}
                  disabled={disabled}
                  spellCheck={false}
                  title="The name of the PostgreSQL service instance. Default figaf-db; an existing instance (for example the Figaf Tool's) is used as it is; a new name is created."
                  onChange={(e) => setNames((p) => ({ ...(p || {}), [s.name]: e.target.value }))}
                  onBlur={() => onNamesChanged && onNamesChanged()}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); onNamesChanged && onNamesChanged(); } }}
                />
              ) : instanceName}
            </div>
            <div className="setup-plan-purpose">{s.purpose || s.offering}</div>
            <div className="setup-plan-state">
              {exists && <span className="pill green">exists</span>}
              {exists && <span className="plan-note">plan {s.actualPlan || s.plan}</span>}
              {!exists && !canChoose && <span className="plan-note">plan {defaultPlan(s)}</span>}
              {canChoose && (
                <select
                  className="select"
                  value={plan}
                  disabled={disabled}
                  onChange={(e) => setPlans((p) => ({ ...p, [s.name]: e.target.value }))}
                >
                  {offeredPlans(s).map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
              )}
            </div>
            <div className="setup-plan-hint">
              <InfoHint label={`About ${instanceName}`} align="end">
                {exists ? (
                  <>This instance already exists in the space and is reused, never replaced.{note ? <> Its plan <span className="kbd">{s.actualPlan || s.plan}</span>: {note}.</> : null}</>
                ) : (
                  <>
                    Does not exist yet — this step creates it.{note ? <> Plan <span className="kbd">{plan}</span>: {note}.</> : null}
                    {canChoose ? " A plan that costs money is your decision; the manager never picks one for you." : " There is only one plan to pick from."}
                  </>
                )}
              </InfoHint>
            </div>
            {(editable || (nameError && nameError.name === s.name)) && (
              <div className="setup-plan-extra">
                {editable && <DatabaseAccessNote s={s} exists={exists} others={others} />}
                {nameError && nameError.name === s.name && (
                  <div className="setup-plan-error" data-name-error="">{nameError.error}</div>
                )}
              </div>
            )}
          </div>
        );
      })}
      {optionalGroups.map((key) => {
        const info = groupInfo(key);
        const members = services.filter((s) => s.optional && s.group === key);
        const on = (groups || []).includes(key);
        const present = members.filter((s) => s.status !== "missing");
        const boxId = `setup-group-${key}`;
        return (
          <div key={key} className="setup-option-row" data-service-group={key}>
            <input
              id={boxId}
              type="checkbox"
              checked={on}
              disabled={disabled}
              data-group-checkbox={key}
              onChange={(e) => toggleGroup(key, e.target.checked)}
            />
            <label className="setup-option-title" htmlFor={boxId}>{info.title}</label>
            <div className="setup-option-hint">
              <InfoHint label={info.title} align="end" side="up">{info.text}</InfoHint>
            </div>
            {info.short && <div className="setup-option-sub">{info.short}</div>}
            <div className="setup-option-sub">
              {members.map((s) => `${s.name} (${s.offering}, plan ${s.plan})`).join(" · ")}
              {present.length > 0 && ` — already in this space: ${present.map((s) => s.name).join(", ")}`}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Step 1, part 2: the role assignment decision, made BEFORE the run
// (run #4 finding 2). Plan from sso-role-assign.js. One line says where it
// stands; the consequence of skipping it is one click away, not four
// paragraphs on the page.
function RoleAssignPanel({ plan, autoAssign, setAutoAssign, assignTo, setAssignTo, emailOk, roleName, onAddBtp, btpBusy }) {
  return (
    <div className="setup-panel" data-panel="role-assign">
      <div className="setup-panel-title">Role assignment</div>
      {plan === null && <div style={{ color: "var(--ink-2)", fontSize: 13 }}>Checking the BTP login of this session…</div>}
      {plan && !plan.available && (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <span className="pill gray">{plan.reason === "no-btp-login" ? "no BTP login" : "check failed"}</span>
            <span style={{ fontSize: 13, color: "var(--ink-2)", flex: 1, minWidth: 220 }}>
              This step cannot assign <code>{roleName}</code> for you. You can prepare the space anyway and assign the role yourself.
            </span>
            {plan.reason === "no-btp-login" && (
              <button className="btn" data-action="add-btp" onClick={onAddBtp} disabled={btpBusy}>
                {btpBusy ? <><Ico.Spinner /> Connecting…</> : <>Add BTP login</>}
              </button>
            )}
          </div>
          <Disclosure label="What you have to do instead">
            {plan.notice && <p>{plan.notice}</p>}
            <p>
              Add the role collection to your user in the BTP cockpit (subaccount → Security → Users) before you
              sign in again; otherwise the sign-in ends in a 403.
            </p>
          </Disclosure>
        </>
      )}
      {plan && plan.available && (
        <>
          <label style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer", fontSize: 13 }}>
            <input type="checkbox" checked={autoAssign} onChange={(e) => setAutoAssign(e.target.checked)} />
            <span style={{ fontWeight: 600, color: "var(--ink-0)", flex: 1 }}>Assign {roleName} automatically</span>
            <InfoHint label="What the automatic assignment runs" align="end">
              Runs <code>btp assign security/role-collection {roleName}</code> for the person below, right after the XSUAA
              instance exists. Without it the next sign-in ends in a 403 until the role is assigned in the cockpit
              (subaccount → Security → Users).
            </InfoHint>
          </label>
          {autoAssign && (
            <div className="field" style={{ marginTop: 10, maxWidth: 440 }}>
              <label className="field-label">Assign to (e-mail of the person who will sign in)</label>
              <input className="input is-mono" data-field="assign-to" autoComplete="off" placeholder="you@example.com"
                value={assignTo} onChange={(e) => setAssignTo(e.target.value)} />
              {plan.notice && <div style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 6 }}>{plan.notice}</div>}
              {!emailOk && (
                <div style={{ fontSize: 12, color: "var(--error, #b91c1c)", marginTop: 6 }}>
                  Enter the e-mail of a person. The step does not start without it while the automatic assignment is on.
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// Cockpit deep link for the manual role assignment (failure path).
function CockpitAssignLink({ roleName }) {
  const [url, setUrl] = React.useState(null);
  React.useEffect(() => {
    const api = fgSetup();
    if (!api || !api.xsuaa || !api.xsuaa.assignRoleCollectionPreflight) return;
    api.xsuaa.assignRoleCollectionPreflight().then((r) => { if (r && r.ok) setUrl(r.url); }).catch(() => {});
  }, []);
  return (
    <span>
      Open the BTP cockpit{url ? <> (<a href={url} target="_blank" rel="noopener noreferrer">user management of this subaccount</a>)</> : null},
      find your user, and assign <code>{roleName}</code>. Then click Continue.
    </span>
  );
}

// ── Step 1: Prepare the space.
function PrepareSpaceStep({ ctx, setCtx, appendLog, services, servicesError, onServicesChanged }) {
  const api = fgSetup();
  const signedIn = ctx.login.cfStatus === "done";
  const [plans, setPlans] = React.useState({});
  // Optional service groups the person ticked (catalog v4, decision 0011).
  // Empty by default: nothing optional is created unless it is asked for.
  const [groups, setGroups] = React.useState([]);
  // Editable instance names (catalog v6: the database). `names` holds what the
  // person typed per catalog name; `named` the faid:services answer for those
  // names (status of the typed instance), shown instead of the page's list.
  const [names, setNames] = React.useState({});
  const [named, setNamed] = React.useState(null);
  const [nameError, setNameError] = React.useState(null);
  const shownServices = named || services;
  const refreshNamed = React.useCallback(async () => {
    if (!api || !api.faid || !api.faid.services) return;
    const sent = {};
    for (const [k, v] of Object.entries(names || {})) if (String(v || "").trim()) sent[k] = String(v).trim();
    try {
      const r = await api.faid.services({ names: sent });
      if (r && r.ok) { setNamed(r.services || null); setNameError(null); }
      else if (r && r.error) setNameError({ name: Object.keys(sent)[0] || "", error: r.error });
    } catch (e) {
      setNameError({ name: Object.keys(sent)[0] || "", error: e.message });
    }
  }, [api, names]);
  const [precheck, setPrecheck] = React.useState(null);
  const [autoAssign, setAutoAssign] = React.useState(false);
  const [assignTo, setAssignTo] = React.useState("");
  // The run (phases, error, outcome) lives in ctx, NOT in this component. The
  // console renders one page at a time, so leaving #/setup unmounts this step
  // while the run keeps going - it is one promise over the RPC surface, and
  // nothing cancels it. ctx belongs to <App/> and survives the route change,
  // so coming back shows the live phases instead of an empty step.
  const prep = ctx.prepareSpace || EMPTY_PREPARE;
  const { phases, started, error, outcome } = prep;
  const patchPrep = React.useCallback((patch) => {
    setCtx((c) => {
      const cur = c.prepareSpace || EMPTY_PREPARE;
      return { ...c, prepareSpace: { ...cur, ...(typeof patch === "function" ? patch(cur) : patch) } };
    });
  }, [setCtx]);
  // A started run verified the target before it began, so a remount mid-run
  // keeps that answer instead of probing again (the probe would fail while
  // the manager is restaging).
  const [spaceCheck, setSpaceCheck] = React.useState(() =>
    prep.started ? { status: "ok", data: null, error: null } : { status: "checking", data: null, error: null });
  const roleName = (outcome && outcome.roleName) || "FAID-Manager-Admin";

  const rolePlan = React.useMemo(() => {
    if (precheck === null) return null;
    const fn = typeof window !== "undefined" && window.figafRoleAssignPlan;
    return typeof fn === "function" ? fn(precheck) : { available: false, autoAssign: false, prefillUser: "", reason: "precheck-failed", notice: "" };
  }, [precheck]);
  const emailOk = React.useMemo(() => {
    const fn = typeof window !== "undefined" && window.figafIsEmailLike;
    return typeof fn === "function" ? fn(assignTo) : /^[^\s@]+@[^\s@]+$/.test(String(assignTo || "").trim());
  }, [assignTo]);

  // Both checks need the cf login; they run (again) whenever it appears, and
  // never while the run is in flight (see spaceCheck above).
  React.useEffect(() => {
    if (!signedIn || !api || started) return;
    let cancelled = false;
    setPrecheck(null);
    if (api.xsuaa && api.xsuaa.roleAssignmentPrecheck) {
      api.xsuaa.roleAssignmentPrecheck().then((r) => { if (!cancelled) setPrecheck(r || { ok: false, error: "no answer" }); })
        .catch((e) => { if (!cancelled) setPrecheck({ ok: false, error: e.message }); });
    } else {
      setPrecheck({ ok: false, error: "precheck unavailable" });
    }
    setSpaceCheck({ status: "checking", data: null, error: null });
    if (api.update && api.update.selfTarget) {
      api.update.selfTarget().then((r) => {
        if (cancelled) return;
        if (!r || r.ok === false) { setSpaceCheck({ status: "error", data: null, error: (r && r.error) || "could not read cf target" }); return; }
        const m = r.mismatch || {};
        const matched = r.loggedIn && !m.apiUrl && !m.org && !m.space;
        setSpaceCheck({ status: matched ? "ok" : "mismatch", data: r, error: null });
      }).catch((e) => { if (!cancelled) setSpaceCheck({ status: "error", data: null, error: e.message }); });
    } else {
      setSpaceCheck({ status: "error", data: null, error: "cf-target probe unavailable" });
    }
    return () => { cancelled = true; };
  }, [signedIn, ctx.login.btpStatus, started]);

  React.useEffect(() => {
    if (!rolePlan) return;
    setAutoAssign(rolePlan.autoAssign);
    setAssignTo(rolePlan.prefillUser || "");
  }, [rolePlan]);

  React.useEffect(() => {
    if (started) return;
    const build = typeof window !== "undefined" && window.figafPrepareSpacePhases;
    patchPrep({ phases: typeof build === "function" ? build(autoAssign) : [] });
  }, [autoAssign, started, patchPrep]);

  const markPhase = React.useCallback((id, status, sub) => {
    patchPrep((r) => ({
      phases: r.phases.map((p) => (p.id === id ? { ...p, status, sub: sub === undefined ? p.sub : sub } : p)),
    }));
  }, [patchPrep]);

  // Live service status lines while the XSUAA instance is created.
  React.useEffect(() => {
    if (!api || !api.on) return;
    const off = api.on("cf:serviceStatus", (msg) => {
      if (msg && /xsuaa/.test(String(msg.name || ""))) markPhase("create-xsuaa", "running", `${msg.name}: ${msg.status}`);
    });
    return () => { off && off(); };
  }, [markPhase]);

  const spaceOk = spaceCheck.status === "ok";
  const canStart = signedIn && spaceOk && rolePlan !== null && services !== null && !servicesError && (!autoAssign || emailOk) && !nameError;

  async function run() {
    if (!canStart || started) return;
    const runner = typeof window !== "undefined" && window.figafRunPrepareSpace;
    if (typeof runner !== "function") { patchPrep({ error: "prepare-space.js is not loaded" }); return; }
    patchPrep({ started: true, error: null, outcome: null });
    setCtx((c) => ({ ...c, setupRunning: true }));
    // Only the plans of instances that do not exist yet are sent, and only
    // the ones this landscape offers a choice of (a single-plan landscape
    // sends nothing and lets the manager pick that plan).
    const chosen = {};
    for (const s of shownServices || []) {
      if (s.status === "missing" && offeredPlans(s).length > 1) chosen[s.name] = plans[s.name] || defaultPlan(s);
    }
    // The typed instance names (catalog v6); empty = the default.
    const sentNames = {};
    for (const [k, v] of Object.entries(names || {})) if (String(v || "").trim()) sentNames[k] = String(v).trim();
    try {
      const r = await runner({ api, plans: chosen, names: sentNames, groups, autoAssign, assignTo, onPhase: markPhase });
      if (!r.ok) { patchPrep({ error: r.error }); return; }
      patchPrep({ outcome: { ...r, managerMode: r.alreadyBound ? "xsuaa" : null } });
      setCtx((c) => ({ ...c, xsuaaUpgradeInitiated: true }));
      if (onServicesChanged) onServicesChanged();
    } catch (e) {
      patchPrep({ error: "Unexpected: " + e.message });
    } finally {
      setCtx((c) => ({ ...c, setupRunning: false }));
    }
  }

  // After the restage: wait until the manager answers in XSUAA mode before
  // offering Continue (a too-early click lands on the old token page).
  React.useEffect(() => {
    if (!outcome || outcome.managerMode === "xsuaa") return;
    let cancelled = false;
    const startedAt = Date.now();
    async function tick() {
      if (cancelled) return;
      try {
        const r = await fetch("/_manager-health", { cache: "no-store", credentials: "same-origin" });
        let body = null;
        try { body = await r.json(); } catch { /* not json yet */ }
        if (r.ok && body && body.mode === "xsuaa") { patchPrep((p) => (p.outcome ? { outcome: { ...p.outcome, managerMode: "xsuaa" } } : {})); return; }
      } catch { /* offline while restaging */ }
      if (Date.now() - startedAt > 5 * 60 * 1000) { patchPrep((p) => (p.outcome ? { outcome: { ...p.outcome, managerMode: "timeout" } } : {})); return; }
      setTimeout(tick, 4000);
    }
    const h = setTimeout(tick, 3000);
    return () => { cancelled = true; clearTimeout(h); };
  }, [outcome ? (outcome.managerMode === "xsuaa" ? "done" : "polling") : "idle"]);

  // A FULL document load is the whole point: the approuter now owns the public
  // route, and only a real navigation goes through the SAP IAS sign-in.
  // `location.href = "/#/setup"` does NOT do that - the page is already at
  // "/#/setup", so the browser treats it as a same-document fragment
  // navigation and nothing happens at all (verified in Chromium/Edge). Set the
  // hash, then reload.
  function continueAfterRestart() {
    try {
      window.location.hash = "#/setup";
      window.location.reload();
    } catch (_) { /* defensive */ }
  }
  // The BTP login is added in place, exactly like the band's own button: the
  // band (one ScreenLogin instance) is subscribed to btp:gaChoice and renders
  // the pickers. Navigating away and back would lose this page's state.
  const btpBusy = ctx.login.btpStatus === "running";
  async function addBtpLogin() {
    if (!api || !api.btp || btpBusy) return;
    setCtx((c) => ({ ...c, login: { ...c.login, btpStatus: "running" } }));
    try {
      await api.btp.loginStart();
    } catch (e) {
      setCtx((c) => ({ ...c, login: { ...c.login, btpStatus: "error" } }));
      appendLog([{ type: "err", text: "BTP sign-in could not be started: " + e.message }]);
    }
  }

  if (!signedIn) {
    return (
      <div className="setup-step-body" data-body="prepare-signin">
        <p className="setup-lead">
          {ctx.login.autoStatus === "trying"
            ? "Connecting to Cloud Foundry…"
            : <>This step needs your Cloud Foundry sign-in. Use <strong>Connect to CF and BTP</strong> above — a one-time passcode is enough.</>}
        </p>
      </div>
    );
  }

  let spaceRow;
  if (spaceCheck.status === "checking") {
    spaceRow = <CheckRow key="cf-target" status="running" title="Checking the Cloud Foundry target" sub="the manager and its approuter must live in the same space" />;
  } else if (spaceCheck.status === "ok") {
    // No data after a remount mid-run (the probe is skipped then): the login
    // in ctx names the same space.
    const t = (spaceCheck.data && spaceCheck.data.target) || { orgName: ctx.login.org, spaceName: ctx.login.space };
    spaceRow = <CheckRow key="cf-target" status="done" title="Signed in to the manager's space" sub={`${t.orgName} / ${t.spaceName}`} />;
  } else if (spaceCheck.status === "error") {
    spaceRow = <CheckRow key="cf-target" status="error" title="Could not verify the Cloud Foundry target" sub={spaceCheck.error || "cf target check failed"} />;
  } else {
    const d = spaceCheck.data || {};
    const t = d.target || {};
    const cur = d.current || {};
    spaceRow = (
      <CheckRow key="cf-target" status="error" title="Wrong Cloud Foundry target"
        sub={<>Expected <strong>{t.orgName} / {t.spaceName}</strong>. {d.loggedIn ? <>You are on <strong>{cur.orgName} / {cur.spaceName}</strong>.</> : "You are not signed in."} Sign out on Session &amp; access and sign in to the manager's space.</>} />
    );
  }

  return (
    <div className="setup-step-body" data-body="prepare">
      {!started && (
        <>
          {servicesError ? (
            // The release could not be read (a catalog older than v7, the store
            // unreachable): no instance can be listed or created. Shown where
            // the plans would be; the step never hides a failure.
            <div className="setup-panel" data-panel="service-plans-error">
              <div className="setup-panel-title">Service plans</div>
              <p className="setup-box-note is-warn" data-services-error="">
                <strong>The release could not be read, so the service instances cannot be listed or created.</strong> {servicesError}
                <br />Point the manager at a release it can read (the release store or a local release directory), then reload this page.
                The terminal drawer shows what was read.
              </p>
            </div>
          ) : (
            <ServicePlansPanel services={shownServices} plans={plans} setPlans={setPlans} groups={groups} setGroups={setGroups}
              names={names} setNames={setNames} onNamesChanged={refreshNamed} nameError={nameError} disabled={started} />
          )}
          <RoleAssignPanel plan={rolePlan} autoAssign={autoAssign} setAutoAssign={setAutoAssign} assignTo={assignTo}
            setAssignTo={setAssignTo} emailOk={emailOk} roleName={roleName} onAddBtp={addBtpLogin} btpBusy={btpBusy} />
        </>
      )}

      {/* Before the run the phases are a reveal behind one summary line; once it
          starts they ARE the progress and stay open. A cf-target problem is
          never hidden: that row shows outside the reveal until it is ok. */}
      {started ? (
        <div className="task-list">
          {spaceRow}
          {phases.map((p) => <CheckRow key={p.id} status={p.status} title={p.label} sub={p.sub || ""} />)}
        </div>
      ) : (
        <>
          {!spaceOk && <div className="task-list">{spaceRow}</div>}
          <div className="setup-runplan" data-runplan="">
            <span>
              <strong>{phases.length} command{phases.length === 1 ? "" : "s"}</strong> · about 4 minutes · the manager is
              offline 30-90 s at the end · the database keeps being created in the background
            </span>
            <span className="spacer" />
            <Disclosure label="Show the commands" openLabel="Hide the commands">
              <div className="task-list">
                {spaceOk ? spaceRow : null}
                {phases.map((p) => <CheckRow key={p.id} status={p.status} title={p.label} sub={p.sub || ""} />)}
              </div>
            </Disclosure>
          </div>
        </>
      )}

      {error && (
        <div className="setup-box is-error" role="alert">
          <strong>Prepare the space failed.</strong> {error}
          <div style={{ marginTop: 6, color: "var(--ink-2)" }}>
            The terminal drawer has the last Cloud Foundry lines. Fix the cause and click the button again; every part
            that already succeeded is skipped.
          </div>
        </div>
      )}

      {outcome && (
        <div className="setup-box is-ok" data-outcome="prepare-done">
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
            <Ico.Check style={{ width: 18, height: 18, color: "var(--ok, #15803d)" }} />
            <strong style={{ color: "var(--ink-0)", fontSize: 14 }}>
              {outcome.managerMode === "xsuaa" ? "The space is prepared. The manager is back." : "The space is prepared. The manager is restarting…"}
            </strong>
          </div>
          <p>
            {outcome.managerMode === "xsuaa"
              ? "Click Continue: the page reloads on the public URL and SAP IAS asks you to sign in."
              : "The approuter now serves the public URL; the manager restarts once (30-90 s). Continue unlocks when it is back."}
            {outcome.assignFailed
              ? <> The role assignment <strong style={{ color: "var(--error, #b91c1c)" }}>did not succeed</strong>.</>
              : outcome.assignSkipped
                ? <> The automatic role assignment was skipped: add <code>{roleName}</code> to your user in the BTP cockpit before you continue, or the sign-in ends in a 403.</>
                : <> <code>{roleName}</code> was assigned to <code>{outcome.assignedTo || "your user"}</code>.</>}
          </p>
          {outcome.managerMode === "timeout" && (
            <p className="setup-box-note">The manager did not report the new mode within 5 minutes. You can still click Continue; if the old token page appears, check <code>cf app figaf-manager</code> in the cockpit and run this step again.</p>
          )}
          <p><strong>Next:</strong> after the SAP IAS sign-in this page opens on step 2 and asks for the management user. No second passcode.</p>
          {outcome.servicesWarning && (
            <p className="setup-box-note is-warn" data-services-warning="">
              <strong>The base services did not complete:</strong> {outcome.servicesWarning}
              <br />After the IAS sign-in, sign in to Cloud Foundry with a passcode once more (step 2 offers it) and repair the instances in step 3 (create, bind to manager, restart).
            </p>
          )}
          {outcome.assignFailed && (
            <p className="setup-box-note is-warn">
              <strong>Assignment error:</strong> {outcome.assignFailed}
              <br /><CockpitAssignLink roleName={roleName} />
            </p>
          )}
        </div>
      )}

      <div className="setup-actions">
        {!started && (
          <button className="btn btn-primary" data-action="prepare" onClick={run} disabled={!canStart}
            title={spaceCheck.status === "checking" ? "Checking the Cloud Foundry target…"
              : !spaceOk ? "Sign in to the manager's Cloud Foundry space first"
              : rolePlan === null ? "Checking the BTP login of this session…"
              : services === null ? "Checking the service instances…"
              : servicesError ? "The release could not be read; the instances cannot be created (see above)"
              : (autoAssign && !emailOk) ? "Enter the e-mail the role goes to, or switch the automatic assignment off"
              : "Create the instances, turn on SAP IAS sign-in, restart the manager once"}>
            <Ico.Shield /> {autoAssign ? "Prepare the space" : "Prepare the space without role assignment"}
          </button>
        )}
        {started && !outcome && !error && <button className="btn btn-primary" disabled><Ico.Spinner /> Preparing…</button>}
        {started && error && <button className="btn btn-primary" onClick={() => patchPrep({ started: false, error: null })}>Try again</button>}
        {outcome && outcome.managerMode === "xsuaa" && (
          <button className="btn btn-primary" data-action="continue" onClick={continueAfterRestart}>Continue <Ico.ArrowRight /></button>
        )}
        {outcome && outcome.managerMode === "timeout" && (
          <button className="btn btn-primary" onClick={continueAfterRestart}>Continue anyway <Ico.ArrowRight /></button>
        )}
        {outcome && !outcome.managerMode && (
          <button className="btn btn-primary" disabled><Ico.Spinner /> Waiting for the manager…</button>
        )}
      </div>
    </div>
  );
}

// ── Step 2: Management user. The form, and the manager signs itself in with
// the stored user right away. The passcode fallback is the band above (one
// ScreenLogin owns both CLIs; a second instance here would subscribe to the
// login events twice and open the browser twice).
function ManagementUserStep({ ctx, setCtx, appendLog, stored, onStored }) {
  const api = fgSetup();
  const signedIn = ctx.login.cfStatus === "done";
  const bindingPresent = !!(stored && stored.bindingPresent);
  const [username, setUsername] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState(null);

  async function store() {
    if (!api || busy) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.login.storeManagementUser({ username: username.trim(), password });
      if (!r || !r.ok) { setMsg({ ok: false, text: (r && r.error) || "storing failed" }); return; }
      setPassword("");
      appendLog([{ type: "ok", text: `Management user ${r.username} verified and stored.` }]);
      if (!signedIn) {
        const s = await api.login.withStoredUser();
        if (s && s.ok) {
          const m = /^https?:\/\/api\.(.+)\.hana\.ondemand\.com/i.exec(s.apiUrl || "");
          setCtx((c) => ({ ...c, login: { ...c.login, autoStatus: undefined, cfOnly: true, cfStatus: "done", user: s.user || "", org: s.org || "", space: s.space || "", apiUrl: s.apiUrl || "", landscape: m ? m[1] : c.login.landscape } }));
          setMsg({ ok: true, text: `Stored. The manager signed in as ${r.username}.` });
        } else {
          setMsg({ ok: false, text: `Stored, but the sign-in with it failed: ${(s && s.error) || "unknown error"}` });
        }
      } else {
        setMsg({ ok: true, text: "Verified against Cloud Foundry and stored." });
      }
      if (onStored) onStored();
    } catch (e) {
      setMsg({ ok: false, text: e.message });
    } finally {
      setBusy(false);
    }
  }

  if (stored === null || stored === undefined) {
    return <div className="setup-step-body" style={{ color: "var(--ink-3)", fontSize: 13 }}>Checking the Credential Store…</div>;
  }

  if (!bindingPresent) {
    return (
      <div className="setup-step-body" data-body="mgmt-user-no-binding">
        <p className="setup-lead">
          The manager is not bound to a Credential Store, so no user can be stored yet. Sign in with a one-time
          passcode and repair the Credential Store in step 3 (create, bind to manager, restart). Then come back here.
        </p>
      </div>
    );
  }

  return (
    <div className="setup-step-body" data-body="mgmt-user">
      <div className="setup-panel">
        <div className="setup-panel-title">Store the management user</div>
        <div className="setup-hint-line">
          <p className="setup-panel-text" style={{ margin: 0 }}>A dedicated technical account, never a person's.</p>
          <InfoHint label="What the account needs, and what happens to the password" align="end">
            Space Developer in this space, password login, no two-factor authentication. The manager verifies it
            against Cloud Foundry, then stores it encrypted in the Credential Store. The password never appears in
            the terminal or the logs.
          </InfoHint>
        </div>
        <div className="field" style={{ marginBottom: 8, maxWidth: 440 }}>
          <label className="field-label">Technical user e-mail</label>
          <input className="input is-mono" data-field="mgmt-username" autoComplete="off" placeholder="figaf-manager-tech@example.com"
            value={username} onChange={(e) => setUsername(e.target.value)} disabled={busy} />
        </div>
        <div className="field" style={{ marginBottom: 10, maxWidth: 440 }}>
          <label className="field-label">Password</label>
          <input className="input is-mono" data-field="mgmt-password" type="password" autoComplete="new-password"
            value={password} onChange={(e) => setPassword(e.target.value)} disabled={busy} />
        </div>
        <button className="btn btn-primary" data-action="store-mgmt-user" onClick={store} disabled={busy || !username.trim() || !password}>
          {busy ? <><Ico.Spinner /> Verifying &amp; storing…</> : <>Verify &amp; store</>}
        </button>
        {msg && <div style={{ marginTop: 8, fontSize: 13, color: msg.ok ? "var(--ok, #15803d)" : "var(--error, #b91c1c)" }}>{msg.text}</div>}
      </div>
      {!signedIn && (
        <div style={{ marginTop: 10, fontSize: 12, color: "var(--ink-3)" }} data-action="passcode-instead">
          No technical user at hand? Sign in with a one-time passcode in <strong>Connect to CF and BTP</strong> above
          — you will then need a passcode again after every restart, until a user is stored here.
        </div>
      )}
    </div>
  );
}

// ── Step 3: Base services - the panel of screen-faid-apps.jsx, plus the
// self-refresh while an instance is being created.
function BaseServicesStep({ ctx, services, onRefresh, onOpenTerminal }) {
  const api = fgSetup();
  const signedIn = ctx.login.cfStatus === "done";
  const [busy, setBusy] = React.useState(null);
  const [outcome, setOutcome] = React.useState(null);

  const creating = !!(services && services.some((s) => s.status === "in-progress"));
  React.useEffect(() => {
    if (!signedIn || !creating) return;
    const h = setInterval(() => { onRefresh && onRefresh(); }, 10_000);
    return () => clearInterval(h);
  }, [signedIn, creating, onRefresh]);

  const [dbNote, setDbNote] = React.useState(null); // the last database action's result line

  async function serviceAction(kind, fn) {
    if (busy) return;
    setBusy(kind);
    setOutcome(null);
    if (/^database-/.test(kind)) setDbNote(null);
    try {
      const r = await fn();
      if (r && !r.ok && r.error) {
        const build = (typeof window !== "undefined" && window.figafActionOutcome) || null;
        const input = { action: kind, appName: "Base services", result: r, managerVersion: window.figafVersion, org: ctx.login.org, space: ctx.login.space, at: new Date().toISOString() };
        setOutcome(build ? build(input) : { ok: false, title: `${kind} failed`, facts: [{ label: "Error", value: r.error }], report: JSON.stringify(input, null, 2), at: input.at });
      } else if (r && r.ok && kind === "database-prepare") {
        setDbNote(`Database access prepared on ${r.instanceName}: role ${r.role}, schema ${r.schema}, entry written.${r.verify && r.verify.note ? " " + r.verify.note : ""}${r.passwordReused ? " The existing password was kept." : ""}`);
      } else if (r && r.ok && kind === "database-rotate") {
        setDbNote(`Password rotated on ${r.instanceName}.${r.restarted ? ` ${r.restarted} was restarted and reads the new entry.` : " The backend reads it at its next start."}`);
      } else if (r && r.ok && kind === "database-drop") {
        setDbNote(`Schema faid and role faid_app dropped on ${r.instanceName}; the entry was deleted.`);
      }
      return r;
    } finally {
      setBusy(null);
      if (kind !== "restart" && onRefresh) onRefresh();
    }
  }

  if (!signedIn) {
    return <div className="setup-step-body" style={{ color: "var(--ink-3)", fontSize: 13 }}>The state of the instances shows once the manager is signed in to Cloud Foundry (step 2).</div>;
  }
  return (
    <div className="setup-step-body" data-body="services">
      <FaidActionOutcome outcome={outcome} onDismiss={() => setOutcome(null)} onOpenTerminal={onOpenTerminal} />
      {dbNote && <div className="setup-box is-ok" data-database-outcome="" style={{ marginBottom: 10 }}>{dbNote}</div>}
      <BaseServicesCard
        services={services}
        busy={busy}
        onRefresh={onRefresh}
        onDatabasePrepare={api.faid.databasePrepare ? (instanceName) => serviceAction("database-prepare", () => api.faid.databasePrepare({ instanceName })) : null}
        onDatabaseRotate={api.faid.databaseRotate ? () => serviceAction("database-rotate", () => api.faid.databaseRotate()) : null}
        onDatabaseDrop={api.faid.databaseDrop ? () => serviceAction("database-drop", () => api.faid.databaseDrop({ confirm: true })) : null}
        onProvision={(plans, only) => serviceAction("provision", () => api.faid.provisionServices(only && only.length ? { plans, only } : { plans }))}
        onBind={(name) => serviceAction("bind", () => api.faid.bindManagerService({ name }))}
        onBindPlatform={api.faid.bindPlatformService
          ? (name) => serviceAction("bind-platform", () => api.faid.bindPlatformService({ name }))
          : null}
        onRestart={() => serviceAction("restart", () => api.faid.restartSelf())}
      />
    </div>
  );
}

// ── The page. Two parts: the sign-in band (the sessions the installation
// runs on — a precondition, not a step) and the checklist. Exactly one step is
// expanded at a time, so the whole installation fits on a screen.
function ScreenSetupPage({ ctx, setCtx, appendLog, data, setup, navigate, onRefreshExternal, onRefreshCf, onOpenTerminal, releaseVersion }) {
  // `null` = follow the current step; a step id = the person opened that one;
  // "" = they collapsed everything. Declared before the early return: hooks
  // may not sit behind a condition.
  const [openStep, setOpenStep] = React.useState(null);
  if (!setup) return null;
  const services = data && data.services ? (data.services.ok ? data.services.services : []) : null;
  // faid:services failed: the release could not be read. Step 1 says so
  // instead of showing no instances (setup-checklist.js carries the same text).
  const servicesError = data && data.services && data.services.ok === false ? String(data.services.error || "the release could not be read") : "";
  const stored = data ? (data.stored === undefined ? null : data.stored) : null;

  const expandedId = openStep === null ? (setup.current ? setup.current.id : null) : openStep;
  const toggleStep = (id) => () => setOpenStep(expandedId === id ? "" : id);

  const bodyFor = (s) => {
    if (s.done) return null;
    switch (s.id) {
      case "prepare":
        return s.current ? <PrepareSpaceStep ctx={ctx} setCtx={setCtx} appendLog={appendLog} services={services} servicesError={servicesError} onServicesChanged={onRefreshCf} /> : null;
      case "mgmt-user":
        return s.current ? <ManagementUserStep ctx={ctx} setCtx={setCtx} appendLog={appendLog} stored={stored} onStored={onRefreshExternal} /> : null;
      case "services":
        return !s.blocked ? <BaseServicesStep ctx={ctx} services={services} onRefresh={onRefreshCf} onOpenTerminal={onOpenTerminal} /> : null;
      case "platform":
      case "figaf-connection":
        return !s.blocked && s.cta ? (
          <div className="setup-step-body">
            <button className="btn btn-primary" onClick={s.action}>{s.cta}</button>
          </div>
        ) : null;
      default:
        return null;
    }
  };

  return (
    <div className="pane-body setup-page">
      <div className="pane-head">
        <div className="pane-eyebrow">Setup</div>
        <h1 className="pane-title">Set up this installation</h1>
        <p className="pane-desc">
          {setup.total} steps, in this order. Open a step to see what it does and what it needs; the next button is
          always on the current step. Every command runs as plain <span className="kbd">cf</span> / <span className="kbd">btp</span> calls
          — the terminal drawer below shows them as they run.
        </p>
      </div>

      {/* The sign-in band. ONE ScreenLogin owns both CLIs for the whole page:
          a second instance would subscribe to btp:ssoUrl twice and open the
          browser twice. */}
      <ScreenLogin ctx={ctx} setCtx={setCtx} onNext={() => {}} appendLog={appendLog} band />

      <div className="card setup-checklist" data-setup-page="">
        <div className="setup-head">
          <div style={{ fontWeight: 700 }}>{setup.complete ? "Installation complete" : "Installation progress"}</div>
          <span className={`pill ${setup.complete ? "green" : "blue"}`} data-setup-progress="">
            {setup.complete ? "complete" : `${setup.done} of ${setup.total} done`}
          </span>
          {releaseVersion && <span className="setup-hint">release {releaseVersion}</span>}
        </div>
        {setup.steps.map((s) => {
          // A done step has nothing left to reveal: one line, no chevron.
          const collapsible = !s.done;
          const open = collapsible ? expandedId === s.id : false;
          const state = s.done ? "is-done" : s.current ? "is-current" : s.blocked ? "is-blocked" : "is-open";
          const head = (
            <>
              <div className="setup-title">
                <span>{s.n}. {s.title}</span>
                {s.done && <span className="pill green">done</span>}
                {!s.done && s.current && <span className="pill blue">current step</span>}
                {!s.done && !s.current && s.blocked && <span className="pill gray">{s.blocked}</span>}
              </div>
              {/* Collapsed, the why-line is trimmed to one line; expanded, the
                  step says in full what it does and what it needs. Nothing is
                  dropped, only tiered. */}
              {collapsible && !open && s.why && <div className="setup-summary">{s.why}</div>}
              {open && s.why && <div className="setup-why">{s.why}</div>}
              {open && s.when && <div className="setup-when">{s.when}</div>}
            </>
          );
          return (
            <div key={s.id} data-step={s.id}
              className={`setup-step ${state}${collapsible ? (open ? " is-expanded" : " is-collapsed") : ""}`}>
              <div className="setup-num">{s.done ? <Ico.Check /> : s.n}</div>
              <div className="setup-body">
                {collapsible ? (
                  <div className="setup-step-head" role="button" tabIndex={0} aria-expanded={open}
                    onClick={toggleStep(s.id)}
                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleStep(s.id)(); } }}>
                    <div style={{ flex: 1, minWidth: 0 }}>{head}</div>
                    <span className="setup-chev"><Ico.Chev /></span>
                  </div>
                ) : head}
                {open && bodyFor(s)}
              </div>
            </div>
          );
        })}
        {setup.complete && (
          <div className="setup-box is-ok" style={{ marginTop: 12 }}>
            <strong>Everything is in place.</strong> The manager signs itself in, the apps run, the connections are stored.
            This page stays here as the status of the installation; a missing instance can be repaired in step 3.
            <div style={{ marginTop: 10 }}>
              <button className="btn btn-primary" onClick={() => navigate("apps")}>Open FAID Apps</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

Object.assign(window, { ScreenSetupPage });
