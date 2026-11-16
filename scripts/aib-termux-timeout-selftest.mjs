import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const bridge = fs.readFileSync(path.join(root, "plugins/withTermuxBridge.js"), "utf8");
const packs = fs.readFileSync(path.join(root, "lib/termux-packs.ts"), "utf8");
const bridgeTs = fs.readFileSync(path.join(root, "lib/termux-bridge.ts"), "utf8");
const executor = fs.readFileSync(path.join(root, "lib/termux-executor.ts"), "utf8");
const required = [
  [/command -v timeout/, "timeout availability guard"],
  [/timeout --signal=TERM --kill-after=10s/, "TERM/KILL timeout enforcement"],
  [/result\.exitCode == 124/, "native timeout result handling"],
  [/\+ 15_000L/, "termination grace period"],
  [/RUN_COMMAND_PENDING_INTENT/, "official Termux result callback"],
  [/TermuxResultReceiver/, "private callback receiver"],
  [/AIBUILDER_TIMEOUT_UNAVAILABLE: install coreutils in Termux/, "coreutils fail-closed guard"],
];
for (const [re, name] of required) if (!re.test(bridge + "\n" + packs)) throw new Error(`missing: ${name}`);
if (!/opts\?\.honorExplicitTimeout !== true && \(opts\?\.isBuild === true \|\| looksLikeLongRunningCommand\(cmd\)\)/.test(bridgeTs)) throw new Error("missing: explicit bounded phase timeout override");
if (!/Math\.min\(Math\.max\(1_000, timeout\), MAX_COMMAND_TIMEOUT_MS\)/.test(bridgeTs)) throw new Error("missing: hard cap for exact timeout override");
if (!/honorExplicitTimeout: options\.honorExplicitTimeout/.test(executor)) throw new Error("missing: guarded executor timeout plumbing");
console.log("AIB_TERMUX_TIMEOUT_SELFTEST_OK");
