#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const errors = [];
const shared = path.join(root, "lib/ui-expanded-highlight.ts");
if (!fs.existsSync(shared)) errors.push("missing lib/ui-expanded-highlight.ts");
else {
  const t = fs.readFileSync(shared, "utf8");
  for (const n of ["EXPANDED_GOLD", "EXPANDED_GOLD_DEEP", "expandedHeaderStyle", "expandedTitleColor", "expandedIconColors"]) {
    if (!t.includes(n)) errors.push("shared missing " + n);
  }
}
for (const rel of [
  "components/AgentThinkingPanel.tsx",
  "components/BuildProgressPanel.tsx",
  "app/runtime.tsx",
  "app/settings.tsx",
  "components/ChatBubble.tsx",
]) {
  const t = fs.readFileSync(path.join(root, rel), "utf8");
  if (!t.includes("ui-expanded-highlight") && !t.includes("expandedHeaderStyle") && !t.includes("EXPANDED_GOLD")) {
    errors.push(rel + " not wired to shared highlight");
  }
}
const agent = fs.readFileSync(path.join(root, "lib/termux-agent.ts"), "utf8");
if (!agent.includes("sourceKindFromPrepOut")) errors.push("sourceKindFromPrepOut missing");
if (!agent.includes("Подготовка (${prepKindLabel})") && !agent.includes("Подготовка (${")) {
  // template form
  if (!agent.includes("prepKindLabel")) errors.push("prepKindLabel activity missing");
}
if (errors.length) { console.error(errors.join("\n")); process.exit(1); }
console.log("AIB_EXPANDED_HIGHLIGHT_SELFTEST_OK panels=shared settings=shared chat=1 prepareKind=1");
