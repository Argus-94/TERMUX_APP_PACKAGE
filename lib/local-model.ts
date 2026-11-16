import { File, Directory, Paths } from "expo-file-system";
import * as FileSystemLegacy from "expo-file-system/legacy";
import { initLlama } from "llama.rn";
import type { AppLanguage } from "./i18n";
import { getTermuxNative } from "./termux-bridge";

// Тип контекста берём из возвращаемого значения initLlama, а не из
// отдельного экспорта типа — так меньше риск разъехаться с версией пакета.
type LlamaContext = Awaited<ReturnType<typeof initLlama>>;

/**
 * Единственная офлайн-модель приложения.
 *
 * Qwen2.5-3B-Instruct (GGUF Q4_K_M, ~1.93 GB) — текстовая модель под
 * mid-range Android (MT6789 / 8 GB): быстро на CPU, хватает для агента
 * (TERMUX_RUN, код, объяснения). Vision-mmproj отключён ради RAM/скорости.
 *
 * n_ctx/n_threads/n_gpu_layers — DEFAULT_LOCAL_PARAMS + device-profile.ts
 * (recommendModelSettings) / ручные Настройки.
 *
 * Смена модели: правьте только LOCAL_MODEL ниже.
 */
export const LOCAL_MODEL = {
  // Air1 Ultra / MT6789 / ~8GB: 3B Q4_K_M — баланс скорости и качества для агента.
  // Быстрее прежнего Qwen3-VL-4B (~2.5GB+mmproj), лучше держит инструктаж агента,
  // чем 1.5B. Vision отключён (mmproj=0) — экономия RAM и времени загрузки.
  id: "qwen25-3b-instruct-q4",
  name: "Qwen2.5 3B Instruct (Q4_K_M)",
  repo: "bartowski/Qwen2.5-3B-Instruct-GGUF",
  llmFileName: "Qwen2.5-3B-Instruct-Q4_K_M.gguf",
  llmUrl:
    "https://huggingface.co/bartowski/Qwen2.5-3B-Instruct-GGUF/resolve/main/Qwen2.5-3B-Instruct-Q4_K_M.gguf",
  llmBytes: 1_929_903_264,
  llmSha256: "9c9f56a391a3abbd5b89d0245bf6106081bcc3173119d4229235dd9d23253f94",
  // Текстовая модель — vision-модуль не нужен
  mmprojFileName: "",
  mmprojUrl: "",
  mmprojBytes: 0,
  mmprojSha256: "",
} as const;

/** Метаданные фактически активной модели на диске (в т.ч. импорт «любой GGUF»). */
export interface ActiveModelMeta {
  displayName: string;
  llmFileName: string;
  llmBytes: number;
  llmSha256?: string;
  mmprojFileName?: string;
  mmprojBytes?: number;
  source?: "catalog" | "import";
}

const ACTIVE_META_FILE = "active-model.json";

/**
 * Human-readable name + quant from a GGUF filename.
 * e.g. qwen2.5-coder-0.5b-instruct-q3_k_m.gguf → "Qwen2.5 Coder 0.5B Instruct (Q3_K_M)"
 */
export function parseGgufDisplayName(fileName: string): { displayName: string; quant?: string; paramsHint?: string } {
  let base = String(fileName || "").trim().replace(/\.gguf$/i, "");
  if (!base) return { displayName: "Imported GGUF" };
  // quant at end: Q4_K_M, q3_k_m, IQ4_XS, etc.
  let quant: string | undefined;
  const qMatch = base.match(/[-_.](iq\d+_\w+|q\d+_k_[sml]|q\d+_0|q\d+_1|f16|f32)$/i);
  if (qMatch) {
    quant = qMatch[1].toUpperCase().replace(/-/g, "_");
    base = base.slice(0, -qMatch[0].length);
  }
  // size hint 0.5b, 1.5b, 3b, 7b
  let paramsHint: string | undefined;
  const sMatch = base.match(/(\d+(?:\.\d+)?)\s*b\b/i);
  if (sMatch) paramsHint = `${sMatch[1]}B`;
  // prettify separators
  let pretty = base
    .replace(/[_]+/g, "-")
    .split("-")
    .filter(Boolean)
    .map((w) => {
      if (/^\d+(\.\d+)?b$/i.test(w)) return w.toUpperCase().replace("B", "B");
      if (/^(instruct|chat|coder|math|vl)$/i.test(w)) return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
      if (/^qwen/i.test(w)) return w.replace(/qwen/i, "Qwen");
      if (/^llama/i.test(w)) return w.replace(/llama/i, "Llama");
      return w.charAt(0).toUpperCase() + w.slice(1);
    })
    .join(" ");
  pretty = pretty.replace(/\s+/g, " ").trim();
  const displayName = quant ? `${pretty} (${quant})` : pretty;
  return { displayName, quant, paramsHint };
}

function fileNameFromUri(uri: string): string {
  try {
    const u = decodeURIComponent(String(uri || ""));
    const seg = u.split("/").pop() || "";
    return seg.split("?")[0] || "";
  } catch {
    return "";
  }
}

async function stagedFileHasGgufMagic(file: File): Promise<boolean> {
  try {
    const handle = file.open();
    try {
      const bytes = handle.readBytes(4);
      return !!bytes && bytes.length === 4 && bytes[0] === 0x47 && bytes[1] === 0x47 && bytes[2] === 0x55 && bytes[3] === 0x46;
    } finally {
      try { handle.close(); } catch { /* ignore */ }
    }
  } catch {
    return false;
  }
}


function getActiveMetaFile(): File {
  return new File(getModelsDir(), ACTIVE_META_FILE);
}

/** Читает override; null → используется LOCAL_MODEL из каталога. */
let cachedActiveMeta: ActiveModelMeta | null | undefined;

export function readActiveModelMeta(): ActiveModelMeta | null {
  if (cachedActiveMeta !== undefined) return cachedActiveMeta;
  try {
    const f = getActiveMetaFile();
    if (!f.exists) {
      cachedActiveMeta = null;
      return null;
    }
    // Sync read via legacy FS when possible
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const path = f.uri;
      const raw = typeof FileSystemLegacy.readAsStringAsync === "function"
        ? null
        : null;
      void raw;
      void path;
    } catch { /* ignore */ }
    const anyF = f as any;
    let text = "";
    if (typeof anyF.textSync === "function") text = String(anyF.textSync() || "");
    else if (typeof anyF.text === "function") {
      // cannot sync-wait; rely on cache filled by writeActiveModelMeta
      cachedActiveMeta = null;
      return null;
    }
    if (!text) {
      cachedActiveMeta = null;
      return null;
    }
    const j = JSON.parse(text) as ActiveModelMeta;
    if (!j?.llmFileName || !j?.llmBytes) {
      cachedActiveMeta = null;
      return null;
    }
    cachedActiveMeta = j;
    return j;
  } catch {
    cachedActiveMeta = null;
    return null;
  }
}

export async function writeActiveModelMeta(meta: ActiveModelMeta): Promise<void> {
  const target = getActiveMetaFile();
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const temp = new File(getModelsDir(), `${ACTIVE_META_FILE}.tmp-${suffix}`);
  const previous = new File(getModelsDir(), `${ACTIVE_META_FILE}.prev-${suffix}`);
  let previousMoved = false;
  try {
    await temp.write(JSON.stringify(meta));
    if (target.exists) {
      target.move(previous);
      previousMoved = true;
    }
    temp.move(target);
    cachedActiveMeta = meta;
    if (previousMoved && previous.exists) {
      try { previous.delete(); } catch { /* stale backup is safer than failing a committed write */ }
    }
  } catch (error) {
    try { if (temp.exists) temp.delete(); } catch { /* best effort */ }
    if (previousMoved && previous.exists) {
      try {
        if (target.exists) target.delete();
        previous.move(target);
      } catch (rollbackError) {
        const cause = error instanceof Error ? error.message : String(error);
        const rollback = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
        throw new Error(`ACTIVE_MODEL_META_WRITE_ROLLBACK_FAILED:${cause}:${rollback}`);
      }
    }
    throw error;
  }
}


export async function refreshActiveMetaFromDisk(): Promise<ActiveModelMeta | null> {
  try {
    const f = getActiveMetaFile();
    if (!f.exists) {
      cachedActiveMeta = null;
      return null;
    }
    const text = await FileSystemLegacy.readAsStringAsync(f.uri);
    const j = JSON.parse(String(text || "")) as ActiveModelMeta;
    if (!j?.llmFileName || !j?.llmBytes) {
      cachedActiveMeta = null;
      return null;
    }
    cachedActiveMeta = j;
    return j;
  } catch {
    cachedActiveMeta = null;
    return null;
  }
}

