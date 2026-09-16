/* global React */
// Shared components for Figaf Installer

// ───────────── SVG icon primitives ─────────────
const Ico = {
  Check: (p) => (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M3 8.5l3.2 3.2L13 5" />
    </svg>
  ),
  X: (p) => (
    <svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" {...p}>
      <path d="M2 2l12 12M14 2L2 14" />
    </svg>
  ),
  Min: (p) => (
    <svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1.2" {...p}>
      <path d="M2 8h12" />
    </svg>
  ),
  Max: (p) => (
    <svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1.2" {...p}>
      <rect x="2.5" y="2.5" width="11" height="11" />
    </svg>
  ),
  Chev: (p) => (
    <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M6 4l4 4-4 4" />
    </svg>
  ),
  ChevDown: (p) => (
    <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M4 6l4 4 4-4" />
    </svg>
  ),
  ArrowRight: (p) => (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M3 8h10M9 4l4 4-4 4" />
    </svg>
  ),
  ArrowLeft: (p) => (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M13 8H3M7 4l-4 4 4 4" />
    </svg>
  ),
  External: (p) => (
    <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M9 3h4v4M13 3L7 9M11 9v3.5a.5.5 0 01-.5.5h-7a.5.5 0 01-.5-.5v-7a.5.5 0 01.5-.5H7" />
    </svg>
  ),
  Spinner: (p) => (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" className="spin" {...p}>
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeDasharray="8 18" opacity="0.95" />
    </svg>
  ),
  Dot: (p) => (
    <svg viewBox="0 0 16 16" width="8" height="8" {...p}>
      <circle cx="8" cy="8" r="3" fill="currentColor" />
    </svg>
  ),
  Copy: (p) => (
    <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <rect x="5" y="5" width="8" height="8" rx="1.5" />
      <path d="M3 11V3.5A.5.5 0 013.5 3H11" />
    </svg>
  ),
  Trash: (p) => (
    <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M3 4.5h10M6 4.5V3a.5.5 0 01.5-.5h3a.5.5 0 01.5.5v1.5M4.5 4.5v8a.5.5 0 00.5.5h6a.5.5 0 00.5-.5v-8" />
    </svg>
  ),
  Terminal: (p) => (
    <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <rect x="2" y="3" width="12" height="10" rx="1" />
      <path d="M5 6.5L7 8l-2 1.5M8.5 10H11" />
    </svg>
  ),
  Info: (p) => (
    <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 7.5v3.5M8 5.5v.01" />
    </svg>
  ),
  Cloud: (p) => (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M7 18a5 5 0 01-.7-9.95A6 6 0 0118 9a4 4 0 010 8H7z" />
    </svg>
  ),
  Link: (p) => (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M10 13a5 5 0 007 0l3-3a5 5 0 00-7-7l-1 1" />
      <path d="M14 11a5 5 0 00-7 0l-3 3a5 5 0 007 7l1-1" />
    </svg>
  ),
  Shield: (p) => (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z" />
    </svg>
  ),
  Box: (p) => (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M3 7l9-4 9 4v10l-9 4-9-4V7z" />
      <path d="M3 7l9 4 9-4M12 11v10" />
    </svg>
  ),
  Database: (p) => (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <ellipse cx="12" cy="5" rx="8" ry="3" />
      <path d="M4 5v14a8 3 0 0016 0V5M4 12a8 3 0 0016 0" />
    </svg>
  ),
  User: (p) => (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21a8 8 0 0116 0" />
    </svg>
  ),
  Search: (p) => (
    <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <circle cx="7" cy="7" r="4" />
      <path d="M10 10l3 3" />
    </svg>
  ),
  Refresh: (p) => (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M3 12a9 9 0 0115.5-6.3L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 01-15.5 6.3L3 16" />
      <path d="M3 21v-5h5" />
    </svg>
  ),
};

