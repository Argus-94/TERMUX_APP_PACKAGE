import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

/** Resolve the repository TypeScript package or the installation backing `tsc`. */
export function loadTypeScript() {
  const require = createRequire(import.meta.url);
  try { return require("typescript"); } catch { /* resolve the available global compiler below */ }
  try {
    const command = process.platform === "win32" ? "where" : "which";
    const executable = fs.realpathSync(execFileSync(command, ["tsc"], { encoding: "utf8" }).trim().split(/\r?\n/)[0]);
    const candidates = [
      path.resolve(path.dirname(executable), "../lib/typescript.js"),
      path.resolve(path.dirname(executable), "../lib/node_modules/typescript/lib/typescript.js"),
    ];
    for (const candidate of candidates) if (fs.existsSync(candidate)) return require(candidate);
  } catch { /* report one stable test setup error below */ }
  const error = new Error("SELFTEST_TYPESCRIPT_UNAVAILABLE");
  error.code = "SELFTEST_TYPESCRIPT_UNAVAILABLE";
  throw error;
}

export const typescript = loadTypeScript();