export function clearActiveModelMeta(): void {
  cachedActiveMeta = null;
  try {
    const f = getActiveMetaFile();
    if (f.exists) f.delete();
  } catch {
    /* ignore */
  }
}

/** Эффективные параметры LLM-файла (каталог или импорт). */
export function getEffectiveModel(): {
  displayName: string;
  llmFileName: string;
  llmBytes: number;
  llmSha256: string;
  mmprojFileName: string;
  mmprojBytes: number;
  mmprojSha256: string;
  source: "catalog" | "import";
} {
  const meta = readActiveModelMeta();
  if (meta) {
    return {
      displayName: meta.displayName || meta.llmFileName,
      llmFileName: meta.llmFileName,
      llmBytes: meta.llmBytes,
      llmSha256: meta.llmSha256 || "",
      mmprojFileName: meta.mmprojFileName || "",
      mmprojBytes: meta.mmprojBytes || 0,
      mmprojSha256: "",
      source: meta.source || "import",
    };
  }
  return {
    displayName: LOCAL_MODEL.name,
    llmFileName: LOCAL_MODEL.llmFileName,
    llmBytes: LOCAL_MODEL.llmBytes,
    llmSha256: LOCAL_MODEL.llmSha256,
    mmprojFileName: LOCAL_MODEL.mmprojFileName,
    mmprojBytes: LOCAL_MODEL.mmprojBytes,
    mmprojSha256: LOCAL_MODEL.mmprojSha256,
    source: "catalog",
  };
}

export type EngineStatus =
  | "idle"
  | "downloading"
  | "loading"
  | "ready"
  | "error";

export interface ChatTurn {
  role: "user" | "assistant" | "system";
  content: string;
}

/** Параметры инициализации контекста llama.rn — то, что настраивается один
 *  раз при загрузке модели в память (см. hooks/useAppSettings.ts). */
export interface LocalModelParams {
  nCtx: number;
  nThreads: number;
  nGpuLayers: number;
}

export const DEFAULT_LOCAL_PARAMS: LocalModelParams = {
  // MT6789: 2×A76 + 6×A55 → 4 потока оптимум (не 8)
  nCtx: 3072,       // агенту нужен запас под историю + TERMUX_RUN
  nThreads: 4,
  nGpuLayers: 0,    // Mali offline offload нестабилен — CPU only
};

/** Параметры генерации ответа — можно менять от запроса к запросу без
 *  перезагрузки модели. */
export interface GenerationParams {
  temperature: number;
  maxTokens: number; // n_predict
  topP: number;
}

export const DEFAULT_GENERATION_PARAMS: GenerationParams = {
  temperature: 0.3,  // ниже — стабильнее команды агента
  maxTokens: 1024,   // чуть больше для tool/agent ответов
  topP: 0.9,
};

const SYSTEM_PROMPTS: Record<AppLanguage, string> = {
  uk: "Ти — офлайн ШІ-асистент розробника всередині додатку AI Builder. " +
    "Ти працюєш повністю локально, без інтернету. Допомагай писати, пояснювати " +
    "і виправляти код будь-якими мовами (Java, Kotlin, XML, Smali, C/C++ тощо), " +
    "а також аналізуй надіслані зображення й скріншоти (наприклад, екрани " +
    "додатків, помилки, макети інтерфейсу). Оформляй код у блоках ``` із " +
    "зазначенням мови. Перед фінальною відповіддю самоперевіряй синтаксис, API та логіку; не заявляй про компіляцію або тести, якщо вони реально не виконувалися. Відповідай українською мовою, якщо користувач не попросив " +
    "інакше.",
  ru: "Ты — офлайн ИИ-ассистент разработчика внутри приложения AI Builder. " +
    "Ты работаешь полностью локально, без интернета. Помогай писать, объяснять " +
    "и исправлять код на любых языках (Java, Kotlin, XML, Smali, C/C++ и т.д.), " +
    "а также анализируй присылаемые изображения и скриншоты (например, экраны " +
    "приложений, ошибки, макеты интерфейса). Оформляй код в блоках ``` с " +
    "указанием языка. Перед финальным ответом самопроверяй синтаксис, API и логику; не утверждай, что код скомпилирован или протестирован, если это реально не выполнялось. Отвечай на русском языке, если пользователь не попросил " +
    "иначе.",
  en: "You are an offline AI developer assistant inside the AI Builder app. " +
    "You work fully locally, without internet access. Help write, explain, " +
    "and fix code in any language (Java, Kotlin, XML, Smali, C/C++, etc.), " +
    "and analyze any images and screenshots sent to you (e.g. app screens, " +
    "errors, UI mockups). Format code in ``` blocks with the language " +
    "specified. Before the final answer, self-review syntax, APIs, and logic; never claim compilation or tests unless they were actually run. Respond in English unless the user asked otherwise.",
};

// Глобальный системный промт (Настройки → "Системный промт") — тот же
// механизм, что и в lib/online-model.ts: если пользователь задал свой текст,
// он дописывается ПОСЛЕ встроенного промта модели, а не заменяет его.
function getSystemPrompt(lang: AppLanguage, customSystemPrompt?: string): string {
  const base = SYSTEM_PROMPTS[lang] || SYSTEM_PROMPTS.uk;
  const custom = (customSystemPrompt || "").trim();
  if (!custom) return base;
  // useLLM передаёт уже полный buildSystemPrompt (ядро IDE + tier + user).
  // Раньше мы дописывали ещё и локальный base → system раздувался до
  // десятков КБ и при n_ctx≈3k сразу получали "Context is full" даже на «Привет».
  if (custom.length >= 400) return custom;
  return `${base}\n\n${custom}`;
}

/** Грубая оценка токенов (смесь кириллицы/латиницы/кода). */
function estimateTokens(text: string): number {
  if (!text) return 0;
  // ~2.2 символа на токен для RU/UK + код; с запасом.
  return Math.ceil(text.length / 2.2);
}

/**
 * Ужимает system + историю так, чтобы prompt + n_predict влезли в n_ctx.
 * Без этого llama.rn отвечает "Context is full" на коротких репликах, если
 * system prompt (ядро IDE) сам по себе больше окна контекста.
 */
/**
 * llama.rn passes these messages through the model's Jinja chat template.
 * Some instruct templates (notably Gemma) reject adjacent turns with the
 * same role. Keep the engine boundary defensive because agent/recovery code
 * and persisted histories can originate outside the normal chat path.
 *
 * The first system message is preserved as the single system prompt. Any
 * additional system messages are folded into it, and adjacent user/assistant
 * turns are merged. This preserves all text while guaranteeing the role
 * sequence expected by strict templates.
 */
function normalizeChatHistory(history: ChatTurn[]): ChatTurn[] {
  const normalized: ChatTurn[] = [];
  for (const raw of history) {
    // system turns in history are folded by fitMessagesToContext into the
    // single leading system message — drop them here to avoid system/system.
    if (raw.role === "system") continue;
    const content = String(raw.content ?? "").trim();
    if (!content) continue;

    if (normalized.length === 0) {
      normalized.push({ role: raw.role, content });
      continue;
    }

    const previous = normalized[normalized.length - 1];
    if (previous.role === raw.role) {
      previous.content = `${previous.content}\n\n${content}`;
    } else {
      normalized.push({ role: raw.role, content });
    }
  }
  return normalized;
}

/**
 * Strict user/assistant alternation required by many Jinja chat templates
 * (Qwen, Gemma, Llama-3 instruct). After the leading system message the
 * first turn MUST be user. Leading assistant turns (welcome bubble) are
 * dropped; adjacent same-role turns are merged; trailing assistant is kept
 * only if a following user exists (completion always ends on user).
 */
function enforceRoleAlternation(
  messages: { role: "system" | "user" | "assistant"; content: string }[]
): { role: "system" | "user" | "assistant"; content: string }[] {
  if (messages.length === 0) return messages;
  const systemMsgs = messages.filter((m) => m.role === "system");
  const rest = messages.filter((m) => m.role !== "system");
  const sys =
    systemMsgs.length === 0
      ? null
      : {
          role: "system" as const,
          content: systemMsgs.map((m) => m.content).filter(Boolean).join("\n\n"),
        };

  const turns: { role: "user" | "assistant"; content: string }[] = [];
  for (const m of rest) {
    if (m.role !== "user" && m.role !== "assistant") continue;
    const content = (m.content || "").trim();
    if (!content) continue;
    if (turns.length === 0) {
      // First non-system must be user — skip leading assistant (welcome).
      if (m.role !== "user") continue;
      turns.push({ role: "user", content });
      continue;
    }
    const prev = turns[turns.length - 1];
    if (prev.role === m.role) {
      prev.content = `${prev.content}\n\n${content}`;
    } else {
      turns.push({ role: m.role, content });
    }
  }

  // Completion requires the last message to be user.
  while (turns.length > 0 && turns[turns.length - 1].role === "assistant") {
    turns.pop();
  }

  // If everything was assistant/empty, keep a minimal user turn so the
  // template does not fail hard — caller should still pass a real user msg.
  if (turns.length === 0) {
    turns.push({ role: "user", content: "." });
  }

  const out: { role: "system" | "user" | "assistant"; content: string }[] = [];
  if (sys && sys.content.trim()) out.push(sys);
  out.push(...turns);
  return out;
}

