import { File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import type { AppLanguage } from "./i18n";

/**
 * Если пользователь вставляет в поле ввода очень много текста (буфер
 * обмена), приложение вместо огромного сообщения создаёт .txt-файл и
 * прикрепляет его к чату — см. порог PASTE_TO_FILE_THRESHOLD в app/index.tsx.
 * Файл хранится в постоянном каталоге документов приложения; "скачать" из чата — это шаринг через
 * системное меню (Sharing.shareAsync), как и экспорт лога в
 * hooks/useLogger.ts.
 */

export interface TextFileAttachment {
  name: string;
  uri: string;
  size: number;
}

export async function saveTextAsFile(text: string, baseName = "paste"): Promise<TextFileAttachment> {
  const fileName = `${baseName}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`;
  const file = new File(Paths.document, fileName);
  await file.write(text);
  return { name: fileName, uri: file.uri, size: file.size ?? text.length };
}

export interface ShareTextFileOptions {
  /** Заголовок системного діалогу "Поділитися". Якщо не передано — англійський fallback. */
  dialogTitle?: string;
  /** Повідомлення про помилку, якщо Sharing недоступний на пристрої. */
  unavailableMessage?: string;
}

export async function shareTextFile(uri: string, options?: ShareTextFileOptions): Promise<void> {
  const isAvailable = await Sharing.isAvailableAsync();
  if (!isAvailable) {
    throw new Error(options?.unavailableMessage || "File sharing is not available on this device.");
  }
  await Sharing.shareAsync(uri, {
    mimeType: "text/plain",
    dialogTitle: options?.dialogTitle || "Save file",
    UTI: "public.plain-text",
  });
}

// Скорочення одиниць вимірювання розміру файлу — окремо під кожну мову
// додатку, щоб рядок на кшталт "2.5 ГБ" не залишався російським/українським
// незалежно від того, яку мову обрано в Налаштуваннях (див. useLanguage()).
const SIZE_UNITS: Record<AppLanguage, [string, string, string, string]> = {
  uk: ["Б", "КБ", "МБ", "ГБ"],
  ru: ["Б", "КБ", "МБ", "ГБ"],
  en: ["B", "KB", "MB", "GB"],
};

const SPEED_SUFFIX: Record<AppLanguage, string> = {
  uk: "/с",
  ru: "/с",
  en: "/s",
};

export function formatFileSize(bytes: number, lang: AppLanguage = "en"): string {
  const [b, kb, mb, gb] = SIZE_UNITS[lang] || SIZE_UNITS.en;
  if (bytes < 1024) return `${bytes} ${b}`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} ${kb}`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} ${mb}`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} ${gb}`;
}

/** То же самое, что formatFileSize, но с суффиксом скорости — для скорости скачивания. */
export function formatSpeed(bytesPerSec: number, lang: AppLanguage = "en"): string {
  if (bytesPerSec <= 0) return "";
  return `${formatFileSize(bytesPerSec, lang)}${SPEED_SUFFIX[lang] || SPEED_SUFFIX.en}`;
}