// ───────────── Figaf logo mark ─────────────
function FigafMark({ size = 18 }) {
  return (
    <img 
      src="./figaf-logo.png"
      height={size}
      style={{ objectFit: "contain", borderRadius: 4 }}
      alt="Figaf Logo"
    />
  );
}

// ───────────── Windows 11 chrome ─────────────
function WinFrame({ title = "Figaf Manager", children }) {
  const features = window.figafModeFlags.features;
  const api = typeof window !== "undefined" ? window.figaf : null;

  if (!features.windowChrome) {
    return (
      <div className="win">
        <div className="win-titlebar" style={{ cursor: "default" }}>
          <div className="win-title">
            <FigafMark size={14} />
            <span>{title}</span>
          </div>
        </div>
        <div className="win-body">{children}</div>
      </div>
    );
  }

  const drag = { WebkitAppRegion: "drag" };
  const noDrag = { WebkitAppRegion: "no-drag" };
  return (
    <div className="win">
      <div className="win-titlebar" style={drag}>
        <div className="win-title">
          <FigafMark size={14} />
          <span>{title}</span>
        </div>
        <div className="win-controls" style={noDrag}>
          <div className="win-ctrl" onClick={() => api?.window.minimize()}><Ico.Min/></div>
          <div className="win-ctrl" onClick={() => api?.window.toggleMax()}><Ico.Max/></div>
          <div className="win-ctrl close" onClick={() => api?.window.close()}><Ico.X/></div>
        </div>
      </div>
      <div className="win-body">{children}</div>
    </div>
  );
}

// ───────────── Stepper rail ─────────────
function StepperRail({ steps, current, maxReached, version, onNavigate }) {
  return (
    <aside className="rail">
      <div className="rail-brand">
        <FigafMark size={26} />
        <div className="rail-brand-text">
          <span className="t1">Figaf Manager</span>
          <span className="t2">SAP BTP · Cloud Foundry</span>
        </div>
      </div>

      <div className="stepper">
        {steps.map((s, i) => {
          const isActive = i === current;
          const isDone = i < maxReached;
          // Console behavior (lane 1): steps already reached are navigation —
          // clicking one jumps back to it (e.g. Choose action from a flow).
          const clickable = !!onNavigate && i <= maxReached && !isActive;
          return (
            <div
              key={s.id}
              className={`step ${isActive ? "is-active" : ""} ${isDone ? "is-done" : ""}`}
              onClick={clickable ? () => onNavigate(i) : undefined}
              style={clickable ? { cursor: "pointer" } : undefined}
              title={clickable ? `Go to ${s.label}` : undefined}
            >
              <div className="step-dot">
                {isDone ? <Ico.Check /> : (i + 1)}
              </div>
              <div className="step-text">
                <div className="step-label">{s.label}</div>
                {s.sub && <div className="step-sub">{s.sub}</div>}
              </div>
            </div>
          );
        })}
      </div>

      <div className="rail-foot">
        {/* Version comes from package.json via host.getInstalledVersion(),
            surfaced through ctx.selfUpdate.check.current — never hard-coded.
            Renders empty until the startup check resolves (sub-second). */}
        <span>{version ? `v${version}` : ""}</span>
        <span>figaf.com</span>
      </div>
    </aside>
  );
}

// ───────────── Wizard footer (Back / Next) ─────────────
function WizardFooter({ onBack, onNext, nextLabel = "Next", backLabel = "Back", nextDisabled, showBack = true, children }) {
  return (
    <div className="pane-foot">
      <div className="spacer" />
      {children}
      {showBack && (
        <button className="btn" onClick={onBack} disabled={!onBack}>
          <Ico.ArrowLeft /> {backLabel}
        </button>
      )}
      <button className="btn btn-primary" onClick={onNext} disabled={nextDisabled}>
        {nextLabel} <Ico.ArrowRight />
      </button>
    </div>
  );
}

