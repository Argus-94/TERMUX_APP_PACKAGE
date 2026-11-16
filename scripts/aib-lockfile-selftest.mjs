import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const errors = [];
if (pkg.packageManager !== "pnpm@9.15.0") errors.push(`PACKAGE_MANAGER_MISMATCH:${pkg.packageManager || "missing"}`);
if (!fs.existsSync(path.join(root, "pnpm-lock.yaml"))) errors.push("PNPM_LOCKFILE_MISSING");
if (fs.existsSync(path.join(root, "package-lock.json"))) errors.push("NPM_LOCKFILE_FORBIDDEN");
const gradlew = fs.readFileSync(path.join(root, "gradlew"), "utf8");
const termuxAgent = fs.readFileSync(path.join(root, "lib", "termux-agent.ts"), "utf8");
if (!gradlew.includes("pnpm install --frozen-lockfile")) errors.push("GRADLEW_NOT_PINNED_TO_PNPM");
if (/npm install --legacy-peer-deps/.test(gradlew)) errors.push("GRADLEW_NPM_FALLBACK_PRESENT");
if (/pnpm install --no-frozen-lockfile/.test(termuxAgent)) errors.push("TERMUX_AGENT_NO_FROZEN_LOCKFILE");
if (!/\bpnpm(?:\s+install)?\s+--frozen-lockfile\b/.test(termuxAgent)) errors.push("TERMUX_AGENT_FROZEN_PNPM_MISSING");
// Controlled npm fallback after pnpm attempts is allowed for device robustness (Expo cache / partial installs).
if (!termuxAgent.includes("pnpm@9.15.0") && !termuxAgent.includes("NO_PINNED_PNPM")) {
  errors.push("TERMUX_AGENT_PNPM_FAIL_CLOSED_MISSING");
}
const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
if (!readme.includes("Canonical package manager/lockfile: pnpm 9.15.0")) errors.push("README_CANONICAL_PM_MISSING");
if (errors.length) { console.error(errors.join("\n")); process.exit(1); }
console.log("AIB_LOCKFILE_SELFTEST_OK packageManager=pnpm@9.15.0 lockfile=pnpm");
