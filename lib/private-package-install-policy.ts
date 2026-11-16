/**
 * Manual catalog installation is a different trust boundary from terminal exec.
 * No reviewed, signed app-compatible feed/toolchain has been qualified yet.
 * This is intentionally not a setting, environment flag, or cached UI value.
 */
export const PRIVATE_PACKAGE_MUTATION_BLOCK_CODE = "AIB_PRIVATE_PACKAGE_FEED_NOT_QUALIFIED" as const;
const PRIVATE_PACKAGE_MUTATION_AVAILABILITY = Object.freeze({
  allowed: false as const,
  code: PRIVATE_PACKAGE_MUTATION_BLOCK_CODE,
});

export function getPrivatePackageMutationAvailability() {
  return PRIVATE_PACKAGE_MUTATION_AVAILABILITY;
}

export function privatePackageMutationBlockReason(language: "ru" | "uk" | "en"): string {
  if (language === "en") {
    return "Ordinary catalog installation, update and removal are unavailable: the complete signed feed and tools for AI Builder's private Android runtime have not been qualified. External Termux or Linux archives are not compatible substitutes. This refusal performs no download or installation. The separate test-only make transaction does not qualify other tools or enable a production feed.";
  }
  if (language === "uk") {
    return "Звичайне встановлення, оновлення й видалення з каталогу недоступні: повний підписаний feed та інструменти для приватного Android-середовища AI Builder ще не кваліфіковані. Пакети зовнішнього Termux або Linux не є сумісною заміною. Ця відмова не запускає завантаження чи встановлення. Окремий test-only сценарій make не кваліфікує інші інструменти й не вмикає production-feed.";
  }
  return "Обычная установка, обновление и удаление из каталога недоступны: полный подписанный feed и инструменты для приватной Android-среды AI Builder ещё не квалифицированы. Пакеты внешнего Termux или Linux не являются совместимой заменой. Этот отказ не запускает скачивание или установку. Отдельный test-only сценарий make не квалифицирует остальные инструменты и не включает production-feed.";
}

export function assertPrivatePackageMutationAllowed(): never {
  const availability = getPrivatePackageMutationAvailability();
  throw new Error(`${availability.code}: ${privatePackageMutationBlockReason("en")}`);
}
