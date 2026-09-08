// The two required service instances of a Figaf Tool deployment (the deploy
// flow, both hosts). Pure logic, browser-globals like mode.js:
// screen-config.jsx and screen-ops.jsx render the result,
// figaf-tool-services.test.js runs it under node:test. No React, no I/O.
//
// Since 2026-09-08 the names are editable (defaults figaf-db, figaf-xsuaa)
// and an instance that already exists in the space is REUSED as it is: no
// plan and no PostgreSQL parameters are asked for a database that exists
// (it is usually the instance the FAID backend shares), and no create runs
// for an XSUAA instance that exists. The xsappname in xs-security.json
// follows the XSUAA instance name, because XSUAA wants it unique per
// SUBACCOUNT (a Figaf Tool in another space of the same subaccount blocks
// the default name).
//
// Input:
//   config    ctx.config: { dbServiceName, xsuaaServiceName, dbPlan,
//                           enableConnectivity, enableDestination }
//   spaceRows the rows of cf:services ([{ name, offering, plan, operation }])
//             or null while they load / when the listing failed
//
// figafToolServices(config, spaceRows) ->
//   { loaded, db, xsuaa, askDbPlan, xsappname, errors }
//     db, xsuaa  { name, offering, exists, reuse, plan, operation, error }
//     askDbPlan  false when the database exists: no plan, no parameters
//     errors     every text that blocks "Start deployment"
//
// figafToolProvisioningTasks(config, spaceRows) -> the checklist rows of
//   ScreenProgress ({ id, status, title, sub }) in run order.
(function () {
  var DEFAULTS = { db: "figaf-db", xsuaa: "figaf-xsuaa" };
  var OFFERINGS = { db: "postgresql-db", xsuaa: "xsuaa" };
  var LABELS = { db: "Database service name", xsuaa: "XSUAA service name" };
  // Same rule as packages/core/faid-database.js validateInstanceName.
  var NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,49}$/;

  function nameOf(config, key) {
    var raw = config && config[key === "db" ? "dbServiceName" : "xsuaaServiceName"];
    var s = raw == null ? "" : String(raw).trim();
    return s || DEFAULTS[key];
  }

  function describe(key, name, rows) {
    var out = { name: name, offering: OFFERINGS[key], exists: false, reuse: false, plan: "", operation: "", error: "" };
    if (!NAME_RE.test(name)) {
      out.error = LABELS[key] + ": '" + name.slice(0, 60) + "' is not a valid service instance name (letters, digits, '.', '_' and '-'; 1-50 characters; must start with a letter or digit).";
      return out;
    }
    if (!Array.isArray(rows)) return out;
    var row = null;
    for (var i = 0; i < rows.length; i++) {
      if (rows[i] && rows[i].name === name) { row = rows[i]; break; }
    }
    if (!row) return out;
    out.exists = true;
    out.plan = row.plan || "";
    out.operation = row.operation || "";
    if ((row.offering || "") !== OFFERINGS[key]) {
      out.error = "'" + name + "' exists in this space, but it is a " + (row.offering || "different") + " instance, not " + OFFERINGS[key] + ". Choose another name.";
      return out;
    }
    if (/failed/i.test(out.operation)) {
      out.error = "'" + name + "' exists in this space, but its last operation failed (" + out.operation + "). Delete it or choose another name.";
      return out;
    }
    out.reuse = true;
    return out;
  }

  function figafToolServices(config, spaceRows) {
    var rows = Array.isArray(spaceRows) ? spaceRows : null;
    var db = describe("db", nameOf(config, "db"), rows);
    var xsuaa = describe("xsuaa", nameOf(config, "xsuaa"), rows);
    var errors = [];
    if (db.error) errors.push(db.error);
    if (xsuaa.error) errors.push(xsuaa.error);
    if (!db.error && !xsuaa.error && db.name === xsuaa.name) {
      errors.push("The database and the XSUAA instance cannot share the name '" + db.name + "'.");
    }
    return { loaded: rows !== null, db: db, xsuaa: xsuaa, askDbPlan: !db.reuse, xsappname: xsuaa.name, errors: errors };
  }

  function figafToolProvisioningTasks(config, spaceRows) {
    var cfg = config || {};
    var svc = figafToolServices(cfg, spaceRows);
    var tasks = [
      { id: "vars", status: "pending", title: "Update vars.yml", sub: "ID · LANDSCAPE_APPS_DOMAIN · LOCATION_ID · DOCKER_IMAGE_VERSION" },
    ];
    if (svc.db.reuse) {
      tasks.push({ id: "db", status: "pending", title: "Reuse PostgreSQL service (" + svc.db.name + ")", sub: "existing instance" + (svc.db.plan ? " · plan " + svc.db.plan : "") + " · no plan, no parameters" });
    } else {
      tasks.push({ id: "db", status: "pending", title: "Create PostgreSQL service (" + svc.db.name + ")", sub: "cf create-service postgresql-db " + (cfg.dbPlan || "<plan>") + " · poll every 10s" });
    }
    if (svc.xsuaa.reuse) {
      tasks.push({ id: "xsuaa", status: "pending", title: "Reuse XSUAA service (" + svc.xsuaa.name + ")", sub: "existing instance · roles left as they are" });
    } else {
      tasks.push({ id: "xsuaa", status: "pending", title: "Create XSUAA service (" + svc.xsuaa.name + ")", sub: "cf create-service xsuaa application · xsappname " + svc.xsappname });
    }
    tasks.push({ id: "roles", status: "pending", title: "Assign role collection", sub: "btp assign security/role-collection IRTAdmin (after XSUAA)" });
    if (cfg.enableConnectivity) tasks.push({ id: "connectivity", status: "pending", title: "Create Connectivity service (figaf-connectivity)", sub: "cf create-service connectivity lite" });
    if (cfg.enableDestination) tasks.push({ id: "destination", status: "pending", title: "Create Destination service (figaf-destination)", sub: "cf create-service destination lite" });
    return tasks;
  }

  if (typeof window !== "undefined") {
    window.figafToolServices = figafToolServices;
    window.figafToolProvisioningTasks = figafToolProvisioningTasks;
  }
})();