function fitMessagesToContext(
  system: string,
  history: ChatTurn[],
  nCtx: number,
  nPredict: number
): { role: "system" | "user" | "assistant"; content: string }[] {
  const reserve = Math.max(128, Math.min(nPredict, Math.floor(nCtx * 0.35)));
  const budget = Math.max(256, nCtx - reserve - 32);

  let sys = system;
  let sysTokens = estimateTokens(sys);
  // System не должен съедать больше ~55% бюджета.
  const sysCap = Math.floor(budget * 0.55);
  if (sysTokens > sysCap) {
    const maxChars = Math.max(400, Math.floor(sysCap * 2.2));
    sys =
      sys.slice(0, maxChars) +
      "\n\n[…system prompt truncated to fit model context…]";
    sysTokens = estimateTokens(sys);
  }

  const out: { role: "system" | "user" | "assistant"; content: string }[] = [
    { role: "system", content: sys },
  ];
  let used = sysTokens;
  const safeHistory = normalizeChatHistory(history);
  // История с конца (свежие сообщения важнее).
  const kept: ChatTurn[] = [];
  for (let i = safeHistory.length - 1; i >= 0; i--) {
    const turn = safeHistory[i];
    const t = estimateTokens(turn.content || "");
    if (used + t > budget) break;
    kept.push(turn);
    used += t;
  }
  kept.reverse();
  for (const turn of kept) {
    out.push({ role: turn.role, content: turn.content });
  }
  // Хотя бы последнее user-сообщение, даже если длинное — обрезаем.
  if (kept.length === 0 && safeHistory.length > 0) {
    const last = safeHistory[safeHistory.length - 1];
    const room = Math.max(200, (budget - used) * 2.2);
    const content =
      (last.content || "").length > room
        ? (last.content || "").slice(-Math.floor(room))
        : last.content || "";
    out.push({ role: last.role, content });
  }
  // Jinja templates (Qwen/Gemma/…) require strict alternation after system.
  return enforceRoleAlternation(out);
}

const STOP_WORDS = [
  "</s>",
  "<|end|>",
  "<|eot_id|>",
  "<|end_of_text|>",
  "<|im_end|>",
  "<|EOT|>",
  "<|END_OF_TURN_TOKEN|>",
  "<|end_of_turn|>",
  "<|endoftext|>",
];

function getModelsDir(): Directory {
  const dir = new Directory(Paths.document, "models");
  if (!dir.exists) {
    try {
      dir.create();
    } catch {
      // могла быть создана параллельным вызовом — не критично
    }
  }
  return dir;
}

function getLlmFile(): File {
  const name = getEffectiveModel().llmFileName || LOCAL_MODEL.llmFileName;
  return new File(getModelsDir(), name);
}

function getMmprojFile(): File {
  const eff = getEffectiveModel();
  const name = eff.mmprojFileName || LOCAL_MODEL.mmprojFileName || "mmproj.unused.gguf";
  return new File(getModelsDir(), name || "mmproj.unused.gguf");
}

export type DownloadProgress = {
  /** 0-100, объединённый прогресс по обоим файлам модели */
  percent: number;
  /** какой файл сейчас качается */
  stage: "llm" | "mmproj";
  /** сколько байт скачано ИМЕННО для текущего файла (stage) */
  bytesWritten: number;
  /** ожидаемый размер текущего файла (по заголовку сервера, либо оценка) */
  totalBytes: number;
  /** сколько байт скачано суммарно по обоим файлам с начала загрузки */
  bytesWrittenOverall: number;
  /** ожидаемый суммарный размер обоих файлов */
  totalBytesOverall: number;
  /** сглаженная скорость скачивания, байт/сек (0, если ещё не вычислена) */
  speedBytesPerSec: number;
};

class LocalModelEngine {
  private context: LlamaContext | null = null;
  private multimodalReady = false;
  private abortController: AbortController | null = null;
  private appliedParams: LocalModelParams | null = null;
  private lifecycleGeneration = 0;
  private loadTask: { params: LocalModelParams; promise: Promise<void> } | null = null;
  private unloadTask: Promise<void> | null = null;
  private unloading = false;
  private activeCompletions = 0;
  private completionDrainResolve: (() => void) | null = null;

  isDownloaded(): boolean {
    try {
      return this.validateDownloadedFiles().ok;
    } catch {
      return false;
    }
  }

  /** On-disk GGUF facts for auto parameter tuning. */
  getOnDiskModelInfo(): {
    fileName: string;
    fileBytes: number;
    hasMmproj: boolean;
    displayName?: string;
  } | null {
    try {
      const llm = getLlmFile();
      if (!llm.exists) return null;
      const fileBytes = Number(llm.size || 0);
      if (fileBytes < 1_000_000) return null;
      const mm = getMmprojFile();
      const hasMmproj = mm.exists && Number(mm.size || 0) > 500_000;
      const fileName = getEffectiveModel().llmFileName || llm.name || "model.gguf";
      const parsed = parseGgufDisplayName(fileName);
      return {
        fileName,
        fileBytes,
        hasMmproj,
        displayName: parsed.displayName,
      };
    } catch {
      return null;
    }
  }

  /** Быстрая синхронная проверка размера файлов. Полная проверка GGUF magic
   *  выполняется асинхронным validateDownloadedFilesAsync() перед native init.
   */
  validateDownloadedFiles(): { ok: boolean; llmBytes: number; mmprojBytes: number; reason?: string } {
    try {
      const llm = getLlmFile();
      const mmproj = getMmprojFile();
      const llmBytes = llm.exists ? Number(llm.size || 0) : 0;
      const mmprojBytes = mmproj.exists ? Number(mmproj.size || 0) : 0;
      // Размеры зафиксированы по опубликованным GGUF-артефактам (Content-Length HF).
      // Допуск ±4 KiB: на некоторых Android File.size после downloadFileAsync
      // может на мгновение отставать / округляться, а реальный файл уже полный.
      const SIZE_TOLERANCE = 4096;
      const eff = getEffectiveModel();
      // Импорт «любой GGUF»: достаточно существующего LLM-файла > 10 МБ
      const importMode = eff.source === "import";
      const llmOk = importMode
        ? llm.exists && llmBytes > 10_000_000
        : llm.exists &&
          llmBytes > 0 &&
          Math.abs(llmBytes - eff.llmBytes) <= SIZE_TOLERANCE;
      const mmOk =
        eff.mmprojBytes > 0 &&
        mmproj.exists &&
        mmprojBytes > 0 &&
        Math.abs(mmprojBytes - eff.mmprojBytes) <= SIZE_TOLERANCE;
      if (!llmOk) {
        return {
          ok: false,
          llmBytes,
          mmprojBytes,
          reason: `LLM_FILE_SIZE_MISMATCH(got=${llmBytes},exp=${eff.llmBytes})`,
        };
      }
      if (!mmOk && mmproj.exists && eff.mmprojBytes > 0) {
        return {
          ok: true,
          llmBytes,
          mmprojBytes,
          reason: `MMPROJ_OPTIONAL_SIZE_MISMATCH(got=${mmprojBytes},exp=${eff.mmprojBytes})`,
        };
      }
      return { ok: true, llmBytes, mmprojBytes };
    } catch {
      return { ok: false, llmBytes: 0, mmprojBytes: 0, reason: "MODEL_FILES_UNREADABLE" };
    }
  }

