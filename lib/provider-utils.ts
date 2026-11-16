/**
 * Helpers for custom/online provider UX: rate-limit memory, image-model
 * detection, and user-facing error messages (402/429/5xx).
 */

/** Models that are almost certainly not chat/code agents. */
export function looksLikeImageModel(modelId: string): boolean {
  const id = (modelId || "").toLowerCase();
  return (
    /\b(sdxl|stable-diffusion|stable_diffusion|dall-e|dalle|flux|midjourney|image-gen|img2img|text2img|wai-nsfw|illustrious|pony[-_]?xl|realvis|juggernaut|nsfw[-_]?illustrious)\b/.test(
      id
    ) ||
    /\/(sd|sdxl|flux)[-_/]/.test(id) ||
    (id.includes("nsfw") && (id.includes("xl") || id.includes("sd")))
  );
}

export function looksLikeFreeTierModel(modelId: string): boolean {
  return /:free$/i.test(modelId || "");
}

/** Embedding / audio / moderation — not usable as chat agent. */
export function looksLikeNonChatModel(modelId: string): boolean {
  const id = (modelId || "").toLowerCase();
  if (!id.trim()) return false;
  if (looksLikeImageModel(id)) return true;
  return (
    /\b(embed|embedding|text-embedding|bge-|e5-|gte-|minilm|whisper|tts|speech|audio|moderation|rerank|classifier|vision-only)\b/.test(
      id
    ) ||
    /\/(embed|embedding|whisper|tts)\b/.test(id)
  );
}

/** Keep blocked-model diagnostics actionable when a persisted Model ID is empty. */
export function formatModelIdForLog(modelId: unknown): string {
  const id = String(modelId ?? "").trim();
  return id || "(empty)";
}

/**
 * Clear chat message when the selected model cannot be used in AI Builder.
 * Returns null if the model looks acceptable (or unknown — allow try).
 */
export function getUnsupportedModelChatMessage(
  modelId: string,
  lang: "ru" | "uk" | "en" = "ru"
): string | null {
  const id = (modelId || "").trim();
  if (!id) {
    return {
      ru: "❌ Модель не выбрана.\nОткройте Настройки → укажите Model ID текстовой chat/code-модели.",
      uk: "❌ Модель не вибрана.\nВідкрийте Налаштування → вкажіть Model ID текстової chat/code-моделі.",
      en: "❌ No model selected.\nOpen Settings and set a text chat/code Model ID.",
    }[lang];
  }
  if (looksLikeImageModel(id)) {
    return {
      ru:
        `❌ Эта модель не поддерживается в чате AI Builder.\n\n` +
        `Выбрано: «${id}»\n` +
        `Тип: генерация изображений (image / SDXL / NSFW), а не текстовый диалог.\n\n` +
        `Что сделать: Настройки → Custom / Online → выберите текстовую chat/code-модель ` +
        `(Qwen, Llama Instruct, Claude, GPT-compatible models) и повторите сообщение.`,
      uk:
        `❌ Ця модель не підтримується в чаті AI Builder.\n\n` +
        `Обрано: «${id}»\n` +
        `Тип: генерація зображень (image / SDXL / NSFW), а не текстовий діалог.\n\n` +
        `Що зробити: Налаштування → Custom / Online → текстова chat/code-модель ` +
        `(Qwen, Llama Instruct, Claude та інші text chat-моделі) і повторіть повідомлення.`,
      en:
        `❌ This model is not supported in AI Builder chat.\n\n` +
        `Selected: «${id}»\n` +
        `Type: image generation (SDXL / NSFW), not text chat.\n\n` +
        `Open Settings → pick a text chat/code model (Qwen, Llama Instruct, Claude, and other text chat models) and try again.`,
    }[lang];
  }
  if (looksLikeNonChatModel(id) && !looksLikeImageModel(id)) {
    return {
      ru:
        `❌ Эта модель не подходит для чата и агента Termux.\n\n` +
        `Выбрано: «${id}»\n` +
        `Нужна текстовая chat/completions-модель, а не embedding / audio / moderation.\n\n` +
        `Смените Model ID в Настройках на обычную текстовую LLM.`,
      uk:
        `❌ Ця модель не підходить для чату та агента Termux.\n\n` +
        `Обрано: «${id}»\n` +
        `Потрібна текстова chat/completions-модель, не embedding / audio.\n\n` +
        `Змініть Model ID у Налаштуваннях.`,
      en:
        `❌ This model cannot be used for chat or the Termux agent.\n\n` +
        `Selected: «${id}»\n` +
        `Need a text chat/completions LLM, not embedding/audio.\n\n` +
        `Change Model ID in Settings.`,
    }[lang];
  }
  return null;
}

