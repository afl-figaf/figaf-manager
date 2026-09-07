/* global React, Ico, WizardFooter, ScrollReveal */

const fg = () => (typeof window !== "undefined" && window.figaf) || null;

// Keep byte-identical with packages/core/cf-landscape.js (the renderer has no
// bundler, so it can't require the core copy). Derives the CF landscape label
// from a CF API URL; returns "" for custom / non-standard hosts.
function landscapeFromApiUrl(apiUrl) {
  try {
    let s = String(apiUrl || "").trim();
    if (!s) return "";
    if (!/^[a-z]+:\/\//i.test(s)) s = "https://" + s;
    const host = new URL(s).hostname.toLowerCase();
    const m = /^api\.(.+)\.hana\.ondemand\.com$/.exec(host);
    return m ? m[1] : "";
  } catch {
    return "";
  }
}

// Lenient "is this a usable http(s) endpoint" check (scheme optional). Used to
// gate the "Get passcode" button while the operator types a CF API URL.
function isValidApiUrl(s) {
  try {
    let v = String(s || "").trim();
    if (!v) return false;
    if (!/^[a-z]+:\/\//i.test(v)) v = "https://" + v;
    const u = new URL(v);
    return !!u.hostname && u.hostname.includes(".");
  } catch {
    return false;
  }
}

// ═══════════════════════════════════════════════════════════
// 2. CLI Login — SSO + passcode
// ═══════════════════════════════════════════════════════════
// gate: rendered as the console's auth gate (no wizard wording, no footer).
// embedded: rendered INSIDE another page (the Setup page): only the cards,
// no page header - the host page says why the sign-in is needed.
function ScreenLogin({ ctx, setCtx, onNext, appendLog, gate, embedded }) {
  const { login } = ctx;
  const setLogin = (patch) => setCtx(c => ({ ...c, login: { ...c.login, ...patch } }));
  const [gaChoice, setGaChoice] = React.useState(null);
  const [subaccountChoice, setSubaccountChoice] = React.useState(null);
  const [orgChoice, setOrgChoice] = React.useState(null);
  const [spaceChoice, setSpaceChoice] = React.useState(null);
  // The manager's own org/space when the passcode login will be pinned to them
  // (server side: cf-target.js resolveSelfPin). null = the operator still gets
  // the org/space picker (desktop, or a login to another CF landscape).
  const [ownTarget, setOwnTarget] = React.useState(null);
  const [cfSwitchingOrg, setCfSwitchingOrg] = React.useState(false);
  // Stored management user (SAP Credential Store) — probed once; the server
  // caches the probe, so re-renders don't burn credstore rate limit.
  const [storedUser, setStoredUser] = React.useState(null);
  // Setup form for storing/replacing the management user via the UI.
  const [mgmtSetupOpen, setMgmtSetupOpen] = React.useState(false);
  const [mgmtUsername, setMgmtUsername] = React.useState("");
  const [mgmtPassword, setMgmtPassword] = React.useState("");
  const [mgmtStoring, setMgmtStoring] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fg()?.login?.storedUserStatus?.();
        if (!cancelled && r && r.ok) setStoredUser(r);
      } catch { /* surface stays hidden */ }
    })();
    return () => { cancelled = true; };
  }, []);

  // Verify + store the management user through the manager itself (no script):
  // the server checks the login against CF in a throw-away CF_HOME, then
  // writes the credential encrypted into the Credential Store.
  async function storeManagementUser() {
    const api = fg();
    if (!api || !api.login || mgmtStoring) return;
    setMgmtStoring(true);
    try {
      const r = await api.login.storeManagementUser({ username: mgmtUsername.trim(), password: mgmtPassword });
      if (r && r.ok) {
        setStoredUser({ ok: true, available: true, bindingPresent: true, username: r.username });
        setMgmtSetupOpen(false);
        setMgmtUsername("");
        setMgmtPassword("");
        appendLog([{ type: "ok", text: `Management user ${r.username} verified and stored.` }]);
      } else {
        appendLog([{ type: "err", text: (r && r.error) || "Storing the management user failed" }]);
      }
    } finally {
      setMgmtStoring(false);
    }
  }

  const btpLoggedIn = login.btpStatus === "done";
  const cfLoggedIn = login.cfStatus === "done";
  // CF-only mode: BTP was skipped, so the CF section is usable on its own.
  const cfOnly = !!login.cfOnly;
  const cfReady = btpLoggedIn || cfOnly;
  const canContinue = cfReady && cfLoggedIn;
  const showCfOnly = !!(window.figafModeFlags.features && window.figafModeFlags.features.cfOnlyLogin);
  // Console gate, first sign-in: Cloud Foundry is what the FAID Apps install needs,
  // the BTP login is optional (persistent-SSO role assignment, Figaf Tool
  // deployments). Only while NEITHER login exists - "Add BTP login" from
  // Session & access (CF already signed in) keeps the BTP-first layout.
  const cfFirst = !!(gate && window.figafModeFlags.features && window.figafModeFlags.features.cfFirstLogin)
    && !cfLoggedIn && !btpLoggedIn;
  React.useEffect(() => {
    if (cfFirst && !cfOnly && login.btpStatus === "idle") enterCfOnly();
    // eslint-disable-next-line
  }, [cfFirst]);
  // Display host for the CF card / passcode hint. Empty for a custom landscape.
  const cfApiHost = login.landscape ? `api.${login.landscape.replace(/^cf-/, "cf.")}.hana.ondemand.com` : "";

  React.useEffect(() => {
    const api = fg();
    if (!api || !api.cf || !api.cf.ownTarget || cfLoggedIn) return;
    let alive = true;
    (async () => {
      try {
        const r = await api.cf.ownTarget(login.apiUrl || "");
        if (alive) setOwnTarget((r && r.ok && r.pinned) || null);
      } catch (e) { /* backend without the handler: keep the picker */ }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line
  }, [login.apiUrl, cfLoggedIn]);

  React.useEffect(() => {
    const api = fg();
    if (!api) return;
    const offCf1 = api.on("cf:loggedIn", () => {
      setOrgChoice(null);
      setSpaceChoice(null);
      setCfSwitchingOrg(false);
      setLogin({ cfStatus: "done", cfError: "" });
      (async () => {
        const t = await api.cf.targetOrgSpace();
        if (t && t.ok) setLogin({ org: t.org, space: t.space, user: t.user || login.user });
      })();
    });
    const offCf2 = api.on("cf:loginFailed", (p) => {
      setOrgChoice(null);
      setSpaceChoice(null);
      setCfSwitchingOrg(false);
      // A pinned login can fail for a reason the operator can fix (no role in
      // the manager's own space). The server explains it - show that text.
      setLogin({ cfStatus: "error", cfError: (p && p.error) || "" });
    });
    const offCfOrgChoice = api.on("cf:orgChoice", (p) => setOrgChoice(p));
    const offCfSpaceChoice = api.on("cf:spaceChoice", (p) => setSpaceChoice(p));
    const offSwitchDone = api.on("cf:switchOrgDone", ({ org, space }) => {
      setCfSwitchingOrg(false);
      setOrgChoice(null);
      setSpaceChoice(null);
      setLogin({ org, space });
    });

    const offGaChoice = api.on("btp:gaChoice", (p) => {
      setSubaccountChoice(null);
      setGaChoice(p);
    });
    const offSubChoice = api.on("btp:subaccountChoice", (p) => {
      setSubaccountChoice(p);
    });
    const offBtpOk = api.on("btp:loggedIn", (env) => {
      setGaChoice(null);
      setSubaccountChoice(null);
      if (env && env.ok) {
        setLogin({
          btpStatus: "done",
          landscape: env.landscape,
          subaccount: env.subaccount || "",
          subaccountName: env.subaccountName || "",
          subdomain: env.subdomain || "",
          provider: env.provider || "",
          org: env.org || "",
          apiUrl: env.apiUrl,
        });
      } else {
        setLogin({ btpStatus: "error" });
      }
    });
    const offBtpFail = api.on("btp:loginFailed", () => {
      setGaChoice(null);
      setSubaccountChoice(null);
      setLogin({ btpStatus: "error" });
    });
    const offBtpSso = api.on("btp:ssoUrl", ({ url }) => {
      api.shell.openExternal(url);
    });

    return () => {
      offCf1 && offCf1();
      offCf2 && offCf2();
      offCfOrgChoice && offCfOrgChoice();
      offCfSpaceChoice && offCfSpaceChoice();
      offSwitchDone && offSwitchDone();
      offGaChoice && offGaChoice();
      offSubChoice && offSubChoice();
      offBtpOk && offBtpOk();
      offBtpFail && offBtpFail();
      offBtpSso && offBtpSso();
    };
    // eslint-disable-next-line
  }, []);

  async function startBtpLogin() {
    const api = fg();
    if (!api) return;
    setGaChoice(null);
    setSubaccountChoice(null);
    setLogin({ btpStatus: "running" });
    await api.btp.loginStart();
  }

  async function cancelBtpLogin() {
    const api = fg();
    if (!api) return;
    setGaChoice(null);
    setSubaccountChoice(null);
    await api.btp.cancelLogin();
    setLogin({ btpStatus: "idle" });
  }

  // Skip BTP entirely and connect straight to Cloud Foundry. Pre-fills the API
  // URL from the host (hosted manager knows its own endpoint via VCAP; desktop
  // returns "").
  async function enterCfOnly() {
    const api = fg();
    setGaChoice(null);
    setSubaccountChoice(null);
    setLogin({ cfOnly: true });
    let apiUrl = "";
    try {
      const r = await api?.cf?.suggestedApiUrl?.();
      if (r && r.ok) apiUrl = r.apiUrl || "";
    } catch {}
    setLogin({ apiUrl, landscape: apiUrl ? landscapeFromApiUrl(apiUrl) : "" });
  }

  // Back out of CF-only mode and restore the normal BTP login flow. Only
  // offered before CF login completes, so there's no CF session to tear down.
  function revertCfOnly() {
    setOrgChoice(null);
    setSpaceChoice(null);
    setLogin({
      cfOnly: false,
      cfStatus: "idle",
      apiUrl: "",
      landscape: "",
      passcode: "",
      passcodeRequested: false,
      org: "",
      space: "",
    });
  }

  async function selectSubaccount(guid) {
    const api = fg();
    if (!api) return;
    setSubaccountChoice(null);
    setLogin({ btpStatus: "running" });
    const r = await api.btp.selectSubaccount(guid);
    if (r && r.ok === false) {
      appendLog([{ type: "err", text: r.error || "Failed to target subaccount" }]);
      setLogin({ btpStatus: "error" });
    }
  }

  async function selectGa(index) {
    const api = fg();
    if (!api) return;
    setGaChoice(null);
    setSubaccountChoice(null);
    setLogin({ btpStatus: "running" });
    await api.btp.selectGlobalAccount(index);
  }

  async function goBackToGaPicker() {
    const api = fg();
    if (!api) return;
    setSubaccountChoice(null);
    setLogin({ btpStatus: "running" });
    await api.btp.listGlobalAccounts();
  }

  async function switchGlobalAccount() {
    const api = fg();
    if (!api) return;
    setGaChoice(null);
    setSubaccountChoice(null);
    setOrgChoice(null);
    setSpaceChoice(null);
    setLogin({
      btpStatus: "running",
      cfStatus: "idle",
      cfOnly: false,
      landscape: "", subaccount: "", subaccountName: "", subdomain: "", provider: "", org: "", space: "", user: "", apiUrl: "",
      passcode: "", passcodeRequested: false,
    });
    setCtx(c => ({ ...c, config: { ...c.config, trialPg: undefined, dbParams: {} } }));
    await api.btp.listGlobalAccounts();
  }

  async function handleLogout() {
    const api = fg();
    if (!api) return;
    await api.btp.logout();
    setLogin({
      btpStatus: "idle", cfStatus: "idle", cfOnly: false,
      landscape: "", subaccount: "", subaccountName: "", subdomain: "", provider: "", org: "", space: "", user: "", apiUrl: "",
      passcode: "", passcodeRequested: false,
    });
    // Clear PostgreSQL auto-detection so the next login re-seeds it from the
    // new global account's subdomain (trial vs real tenant can differ).
    setCtx(c => ({ ...c, config: { ...c.config, trialPg: undefined, dbParams: {} } }));
  }

  async function handleCfLogout() {
    const api = fg();
    if (!api) return;
    await api.cf.logout();
    setCfSwitchingOrg(false);
    setOrgChoice(null);
    setSpaceChoice(null);
    setLogin({
      cfStatus: "idle",
      org: "", space: "",
      passcode: "", passcodeRequested: false,
    });
  }

  async function switchCfOrg() {
    const api = fg();
    if (!api) return;
    setOrgChoice(null);
    setSpaceChoice(null);
    setCfSwitchingOrg(true);
    const r = await api.cf.switchOrgStart();
    if (r && r.ok === false) {
      appendLog([{ type: "err", text: r.error || "Failed to list orgs" }]);
      setCfSwitchingOrg(false);
    }
  }

  async function cancelCfSwitch() {
    const api = fg();
    if (!api) return;
    setCfSwitchingOrg(false);
    setOrgChoice(null);
    setSpaceChoice(null);
    const t = await api.cf.targetOrgSpace();
    if (t && t.ok) setLogin(l => ({ ...l, org: t.org || l.org, space: t.space || l.space }));
  }

  async function selectCfOrg(index) {
    const api = fg();
    if (!api) return;
    setOrgChoice(null);
    if (cfSwitchingOrg) {
      const r = await api.cf.switchSelectOrg(index);
      if (r && r.ok === false) {
        appendLog([{ type: "err", text: r.error || "Failed to select org" }]);
        setCfSwitchingOrg(false);
      }
      return;
    }
    const r = await api.cf.selectOrg(index);
    if (r && r.ok === false) {
      appendLog([{ type: "err", text: r.error || "Failed to select org" }]);
      setLogin({ cfStatus: "error" });
    }
  }

  async function selectCfSpace(index) {
    const api = fg();
    if (!api) return;
    setSpaceChoice(null);
    if (cfSwitchingOrg) {
      const r = await api.cf.switchSelectSpace(index);
      if (r && r.ok === false) {
        appendLog([{ type: "err", text: r.error || "Failed to select space" }]);
        setCfSwitchingOrg(false);
      }
      return;
    }
    const r = await api.cf.selectSpace(index);
    if (r && r.ok === false) {
      appendLog([{ type: "err", text: r.error || "Failed to select space" }]);
      setLogin({ cfStatus: "error" });
    }
  }

  // One click, no passcode: the server fetches the technical user from the
  // Credential Store, runs cf auth (credentials only in the child process
  // env), and targets the manager's own org/space.
  async function loginWithStoredUser() {
    const api = fg();
    if (!api || !api.login) return;
    setLogin({ cfStatus: "running" });
    const r = await api.login.withStoredUser();
    if (r && r.ok) {
      setLogin({
        cfStatus: "done",
        user: r.user,
        org: r.org,
        space: r.space,
        apiUrl: r.apiUrl || login.apiUrl,
        landscape: login.landscape || landscapeFromApiUrl(r.apiUrl || ""),
      });
    } else {
      appendLog([{ type: "err", text: (r && r.error) || "Stored-user sign-in failed" }]);
      setLogin({ cfStatus: "error" });
    }
  }

  async function requestPasscode() {
    const api = fg();
    if (!api) return;
    // CF-only: normalize the typed endpoint (add scheme if missing) and (re)derive
    // the landscape so the passcode URL is right even if the user pasted+edited.
    let apiUrl = login.apiUrl;
    let landscape = login.landscape;
    if (cfOnly) {
      if (apiUrl && !/^[a-z]+:\/\//i.test(apiUrl)) apiUrl = "https://" + apiUrl;
      landscape = landscapeFromApiUrl(apiUrl);
      if (apiUrl !== login.apiUrl || landscape !== login.landscape) setLogin({ apiUrl, landscape });
    }
    if (!apiUrl && landscape) {
      apiUrl = `https://api.${landscape.replace(/^cf-/, "cf.")}.hana.ondemand.com`;
    }
    setLogin({ passcodeRequested: true, cfError: "" });
    // Open the passcode page only when we know the landscape. On a custom /
    // sovereign host we couldn't derive it — skip the auto-open (the operator
    // fetches the passcode from their own SSO page) but never block login.
    if (landscape) await api.shell.openPasscodeUrl(landscape);
    await api.cf.loginStart(apiUrl);
  }

  async function submitPasscode() {
    const api = fg();
    if (!api) return;
    if (!login.passcode || login.passcode.length < 4) return;
    setLogin({ cfStatus: "running", cfError: "" });
    // Success path: cf process closes → cf:loggedIn / cf:loginFailed events flip
    // cfStatus. If the handler itself reports failure (e.g. cf already exited,
    // bad shim wiring) we have to flip back here — otherwise the button is
    // stuck on "Authenticating…" forever.
    const r = await api.cf.submitPasscode(login.passcode);
    if (r && r.ok === false) {
      appendLog([{ type: "err", text: r.error || "Failed to submit passcode" }]);
      setLogin({ cfStatus: "error" });
    }
  }

  async function pastePasscode() {
    const api = fg();
    if (!api) return;
    try {
      const r = await api.shell.readClipboard();
      if (!r || !r.ok) {
        appendLog([{ type: "warn", text: "Could not read clipboard." }]);
        return;
      }
      const value = (r.text || "").trim();
      if (!value) {
        appendLog([{ type: "warn", text: "Clipboard is empty." }]);
        return;
      }
      setLogin({ passcode: value });
    } catch {
      appendLog([{ type: "warn", text: "Could not read clipboard." }]);
    }
  }

  // The two sign-in cards. Order: BTP first in the wizard and when adding a
  // BTP login to an existing CF session; Cloud Foundry first on the console
  // gate (cfFirst) - the FAID Apps install needs only cf.
  const btpCard = (
        <div className="card">
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: (btpLoggedIn || gaChoice || subaccountChoice) ? 10 : 14 }}>
            <div style={{ width: 36, height: 36, borderRadius: 8, background: "var(--fg-blue-soft)", color: "var(--fg-blue)", display: "grid", placeItems: "center" }}>
              <Ico.Cloud />
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13.5, fontWeight: 600, color: "var(--ink-0)" }}>SAP BTP CLI</div>
              <div style={{ fontSize: 12, color: "var(--ink-3)" }}>
                {cfOnly && !btpLoggedIn
                  ? (cfFirst
                    ? "Optional - only for the persistent-SSO role assignment and Figaf Tool deployments"
                    : "Skipped — Cloud Foundry only")
                  : "cli.btp.cloud.sap"}
              </div>
            </div>
            {btpLoggedIn && <span className="pill green"><Ico.Check /> Connected</span>}
            {btpLoggedIn && (
              <button className="btn btn-ghost" style={{ fontSize: 12, padding: "4px 10px" }} onClick={switchGlobalAccount}>
                <Ico.Refresh /> Switch Account
              </button>
            )}
            {btpLoggedIn && (
              <button className="btn btn-ghost" style={{ fontSize: 12, padding: "4px 10px" }} onClick={handleLogout}>
                Sign out
              </button>
            )}
            {!btpLoggedIn && login.btpStatus === "running" && (gaChoice || subaccountChoice) && (
              <span className="pill blue">Awaiting selection</span>
            )}
            {!btpLoggedIn && login.btpStatus === "running" && !gaChoice && !subaccountChoice && (
              <span className="pill blue"><Ico.Spinner /> Connecting…</span>
            )}
            {showCfOnly && !cfOnly && !btpLoggedIn && (login.btpStatus === "idle" || login.btpStatus === "error") && (
              <button className="btn btn-ghost" style={{ fontSize: 12, padding: "4px 10px" }} onClick={enterCfOnly} title="No global account? Connect straight to Cloud Foundry.">
                Skip BTP login
              </button>
            )}
            {!cfOnly && login.btpStatus === "idle" && (
              <button className="btn btn-primary" onClick={startBtpLogin}>
                Sign in with SSO <Ico.External />
              </button>
            )}
            {!cfOnly && login.btpStatus === "error" && (
              <button className="btn btn-primary" onClick={startBtpLogin}>
                Retry <Ico.External />
              </button>
            )}
            {cfOnly && !btpLoggedIn && (
              <>
                <span className="pill gray">{cfFirst ? "optional" : "Skipped"}</span>
                {!cfLoggedIn && (
                  <button className="btn btn-ghost" style={{ fontSize: 12, padding: "4px 10px" }} onClick={revertCfOnly}>
                    {cfFirst ? "Sign in with SSO instead" : "Use BTP login instead"}
                  </button>
                )}
                {cfLoggedIn && (
                  <button
                    className="btn btn-ghost"
                    style={{ fontSize: 12, padding: "4px 10px" }}
                    title="Sign in to SAP BTP as well — enables Deploy / Connect / SSO upgrade. Your Cloud Foundry login is kept."
                    onClick={() => setLogin({ cfOnly: false, btpStatus: "idle" })}
                  >
                    Add BTP login
                  </button>
                )}
              </>
            )}
          </div>

          {!btpLoggedIn && gaChoice && gaChoice.accounts && gaChoice.accounts.length > 0 && (
            <ScrollReveal>
            <div className="slide-in" style={{ borderTop: "1px solid var(--border)", paddingTop: 12, marginTop: 4 }}>
              <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--ink-3)", marginBottom: 4 }}>
                Choose a global account
              </div>
              <div style={{ fontSize: 12, color: "var(--ink-3)", marginBottom: 10 }}>
                Your account has access to multiple global accounts. Pick the one you want to deploy to.
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {gaChoice.accounts.map((acct) => (
                  <button
                    key={acct.index}
                    className="choice"
                    style={{ flexDirection: "row", alignItems: "center", padding: "12px 14px", gap: 14, textAlign: "left" }}
                    onClick={() => selectGa(acct.index)}
                  >
                    <div style={{ width: 28, height: 28, borderRadius: 6, background: "var(--fg-blue-soft)", color: "var(--fg-blue)", display: "grid", placeItems: "center", flexShrink: 0, fontSize: 12, fontWeight: 600, fontFamily: "var(--font-mono)" }}>
                      {acct.index}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: "var(--ink-0)" }}>{acct.name}</div>
                      {acct.subaccounts && acct.subaccounts.length > 0 && (
                        <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 3, display: "flex", flexWrap: "wrap", gap: 4 }}>
                          {acct.subaccounts.map((s) => (
                            <span key={s.index} style={{ background: "var(--bg-2)", borderRadius: 4, padding: "1px 6px", fontFamily: "var(--font-mono)" }}>{s.name}</span>
                          ))}
                        </div>
                      )}
                    </div>
                    <Ico.ArrowRight />
                  </button>
                ))}
              </div>
              <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 10 }}>
                <button className="btn btn-ghost" style={{ fontSize: 12, padding: "4px 10px" }} onClick={cancelBtpLogin}>
                  Cancel sign-in
                </button>
              </div>
            </div>
            </ScrollReveal>
          )}

          {!btpLoggedIn && subaccountChoice && subaccountChoice.subaccounts && subaccountChoice.subaccounts.length > 0 && (
            <ScrollReveal>
            <div className="slide-in" style={{ borderTop: "1px solid var(--border)", paddingTop: 12, marginTop: 4 }}>
              <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--ink-3)", marginBottom: 4 }}>
                Choose a subaccount
              </div>
              {subaccountChoice.globalAccountName && (
                <div style={{ fontSize: 12, color: "var(--ink-2)", marginBottom: 6 }}>
                  Global account: <strong>{subaccountChoice.globalAccountName}</strong>
                </div>
              )}
              <div style={{ fontSize: 12, color: "var(--ink-3)", marginBottom: 10 }}>
                Pick the subaccount you want to deploy to. Subaccounts without a Cloud Foundry environment are shown but cannot be selected.
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {subaccountChoice.subaccounts.map((sa, i) => {
                  const region = sa.region;
                  const provider = sa.provider;
                  const meta = [
                    region && `region: ${region}`,
                    provider && `provider: ${provider}`,
                    sa.subdomain && `subdomain: ${sa.subdomain}`,
                  ].filter(Boolean);
                  const disabled = !sa.cfEnabled;
                  return (
                    <button
                      key={sa.guid || i}
                      className="choice"
                      disabled={disabled}
                      title={disabled ? "No Cloud Foundry environment in this subaccount" : undefined}
                      style={{
                        flexDirection: "row",
                        alignItems: "center",
                        padding: "12px 14px",
                        gap: 14,
                        textAlign: "left",
                        opacity: disabled ? 0.5 : 1,
                        cursor: disabled ? "not-allowed" : "pointer",
                      }}
                      onClick={() => { if (!disabled) selectSubaccount(sa.guid); }}
                    >
                      <div style={{ width: 28, height: 28, borderRadius: 6, background: "var(--fg-blue-soft)", color: "var(--fg-blue)", display: "grid", placeItems: "center", flexShrink: 0, fontSize: 12, fontWeight: 600, fontFamily: "var(--font-mono)" }}>
                        {i + 1}
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 600, color: "var(--ink-0)", display: "flex", alignItems: "center", gap: 8 }}>
                          {sa.displayName || sa.guid || `Subaccount ${i + 1}`}
                          {disabled && <span className="pill gray" style={{ fontSize: 10 }}>No CF</span>}
                        </div>
                        {meta.length > 0 && (
                          <div style={{ fontSize: 11.5, color: "var(--ink-3)", marginTop: 2, fontFamily: "var(--font-mono)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                            {meta.join(" · ")}
                          </div>
                        )}
                      </div>
                      {!disabled && <Ico.ArrowRight />}
                    </button>
                  );
                })}
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", marginTop: 10 }}>
                <button className="btn btn-ghost" style={{ fontSize: 12, padding: "4px 10px" }} onClick={goBackToGaPicker}>
                  <Ico.Refresh /> Switch global account
                </button>
                <button className="btn btn-ghost" style={{ fontSize: 12, padding: "4px 10px" }} onClick={cancelBtpLogin}>
                  Cancel sign-in
                </button>
              </div>
            </div>
            </ScrollReveal>
          )}

          {btpLoggedIn && (
            <ScrollReveal>
            <div className="summary-grid slide-in">
              {login.subdomain && <div className="cell"><div className="k">Global account</div><div className="v">{login.subdomain}</div></div>}
              {login.subaccountName && <div className="cell"><div className="k">Subaccount</div><div className="v">{login.subaccountName}</div></div>}
              {login.subaccount && <div className="cell"><div className="k">Subaccount ID</div><div className="v">{login.subaccount}</div></div>}
              {login.org && <div className="cell"><div className="k">Org</div><div className="v">{login.org}</div></div>}
              <div className="cell"><div className="k">Landscape</div><div className="v">{login.landscape}</div></div>
              <div className="cell"><div className="k">API endpoint</div><div className="v">api.{login.landscape.replace(/^cf-/, 'cf.')}.hana.ondemand.com</div></div>
            </div>
            </ScrollReveal>
          )}
        </div>
  );
  const cfCard = (
        <div className="card" style={{ opacity: cfReady ? 1 : 0.55 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
            <div style={{ width: 36, height: 36, borderRadius: 8, background: "var(--fg-blue-soft)", color: "var(--fg-blue)", display: "grid", placeItems: "center" }}>
              <Ico.Box />
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13.5, fontWeight: 600, color: "var(--ink-0)" }}>Cloud Foundry CLI</div>
              <div style={{ fontSize: 12, color: "var(--ink-3)" }}>
                {btpLoggedIn
                  ? cfApiHost
                  : cfOnly
                    ? (login.apiUrl ? login.apiUrl.replace(/^https?:\/\//, "") : "Enter your CF API URL below")
                    : "Detected after BTP login"}
              </div>
            </div>
            {cfFirst && <span className="pill blue">required</span>}
            {cfLoggedIn && <span className="pill green"><Ico.Check /> Connected</span>}
            {cfLoggedIn && (
              <button className="btn btn-ghost" style={{ fontSize: 12, padding: "4px 10px" }} onClick={handleCfLogout}>
                Sign out
              </button>
            )}
            {cfLoggedIn && !cfSwitchingOrg && (
              <button className="btn btn-ghost" style={{ fontSize: 12, padding: "4px 10px" }} onClick={switchCfOrg}>
                <Ico.Refresh /> Switch Org
              </button>
            )}
          </div>

          {cfReady && !cfLoggedIn && !cfSwitchingOrg && (
            <div className="slide-in">
              {login.cfError && (
                <div style={{ marginBottom: 12, padding: "10px 12px", borderRadius: 8, fontSize: 12, lineHeight: 1.5, background: "var(--fg-red-soft, #fdecea)", color: "var(--fg-red, #c0392b)" }}>
                  {login.cfError}
                </div>
              )}
              {!login.passcodeRequested ? (
                <div>
                  {/* The stored management user comes FIRST: when it exists, one
                      click signs in; when only the Credential Store exists, storing
                      the user is the right next step. The passcode is the fallback. */}
                  {storedUser && storedUser.available && (
                    <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 12, flexWrap: "wrap" }}>
                      <button className="btn btn-primary" onClick={loginWithStoredUser} disabled={login.cfStatus === "running"}>
                        {login.cfStatus === "running"
                          ? <><Ico.Spinner /> Signing in…</>
                          : <>Sign in with stored management user</>}
                      </button>
                      <span style={{ fontSize: 12, color: "var(--ink-3)" }}>
                        <span className="kbd">{storedUser.username}</span> from SAP Credential Store — no passcode needed.{" "}
                        <button className="btn-link" onClick={() => setMgmtSetupOpen((o) => !o)}>Replace user</button>
                      </span>
                    </div>
                  )}
                  {storedUser && !storedUser.available && storedUser.bindingPresent && !mgmtSetupOpen && (
                    <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 12, flexWrap: "wrap" }}>
                      <button className="btn btn-primary" onClick={() => setMgmtSetupOpen(true)}>
                        Set up management user
                      </button>
                      <span style={{ fontSize: 12, color: "var(--ink-3)" }}>
                        Store a technical CF user in SAP Credential Store — then no passcode is needed again.
                      </span>
                    </div>
                  )}
                  {cfOnly && (
                    <div className="field" style={{ marginBottom: 12 }}>
                      <label className="field-label">
                        Cloud Foundry API URL <span className="field-required">*</span>
                      </label>
                      <input
                        className="input is-mono"
                        placeholder="https://api.cf.us10.hana.ondemand.com"
                        value={login.apiUrl}
                        onChange={(e) => {
                          const v = e.target.value.trim();
                          setLogin({ apiUrl: v, landscape: landscapeFromApiUrl(v) });
                        }}
                      />
                      <div className="field-hint">
                        From the BTP cockpit, open your subaccount → <span className="kbd">Cloud Foundry · Environment</span> and copy the API endpoint.
                      </div>
                    </div>
                  )}
                  {ownTarget && (
                    <div style={{ marginBottom: 12, padding: "10px 12px", borderRadius: 8, fontSize: 12, lineHeight: 1.5, background: "var(--fg-blue-soft, #eef4ff)", color: "var(--ink-2)" }}>
                      <div style={{ fontWeight: 600, color: "var(--ink-0)" }}>
                        Target: <span className="kbd">{ownTarget.org}</span> / <span className="kbd">{ownTarget.space}</span>
                      </div>
                      <div style={{ marginTop: 3 }}>
                        This manager runs in that space and installs the FAID Apps there. The
                        sign-in targets it for you, so there is no org or space to choose.
                      </div>
                    </div>
                  )}
                  <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                    <button className={`btn ${storedUser && storedUser.bindingPresent ? "" : "btn-primary"}`} onClick={requestPasscode} disabled={cfOnly && !isValidApiUrl(login.apiUrl)}>
                      Get passcode in browser <Ico.External />
                    </button>
                    <span style={{ fontSize: 12, color: "var(--ink-3)" }}>
                      {cfApiHost
                        ? <>Opens <span className="kbd">login.{login.landscape.replace(/^cf-/, "cf.")}.hana.ondemand.com/passcode</span></>
                        : "Then open your CF passcode page and paste the one-time code."}
                    </span>
                  </div>
                  {storedUser && storedUser.bindingPresent && mgmtSetupOpen && (
                    <div style={{ marginTop: 12, padding: 12, border: "1px solid var(--border)", borderRadius: 8 }}>
                      <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 4 }}>
                        {storedUser.available ? "Replace the management user" : "Set up the management user"}
                      </div>
                      <div style={{ fontSize: 12, color: "var(--ink-3)", marginBottom: 10 }}>
                        The credentials are first VERIFIED against Cloud Foundry (login + access to this
                        space, in an isolated check), then stored encrypted in SAP Credential Store.
                        They never appear in the terminal or logs. The account must have password
                        login (no 2FA) and the Space Developer role in this space.
                      </div>
                      <div className="field" style={{ marginBottom: 8 }}>
                        <label className="field-label">Technical user e-mail</label>
                        <input
                          className="input is-mono"
                          placeholder="figaf-manager-tech@example.com"
                          autoComplete="off"
                          value={mgmtUsername}
                          onChange={(e) => setMgmtUsername(e.target.value)}
                          disabled={mgmtStoring}
                        />
                      </div>
                      <div className="field" style={{ marginBottom: 10 }}>
                        <label className="field-label">Password</label>
                        <input
                          className="input is-mono"
                          type="password"
                          autoComplete="new-password"
                          value={mgmtPassword}
                          onChange={(e) => setMgmtPassword(e.target.value)}
                          disabled={mgmtStoring}
                        />
                      </div>
                      <div style={{ display: "flex", gap: 8 }}>
                        <button
                          className="btn btn-primary"
                          onClick={storeManagementUser}
                          disabled={mgmtStoring || !mgmtUsername.trim() || !mgmtPassword}
                        >
                          {mgmtStoring ? <><Ico.Spinner /> Verifying &amp; storing…</> : <>Verify &amp; store</>}
                        </button>
                        <button className="btn" onClick={() => setMgmtSetupOpen(false)} disabled={mgmtStoring}>
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <ScrollReveal>
                <div className="slide-in">
                  <div className="sso-mock" style={{ marginBottom: 12 }}>
                    <div className="sso-mock-icon"><Ico.Shield /></div>
                    <div style={{ flex: 1, fontSize: 12, color: "var(--ink-2)" }}>
                      {login.landscape
                        ? "Browser opened to get a one-time passcode. Copy it from SAP and paste below."
                        : "Open your Cloud Foundry passcode page, copy the one-time passcode, and paste it below."}
                    </div>
                  </div>
                  <div className="field">
                    <label className="field-label">
                      One-time passcode <span className="field-required">*</span>
                    </label>
                    <div style={{ display: "flex", gap: 8 }}>
                      <input
                        className="input is-mono"
                        placeholder="paste passcode"
                        value={login.passcode}
                        onChange={(e) => setLogin({ passcode: e.target.value.trim() })}
                        disabled={login.cfStatus === "running"}
                        style={{ flex: 1, letterSpacing: "0.12em" }}
                      />
                      <button
                        className="btn"
                        onClick={pastePasscode}
                        disabled={login.cfStatus === "running"}
                      >
                        Paste
                      </button>
                      <button
                        className="btn btn-primary"
                        onClick={submitPasscode}
                        disabled={!login.passcode || login.cfStatus === "running"}
                      >
                        {login.cfStatus === "running" ? <><Ico.Spinner /> Authenticating</> : <>Continue <Ico.ArrowRight /></>}
                      </button>
                    </div>
                    <div className="field-hint">
                      Passcodes expire after a few minutes.{" "}
                      {login.landscape
                        ? <button className="btn-link" onClick={() => fg()?.shell.openPasscodeUrl(login.landscape)}>Get a new one</button>
                        : "Reopen your CF passcode page for a new one."}
                    </div>
                  </div>
                </div>
                </ScrollReveal>
              )}
            </div>
          )}

          {(!cfLoggedIn || cfSwitchingOrg) && orgChoice && orgChoice.orgs && orgChoice.orgs.length > 0 && (
            <ScrollReveal>
            <div className="slide-in" style={{ borderTop: "1px solid var(--border)", paddingTop: 12, marginTop: 12 }}>
              <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--ink-3)", marginBottom: 4 }}>
                Choose a Cloud Foundry org
              </div>
              <div style={{ fontSize: 12, color: "var(--ink-3)", marginBottom: 10 }}>
                The CLI returned multiple orgs. {orgChoice.orgs.some(o => o.recommended)
                  ? <>The one matching your BTP subaccount org (<span className="kbd">{login.org}</span>) is recommended.</>
                  : "None match your BTP subaccount org — pick the one you want to deploy to."}
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {orgChoice.orgs.map((o) => (
                  <button
                    key={o.index}
                    className="choice"
                    style={{ flexDirection: "row", alignItems: "center", padding: "12px 14px", gap: 14, textAlign: "left" }}
                    onClick={() => selectCfOrg(o.index)}
                  >
                    <div style={{ width: 28, height: 28, borderRadius: 6, background: "var(--fg-blue-soft)", color: "var(--fg-blue)", display: "grid", placeItems: "center", flexShrink: 0, fontSize: 12, fontWeight: 600, fontFamily: "var(--font-mono)" }}>
                      {o.index}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: "var(--ink-0)", display: "flex", alignItems: "center", gap: 8 }}>
                        {o.name}
                        {o.recommended && <span className="pill green" style={{ fontSize: 10 }}><Ico.Check /> Recommended</span>}
                      </div>
                    </div>
                    <Ico.ArrowRight />
                  </button>
                ))}
              </div>
              {cfSwitchingOrg && (
                <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 10 }}>
                  <button className="btn btn-ghost" style={{ fontSize: 12, padding: "4px 10px" }} onClick={cancelCfSwitch}>
                    Cancel
                  </button>
                </div>
              )}
            </div>
            </ScrollReveal>
          )}

          {(!cfLoggedIn || cfSwitchingOrg) && spaceChoice && spaceChoice.spaces && spaceChoice.spaces.length > 0 && (
            <ScrollReveal>
            <div className="slide-in" style={{ borderTop: "1px solid var(--border)", paddingTop: 12, marginTop: 12 }}>
              <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--ink-3)", marginBottom: 4 }}>
                Choose a space
              </div>
              <div style={{ fontSize: 12, color: "var(--ink-3)", marginBottom: 10 }}>
                The selected org has multiple spaces. Pick the one you want to deploy to.
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {spaceChoice.spaces.map((s) => (
                  <button
                    key={s.index}
                    className="choice"
                    style={{ flexDirection: "row", alignItems: "center", padding: "12px 14px", gap: 14, textAlign: "left" }}
                    onClick={() => selectCfSpace(s.index)}
                  >
                    <div style={{ width: 28, height: 28, borderRadius: 6, background: "var(--fg-blue-soft)", color: "var(--fg-blue)", display: "grid", placeItems: "center", flexShrink: 0, fontSize: 12, fontWeight: 600, fontFamily: "var(--font-mono)" }}>
                      {s.index}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: "var(--ink-0)" }}>{s.name}</div>
                    </div>
                    <Ico.ArrowRight />
                  </button>
                ))}
              </div>
              {cfSwitchingOrg && (
                <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 10 }}>
                  <button className="btn btn-ghost" style={{ fontSize: 12, padding: "4px 10px" }} onClick={cancelCfSwitch}>
                    Cancel
                  </button>
                </div>
              )}
            </div>
            </ScrollReveal>
          )}

          {cfLoggedIn && (
            <ScrollReveal>
            <div className="summary-grid slide-in">
              {login.org && <div className="cell"><div className="k">Org</div><div className="v">{login.org}</div></div>}
              {login.space && <div className="cell"><div className="k">Space</div><div className="v">{login.space}</div></div>}
            </div>
            </ScrollReveal>
          )}
        </div>
  );

  const cards = (
    <div className="login-cards" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {cfFirst ? <>{cfCard}{btpCard}</> : <>{btpCard}{cfCard}</>}
    </div>
  );

  // Embedded in another page (the Setup): the cards only.
  if (embedded) return <div className="login-embedded">{cards}</div>;

  return (
    <>
      <div className="pane-body">
        <div className="pane-head">
          {/* In the console frame this screen is an auth GATE on the addressed
              page, not a wizard step - no step wording, no wizard footer. */}
          <div className="pane-eyebrow">{gate ? "Sign in" : "Step 2 · Authenticate"}</div>
          <h1 className="pane-title">{cfFirst ? "Sign in to Cloud Foundry" : "Sign in to SAP BTP and Cloud Foundry"}</h1>
          <p className="pane-desc">
            {cfFirst
              ? <>The manager runs <span className="kbd">cf</span> commands in your name. Get a one-time passcode in the browser and paste it here. A BTP login is optional and can be added later under Session &amp; access.</>
              : <>Both CLIs use single sign-on. We'll open your browser, then you'll paste a one-time passcode for the Cloud Foundry CLI.</>}
          </p>
        </div>

        {/* The wizard's method picker; the console gate has one method. */}
        {!gate && (
          <div className="field" style={{ marginBottom: 22 }}>
            <div className="field-label">Sign-in method</div>
            <div className="radio-row">
              <div className="radio-tile selected">
                <Ico.Shield style={{ width: 14, height: 14 }} /> Single sign-on (SSO)
              </div>
              <div className="radio-tile" style={{ opacity: 0.55 }}>
                <Ico.User style={{ width: 14, height: 14 }} /> Username & password
                <span className="pill gray" style={{ marginLeft: 4 }}>Coming soon</span>
              </div>
            </div>
          </div>
        )}

        {cards}
      </div>

      {!gate && <WizardFooter nextDisabled={!canContinue} onNext={onNext} onBack={null} />}
    </>
  );
}

Object.assign(window, { ScreenLogin });
