import { errorMessage, errorName } from "./error-utils";
import { persistentLogger } from "./persistent-logger";
import { probeOpenRouterCredential, securedProviderFetch } from "../core/enhancements/auth/productionProviderTransport";
import { classifyProviderHttpStatus, classifyProviderProbeError, classifyProviderTransportFailure, providerKeyValidity, type ProviderProbeStatus } from "./provider-probe-status";
import { ProviderRequestTimeoutError, withProviderRequestControl } from "./provider-request-control";
/**
 * Онлайн-модель приложения — работает через OpenRouter (https://openrouter.ai).
 *
 * ВАЖНО (исправление ошибки "This model is unavailable for free"): раньше
 * здесь был захардкожен конкретный слаг meta-llama/llama-3.1-8b-instruct:free.
 * OpenRouter периодически снимает бесплатные модели с бесплатного тарифа или
 * полностью их выключает — именно это и произошло (см. ответ 404 от сервера).
 * Чтобы больше не чинить это вручную при каждой смене модели, используем
 * официальный бесплатный роутер OpenRouter "openrouter/free" — он сам
 * выбирает доступную бесплатную модель (включая модели с поддержкой
 * изображений, когда запрос их требует) и не имеет фиксированного слага,
 * который может устареть.
 */

export const ONLINE_MODEL = {
  id: "openrouter/free",
  name: "OpenRouter Free Router",
  provider: "OpenRouter",
  /** Условный размер контекстного окна роутера — используется только для
   *  подписи в интерфейсе (см. i18n-ключ "onlineModelContextLabel"). */
  contextLength: 200_000,
} as const;

/**
 * Список бесплатных моделей OpenRouter, доступных для ручного выбора в
 * Настройках → "Модели OpenRouter" (см. components/OpenRouterModelsDialog.tsx).
 * Первый пункт — тот же "auto"-роутер, что используется по умолчанию
 * (ONLINE_MODEL.id) — сам подбирает доступную бесплатную модель.
 *
 * ВАЖНО (v25, перепроверено по логу пользователя от 09.09.2026 и по
 * https://openrouter.ai/collections/free-models):
 *  - z-ai/glm-5.3-flash:free УДАЛЕНА — этого слага вообще нет в текущей
 *    коллекции бесплатных моделей OpenRouter, отсюда и HTTP 404 "This model
 *    is unavailable for free" в логе. Слаг был снят с бесплатного тарифа.
 *  - thinkingmachines/inkling:free и thinkingmachines/inkling-small:free
 *    УДАЛЕНЫ — формально числятся бесплатными в каталоге OpenRouter, но
 *    провайдер отдаёт их только зарегистрированным "агентным" приложениям
 *    (см. HTTP 403 "is only available on agentic harnesses" в логе);
 *    обычный чат-запрос из этого приложения принципиально не может
 *    получить ответ от этих моделей — это ограничение провайдера, а не
 *    ошибка кода, поэтому держать их в списке бессмысленно.
 *  - Добавлены модели, подтверждённо входящие в бесплатную коллекцию
 *    OpenRouter на сентябрь 2026 (обычные чат-модели, без ограничения
 *    "только агентные харнессы"): nvidia/nemotron-3-super-120b-a12b:free,
 *    nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free (с поддержкой
 *    изображений), poolside/laguna-xs-2.1:free, liquid/lfm-2.5-2.6b:free,
 *    nex-agi/nex-n2.5-mini:free — это расширяет пул кандидатов для
 *    автозамены (см. checkOpenRouterModels/recoverOnlineModel ниже), чтобы
 *    почти всегда был доступен хотя бы один рабочий вариант.
 *
 * OpenRouter регулярно меняет состав бесплатных моделей — если через
 * какое-то время какая-то из моделей ниже тоже перестанет отвечать, самый
 * надёжный вариант — оставить выбранным первый пункт ("openrouter/free"),
 * он не завязан на конкретный слаг и сам переключается на то, что доступно.
 * Актуальный список на будущее: https://openrouter.ai/collections/free-models
 */
export interface OpenRouterModelOption {
  id: string;
  name: string;
  vision: boolean;
  contextLength: number;
  /** Рекомендована для Termux-агента (code / tool-use). В UI — бейдж ★ */
  agentRecommended?: boolean;
  /** Подходит ли модель для полноценного диалога и разработки в чате AI Builder. */
  suitableForChat?: boolean;
  /** Причина, если модель не подходит или имеет существенные ограничения для чата. */
  unsuitableReason?: {
    uk: string;
    ru: string;
    en: string;
  };
}

