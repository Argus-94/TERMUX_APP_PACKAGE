import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => fs.readFileSync(path.join(root, f), "utf8");

for (const f of [
  "lib/fast-path-metrics.ts",
  "lib/pkg-auto-ensure.ts",
  "lib/keystore-policy.ts",
  "lib/failure-fixture-retry.ts",
  "PLAN_PRIORITIES_V395.md",
]) {
  assert.ok(fs.existsSync(path.join(root, f)), f);
}

const metrics = read("lib/fast-path-metrics.ts");
assert.match(metrics, /recordFastPathExecution/);
assert.match(metrics, /fastPathHits/);

const pkg = read("lib/pkg-auto-ensure.ts");
assert.match(pkg, /inferPkgProfilesFromTask/);
assert.match(pkg, /buildAutoPkgEnsurePlan/);

const exec = read("lib/termux-executor.ts");
assert.match(exec, /recordFastPathExecution/);

const llm = read("hooks/useLLM.ts");
assert.match(llm, /ensureRuntimeSession/);
assert.match(llm, /killRuntimeSession/);

const agent = read("lib/termux-agent.ts");
assert.match(agent, /AUTO_PKG|autoPkgBlock/);
assert.match(agent, /buildAutoPkgEnsurePlan/);

const play = read("lib/agent-playbooks.ts");
assert.match(play, /preferHost/);

const usage = read("lib/agent-usage-meter.ts");
assert.match(usage, /formatUsageSummary/);
assert.match(usage, /hostCommands/);

const priv = read("lib/privilege-awareness.ts");
assert.match(priv, /buildShizukuProbeCommand/);

const runtime = read("app/runtime.tsx");
assert.match(runtime, /getFastPathSnapshot/);
assert.match(runtime, /Fast Path/);

const smoke = read("DEVICE_SMOKE.md");
const sourceVersionCode = read("app.config.ts").match(/versionCode:\s*(\d+)/)?.[1];
assert.ok(sourceVersionCode, "source Android version code is present");
assert.match(smoke, new RegExp(`v${sourceVersionCode}`));
assert.match(smoke, /Android device smoke.*\*\*NOT RUN\*\*/);

const trajSrc = read("lib/agent-trajectory.ts");
assert.match(trajSrc, /recordUsageBackend/);
assert.match(trajSrc, /trajectoryUsageSummary/);

const termuxAgentSrc = read("lib/termux-agent.ts");
assert.match(termuxAgentSrc, /trajectoryUsageSummary/);
assert.match(termuxAgentSrc, /usageLine/);

const replaySrc = read("app/session-replay.tsx");
assert.match(replaySrc, /buildRetryPlanFromFixture/);
assert.match(replaySrc, /Повторить|Повторити|Retry/);

const runtimeSrc2 = read("app/runtime.tsx");
assert.match(runtimeSrc2, /onPrivilegeProbe/);
assert.match(runtimeSrc2, /onKeystoreCheck/);
assert.match(runtimeSrc2, /buildShizukuProbeCommand/);


assert.match(termuxAgentSrc, /AIB_AUTO_PKG_PREFLIGHT/);
assert.match(termuxAgentSrc, /runInActiveEnv/);
const indexSrc = read("app/index.tsx");
assert.match(indexSrc, /retryTask/);
assert.match(indexSrc, /useLocalSearchParams/);
const pre = read("scripts/aib-pre-release.mjs");
assert.match(pre, /priorities-v395-selftest/);

assert.match(termuxAgentSrc, /skipAutoPkg/);
assert.match(termuxAgentSrc, /trustedInternal: true/);
assert.match(indexSrc, /retryAppliedRef/);
const runtimeSrc3 = read("app/runtime.tsx");
assert.match(runtimeSrc3, /resetFastPathMetrics/);

const usageSrc = read("lib/agent-usage-meter.ts");
assert.match(usageSrc, /meter\.hostCommands = \(meter\.hostCommands \|\| 0\) \+ 1/);
assert.match(usageSrc, /meter\.prootCommands = \(meter\.prootCommands \|\| 0\) \+ 1/);
assert.doesNotMatch(usageSrc, /\(meter\.hostCommands \|\| 0\) \+=/);

const i18nSrc = read("lib/i18n.ts");
assert.match(i18nSrc, /nativePriorityTitle:/);
assert.match(i18nSrc, /nativePriorityHint:/);
assert.match(i18nSrc, /desktopModeLabel:/);
assert.match(i18nSrc, /desktopModeHint:/);
assert.equal((i18nSrc.match(/nativePriorityTitle:/g) || []).length, 3);
assert.equal((i18nSrc.match(/privilegeProbe:/g) || []).length, 3);
assert.equal((i18nSrc.match(/keystoreCheck:/g) || []).length, 3);
assert.equal((i18nSrc.match(/stopAllSessions:/g) || []).length, 3);
assert.equal((i18nSrc.match(/stopSession:/g) || []).length, 3);
console.log("aib-priorities-v395-selftest: OK");


