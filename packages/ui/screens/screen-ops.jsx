/* global React, Ico, CheckRow, WizardFooter */

const fg = () => (typeof window !== "undefined" && window.figaf) || null;

// ═══════════════════════════════════════════════════════════
// 5. Service creation + role assignment
// ═══════════════════════════════════════════════════════════
function ScreenProgress({ ctx, setCtx, onNext, onBack, appendLog }) {
  const tasks = ctx.tasks;
  const allDone = tasks.every(t => t.status === "done");

  React.useEffect(() => {
    if (ctx.deployStarted) return;
    // The checklist follows the configuration and the space: an instance that
    // exists is reused, the others are created (figaf-tool-services.js).
    const svc = window.figafToolServices(ctx.config, ctx.spaceServices);
    setCtx(c => ({ ...c, deployStarted: true, tasks: window.figafToolProvisioningTasks(c.config, c.spaceServices) }));
    const api = fg();
    if (!api) return;

    const mark = (id, patch) =>
      setCtx(c => ({ ...c, tasks: c.tasks.map(t => t.id === id ? { ...t, ...patch } : t) }));

    // Reuse an instance that is in the space (`cf service <name>` is the
    // authority, not the listing the Configuration screen saw), otherwise
    // create it and wait for "create succeeded". `plan` may be empty when
    // the Configuration screen hid the plan because the instance existed.
    async function ensureService(id, { label, offering, plan, name, configFile, reusedKey }) {
      const s = await api.cf.service(name);
      if (s.ok) {
        mark(id, { status: "running", title: `Reuse ${label} (${name})`, sub: `exists · ${s.status}` });
        const p = /succeeded/i.test(s.status) ? s : await api.cf.pollService(name);
        const ready = /succeeded/i.test(p.status || "");
        mark(id, { status: ready ? "done" : "error", sub: ready ? `already exists · reused (${p.status})` : (p.status || "not ready") });
        if (ready && reusedKey) setCtx(c => ({ ...c, [reusedKey]: true }));
        return ready;
      }
      if (!plan) {
        mark(id, { status: "error", title: `Create ${label} (${name})`, sub: `${name} is not in the space any more and no plan was chosen — go back and choose a plan` });
        return false;
      }
      mark(id, { status: "running", title: `Create ${label} (${name})` });
      const c = await api.cf.createService({ offering, plan, name, configFile });
      if (!c.ok) { mark(id, { status: "error", sub: c.stderr || "create-service failed" }); return false; }
      const p = await api.cf.pollService(name);
      mark(id, { status: p.ok ? "done" : "error", sub: p.status });
      return p.ok;
    }

    (async () => {
      // 1. vars.yml — written in config step; just mark done
      mark("vars", { status: "done", sub: "vars.yml updated" });

      // 2. The database runs fully in parallel — no dependency on XSUAA. An
      //    existing instance (usually the one shared with the FAID backend)
      //    is reused; db.json is only read when a new one is created.
      const dbPromise = ensureService("db", {
        label: "PostgreSQL service", offering: "postgresql-db", plan: ctx.config.dbPlan,
        name: svc.db.name, configFile: "db.json", reusedKey: "dbReused",
      });

      // 3. XSUAA creation, THEN role assignment chained off it.
      //
      // The IRTAdmin role collection is not a standalone object — it is
      // materialized in the subaccount by xs-security.json the moment
      // `cf create-service xsuaa application figaf-xsuaa` reaches
      // status: succeeded. So the assign MUST wait for that poll to
      // succeed. Running it in parallel (the old behavior) only ever
      // worked on subaccounts where a prior deployment had already left
      // the role collection behind; on a fresh subaccount the assign
      // raced ahead of materialization and failed with "role collection
      // not found".
      //
      // An XSUAA instance that already exists in the space is reused as it
      // is (its role collections are already there); xs-security.json carries
      // the xsappname that follows the instance name (config:writeVars).
      const xsRolePromise = (async () => {
        const ready = await ensureService("xsuaa", {
          label: "XSUAA service", offering: "xsuaa", plan: "application",
          name: svc.xsuaa.name, configFile: "xs-security.json", reusedKey: "xsuaaReused",
        });
        if (!ready) {
          mark("roles", { status: "error", sub: "skipped — XSUAA not ready" });
          return;
        }

        // XSUAA is up and the role collections are now materialized.
        mark("roles", { status: "running" });
        const users = await api.btp.listUsers();
        const who = ctx.login.user || (users.ok && users.users[0]) || "";
        if (!who) { mark("roles", { status: "error", sub: "no user found" }); return; }
        const r = await api.btp.assignRole(who, "IRTAdmin");
        mark("roles", { status: r.ok ? "done" : "error", sub: r.ok ? `assigned IRTAdmin to ${who}` : (r.stderr || "failed") });
      })();

      // 4. Optional: Connectivity service (PI/PO via SAP Cloud Connector)
      const connectivityPromise = ctx.config.enableConnectivity ? (async () => {
        mark("connectivity", { status: "running" });
        const c = await api.cf.createService({ offering: "connectivity", plan: "lite", name: "figaf-connectivity" });
        mark("connectivity", { status: c.ok ? "done" : "error", sub: c.ok ? (c.alreadyExists ? "already exists" : "created") : (c.stderr || "create-service failed") });
      })() : Promise.resolve();

      // 5. Optional: Destination service (PI/PO via SAP Cloud Connector)
      const destinationPromise = ctx.config.enableDestination ? (async () => {
        mark("destination", { status: "running" });
        const c = await api.cf.createService({ offering: "destination", plan: "lite", name: "figaf-destination" });
        mark("destination", { status: c.ok ? "done" : "error", sub: c.ok ? (c.alreadyExists ? "already exists" : "created") : (c.stderr || "create-service failed") });
      })() : Promise.resolve();

      await Promise.all([dbPromise, xsRolePromise, connectivityPromise, destinationPromise]);
    })();
    // eslint-disable-next-line
  }, []);

  return (
    <>
      <div className="pane-body">
        <div className="pane-head">
          <div className="pane-eyebrow">Step 5 · Provisioning</div>
          <h1 className="pane-title">
            {allDone ? "Services ready" : "Creating services & assigning roles…"}
          </h1>
          <p className="pane-desc">
            {allDone
              ? "All services and the IRTAdmin role are configured. Ready to deploy the app."
              : <>Creating services in <span className="kbd">{ctx.login.org || "?"} / {ctx.login.space || "?"}</span> and assigning role collections. Most tasks run in parallel.</>}
          </p>
        </div>

        <div className="card" style={{ padding: "4px 18px" }}>
          <div className="checklist">
            {tasks.map(t => <CheckRow key={t.id} {...t} />)}
          </div>
        </div>

        {!allDone && (
          <div style={{ marginTop: 16, display: "flex", gap: 10, alignItems: "center", fontSize: 12, color: "var(--ink-3)" }}>
            <Ico.Terminal style={{ color: "var(--fg-blue)" }} />
            <span>Expand <strong>CLI details</strong> below to watch raw output.</span>
          </div>
        )}
      </div>

      <WizardFooter
        onBack={onBack}
        onNext={onNext}
        nextDisabled={!allDone}
        nextLabel={allDone ? "Continue to deploy" : "Provisioning…"}
        backLabel="Cancel"
      />
    </>
  );
}

