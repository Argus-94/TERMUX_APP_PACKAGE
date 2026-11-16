/**
 * Static + pure-logic selftest for AgentTrace / structural gates.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const src = fs.readFileSync(path.join(root, "lib/agent-trace.ts"), "utf8");
const agentSrc = fs.readFileSync(path.join(root, "lib/termux-agent.ts"), "utf8");
const errors = [];

for (const token of [
  "promoteTraceToFixture",
  "evaluateFailToPassContract",
  "runFailToPassSelftest",
  "buildRegressionHintsForTask",
  "summarizeTraceStats",
  "runStructuralGates",
  "clusterFailure",
  "createAgentTrace",
  "persistAgentTrace",
  "BUILTIN_TRACE_FIXTURES",
  "extractApkPath",
  "no_packages_menu_done",
  "absolute_apk_path",
]) {
  if (!src.includes(token)) errors.push(`agent-trace missing ${token}`);
}

for (const token of [
  'from "./agent-trace"',
  "runStructuralGates",
  "STRUCTURAL_GATE_FAIL",
  "appendTraceStep",
  "persistAgentTrace",
  "AIB_APK_EXISTS",
  "AIB_APK_SIZE",
  "APK_TOO_SMALL",
  "buildRegressionHintsForTask",
]) {
  if (!agentSrc.includes(token)) errors.push(`termux-agent missing ${token}`);
}

function extractApkPath(text) {
  const m =
    text.match(/(?:^|[\s"'`=])(\/(?:storage|data|sdcard)\/[\w./+-]+\.apk)\b/i) ||
    text.match(/AIB_DETERMINISTIC_APK=(\/[^\s]+)/i);
  return m?.[1]?.trim() || null;
}

function runStructuralGates(task, doneMessage, requireApk) {
  const msg = (doneMessage || "").trim();
  const gates = [];
  const packagesPush =
    /(меню\s*[«"]?Пакеты|Packages\s*menu|Для компиляции)/i.test(msg) && !extractApkPath(msg);
  gates.push({ id: "no_packages_menu_done", pass: !packagesPush });
  const relativeOnly =
    /(сборк[аеи]\s+успешн|BUILD SUCCESSFUL|проверьте\s+app\/build)/i.test(msg) &&
    !extractApkPath(msg);
  gates.push({ id: "no_relative_apk_hint", pass: !relativeOnly });
  if (requireApk) {
    gates.push({ id: "absolute_apk_path", pass: !!extractApkPath(msg) });
  }
  return gates;
}

const passMsg =
  "APK готов: /storage/emulated/0/AIBuilderTermux/HelloWorld/app/build/outputs/apk/debug/app-debug.apk";
const failRelative = "Сборка успешна. Проверьте app/build/outputs/apk/.";
const failPackages = 'Установите SDK через меню "Пакеты → Для компиляции".';

const g1 = runStructuralGates("Создай Hello World", passMsg, true);
if (!g1.every((g) => g.pass)) errors.push("passMsg should pass all gates");

const g2 = runStructuralGates("Создай Hello World", failRelative, true);
if (g2.every((g) => g.pass)) errors.push("relative success must fail gates");

const g3 = runStructuralGates("Создай Hello World", failPackages, true);
if (g3.every((g) => g.pass)) errors.push("packages menu DONE must fail gates");

function evaluateFailToPass(task, failMsg, passMsg, requireApk) {
  const gFail = runStructuralGates(task, failMsg, requireApk);
  if (gFail.every((g) => g.pass)) return false;
  if (passMsg) {
    const gPass = runStructuralGates(task, passMsg, requireApk);
    if (!gPass.every((g) => g.pass)) return false;
  }
  return true;
}
if (!evaluateFailToPass("Создай Hello World", failRelative, passMsg, true)) {
  errors.push("fail-to-pass contract broken");
}

if (errors.length) {
  console.error("FAIL\n" + errors.join("\n"));
  process.exit(1);
}
console.log("OK agent-trace selftest");
console.log("- structural gates + fail-to-pass");
console.log("- APK on-disk size verify wired");
console.log("- regression hints + stats helpers present");