/** In-memory rate-limit lock per provider+model (survives within app session). */
const rateLimitUntil = new Map<string, number>();

function rateKey(baseUrl: string, modelId: string): string {
  return `${(baseUrl || "").replace(/\/+$/, "")}::${modelId || ""}`;
}

export function markProviderRateLimited(
  baseUrl: string,
  modelId: string,
  retryAfterSec?: number
): void {
  const sec = Math.min(
    Math.max(retryAfterSec ?? 3600, 30),
    24 * 3600
  );
  rateLimitUntil.set(rateKey(baseUrl, modelId), Date.now() + sec * 1000);
}

export function clearProviderRateLimit(baseUrl: string, modelId: string): void {
  rateLimitUntil.delete(rateKey(baseUrl, modelId));
}

export function getProviderRateLimitRemainingSec(
  baseUrl: string,
  modelId: string
): number {
  const until = rateLimitUntil.get(rateKey(baseUrl, modelId));
  if (!until) return 0;
  const left = Math.ceil((until - Date.now()) / 1000);
  if (left <= 0) {
    rateLimitUntil.delete(rateKey(baseUrl, modelId));
    return 0;
  }
  return left;
}

/** Parse "retry in 3499s" / "Retry-After" style hints from error text. */
export function parseRetryAfterSeconds(message: string): number | undefined {
  const m =
    message.match(/retry\s+in\s+(\d+)\s*s/i) ||
    message.match(/retry[_-]?after[=:\s]+(\d+)/i) ||
    message.match(/(\d+)\s*s(?:ec(?:onds)?)?\s*(?:remaining|left)/i);
  if (m) return Math.min(Number(m[1]), 24 * 3600);
  const min = message.match(/(\d+)\s*min/i);
  if (min && /60\s*min|every\s+\d+\s*min/i.test(message)) {
    return Math.min(Number(min[1]) * 60, 24 * 3600);
  }
  return undefined;
}

export function formatSecondsHuman(sec: number): string {
  if (sec < 60) return `${sec} с`;
  const m = Math.ceil(sec / 60);
  if (m < 60) return `${m} мин`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm ? `${h} ч ${rm} мин` : `${h} ч`;
}

/**
 * Turn raw engine errors into actionable Russian (or bilingual) user text.
 * Also updates rate-limit memory when 429 is detected.
 */