/** Free OpenRouter. agentRecommended=true → бейдж ★ в списке моделей. */
export const FREE_OPENROUTER_MODELS: OpenRouterModelOption[] = [
  { id: "openrouter/free", name: "OpenRouter Free Router (auto)", vision: true, contextLength: 200_000, suitableForChat: true },
  { id: "cohere/north-mini-code:free", name: "Cohere North Mini Code", vision: false, contextLength: 256_000, agentRecommended: true, suitableForChat: true },
  { id: "nex-agi/nex-n2.5-mini:free", name: "Nex AGI N2.5 Mini", vision: false, contextLength: 262_144, agentRecommended: true, suitableForChat: true },
  { id: "poolside/laguna-s-2.1:free", name: "Poolside Laguna S 2.1", vision: false, contextLength: 262_144, agentRecommended: true, suitableForChat: true },
  { id: "poolside/laguna-xs-2.1:free", name: "Poolside Laguna XS 2.1", vision: false, contextLength: 262_144, agentRecommended: true, suitableForChat: true },
  { id: "nvidia/nemotron-3-super-120b-a12b:free", name: "NVIDIA Nemotron 3 Super", vision: false, contextLength: 262_144, suitableForChat: true },
  { id: "nvidia/nemotron-3.5-lightning:free", name: "NVIDIA Nemotron 3.5 Lightning", vision: false, contextLength: 1_000_000, suitableForChat: true },
  { id: "nvidia/nemotron-3-ultra-550b-a55b:free", name: "NVIDIA Nemotron 3 Ultra", vision: false, contextLength: 1_000_000, suitableForChat: true },
  { id: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free", name: "NVIDIA Nemotron 3 Nano Omni", vision: true, contextLength: 256_000, suitableForChat: true },
  {
    id: "liquid/lfm-2.5-2.6b:free",
    name: "Liquid LFM 2.5",
    vision: false,
    contextLength: 66_000,
    suitableForChat: false,
    unsuitableReason: {
      uk: "Малий контекст (66k), базова гібридна архітектура: не оптимізована для тривалого діалогу та команд розробки IDE.",
      ru: "Малый контекст (66k), базовая гибридная архитектура: не оптимизирована для длинного диалога и команд разработки IDE.",
      en: "Small context (66k), base hybrid model: not optimized for extended IDE multi-turn chat and dev commands.",
    },
  },
];

// Ключ по умолчанию — для работы "из коробки". При публикации замените на пустую строку.
// Никогда не хранить API-ключ в исходниках приложения: APK/IPA можно
// распаковать. Пользователь вводит ключ в настройках, где он сохраняется в
// SecureStore устройства. Старый ключ из предыдущей версии нужно отозвать в
// кабинете OpenRouter.
export const DEFAULT_OPENROUTER_API_KEY = "";


export interface ChatTurnOnline {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface OnlineGenerationParams {
  temperature: number;
  maxTokens: number;
  topP: number;
}

export const DEFAULT_ONLINE_PARAMS: OnlineGenerationParams = {
  temperature: 0.4,
  maxTokens: 1536,
  topP: 0.9,
};

// Системный промпт — по языку интерфейса приложения (см. hooks/useLLM.ts,
// который передаёт текущий useLanguage().language). Раньше был захардкожен
// по-русски (с опечаткой "Овечай" вместо "Отвечай") и не совпадал с
// выбранным языком интерфейса — именно на это жаловался пользователь.
const SYSTEM_PROMPTS: Record<"uk" | "ru" | "en", string> = {
  uk: "Ти — дружній мобільний ШІ-помічник у AI Builder. За замовчуванням веди звичайний діалог: " +
    "вітайся, відповідай тепло й по суті. Допомагай з кодом (Java, Kotlin, XML тощо) та зображеннями. " +
    "Код у блоках ``` з мовою. Не стверджуй про збірку/тести без реального запуску. " +
    "Режим агента (TERMUX_RUN) — лише якщо користувач просить дію на пристрої. Відповідай мовою користувача.",
  ru: "Ты — дружелюбный мобильный ИИ-помощник в AI Builder. По умолчанию веди обычный диалог: " +
    "здоровайся, отвечай тепло и по делу. Помогай с кодом (Java, Kotlin, XML и т.д.) и изображениями. " +
    "Код в блоках ``` с языком. Не утверждай про сборку/тесты без реального запуска. " +
    "Режим агента (TERMUX_RUN) — только если пользователь просит действие на устройстве. Отвечай на языке пользователя.",
  en: "You are a friendly mobile AI assistant in AI Builder. By default hold a normal conversation: " +
    "greet the user, answer warmly and clearly. Help with code (Java, Kotlin, XML, etc.) and images. " +
    "Code in ``` fences with a language tag. Never claim builds/tests unless they really ran. " +
    "Agent mode (TERMUX_RUN) only when the user asks for an on-device action. Reply in the user's language.",
};

// Глобальный системный промт (см. Настройки → "Системный промт") — задаётся
// пользователем один раз и применяется как к офлайн-, так и к онлайн-модели
// (см. lib/local-model.ts, где та же логика). Если задан — дописывается
// ПОСЛЕ встроенного промта, а не заменяет его, чтобы модель не теряла базовые
// инструкции (формат кода, разбор изображений и т.д.).
function getSystemPrompt(lang: "uk" | "ru" | "en", customSystemPrompt?: string): string {
  const base = SYSTEM_PROMPTS[lang] || SYSTEM_PROMPTS.uk;
  const custom = (customSystemPrompt || "").trim();
  if (!custom) return base;
  return `${base}\n\n${custom}`;
}

const OPENROUTER_ROUTE = { baseUrl: "https://openrouter.ai/api/v1" } as const;

function buildHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "HTTP-Referer": "https://github.com/ai-builder-app",
    "X-Title": "AI Builder",
  };
}

