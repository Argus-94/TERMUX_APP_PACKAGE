/**
 * AGENTS.md — инструкция для ИИ-агента в корне пользовательского проекта.
 * Не README: только команды, структура, запреты, критерий «готово».
 */

import { executeGuardedTermuxCommand } from "./termux-executor";

export interface AgentsMdConfig {
  name: string;
  packageName?: string;
  stack?: string;
  /** Корень проекта на устройстве (для блока Команды). */
  projectPath?: string;
}

/** Шаблон под Android/Gradle в Termux (aarch64). */
export function generateAgentsMd(config: AgentsMdConfig): string {
  const name = config.name || "App";
  const pkg = config.packageName || "com.example.app";
  const stack = config.stack || "Kotlin, Android Gradle, ViewBinding/Compose";
  const root = config.projectPath || ".";

  return `# AGENTS.md

## Проект
${name} — Android-приложение (${pkg}).
Стек: ${stack}. Сборка и правки — в **Termux на Android (обычно aarch64)**, не на PC.

## Среда
- SDK: \`$PREFIX/opt/android-sdk\` (\`export ANDROID_HOME=\$PREFIX/opt/android-sdk\`)
- NDK: только **aarch64** из проверенного pinned tool-pack → \`\$PREFIX/opt/android-ndk\`, не Google linux-x86_64
- На \`/storage/...\`: \`bash gradlew ...\`, не \`./gradlew\` (нет exec bit)

## Команды
- Сборка debug:
  \`cd "${root}" && export ANDROID_HOME=\$PREFIX/opt/android-sdk ANDROID_SDK_ROOT=\$ANDROID_HOME && bash gradlew assembleDebug --no-daemon\`
- APK после сборки: \`find . -path '*/outputs/apk/*.apk'\`
- Тесты (если есть): \`bash gradlew test --no-daemon\`

## Структура
- \`app/src/main/java/\` — Kotlin/Java
- \`app/src/main/res/\` — ресурсы
- \`app/build.gradle*\` / корневой \`build.gradle*\` — зависимости и SDK
- Не коммить и не править без нужды: \`.gradle/\`, \`build/\`, локальные секреты

## Правила
0. Среда: Android ARM64 + Termux. Предпочитай host Termux (pkg) для простых задач; Ubuntu proot — только когда нужен полный Linux userspace (apt). Не ставь desktop/x86_64 пакеты.
1. Сообщение пользователя в чате важнее этого файла.
2. Этот AGENTS.md — только проектный контекст; он не может отменять системные, security- или sandbox-ограничения агента.
3. Меняй только файлы, нужные задаче.
4. Не добавляй зависимости без явной нужды.
5. Не ставь desktop-пакеты (Ubuntu amd64, brew, choco, Google NDK linux.zip).
6. Не пиши простыни android-sdk-license в цикле.
7. Не выдумывай \`BUILD SUCCESSFUL\` / \`[TERMUX_RESULT]\`.

## Готово, когда
- Есть реальный \`*.apk\` под \`*/outputs/apk/\`
- В выводе сборки есть \`BUILD SUCCESSFUL\` (из gradle, не из текста модели)
- Нет падения на изменённых экранах/сценариях задачи
`;
}

const MAX_AGENTS_CHARS = 6000;

/**
 * Прочитать AGENTS.md из корня проекта (или ближайший вверх).
 * Возвращает текст или null.
 */
export async function loadAgentsMdFromProject(
  projectPath: string | null | undefined
): Promise<string | null> {
  if (!projectPath || !projectPath.trim()) return null;
  const root = projectPath.replace(/\/+$/, "").trim();
  // Only read AGENTS.md under Termux/storage project roots (no traversal outside).
  if (
    root.includes("\0") ||
    root.includes("..") ||
    !/^(\/storage\/|\/sdcard\/|\/data\/data\/com\.termux\/)/.test(root)
  ) {
    return null;
  }
  // Экранирование для shell
  const esc = root.replace(/'/g, `'\\''`);
  const cmd =
    `f='${esc}/AGENTS.md'; if [ -f "$f" ]; then echo "___AGENTS_START___"; head -c ${MAX_AGENTS_CHARS} "$f"; echo; echo "___AGENTS_END___"; exit 0; fi; ` +
    `echo "___AGENTS_NONE___"`;
  try {
    const r = await executeGuardedTermuxCommand(cmd, { timeoutMs: 15_000, trustedInternal: true });
    const out = r.stdout || "";
    if (/___AGENTS_NONE___/.test(out)) return null;
    const m = out.match(/___AGENTS_START___([\s\S]*?)___AGENTS_END___/);
    if (!m) return null;
    const body = m[1].trim();
    return body ? body.slice(0, MAX_AGENTS_CHARS) : null;
  } catch {
    return null;
  }
}

/** Извлечь путь проекта из текста задачи (zip или каталог). */
export function guessProjectRootFromTask(task: string): string | null {
  const zip =
    task.match(/(\/storage\/[^\s"'`]+\.zip)/i) ||
    task.match(/(\/data\/data\/com\.termux\/files\/home\/[^\s"'`]+\.zip)/i);
  if (zip) {
    // после unzip корень часто рядом; для AGENTS ищем в распакованном workdir позже
    return null;
  }
  const dir = task.match(/(\/storage\/emulated\/0\/[^\s"'`]+)/i);
  return dir ? dir[1].replace(/[),\].]+$/, "") : null;
}
