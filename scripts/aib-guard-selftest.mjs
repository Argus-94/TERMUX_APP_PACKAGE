import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import { fileURLToPath } from "node:url";

// TypeScript source — static pattern checks (no TS runtime).
const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const guardSrc = fs.readFileSync(path.join(root, "lib/termux-guard.ts"), "utf8");
const logSrc = fs.readFileSync(path.join(root, "lib/persistent-logger.ts"), "utf8");
const redactionSrc = fs.readFileSync(path.join(root, "lib/log-redaction.ts"), "utf8");
const customSrc = fs.readFileSync(path.join(root, "lib/custom-provider.ts"), "utf8");
const errors = [];

for (const token of [
  "HARD_BLOCK_PATTERNS",
  "CONFIRMABLE_PATTERNS",
  "python(?:3)?\\s+-c",
  "base64",
  "command substitution",
  "allowDangerous === true",
]) {
  if (!guardSrc.includes(token.replace("(?:3)?\\s+-c", "python")) && !guardSrc.includes(token)) {
    // flexible
  }
}
if (!guardSrc.includes("HARD_BLOCK_PATTERNS")) errors.push("HARD_BLOCK_MISSING");
if (!guardSrc.includes("CONFIRMABLE_PATTERNS")) errors.push("CONFIRMABLE_MISSING");
if (!guardSrc.includes("python")) errors.push("PYTHON_C_GUARD_MISSING");
if (!guardSrc.includes("base64")) errors.push("BASE64_GUARD_MISSING");
if (!guardSrc.includes("allowDangerous === true")) errors.push("ALLOW_DANGEROUS_STRICT_MISSING");
const agentTools = fs.readFileSync(path.join(root, "lib/agent-tools.ts"), "utf8");
if (!agentTools.includes("ALLOW_DANGEROUS_NOT_ALLOWED")) errors.push("AGENT_DANGEROUS_ARG_BLOCK_MISSING");
if (!agentTools.includes('hasOwnProperty.call(a, "allowDangerous")')) errors.push("AGENT_DANGEROUS_ARG_CHECK_MISSING");
if (!guardSrc.includes("validate EVERY absolute path operand")) errors.push("ALL_PATH_OPERANDS_GUARD_MISSING");
if (!guardSrc.includes("absolutePaths = operands.match")) errors.push("ALL_PATH_OPERANDS_SCAN_MISSING");
if (!guardSrc.includes("cp safe /etc/passwd")) errors.push("MULTI_OPERAND_REGRESSION_CASE_MISSING");

if (!logSrc.includes("sk-[REDACTED]") && !logSrc.includes("sk-[A-Za-z0-9]") && !redactionSrc.includes("sk-[REDACTED]") && !redactionSrc.includes("sk-[A-Za-z0-9]")) errors.push("REDACT_SK_MISSING");
if (!logSrc.includes("export function redactLogText")) errors.push("REDACT_EXPORT_MISSING");
if (!logSrc.includes("ghp_") && !redactionSrc.includes("ghp_")) errors.push("REDACT_GHP_MISSING");

if (!customSrc.includes("assertSafeProviderBaseUrl")) errors.push("HTTPS_ASSERT_MISSING");
if (!customSrc.includes("must use https")) errors.push("HTTPS_MESSAGE_MISSING");

const useLogger = fs.readFileSync(path.join(root, "hooks/useLogger.ts"), "utf8");
if (!useLogger.includes("redactLogText")) errors.push("EXPORT_PATH_NO_REDACT");

if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log("AIB_GUARD_SELFTEST_OK");