/**
 * Лёгкая проверка валидности OpenRouter API-ключа — без траты токенов и
 * без обращения к конкретной модели. Использует официальный эндпоинт
 * информации о ключе GET /api/v1/key (см. https://openrouter.ai/docs/api-reference/authentication),
 * который возвращает 200 с данными о ключе (лимиты/использование), если
 * ключ действителен, и 401 — если нет. Используется кнопкой "Проверить
 * ключ" в Настройках (см. app/settings.tsx).
 */
export interface ApiKeyCheckResult {
  valid: boolean | null;
  status: ProviderProbeStatus;
  retryAfterMs?: number | null;
}

export async function validateOpenRouterApiKey(
  transportOrCandidate: typeof securedProviderFetch | string = securedProviderFetch,
  timeoutMs = 12_000,
  signal?: AbortSignal,
): Promise<ApiKeyCheckResult> {
  const candidateKey = typeof transportOrCandidate === "string" ? transportOrCandidate.trim() : "";
  const transport = typeof transportOrCandidate === "function" ? transportOrCandidate : securedProviderFetch;
  try {
    const { response, details } = await withProviderRequestControl(async (signal) => {
      const response = candidateKey
        ? await probeOpenRouterCredential(candidateKey, signal)
        : await transport("openrouter", OPENROUTER_ROUTE, "key", { method: "GET", signal });
      // Keep body inspection inside the hard deadline too.
      const details = response.status === 429 ? await extractErrorMessage(response) : "";
      return { response, details };
    }, { timeoutMs: Math.max(1, timeoutMs), signal });
    const status = classifyProviderHttpStatus(response.status, "key", details);
    const retryAfterMs = parseRetryAfterMs(response);
    persistentLogger.add(status === "key_invalid" ? "warn" : status === "key_valid" ? "info" : "warn", "OpenRouter", `Key check -> ${status}${response.status ? ` HTTP ${response.status}` : ""}`);
    return { valid: providerKeyValidity(status), status, ...(retryAfterMs !== null ? { retryAfterMs } : {}) };
  } catch (err: unknown) {
    if (signal?.aborted) throw new Error("ABORTED");
    const status = classifyProviderTransportFailure(err instanceof ProviderRequestTimeoutError || errorName(err) === "AbortError");
    // Never persist transport exception text here; it can contain implementation
    // details and is not needed to distinguish offline from timeout.
    persistentLogger.add("warn", "OpenRouter", `Key check -> ${status} (no HTTP response)`);
    return { valid: null, status };
  }
}

async function extractErrorMessage(response: Response): Promise<string> {
  try {
    const data = await response.json();
    if (data?.error?.message) return String(data.error.message);
    return JSON.stringify(data);
  } catch {
    try {
      return await response.text();
    } catch {
      return response.statusText;
    }
  }
}

// Сообщения об ошибках ниже НЕ переведены на конкретный язык здесь —
// вместо готового русского текста бросаются короткие технические коды
// ("NO_KEY", "NETWORK:...", "HTTP:status:...", "EMPTY"). Экран/хук, который
// ловит ошибку (hooks/useLLM.ts), расшифровывает код через
// useLanguage().t(...) — так текст ошибки всегда соответствует текущему
// языку интерфейса, а не языку, который был захардкожен в момент написания
// этого файла (это и была причина "смешения языков" в интерфейсе).
function extractMessageText(data: any): string | null {
  const message = data?.choices?.[0]?.message;
  if (message) {
    const content = message?.content;
    if (typeof content === "string" && content.trim()) return content.trim();
    // Reasoning-модели часто отдают текст в reasoning / reasoning_content
    const reasoning = message?.reasoning ?? message?.reasoning_content;
    if (typeof reasoning === "string" && reasoning.trim()) return reasoning.trim();
    // Иногда content — массив частей (multimodal style)
    if (Array.isArray(content)) {
      const joined = content
        .map((p: any) => (typeof p === "string" ? p : p?.text || ""))
        .join("")
        .trim();
      if (joined) return joined;
    }
  }
  if (typeof data?.choices?.[0]?.text === "string" && data.choices[0].text.trim()) {
    return data.choices[0].text.trim();
  }
  return null;
}

