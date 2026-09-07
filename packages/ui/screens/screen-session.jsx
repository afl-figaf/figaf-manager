/* global React, ScreenLogin, Ico */
// Console page: Session & access (#/session).
// The old wizard "Sign in" step, reframed as a settings page:
//   - signed out  → the full ScreenLogin (passcode, stored user, CF-only)
//   - signed in   → the access map (what each sign-in is for, and its state),
//                   then the cards: CF session, BTP session, management user.
// The installation itself (Prepare the space, the first management user) is
// on the Setup page (#/setup); this page is for the running manager.
// Sign-out clears the server-side CLI login AND the client login context,
// which makes the console's auth gate take over again.

function SessionInfoRow({ label, value }) {
  return (
    <div style={{ display: "flex", gap: 10, fontSize: 13, margin: "4px 0" }}>
      <div style={{ width: 110, color: "var(--ink-3)" }}>{label}</div>
      <div><span className="kbd">{value || "—"}</span></div>
    </div>
  );
}

// Management user card — set up / replace the technical CF user stored in
// the SAP Credential Store (namespace figaf-manager, name cf-management-user).
// Mirrors the form on the Setup page, but standalone so it is usable while
// signed in. The handler verifies the credentials against CF before storing.
function MgmtUserCard() {
  const api = typeof window !== "undefined" ? window.figaf : null;
  const [status, setStatus] = React.useState(null); // login:storedUserStatus result
  const [formOpen, setFormOpen] = React.useState(false);
  const [username, setUsername] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState(null); // { ok, text }

  const loadStatus = React.useCallback(async () => {
    try { setStatus(await api.login.storedUserStatus()); }
    catch (e) { setStatus({ available: false, bindingPresent: false, error: e.message }); }
  }, []);
  React.useEffect(() => { loadStatus(); }, [loadStatus]);

  async function store() {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.login.storeManagementUser({ username, password });
      if (r && r.ok) {
        setMsg({ ok: true, text: "Verified against Cloud Foundry and stored." });
        setFormOpen(false);
        setUsername("");
        setPassword("");
        await loadStatus();
      } else {
        setMsg({ ok: false, text: (r && r.error) || "storing failed" });
      }
    } catch (e) {
      setMsg({ ok: false, text: e.message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" style={{ marginTop: 14 }}>
      <div style={{ fontWeight: 700, marginBottom: 6 }}>Management user (automatic sign-in)</div>
      <p style={{ fontSize: 13, color: "var(--ink-3)", margin: "0 0 10px" }}>
        A technical CF user stored in the SAP Credential Store. With it, the manager
        signs in by itself — no passcode — and scheduled actions become possible.
      </p>

      {!status && <div style={{ fontSize: 13, color: "var(--ink-3)" }}>Checking…</div>}

      {status && !status.bindingPresent && (
        <div style={{ fontSize: 13, color: "var(--ink-3)" }}>
          The manager is not bound to a Credential Store instance, so no user can be
          stored. Repair it on the Setup page, step 3 (create, bind to manager, restart).
        </div>
      )}

      {status && status.bindingPresent && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          {status.available
            ? <span className="pill green">stored: {status.username || "…"}</span>
            : <span className="pill gray">not set up</span>}
          <button className="btn" onClick={() => { setFormOpen(o => !o); setMsg(null); }} disabled={busy}>
            {status.available ? "Replace user" : "Set up management user"}
          </button>
        </div>
      )}

      {status && status.bindingPresent && formOpen && (
        <div style={{ marginTop: 10, maxWidth: 420 }}>
          <input
            className="input"
            style={{ width: "100%", marginBottom: 8 }}
            placeholder="CF username (e-mail)"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            disabled={busy}
          />
          <input
            className="input"
            style={{ width: "100%", marginBottom: 8 }}
            type="password"
            placeholder="CF password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={busy}
          />
          <button className="btn btn-primary" onClick={store} disabled={busy || !username || !password}>
            {busy ? "Verifying against CF…" : "Verify & store"}
          </button>
        </div>
      )}

      {msg && (
        <div style={{ marginTop: 8, fontSize: 13, color: msg.ok ? "var(--fg-blue)" : "var(--fg-red, #c0392b)" }}>
          {msg.text}
        </div>
      )}
    </div>
  );
}

// One picture of the four things called "sign-in" here (virgin run #3:
// "various ways of authentication"): what each is FOR, and its state now.
function AccessMapCard({ ctx }) {
  const api = typeof window !== "undefined" ? window.figaf : null;
  const ssoMode = typeof window !== "undefined" && window.figafXsuaaMode === true;
  const [stored, setStored] = React.useState(null);
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = api && api.login ? await api.login.storedUserStatus() : null;
        if (!cancelled) setStored(r || { available: false, bindingPresent: false });
      } catch {
        if (!cancelled) setStored({ available: false, bindingPresent: false });
      }
    })();
    return () => { cancelled = true; };
  }, []);
  const cfOn = ctx.login.cfStatus === "done";
  const btpOn = ctx.login.btpStatus === "done";
  const rows = [
    {
      name: "Browser access",
      purpose: ssoMode
        ? "SAP IAS sign-in through the approuter; the FAID-Manager-Admin (or -Operator) role collection is required. Survives restarts and redeploys."
        : "A one-time setup token from the app logs, until step 1 of the Setup (Prepare the space) is done. Dies on every restart.",
      state: ssoMode ? { cls: "green", text: "SAP IAS" } : { cls: "gray", text: "setup token" },
    },
    {
      name: "Cloud Foundry login",
      purpose: "Runs the cf commands (services, apps, logs). Required. By passcode, or automatic with the management user.",
      state: cfOn ? { cls: "green", text: `signed in: ${ctx.login.user || "…"}` } : { cls: "gray", text: "not signed in" },
    },
    {
      name: "SAP BTP login",
      purpose: "Optional. Only for the automatic role assignment in Setup step 1 and for Figaf Tool deployments.",
      state: btpOn ? { cls: "green", text: "signed in" } : { cls: "gray", text: "not signed in" },
    },
    {
      name: "Management user",
      purpose: "A technical CF user in the Credential Store. Lets the manager sign in by itself after every restart.",
      state: stored === null
        ? { cls: "gray", text: "checking…" }
        : stored.available
          ? { cls: "green", text: `stored: ${stored.username || ""}` }
          : { cls: "gray", text: stored.bindingPresent ? "not set up" : "needs the Credential Store binding" },
    },
  ];
  return (
    <div className="card access-map">
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
        <div style={{ fontWeight: 700 }}>How this manager signs you in</div>
        <span className={`pill ${ssoMode ? "green" : "gray"}`}>{ssoMode ? "persistent SSO active" : "bootstrap mode"}</span>
      </div>
      <p style={{ fontSize: 13, color: "var(--ink-3)", margin: "0 0 6px" }}>
        Four things are called "sign-in" here. This is what each one is for, and where it stands.
      </p>
      {rows.map((r) => (
        <div key={r.name} className="access-row" data-access={r.name}>
          <div className="access-name">{r.name}</div>
          <div className="access-purpose">{r.purpose}</div>
          <span className={`pill ${r.state.cls}`}>{r.state.text}</span>
        </div>
      ))}
    </div>
  );
}