  /**
   * Полная перед загрузкой llama.rn проверка.
   * Критерий «модель готова»: точный (с допуском) размер обоих файлов.
   * GGUF-magic и SHA-256 — желательные, но НЕ блокирующие: на части устройств
   * File.open()/readBytes() и native sha256File бросают на файлах >2 ГБ,
   * из-за чего раньше всегда получали MODEL_INTEGRITY_CHECK_FAILED после
   * успешного скачивания.
   */
  async validateDownloadedFilesAsync(): Promise<{ ok: boolean; llmBytes: number; mmprojBytes: number; reason?: string }> {
    const basic = this.validateDownloadedFiles();
    if (!basic.ok) return basic;

    // --- GGUF magic (soft) ---
    const checkMagic = async (file: File): Promise<"ok" | "bad" | "skip"> => {
      try {
        const handle = file.open();
        try {
          const bytes = handle.readBytes(4);
          if (
            bytes &&
            bytes.length === 4 &&
            bytes[0] === 0x47 &&
            bytes[1] === 0x47 &&
            bytes[2] === 0x55 &&
            bytes[3] === 0x46
          ) {
            return "ok";
          }
          return "bad";
        } finally {
          try {
            handle.close();
          } catch {
            /* ignore */
          }
        }
      } catch {
        // File.open/readBytes throws on some Android builds for multi-GB files.
        return "skip";
      }
    };

    let magicReason = "";
    try {
      const llmMagic = await checkMagic(getLlmFile());
      if (llmMagic === "bad") {
        // Явно не GGUF (например, HTML-страница ошибки HF) — отклоняем.
        return { ...basic, ok: false, reason: "LLM_NOT_GGUF" };
      }
      if (llmMagic === "skip") magicReason = "MAGIC_SKIPPED";

      // mmproj необязателен. Проверяем его только если на диске действительно
      // лежит файл ожидаемого размера; случайный/старый файл не блокирует
      // текстовый режим LLM.
      const mmproj = getMmprojFile();
      const mmprojValid =
        mmproj.exists &&
        Math.abs(Number(mmproj.size || 0) - LOCAL_MODEL.mmprojBytes) <= 4096;
      if (mmprojValid) {
        const mmMagic = await checkMagic(mmproj);
        if (mmMagic === "bad") {
          return { ...basic, ok: true, reason: "MMPROJ_NOT_GGUF_OPTIONAL" };
        }
        if (mmMagic === "skip") magicReason = magicReason || "MAGIC_SKIPPED";
      }
    } catch {
      magicReason = "MAGIC_SKIPPED";
    }

    // --- SHA-256 (soft) ---
    const native = getTermuxNative();
    if (!native?.sha256File) {
      return {
        ...basic,
        ok: true,
        reason: magicReason || "MODEL_SHA256_UNAVAILABLE",
      };
    }
    try {
      const llmFile = getLlmFile();
      const mmprojFile = getMmprojFile();
      const llmHash = await native.sha256File(llmFile.uri);
      const effSha = getEffectiveModel();
      if (
        effSha.llmSha256 &&
        typeof llmHash === "string" &&
        llmHash.toLowerCase() !== effSha.llmSha256
      ) {
        return { ...basic, ok: true, reason: "LLM_SHA256_MISMATCH_SOFT" };
      }
      const mmprojValid =
        effSha.mmprojBytes > 0 &&
        mmprojFile.exists &&
        Math.abs(Number(mmprojFile.size || 0) - effSha.mmprojBytes) <= 4096;
      if (mmprojValid && LOCAL_MODEL.mmprojSha256) {
        const mmprojHash = await native.sha256File(mmprojFile.uri);
        if (typeof mmprojHash === "string" && mmprojHash.toLowerCase() !== LOCAL_MODEL.mmprojSha256) {
          return { ...basic, ok: true, reason: "MMPROJ_SHA256_MISMATCH_SOFT" };
        }
      }
      return { ...basic, ok: true, reason: magicReason || undefined };
    } catch {
      // Native SHA failed — size already OK → accept.
      return {
        ...basic,
        ok: true,
        reason: magicReason || "MODEL_SHA256_CHECK_SKIPPED",
      };
    }
  }

  isLoaded(): boolean {
    return this.context !== null;
  }

  /** Параметры (n_ctx/n_threads/n_gpu_layers), с которыми модель РЕАЛЬНО
   *  загружена в память сейчас (null, если не загружена). */
  getAppliedParams(): LocalModelParams | null {
    return this.appliedParams;
  }

