/* global React, Ico, WizardFooter, CheckRow */

// ═══════════════════════════════════════════════════════════
// v2: XSUAA upgrade — auth-gate-implementation-plan.md §2
// ═══════════════════════════════════════════════════════════
//
// Two screens, both hosted-only:
//
//   ScreenXsuaaUpgrade
//     Runs phase 1 (create xsuaa, push approuter), phase 2 (map/unmap route),
//     the optional self-assign step, and phase 3 (bind+restage). The screen
//     does NOT auto-redirect after restage initiates — the operator must
//     click "Continue to wizard" to navigate to /, at which point the
//     approuter triggers IAS sign-in (yielding a fresh JWT that includes
//     the just-assigned scope).
//
//     Subscribes to xsuaa:upgradePhase + cf:serviceStatus events. Reads
//     pre-state via xsuaa:upgradeStatus so a resumed upgrade picks up where
//     it left off (the manager dyno may have restarted mid-flow).
//
//   ScreenXsuaaAssignRole
//     Manual-assignment fallback. Only reached if the auto-assign step in
//     ScreenXsuaaUpgrade fails — the upgrade screen routes the operator
//     here via onNext in that case. Deep-links to the BTP cockpit's
//     user-management page.

const fg = () => (typeof window !== "undefined" && window.figaf) || null;

// Phase rows rendered on the upgrade screen. "assign-role" is conditional
// (only shown when the checkbox is on). Kept as a const array so the
// rendering loop stays declarative.
//
// Why assign-role sits immediately AFTER create-xsuaa (not after map-route):
// xs-security.json declares the role-collections inline, so they're
// materialized atomically when `cf create-service xsuaa application` reaches
// status: succeeded. The collections are then assignable via `btp assign
// security/role-collection` against state.subaccount/state.user — no
// dependency on the approuter being pushed, on routes being swapped, or on
// the manager being restaged. Running it here guarantees the assignment
// commits BEFORE the approuter starts enforcing XSUAA on the public route
// (map-route unmaps the manager and the next browser request is bounced to
// IAS); otherwise the operator would re-authenticate, get a JWT without the
// scope, and the auto-assign would land too late to matter for that session.
//
// Decision 0009 (2026-09-03): ONE XSUAA instance (figaf-faid-xsuaa) carries the
// roles of the manager and the apps, and this step runs FIRST in a fresh
// space. The Credential Store is created and bound here too (no restart yet),
// so the restage at the end activates it and the management user can be
// stored right after the IAS sign-in - one token, one passcode, one restart.
const ALL_PHASES = [
  { id: "create-xsuaa",     label: "Prepare the XSUAA instance",           sub: "cf create-service / update-service xsuaa application figaf-faid-xsuaa — roles of the manager and the apps" },
  { id: "assign-role",      label: "Assign role collection",               sub: "btp assign security/role-collection (optional)" },
  { id: "manager-services", label: "Create and bind the Credential Store", sub: "cf create-service credstore + cf bind-service figaf-manager — active after the restage" },
  { id: "push-approuter",   label: "Deploy approuter",                     sub: "cf push figaf-manager-approuter (bundled in zip)" },
  { id: "map-route",        label: "Hand off public route",                sub: "approuter now serves the public route" },
  { id: "restage",          label: "Restage manager",                      sub: "manager rebinds to XSUAA — 30-90s downtime expected" },
];

// The role collection we self-assign (shared instance, decision 0009). Admin
// includes Operator (its role template references both scopes), so this single
// assignment covers both. The server reports the collection of the bound
// instance in xsuaa:upgradeStatus (legacy installations differ); this constant
// is the display default.
const ASSIGN_ROLE = "FAID-Manager-Admin";

