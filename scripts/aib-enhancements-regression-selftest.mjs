#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const suites = [
  "aib-credential-proxy-selftest.mjs",
  "aib-agent-provider-route-selftest.mjs",
  "aib-provider-transport-selftest.mjs",
  "aib-provider-credential-lifecycle-selftest.mjs",
  "aib-provider-credential-migration-selftest.mjs",
  "aib-credential-proxy-transport-selftest.mjs",
  "aib-runtime-backend-security-selftest.mjs",
  "aib-command-log-redaction-selftest.mjs",
  "aib-task-checkpoint-selftest.mjs",
  "aib-runtime-manifest-selftest.mjs",
  "aib-incontainer-supervisor-selftest.mjs",
  "aib-sleep-wake-selftest.mjs",
  "aib-hardened-proot-selftest.mjs",
  "aib-proot-container-mount-security-selftest.mjs",
  "aib-activity-timeline-selftest.mjs",
  "aib-workspace-snapshot-selftest.mjs",
  "aib-enhancements-integration-selftest.mjs",
  "aib-interceptor-policy-selftest.mjs",
  "aib-interceptor-engine-selftest.mjs",
  "aib-userspace-runtime-selftest.mjs",
  "aib-runtime-e2e-contract-selftest.mjs",
  "aib-core-agent-security-selftest.mjs",
  "aib-supervisor-watchdog-selftest.mjs",
  "aib-supervisor-policy-selftest.mjs",
  "aib-termux-bridge-kotlin-template-selftest.mjs",
  "aib-first-run-orchestrator-selftest.mjs",
  "aib-bootstrap-diagnostics-selftest.mjs",
  "aib-performance-mode-selftest.mjs",
  "aib-device-policy-selftest.mjs",
  "aib-accessibility-engine-selftest.mjs",
  "aib-wireless-adb-selftest.mjs",
  "aib-device-bridge-selftest.mjs",
  "aib-virtualdisplay-native-selftest.mjs",
  "aib-agent-fs-write-selftest.mjs",
  "aib-secret-path-policy-selftest.mjs",
  "aib-gguf-lifecycle-selftest.mjs",
  "aib-offline-agent-selftest.mjs",
  "aib-community-skill-policy-selftest.mjs",
  "aib-android-toolchain-agent-selftest.mjs",
  "aib-android-toolchain-production-wiring-selftest.mjs",
  "aib-security-policy-regression-selftest.mjs",
  "aib-uninstall-safe-store-selftest.mjs",
  "aib-data-migration-selftest.mjs",
  "aib-home-document-storage-selftest.mjs",
  "aib-durable-persistence-selftest.mjs",
  "aib-scoped-backup-selftest.mjs",
  "aib-profile-transfer-regression-selftest.mjs",
];
const javac = spawnSync("javac", ["-version"], { encoding: "utf8" });
const javacAvailable = !javac.error && javac.status === 0;
const skipped = javacAvailable ? [] : ["aib-credential-proxy-transport-selftest.mjs (JDK javac unavailable)"];
const runnableSuites = suites.filter((suite) => javacAvailable || suite !== "aib-credential-proxy-transport-selftest.mjs");
const failures = [];
for (const suite of runnableSuites) {
  const file = path.join(root, "scripts", suite);
  if (!(await import("node:fs").then(({ existsSync }) => existsSync(file)))) {
    failures.push(`${suite}: missing test file`);
    process.stderr.write(`REGRESSION_MISSING_SUITE: ${suite}\n`);
    continue;
  }
  const result = spawnSync(process.execPath, ["--experimental-transform-types", file], { cwd: root, encoding: "utf8", timeout: 120_000 });
  if (result.error || result.status !== 0) {
    process.stderr.write(result.stdout || "");
    process.stderr.write(result.stderr || "");
    const failure = `${suite} status=${result.status} ${result.error ?? ""}`;
    failures.push(failure);
    process.stderr.write(`REGRESSION_FAILED: ${failure}\n`);
    continue;
  }
  process.stdout.write(`${suite}: ${result.stdout.trim().split(/\r?\n/).at(-1)}\n`);
}
if (failures.length) {
  process.stderr.write(`AIB_ENHANCEMENTS_REGRESSION_SELFTEST_FAIL passed=${runnableSuites.length - failures.length} failed=${failures.length} skipped=${skipped.length ? skipped.join(";") : "none"}\n`);
  for (const failure of failures) process.stderr.write(` - ${failure}\n`);
  process.exitCode = 1;
} else {
  console.log(`AIB_ENHANCEMENTS_REGRESSION_SELFTEST_OK suites=${runnableSuites.length} skipped=${skipped.length ? skipped.join(";") : "none"} device_rn_termux_proot=NOT_TESTED`);
}