  /**
   * Скачивает файл модели и файл vision-модуля (mmproj) в приватную папку
   * приложения (Paths.document/models). На Android 13+ для этого не нужно
   * никаких дополнительных разрешений — папка приватная для приложения.
   *
   * ВАЖНО (исправление индикатора прогресса): у File.downloadFileAsync
   * (expo-file-system 19.x, "next"-API) поле в onProgress называется
   * `bytesWritten`/`totalBytes`, а НЕ `totalBytesWritten`, как было раньше —
   * из-за опечатки в названии поля колбэк каждый раз получал `undefined`,
   * процент всегда оставался на 0% (или NaN) вплоть до самого конца
   * скачивания. Дополнительно теперь считаем реальную скорость (байт/сек) и
   * отдаём наружу как объём в байтах текущего файла, так и суммарный —
   * see DownloadProgress выше и app/settings.tsx (ProgressBar) для отображения.
   */
  async download(
    onProgress?: (p: DownloadProgress) => void,
    overrides?: { llmUrl?: string }
  ): Promise<void> {
    const llmUrl = (overrides?.llmUrl && overrides.llmUrl.trim()) || LOCAL_MODEL.llmUrl;

    this.abortController = new AbortController();
    const dir = getModelsDir();
    const totalBytesOverall = LOCAL_MODEL.llmBytes + LOCAL_MODEL.mmprojBytes;

    // Скользящее окно из нескольких последних замеров — чтобы скорость на
    // экране не "дёргалась" от каждого чуть более быстрого/медленного чанка.
    let lastTs = Date.now();
    let lastBytesOverall = 0;
    const speedSamples: number[] = [];
    const computeSpeed = (bytesWrittenOverall: number): number => {
      const now = Date.now();
      const dtSec = (now - lastTs) / 1000;
      if (dtSec <= 0) return speedSamples.length ? speedSamples[speedSamples.length - 1] : 0;
      const deltaBytes = bytesWrittenOverall - lastBytesOverall;
      lastTs = now;
      lastBytesOverall = bytesWrittenOverall;
      const instantSpeed = Math.max(0, deltaBytes / dtSec);
      speedSamples.push(instantSpeed);
      if (speedSamples.length > 6) speedSamples.shift();
      return speedSamples.reduce((a, b) => a + b, 0) / speedSamples.length;
    };

    // Нормализуем колбэк прогресса: разные версии expo-file-system отдают
    // либо { bytesWritten, totalBytes }, либо legacy { totalBytesWritten,
    // totalBytesExpectedToWrite }. Также запускаем polling размера файла —
    // если onProgress не вызывается (баг на некоторых устройствах), индикатор
    // всё равно обновляется по реальному размеру файла на диске.
    const normalizeProgress = (raw: any): { bytesWritten: number; totalBytes: number } => {
      if (!raw || typeof raw !== "object") return { bytesWritten: 0, totalBytes: 0 };
      const bytesWritten =
        typeof raw.bytesWritten === "number"
          ? raw.bytesWritten
          : typeof raw.totalBytesWritten === "number"
            ? raw.totalBytesWritten
            : 0;
      const totalBytes =
        typeof raw.totalBytes === "number"
          ? raw.totalBytes
          : typeof raw.totalBytesExpectedToWrite === "number"
            ? raw.totalBytesExpectedToWrite
            : 0;
      return { bytesWritten, totalBytes };
    };

    const pollFileSize = (
      file: File,
      stage: "llm" | "mmproj",
      baseBytes: number,
      expected: number
    ): ReturnType<typeof setInterval> => {
      return setInterval(() => {
        try {
          const size = file.exists ? (file.size ?? 0) : 0;
          if (size <= 0) return;
          const bytesWrittenOverall = baseBytes + size;
          const percent = Math.min(
            99,
            Math.round((bytesWrittenOverall / totalBytesOverall) * 100)
          );
          onProgress?.({
            percent,
            stage,
            bytesWritten: size,
            totalBytes: expected,
            bytesWrittenOverall,
            totalBytesOverall,
            speedBytesPerSec: computeSpeed(bytesWrittenOverall),
          });
        } catch {
          // ignore
        }
      }, 500);
    };

    const downloadOne = async (
      url: string,
      finalFile: File,
      stage: "llm" | "mmproj",
      expectedBytes: number,
      baseBytes: number
    ): Promise<void> => {
      if (finalFile.exists) {
        const finalSize = Number(finalFile.size || 0);
        if (Math.abs(finalSize - expectedBytes) <= 4096) {
          lastBytesOverall = baseBytes + expectedBytes;
          onProgress?.({
            percent: Math.round(((baseBytes + expectedBytes) / totalBytesOverall) * 100),
            stage,
            bytesWritten: expectedBytes,
            totalBytes: expectedBytes,
            bytesWrittenOverall: baseBytes + expectedBytes,
            totalBytesOverall,
            speedBytesPerSec: 0,
          });
          return;
        }
        try { finalFile.delete(); } catch { /* retry below will surface the real error */ }
      }

      // Скачиваем сначала во временный .part-файл и только после успешного
      // завершения переименовываем его в рабочее имя. Поэтому оборванная
      // сеть/убийство процесса больше никогда не оставит частичный GGUF под
      // настоящим именем модели.
      const partFile = new File(getModelsDir(), `${finalFile.name}.part`);
      try { if (partFile.exists) partFile.delete(); } catch { /* ignore */ }

      const runAttempt = async () => {
        const poll = pollFileSize(partFile, stage, baseBytes, expectedBytes);
        try {
          await File.downloadFileAsync(url, partFile, {
            idempotent: true,
            signal: this.abortController?.signal,
            headers: {
              Accept: "application/octet-stream",
              "Cache-Control": "no-cache",
            },
            onProgress: (raw: any) => {
              const progress = normalizeProgress(raw);
              const stageTotal = progress.totalBytes > 0 ? progress.totalBytes : expectedBytes;
              const bytesWrittenOverall = baseBytes + progress.bytesWritten;
              const percent = Math.min(99, Math.round((bytesWrittenOverall / totalBytesOverall) * 100));
              onProgress?.({
                percent,
                stage,
                bytesWritten: progress.bytesWritten,
                totalBytes: stageTotal,
                bytesWrittenOverall,
                totalBytesOverall,
                speedBytesPerSec: computeSpeed(bytesWrittenOverall),
              });
            },
          } as any);
        } finally {
          clearInterval(poll);
        }
        const size = partFile.exists ? Number(partFile.size || 0) : 0;
        if (Math.abs(size - expectedBytes) > 4096) {
          throw new Error(`MODEL_DOWNLOAD_SIZE_MISMATCH:${stage}:got=${size}:expected=${expectedBytes}`);
        }
      };

      let lastError: unknown = null;
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          await runAttempt();
          if (finalFile.exists) finalFile.delete();
          partFile.move(finalFile);
          return;
        } catch (err) {
          lastError = err;
          if (this.abortController?.signal.aborted || attempt === 2) break;
          try { if (partFile.exists) partFile.delete(); } catch { /* ignore */ }
          await new Promise((resolve) => setTimeout(resolve, 1200));
        }
      }
      try { if (partFile.exists) partFile.delete(); } catch { /* ignore */ }
      throw lastError instanceof Error ? lastError : new Error(String(lastError));
    };

    const llmFile = getLlmFile();
    await downloadOne(llmUrl, llmFile, "llm", LOCAL_MODEL.llmBytes, 0);

    if (LOCAL_MODEL.mmprojBytes > 0 && LOCAL_MODEL.mmprojUrl) {
      const mmprojFile = getMmprojFile();
      await downloadOne(LOCAL_MODEL.mmprojUrl, mmprojFile, "mmproj", LOCAL_MODEL.mmprojBytes, LOCAL_MODEL.llmBytes);
    }

    onProgress?.({
      percent: 100,
      stage: LOCAL_MODEL.mmprojBytes > 0 ? "mmproj" : "llm",
      bytesWritten: LOCAL_MODEL.mmprojBytes > 0 ? LOCAL_MODEL.mmprojBytes : LOCAL_MODEL.llmBytes,
      totalBytes: LOCAL_MODEL.mmprojBytes > 0 ? LOCAL_MODEL.mmprojBytes : LOCAL_MODEL.llmBytes,
      bytesWrittenOverall: totalBytesOverall,
      totalBytesOverall,
      speedBytesPerSec: 0,
    });
    this.abortController = null;

    // Даём ФС Android чуть времени зафиксировать size после downloadFileAsync
    // (на части устройств size обновляется с задержкой → ложный SIZE_MISMATCH).
    await new Promise((r) => setTimeout(r, 400));

    clearActiveModelMeta(); // каталожная загрузка сбрасывает import-meta
    const verified = await this.validateDownloadedFilesAsync();
    if (!verified.ok) {
      // Удаляем только явно неполные файлы (далеко от ожидаемого размера).
      // Soft-причины (MAGIC_SKIPPED / SHA soft) сюда уже не попадают — ok=true.
      const SIZE_TOLERANCE = 4096;
      try {
        const llm = getLlmFile();
        const sz = llm.exists ? Number(llm.size || 0) : 0;
        if (llm.exists && Math.abs(sz - LOCAL_MODEL.llmBytes) > SIZE_TOLERANCE) llm.delete();
      } catch {}
      try {
        const mm = getMmprojFile();
        const sz = mm.exists ? Number(mm.size || 0) : 0;
        if (mm.exists && Math.abs(sz - LOCAL_MODEL.mmprojBytes) > SIZE_TOLERANCE) mm.delete();
      } catch {}
      throw new Error(
        `MODEL_DOWNLOAD_INCOMPLETE:${verified.reason || "invalid_files"}` +
          ` llm=${verified.llmBytes} mmproj=${verified.mmprojBytes}`
      );
    }
  }

  cancelDownload(): void {
    this.abortController?.abort();
    this.abortController = null;
    // Удаляем то, что успело скачаться частично — иначе isDownloaded()
    // может увидеть "битый" недокачанный файл на следующем запуске.
    try {
      const llmFile = getLlmFile();
      if (llmFile.exists) llmFile.delete();
      const mmprojFile = getMmprojFile();
      if (mmprojFile.exists) mmprojFile.delete();
    } catch {
      // игнорируем — файла может не быть
    }
  }

  async deleteFiles(): Promise<void> {
    await this.unload();
    try {
      const llmFile = getLlmFile();
      if (llmFile.exists) llmFile.delete();
      const mmprojFile = getMmprojFile();
      if (mmprojFile.exists) mmprojFile.delete();
    } catch {
      // игнорируем
    }
    clearActiveModelMeta();
  }

  /**
   * Файлы уже скачанной модели для экспорта (Настройки → «Экспортировать
   * модель», см. app/settings.tsx). Возвращает null, если модели ещё нет
   * на диске — экспортировать нечего.
   */
  getExportFiles(): { llm: File; mmproj: File | null } | null {
    const llm = getLlmFile();
    if (!llm.exists) return null;
    // Экспорт второго файла (mmproj/vision) — если он реально есть на диске
    // (каталог или импорт «любой» модели). Раньше смотрели только LOCAL_MODEL.mmprojBytes,
    // из-за чего импортированный mmproj не отдавался.
    const eff = getEffectiveModel();
    const mmproj = getMmprojFile();
    const mm =
      mmproj.exists &&
      Number(mmproj.size || 0) > 0 &&
      (eff.mmprojBytes > 0 || Number(mmproj.size || 0) > 1_000_000)
        ? mmproj
        : null;
    return { llm, mmproj: mm };
  }

  /**
   * Импорт уже скачанных где-то файлов модели (бэкап, перенос с другого
   * устройства, ручная загрузка через браузер) — вместо повторного
   * скачивания ~3 ГБ по сети через «Скачать модель».
   *
   * Каждый выбранный пользователем файл сопоставляется с LLM- или
   * mmproj-частью по фактическому размеру содержимого; имя файла не учитывается.
   * Если Android File Provider не сообщает размер, он запрашивается через
   * нативный ContentResolver.
   * После потокового копирования итог всё равно проверяется по размеру, поэтому
   * случайный файл другой модели не принимается. Части можно импортировать по одной.
   */
  private async importOneFile(sourceUri: string, destination: File): Promise<void> {
    const native = getTermuxNative();
    if (native?.importModelFile && sourceUri.startsWith("content://")) {
      const ok = await native.importModelFile(sourceUri, destination.uri);
      if (!ok) throw new Error("MODEL_IMPORT_NATIVE_COPY_FAILED");
      return;
    }
    // Non-Android / file:// fallback. Kept for desktop/iOS and old providers.
    await FileSystemLegacy.copyAsync({ from: sourceUri, to: destination.uri });
  }

  private async stageModelImport(
    sourceUri: string,
    targetName: string,
    minBytes: number,
    tooSmallReason: string,
  ): Promise<{ file: File; bytes: number }> {
    const token = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const staged = new File(getModelsDir(), `.${targetName}.import-${token}.tmp`);
    try {
      await this.importOneFile(sourceUri, staged);
      const bytes = Number(staged.exists ? staged.size : 0) || 0;
      if (bytes < minBytes) throw new Error(tooSmallReason);
      if (bytes > 20 * 1024 * 1024 * 1024) throw new Error("MODEL_FILE_TOO_LARGE");
      if (!(await stagedFileHasGgufMagic(staged))) {
        throw new Error(targetName.toLowerCase().includes("mmproj") ? "MMPROJ_NOT_GGUF" : "LLM_NOT_GGUF");
      }
      return { file: staged, bytes };
    } catch (error) {
      try { if (staged.exists) staged.delete(); } catch { /* best effort */ }
      throw error;
    }
  }

  /** Move old bytes aside, then atomically rename the fully staged file into place. */
  private replaceStagedModel(staged: File, target: File): File | null {
    const token = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const backup = new File(getModelsDir(), `.${target.name}.previous-${token}`);
    let backupMoved = false;
    try {
      if (target.exists) {
        target.move(backup);
        backupMoved = true;
      }
      staged.move(target);
      return backupMoved ? backup : null;
    } catch (error) {
      if (backupMoved && backup.exists) {
        try {
          if (target.exists) target.delete();
          backup.move(target);
        } catch (rollbackError) {
          const cause = error instanceof Error ? error.message : String(error);
          const rollback = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
          throw new Error(`MODEL_IMPORT_FILE_ROLLBACK_FAILED:${cause}:${rollback}`);
        }
      }
      throw error;
    }
  }

  private rollbackReplacedModel(target: File, backup: File | null): void {
    if (target.exists) target.delete();
    if (backup?.exists) backup.move(target);
  }

  private discardModelBackup(backup: File | null): void {
    try { if (backup?.exists) backup.delete(); } catch { /* stale backup is safer than undoing a committed import */ }
  }

  /**
   * Явный импорт основного LLM GGUF (любая модель).
   * Размер/имя не сверяются с каталогом — файл принимается как LLM.
   */
  async importLlmFile(
    picked: { uri: string; size?: number | null; name?: string | null }
  ): Promise<{ ok: boolean; complete?: boolean; imported?: "llm"; reason?: string }> {
    let staged: File | null = null;
    try {
      const n0 = (picked.name || "").toLowerCase();
      if (n0 && /\.(zip|apk|aab|exe|js|ts|json|txt|pdf)$/i.test(n0)) {
        return { ok: false, reason: "LLM_NOT_GGUF" };
      }
      getModelsDir();
      const fromUri = fileNameFromUri(picked.uri);
      const pickedName = (picked.name || fromUri || "").trim();
      const safeBase = (pickedName || "imported-model.gguf")
        .replace(/[^a-zA-Z0-9._\-\u0400-\u04FF]+/g, "_")
        .replace(/_+/g, "_")
        .slice(0, 120);
      const finalLlmName = safeBase.toLowerCase().endsWith(".gguf") || safeBase.toLowerCase().endsWith(".ggml")
        ? safeBase
        : `${safeBase}.gguf`;
      if (!finalLlmName.toLowerCase().endsWith(".gguf") && !finalLlmName.toLowerCase().endsWith(".ggml")) {
        return { ok: false, reason: "LLM_NOT_GGUF" };
      }
      const prev = readActiveModelMeta();
      if (prev?.mmprojFileName === finalLlmName) return { ok: false, reason: "MODEL_IMPORT_FILENAME_COLLISION" };
      const stagedImport = await this.stageModelImport(picked.uri, finalLlmName, 1_000_000, "LLM_FILE_TOO_SMALL");
      staged = stagedImport.file;
      const finalFile = new File(getModelsDir(), finalLlmName);
      await this.unload();
      const backup = this.replaceStagedModel(staged, finalFile);
      staged = null;
      const parsed = parseGgufDisplayName(pickedName || finalLlmName);
      const display = parsed.displayName;
      try {
        await writeActiveModelMeta({
          displayName: display,
          llmFileName: finalLlmName,
          llmBytes: stagedImport.bytes,
          mmprojFileName: prev?.mmprojFileName,
          mmprojBytes: prev?.mmprojBytes,
          source: "import",
        });
      } catch (error) {
        this.rollbackReplacedModel(finalFile, backup);
        throw error;
      }
      this.discardModelBackup(backup);
      return { ok: true, complete: true, imported: "llm", reason: "MODEL_READY_TEXT_ONLY" };
    } catch (err) {
      try { if (staged?.exists) staged.delete(); } catch { /* best effort */ }
      return {
        ok: false,
        reason: `COPY_FAILED: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * Явный импорт второго файла (mmproj / vision / companion GGUF).
   * Любой выбранный файл принимается как companion к уже импортированной/скачанной LLM.
   * Совместимость с первой моделью — ответственность пользователя (обычно тот же семейный mmproj).
   */
  async importMmprojFile(
    picked: { uri: string; size?: number | null; name?: string | null }
  ): Promise<{ ok: boolean; complete?: boolean; imported?: "mmproj"; reason?: string }> {
    let staged: File | null = null;
    try {
      getModelsDir();
      const pickedName = (picked.name || "").trim();
      const safeBase = (pickedName || "mmproj.gguf")
        .replace(/[^a-zA-Z0-9._\-\u0400-\u04FF]+/g, "_")
        .replace(/_+/g, "_")
        .slice(0, 120);
      const finalName = safeBase.toLowerCase().endsWith(".gguf") || safeBase.toLowerCase().endsWith(".ggml")
        ? safeBase
        : `${safeBase}.gguf`;
      const prev = readActiveModelMeta();
      const activeLlmName = prev?.llmFileName || getLlmFile().name;
      if (activeLlmName === finalName) return { ok: false, reason: "MODEL_IMPORT_FILENAME_COLLISION" };
      const stagedImport = await this.stageModelImport(picked.uri, finalName, 100_000, "MMPROJ_FILE_TOO_SMALL");
      staged = stagedImport.file;
      const destNamed = new File(getModelsDir(), finalName);
      await this.unload();
      const backup = this.replaceStagedModel(staged, destNamed);
      staged = null;
      const eff = getEffectiveModel();
      const currentLlm = getLlmFile();
      try {
        await writeActiveModelMeta({
          displayName: prev?.displayName || eff.displayName,
          llmFileName: prev?.llmFileName || eff.llmFileName,
          llmBytes: prev?.llmBytes || (Number(currentLlm.size || 0) || eff.llmBytes),
          llmSha256: prev?.llmSha256,
          mmprojFileName: finalName,
          mmprojBytes: stagedImport.bytes,
          source: prev?.source || "import",
        });
      } catch (error) {
        this.rollbackReplacedModel(destNamed, backup);
        throw error;
      }
      this.discardModelBackup(backup);
      const llmOk = getLlmFile().exists && Number(getLlmFile().size || 0) > 10_000_000;
      return {
        ok: true,
        complete: llmOk,
        imported: "mmproj",
        reason: llmOk ? "MODEL_READY_MULTIMODAL" : "MMPROJ_IMPORTED_WAITING_FOR_LLM",
      };
    } catch (err) {
      try { if (staged?.exists) staged.delete(); } catch { /* best effort */ }
      return {
        ok: false,
        reason: `COPY_FAILED: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  async importFiles(
    picked: { uri: string; size?: number | null; name?: string | null }[]
  ): Promise<{ ok: boolean; complete?: boolean; imported?: "llm" | "mmproj" | "both"; reason?: string }> {
    let llmSrc: { uri: string } | null = null;
    let mmprojSrc: { uri: string } | null = null;

    const SIZE_TOLERANCE = 4096;
    // Имя файла НИКОГДА не используется для определения части модели.
    // Пользователь может переименовать GGUF как угодно, а Android DocumentProvider
    // может сам изменить имя при копировании (например, добавив " (1)").
    // Единственный надёжный идентификатор для этой фиксированной пары — размер
    // содержимого файла. Для content:// URI размер дополнительно запрашивается
    // нативно, если DocumentPicker его не вернул.
    const getSize = async (f: { uri: string; size?: number | null }): Promise<number | null> => {
      if (typeof f.size === "number" && Number.isFinite(f.size) && f.size > 0) return f.size;
      const native = getTermuxNative();
      if (native?.getContentUriSize && f.uri.startsWith("content://")) {
        try {
          const n = await native.getContentUriSize(f.uri);
          if (Number.isFinite(n) && n > 0) return n;
        } catch { /* fall through */ }
      }
      return null;
    };

    // 1) точное совпадение с каталожной моделью
    // 2) иначе — любой крупный .gguf / файл > 50 МБ как LLM
    for (const f of picked) {
      const size = await getSize(f);
      const name = (f.name || "").toLowerCase();
      const isGguf = name.endsWith(".gguf") || name.endsWith(".ggml");
      if (
        size !== null &&
        LOCAL_MODEL.mmprojBytes > 0 &&
        Math.abs(size - LOCAL_MODEL.mmprojBytes) <= SIZE_TOLERANCE
      ) {
        mmprojSrc = f;
      } else if (
        size !== null &&
        Math.abs(size - LOCAL_MODEL.llmBytes) <= SIZE_TOLERANCE
      ) {
        llmSrc = f;
      } else if (!llmSrc && size !== null && size > 50_000_000 && (isGguf || size > 100_000_000)) {
        llmSrc = f;
      } else if (!llmSrc && isGguf && size !== null && size > 10_000_000) {
        llmSrc = f;
      }
    }

    if (!llmSrc && !mmprojSrc) {
      return { ok: false, reason: "NO_MATCHING_FILES" };
    }

    let stagedLlm: { file: File; bytes: number } | null = null;
    let stagedMmproj: { file: File; bytes: number } | null = null;
    const replacements: Array<{ target: File; backup: File | null }> = [];
    try {
      getModelsDir();
      const pickedName = (llmSrc as { name?: string } | null)?.name || "";
      const safeBase = (pickedName || "imported-model.gguf")
        .replace(/[^a-zA-Z0-9._\-\u0400-\u04FF]+/g, "_")
        .replace(/_+/g, "_")
        .slice(0, 120);
      const finalLlmName = safeBase.toLowerCase().endsWith(".gguf") || safeBase.toLowerCase().endsWith(".ggml")
        ? safeBase
        : `${safeBase}.gguf`;
      const mmprojPickedName = (mmprojSrc as { name?: string } | null)?.name || "mmproj.gguf";
      const safeMmprojName = mmprojPickedName
        .replace(/[^a-zA-Z0-9._\-\u0400-\u04FF]+/g, "_")
        .replace(/_+/g, "_")
        .slice(0, 120);
      const finalMmprojName = safeMmprojName.toLowerCase().endsWith(".gguf") || safeMmprojName.toLowerCase().endsWith(".ggml")
        ? safeMmprojName
        : `${safeMmprojName}.gguf`;
      if (llmSrc && mmprojSrc && finalLlmName === finalMmprojName) throw new Error("MODEL_IMPORT_FILENAME_COLLISION");
      const currentLlmBeforeImport = getLlmFile();
      if (mmprojSrc && finalMmprojName === currentLlmBeforeImport.name && finalMmprojName !== finalLlmName) {
        throw new Error("MODEL_IMPORT_FILENAME_COLLISION");
      }

      // Copy and check every selected file before touching the currently active model files.
      if (llmSrc) stagedLlm = await this.stageModelImport(llmSrc.uri, finalLlmName, 10_000_000, "LLM_FILE_TOO_SMALL");
      if (mmprojSrc) stagedMmproj = await this.stageModelImport(mmprojSrc.uri, finalMmprojName, 100_000, "MMPROJ_FILE_TOO_SMALL");

      const previousMeta = readActiveModelMeta();
      const currentLlm = getLlmFile();
      const metadataBase: ActiveModelMeta = previousMeta ?? {
        displayName: LOCAL_MODEL.name,
        llmFileName: currentLlm.name || LOCAL_MODEL.llmFileName,
        llmBytes: Number(currentLlm.size || 0) || LOCAL_MODEL.llmBytes,
        source: currentLlm.exists ? "catalog" : "import",
      };
      const llmTarget = stagedLlm ? new File(getModelsDir(), finalLlmName) : null;
      const mmprojTarget = stagedMmproj ? new File(getModelsDir(), finalMmprojName) : null;
      await this.unload();

      try {
        if (stagedLlm && llmTarget) replacements.push({ target: llmTarget, backup: this.replaceStagedModel(stagedLlm.file, llmTarget) });
        if (stagedMmproj && mmprojTarget) replacements.push({ target: mmprojTarget, backup: this.replaceStagedModel(stagedMmproj.file, mmprojTarget) });
        const nextMeta: ActiveModelMeta = {
          ...metadataBase,
          ...(stagedLlm && llmTarget ? {
            displayName: parseGgufDisplayName(pickedName || finalLlmName).displayName,
            llmFileName: finalLlmName,
            llmBytes: stagedLlm.bytes,
            llmSha256: undefined,
            source: "import" as const,
          } : {}),
          ...(stagedMmproj && mmprojTarget ? {
            mmprojFileName: finalMmprojName,
            mmprojBytes: stagedMmproj.bytes,
          } : {}),
        };
        await writeActiveModelMeta(nextMeta);
      } catch (error) {
        const rollbackErrors: string[] = [];
        for (let i = replacements.length - 1; i >= 0; i--) {
          try { this.rollbackReplacedModel(replacements[i].target, replacements[i].backup); }
          catch (rollbackError) { rollbackErrors.push(rollbackError instanceof Error ? rollbackError.message : String(rollbackError)); }
        }
        if (rollbackErrors.length) throw new Error(`MODEL_IMPORT_BATCH_ROLLBACK_FAILED:${rollbackErrors.join(";")}`);
        throw error;
      }

      for (const replacement of replacements) this.discardModelBackup(replacement.backup);
      const effectiveLlm = getLlmFile();
      const llmOk = effectiveLlm.exists && Number(effectiveLlm.size || 0) > 10_000_000;
      const effectiveMmproj = getMmprojFile();
      const activeMetaAfterImport = readActiveModelMeta();
      const mmOk = Boolean(activeMetaAfterImport?.mmprojFileName) &&
        effectiveMmproj.exists && Number(effectiveMmproj.size || 0) > 100_000;
      if (!stagedLlm && !stagedMmproj) return { ok: false, reason: "NO_MATCHING_FILES" };
      return {
        ok: true,
        complete: llmOk,
        imported: stagedLlm && stagedMmproj ? "both" : stagedLlm ? "llm" : "mmproj",
        reason: llmOk ? (mmOk ? "MODEL_READY_MULTIMODAL" : "MODEL_READY_TEXT_ONLY") : "MMPROJ_IMPORTED_WAITING_FOR_LLM",
      };
    } catch (err) {
      return { ok: false, reason: `COPY_FAILED: ${err instanceof Error ? err.message : String(err)}` };
    } finally {
      try { if (stagedLlm?.file.exists) stagedLlm.file.delete(); } catch { /* best effort */ }
      try { if (stagedMmproj?.file.exists) stagedMmproj.file.delete(); } catch { /* best effort */ }
    }
  }

  /**
   * Загружает модель и vision-модуль в память (инициализирует контекст).
   * Если модель уже загружена С ТЕМИ ЖЕ параметрами — ничего не делает.
   * Если загружена, но параметры отличаются (пользователь поменял
   * контекст/потоки/GPU-слои в Настройках) — сначала выгружает старый
   * контекст и поднимает новый.
   */
  async load(params: LocalModelParams = DEFAULT_LOCAL_PARAMS): Promise<void> {
    if (this.unloadTask) {
      const waitingFor = this.unloadTask;
      await waitingFor.catch(() => undefined);
      return this.load(params);
    }
    if (this.loadTask) {
      const current = this.loadTask;
      const same = current.params.nCtx === params.nCtx && current.params.nThreads === params.nThreads && current.params.nGpuLayers === params.nGpuLayers;
      if (same) return current.promise;
      const generation = this.lifecycleGeneration;
      await current.promise.catch(() => undefined);
      if (generation !== this.lifecycleGeneration) return;
      return this.load(params);
    }
    if (this.context) {
      const p = this.appliedParams;
      const unchanged =
        p && p.nCtx === params.nCtx && p.nThreads === params.nThreads && p.nGpuLayers === params.nGpuLayers;
      if (unchanged) return;
      await this.unload();
    }
    const generation = ++this.lifecycleGeneration;
    const promise = this.loadInternal(params, generation);
    this.loadTask = { params, promise };
    try {
      await promise;
    } finally {
      if (this.loadTask?.promise === promise) this.loadTask = null;
    }
  }

  private async loadInternal(params: LocalModelParams, generation: number): Promise<void> {
    const files = await this.validateDownloadedFilesAsync();
    if (generation !== this.lifecycleGeneration) return;
    if (!files.ok) {
      throw new Error(`MODEL_NOT_DOWNLOADED:${files.reason || "invalid_files"}`);
    }

    const context = await initLlama({
      model: getLlmFile().uri,
      n_ctx: params.nCtx,
      n_threads: params.nThreads,
      n_gpu_layers: params.nGpuLayers,
      // Обязательно для мультимодальных моделей — не даёт контексту "сдвигать"
      // уже посчитанные токены изображения.
      ctx_shift: false,
    });

    if (generation !== this.lifecycleGeneration) {
      try { await context.release(); } catch { /* best effort release */ }
      return;
    }

    let multimodalOk = false;
    const mmprojFile = getMmprojFile();
    const mmprojBytes = mmprojFile.exists ? Number(mmprojFile.size || 0) : 0;
    const effLoad = getEffectiveModel();
    const mmprojValid =
      effLoad.mmprojBytes > 0 &&
      mmprojFile.exists &&
      mmprojBytes > 0 &&
      Math.abs(mmprojBytes - effLoad.mmprojBytes) <= 4096;
    if (mmprojValid) {
      try {
        multimodalOk = !!(await context.initMultimodal({
          path: mmprojFile.uri,
          use_gpu: params.nGpuLayers > 0,
        }));
      } catch {
        // Текстовый LLM остаётся пригодным даже если optional mmproj не
        // удалось инициализировать на конкретном Android/llama.rn.
        multimodalOk = false;
      }
    }

    if (generation !== this.lifecycleGeneration) {
      try { if (multimodalOk) await context.releaseMultimodal(); } catch { /* best effort release */ }
      try { await context.release(); } catch { /* best effort release */ }
      return;
    }
    this.context = context;
    this.multimodalReady = multimodalOk;
    this.appliedParams = params;
  }

  /** Реальный native smoke-test: модель должна быть загружена llama.rn и
   *  выполнить хотя бы один короткий completion. Это намеренно не имитирует
   *  inference и поэтому пригодно для Android E2E/диагностики. */
  async smokeTest(): Promise<{ ok: true; text: string; elapsedMs: number }> {
    const context = this.ensureReady();
    const started = Date.now();
    const result = await this.completionWithSignal(context, {
      messages: [
        { role: "system" as const, content: "Answer briefly." },
        { role: "user" as const, content: "Reply with exactly: AIB_LLAMA_OK" },
      ],
      n_predict: 16,
      temperature: 0,
      top_p: 1,
      stop: STOP_WORDS,
    });
    const text = String(result?.text || "").trim();
    if (!text) throw new Error("LLAMA_EMPTY_RESPONSE");
    return { ok: true, text, elapsedMs: Date.now() - started };
  }

  async unload(): Promise<void> {
    if (this.unloadTask) return this.unloadTask;
    this.unloading = true;
    this.lifecycleGeneration += 1;
    const pendingLoad = this.loadTask?.promise;
    const task = (async () => {
      if (pendingLoad) await pendingLoad.catch(() => undefined);
      const context = this.context;
      const multimodalReady = this.multimodalReady;
      if (!context) return;
      if (this.activeCompletions > 0) {
        try { await context.stopCompletion(); } catch { /* wait for native completion to settle */ }
        await this.waitForCompletions(30_000);
      }
      let multimodalError: unknown;
      let releaseError: unknown;
      if (multimodalReady) {
        try { await context.releaseMultimodal(); }
        catch (error) { multimodalError = error; }
      }
      try { await context.release(); }
      catch (error) { releaseError = error; }
      if (!releaseError) {
        this.context = null;
        this.multimodalReady = false;
        this.appliedParams = null;
      } else {
        this.context = context;
        this.multimodalReady = multimodalReady && !multimodalError;
      }
      if (multimodalError || releaseError) {
        const detail = [multimodalError, releaseError].filter(Boolean)
          .map((error) => error instanceof Error ? error.message : String(error)).join(";");
        throw new Error(`MODEL_UNLOAD_FAILED:${detail}`);
      }
    })();
    this.unloadTask = task;
    try { await task; } finally {
      if (this.unloadTask === task) this.unloadTask = null;
      this.unloading = false;
    }
  }

  private async waitForCompletions(timeoutMs: number): Promise<void> {
    if (this.activeCompletions === 0) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.completionDrainResolve === finish) this.completionDrainResolve = null;
        reject(new Error("MODEL_GENERATION_DRAIN_TIMEOUT"));
      }, timeoutMs);
      const finish = () => {
        clearTimeout(timer);
        if (this.completionDrainResolve === finish) this.completionDrainResolve = null;
        resolve();
      };
      this.completionDrainResolve = finish;
      if (this.activeCompletions === 0) finish();
    });
  }

  private ensureReady(): LlamaContext {
    if (this.unloading) throw new Error("MODEL_UNLOADING");
    if (!this.context) {
      throw new Error("MODEL_NOT_LOADED");
    }
    return this.context;
  }

  private async completionWithSignal(
    context: LlamaContext,
    params: Parameters<LlamaContext["completion"]>[0],
    signal?: AbortSignal,
  ): Promise<Awaited<ReturnType<LlamaContext["completion"]>>> {
    if (this.unloading) throw new Error("MODEL_UNLOADING");
    if (signal?.aborted) throw new Error("ABORTED");
    this.activeCompletions += 1;
    let released = false;
    const releaseLease = () => {
      if (released) return;
      released = true;
      this.activeCompletions = Math.max(0, this.activeCompletions - 1);
      if (this.activeCompletions === 0) this.completionDrainResolve?.();
    };
    let completion: Promise<Awaited<ReturnType<LlamaContext["completion"]>>>;
    try { completion = Promise.resolve(context.completion(params)); }
    catch (error) { releaseLease(); throw error; }
    void completion.then(releaseLease, releaseLease);
    if (!signal) return completion;
    let stopPromise: Promise<void> | null = null;
    let rejectAbort!: (reason: Error) => void;
    const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
    const onAbort = () => {
      if (stopPromise) return;
      const stopTask = context.stopCompletion().catch(() => {});
      stopPromise = stopTask;
      void stopTask.then(() => rejectAbort(new Error("ABORTED")));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    try {
      const result = await Promise.race([completion, aborted]);
      if (signal.aborted) {
        if (stopPromise) await stopPromise;
        throw new Error("ABORTED");
      }
      return result;
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  /** Обычный текстовый чат (например, вопросы про код). */
  async chat(
    history: ChatTurn[],
    gen: GenerationParams = DEFAULT_GENERATION_PARAMS,
    lang: AppLanguage = "uk",
    customSystemPrompt?: string,
    signal?: AbortSignal
  ): Promise<string> {
    const context = this.ensureReady();
    const nCtx = this.appliedParams?.nCtx ?? DEFAULT_LOCAL_PARAMS.nCtx;
    const nPredict = Math.min(gen.maxTokens, Math.max(128, Math.floor(nCtx * 0.4)));
    const system = getSystemPrompt(lang, customSystemPrompt);
    const messages = fitMessagesToContext(system, history, nCtx, nPredict);
    try {
      const result = await this.completionWithSignal(context, {
        messages,
        n_predict: nPredict,
        temperature: gen.temperature,
        top_p: gen.topP,
        stop: STOP_WORDS,
      }, signal);
      return (result.text || "").trim();
    } catch (err: unknown) {
      const raw = err instanceof Error ? err.message : String(err);
      if (/context is full/i.test(raw)) {
        const tightSys = system.length > 800 ? system.slice(0, 800) + "\n\n[…truncated for context…]" : system;
        const tightPredict = Math.min(256, nPredict);
        const messages2 = fitMessagesToContext(tightSys, history.slice(-2), nCtx, tightPredict);
        const result = await this.completionWithSignal(context, {
          messages: messages2, n_predict: tightPredict, temperature: gen.temperature, top_p: gen.topP, stop: STOP_WORDS,
        }, signal);
        return (result.text || "").trim();
      }
      throw err;
    }
  }

  /** Анализ изображения/скриншота с текстовым вопросом. */
  async analyzeImage(
    imageUri: string,
    prompt: string,
    gen: GenerationParams = DEFAULT_GENERATION_PARAMS,
    lang: AppLanguage = "uk",
    customSystemPrompt?: string,
    signal?: AbortSignal
  ): Promise<string> {
    const context = this.ensureReady();
    if (!this.multimodalReady) {
      throw new Error("VISION_NOT_READY");
    }
    const nCtx = this.appliedParams?.nCtx ?? DEFAULT_LOCAL_PARAMS.nCtx;
    const nPredict = Math.min(gen.maxTokens, Math.max(128, Math.floor(nCtx * 0.35)));
    let system = getSystemPrompt(lang, customSystemPrompt);
    const sysCap = Math.floor(nCtx * 0.4 * 2.2);
    if (system.length > sysCap) system = system.slice(0, sysCap) + "\n\n[…system truncated for vision context…]";
    const result = await this.completionWithSignal(context, {
      messages: [
        { role: "system" as const, content: system },
        {
          role: "user" as const,
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: imageUri } },
          ] as any,
        },
      ],
      n_predict: nPredict, temperature: gen.temperature, top_p: gen.topP, stop: STOP_WORDS,
    }, signal);
    return (result.text || "").trim();
  }

}

export const localModelEngine = new LocalModelEngine();