async function callOpenRouterOnce(body: Record<string, unknown>, signal?: AbortSignal, transport: typeof securedProviderFetch = securedProviderFetch): Promise<string> {
  const t0 = Date.now();
  const model = typeof body.model === "string" ? body.model : "?";
  persistentLogger.add(
    "debug",
    "OpenRouter",
    `→ POST chat/completions model=${model} msgs=${Array.isArray(body.messages) ? body.messages.length : "?"}`
  );
  persistentLogger.markModelRequest(
    "OpenRouter",
    model,
    Array.isArray(body.messages) ? body.messages as Array<{ role?: string; content?: unknown }> : undefined,
    (() => { try { return JSON.stringify(body).length; } catch { return 0; } })(),
    "chat"
  );
  let response: Response;
  let responseData: any;
  let errorDetails = "";
  try {
    const result = await withProviderRequestControl(async (requestSignal) => {
      const response = await transport("openrouter", OPENROUTER_ROUTE, "chat/completions", {
        method: "POST",
        headers: buildHeaders(),
        body: JSON.stringify(body),
        signal: requestSignal,
      }, { model });
      if (!response.ok) {
        return { response, data: null, details: response.status === 429 ? await extractErrorMessage(response) : "" };
      }
      return { response, data: await response.json(), details: "" };
    }, { timeoutMs: 90_000, signal });
    response = result.response;
    responseData = result.data;
    errorDetails = result.details;
  } catch (err: unknown) {
    if (signal?.aborted) throw new Error("ABORTED");
    if (err instanceof ProviderRequestTimeoutError || classifyProviderProbeError(err, "request") === "timeout") {
      persistentLogger.add("warn", "OpenRouter", "TIMEOUT waiting for secured provider response");
      throw new Error("TIMEOUT");
    }
    persistentLogger.add("error", "OpenRouter", "NETWORK transport failure");
    throw new Error("NETWORK:transport");
  }

  const ms = Date.now() - t0;
  if (!response.ok) {
    const dailyQuota = response.status === 429 && isDailyFreeLimitError(errorDetails);
    persistentLogger.add("warn", "OpenRouter", `← HTTP ${response.status} in ${ms}ms${dailyQuota ? " DAILY_FREE_QUOTA" : ""}`);
    const category = dailyQuota ? "DAILY_FREE_QUOTA"
      : response.status === 403 ? "MODEL_ACCESS_DENIED"
        : response.status === 404 ? "MODEL_UNAVAILABLE"
          : response.status >= 500 ? "UPSTREAM_ERROR" : "REQUEST_REJECTED";
    throw new Error(`HTTP:${response.status}:${category}`);
  }

  const text = extractMessageText(responseData);
  persistentLogger.add(
    "debug",
    "OpenRouter",
    `← 200 in ${ms}ms, reply ${text ? text.length : 0} chars` + (text ? "" : " (EMPTY)"),
    "agent"
  );
  if (text) {
    persistentLogger.markModelResponse("OpenRouter", String(body?.model || "?"), text, ms);
  }
  if (!text) {
    throw new Error("EMPTY");
  }
  return text;
}

