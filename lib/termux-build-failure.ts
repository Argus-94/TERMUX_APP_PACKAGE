export type TermuxBuildFailureKind = "project-input" | "project-path" | "toolchain" | "gradle" | "build-command";

/** Classify by explicit output markers, preferring source and preflight failures over generic exit codes. */
export function classifyTermuxBuildFailure(output: string): TermuxBuildFailureKind {
  const text = String(output ?? "");
  if (/BLOCKED_BY_APP|sensitive file access is not allowed|SENSITIVE_FILE_READ_BLOCKED|PROJECT_SOURCE_(?:ACCESS_DENIED|NOT_FOUND|COPY_FAILED|READ_NOT_PROVEN|SPECIAL_FILE_DENIED|SYMLINK_DENIED)|PROJECT_ARCHIVE_(?:INVALID|PATH_VALIDATION_FAILED|UNSAFE_MEMBER|LINK_OR_SPECIAL_FILE_DENIED|SPECIAL_FILE_DENIED|SYMLINK_DENIED|EXTRACT_FAILED|SIZE_LIMIT_EXCEEDED)|PROJECT_IMPORT_(?:COPY_FAILED|ROOT_INVALID|OUTSIDE_PROJECTS)|PROJECT_SOURCE_INVALID|PROJECT_PREBUILD_REQUIRED|PROJECT_KIND_UNSUPPORTED|PROJECT_ARCHIVE_VALIDATOR_MISSING|PROJECT_WORKSPACE_[A-Z_]+/i.test(text)) return "project-input";
  if (/\bNO_SAVED_PROJ\b|\bNO_PROJECT\b|\bAIB_PROJECT_PATH_[A-Z_]+\b|PROJECT_PATH_VALIDATION_FAILED/i.test(text)) return "project-path";
  if (/\bNO_JAVA\b|\bJAVA_(?:MISSING|NOT_FOUND)\b|\bNO_SDK\b|\bSDK_MISSING\b|\bsdk_(?:dir|platforms)=(?:MISSING|UNTRUSTED)\b|\baapt2=MISSING\b|\bgradle=BROKEN\b|gradle=OK:\s*(?:\r?\n|$)|NO_VERIFIED_GRADLE_WRAPPER/i.test(text)) return "toolchain";
  if (/\bBUILD FAILED\b|FAILURE:\s*Build failed|What went wrong:/i.test(text)) return "gradle";
  return "build-command";
}

/** User-facing diagnosis never claims Gradle ran unless its own failure marker exists. */
export function termuxBuildFailureMessage(kind: TermuxBuildFailureKind): string {
  switch (kind) {
    case "project-input": return "Исходный файл не удалось безопасно прочитать/подготовить как поддерживаемый проект. Проверьте доступ к файлу и структуру исходников; причина не классифицируется как отсутствие Gradle wrapper.";
    case "project-path": return "Ошибка проверки пути к проекту: сохранённый каталог отсутствует или недоступен. Сборка Gradle не запускалась.";
    case "toolchain": return "Проверка Android/JDK/SDK toolchain не пройдена. Автоматическая установка и повторные recovery циклы не запускались; Gradle не запускался.";
    case "gradle": return "Gradle запустился, но завершился с ошибкой сборки или компиляции.";
    default: return "Сборочная команда завершилась ошибкой; вывод не подтверждает, что Gradle успел запуститься.";
  }
}

export function formatTermuxBuildFailure(kind: TermuxBuildFailureKind, stage: "prepare" | "assemble", exitCode: number): string {
  return `${termuxBuildFailureMessage(kind)} (stage=${stage}, exit=${Number.isFinite(exitCode) ? exitCode : "unknown"}).`;
}