// ═══════════════════════════════════════════════════════════
// 6. Deploy app (cf push)
// ═══════════════════════════════════════════════════════════
function ScreenDeploy({ ctx, setCtx, onNext, onBack, appendLog }) {
  const pushStatus = ctx.pushStatus;
  const done = pushStatus === "done";
  const failed = pushStatus === "error";

  React.useEffect(() => {
    if (ctx.pushStarted) return;
    setCtx(c => ({ ...c, pushStarted: true, pushStatus: "running" }));
    const api = fg();
    if (!api) return;
    (async () => {
      const r = await api.cf.push();
      setCtx(c => ({ ...c, pushStatus: r.ok ? "done" : "error" }));
    })();
    // eslint-disable-next-line
  }, []);

  const appUrl = `https://${ctx.config.id}.${ctx.config.domain}`;

  return (
    <>
      <div className="pane-body">
        <div className="pane-head">
          <div className="pane-eyebrow">Step 6 · Deploy</div>
          <h1 className="pane-title">
            {done ? "Application deployed" : failed ? "Deployment failed" : "Pushing Figaf Tool to Cloud Foundry…"}
          </h1>
          <p className="pane-desc">
            {done
              ? "The Figaf Tool is live and bound to all services."
              : failed
                ? "cf push exited with a non-zero code. Expand the CLI drawer to see the error."
                : <>Running <span className="kbd">cf push --vars-file vars.yml</span> — uploading, staging, and starting instances.</>}
          </p>
        </div>

        <div className="card" style={{ padding: "20px 18px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <div style={{ width: 44, height: 44, borderRadius: 10, background: done ? "var(--success-soft)" : "var(--fg-blue-soft)", border: `2px solid ${done ? "var(--success)" : "var(--fg-blue)"}`, color: done ? "var(--success)" : "var(--fg-blue)", display: "grid", placeItems: "center" }}>
              {done ? <Ico.Check style={{ width: 20, height: 20 }} /> : <Ico.Spinner style={{ width: 20, height: 20 }} />}
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: "var(--ink-0)", marginBottom: 4 }}>
                {done ? "Deployment complete" : failed ? "Push failed" : "Uploading and staging…"}
              </div>
              <div style={{ fontSize: 12, color: "var(--ink-3)", fontFamily: "var(--font-mono)" }}>
                {done ? appUrl : "cf push --vars-file vars.yml"}
              </div>
            </div>
            {done && <span className="pill green">Live</span>}
          </div>
        </div>

        <div style={{ marginTop: 16, display: "flex", gap: 10, alignItems: "center", fontSize: 12, color: "var(--ink-3)" }}>
          <Ico.Info style={{ color: "var(--fg-blue)" }} />
          <span>
            This step uploads the Docker image, binds services, and starts the app. Typically takes 2–5 minutes.
          </span>
        </div>
      </div>

      <WizardFooter
        onBack={onBack}
        onNext={onNext}
        nextDisabled={!done}
        nextLabel={done ? "Finish" : failed ? "Retry or cancel" : "Deploying…"}
        backLabel="Cancel"
      />
    </>
  );
}

Object.assign(window, { ScreenProgress, ScreenDeploy });