async function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return sleep(ms);
  if (signal.aborted) throw new Error("ABORTED");
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => { clearTimeout(timer); reject(new Error("ABORTED")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function callOpenRouter(body: Record<string, unknown>, signal?: AbortSignal, transport: typeof securedProviderFetch = securedProviderFetch): Promise<string> {
  // Free-модели часто отдают 429 "Provider returned error" — retry с backoff.
  const maxAttempts = 2;
  let lastErr: any;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (signal?.aborted) throw new Error("ABORTED");
    try {
      return await callOpenRouterOnce(body, signal, transport);
    } catch (err: unknown) {
      lastErr = err;
      const msg = errorMessage(err);
      // Дневной лимит free — retry бесполезен
      if (/free-models-per-day|1000 free model requests|HTTP:429:DAILY_FREE_QUOTA/i.test(msg)) {
        throw err;
      }
      // Если модель недоступна (404/403) и выбрана конкретная модель (не auto-router),
      // автоматически переключаемся на ONLINE_MODEL.id (openrouter/free)
      if (
        (/HTTP:404/.test(msg) || /HTTP:403/.test(msg)) &&
        typeof body.model === "string" &&
        body.model !== ONLINE_MODEL.id
      ) {
        persistentLogger.add(
          "warn",
          "OpenRouter",
          `Model ${body.model} returned ${msg.slice(0, 80)}. Auto-failing over to ${ONLINE_MODEL.id}`
        );
        body = { ...body, model: ONLINE_MODEL.id };
        continue;
      }
      const retriable =
        /HTTP:429/.test(msg) ||
        /HTTP:503/.test(msg) ||
        msg === "EMPTY" ||
        msg.startsWith("NETWORK:");
      if (retriable && attempt < maxAttempts - 1) {
        const delay = /HTTP:429|HTTP:503/.test(msg)
          ? 1500 * (attempt + 1) * (attempt + 1)
          : 800;
        persistentLogger.add(
          "warn",
          "OpenRouter",
          `retry ${attempt + 1}/${maxAttempts - 1} after ${delay}ms (${msg.slice(0, 100)})`
        );
        await abortableDelay(delay, signal);
        continue;
      }
      // После единственной автоматической retry попытки останавливаем workflow.
      // Никаких каскадных fallback-запросов после 429/503/network/empty.
      throw err;
    }
  }
  throw lastErr;
}

// ─────────────────────────────────────────────────────────────────────────
// Проверка работоспособности моделей OpenRouter (Настройки → "Модели
// OpenRouter" → кнопка "Проверить модели", а также автопроверка при
// запуске — см. hooks/useAppSettings.ts).
//
// ПРИЧИНА: список FREE_OPENROUTER_MODELS выше — это слаги, которые
// подтверждённо были бесплатны на момент написания кода, но OpenRouter
// регулярно меняет состав бесплатных моделей и условия доступа к ним (см.
// лог пользователя: несколько моделей отвечали 403 "is only available on
// agentic harnesses" вместо ответа в обычном чате). Простой запрос списка
// моделей (GET /models) НЕ показывает такие ограничения — модель может
// официально существовать и быть "бесплатной", но всё равно отказывать
// конкретно чат-запросам. Поэтому единственный надёжный способ понять,
// работает ли модель "прямо сейчас" — отправить ей реальный, но
// максимально дешёвый (max_tokens: 4) тестовый запрос и посмотреть на ответ.
// ─────────────────────────────────────────────────────────────────────────

// "limited" — новый статус (v25): дневной лимит бесплатных запросов
// OpenRouter исчерпан для ВСЕГО аккаунта (см. isDailyFreeLimitError ниже).
// Это отдельный статус, а НЕ "broken" — раньше эта ситуация ошибочно
// показывалась как "Не работает" для каждой модели по отдельности (именно
// это на скриншоте пользователя: 0 из 8 моделей "работает", хотя на самом
// деле ни одна модель не сломана — просто закончился общий дневной лимит).
export type OpenRouterModelStatus = "unknown" | "checking" | "working" | "broken" | "limited" | "rate_limited" | "unavailable" | "auth_error" | "access_denied" | "upstream_error" | "network_error" | "timeout";

/** Select a fallback only from this probe round; persisted/merged history must never drive auto-switching. */
export function selectOpenRouterFallbackModelId(
  currentId: string,
  roundStatus: Readonly<Record<string, OpenRouterModelStatus>>,
  orderedModels: readonly Pick<OpenRouterModelOption, "id">[],
): string | null {
  const currentStatus = roundStatus[currentId];
  if (currentStatus !== "broken" && currentStatus !== "unavailable") return null;
  return orderedModels.find((model) => roundStatus[model.id] === "working")?.id ?? null;
}

export interface OpenRouterModelCheckResult {
  id: string;
  status: Exclude<OpenRouterModelStatus, "unknown" | "checking">;
  error?: string;
}

const MODEL_CHECK_TIMEOUT_MS = 20_000;
// Бесплатные модели OpenRouter имеют жёсткий лимит запросов в минуту на
// ключ/модель. Раньше проверка била все модели практически одновременно
// (конкурентность 2, без пауз) — из-за этого OpenRouter отвечал 429 "Too
// Many Requests" на большинство моделей, и они помечались "Не работает",
// хотя на самом деле прекрасно отвечают при обычном одиночном запросе (это
// и есть причина ошибки со скриншота: "показывает не активна, а на самом
// деле работает"). Ниже — retry с задержкой именно на 429/503, отдельный
// статус-код в ошибке и пауза между запросами, чтобы не создавать новый
// всплеск лимита при повторной попытке.
const MODEL_CHECK_MAX_RETRIES = 2;
const MODEL_CHECK_RETRY_BASE_DELAY_MS = 3_000;
const MODEL_CHECK_STAGGER_DELAY_MS = 900;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error("ABORTED")); return; }
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(new Error("ABORTED"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// OpenRouter отдаёт бесплатным ("...:free") моделям ДВА разных вида 429:
//  1) обычный per-minute rate limit конкретного провайдера/модели —
//     временный, повторный запрос через несколько секунд обычно проходит;
//  2) общий дневной лимит запросов аккаунта ("Rate limit exceeded:
//     free-models-per-day. Add 10 credits to unlock 1000 free model
//     requests per day") — это лимит на ВЕСЬ аккаунт сразу на все
//     бесплатные модели одновременно, и он не снимется, если подождать
//     несколько секунд или переключиться на другую модель: сбрасывается
//     только раз в сутки (или увеличивается пополнением баланса).
// Раньше оба случая обрабатывались одинаково — ретраи, а затем статус
// "broken" на КАЖДУЮ модель по отдельности. Из-за этого при исчерпанном
// дневном лимите проверка показывала "0 из N моделей работает" (см.
// скриншот/лог пользователя), хотя ни одна модель на самом деле не
// сломана. Различаем эти случаи по тексту ошибки.
function isDailyFreeLimitError(details: string): boolean {
  return typeof details === "string" && details.toLowerCase().includes("free-models-per-day");
}

/** Достаёт задержку из заголовка Retry-After (секунды или HTTP-дата), либо null. */
function parseRetryAfterMs(response: Response): number | null {
  const header = response.headers?.get?.("retry-after");
  if (!header) return null;
  const seconds = Number(header);
  if (!Number.isNaN(seconds)) return Math.max(0, seconds * 1000);
  const dateMs = Date.parse(header);
  if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - Date.now());
  return null;
}

async function probeOpenRouterModel(
  modelId: string,
  attempt: number = 0,
  maxRetries: number = MODEL_CHECK_MAX_RETRIES,
  signal?: AbortSignal,
  transport: typeof securedProviderFetch = securedProviderFetch,
  requestTimeoutMs = MODEL_CHECK_TIMEOUT_MS,
): Promise<OpenRouterModelCheckResult> {
  if (signal?.aborted) throw new Error("ABORTED");
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort();
  signal?.addEventListener("abort", abortFromCaller, { once: true });
  let timedOut = false;
  const timeoutId = setTimeout(() => { timedOut = true; controller.abort(); }, requestTimeoutMs);
  try {
    const response = await withProviderRequestControl((requestSignal) => transport("openrouter", OPENROUTER_ROUTE, "chat/completions", {
      method: "POST",
      headers: buildHeaders(),
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: "user", content: "Reply with exactly: OK" }],
        // Дальше 8 токенов не хватало моделям с "рассуждением" (reasoning) —
        // они успевали потратить весь лимит на внутренние размышления и
        // возвращали пустой content, из-за чего рабочая модель ошибочно
        // помечалась как "Не работает". 32 токена даёт достаточно места и
        // на короткое рассуждение, и на сам ответ "OK".
        max_tokens: 32,
        temperature: 0,
      }),
      signal: requestSignal,
    }, { model: modelId }), { timeoutMs: requestTimeoutMs, signal: controller.signal });
    if (signal?.aborted) throw new Error("ABORTED");

    if (response.status === 429) {
      const details = await withProviderRequestControl(() => extractErrorMessage(response), {
        timeoutMs: requestTimeoutMs,
        signal: controller.signal,
      });
      if (isDailyFreeLimitError(details)) {
        // Общий дневной лимит — ждать и повторять здесь бессмысленно (см.
        // isDailyFreeLimitError выше), и это НЕ поломка именно этой модели.
        clearTimeout(timeoutId);
        return { id: modelId, status: "limited", error: "HTTP:429:DAILY_FREE_QUOTA" };
      }
      // Обычный per-minute rate limit — это НЕ признак того, что модель
      // сломана, это временное ограничение частоты запросов. Ждём и
      // пробуем ещё раз, прежде чем делать вывод о неработоспособности.
      if (attempt < maxRetries) {
        const retryAfter = parseRetryAfterMs(response);
        const delay = retryAfter ?? MODEL_CHECK_RETRY_BASE_DELAY_MS * (attempt + 1);
        clearTimeout(timeoutId);
        await sleep(delay, signal);
        return probeOpenRouterModel(modelId, attempt + 1, maxRetries, signal, transport, requestTimeoutMs);
      }
      return { id: modelId, status: "rate_limited", error: "HTTP:429:RETRY_AFTER_RATE_LIMIT" };
    }

    // 503 (сервис временно перегружен) — тоже не признак поломки модели.
    if (response.status === 503 && attempt < maxRetries) {
      const retryAfter = parseRetryAfterMs(response);
      const delay = retryAfter ?? MODEL_CHECK_RETRY_BASE_DELAY_MS * (attempt + 1);
      clearTimeout(timeoutId);
      await sleep(delay, signal);
      return probeOpenRouterModel(modelId, attempt + 1, maxRetries, signal, transport, requestTimeoutMs);
    }

    if (!response.ok) {
      const details = response.status === 429 ? await extractErrorMessage(response) : "";
      const outcome = classifyProviderHttpStatus(response.status, "model", details);
      if (outcome === "model_unavailable") return { id: modelId, status: "unavailable", error: "HTTP:404:MODEL_UNAVAILABLE" };
      if (outcome === "key_invalid") return { id: modelId, status: "auth_error", error: `HTTP:${response.status}:AUTH_REJECTED` };
      if (outcome === "access_denied") return { id: modelId, status: "access_denied", error: "HTTP:403:MODEL_ACCESS_DENIED" };
      if (outcome === "upstream_error") return { id: modelId, status: "upstream_error", error: `HTTP:${response.status}:UPSTREAM_ERROR` };
      if (outcome === "daily_quota") return { id: modelId, status: "limited", error: "HTTP:429:DAILY_FREE_QUOTA" };
      if (outcome === "rate_limited") return { id: modelId, status: "rate_limited", error: "HTTP:429:RETRY_AFTER_RATE_LIMIT" };
      return { id: modelId, status: "broken", error: `HTTP:${response.status}:REQUEST_REJECTED` };
    }

    const data = await withProviderRequestControl(() => response.json(), {
      timeoutMs: requestTimeoutMs,
      signal: controller.signal,
    });
    const message = data?.choices?.[0]?.message;
    const content = message?.content;
    // Некоторые бесплатные модели (в первую очередь "reasoning"-модели)
    // возвращают полезный текст не в content, а в reasoning/reasoning_content,
    // если основной ответ не успел сформироваться в пределах max_tokens.
    // Раньше проверялся только content — из-за этого рабочая модель
    // ошибочно считалась "пустым ответом" (EMPTY) и помечалась сломанной.
    const reasoning = message?.reasoning ?? message?.reasoning_content;
    const hasContent = typeof content === "string" && content.trim().length > 0;
    const hasReasoning = typeof reasoning === "string" && reasoning.trim().length > 0;
    // Если ответ пришёл без ошибки, но реального текста нет, а модель просто
    // упёрлась в лимит токенов на середине размышления (finish_reason ===
    // "length") — это тоже сигнал, что модель жива и отвечает, ей просто
    // нужно больше max_tokens в реальном чате (там по умолчанию 1536, а не 32).
    const ranOutOfBudget = data?.choices?.[0]?.finish_reason === "length";
    if (!hasContent && !hasReasoning && !ranOutOfBudget) {
      return { id: modelId, status: "broken", error: "EMPTY" };
    }
    return { id: modelId, status: "working" };
  } catch (err: unknown) {
    if (signal?.aborted) throw new Error("ABORTED");
    const isTimeout = timedOut || err instanceof ProviderRequestTimeoutError || errorName(err) === "AbortError";
    if (!isTimeout && attempt < maxRetries) {
      // Разрыв сети/таймаут соединения — тоже стоит попробовать ещё раз
      // перед тем как считать модель сломанной.
      await sleep(MODEL_CHECK_RETRY_BASE_DELAY_MS * (attempt + 1), signal);
      return probeOpenRouterModel(modelId, attempt + 1, maxRetries, signal, transport, requestTimeoutMs);
    }
    const transportStatus = classifyProviderTransportFailure(isTimeout);
    return { id: modelId, status: transportStatus === "timeout" ? "timeout" : "network_error", error: transportStatus === "timeout" ? "TIMEOUT" : "NETWORK_ERROR" };
  } finally {
    clearTimeout(timeoutId);
    signal?.removeEventListener("abort", abortFromCaller);
  }
}

