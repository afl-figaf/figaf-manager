// Role assignment in the persistent-SSO upgrade: the decision the upgrade
// screen makes BEFORE "Start upgrade" (docs/faid-apps-console/SPEC.md "Role assignment in
// the SSO upgrade", run #4 finding 2).
// Pure logic, browser-globals like setup-checklist.js: screen-xsuaa.jsx renders
// the result, sso-role-assign.test.js runs it under node:test. No React, no I/O.
//
// Input `pre` = result of xsuaa:roleAssignmentPrecheck:
//   { ok, error?, btpLoggedIn, cfUser, cfUserIsStoredUser, storedUsername }
//
// Output:
//   { available, autoAssign, prefillUser, needsUserInput, reason, notice }
//   available      = the automatic assignment can run in this session
//   autoAssign     = the default of the switch
//   prefillUser    = e-mail to prefill in "Assign to"
//   needsUserInput = the operator must type the e-mail (technical user signed in)
//   reason         = "" | "no-btp-login" | "precheck-failed"
//   notice         = one plain sentence for the panel ("" when nothing to say)

(function () {
  "use strict";

  function figafIsEmailLike(value) {
    var s = String(value == null ? "" : value).trim();
    return s.length > 0 && s.length <= 256 && /^[^\s@]+@[^\s@]+$/.test(s);
  }

  function figafRoleAssignPlan(pre) {
    if (!pre || pre.ok === false) {
      return {
        available: false,
        autoAssign: false,
        prefillUser: "",
        needsUserInput: false,
        reason: "precheck-failed",
        notice: "Could not check the BTP login" + (pre && pre.error ? " (" + pre.error + ")" : "") +
          ". Assign the role in the BTP cockpit after the upgrade.",
      };
    }
    if (!pre.btpLoggedIn) {
      return {
        available: false,
        autoAssign: false,
        prefillUser: "",
        needsUserInput: false,
        reason: "no-btp-login",
        notice: "The automatic role assignment needs a BTP login in THIS session. " +
          "A BTP login made before the last restart does not count: the manager forgets it on every restart.",
      };
    }
    if (pre.cfUserIsStoredUser) {
      var tech = pre.storedUsername || pre.cfUser || "the technical user";
      return {
        available: true,
        autoAssign: true,
        prefillUser: "",
        needsUserInput: true,
        reason: "",
        notice: "The manager is signed in as the technical user " + tech +
          ". The role must go to a person: enter your own e-mail.",
      };
    }
    var user = String(pre.cfUser || "").trim();
    return {
      available: true,
      autoAssign: true,
      prefillUser: user,
      needsUserInput: !figafIsEmailLike(user),
      reason: "",
      notice: "",
    };
  }

  if (typeof window !== "undefined") {
    window.figafIsEmailLike = figafIsEmailLike;
    window.figafRoleAssignPlan = figafRoleAssignPlan;
  }
})();