export function formatProviderUserError(
  raw: string,
  opts?: { baseUrl?: string; modelId?: string }
): string {
  const msg = raw || "unknown error";
  const lower = msg.toLowerCase();

  if (opts?.baseUrl && opts?.modelId && /(?:\b429\b|too many requests|rate.?limit)/i.test(msg)) {
    const retry = parseRetryAfterSeconds(msg) ?? 3600;
    markProviderRateLimited(opts.baseUrl, opts.modelId, retry);
  }

  if (/\b402\b|insufficient.*balance|wallet|top up|недостаточн/i.test(msg)) {
    return (
      "❌ Провайдер: недостаточно средств (HTTP 402).\n" +
      "Пополните баланс в кабинете API или смените ключ/провайдера.\n\n" +
      `Детали: ${msg.slice(0, 280)}`
    );
  }
  if (/\b401\b|unauthorized|invalid.*api.?key|incorrect api key/i.test(msg)) {
    return (
      "❌ Провайдер: неверный API-ключ (HTTP 401).\n" +
      "Проверьте ключ в настройках Custom / Online.\n\n" +
      `Детали: ${msg.slice(0, 280)}`
    );
  }
  if (/\b429\b|too many requests|rate.?limit/i.test(msg)) {
    const retry =
      (opts?.baseUrl && opts?.modelId
        ? getProviderRateLimitRemainingSec(opts.baseUrl, opts.modelId)
        : 0) ||
      parseRetryAfterSeconds(msg) ||
      3600;
    return (
      "❌ Лимит запросов к модели (HTTP 429).\n" +
      `Повторите через ~${formatSecondsHuman(retry)} или выберите другую текстовую модель / платный тариф.\n` +
      "Для агента Termux не используйте image/NSFW и free-модели с 1 запросом в час.\n\n" +
      `Детали: ${msg.slice(0, 280)}`
    );
  }
  if (/\b524\b|\b502\b|\b503\b|\b504\b|timeout occurred|cloudflare|gateway/i.test(msg)) {
    return (
      "❌ Провайдер временно недоступен (сеть / gateway timeout).\n" +
      "Подождите минуту и повторите или смените endpoint.\n\n" +
      `Детали: ${msg.slice(0, 280)}`
    );
  }
  if (looksLikeImageModel(opts?.modelId || "") || /image model|not a chat/i.test(lower)) {
    const mid = opts?.modelId || "?";
    return (
      `❌ Модель «${mid}» не поддерживается в AI Builder (image/NSFW, не текстовый чат).\n` +
      "Смените модель в Настройках на chat/code (Qwen, Llama Instruct и другие текстовые chat-модели).\n\n" +
      `Детали: ${msg.slice(0, 280)}`
    );
  }
  return `❌ Ошибка модели: ${msg.slice(0, 500)}`;
}

export function isProviderHardFailure(message: string): boolean {
  return /(?:\b402\b|\b401\b|\b429\b|\b524\b|\b502\b|\b503\b|\b504\b|insufficient|rate.?limit|too many requests|unauthorized|timeout occurred)/i.test(
    message
  );
}

/** Greeting / capability small-talk — no full Termux agent loop needed. */
export function isSmallTalkMessage(message: string): boolean {
  const t = message.trim().toLowerCase().replace(/[!?.…]+$/g, "");
  if (t.length > 160) return false;
  return /^(привет|здравствуй|здравствуйте|добрый\s+(день|вечер|утро)|доброго\s+(дня|вечора|ранку)|вітаю|привіт|hi|hello|hey|good\s+(morning|afternoon|evening)|що\s+вмієш|що\s+ти\s+вмієш|что\s+умеешь|что\s+умееш|кто\s+ты|хто\s+ти|who\s+are\s+you|what\s+can\s+you\s+do|help|помощь|допомога|що\s+ти|что\s+ты\s+такое|что\s+ты\s+умеешь|что\s+умеешь\s+делать|how\s+are\s+you|как\s+дела|як\s+справи)$/i.test(
    t
  );
}

/**
 * Plain chat — no Termux commands. Capabilities, explanations, lists, advice.
 * Used when Termux is ON so not every message becomes an agent loop.
 */
