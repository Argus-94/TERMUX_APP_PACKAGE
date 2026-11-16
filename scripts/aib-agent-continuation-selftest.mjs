#!/usr/bin/env node
/**
 * Ensures docs/AGENT_CONTINUATION.md always exists with required handoff sections.
 * User relies on this file when starting a new dialog with «Продолжи».
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const file = path.join(root, "docs", "AGENT_CONTINUATION.md");
const errors = [];

if (!fs.existsSync(file)) {
  errors.push("MISSING docs/AGENT_CONTINUATION.md — must always exist");
} else {
  const t = fs.readFileSync(file, "utf8");
  for (const need of [
    "Выполнено в текущем проходе",
    "Обязательные незакрытые пункты",
    "Первые действия при продолжении",
    "Условия закрытия",
    "AIBuilder-Expo-v269.zip",
    "com.karat.aibuilder",
    "PROMT.txt",
    "Историческая запись прежнего handoff",
  ]) {
    if (!t.includes(need)) errors.push("missing section/text: " + need);
  }
  if (!/Обновлять этот файл в конце каждой итерации с архивом/.test(t)) {
    errors.push("missing mandatory handoff update rule");
  }
  if (!/0\/43/.test(t) || !/0\/25/.test(t) || !/не полный sign-off/i.test(t)) {
    errors.push("handoff must disclose current incomplete tool/chain coverage and non-final status");
  }
}

if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log("AIB_AGENT_CONTINUATION_SELFTEST_OK file=docs/AGENT_CONTINUATION.md");
