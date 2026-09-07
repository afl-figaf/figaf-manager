/* global React */
// Console page: Figaf Tool (#/figaf-tool) — the hub.
// Lists the Figaf Tool deployments this cf login can see, and starts the three
// Figaf Tool flows (deploy / update / connect). The flows keep their screens
// and order; the console renders them inside this page as a local stepper
// (see ConsoleFrame in console.jsx). The persistent-SSO upgrade is about the
// manager's own sign-in and is Setup step 1 (#/setup, Prepare the space).

function FigafToolActionCard({ title, desc, cta, disabled, hint, onClick }) {
  return (
    <div className="card" style={{ flex: "1 1 240px", minWidth: 240 }}>
      <div style={{ fontWeight: 700, marginBottom: 4 }}>{title}</div>
      <p style={{ fontSize: 13, color: "var(--ink-3)", margin: "0 0 10px", minHeight: 38 }}>{desc}</p>
      <button className="btn" onClick={onClick} disabled={disabled}>{cta}</button>
      {disabled && hint && (
        <div style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 6 }}>{hint}</div>
      )}
    </div>
  );
}

function ScreenFigafToolHub({ ctx, onStartFlow, onGoSession }) {
  const api = typeof window !== "undefined" ? window.figaf : null;
  const [discovery, setDiscovery] = React.useState(null); // faid:figafSystems result
  const cfOnly = !!ctx.login.cfOnly;

  const discover = React.useCallback(async () => {
    setDiscovery(null);
    try { setDiscovery(await api.faid.figafSystems()); }
    catch (e) { setDiscovery({ ok: false, error: e.message }); }
  }, []);
  React.useEffect(() => { discover(); }, [discover]);

  const btpHint = (
    <>
      Needs a BTP login —{" "}
      <button className="btn-link" onClick={onGoSession}>add it under Session &amp; access</button>.
    </>
  );

  return (
    <div className="pane-body">
      <div className="pane-head">
        <div className="pane-eyebrow">Figaf Tool</div>
        <h1 className="pane-title">Figaf Tool deployments</h1>
        <p className="pane-desc">
          Deploy, update, and connect the Figaf Tool itself. These are the original
          installer flows — each opens as a short guided sequence on this page.
        </p>
      </div>

      <div className="card">
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
          <div style={{ fontWeight: 700 }}>Discovered in this Cloud Foundry login</div>
          <div className="spacer" style={{ flex: 1 }} />
          <button className="btn" onClick={discover} disabled={discovery === null}>
            {discovery === null ? "Searching…" : "Search again"}
          </button>
        </div>
        {discovery === null && (
          <div style={{ fontSize: 13, color: "var(--ink-3)" }}>
            Looking for running Figaf Tool app + router pairs…
          </div>
        )}
        {discovery && !discovery.ok && (
          <div style={{ fontSize: 13, color: "var(--ink-3)" }}>{discovery.error}</div>
        )}
        {discovery && discovery.ok && discovery.systems.length === 0 && (
          <div style={{ fontSize: 13, color: "var(--ink-3)" }}>
            No Figaf Tool found in the spaces this login can see. A technical
            management user usually sees only its own space — sign in with your
            own user, or give the management user a Space Auditor role in the
            Figaf Tool spaces.
          </div>
        )}
        {discovery && discovery.ok && discovery.systems.map((s) => (
          <div
            key={s.id}
            style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 0", borderBottom: "1px solid var(--line)", flexWrap: "wrap" }}
          >
            <div style={{ fontWeight: 600, fontSize: 13 }}>{s.id}</div>
            <a className="btn-link" href={s.url} target="_blank" rel="noreferrer" style={{ fontSize: 13 }}>{s.url}</a>
            <div className="spacer" style={{ flex: 1 }} />
            <span style={{ fontSize: 12, color: "var(--ink-3)" }} className="kbd">{s.image}</span>
          </div>
        ))}
      </div>

      <div style={{ display: "flex", gap: 12, marginTop: 14, flexWrap: "wrap" }}>
        <FigafToolActionCard
          title="Update Figaf Tool"
          desc="Move a deployed Figaf Tool to a newer image, with verify and resume."
          cta="Start update"
          disabled={false}
          onClick={() => onStartFlow("update")}
        />
        <FigafToolActionCard
          title="Deploy new Figaf Tool"
          desc="A fresh Figaf Tool in this subaccount: services, roles, cf push."
          cta="Start deploy"
          disabled={cfOnly}
          hint={btpHint}
          onClick={() => onStartFlow("deploy")}
        />
        <FigafToolActionCard
          title="Connect to Integration Suite"
          desc="Create the it-rt services and keys, and set up how Figaf signs in to BTP."
          cta="Start connect"
          disabled={cfOnly}
          hint={btpHint}
          onClick={() => onStartFlow("connect")}
        />
      </div>
    </div>
  );
}

Object.assign(window, { ScreenFigafToolHub });
