"use strict";
// Single source of truth for self-update release discovery.
//
// Override the repo at runtime with FIGAF_RELEASE_REPO=<owner>/<name> when
// staging from a fork. The GitHub Release for each version is expected to
// carry these assets:
//   figaf-manager-app-<semver>.zip       (cloud zip the dyno self-pushes)
//   Figaf-Installer-<semver>-x64.exe     (Windows PORTABLE exe — runs without install)
// The release workflow also attaches the cloud manifest.yml; it carries no
// version and is not parsed here.
//
// The desktop asset is the PORTABLE exe, not the NSIS "Setup" installer — a
// running portable can't overwrite itself in place, so the desktop self-update
// only DETECTS a newer version here and sends the operator to the release page
// to download + replace manually (see triggerSelfUpdate in self-update-banner.jsx).
// The regex deliberately requires a digit right after "Figaf-Installer-" so it
// matches the portable name but never the "Figaf-Installer-Setup-..." installer.

const RELEASE_REPO = process.env.FIGAF_RELEASE_REPO || "figaf/FigafManager";

const RELEASE_LATEST_URL = `https://api.github.com/repos/${RELEASE_REPO}/releases/latest`;

const CLOUD_ASSET_REGEX   = /^figaf-manager-app-(\d+\.\d+\.\d+)\.zip$/;
const DESKTOP_ASSET_REGEX = /^Figaf-Installer-(\d+\.\d+\.\d+)-x64\.exe$/;

// Three-part semver comparator with one kind of pre-release: the FAID dev
// channel (figaf-faid decision 0017), x.y.z-dev.N. The three numbers first;
// then a version WITHOUT a suffix is newer than the same version with one
// (0.6.2 > 0.6.2-dev.9), and two suffixes compare by their number
// (0.6.2-dev.10 > 0.6.2-dev.9). The manager's own releases carry no suffix.
// Returns -1 if a < b, 0 if equal, +1 if a > b. Non-semver input → NaN-safe
// comparison treats missing parts as 0.
function compareSemver(a, b) {
  const split = (v) => {
    const [core, pre] = String(v || "").split("-");
    const nums = core.split(".").map((n) => parseInt(n, 10));
    const preNum = pre == null ? null : parseInt(String(pre).split(".")[1], 10);
    return { nums, pre: pre == null ? null : (Number.isFinite(preNum) ? preNum : 0) };
  };
  const pa = split(a);
  const pb = split(b);
  for (let i = 0; i < 3; i++) {
    const x = Number.isFinite(pa.nums[i]) ? pa.nums[i] : 0;
    const y = Number.isFinite(pb.nums[i]) ? pb.nums[i] : 0;
    if (x < y) return -1;
    if (x > y) return  1;
  }
  if (pa.pre === null && pb.pre === null) return 0;
  if (pa.pre === null) return 1;
  if (pb.pre === null) return -1;
  if (pa.pre < pb.pre) return -1;
  if (pa.pre > pb.pre) return 1;
  return 0;
}

module.exports = {
  RELEASE_REPO,
  RELEASE_LATEST_URL,
  CLOUD_ASSET_REGEX,
  DESKTOP_ASSET_REGEX,
  compareSemver,
};
