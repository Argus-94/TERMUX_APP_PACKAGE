import assert from "node:assert/strict";
import fs from "node:fs";

const recovery = fs.readFileSync("lib/agent-recovery.ts", "utf8");
const agent = fs.readFileSync("lib/termux-agent.ts", "utf8");
const backend = fs.readFileSync("lib/agent-shell-backend.ts", "utf8");
const autonomy = fs.readFileSync("lib/agent-autonomy-policy.ts", "utf8");
const policy = fs.readFileSync("lib/apk-build-safety-policy.ts", "utf8");

assert.match(recovery, /aib_\(\?:ubuntu\|debian\)_rootfs_missing|aib_proot_distro_missing/);
assert.match(recovery, /android_sdk_not_found/);
assert.match(recovery, /java_not_found/);
assert.match(recovery, /active-build-backend/);
assert.match(agent, /agentShellBackendPromptHint/);
assert.match(autonomy, /Ubuntu: apt only/);
assert.doesNotMatch(autonomy, /Debian: apt only/);
assert.match(autonomy, /Termux: pkg only/);
assert.match(policy, /AUTONOMOUS BUILD POLICY/);
assert.match(policy, /sdkmanager/);
assert.match(policy, /AIB_AUTOBUILD_NEEDS_LLM=1/);
assert.match(policy, /Never stop at the first error/);
assert.match(autonomy, /Prefer repairing the rootfs over proot-distro reset\/remove/);
assert.match(recovery, /APK_BUILD_SAFETY_POLICY/);
assert.match(agent, /BUILD_RECOVERY_SAFETY_POLICY/);
assert.match(backend, /AIB_UBUNTU_ROOTFS_MISSING/);
assert.match(backend, /AIB_DEBIAN_ROOTFS_MISSING/);

console.log("AIB_RECOVERY_TOOLCHAIN_LAYER_SELFTEST_OK backend_aware=1 sdk=1 java=1 proot=1");
