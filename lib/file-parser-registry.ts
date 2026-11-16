/** Local attachment parsing. Extracted file bytes are untrusted data; no archive entry or document content is executed. */

import { File } from "expo-file-system";
import { extractText as extractPdfText, isAvailable as isPdfExtractorAvailable } from "expo-pdf-text-extract";
import type { AttachmentType, ChatAttachment } from "./multimodal-types";
import { extractApkContent, extractDocxContent, extractGenericZipContent, extractXlsxContent } from "./document-content-extractors";
import { type ZipByteSource } from "./archive-utils";

const MAX_INLINE_CHARS = 12_000;
const MAX_TEXT_READ_BYTES = 256 * 1024;
const MAX_CSV_READ_BYTES = 512 * 1024;
const MAX_SAFE_NONARCHIVE_BYTES = 100 * 1024 * 1024;
const MAX_SAFE_OFFICE_BYTES = 50 * 1024 * 1024;
const MAX_SAFE_PDF_BYTES = 20 * 1024 * 1024;
const MAX_SAFE_ARCHIVE_BYTES = 512 * 1024 * 1024;

export class AttachmentReadError extends Error {
  readonly code = "ATTACHMENT_READ_FAILED";

  constructor() {
    super("ATTACHMENT_READ_FAILED");
    this.name = "AttachmentReadError";
  }
}

const EXT_TO_TYPE: Record<string, AttachmentType> = {
  // Images
  jpg: "IMAGE", jpeg: "IMAGE", png: "IMAGE", gif: "IMAGE", webp: "IMAGE", svg: "IMAGE", bmp: "IMAGE", heic: "IMAGE",
  // Audio
  mp3: "AUDIO", wav: "AUDIO", m4a: "AUDIO", aac: "AUDIO", ogg: "AUDIO", flac: "AUDIO", opus: "AUDIO",
  // Video
  mp4: "VIDEO", mkv: "VIDEO", mov: "VIDEO", webm: "VIDEO", avi: "VIDEO", "3gp": "VIDEO",
  // Documents and spreadsheets
  pdf: "PDF",
  doc: "DOCUMENT", docx: "DOCUMENT", rtf: "DOCUMENT", odt: "DOCUMENT",
  xls: "SPREADSHEET", xlsx: "SPREADSHEET", csv: "SPREADSHEET", tsv: "SPREADSHEET", ods: "SPREADSHEET",
  ppt: "PRESENTATION", pptx: "PRESENTATION", odp: "PRESENTATION",
  // Text and configuration
  txt: "TEXT", md: "TEXT", markdown: "TEXT", log: "TEXT", ini: "TEXT", env: "TEXT", conf: "TEXT",
  json: "JSON", xml: "XML", html: "XML", xhtml: "XML", svg2: "XML", plist: "XML", yml: "TEXT", yaml: "TEXT",
  // Source code
  js: "SOURCE_CODE", jsx: "SOURCE_CODE", ts: "SOURCE_CODE", tsx: "SOURCE_CODE",
  py: "SOURCE_CODE", java: "SOURCE_CODE", kt: "SOURCE_CODE", kts: "SOURCE_CODE",
  c: "SOURCE_CODE", cpp: "SOURCE_CODE", h: "SOURCE_CODE", hpp: "SOURCE_CODE",
  rs: "SOURCE_CODE", go: "SOURCE_CODE", swift: "SOURCE_CODE", rb: "SOURCE_CODE",
  sh: "SOURCE_CODE", bash: "SOURCE_CODE", zsh: "SOURCE_CODE", gradle: "SOURCE_CODE",
  css: "SOURCE_CODE", scss: "SOURCE_CODE", less: "SOURCE_CODE", sql: "SOURCE_CODE",
  // Archives and packages
  zip: "ARCHIVE", tar: "ARCHIVE", gz: "ARCHIVE", "7z": "ARCHIVE", rar: "ARCHIVE",
  apk: "ARCHIVE", aab: "ARCHIVE", jar: "ARCHIVE",
};