function ScreenXsuaaUpgrade({ ctx, setCtx, onNext, onBack, setStep, STEPS }) {
  // The automatic role assignment is decided BEFORE "Start upgrade" (run #4
  // finding 2, docs/faid-apps-console/SPEC.md "Role assignment in the SSO upgrade"): the
  // server says whether a BTP login exists in THIS session and who the cf user
  // is; the pure plan (sso-role-assign.js) turns that into the panel below.
  // Local state, not threaded through global ctx; frozen once the run starts.
  const [autoAssign, setAutoAssign] = React.useState(true);
  const [precheck, setPrecheck] = React.useState(null);   // null = still asking the server
  const [assignTo, setAssignTo] = React.useState("");      // e-mail the role goes to
  const plan = React.useMemo(() => {
    if (precheck === null) return null;
    const fn = typeof window !== "undefined" && window.figafRoleAssignPlan;
    if (typeof fn === "function") return fn(precheck);
    // Module not loaded (desktop bundle): keep the old behavior.
    return { available: true, autoAssign: true, prefillUser: (ctx.login && ctx.login.user) || "", needsUserInput: false, reason: "", notice: "" };
    // eslint-disable-next-line
  }, [precheck]);
  const emailOk = React.useMemo(() => {
    const fn = typeof window !== "undefined" && window.figafIsEmailLike;
    return typeof fn === "function" ? fn(assignTo) : /^[^\s@]+@[^\s@]+$/.test(String(assignTo || "").trim());
  }, [assignTo]);

  React.useEffect(() => {
    let cancelled = false;
    const api = fg();
    if (!api || !api.xsuaa || !api.xsuaa.roleAssignmentPrecheck) {
      setPrecheck({ ok: false, error: "precheck unavailable" });
      return;
    }
    api.xsuaa.roleAssignmentPrecheck().then((r) => {
      if (!cancelled) setPrecheck(r || { ok: false, error: "no answer" });
    }).catch((e) => {
      if (!cancelled) setPrecheck({ ok: false, error: e.message });
    });
    return () => { cancelled = true; };
  }, []);

  // Apply the plan once it exists: the switch default and the prefilled e-mail.
  React.useEffect(() => {
    if (!plan) return;
    setAutoAssign(plan.autoAssign);
    setAssignTo(plan.prefillUser || "");
  }, [plan]);

  // "Add BTP login first": Session & access opens with the BTP sign-in form
  // (console route #/session/add-btp); when the login completes, the console
  // returns to #/session/sso-upgrade and this screen re-runs its check.
  function addBtpLoginFirst() {
    if (typeof window !== "undefined") window.location.hash = "#/session/add-btp";
  }

  // Initial phase set respects the checkbox value at mount. We refresh it
  // when autoAssign toggles BEFORE the upgrade starts (started=false).
  const buildPhases = React.useCallback((includeAssign) =>
    ALL_PHASES
      .filter(p => p.id !== "assign-role" || includeAssign)
      .map(p => ({ ...p, status: "pending" })),
  []);
  const [phases, setPhases] = React.useState(() => buildPhases(true));
  const [started, setStarted] = React.useState(false);
  const [error, setError] = React.useState(null);
  // outcome: null while running; after success:
  //   { restaging: true, assignFailed: <reason|null>, managerMode: "token"|"xsuaa"|null }
  // managerMode is updated by the post-restage poll against /_manager-health.
  // Until it flips to "xsuaa" the Continue button is disabled — clicking it
  // earlier sends the operator to / on the still-v1 manager, which 302s to
  // /setup (the root cause of the symptom that prompted this poll in the
  // first place).
  const [outcome, setOutcome] = React.useState(null);

  // ── Pre-flight: are we targeting the SAME cf org/space the manager itself
  // is deployed in? The upgrade pushes a sibling approuter (cf push
  // figaf-manager-approuter) into the *current* cf target, and CF requires the
  // approuter and the manager to live in the same space (the approuter maps
  // the manager's internal route). If the operator's cf session has drifted to
  // a different org/space/landscape, push-approuter fails partway and leaves a
  // half-applied upgrade. So we gate the whole flow on a target match.
  //
  // Reuses update:selfTarget — the same read-only probe (`cf api` + `cf target`
  // compared against the manager's own VCAP_APPLICATION coordinates) that the
  // self-update pre-flight modal uses. status: "checking" | "ok" | "mismatch"
  // | "error". Runs on mount; navigating away to login and back remounts the
  // screen, which re-runs it (no manual re-check button needed).
  const [spaceCheck, setSpaceCheck] = React.useState({ status: "checking", data: null, error: null });

  React.useEffect(() => {
    let cancelled = false;
    const api = fg();
    if (!api || !api.update || !api.update.selfTarget) {
      setSpaceCheck({ status: "error", data: null, error: "cf-target probe unavailable" });
      return;
    }
    setSpaceCheck({ status: "checking", data: null, error: null });
    api.update.selfTarget().then((r) => {
      if (cancelled) return;
      if (!r || r.ok === false) {
        setSpaceCheck({ status: "error", data: null, error: (r && r.error) || "could not read cf target" });
        return;
      }
      const m = r.mismatch || {};
      // "Same space" = same landscape AND org AND space. A space name alone is
      // ambiguous across orgs/landscapes, and a wrong api endpoint is just as
      // fatal to the approuter push, so all three must match.
      const matched = r.loggedIn && !m.apiUrl && !m.org && !m.space;
      setSpaceCheck({ status: matched ? "ok" : "mismatch", data: r, error: null });
    }).catch((e) => {
      if (!cancelled) setSpaceCheck({ status: "error", data: null, error: e.message });
    });
    return () => { cancelled = true; };
  }, []);

  // "Go to login" — jump back to the login step so the operator can re-target
  // (the login screen's "Switch Org" re-runs cf target -o/-s). ctx.choice stays
  // "xsuaa-upgrade", so Continue → Choice (still selected) → Begin upgrade
  // brings them right back here, remounting and re-running the check.
  function goToLogin() {
    if (!setStep || !Array.isArray(STEPS)) return;
    const i = STEPS.findIndex(s => s && s.id === "login");
    if (i >= 0) setStep(i);
  }

  const spaceOk = spaceCheck.status === "ok";

  // Reflect checkbox toggles into the phase list while still in pre-run state.
  React.useEffect(() => {
    if (started) return;
    setPhases(buildPhases(autoAssign));
  }, [autoAssign, started, buildPhases]);

  const markPhase = React.useCallback((id, patch) => {
    setPhases(prev => prev.map(p => p.id === id ? { ...p, ...patch } : p));
  }, []);

  // Subscribe to live phase + service status events from the orchestrator.
  // Note we ignore "assign-role" events when the checkbox is off — the
  // handler shouldn't fire in that case, but defense in depth.
  React.useEffect(() => {
    const api = fg();
    if (!api || !api.on) return;
    const offPhase = api.on("xsuaa:upgradePhase", (msg) => {
      if (!msg || !msg.phase) return;
      const status = msg.state === "running" ? "running" : msg.state === "done" ? "done" : "error";
      markPhase(msg.phase, { status, sub: msg.error || undefined });
    });
    const offSvc = api.on("cf:serviceStatus", (msg) => {
      if (msg && /xsuaa/.test(String(msg.name || ""))) {
        markPhase("create-xsuaa", { sub: `${msg.name}: ${msg.status}` });
      }
    });
    return () => { offPhase && offPhase(); offSvc && offSvc(); };
  }, [markPhase]);

  async function runUpgrade() {
    // Defense in depth — the Start button is already disabled until the
    // CF-target check passes, but never kick off a push into the wrong space.
    if (spaceCheck.status !== "ok") return;
    // The panel decided the assignment; never start with an unusable target.
    if (autoAssign && !emailOk) return;
    setStarted(true);
    setError(null);
    const api = fg();
    if (!api) { setError("API unavailable"); return; }

    try {
      // Pre-flight status check — lets a resumed upgrade pick up where it
      // left off if the dyno restarted mid-flow.
      const pre = await api.xsuaa.upgradeStatus();

      // Phase 1 — ALWAYS runs (decision 0009): the shared instance is created
      // when missing and UPDATED when present, so the manager's roles are in
      // it even when the instance came from the release or from a script.
      const roleName = (pre && pre.roleCollection) || ASSIGN_ROLE;
      markPhase("create-xsuaa", { status: "running" });
      const r1 = await api.cf.createXsuaa();
      if (!r1 || !r1.ok) {
        setError("prepare XSUAA: " + ((r1 && r1.error) || "failed"));
        markPhase("create-xsuaa", { status: "error", sub: r1 && r1.error });
        return;
      }
      const instName = r1.instance || "figaf-faid-xsuaa";
      markPhase("create-xsuaa", {
        status: "done",
        sub: r1.legacy ? "legacy instance already bound — nothing to create"
          : r1.updated ? `${instName} updated with the current roles`
          : `${instName} created`,
      });

      // Optional auto-assign step. Runs HERE — immediately after the XSUAA
      // service is up — because:
      //   1. Role-collections are materialized inline by xs-security.json the
      //      moment create-service reaches status: succeeded; the assignment
      //      only needs state.user + state.subaccount (both captured during
      //      login). It does NOT require the approuter, route swap, or
      //      restage.
      //   2. Once the approuter takes over the public route (map-route, below)
      //      the operator's next request is bounced to IAS for sign-in. If the
      //      assignment hasn't committed by then, the fresh JWT will lack the
      //      scope and the auto-assign would have zero practical effect.
      // Failure here is non-fatal — XSUAA is up, the upgrade can proceed, and
      // the success state surfaces the cockpit-fallback messaging so the
      // operator can self-assign before clicking Continue.
      let assignFailedReason = null;
      let assignedTo = null;
      if (autoAssign) {
        const who = String(assignTo || "").trim();
        markPhase("assign-role", { status: "running", sub: `btp assign ${roleName} --to-user ${who}` });
        // The server probes the BTP login live and derives the subaccount GUID
        // from the manager's own XSUAA instance when the BTP flow did not
        // capture one (run #4 finding 2).
        const ar = await api.xsuaa.assignRoleCollection(roleName, who);
        if (!ar || ar.ok === false) {
          assignFailedReason = (ar && ar.error) || "unknown";
          markPhase("assign-role", { status: "error", sub: assignFailedReason });
          // No setError() — we don't want to halt the upgrade. The post-run
          // success state surfaces the fallback messaging instead.
        } else {
          assignedTo = ar.user || who;
          const via = ar.subaccountSource === "xsuaa-service-key" ? " (subaccount taken from the XSUAA service key)" : "";
          markPhase("assign-role", { status: "done", sub: `assigned ${ar.role} to ${assignedTo}${via}` });
        }
      }

      // Credential Store: created and bound NOW, without a restart (decision
      // 0009). The restage at the end activates the binding, so the management
      // user can be stored right after the IAS sign-in — no second passcode.
      // Non-fatal: SSO does not need the Credential Store; on a failure the
      // success state says what to do (passcode once more, Base services card).
      let servicesWarning = null;
      markPhase("manager-services", { status: "running" });
      let ms = null;
      try {
        ms = api.faid && api.faid.prepareManagerServices ? await api.faid.prepareManagerServices() : { ok: true, note: "not available in this build" };
      } catch (e) {
        ms = { ok: false, error: e && e.message ? e.message : "prepareManagerServices failed" };
      }
      if (!ms || ms.ok === false) {
        servicesWarning = (ms && ms.error) || "unknown error";
        markPhase("manager-services", { status: "error", sub: servicesWarning });
      } else {
        const boundTxt = ms.bound && ms.bound.length ? `bound to the manager: ${ms.bound.join(", ")} (active after the restage)` : (ms.note || "nothing to do");
        const createdTxt = ms.created && ms.created.length ? `created ${ms.created.join(", ")}; ` : "";
        markPhase("manager-services", { status: "done", sub: createdTxt + boundTxt });
      }

      // Phase 1.3-1.6
      if (!pre || !pre.hasApprouterApp) {
        markPhase("push-approuter", { status: "running" });
        const r2 = await api.cf.pushManagerApprouter();
        if (!r2.ok) { setError("pushManagerApprouter: " + (r2.error || "failed")); markPhase("push-approuter", { status: "error", sub: r2.error }); return; }
        markPhase("push-approuter", { status: "done" });
      } else {
        markPhase("push-approuter", { status: "done", sub: "approuter already deployed" });
      }

      // Phase 2: route swap. We need domain + hostname. VCAP_APPLICATION
      // gives us uris[0] which is "<host>.<domain>". Split on the first dot.
      let mapHost = null, mapDomain = null;
      const fullRoute = pre && pre.route;
      if (fullRoute) {
        const dot = fullRoute.indexOf(".");
        if (dot > 0) { 
          mapHost = fullRoute.slice(0, dot); 
          if (mapHost.endsWith("-internal")) mapHost = mapHost.slice(0, -"-internal".length);
          mapDomain = fullRoute.slice(dot + 1); 
        }
      }
      if (!mapHost || !mapDomain) {
        setError("Could not determine the manager's public route. Inspect cf app figaf-manager in cockpit.");
        markPhase("map-route", { status: "error", sub: "route unknown" });
        return;
      }

      // Phase 2: route swap. We map the approuter to the public hostname here
      // and let cf:restage handle the unmap server-side (see below). Splitting
      // map-route and unmap-route across two RPCs is fine because the manager
      // is still on the route after the map; splitting unmap-route from
      // restage is NOT — the gorouter starts resolving the hostname to the
      // approuter the moment the manager is unmapped, and the next RPC 401s
      // at the approuter before reaching the manager.
      markPhase("map-route", { status: "running" });
      const m1 = await api.cf.mapRoute({ app: "figaf-manager-approuter", domain: mapDomain, hostname: mapHost });
      if (!m1.ok) { setError("mapRoute: " + (m1.stderr || "failed")); markPhase("map-route", { status: "error" }); return; }
      markPhase("map-route", { status: "done", sub: "approuter now serves the public route" });

      // Phase 2.5: unmap + bind + restage, all in one RPC. The handler runs
      // unmap-route → bind-service → spawn cf restage (fire-and-forget) on
      // the manager itself. The request arrives while the manager is still
      // on the public route; the OK response flows back over the already-
      // open TCP connection even after unmap-route removes the manager from
      // the gorouter. After this returns, the dyno will die in the next
      // 30-90s and the UI polls the approuter's /_manager-health.
      //
      // Pre-set figafSuppressAuthKick BEFORE the await. The orchestrator
      // spawns `cf restage` synchronously inside the handler, so the dyno can
      // begin its shutdown sequence while the HTTP response is still in
      // flight. If we set the flag only after the await resolves, an in-the-
      // gap WS close (unmap already happened — reconnect routes through the
      // approuter and gets a generic close on the unauthenticated tab) can
      // leak a redirect to /setup before we get a chance to suppress.
      // Setting it here is safe: any auth-kick during the upgrade phase is
      // already either bogus (we caused it ourselves by initiating restage)
      // or about to be superseded by the explicit "Continue to wizard" click.
      if (typeof window !== "undefined") window.figafSuppressAuthKick = true;

      markPhase("restage", { status: "running", sub: "manager will be offline for 30-90s" });
      // skipIfBound: on a re-run where the manager is already bound to xsuaa,
      // the orchestrator probes cf curl /v3/service_credential_bindings and
      // returns alreadyBound=true without forcing a needless 30-90s restage.
      // The first-time path doesn't hit this branch (no binding yet).
      const r3 = await api.cf.restage({
        app: "figaf-manager",
        bindXsuaa: true,
        skipIfBound: true,
        unmapRoute: { domain: mapDomain, hostname: mapHost },
      });
      if (!r3 || r3.ok === false) {
        // bind-service failed for a non-"already bound" reason (quota, perms,
        // network). The route swap is already committed at this point, so
        // recovery requires either re-running the upgrade (idempotent for
        // already-mapped routes) or manually binding+restaging from the
        // cockpit. Surface the error and stop — the success state is wrong
        // when XSUAA mode hasn't taken effect.
        setError("restage: " + (r3 && r3.error || "failed"));
        markPhase("restage", { status: "error", sub: r3 && r3.error });
        return;
      }
      // From this point on, the WebSocket may drop as the dyno dies. We do
      // NOT auto-redirect — instead we show the success state with an
      // explicit "Continue to wizard" button. The operator clicks when ready.
      //
      // figafSuppressAuthKick was set above (pre-await) so the suppression
      // is already in place. It stays true until window.location reloads
      // (Continue button), which resets the closure naturally.
      const subTxt = r3.alreadyBound ? "manager already in XSUAA mode" : "restage initiated";
      markPhase("restage", { status: "done", sub: subTxt });
      setCtx(c => ({ ...c, xsuaaUpgradeInitiated: true }));
      setOutcome({
        restaging: true,
        assignFailed: assignFailedReason,
        assignSkipped: !autoAssign,
        assignedTo,
        servicesWarning,
        roleName,
        // If the manager was already bound, it's already in XSUAA mode; the
        // poll below would otherwise wait pointlessly for a mode-flip that
        // already happened.
        managerMode: r3.alreadyBound ? "xsuaa" : null,
      });
    } catch (e) {
      setError("Unexpected: " + e.message);
    }
  }

  // Post-restage poll: wait for the manager to come back in XSUAA mode before
  // letting the operator click "Continue to wizard." Without this gate, a
  // too-eager click lands on / while the OLD manager dyno (still in v1 mode)
  // is mid-restage. The old v1 manager 302s any uncookied GET to /setup —
  // which is exactly the bug the operator reported (and the reason for this
  // entire poll). Probes the approuter's unauthenticated /_manager-health
  // route, which proxies to manager's /health and forwards its JSON body
  // (see packages/manager-approuter/server.js#probeManager). Stops on the
  // first successful mode==="xsuaa" response.
  //
  // We deliberately do NOT use api.xsuaa.upgradeStatus() here — that goes
  // through the gated /rpc/* surface, which fails 401 the moment XSUAA mode
  // kicks in (no JWT, since the operator hasn't reauthed yet). The
  // /_manager-health route is unauthenticated by design for exactly this
  // poll case.
  React.useEffect(() => {
    if (!outcome || outcome.managerMode === "xsuaa") return;
    let cancelled = false;
    let elapsed = 0;
    const startedAt = Date.now();
    async function tick() {
      if (cancelled) return;
      try {
        const r = await fetch("/_manager-health", { cache: "no-store", credentials: "same-origin" });
        if (cancelled) return;
        // 200 with mode==="xsuaa" → done. 200 with mode==="token" → manager
        // back but still on the old droplet (race between cf restage scheduling
        // and the new droplet's first boot); keep polling. 503 → manager
        // currently unreachable (mid-restage); keep polling. Other → also poll.
        let body = null;
        try { body = await r.json(); } catch { /* ignore */ }
        if (r.ok && body && body.mode === "xsuaa") {
          setOutcome((o) => o ? { ...o, managerMode: "xsuaa" } : o);
          return;
        }
      } catch {
        // network blip during restage is expected; loop on.
      }
      elapsed = Date.now() - startedAt;
      // Total budget: 5 minutes. Beyond that, stop polling and let the
      // operator click Continue manually — they'll see the v1 /setup if the
      // restage truly never took, which is recoverable from the cockpit.
      if (elapsed > 5 * 60 * 1000) {
        setOutcome((o) => o ? { ...o, managerMode: "timeout" } : o);
        return;
      }
      setTimeout(tick, 4000);
    }
    // First tick after 3s — gives the dyno a beat to start its shutdown so
    // the probe isn't just hitting the about-to-die v1 manager.
    const h = setTimeout(tick, 3000);
    return () => { cancelled = true; clearTimeout(h); };
  }, [outcome && outcome.managerMode === "xsuaa" ? "done" : (outcome ? "polling" : "idle")]);

  // Manual reboot — explicit user click after seeing the success state.
  // The page must RELOAD against the public route, which is now served by the
  // approuter; the approuter sees no XSUAA cookie and triggers an IAS sign-in.
  // The new JWT includes the scope (assuming assignment succeeded or was done
  // manually beforehand). Assigning window.location.href alone does not reload:
  // the target differs from the current URL only in the fragment, which the
  // browser handles inside the same document (verified in Chromium/Edge).
  function continueToWizard() {
    try {
      window.location.hash = "#/session";
      window.location.reload();
    } catch (_) { /* defensive */ }
  }

  // Manual reboot via the assign-role fallback screen — the operator who
  // hit an assignment failure may want to assign via cockpit first. Routes
  // there via the existing onNext path, which leads to xsuaa-assign-role.
  function openManualAssignFallback() {
    if (onNext) onNext();
  }

  const isSuccess = !!outcome;
  // The footer Cancel/Back buttons should disappear once the upgrade is
  // running (no graceful rollback path mid-flow).

  // The CF-target pre-check, rendered as the FIRST row of the task list (above
  // the upgrade phases) so it reads like one of the checks. On a mismatch it
  // surfaces the manager's own org/space plus a "Go to login" button.
  let spaceCheckRow;
  if (spaceCheck.status === "checking") {
    spaceCheckRow = (
      <CheckRow key="cf-target" status="running"
        title="Checking Cloud Foundry target"
        sub="Confirming you're targeting the manager's space" />
    );
  } else if (spaceCheck.status === "ok") {
    const t = (spaceCheck.data && spaceCheck.data.target) || {};
    spaceCheckRow = (
      <CheckRow key="cf-target" status="done"
        title="Targeting the manager's space"
        sub={`${t.orgName} / ${t.spaceName}`} />
    );
  } else {
    const goBtn = (
      <button className="btn" style={{ padding: "5px 12px", fontSize: 12 }}
        onClick={goToLogin}
        title="Go back to the login step to target the manager's org / space">
        <Ico.ArrowLeft /> Go to login
      </button>
    );
    if (spaceCheck.status === "error") {
      spaceCheckRow = (
        <CheckRow key="cf-target" status="error"
          title="Couldn't verify Cloud Foundry target"
          sub={spaceCheck.error || "cf target check failed"}
          meta={goBtn} />
      );
    } else {
      const d = spaceCheck.data || {};
      const t = d.target || {};
      const cur = d.current || {};
      const wrongLandscape = !!(d.mismatch && d.mismatch.apiUrl);
      const sub = (
        <>
          Expected <strong>{t.orgName} / {t.spaceName}</strong>{wrongLandscape ? " (different landscape)" : ""}.{" "}
          {d.loggedIn
            ? <>You're on <strong>{cur.orgName} / {cur.spaceName}</strong>.</>
            : <>You're not logged in to cf.</>}
        </>
      );
      spaceCheckRow = (
        <CheckRow key="cf-target" status="error"
          title="Wrong Cloud Foundry target"
          sub={sub}
          meta={goBtn} />
      );
    }
  }

  return (
    <>
      <div className="pane-body">
        <div className="pane-head">
          <div className="pane-eyebrow">XSUAA upgrade</div>
          <h1 className="pane-title">Enable persistent SSO login</h1>
          <p className="pane-desc">
            Step 1 of a fresh installation. Replaces the cockpit-log setup token with SAP IAS authentication: afterwards anyone in the <strong>{ASSIGN_ROLE}</strong> role collection (or <strong>FAID-Manager-Operator</strong>) reaches the manager with SAP IAS, and the token is never needed again.
          </p>
          <p className="pane-desc" style={{ fontSize: 12, color: "var(--ink-3)" }}>
            What runs: the shared XSUAA instance <code>figaf-faid-xsuaa</code> is created or updated with the roles of the manager and the apps, the role collection is optionally assigned to you, the Credential Store is created and bound to the manager, an approuter app is pushed and takes over the public route, and figaf-manager is restaged once. Expect 3-4 minutes total, with 30-90 seconds of downtime at the end. After the IAS sign-in the gate offers <strong>Set up management user</strong> — no second passcode.
          </p>
        </div>

        {!started && (
          <div
            data-panel="role-assign"
            style={{
              padding: "12px 14px", marginBottom: 14,
              borderRadius: 8, background: "rgba(21,101,216,0.05)",
              border: "1px solid rgba(21,101,216,0.18)",
              fontSize: 13, color: "var(--ink-1)",
            }}
          >
            <div style={{ fontWeight: 600, color: "var(--ink-0)", marginBottom: 6 }}>Role assignment</div>
            {plan === null && (
              <div style={{ color: "var(--ink-2)" }}>Checking the BTP login of this session…</div>
            )}
            {plan && !plan.available && (
              <>
                <p style={{ margin: "0 0 8px", lineHeight: 1.5 }}>
                  <span className="pill gray" style={{ marginRight: 8 }}>
                    {plan.reason === "no-btp-login" ? "no BTP login" : "check failed"}
                  </span>
                  {plan.notice}
                </p>
                <p style={{ margin: "0 0 10px", lineHeight: 1.5, color: "var(--ink-2)" }}>
                  Without it the upgrade cannot assign <code>{ASSIGN_ROLE}</code>. You then add the role collection to
                  your user in the BTP cockpit (subaccount → Security → Users) before you can sign in again.
                </p>
                {plan.reason === "no-btp-login" && (
                  <button className="btn" onClick={addBtpLoginFirst}>Add BTP login first</button>
                )}
              </>
            )}
            {plan && plan.available && (
              <>
                <label style={{ display: "flex", alignItems: "flex-start", gap: 10, cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={autoAssign}
                    onChange={(e) => setAutoAssign(e.target.checked)}
                    style={{ marginTop: 3 }}
                  />
                  <span>
                    <strong style={{ color: "var(--ink-0)" }}>Assign {ASSIGN_ROLE} automatically</strong>
                    <br />
                    <span style={{ color: "var(--ink-2)" }}>
                      Runs <code>btp assign security/role-collection {ASSIGN_ROLE}</code> for the user below, right after the
                      XSUAA instance exists. Without it you see a 403 on the next sign-in until the role is assigned in the cockpit.
                    </span>
                  </span>
                </label>
                {autoAssign && (
                  <div className="field" style={{ marginTop: 10 }}>
                    <label className="field-label">Assign to (e-mail of the person who will sign in)</label>
                    <input
                      className="input is-mono"
                      data-field="assign-to"
                      autoComplete="off"
                      placeholder="you@example.com"
                      value={assignTo}
                      onChange={(e) => setAssignTo(e.target.value)}
                    />
                    {plan.notice && (
                      <div style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 6 }}>{plan.notice}</div>
                    )}
                    {!emailOk && (
                      <div style={{ fontSize: 12, color: "var(--error, #b91c1c)", marginTop: 6 }}>
                        Enter the e-mail of a person. The upgrade does not start without it while the automatic assignment is on.
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        )}

        <div className="task-list">
          {spaceCheckRow}
          {phases.map(p => (
            <CheckRow
              key={p.id}
              status={p.status}
              title={p.label}
              sub={p.sub || ""}
            />
          ))}
        </div>

        {error && (
          <div style={{ marginTop: 16, padding: "12px 14px", borderRadius: 8, background: "rgba(225,29,72,0.07)", border: "1px solid rgba(225,29,72,0.25)", color: "var(--error, #b91c1c)", fontSize: 13 }}>
            <strong>Upgrade failed.</strong> {error}
          </div>
        )}

        {isSuccess && (
          <div style={{ marginTop: 16, padding: "14px 16px", borderRadius: 10, background: "rgba(34,197,94,0.06)", border: "1px solid rgba(34,197,94,0.25)", fontSize: 13, color: "var(--ink-1)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <Ico.Check style={{ width: 18, height: 18, color: "var(--ok, #15803d)" }} />
              <strong style={{ color: "var(--ink-0)", fontSize: 14 }}>
                {outcome.managerMode === "xsuaa"
                  ? "Upgrade complete — manager is in XSUAA mode."
                  : "Upgrade initiated — manager is restaging."}
              </strong>
            </div>
            <p style={{ margin: "6px 0", lineHeight: 1.55 }}>
              {outcome.managerMode === "xsuaa"
                ? <>The approuter is serving the public route and figaf-manager has come back up bound to XSUAA. Click Continue to reauthenticate through SAP IAS.</>
                : <>The approuter has taken over the public route and figaf-manager is rebinding to XSUAA (~30-90s). The Continue button unlocks once the manager reports XSUAA mode.</>}
              {outcome.assignFailed
                ? <> The role assignment <strong style={{ color: "var(--error, #b91c1c)" }}>did not succeed</strong> — assign the role in the cockpit before continuing.</>
                : outcome.assignSkipped
                  ? <> The automatic role assignment was <strong>skipped by your choice</strong> — add <code>{ASSIGN_ROLE}</code> to your user in the BTP cockpit (subaccount → Security → Users) before continuing, or the next sign-in ends in a 403.</>
                  : <> <code>{ASSIGN_ROLE}</code> was assigned to <code>{outcome.assignedTo || "your user"}</code> in your subaccount.</>}
            </p>
            {/*
              Live restage status. We render a thin readiness banner so the
              operator has feedback during the 30-90s window. Three states:
                null      → polling not yet completed a successful probe
                "xsuaa"   → confirmed; Continue button is enabled
                "timeout" → polled for 5 min without confirmation; the operator
                            can still click Continue, but will probably land on
                            v1 /setup (recoverable from cockpit)
            */}
            {outcome.managerMode !== "xsuaa" && (
              <p style={{ margin: "10px 0 0", padding: "8px 10px", borderRadius: 6, background: "rgba(21,101,216,0.06)", border: "1px solid rgba(21,101,216,0.18)", color: "var(--ink-1)", lineHeight: 1.5, fontSize: 12 }}>
                {outcome.managerMode === "timeout"
                  ? <><strong>Probe timeout.</strong> The manager hasn't reported XSUAA mode in 5 minutes. You can still click Continue — if you land on the legacy setup page, the bind may have failed; verify <code>cf services figaf-manager-xsuaa</code> in the cockpit and re-run the upgrade.</>
                  : <><strong>Waiting for manager to come back…</strong> Probing <code>/_manager-health</code> through the approuter. Continue unlocks automatically once the manager reports <code>mode: "xsuaa"</code>.</>}
              </p>
            )}
            <p style={{ margin: "10px 0 0", lineHeight: 1.55 }}>
              <strong>You must fully re-authenticate</strong> for the new scope to appear in your JWT. Your current cookies were issued before the role assignment and won't have it. After you click Continue, the approuter will redirect you through SAP IAS — sign in there to get a fresh token. If you see anything unexpected, use a private/incognito window or clear cookies for this hostname.
            </p>
            <p style={{ margin: "10px 0 0", lineHeight: 1.55 }} data-next-step="management-user">
              <strong>Next:</strong> after the IAS sign-in the sign-in gate offers <strong>Set up management user</strong> (the Credential Store binding is active now). Store it, and the manager signs itself in from then on — no second passcode.
            </p>
            {outcome.servicesWarning && (
              <p style={{ margin: "10px 0 0", padding: "10px 12px", borderRadius: 6, background: "rgba(225,29,72,0.07)", border: "1px solid rgba(225,29,72,0.2)", color: "var(--ink-1)", lineHeight: 1.5 }} data-services-warning="">
                <strong style={{ color: "var(--ink-0)" }}>Credential Store step did not complete:</strong> {outcome.servicesWarning}
                <br />
                <span style={{ color: "var(--ink-2)" }}>
                  After the IAS sign-in, sign in to Cloud Foundry with a passcode once more and use the Base services card (create, bind to manager, restart). Then store the management user.
                </span>
              </p>
            )}
            {outcome.assignFailed && (
              <p style={{ margin: "10px 0 0", padding: "10px 12px", borderRadius: 6, background: "rgba(225,29,72,0.07)", border: "1px solid rgba(225,29,72,0.2)", color: "var(--ink-1)", lineHeight: 1.5 }}>
                <strong style={{ color: "var(--ink-0)" }}>Assignment error:</strong> {outcome.assignFailed}
                <br />
                <span style={{ color: "var(--ink-2)" }}>
                  Open the BTP cockpit, find your user under the subaccount's Users tab, and assign the <code>{ASSIGN_ROLE}</code> role collection. Then click Continue.
                </span>
              </p>
            )}
          </div>
        )}
      </div>

      <div className="pane-foot">
        {!started && (
          <>
            {onBack && <button className="btn" onClick={onBack}><Ico.ArrowLeft /> Back</button>}
            <div className="spacer" />
            <button
              className="btn btn-primary"
              onClick={runUpgrade}
              disabled={!spaceOk || plan === null || (autoAssign && !emailOk)}
              title={
                spaceCheck.status === "checking" ? "Verifying Cloud Foundry target…"
                : !spaceOk ? "Target the manager's Cloud Foundry space first"
                : plan === null ? "Checking the BTP login of this session…"
                : (autoAssign && !emailOk) ? "Enter the e-mail the role goes to, or switch the automatic assignment off"
                : "Begin the XSUAA upgrade"
              }
            >
              <Ico.Shield /> {autoAssign ? "Start upgrade" : "Start upgrade without role assignment"}
            </button>
          </>
        )}
        {started && !isSuccess && (
          <>
            <div className="spacer" />
            <button className="btn btn-primary" disabled>
              <Ico.Shield /> Upgrading…
            </button>
          </>
        )}
        {isSuccess && (
          <>
            <div className="spacer" />
            {outcome.assignFailed && (
              <button className="btn" onClick={openManualAssignFallback} title="Open the cockpit deep-link to assign the role manually">
                <Ico.External /> Assign role in cockpit
              </button>
            )}
            {/*
              Continue button is disabled while we're still waiting for the
              manager to come back in XSUAA mode. This is the gate that
              prevents the "lands on /setup" bug: a too-early click sends the
              operator to /, the still-v1 manager 302s to /setup (no figaf_auth
              cookie), and they end up on the legacy claim page. The "timeout"
              state (5 min of polling without xsuaa confirmation) enables the
              button so the operator isn't stuck; if the bind/restage failed
              silently, the resulting /setup landing is still recoverable.
            */}
            {outcome.managerMode === "xsuaa" ? (
              <button className="btn btn-primary" onClick={continueToWizard} title="Reload through the approuter — you'll be prompted to sign in via SAP IAS">
                Continue <Ico.ArrowRight />
              </button>
            ) : outcome.managerMode === "timeout" ? (
              <button className="btn btn-primary" onClick={continueToWizard} title="The probe timed out; the manager may or may not be ready. Click to attempt continuation anyway.">
                Continue anyway <Ico.ArrowRight />
              </button>
            ) : (
              <button className="btn btn-primary" disabled title="Waiting for manager to come back in XSUAA mode">
                <Ico.Shield /> Waiting for manager…
              </button>
            )}
          </>
        )}
      </div>
    </>
  );
}

function ScreenXsuaaAssignRole({ ctx, setCtx, onNext, onBack }) {
  const [cockpitUrl, setCockpitUrl] = React.useState(null);
  const [error, setError] = React.useState(null);

  // Defensive: this screen is reachable from the failed-auto-assign branch
  // of the upgrade success state, which means restage may still be in flight
  // and the WS may drop. The upgrade screen already set this flag, but if
  // the operator lands here via some other path (e.g. a future direct link)
  // we want to keep the auth-kick suppressed while they're reading the
  // manual-assign instructions. The flag self-clears on the next page load.
  React.useEffect(() => {
    if (typeof window !== "undefined") window.figafSuppressAuthKick = true;
  }, []);

  React.useEffect(() => {
    const api = fg();
    if (!api) return;
    api.xsuaa.assignRoleCollectionPreflight().then((r) => {
      if (r && r.ok) setCockpitUrl(r.url);
      else setError((r && r.error) || "Could not derive cockpit URL");
    });
  }, []);

  function openCockpit() {
    if (!cockpitUrl) return;
    const api = fg();
    if (api && api.shell && api.shell.openExternal) api.shell.openExternal(cockpitUrl);
    else window.open(cockpitUrl, "_blank", "noopener,noreferrer");
  }

  // Manual reboot from this fallback screen too — same target as the
  // upgrade screen's Continue button, and reloaded for the same reason.
  function continueToWizard() {
    try {
      window.location.hash = "#/session";
      window.location.reload();
    } catch (_) {}
  }

  return (
    <>
      <div className="pane-body">
        <div className="pane-head">
          <div className="pane-eyebrow">XSUAA upgrade · manual role assignment</div>
          <h1 className="pane-title">Assign yourself a role collection</h1>
          <p className="pane-desc">
            The auto-assignment didn't complete (or you opted out). Open BTP cockpit, find your user under your subaccount's Users tab, and assign <code>FAID-Manager-Admin</code> (or <code>FAID-Manager-Operator</code> if you prefer non-destructive scope only). Takes about 30 seconds.
          </p>
        </div>

        <ol style={{ margin: "0 0 18px", paddingLeft: 18, color: "var(--ink-1)", fontSize: 14, lineHeight: 1.6 }}>
          <li>Click "Open cockpit" below — it deep-links to your subaccount's user-management page.</li>
          <li>Find yourself in the user list and open your row.</li>
          <li>In the "Role Collections" tab, assign <code>FAID-Manager-Admin</code>.</li>
          <li>Return here and click "Continue to wizard" — you'll be redirected through SAP IAS for a fresh sign-in.</li>
        </ol>

        {error && (
          <div style={{ padding: "10px 12px", borderRadius: 8, background: "rgba(225,29,72,0.07)", border: "1px solid rgba(225,29,72,0.25)", color: "var(--error, #b91c1c)", fontSize: 13 }}>
            {error}
          </div>
        )}
      </div>

      <div className="pane-foot">
        {onBack && <button className="btn" onClick={onBack}><Ico.ArrowLeft /> Back</button>}
        <div className="spacer" />
        <button className="btn" onClick={openCockpit} disabled={!cockpitUrl}>
          <Ico.External /> Open cockpit
        </button>
        <button className="btn btn-primary" onClick={continueToWizard} title="Reload through the approuter — you'll be prompted to sign in via SAP IAS">
          Continue to wizard <Ico.ArrowRight />
        </button>
      </div>
    </>
  );
}

Object.assign(window, { ScreenXsuaaUpgrade, ScreenXsuaaAssignRole });
