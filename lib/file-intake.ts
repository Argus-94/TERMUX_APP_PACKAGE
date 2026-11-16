/** Local-first attachment intake, bounded archive inspection and dynamic action resolution. */
import { File } from "expo-file-system";
import type { AttachmentType, ChatAttachment } from "./multimodal-types";
import { detectAttachmentType } from "./file-parser-registry";
import { hasZipStartSignature, inspectZip, type ArchiveInspection, type ZipByteSource } from "./archive-utils";
import { persistentLogger } from "./persistent-logger";

export interface FileAnalysisSession {
  attachmentId: string;
  filename: string;
  mime: string;
  size: number;
  extension: string;
  detectedType: AttachmentType;
  textLike: boolean;
  archive?: ArchiveInspection;
  manifest?: Record<string, unknown>;
  availableActions: FileAction[];
  selectedAction?: string;
  analysisState: "READY" | "ERROR";
  error?: string;
  createdAt: number;
}

export interface FileAction { id: string; label: string; prompt: string; }

const MAX_LOCAL_NONARCHIVE_BYTES = 100 * 1024 * 1024;
const MAX_LOCAL_ARCHIVE_BYTES = 512 * 1024 * 1024;
const sessionCache = new Map<string, FileAnalysisSession>();
const TEXT_EXTS = /^(txt|md|json|xml|yaml|yml|toml|ini|properties|gradle|kts|java|kt|js|ts|tsx|jsx|py|c|cpp|h|hpp|rs|go|sh|css|scss|less|sql|log|conf)$/i;

function fileZipSource(file: File, size: number): ZipByteSource {
  return {
    size,
    async read(start, end) {
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > size) {
        throw new Error("ZIP_RANGE_INVALID");
      }
      return new Uint8Array(await file.slice(start, end).arrayBuffer());
    },
  };
}