export function detectAttachmentType(fileName: string, mimeType?: string): AttachmentType {
  const ext = (fileName.split(".").pop() || "").toLowerCase();
  if (EXT_TO_TYPE[ext]) return EXT_TO_TYPE[ext];
  if (mimeType) {
    if (mimeType.startsWith("image/")) return "IMAGE";
    if (mimeType.startsWith("audio/")) return "AUDIO";
    if (mimeType.startsWith("video/")) return "VIDEO";
    if (mimeType.includes("pdf")) return "PDF";
    if (mimeType.includes("json")) return "JSON";
    if (mimeType.includes("xml")) return "XML";
    if (mimeType.includes("zip") || mimeType.includes("compressed") || mimeType.includes("archive")) return "ARCHIVE";
    if (mimeType.includes("spreadsheet") || mimeType.includes("csv")) return "SPREADSHEET";
    if (mimeType.includes("word") || mimeType.includes("document")) return "DOCUMENT";
    if (mimeType.startsWith("text/")) return "TEXT";
  }
  return "UNKNOWN";
}

function zipSource(file: File, size: number): ZipByteSource {
  return {
    size,
    async read(start, end) {
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > size) throw new Error("ZIP_RANGE_INVALID");
      return new Uint8Array(await file.slice(start, end).arrayBuffer());
    },
  };
}

function tooLarge(size: number, limit: number, label: string): { text: string; summary: string; truncated: boolean } {
  const mb = (size / (1024 * 1024)).toFixed(1);
  const limitMb = (limit / (1024 * 1024)).toFixed(0);
  return { text: `[${label}: файл больше безопасного лимита ${limitMb} МБ; содержимое не прочитано.]`, summary: `${label}: ${mb} МБ, превышен лимит`, truncated: true };
}

function limitText(text: string, summary: string, max = MAX_INLINE_CHARS) {
  if (text.length <= max) return { text, summary, truncated: false };
  return { text: `${text.slice(0, max)}\n[... показаны первые ${max} символов ...]`, summary, truncated: true };
}

function fileSize(file: File, attachment: ChatAttachment): number {
  const actual = file.size;
  return typeof actual === "number" && Number.isFinite(actual) && actual >= 0 ? actual : Math.max(0, attachment.sizeBytes || 0);
}

async function readTextPrefix(file: File, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  const slice = file.slice(0, maxBytes);
  const text = await slice.text();
  return { text, truncated: (file.size || 0) > maxBytes };
}

function readFirstBytes(bytes: Uint8Array, expected: string): boolean {
  return bytes.length >= expected.length && expected.split("").every((character, index) => bytes[index] === character.charCodeAt(0));
}

