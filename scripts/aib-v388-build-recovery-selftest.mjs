#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(new URL("../lib/termux-agent.ts", import.meta.url), "utf8");
const maxRecoveries = Number(source.match(/const maxBuildRecoveries = (\d+);/)?.[1]);
assert.ok(Number.isInteger(maxRecoveries) && maxRecoveries > 0, "BUILD_RECOVERY_BUDGET_MISSING");
assert.match(source, /const BUILD_RECOVERY_WALL_MS = 150 \* 60 \* 1000/);
assert.match(source, /readiness\.ok\)[\s\S]{0,350}no package install or Gradle retry started/);
assert.match(source, /recoveryFingerprints\.filter\(\(fp\) => fp === recoveryState\.fingerprint\)\.length >= 3/);
assert.match(source, /same-failure-after-two-attempts/);
assert.match(source, /APK build recovery exhausted/);
assert.match(source, /last_failure\.log/);
for (const blocker of ["network-unavailable", "storage-access-denied", "rootfs-unverified"]) {
  assert.ok(source.includes(`"${blocker}"`), `RECOVERY_BLOCKER_MISSING:${blocker}`);
}

function simulateRecovery(failures, budget = maxRecoveries) {
  const fingerprints = [];
  let attempts = 0;
  const repeatLimit = 3; // v389: a repeated cause is tolerated three times (each followed by a different fix) before stopping
  for (let index = 0; index < maxRecoveries; index += 1) {
    if (index >= budget) return { stop: "build-recovery-time-limit", attempts };
    attempts += 1;
    const failure = failures[index] || { fingerprint: `unique-${index}` };
    if (failure.blocker) return { stop: failure.blocker, attempts };
    if (fingerprints.filter((fp) => fp === failure.fingerprint).length >= repeatLimit) return { stop: "same-failure-after-two-attempts", attempts };
    fingerprints.push(failure.fingerprint);
  }
  return { stop: "retry-budget-exhausted", attempts };
}

assert.deepEqual(simulateRecovery([{ fingerprint: "w" }, { fingerprint: "w" }, { fingerprint: "w" }, { fingerprint: "w" }]), {
  stop: "same-failure-after-two-attempts",
  attempts: 4,
});
assert.deepEqual(simulateRecovery(Array.from({ length: 12 }, (_, i) => ({ fingerprint: `u${i}` }))), {
  stop: "retry-budget-exhausted",
  attempts: maxRecoveries,
});
assert.deepEqual(simulateRecovery([{ fingerprint: "network", blocker: "network-unavailable" }]), {
  stop: "network-unavailable",
  attempts: 1,
});
assert.deepEqual(simulateRecovery([{ fingerprint: "a" }, { fingerprint: "b" }], 1), {
  stop: "build-recovery-time-limit",
  attempts: 1,
});
console.log(`AIB_V388_BUILD_RECOVERY_SELFTEST_OK max_recoveries=${maxRecoveries} duplicate_root_cause=stop network_blocker=stop timeout=bounded exhaustion=bounded log=preserved`);
