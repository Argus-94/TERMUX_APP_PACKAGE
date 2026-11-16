export type PackageMenuAvailability = {
  bridgeAvailable: boolean;
  sessionEnabled: boolean;
  reason: "session-disabled" | "bridge-unavailable" | "eligible";
};

export function classifyPackageMenuAvailability(
  bridgeAvailable: boolean,
  sessionEnabled: boolean,
): PackageMenuAvailability {
  return {
    bridgeAvailable,
    sessionEnabled,
    reason: !bridgeAvailable ? "bridge-unavailable" : !sessionEnabled ? "session-disabled" : "eligible",
  };
}

export function packageMenuAvailabilityMessage(reason: PackageMenuAvailability["reason"], language: string): string {
  if (reason === "eligible") return "";
  if (reason === "session-disabled") {
    if (language === "en") return "Termux session is disabled. Enable it in the side menu before using package actions. This is separate from private runtime readiness.";
    if (language === "uk") return "Сесію Termux вимкнено. Увімкніть її в боковому меню перед діями з пакетами. Це окремо від готовності приватного runtime.";
    return "Сессия Termux выключена. Включите её в боковом меню перед действиями с пакетами. Это отдельно от готовности приватного runtime.";
  }
  if (language === "en") return "The native Termux bridge is unavailable. Package actions are blocked; this does not indicate private runtime readiness. The full signed feed is checked separately.";
  if (language === "uk") return "Нативний міст Termux недоступний. Дії з пакетами заблоковано; це не свідчить про готовність приватного runtime. Повний підписаний feed перевіряється окремо.";
  return "Нативный bridge Termux недоступен. Действия с пакетами заблокированы; это не означает, что private runtime не готов. Полный подписанный feed проверяется отдельно.";
}
