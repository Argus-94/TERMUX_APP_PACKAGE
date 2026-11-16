import type { BuildStage, TermuxTaskKind } from "../components/TermuxContext";

export interface ObservedBuildStageUpdate {
  id: string;
  status: BuildStage["status"];
  detail?: string;
}

export interface TaskIntentHints {
  createApp?: boolean;
  reverse?: boolean;
  build?: boolean;
  repair?: boolean;
}

/** Classifies the requested work, while allowing the existing intent parser to supply authoritative hints. */
export function classifyTermuxTaskKind(text: string, hints: TaskIntentHints = {}): TermuxTaskKind {
  const value = String(text || "");
  if (hints.createApp || /\b(create|generate|make)\b.{0,35}\b(app|application|apk|project)\b|создай.{0,35}(прилож|apk|проект)|создать.{0,35}(прилож|apk|проект)|зроби.{0,35}(застос|apk|проєкт)/i.test(value)) return "create_apk";
  if (hints.reverse || /\b(reverse engineer|decompile|decompil|jadx|smali)\b|реверс|декомпил|разобрать apk/i.test(value)) return "reverse";
  if (hints.repair || /\b(repair|fix|correct|patch|debug)\b.{0,50}\b(source|code|project|app|build|bug|error)\b|\b(source|code|project|app|build|bug|error)\b.{0,50}\b(repair|fix|correct|patch)\b|исправ|почин|устран.{0,25}(ошиб|баг)|починить/i.test(value)) return "repair_source";
  if (hints.build || /\b(assemble|gradle|build\s*apk|build\s*project)\b|собери|собрать|сборк|збірк|скомпіл|компіл/i.test(value)) return "build_apk";
  return "generic";
}

export function taskKindTitle(kind: TermuxTaskKind, language?: string): string {
  const en = language === "en";
  const uk = language === "uk";
  switch (kind) {
    case "create_apk": return en ? "Create app" : uk ? "Створення застосунку" : "Создание приложения";
    case "build_apk": return en ? "Build APK" : uk ? "Збірка APK" : "Сборка APK";
    case "repair_source": return en ? "Repair source" : uk ? "Виправлення вихідного коду" : "Исправление исходников";
    case "reverse": return en ? "Analyze project" : uk ? "Аналіз застосунку" : "Анализ приложения";
    default: return en ? "Task" : uk ? "Завдання" : "Задача";
  }
}

/** These IDs and names correspond exactly to runAssembleDebug's emitted stage events. */
export function createObservedAssembleStages(language?: string): BuildStage[] {
  const labels = language === "en"
    ? ["Java / Android SDK environment", "Gradle assembleDebug", "Find APK output", "Align APK", "Sign APK (V1/V2/V3)", "Verify signature"]
    : language === "uk"
      ? ["Середовище Java / Android SDK", "Gradle assembleDebug", "Пошук APK", "Вирівнювання APK", "Підпис APK (V1/V2/V3)", "Перевірка підпису"]
      : ["Окружение Java / Android SDK", "Gradle assembleDebug", "Поиск APK", "Выравнивание APK", "Подпись APK (V1/V2/V3)", "Проверка подписи"];
  const ids = ["setup", "compile", "apk", "align", "sign", "verify"];
  return ids.map((id, index) => ({ id, label: labels[index], status: "pending" }));
}

/** Apply exactly one backend update; do not auto-complete earlier or future stages. */
export function applyObservedBuildStageUpdate(stages: readonly BuildStage[], update: ObservedBuildStageUpdate): BuildStage[] {
  return stages.map((stage) => stage.id === update.id
    ? { ...stage, status: update.status, detail: update.detail }
    : { ...stage });
}

/** Redact credential-shaped text before exposing a command or error in the task card. */
export function redactTaskActivityText(value: unknown): string {
  return String(value || "")
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, "[скрыто]")
    .replace(/(authorization\s*[:=]\s*(?:token|bearer)\s+)\S+/ig, "$1[скрыто]")
    .replace(/(api[_-]?key\s*[:=]\s*)\S+/ig, "$1[скрыто]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}