/** Reads an attachment and returns only bounded text/metadata for the conversation. */
export async function parseAndExtractAttachmentContent(
  attachment: ChatAttachment,
): Promise<{ text: string; summary: string; truncated: boolean }> {
  try {
    const file = new File(attachment.uri);
    const size = fileSize(file, attachment);
    const extension = attachment.extension.toLowerCase();

    if (attachment.attachmentType === "ARCHIVE") {
      if (size > MAX_SAFE_ARCHIVE_BYTES) return tooLarge(size, MAX_SAFE_ARCHIVE_BYTES, "Архив");
      const source = zipSource(file, size);
      if (extension === "apk") return await extractApkContent(source);
      if (extension === "zip" || extension === "jar") return await extractGenericZipContent(source);
      if (extension === "aab") return { text: "[AAB: ZIP-контейнер не установлен и не запускается. Для безопасности извлечение набора Android App Bundle отключено.]", summary: "AAB: содержимое не извлечено", truncated: false };
      return { text: `[Формат ${extension || "архив"} распознаётся, но поддерживается только безопасное чтение ZIP/APK.]`, summary: "Формат архива не поддерживается", truncated: false };
    }

    if (attachment.attachmentType === "PDF") {
      if (size > MAX_SAFE_PDF_BYTES) return tooLarge(size, MAX_SAFE_PDF_BYTES, "PDF");
      const prefix = new Uint8Array(await file.slice(0, 8).arrayBuffer());
      if (!readFirstBytes(prefix, "%PDF-")) return { text: "[PDF: расширение не совпало с сигнатурой файла; содержимое не извлечено.]", summary: "PDF-сигнатура не подтверждена", truncated: false };
      if (!isPdfExtractorAvailable()) return { text: "[PDF: native text extractor недоступен в этой сборке.]", summary: "PDF extractor недоступен", truncated: false };
      try {
        const text = await extractPdfText(attachment.uri);
        if (!text.trim()) return { text: "[PDF распознан, но цифровой текст не найден. OCR сканированных страниц не выполняется.]", summary: "PDF: цифровой текст не найден", truncated: false };
        return limitText(text, `PDF: извлечено ${text.length} символов`);
      } catch {
        return { text: "[PDF повреждён, защищён паролем или не прошёл безопасное извлечение; локальный путь и детали ошибки скрыты.]", summary: "PDF не удалось безопасно прочитать", truncated: false };
      }
    }

    if (attachment.attachmentType === "DOCUMENT") {
      if (extension !== "docx") return { text: `[Формат документа ${extension || "неизвестен"} не поддерживается; извлечение реализовано для DOCX.]`, summary: "Документ не поддерживаемого формата", truncated: false };
      if (size > MAX_SAFE_OFFICE_BYTES) return tooLarge(size, MAX_SAFE_OFFICE_BYTES, "DOCX");
      return await extractDocxContent(zipSource(file, size));
    }

    if (attachment.attachmentType === "SPREADSHEET") {
      if (extension === "csv" || extension === "tsv") {
        if (size > MAX_SAFE_NONARCHIVE_BYTES) return tooLarge(size, MAX_SAFE_NONARCHIVE_BYTES, "CSV/TSV");
        const { text: raw, truncated } = await readTextPrefix(file, MAX_CSV_READ_BYTES);
        const lines = raw.split(/\r?\n/).slice(0, 100);
        const limited = lines.join("\n");
        const rowTruncated = raw.split(/\r?\n/).length > 100 || truncated;
        return { text: `[Содержимое ${extension.toUpperCase()} (до 100 строк)]:\n${limited}${rowTruncated ? "\n[... последующие строки или байты не переданы ...]" : ""}`, summary: `${extension.toUpperCase()}: передано ${lines.length} строк`, truncated: rowTruncated };
      }
      if (extension !== "xlsx") return { text: `[Электронная таблица ${extension || "неизвестного формата"}: безопасное извлечение реализовано для CSV, TSV и XLSX.]`, summary: "Табличный формат не поддерживается", truncated: false };
      if (size > MAX_SAFE_OFFICE_BYTES) return tooLarge(size, MAX_SAFE_OFFICE_BYTES, "XLSX");
      return await extractXlsxContent(zipSource(file, size));
    }

    if (["TEXT", "SOURCE_CODE", "JSON", "XML"].includes(attachment.attachmentType)) {
      if (size > MAX_SAFE_NONARCHIVE_BYTES) return tooLarge(size, MAX_SAFE_NONARCHIVE_BYTES, "Текстовый файл");
      const { text, truncated } = await readTextPrefix(file, MAX_TEXT_READ_BYTES);
      const result = limitText(text, `Текстовый файл: ${text.length} символов`);
      if (truncated) return { text: `${result.text}\n[... исходный файл больше безопасного объёма чтения ...]`, summary: result.summary, truncated: true };
      return result;
    }

    if (attachment.attachmentType === "IMAGE") return { text: "[Изображение прикреплено]", summary: "Изображение", truncated: false };
    if (attachment.attachmentType === "AUDIO") return { text: "[Прикреплена аудиозапись]", summary: "Аудиозапись", truncated: false };
    if (attachment.attachmentType === "VIDEO") return { text: "[Прикреплён видеофайл]", summary: "Видеофайл", truncated: false };
    if (attachment.attachmentType === "PRESENTATION") return { text: "[Презентация прикреплена; содержимое слайдов этой версией не извлекается.]", summary: "Презентация", truncated: false };
    return { text: `[Прикреплён файл (${(size / 1024).toFixed(1)} КБ); безопасный текстовый extractor для этого формата не настроен.]`, summary: "Файл без текстового извлечения", truncated: false };
  } catch {
    // Do not serialize user filenames, local URIs, exception text, or platform paths into model context.
    throw new AttachmentReadError();
  }
}
