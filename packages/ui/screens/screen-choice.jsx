/* global React, Ico, WizardFooter */

// ═══════════════════════════════════════════════════════════
// 3. Post-login choice
// ═══════════════════════════════════════════════════════════
function ScreenChoice({ ctx, setCtx, onNext, onBack }) {
  const sel = ctx.choice;
  // CF-only sign-in (BTP skipped): only the Update flow works without a global
  // account, so every other action is grayed out.
  const cfOnly = !!ctx.login.cfOnly;
  const showXsuaaUpgrade = !!(window.figafModeFlags.features && window.figafModeFlags.features.xsuaaUpgrade);
  const showUpdate = !!(window.figafModeFlags.features && window.figafModeFlags.features.updateFigafTool);
  const showManageFaid = !!(window.figafModeFlags.features && window.figafModeFlags.features.manageFaidApps);
  // CF-only has no BTP landscape label — fall back to the API host / org.
  const target = ctx.login.landscape || (ctx.login.apiUrl || "").replace(/^https?:\/\//, "") || ctx.login.org || "your space";
  // CF-only login supports the flows that need nothing but the cf CLI:
  // Update Figaf Tool and the FAID Apps manager.
  function pick(v) { if (cfOnly && v !== "update" && v !== "manage") return; setCtx(c => ({ ...c, choice: v })); }

  return (
    <>
      <div className="pane-body">
        <div className="pane-head">
          <div className="pane-eyebrow">Step 3 · Choose action</div>
          <h1 className="pane-title">What would you like to do?</h1>
          <p className="pane-desc">
            Signed in as <strong>{ctx.login.user || "you"}</strong> on <span className="kbd">{target}</span>.{" "}
            {cfOnly
              ? "You signed in without a global account, so only Update is available."
              : "Pick how you'd like to continue — you can do the other later."}
          </p>
        </div>

        <div className="choice-grid">
          {showXsuaaUpgrade && (
            <button
              className={`choice ${cfOnly ? "disabled" : ""} ${sel === "xsuaa-upgrade" ? "selected" : ""}`}
              onClick={() => pick("xsuaa-upgrade")}
              disabled={cfOnly}
            >
              <div className="choice-icon"><Ico.Shield /></div>
              <div className="choice-title">
                Enable persistent SSO login
                {cfOnly ? <span className="pill gray">Requires BTP login</span> : <span className="pill blue">Recommended</span>}
              </div>
              <div className="choice-desc">
                Replace the one-time cockpit passcode with SAP IAS single sign-on. Provisions XSUAA + a bundled approuter in front of this wizard. Do this first — you can still deploy or connect afterwards.
              </div>
            </button>
          )}

          <button
            className={`choice ${cfOnly ? "disabled" : ""} ${sel === "deploy" ? "selected" : ""}`}
            onClick={() => pick("deploy")}
            disabled={cfOnly}
          >
            <div className="choice-icon"><Ico.Box /></div>
            <div className="choice-title">
              Deploy Figaf Tool
              {cfOnly && <span className="pill gray">Requires BTP login</span>}
            </div>
            <div className="choice-desc">
              Push the Figaf Tool to your Cloud Foundry space along with its PostgreSQL and XSUAA services.
            </div>
          </button>

          {showUpdate && (
            <button
              className={`choice ${sel === "update" ? "selected" : ""}`}
              onClick={() => pick("update")}
            >
              <div className="choice-icon"><Ico.Refresh /></div>
              <div className="choice-title">
                Update Figaf Tool
              </div>
              <div className="choice-desc">
                Refresh an existing deployment to the latest Docker image. Rolling push — no downtime — and pulls the latest deploy templates from GitHub.
              </div>
            </button>
          )}

          {showManageFaid && (
            <button
              className={`choice ${sel === "manage" ? "selected" : ""}`}
              onClick={() => pick("manage")}
            >
              <div className="choice-icon"><Ico.Box /></div>
              <div className="choice-title">
                Manage FAID Apps
                <span className="pill blue">PoC</span>
              </div>
              <div className="choice-desc">
                Install, update, disable, or remove FAID Apps (e.g. B2B Archiving Setup) in this space from the bundled app catalog.
              </div>
            </button>
          )}

          <button
            className={`choice ${cfOnly ? "disabled" : ""} ${sel === "connect" ? "selected" : ""}`}
            onClick={() => pick("connect")}
            disabled={cfOnly}
          >
            <div className="choice-icon"><Ico.Link /></div>
            <div className="choice-title">
              Connect to Integration Suite
              {cfOnly && <span className="pill gray">Requires BTP login</span>}
            </div>
            <div className="choice-desc">
              Link an existing Figaf deployment to your SAP Integration Suite tenant for tracking & testing.
            </div>
          </button>
        </div>

        <div className="divider" />

        <div style={{ fontSize: 12, color: "var(--ink-3)", display: "flex", gap: 8, alignItems: "flex-start" }}>
          <Ico.Info style={{ color: "var(--fg-blue)", flexShrink: 0, marginTop: 1 }} />
          <span>
            Fresh install? Choose <strong>Deploy</strong>. Already running Figaf and just need to wire up Integration Suite? Choose <strong>Connect</strong>.
          </span>
        </div>
      </div>

      <WizardFooter
        onBack={onBack}
        onNext={onNext}
        nextDisabled={!sel}
        nextLabel={
          sel === "connect"       ? "Configure connection" :
          sel === "xsuaa-upgrade" ? "Begin upgrade" :
          sel === "update"        ? "Configure update" :
          sel === "manage"        ? "Open app manager" :
                                    "Configure deployment"
        }
      />
    </>
  );
}

Object.assign(window, { ScreenChoice });
