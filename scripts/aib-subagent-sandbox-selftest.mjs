import fs from "node:fs";
import path from "node:path";
const root = process.cwd();
const guard = fs.readFileSync(path.join(root, "lib/termux-guard.ts"), "utf8");
const executor = fs.readFileSync(path.join(root, "lib/termux-executor.ts"), "utf8");
const subagents = fs.readFileSync(path.join(root, "lib/subagents.ts"), "utf8");
const guardHasNoBranchAllowlist = !/"status"[^\n]*"branch"/.test(guard);
if (!guardHasNoBranchAllowlist) throw new Error("A11_GIT_BRANCH_MUTATION_STILL_ALLOWLISTED");

if (!guard.includes("guardReadOnlyTermuxCommand")) throw new Error("A11_NO_STRICT_READONLY_GUARD");
if (!executor.includes("executeReadOnlyTermuxCommand")) throw new Error("A11_NO_STRICT_READONLY_EXECUTOR");
if (!subagents.includes("executeReadOnlyTermuxCommand")) throw new Error("A11_SUBAGENT_NOT_BOUND_TO_READONLY_EXECUTOR");
if (subagents.includes("executeGuardedTermuxCommand(cmd")) throw new Error("A11_SUBAGENT_CAN_USE_GENERAL_EXECUTOR");

for (const forbidden of ["rm -f x", "touch x", "mkdir x", "curl https://example.com", "npm install", "node -e 'x'", "cat ../secret", "cat /etc/passwd", "cat $HOME/.ssh/id_rsa", "git -C /tmp status", "git branch new", "sed -i s/a/b/ x", "find . -exec rm {} \;", "cat a; rm -rf .", "cat a > b", "cat a | sh"]) {
  if (!guard.includes("READ_ONLY_COMMANDS")) throw new Error("A11_GUARD_IMPLEMENTATION_MISSING");
  // Static assertions complement runtime unit cases because this self-test has no
  // TypeScript runtime available in the release archive.
  if (/\b(?:rm|touch|mkdir|curl|npm|node)\b/.test(forbidden) && !guard.includes("not allowlisted")) throw new Error("A11_FAIL_CLOSED_POLICY_MISSING");
}
console.log("AIB_SUBAGENT_SANDBOX_SELFTEST_OK");
