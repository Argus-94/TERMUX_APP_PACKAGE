#!/usr/bin/env node
/**
 * Phase H — run top-level aib-*-selftest scripts safely.
 * The archive selftest receives a clean source ZIP; raw child output is discarded.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const scriptsDir = path.join(root, "scripts");
const archiveTest = "aib-accessibility-source-archive-selftest.mjs";
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const flagMap = new Map();
for (const command of Object.values(packageJson.scripts || {})) {
  for (const match of command.matchAll(/node\s+(--experimental-(?:strip|transform)-types)\s+(scripts\/[^\s;&]+\.mjs)/g)) {
    flagMap.set(path.basename(match[2]), match[1]);
  }
}
const tests = fs
  .readdirSync(scriptsDir)
  .filter((f) => f.startsWith("aib-") && f.endsWith("-selftest.mjs"))
  .filter((f) => f !== "aib-acceptance-selftest.mjs")
  .sort();

const secretName = /(API_KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE_KEY|SIGNING)/i;
const childEnv = { ...process.env };
for (const key of Object.keys(childEnv)) {
  if (secretName.test(key)) delete childEnv[key];
}

let temporaryArchiveDir;
let archivePath = process.argv[2] || childEnv.AIB_SOURCE_ARCHIVE_PATH;
if (archivePath) {
  archivePath = path.resolve(root, archivePath);
  if (!fs.existsSync(archivePath) || !fs.statSync(archivePath).isFile()) {
    throw new Error("AIB_SOURCE_ARCHIVE_NOT_FOUND");
  }
} else {
  temporaryArchiveDir = fs.mkdtempSync(path.join(os.tmpdir(), "aib-acceptance-source-"));
  archivePath = path.join(temporaryArchiveDir, "clean-source.zip");
  const excluded = [
    "./node_modules/*", "./**/node_modules/*", "./android/*", "./.git/*",
    "./.expo/*", "./**/.expo/*", "./.gradle/*", "./**/.gradle/*",
    "./build/*", "./**/build/*", "./.cache/*", "./**/.cache/*",
    "./__pycache__/*", "./**/__pycache__/*", "*.apk", "*.aab",
    "*.keystore", "*.jks", "*.p12", "*.pfx", "./local.properties",
  ];
  try {
    const zip = spawnSync("zip", ["-qr", archivePath, ".", "-x", ...excluded], {
      cwd: root,
      env: childEnv,
      encoding: "utf8",
      timeout: 60_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    if (zip.status !== 0) throw new Error("AIB_ACCEPTANCE_SOURCE_ARCHIVE_CREATE_FAILED");
  } catch (error) {
    fs.rmSync(temporaryArchiveDir, { recursive: true, force: true });
    throw error;
  }
}

function category(result, combined) {
  if (result.error?.code === "ETIMEDOUT" || result.signal === "SIGTERM") return "TIMEOUT";
  if (combined.includes("AIB_TEST_EXTERNAL_NETWORK_BLOCKED")) return "EXTERNAL_NETWORK_BLOCKED";
  const match = combined.match(/\b(AssertionError|TypeError|ReferenceError|SyntaxError|RangeError|Error)\b/);
  return match?.[1] || "FAILURE_DETAILS_SUPPRESSED";
}

let failed = 0;
const results = [];
try {
  for (const file of tests) {
    const args = [flagMap.get(file) || "--experimental-transform-types", path.join(scriptsDir, file)];
    if (file === archiveTest) args.push(archivePath);
    const r = spawnSync(process.execPath, args, {
      cwd: root,
      env: childEnv,
      encoding: "utf8",
      timeout: file === archiveTest ? 120_000 : 90_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    const combined = `${r.stderr || ""}\n${r.stdout || ""}`;
    const ok = r.status === 0 && !r.error;
    const row = {
      file,
      status: ok ? "pass" : "fail",
      exit_code: r.status,
      category: ok ? "" : category(r, combined),
    };
    if (!ok) failed++;
    results.push(row);
    console.log(ok ? `OK  ${file}` : `FAIL  ${file}  ${row.category}`);
  }
} finally {
  if (temporaryArchiveDir) fs.rmSync(temporaryArchiveDir, { recursive: true, force: true });
}

const summary = {
  total: results.length,
  passed: results.filter((r) => r.status === "pass").length,
  failed,
  archive_input: "source-only ZIP; raw logs discarded",
  child_credentials: "secret-like environment variables removed",
  child_network: "inherited network guard when supplied by caller",
  raw_output_retained: false,
  results,
};
fs.writeFileSync("/home/ubuntu/aib-v269/acceptance-final.json", `${JSON.stringify(summary, null, 2)}\n`);
console.log(`AIB_ACCEPTANCE_${failed === 0 ? "OK" : "FAIL"} total=${tests.length} failed=${failed}`);
process.exit(failed === 0 ? 0 : 1);