/**
 * Проверяет все переданные модели и возвращает карту "id модели -> результат".
 * Auto-router тоже тестируется реальным запросом. Наличие самого слага в
 * GET /models не гарантирует доступность ответа для конкретного ключа.
 *
 * Запросы идут СТРОГО последовательно (с небольшой паузой между ними), а не
 * параллельно — параллельные запросы почти гарантированно ловят 429 от
 * бесплатного тарифа OpenRouter (лимит запросов в минуту общий на все
 * бесплатные модели), из-за чего почти весь список ошибочно помечался
 * "Не работает" сразу после нажатия "Проверить модели". Поштучная проверка
 * с задержкой чуть медленнее, но результат соответствует действительности.
 *
 * onProgress вызывается по мере готовности каждой модели — используется
 * UI-диалогом (OpenRouterModelsDialog), чтобы подсвечивать статусы по одной,
 * а не ждать полного завершения проверки всего списка.
 */
export interface CheckOpenRouterModelsOptions {
  /** Сколько раз повторить запрос при 429/503/сетевой ошибке перед тем как
   *  считать модель сломанной. По умолчанию MODEL_CHECK_MAX_RETRIES (2) —
   *  подходит для фоновой/ручной проверки в Настройках, где точность важнее
   *  скорости. Для аварийного переключения модели прямо во время чата
   *  (см. hooks/useLLM.ts → recoverOnlineModel) стоит передавать 0, чтобы не
   *  заставлять пользователя ждать ответа лишние секунды. */
  maxRetries?: number;
  /** Пауза между проверками моделей (мс), чтобы не залетать в общий
   *  rate-limit бесплатного тарифа OpenRouter. */
  staggerMs?: number;
  /** Abort an in-progress runtime recovery probe/retry when the owning task stops. */
  signal?: AbortSignal;
  /** Per-request deadline override; defaults to the production model-check timeout. */
  requestTimeoutMs?: number;
}