// ───────────── Terminal drawer ─────────────
function TerminalDrawer({ open, onToggle, lines, currentCmd }) {
  const ref = React.useRef(null);
  React.useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [lines, open]);

  return (
    <>
      <div className={`terminal-bar ${open ? "open" : ""}`} onClick={onToggle}>
        <span className="chev"><Ico.Chev /></span>
        <span className="tb-dot" />
        <span className="tb-cmd">
          {currentCmd || "CLI details"}
        </span>
        <span className="tb-actions" onClick={(e) => e.stopPropagation()}>
          <button title="Copy"><Ico.Copy /></button>
          <button title="Clear"><Ico.Trash /></button>
        </span>
      </div>
      {open && (
        <div className="terminal" ref={ref}>
          {lines.map((l, i) => (
            <div key={i}>
              {l.type === "cmd" && (
                <>
                  <span className="t-prompt">PS</span>{" "}
                  <span className="t-path">{l.cwd || "C:\\Figaf"}</span>
                  <span className="t-muted"> &gt; </span>
                  <span className="t-cmd">{l.text}</span>
                </>
              )}
              {l.type === "out" && <span>{l.text}</span>}
              {l.type === "ok" && <span className="t-ok">{l.text}</span>}
              {l.type === "warn" && <span className="t-warn">{l.text}</span>}
              {l.type === "err" && <span className="t-err">{l.text}</span>}
              {l.type === "dim" && <span className="t-dim">{l.text}</span>}
            </div>
          ))}
          <div>
            <span className="t-prompt">PS</span>{" "}
            <span className="t-path">C:\Figaf</span>
            <span className="t-muted"> &gt; </span>
            <span style={{ display: "inline-block", width: 7, height: 13, background: "#D6DEEA", verticalAlign: "-2px", animation: "spin 1s steps(2) infinite", opacity: .8 }} />
          </div>
        </div>
      )}
    </>
  );
}

// ───────────── Check row (used for prereqs & progress) ─────────────
function CheckRow({ status, title, sub, meta }) {
  const iconClass = `check-icon ${status}`;
  let icon;
  // `update` and `unreachable` have no CSS modifier in styles.css, so we set
  // their colours inline: blue for an available update (a positive, actionable
  // signal — distinct from the soft-blue spinner), neutral gray for an
  // unreachable update server (NOT a red error — the current version is still
  // fine to use). The base .check-icon class is already gray, so unreachable
  // only needs its icon; update needs the blue fill.
  let iconStyle;
  if (status === "done") icon = <Ico.Check />;
  else if (status === "running") icon = <Ico.Spinner />;
  else if (status === "error") icon = <Ico.X />;
  else if (status === "update") {
    icon = <Ico.Refresh />;
    iconStyle = { background: "var(--fg-blue)", borderColor: "var(--fg-blue)", color: "#fff" };
  } else if (status === "unreachable") {
    icon = <Ico.Cloud />;
  } else icon = <Ico.Dot style={{ opacity: .5 }} />;

  return (
    <div className="check-row">
      <div className={iconClass} style={iconStyle}>{icon}</div>
      <div>
        <div className="check-title">{title}</div>
        {sub && <div className="check-sub">{sub}</div>}
      </div>
      {meta && <div className="check-meta">{meta}</div>}
    </div>
  );
}

function ScrollReveal({ children }) {
  const ref = React.useRef(null);
  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const inView = rect.top >= 0 && rect.bottom <= window.innerHeight;
    // Only scroll if the element is not already fully in the viewport.
    // This prevents jarring scrolls when navigating back to a screen
    // where sections are already visible.
    if (!inView) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, []);
  return <div ref={ref}>{children}</div>;
}