export function isChatOnlyMessage(message: string): boolean {
  const raw = String(message || "").trim();
  if (!raw || raw.length > 500) return false;
  const t = raw.toLowerCase().replace(/[!?.…]+$/g, "");

  // Explicit capability / help / what can you do
  if (
    /(что\s+умеешь|що\s+вмієш|what\s+can\s+you|capabilities|список\s+что|повний\s+список|полный\s+список|чем\s+можешь|що\s+можеш|help\s+me\s+understand)/i.test(t) ||
    /(напиши|скажи|опиши|перечисли|перелічи).{0,40}(умеешь|вмієш|можешь|можеш|функц|возможност|capabilities)/i.test(t) ||
    /^(кто\s+ты|what\s+are\s+you|расскажи\s+о\s+себе)/i.test(t)
  ) {
    return true;
  }

  // Explanation / how-to theory without disk verbs
  if (
    /^(объясни|поясни|що\s+таке|что\s+такое|как\s+работает|як\s+працює|what\s+is|how\s+does)/i.test(t) &&
    !/(собери|создай|установи|pkg\s|gradle|apk|файл\s+на\s+диск)/i.test(t)
  ) {
    return true;
  }

  // Disk/build/install / create-app action verbs → NOT chat-only
  const needsTermux =
    /(создай|создать|создадим|создайте|создал|создам|створи|собери|збери|assemble|gradlew|установи|встанови|pkg\s+install|перемест|скопир|распакуй|unzip|напиши\s+код|исправь\s+код|build\s+apk|compile|пересобери|rebuild)/i.test(
      t,
    ) ||
    /(добавь|додай|доработай|измени|поменяй|исправь).{0,50}(кнопк|экран|activity|логик|таймер|timer|mainactivity|в\s+приложен|в\s+проект)/i.test(
      t,
    ) ||
    // "напиши/сделай … [any app-like wish]" must go to agent (not only Hello World)
    /(напиши|сделай|зроби|make|create|scaffold|создай|создать|создадим|создайте|створи).{0,80}(приложен|додаток|apk|android|hello\s*world|калькул|игр[уаы]|game|todo|таймер|timer|заметк|трекер|tracker|счётчик|счетчик|counter|утилит|виджет|программ|на\s+android|под\s+android)/i.test(
      t,
    ) ||
    /\.(apk|zip)\b/i.test(t) ||
    /\/storage\/emulated\/0\//i.test(t) ||
    /\/sdcard\//i.test(t) ||
    /AIBuilderTermux/i.test(t) ||
    /(создай|создать|створи|запиши|сохрани|write|create).{0,80}(файл|file|\.txt|\.json|\.md)/i.test(t) ||
    /(в\s+папке|в\s+папку|in\s+(the\s+)?folder).{0,40}(Download|Downloads|Загрузки|Завантаження)/i.test(t) ||
    /(Download|Downloads|Загрузки)\/.{0,40}\.(txt|json|md|csv|log)/i.test(t);

  if (needsTermux) return false;

  // Short conversational requests without device paths
  if (t.length <= 200 && !/\/[\w.]+\//.test(t)) {
    // "напиши список...", "как лучше..." — chat; "напиши таймер/приложение" — agent
    if (
      /^(напиши|создай|создать|скажи|опиши|расскажи|поясни|объясни|перечисли|сравни|в\s+чём|чем\s+отличается)/i.test(t) ||
      /\?$/.test(raw.trim())
    ) {
      if (
        /(приложен|додаток|apk|android|hello\s*world|калькул|gradle|assemble|игр[уаы]|таймер|timer|заметк|трекер|tracker|счётчик|счетчик|утилит|виджет|программ|на\s+android)/i.test(
          t,
        )
      ) {
        return false;
      }
      // pure knowledge "напиши/создай список что умеешь" stays chat if no product words
      // but bare "создай" is already needsTermux above — leave meta chat to model-only path
      return true;
    }
  }
  return false;
}

/**
 * Info-only question about last result / APK path / status — answer from chat
 * history without starting a new Termux agent loop.
 */
export function isInfoOnlyQuery(message: string): boolean {
  const t = message.trim().toLowerCase().replace(/[!?.…]+$/g, "");
  if (!t || t.length > 280) return false;
  if (isChatOnlyMessage(message)) return true;
  // Explicit path / location questions
  if (
    /(путь|шлях|path|где|де|where|куда|куди).{0,40}(apk|апк|файл|file|сохранил|зберіг|saved|лежит|лежить)/i.test(t) ||
    /(apk|апк).{0,30}(путь|шлях|path|где|де|where)/i.test(t) ||
    /^(а\s+)?(напиши|скажи|покажи|укажи|назвы|tell|show|give).{0,20}(путь|шлях|path)/i.test(t)
  ) {
    return true;
  }
  // Status / what happened / last result without action verbs
  if (
    /^(что|що|what)\s+(произошло|сталося|happened|получилось|вийшло)/i.test(t) ||
    /^(статус|status|итог|підсумок|result)\b/i.test(t) ||
    /^(где|де|where)\s+(apk|апк|результат|result)/i.test(t)
  ) {
    return true;
  }
  // No create/build/install/run verbs → prefer chat answer
  const action = /(создай|створи|собери|збери|build|compile|install|установи|запусти|run|исправь|fix|напиши\s+код)/i.test(t);
  const question = /\?$|^(где|де|what|where|как|як|почему|чому|зачем|навіщо|сколько|скільки)/i.test(t);
  if (question && !action && t.length < 100) return true;
  return false;
}