export async function checkOpenRouterModels(
  models: OpenRouterModelOption[],
  onProgress?: (result: OpenRouterModelCheckResult) => void,
  options?: CheckOpenRouterModelsOptions,
  transport: typeof securedProviderFetch = securedProviderFetch,
): Promise<Record<string, OpenRouterModelCheckResult>> {
  const results: Record<string, OpenRouterModelCheckResult> = {};
  const maxRetries = options?.maxRetries ?? MODEL_CHECK_MAX_RETRIES;
  const staggerMs = options?.staggerMs ?? MODEL_CHECK_STAGGER_DELAY_MS;
  const requestedTimeoutMs = options?.requestTimeoutMs;
  const requestTimeoutMs = Number.isFinite(requestedTimeoutMs) && (requestedTimeoutMs ?? 0) > 0
    ? requestedTimeoutMs as number
    : MODEL_CHECK_TIMEOUT_MS;

  for (let i = 0; i < models.length; i++) {
    if (options?.signal?.aborted) throw new Error("ABORTED");
    const model = models[i];
    const result = await probeOpenRouterModel(model.id, 0, maxRetries, options?.signal, transport, requestTimeoutMs);
    if (options?.signal?.aborted) throw new Error("ABORTED");
    results[model.id] = result;
    onProgress?.(result);

    if (result.status === "limited") {
      // Дневной лимит бесплатных запросов исчерпан для ВСЕГО аккаунта —
      // проверять остальные модели дальше бессмысленно (результат будет
      // тем же для любой из них) и только тратит время пользователя.
      // Модели, которые ещё не успели проверить в этом раунде, просто не
      // попадут в results — вызывающий код (см. hooks/useAppSettings.ts)
      // объединяет новый результат с уже известными статусами, а не
      // затирает их, так что их прежний статус не потеряется.
      break;
    }

    if (i < models.length - 1 && staggerMs > 0) {
      await sleep(staggerMs, options?.signal);
    }
  }

  return results;
}

