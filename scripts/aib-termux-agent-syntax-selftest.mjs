#!/usr/bin/env node
/**
 * Regression: nested single-quotes inside JS single-quoted shell fragments
 * broke Metro createBundleReleaseJsAndAssets (CBE, termux-agent.ts ~803).
 * Also forbid require('$VAR...') patterns in shell string pieces.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const targets = [
  "lib/termux-agent.ts",
  "lib/builtin-build-script.ts",
  "lib/repair-script-runner.ts",
  "lib/build-loop.ts",
  "lib/ubuntu-distro.ts",
  "lib/script-runner-agent.ts",
  "lib/termux-commands.ts",
  "lib/agent-engine.ts",
  "lib/compile-packages.ts",
  "lib/termux-installer-env.ts",
];

const errors = [];

for (const rel of targets) {
  const full = path.join(root, rel);
  if (!fs.existsSync(full)) continue;
  const src = fs.readFileSync(full, "utf8");
  const lines = src.split(/\n/);

  // Anti-pattern that caused CBE failure: require('$... inside a '...' fragment
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/require\('\$[A-Za-z_]/.test(line) || /require\("\$[A-Za-z_]/.test(line)) {
      // only flag if it sits in a single-quoted shell fragment line
      if (/^\s*'/.test(line)) {
        errors.push(`${rel}:${i + 1}: nested require($VAR) inside single-quoted shell fragment`);
      }
    }
    // node -p with require(' inside single-quoted line
    if (/^\s*'/.test(line) && /node -p/.test(line) && /require\('\$/.test(line)) {
      errors.push(`${rel}:${i + 1}: node -p require('$VAR) in single-quoted fragment`);
    }
    // catch(e){''} pattern inside single-quoted line (ends string early)
    if (/^\s*'/.test(line) && /catch\s*\(\s*e\s*\)\s*\{\s*''\s*\}/.test(line)) {
      errors.push(`${rel}:${i + 1}: catch(e){''} inside single-quoted fragment`);
    }
  }


  if (/gradle\s+wrapper\s+--gradle-version/.test(src)) {
    errors.push(`${rel}: unpinned gradle wrapper --gradle-version`);
  }
  if (/packages(?:-cf)?\.termux\.dev\/apt\/termux-main/.test(src)) {
    errors.push(`${rel}: hardcoded packages*.termux.dev mirror`);
  }

  // Positive: the build fast-path snapshots src only after its null guard so
  // the async closure cannot pass a nullable path into the preflight command.
  if (rel === "lib/termux-agent.ts") {
    if (!/if\s*\(src\)\s*\{\s*const requestedSourcePath = src;[\s\S]*?buildProjectSourcePreflightCommand\(requestedSourcePath(?:,|\))/.test(src)) {
      errors.push("lib/termux-agent.ts: guarded immutable source path capture missing");
    }
    if (/require\('\$EXPO_ROOT/.test(src)) {
      errors.push("lib/termux-agent.ts: still has require('$EXPO_ROOT)");
    }
  }
}

if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log("AIB_TERMUX_AGENT_SYNTAX_SELFTEST_OK files=" + targets.length);