function actionsFor(type: AttachmentType, archive?: ArchiveInspection): FileAction[] {
  switch (type) {
    case "ARCHIVE":
      if (archive?.format === "apk") return [
        { id: "apk-analyze", label: "Метаданные APK", prompt: "Анализируй только декодированные из AndroidManifest.xml метаданные и перечисленные извлечённые текстовые записи. APK не устанавливался; подпись, DEX-код, ресурсы и поведение не проверены. Не выводи package/version/permissions, если их нет в переданном тексте." },
        { id: "apk-manifest", label: "Манифест и разрешения", prompt: "Объясни только реально переданные package/version/permissions и компоненты из AndroidManifest.xml; resource IDs не считай подтверждёнными строками. Это не проверка подписи или безопасности кода." },
        { id: "apk-libs", label: "Структура APK", prompt: "Оцени только перечисленные метаданные и извлечённые текстовые записи. Не утверждай ABI/native libraries, если они не указаны явно; не запускай и не устанавливай содержимое." },
        { id: "apk-security", label: "Ограничения проверки", prompt: "Отдели извлечённые локальные метаданные APK от неподтверждённых выводов. Подпись, DEX, native code и runtime-поведение не аудировались." },
      ];
      if (archive?.projectType === "android" || archive?.projectType === "expo") return [
        { id: "project-analyze", label: "Проверить файлы проекта", prompt: "Анализируй только содержимое извлечённых безопасных текстовых файлов и список ключевых записей. Не выполняй скрипты/сборку и не считай отсутствующие файлы прочитанными." },
        { id: "project-errors", label: "Искать ошибки", prompt: "Ищи ошибки только в реально переданном тексте файлов и указывай имена файлов, если они представлены. Не выдумывай исходники, которых нет в данных." },
        { id: "project-security", label: "Оценить риски", prompt: "Проверь только извлечённый текст и метаданные архива. Ничего из архива не запускалось; не заявляй о runtime-проверке или готовности к сборке." },
        { id: "project-structure", label: "Структура", prompt: "Суммируй переданные ключевые записи и реально извлечённые файлы; обозначь ограничение по числу и объёму прочитанных текстовых файлов." },
      ];
      return [{ id: "file-analyze", label: "Извлечённый текст архива", prompt: "Анализируй только реальные безопасно извлечённые текстовые записи; если текстовые файлы не найдены или извлечение ограничено, прямо сообщи об этом." }];
    case "PDF": return [
      { id: "pdf-summary", label: "Суммировать текст PDF", prompt: "Суммируй только реально извлечённый цифровой текст PDF. Если передано сообщение об отсутствии текста, шифровании или лимите, не выдумывай содержание. OCR не выполняется." },
      { id: "pdf-detail", label: "Найти сведения", prompt: "Ищи сведения только в переданном извлечённом тексте PDF; укажи, если документ сканированный, зашифрованный или обрезан ограничением." },
      { id: "pdf-tables", label: "Разобрать таблицы", prompt: "Извлекай таблицы только из фактически переданного текста PDF и не утверждай, что координатная структура таблиц сохранена." },
    ];
    case "SPREADSHEET": return [
      { id: "sheet-analyze", label: "Проанализировать таблицу", prompt: "Анализируй только извлечённые CSV/TSV-строки или ячейки XLSX. Формулы не вычислялись; не утверждай, что не переданные листы прочитаны." },
      { id: "sheet-errors", label: "Искать аномалии", prompt: "Ищи аномалии только в реально переданных строках/ячейках и укажи ограничения количества извлечённых данных." },
      { id: "sheet-summary", label: "Сводка", prompt: "Сделай сводку по фактически переданным значениям CSV/TSV/XLSX; если таблица повреждена или текст не найден, сообщи об этом." },
      { id: "sheet-formulas", label: "Формулы", prompt: "Анализируй формулы только если их текст передан. Формулы не исполняются; cached values не являются повторно вычисленными результатами." },
    ];
    case "IMAGE": return [
      { id: "image-describe", label: "Описать", prompt: "Опиши изображение." },
      { id: "image-ocr", label: "Найти текст", prompt: "Извлеки видимый текст с изображения." },
      { id: "image-ui", label: "Проанализировать интерфейс", prompt: "Проанализируй изображение как UI screenshot." },
      { id: "image-bugs", label: "Найти визуальные ошибки", prompt: "Найди визуальные ошибки, проблемы компоновки, отступов и кнопок." },
    ];
    case "DOCUMENT": return [
      { id: "doc-summary", label: "Суммировать текст", prompt: "Суммируй только реально извлечённый текст документа. Для неподдерживаемого или сканированного файла не выдумывай содержание; OCR не выполняется." },
      { id: "doc-detail", label: "Найти сведения", prompt: "Укажи только данные, присутствующие в переданном тексте документа, и сообщи об ограничениях извлечения." },
      { id: "doc-translate", label: "Перевести текст", prompt: "Переводи только реально переданный текст документа; не добавляй отсутствующие разделы." },
    ];
    case "SOURCE_CODE": return [
      { id: "code-analyze", label: "Проанализировать код", prompt: "Проанализируй код и его архитектуру." },
      { id: "code-errors", label: "Найти ошибки", prompt: "Найди ошибки в коде с указанием файлов и строк, где возможно." },
      { id: "code-security", label: "Проверить безопасность", prompt: "Проверь код на типовые проблемы безопасности." },
    ];
    case "TEXT": case "JSON": case "XML": return [
      { id: "text-analyze", label: "Проанализировать", prompt: "Проанализируй файл." },
      { id: "text-errors", label: "Найти ошибки", prompt: "Найди ошибки или подозрительные места в файле." },
      { id: "text-structure", label: "Показать структуру", prompt: "Опиши структуру и ключевые части файла." },
    ];
    default: return [{ id: "file-analyze", label: "Проанализировать файл", prompt: "Проанализируй прикреплённый файл безопасно." }];
  }
}

export function isBroadAttachmentIntent(prompt: string): boolean {
  const p = prompt.trim().toLowerCase();
  return !p || /^(проанализируй|посмотри|что тут|проверь|разбери|analyze|inspect|review|check|what is this)[.!?\s]*$/i.test(p);
}

