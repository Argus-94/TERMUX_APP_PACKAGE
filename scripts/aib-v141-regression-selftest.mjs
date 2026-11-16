import fs from "node:fs";
const backend=fs.readFileSync("lib/agent-shell-backend.ts","utf8");
const repair=fs.readFileSync("lib/repair-script-runner.ts","utf8");
if (!backend.includes("aib_pkg(){")) throw new Error("AIB_V141_MISSING_UBUNTU_PKG_COMPAT");
if (!backend.includes("apt-get install -y")) throw new Error("AIB_V141_MISSING_APT_BRIDGE");
if (!backend.includes("AIB_PKG_UNSUPPORTED")) throw new Error("AIB_V141_MISSING_PKG_FAIL_CLOSED");
if (repair.includes("runShellCommand(cmd")) throw new Error("AIB_V141_REPAIR_BYPASSES_EXECUTOR");
if (!repair.includes("executeGuardedTermuxCommand(")) throw new Error("AIB_V141_REPAIR_EXECUTOR_MISSING");
console.log("AIB_V141_REGRESSION_SELFTEST_OK");
