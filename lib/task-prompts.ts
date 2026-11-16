/**
 * Короткие system-промпты по типу задачи (priority #7).
 * В контекст модели — только хвост лога + diff/скрипт, не весь stdout.
 */

export type TaskPromptKind =
  | "build_apk"
  | "reverse_apk"
  | "install_tools"
  | "script_fix"
  | "file_ops"
  | "generic";

const PROMPTS: Record<TaskPromptKind, { ru: string; en: string }> = {
  build_apk: {
    ru:
      "Ты чинишь сборку APK в Termux. Не переписывай version Gradle и gradle.properties проекта. " +
      "Смотри только хвост лога. Минимальный патч: память Gradle, workers, offline-кэш, путь SDK/Java. " +
      "Успех = реальный APK на диске + exit 0.",
    en:
      "You fix APK builds in Termux. Do not rewrite project Gradle version or gradle.properties. " +
      "Use log tail only. Minimal patch: Gradle memory, workers, offline cache, SDK/Java paths. " +
      "Success = real APK on disk + exit 0.",
  },
  reverse_apk: {
    ru:
      "Ты анализируешь APK (jadx/aapt/unzip). Не удаляй чужие файлы. " +
      "Вывод: краткий отчёт + путь к OUT. Если нет jadx — остановись: BLOCKED: PRIVATE_FEED_UNQUALIFIED; подписанный приватный канал ещё не квалифицирован, ничего не устанавливай и не скачивай.",
    en:
      "You analyze APKs (jadx/aapt/unzip). Do not delete unrelated files. " +
      "Output: short report + OUT path. If jadx is missing, stop: BLOCKED: PRIVATE_FEED_UNQUALIFIED; the signed private feed is not yet qualified. Do not install or download anything.",
  },
  install_tools: {
    ru:
      "Проверяй инструменты только во встроенном приватном runtime. При отсутствии требуемого инструмента остановись: BLOCKED: PRIVATE_FEED_UNQUALIFIED; ничего не устанавливай и не скачивай. " +
      "Не гоняй полный preflight, если инструмент уже есть. Короткий лог.",
    en:
      "Probe tools only in the embedded private runtime. If a required tool is missing, stop: BLOCKED: PRIVATE_FEED_UNQUALIFIED; do not install or download anything. " +
      "Skip full preflight if tool already present. Short log.",
  },
  script_fix: {
    ru:
      "Ты правишь .sh после ошибки. Дай ТОЛЬКО исправленное тело скрипта или краткий diff. " +
      "Не повторяй весь stdout. Опасные rm -rf / su — только с явной необходимостью.",
    en:
      "You fix a .sh after failure. Reply with fixed script body or short diff only. " +
      "Do not dump full stdout. Dangerous rm -rf / su only if strictly required.",
  },
  file_ops: {
    ru:
      "Задача — только файл: найти / скопировать / переместить / показать путь. " +
      "НЕ запускай gradle/assemble/toolchain. " +
      "Сначала find/ls по известным путям (AIBuilderTermux, project, Download). " +
      "Если .apk нет — честно TERMUX_DONE: APK не найден (путь не существует). " +
      "Если есть — cp/mv в указанную папку и TERMUX_DONE с абсолютным путём.",
    en:
      "Task is file-only: find / copy / move / show path. " +
      "Do NOT run gradle/assemble/toolchain. " +
      "First find/ls known paths (AIBuilderTermux, project, Download). " +
      "If no .apk — honest TERMUX_DONE: APK not found. " +
      "If found — cp/mv to target folder and TERMUX_DONE with absolute path.",
  },
  generic: {
    ru:
      "Ты агент AI Builder в Termux. Короткие ответы. Факты только из реального вывода команд.",
    en:
      "You are AI Builder Termux agent. Short replies. Facts only from real command output.",
  },
};

export function getShortTaskPrompt(
  kind: TaskPromptKind,
  lang: "ru" | "uk" | "en" = "ru",
): string {
  const p = PROMPTS[kind] || PROMPTS.generic;
  if (lang === "en") return p.en;
  return p.ru; // uk uses ru for brevity
}


/** Map Intent Router kind → short task prompt (no circular import of intent-router). */
export function intentKindToTaskPromptKind(intentKind: string): TaskPromptKind {
  switch (intentKind) {
    case "build_from_path":
    case "analyze_and_fix":
    case "create_app":
      return "build_apk";
    case "reverse_apk":
      return "reverse_apk";
    case "ndk_install":
      return "install_tools";
    case "analyze_sources":
    case "diagnose":
    case "adb":
      return "file_ops";
    default:
      return "generic";
  }
}

export function classifyTaskPromptKind(task: string): TaskPromptKind {
  const t = (task || "").toLowerCase();
  // Pure file move/copy/find — before build_apk (message may contain "apk")
  if (
    /(перемест|переклад|скопир|скопір|copy|move|cp\s|mv\s)/i.test(t) ||
    /(положи|поклади|кинь|put|place).{0,20}(download|загрузк|завантаж)/i.test(t)
  ) {
    return "file_ops";
  }
  if (/(реверс|reverse|jadx|декомпил|decompile|анализ.*apk|analyze.*apk)/i.test(t)) {
    return "reverse_apk";
  }
  if (/(установи|install).{0,40}(пакет|jadx|sdk|jdk|openjdk|toolchain)|pkg install/i.test(t)) {
    return "install_tools";
  }
  if (/(assemble|сборк|gradle|expo.*build|build\s*apk|созда[йи].*apk)/i.test(t)) {
    return "build_apk";
  }
  if (/(патч|fix|script|\.sh|исправ)/i.test(t)) {
    return "script_fix";
  }
  return "generic";
}

/** Context for LLM: log tail + optional script snippet (not full stdout). */
export function buildLlmRepairContext(opts: {
  kind?: TaskPromptKind;
  log: string;
  script?: string;
  attempt?: number;
  lang?: "ru" | "uk" | "en";
  maxLogChars?: number;
  maxScriptChars?: number;
}): string {
  const kind = opts.kind || "script_fix";
  const lang = opts.lang || "ru";
  const maxLog = opts.maxLogChars ?? 6000;
  const maxScript = opts.maxScriptChars ?? 4000;
  const sys = getShortTaskPrompt(kind, lang);
  const log = (opts.log || "").slice(-maxLog);
  const script = (opts.script || "").slice(0, maxScript);
  const attempt = opts.attempt ?? 1;
  return (
    `${sys}\n\n` +
    `Attempt: ${attempt}\n\n` +
    (script ? `Current script (head):\n\`\`\`bash\n${script}\n\`\`\`\n\n` : "") +
    `Log tail:\n\`\`\`\n${log}\n\`\`\`\n`
  );
}