// ───────────── Additional environment variables (gap G1, 2026-09-14) ─────────
// The Figaf image reads many more variables than the deploy template names
// (ADDITIONAL_IRT_PARAMETERS, IRT_ROOT_LOGGING_LEVEL, the keystore group, …).
// Rather than a field per variable, both the Configuration screen and the
// Update form carry this free-form table; the rows are written into the app's
// `env:` block by config:writeVars. Rows stay an ORDERED ARRAY here so a
// half-typed row (empty key) can exist without colliding; the orchestrator
// drops empty keys and rejects the names the template already owns.
function envObjectToRows(env) {
  return Object.keys(env || {}).map((key) => ({ key, value: env[key] == null ? "" : String(env[key]) }));
}
function envRowsToObject(rows) {
  const out = {};
  for (const r of rows || []) {
    const key = (r && r.key ? String(r.key) : "").trim();
    if (key) out[key] = r.value == null ? "" : String(r.value);
  }
  return out;
}

function EnvVarTable({ rows, onChange, note }) {
  const list = rows && rows.length ? rows : [];
  const set = (i, patch) => onChange(list.map((r, n) => (n === i ? { ...r, ...patch } : r)));
  const remove = (i) => onChange(list.filter((_, n) => n !== i));
  const add = () => onChange([...list, { key: "", value: "" }]);
  return (
    <div>
      {list.map((r, i) => (
        <div key={i} style={{ display: "grid", gridTemplateColumns: "1fr 1fr 32px", gap: 8, marginBottom: 8, alignItems: "center" }}>
          <input
            className="input is-mono"
            value={r.key}
            onChange={(e) => set(i, { key: e.target.value.trim() })}
            placeholder="IRT_ROOT_LOGGING_LEVEL"
            aria-label="Variable name"
          />
          <input
            className="input is-mono"
            value={r.value}
            onChange={(e) => set(i, { value: e.target.value })}
            placeholder="value"
            aria-label="Variable value"
          />
          <button
            type="button"
            className="btn"
            onClick={() => remove(i)}
            title="Remove this variable"
            aria-label={`Remove ${r.key || "this variable"}`}
            style={{ padding: "6px 0", justifyContent: "center" }}
          >
            ×
          </button>
        </div>
      ))}
      <button type="button" className="btn" onClick={add} style={{ fontSize: 12 }}>
        + Add variable
      </button>
      {note && <div className="field-hint" style={{ marginTop: 8 }}>{note}</div>}
    </div>
  );
}

// ───────────── InfoHint / Disclosure ─────────────
// Two ways to keep a page short without deleting what it knows. The console's
// pages are dense with consequences that matter exactly once (what a plan
// costs, what a missing role does to the next sign-in): the one-line version
// stays visible, the rest goes in here. Nothing is ever dropped.

// A "?" marker that reveals one short explanation on hover or focus. Hover is
// CSS-driven so it works without JS; the button keeps it keyboard-reachable.
// size="lg": one marker that is a reference for a whole panel (element by
// element) rather than a note about one field - bigger, wider, scrollable,
// and it stays open while the pointer is inside it.
function InfoHint({ children, label = "More information", align = "start", side = "down", width, size }) {
  return (
    <span className={`infohint align-${align} side-${side}${size ? ` is-${size}` : ""}`}>
      <button type="button" className="infohint-marker" aria-label={label}>?</button>
      <span className="infohint-pop" role="tooltip" style={width ? { width } : undefined}>{children}</span>
    </span>
  );
}

// Inline reveal for secondary copy that is too long for a popover.
function Disclosure({ label = "Details", openLabel, defaultOpen = false, children }) {
  const [open, setOpen] = React.useState(defaultOpen);
  return (
    <div className={`disclosure${open ? " is-open" : ""}`}>
      <button type="button" className="disclosure-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="chev"><Ico.Chev width="10" height="10" /></span>
        {open ? (openLabel || label) : label}
      </button>
      {open && <div className="disclosure-body">{children}</div>}
    </div>
  );
}

Object.assign(window, {
  Ico, FigafMark, WinFrame, StepperRail, WizardFooter, TerminalDrawer, CheckRow, ScrollReveal,
  InfoHint, Disclosure,
  EnvVarTable, envObjectToRows, envRowsToObject,
});