function ScreenSession({ ctx, setCtx, appendLog, addBtpFromRoute }) {
  const api = typeof window !== "undefined" ? window.figaf : null;
  const [addBtp, setAddBtp] = React.useState(!!addBtpFromRoute);
  // #/session/add-btp (the Setup page's "Add BTP login first"): open the BTP
  // form at once, and return to the Setup when the login is done.
  React.useEffect(() => { if (addBtpFromRoute) setAddBtp(true); }, [addBtpFromRoute]);
  React.useEffect(() => {
    if (addBtpFromRoute && addBtp && ctx.login.btpStatus === "done" && typeof window !== "undefined") {
      setAddBtp(false);
      window.location.hash = "#/setup";
    }
  }, [addBtpFromRoute, addBtp, ctx.login.btpStatus]);
  function leaveAddBtp() {
    setAddBtp(false);
    if (addBtpFromRoute && typeof window !== "undefined") window.location.hash = "#/setup";
  }
  const [signingOut, setSigningOut] = React.useState(false);
  const signedIn = ctx.login.cfStatus === "done";

  async function signOut() {
    setSigningOut(true);
    try { await api.cf.logout(); } catch { /* already logged out */ }
    try { await api.btp.logout(); } catch { /* btp may not be logged in */ }
    setSigningOut(false);
    setAddBtp(false);
    setCtx((c) => ({
      ...c,
      login: {
        ...c.login,
        btpStatus: "idle",
        cfStatus: "idle",
        cfOnly: false,
        passcodeRequested: false,
        passcode: "",
        user: "",
        landscape: "",
        apiUrl: "",
        subaccount: "",
        subdomain: "",
        provider: "",
        org: "",
        space: "",
      },
    }));
  }

  // Signed out, or deliberately adding a BTP login: the full sign-in screen.
  if (!signedIn || addBtp) {
    return (
      <>
        {addBtp && (
          <div style={{ padding: "10px 28px 0" }}>
            <button className="btn-link" onClick={leaveAddBtp}>
              {addBtpFromRoute ? "← Back to the Setup" : "← Back to the session overview"}
            </button>
          </div>
        )}
        <ScreenLogin ctx={ctx} setCtx={setCtx} onNext={leaveAddBtp} appendLog={appendLog} gate />
      </>
    );
  }

  return (
    <div className="pane-body">
      <div className="pane-head">
        <div className="pane-eyebrow">Session &amp; access</div>
        <h1 className="pane-title">Who the manager works as</h1>
        <p className="pane-desc">
          Every action runs real <span className="kbd">btp</span> / <span className="kbd">cf</span> commands
          under this session's logins.
        </p>
      </div>

      <AccessMapCard ctx={ctx} />

      <div className="card" style={{ marginTop: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
          <div style={{ fontWeight: 700 }}>Cloud Foundry session</div>
          <span className="pill green">signed in</span>
          {ctx.login.cfOnly && <span className="pill gray">CF-only</span>}
        </div>
        <SessionInfoRow label="User" value={ctx.login.user} />
        <SessionInfoRow label="Org" value={ctx.login.org} />
        <SessionInfoRow label="Space" value={ctx.login.space} />
        <SessionInfoRow label="API" value={ctx.login.apiUrl} />
        <div style={{ marginTop: 10 }}>
          <button className="btn" onClick={signOut} disabled={signingOut}>
            {signingOut ? "Signing out…" : "Sign out"}
          </button>
        </div>
      </div>

      <div className="card" style={{ marginTop: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
          <div style={{ fontWeight: 700 }}>SAP BTP session</div>
          {ctx.login.btpStatus === "done"
            ? <span className="pill green">signed in</span>
            : <span className="pill gray">not signed in</span>}
        </div>
        {ctx.login.btpStatus === "done" ? (
          <>
            <SessionInfoRow label="Subaccount" value={ctx.login.subaccount} />
            <SessionInfoRow label="Subdomain" value={ctx.login.subdomain} />
            <SessionInfoRow label="Landscape" value={ctx.login.landscape} />
          </>
        ) : (
          <>
            <p style={{ fontSize: 13, color: "var(--ink-3)", margin: "0 0 10px" }}>
              Optional. Needed only for: deploying a new Figaf Tool, connecting it to Integration
              Suite, and the automatic role assignment in Setup step 1. Everything else works without it.
            </p>
            <button className="btn" onClick={() => setAddBtp(true)}>Add BTP login</button>
          </>
        )}
      </div>

      <MgmtUserCard />
    </div>
  );
}

Object.assign(window, { ScreenSession });