export async function inspectAttachmentLocally(attachment: ChatAttachment): Promise<FileAnalysisSession> {
  const cached = sessionCache.get(attachment.id);
  if (cached) {
    persistentLogger.add("debug", "FileIntake", "CACHE_HIT");
    return cached;
  }
  const started = Date.now();
  const ext = attachment.extension.toLowerCase();
  let size = attachment.sizeBytes || 0;
  let detectedType = detectAttachmentType(attachment.displayName, attachment.mimeType);
  const session: FileAnalysisSession = {
    attachmentId: attachment.id, filename: attachment.displayName, mime: attachment.mimeType, size, extension: ext,
    detectedType, textLike: TEXT_EXTS.test(ext) || detectedType === "TEXT" || detectedType === "SOURCE_CODE" || detectedType === "JSON" || detectedType === "XML",
    availableActions: [], analysisState: "READY", createdAt: Date.now(),
  };
  try {
    const file = new File(attachment.uri);
    size = typeof file.size === "number" && Number.isFinite(file.size) && file.size >= 0 ? file.size : size;
    session.size = size;
    const isArchiveCandidate = detectedType === "ARCHIVE" || ext === "apk" || ext === "aab" || ext === "zip";
    if (isArchiveCandidate && size > MAX_LOCAL_ARCHIVE_BYTES) throw new Error("archive exceeds 512 MB local-inspection limit");
    if (!isArchiveCandidate && size > MAX_LOCAL_NONARCHIVE_BYTES) throw new Error("file exceeds 100 MB local-inspection limit");
    let magicType: "PDF" | "IMAGE" | "ARCHIVE" | undefined;
    const prefix = new Uint8Array(await file.slice(0, 16).arrayBuffer());
    const ascii = (start: number, value: string) => value.split("").every((ch, i) => prefix[start + i] === ch.charCodeAt(0));
    magicType = ascii(0, "%PDF-") ? "PDF" :
      (prefix[0] === 0x89 && ascii(1, "PNG")) ? "IMAGE" :
      ascii(0, "GIF8") ? "IMAGE" :
      (prefix[0] === 0xff && prefix[1] === 0xd8 && prefix[2] === 0xff) ? "IMAGE" :
      (ascii(0, "RIFF") && ascii(8, "WEBP")) ? "IMAGE" :
      hasZipStartSignature(prefix) ? "ARCHIVE" : undefined;
    if (magicType && detectedType !== magicType && !(detectedType === "DOCUMENT" && magicType === "ARCHIVE") && !(detectedType === "SPREADSHEET" && magicType === "ARCHIVE")) {
      persistentLogger.add("warn", "FileIntake", `MAGIC_MISMATCH extensionType=${detectedType} magicType=${magicType}`);
      session.manifest = { ...(session.manifest || {}), magicType };
    } else {
      session.manifest = { ...(session.manifest || {}), magicType: magicType || "unknown" };
    }
    if (magicType === "ARCHIVE" && detectedType === "UNKNOWN") {
      detectedType = "ARCHIVE";
      session.detectedType = detectedType;
      session.textLike = false;
    }
    if (detectedType === "ARCHIVE" && magicType === "ARCHIVE") {
      const archiveFormat = ext === "apk" || /android.*package-archive/i.test(attachment.mimeType)
        ? "apk" : ext === "aab" ? "aab" : "zip";
      const source = fileZipSource(file, size || file.size || 0);
      session.archive = await inspectZip(source, archiveFormat);
      if (!session.archive.safe) session.analysisState = "ERROR";
      persistentLogger.add(session.archive.safe ? "info" : "error", "FileIntake", `ARCHIVE_INSPECT type=${detectedType} extension=${ext} entries=${session.archive.entryCount} extracted=${session.archive.totalUncompressedBytes} safe=${session.archive.safe} warningCount=${session.archive.warnings.length}`);
    }
    session.availableActions = actionsFor(detectedType, session.archive);
    persistentLogger.add("info", "FileIntake", `READY type=${detectedType} extension=${/^[a-z0-9]{1,10}$/i.test(ext) ? ext : "other"} size=${size} actions=${session.availableActions.map(a => a.id).join(",") || "none"} durationMs=${Date.now() - started}`);
    sessionCache.set(attachment.id, session);
    return session;
  } catch (e: unknown) {
    session.analysisState = "ERROR";
    session.error = e instanceof Error ? e.message : "local inspection failed";
    session.availableActions = [];
    persistentLogger.add("error", "FileIntake", `PRE_ANALYSIS_FAILED type=${detectedType} extension=${/^[a-z0-9]{1,10}$/i.test(ext) ? ext : "other"} size=${size}`);
    return session;
  }
}
