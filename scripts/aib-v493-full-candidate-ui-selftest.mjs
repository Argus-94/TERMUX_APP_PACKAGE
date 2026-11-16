import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const panel = readFileSync(new URL("../components/FullCandidatePackagesPanel.tsx", import.meta.url), "utf8");
const menu = readFileSync(new URL("../components/PackagesRightMenu.tsx", import.meta.url), "utf8");
const api = readFileSync(new URL("../lib/candidate-full-feed.ts", import.meta.url), "utf8");
for (const token of [
  "CANDIDATE_PACKAGES", "runFullCandidateAction", "verify", "install", "reinstall", "remove", "check", "82",
  "unknown", "stale", "SHA-256", "BATCH_WARNING", "busyRef", "CANDIDATE_PACKAGES.find(x => x.name === manual.trim())",
  "HOME", "CANDIDATE_INSTALL_BLOCKER", "CANDIDATE_RELEASE_VALID_UNTIL", "НЕ ВЫПОЛНЕНО",
]) assert.ok(panel.includes(token), `missing UI safety/content token: ${token}`);
for (const token of [
  "result.diagnostics", "diagnosticPhase: details?.phase", "diagnosticReasonCode: details?.reasonCode",
  "stdoutBytes: details?.stdoutBytes", "stderrBytes: details?.stderrBytes",
]) assert.ok(panel.includes(token), `missing safe FullCandidateUI result metric: ${token}`);
assert.doesNotMatch(panel, /JSON\.stringify\([^\n]*(?:stdout|stderr)/, "raw streams must not be serialized to persistent diagnostics");
assert.match(panel, /runFullCohortAction\("install"\)/, "install is a separate explicit full-cohort action");
assert.match(panel, /runFullCohortAction\("reinstall"\)/, "reinstall is a separate explicit full-cohort action");
assert.match(panel, /\["remove", "check"\]/, "per-row actions are limited to one-package removal or read-only check");
assert.doesNotMatch(panel, /\["install", "reinstall", "remove", "check"\]/, "rows cannot dispatch full cohort install/reinstall");
assert.ok(menu.includes("<FullCandidatePackagesPanel"), "panel mounted");
assert.ok(!menu.includes("installCandidateMake") && !menu.includes("runCandidateFeedProbe"), "legacy controls absent");
for (const token of [
  "CANDIDATE_PACKAGES", "runFullCandidateAction", "candidatePackageIdsForTool", "productionEnabled: false", "qualified: false",
  "CANDIDATE_BOOTSTRAP_COMPATIBLE = true", "CANDIDATE_PACKAGES.length !== 82", "AIB_FULL_CANDIDATE_COHORT:82",
  "AIB_FULL_CANDIDATE_FULL_COHORT_REQUIRED",
]) assert.ok(api.includes(token), `API contract missing ${token}`);
assert.match(panel, /setKnown\(prev => Object\.fromEntries\(Object\.entries\(prev\)\.map\(\(\[k, v\]\) => \[k, \{ \.\.\.v, stale: true \}\]\)\)\)/, "states stale after operation");
console.log("aib-v493-full-candidate-ui-selftest: PASS");