export class OnlineModelEngine {
  constructor(private readonly transport: typeof securedProviderFetch = securedProviderFetch) {}

  async chat(
    history: ChatTurnOnline[],
    gen: OnlineGenerationParams = DEFAULT_ONLINE_PARAMS,
    lang: "uk" | "ru" | "en" = "uk",
    customSystemPrompt?: string,
    modelId: string = ONLINE_MODEL.id,
    signal?: AbortSignal
  ): Promise<string> {
    return callOpenRouter(
      {
        model: modelId,
        messages: [{ role: "system", content: getSystemPrompt(lang, customSystemPrompt) }, ...history],
        temperature: gen.temperature,
        max_tokens: gen.maxTokens,
        top_p: gen.topP,
      },
      signal,
      this.transport,
    );
  }

  async analyzeImage(
    imageDataUrl: string,
    prompt: string,
    gen: OnlineGenerationParams = DEFAULT_ONLINE_PARAMS,
    lang: "uk" | "ru" | "en" = "uk",
    customSystemPrompt?: string,
    modelId: string = ONLINE_MODEL.id,
    signal?: AbortSignal
  ): Promise<string> {
    return callOpenRouter(
      {
        model: modelId,
        messages: [
          { role: "system", content: getSystemPrompt(lang, customSystemPrompt) },
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              { type: "image_url", image_url: { url: imageDataUrl } },
            ],
          },
        ],
        temperature: gen.temperature,
        max_tokens: gen.maxTokens,
        top_p: gen.topP,
      },
      signal,
      this.transport,
    );
  }
}

export const onlineModelEngine = new OnlineModelEngine();
