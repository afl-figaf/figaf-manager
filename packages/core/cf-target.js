"use strict";
// Parsers for `cf api` and `cf target` stdout. Pure-logic, no I/O. Used by
// the self-update pre-flight handler (update:selfTarget) to confirm the
// operator's cf-cli session is targeted at the manager's own CF coordinates
// before `cf push` self-redeploy.
//
// Output shape (live capture from cf-cli v8.18):
//
//   cf api:
//     API endpoint:   https://api.cf.us10-001.hana.ondemand.com
//     API version:    3.220.0
//
//   cf target (logged in):
//     API endpoint:   https://api.cf.us10-001.hana.ondemand.com
//     API version:    3.220.0
//     user:           afl@figaf.com
//     org:            9c492946trial
//     space:          dev
//
//   cf target (logged out, exit 1, stderr):
//     FAILED
//     Not logged in. Use 'cf.exe login' or 'cf.exe login --sso' to log in.
//
// Older cf-cli versions used lowercase keys ("api endpoint:") — both forms
// accepted via /i.

const KEY_API   = /^\s*api endpoint:\s+(\S.*?)\s*$/im;
const KEY_USER  = /^\s*user:\s+(\S.*?)\s*$/im;
const KEY_ORG   = /^\s*org:\s+(\S.*?)\s*$/im;
const KEY_SPACE = /^\s*space:\s+(\S.*?)\s*$/im;

function match(re, text) {
  const m = re.exec(text || "");
  return m ? m[1] : null;
}

function parseCfApi(text) {
  return { apiUrl: match(KEY_API, text) };
}

function parseCfTarget(text) {
  const apiUrl    = match(KEY_API, text);
  const user      = match(KEY_USER, text);
  const orgName   = match(KEY_ORG, text);
  const spaceName = match(KEY_SPACE, text);

  // Logged-in markers: explicit user line present (cf prints user only with
  // an active session) AND no "Not logged in" stderr marker in the text.
  const loggedOut = !user || /Not logged in/i.test(text || "");

  return {
    apiUrl,
    user:      loggedOut ? null : user,
    orgName:   loggedOut ? null : orgName,
    spaceName: loggedOut ? null : spaceName,
    loggedIn:  !loggedOut,
  };
}

// Normalize a CF API URL for string comparison: lowercase scheme + host,
// strip trailing slash. (VCAP_APPLICATION.cf_api and `cf api` output can
// differ on trailing slash; case differences are unlikely in practice but
// cheap to handle.)
function normalizeApiUrl(url) {
  if (!url) return "";
  try {
    const u = new URL(String(url));
    const host = u.host.toLowerCase();
    const scheme = u.protocol.toLowerCase();
    const pathname = u.pathname.replace(/\/$/, "");
    return `${scheme}//${host}${pathname}`;
  } catch {
    return String(url).replace(/\/+$/, "").toLowerCase();
  }
}

// ── The manager's own space as the automatic CF target ──────────────────────
// The FAID Apps console installs, updates and removes applications in ITS OWN Cloud
// Foundry space (SPEC section 1), and the hosted manager already knows that
// space from VCAP_APPLICATION. So the passcode sign-in answers `cf login`'s
// "Select an org / Select a space" prompts itself: the question has exactly
// one correct answer, and a wrong pick would install the platform into the
// wrong space (nothing downstream re-checks the target).
//
// resolveSelfPin returns the { org, space } to append to `cf login` as
// `-o <org> -s <space>`, or null when the interactive picker must stay:
//   - desktop mode, or a hosted runtime without VCAP — nothing to pin to;
//   - an incomplete VCAP target;
//   - a login to a CF endpoint that is NOT the manager's own. The Figaf tool
//     may live on another landscape, where our org/space do not exist.
function resolveSelfPin(self, apiUrl) {
  if (!self || !self.apiUrl || !self.orgName || !self.spaceName) return null;
  if (!apiUrl) return null;
  if (normalizeApiUrl(apiUrl) !== normalizeApiUrl(self.apiUrl)) return null;
  return { org: self.orgName, space: self.spaceName };
}

// A pinned login gives the operator no picker to correct a wrong target in,
// so a targeting failure has to explain itself (the CLI only says "not
// found"). Returns a plain-English message for the two failures the pin can
// cause, else null — then the generic "login failed" path stands, so a wrong
// or expired passcode is never reported as a missing role.
const ORG_NOT_FOUND   = /organization\s+'?[^'\n]*'?\s+not found|no org(anization)?\s+with name/i;
const SPACE_NOT_FOUND = /space\s+'?[^'\n]*'?\s+not found|no space\s+with name/i;

function explainPinnedLoginFailure(output, pin) {
  if (!pin) return null;
  const text = String(output || "");
  if (SPACE_NOT_FOUND.test(text)) {
    return `Signed in, but the space ${pin.space} is not visible to this account. `
      + `The manager itself runs in org ${pin.org}, space ${pin.space}, so that is the only install target. `
      + `Ask a subaccount administrator to add you there as Space Developer, then sign in again.`;
  }
  if (ORG_NOT_FOUND.test(text)) {
    return `Signed in, but the org ${pin.org} is not visible to this account. `
      + `The manager itself runs in org ${pin.org}, space ${pin.space}, so that is the only install target. `
      + `Ask a subaccount administrator to give you access there (Space Developer in ${pin.space} is enough), then sign in again.`;
  }
  return null;
}

module.exports = {
  parseCfApi,
  parseCfTarget,
  normalizeApiUrl,
  resolveSelfPin,
  explainPinnedLoginFailure,
};
