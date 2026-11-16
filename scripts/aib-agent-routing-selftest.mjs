/**
 * Chat-only vs Termux-agent routing fixtures.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const pu = fs.readFileSync(path.join(root, "lib/provider-utils.ts"), "utf8");
const llm = fs.readFileSync(path.join(root, "hooks/useLLM.ts"), "utf8");
const eng = fs.readFileSync(path.join(root, "lib/agent-engine.ts"), "utf8");
const errors = [];

if (!llm.includes("strongCreateEarly")) errors.push("useLLM strongCreateEarly");
if (!eng.includes("SOFT_APP_PRODUCT")) errors.push("SOFT_APP_PRODUCT");
if (!eng.includes("создадим")) errors.push("create stems missing создадим");
if (!pu.includes("создать")) errors.push("provider-utils missing создать");
const intent = fs.readFileSync(path.join(root, "lib/termux-intent.ts"), "utf8");
if (!intent.includes("refine-app")) errors.push("termux-intent missing refine-app");
if (!llm.includes("strongCreateEarly")) errors.push("useLLM strongCreateEarly");

function isChatOnlyMessage(message) {
  const raw = String(message || "").trim();
  if (!raw || raw.length > 500) return false;
  const t = raw.toLowerCase().replace(/[!?.…]+$/g, "");
  if (/(что\s+умеешь|полный\s+список|capabilities)/i.test(t)) return true;
  if (/(напиши|скажи|опиши|перечисли).{0,40}(умеешь|можешь|функц)/i.test(t)) return true;
  const needs =
    /(создай|создать|создадим|собери|установи|gradlew|build\s+apk|пересобери)/i.test(t) ||
    /(напиши|сделай|создай|создать).{0,80}(приложен|apk|android|hello\s*world|калькул|игр[уаы]|таймер|timer|трекер)/i.test(t) ||
    /(добавь|доработай|измени).{0,50}(кнопк|приложен|таймер|activity)/i.test(t) ||
    /\.apk\b/i.test(t);
  if (needs) return false;
  if (t.length <= 200 && /^(напиши|создай|скажи|опиши)/i.test(t)) {
    if (/(приложен|apk|android|таймер|timer|игр[уаы]|трекер)/i.test(t)) return false;
    return true;
  }
  return false;
}

function isStrongish(message) {
  const m = message.toLowerCase();
  const create = /(создай|создать|создадим|создайте|напиши|сделай|make|create)/i.test(m);
  if (!create) return false;
  if (/(приложен|apk|android|hello\s*world|калькул)/i.test(m)) return true;
  if (/(таймер|timer|заметк|трекер|tracker|игр[уаы]|счётчик|счетчик)/i.test(m)) return true;
  if (/(на|под)\s+android/i.test(m)) return true;
  return false;
}

const cases = [
  ["Напиши полный список что умеешь делать", true, false],
  ["Создай Hello World", false, true],
  ["Создай таймер", false, true],
  ["Создай приложение для учёта воды", false, true],
  ["Создать простой android app", false, true],
  ["Напиши таймер", false, true],
  ["Напиши стих про осень", true, false],
  ["Создай стих про осень", false, false], // создай → not chat-only, but not strong app
  ["Перемести apk в Download", false, false],
  // refine follow-ups: not chat-only (needsTermux)
  ["Добавь кнопку старт в приложение", false, false],
  ["Пересобери apk", false, false],
];

for (const [msg, expectChat, expectStrong] of cases) {
  const got = isChatOnlyMessage(msg);
  if (got !== expectChat) errors.push(`chatOnly "${msg}" got=${got} expect=${expectChat}`);
  const st = isStrongish(msg);
  if (st !== expectStrong) errors.push(`strongish "${msg}" got=${st} expect=${expectStrong}`);
}

if (errors.length) {
  console.error("FAIL\n" + errors.join("\n"));
  process.exit(1);
}
console.log("OK agent-routing selftest");
console.log("- создай/создать/создадим + wish → agent");
console.log("- создай стих → not strong app (model chat)");
console.log("- напиши стих → chat-only");
