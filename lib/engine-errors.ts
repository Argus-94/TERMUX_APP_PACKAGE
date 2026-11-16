import type { TranslationKey } from "./i18n";

type TFunc = (key: TranslationKey, params?: Record<string, string | number>) => string;

/**
 * lib/local-model.ts и lib/online-model.ts — обычные TS-модули без доступа к
 * useLanguage(), поэтому вместо готового переведённого текста они бросают
 * короткие технические коды ("MODEL_NOT_DOWNLOADED", "NO_KEY",
 * "HTTP:404:...", и т.д.). Эта функция вызывается уже внутри React-хуков
 * (hooks/useLLM.ts, hooks/useAppSettings.ts), где useLanguage().t доступен,
 * и превращает код в текст на текущем языке интерфейса.
 *
 * Если код не распознан — значит, ошибка пришла напрямую из нативного слоя
 * (llama.rn, сеть, expo-file-system и т.п.) и уже содержит полезное
 * техническое сообщение; такие сообщения показываются как есть.
 */
export function translateEngineError(t: TFunc, message: string): string {
  if (message === "MODEL_NOT_DOWNLOADED") return t("errorModelNotDownloaded");
  if (message === "MODEL_NOT_LOADED") return t("errorOfflineNotLoaded");
  if (message === "VISION_NOT_READY") return t("errorVisionNotReady");
  if (message === "NO_KEY") return t("errorNoApiKey");
  if (message === "EMPTY") return t("errorEmptyResponse");
  if (message === "EMPTY_PROVIDER_RESPONSE") return t("errorEmptyResponse");
  if (message === "TIMEOUT") return t("providerCheckTimeout");
  if (message === "REQUEST_ERROR") return t("providerCheckRequestError");
  if (message.startsWith("STT_FAILED:")) return translateEngineError(t, message.slice("STT_FAILED:".length).trim());
  if (/^STT_AUTH_REJECTED\b/.test(message)) return t("apiKeyInvalid");
  if (/^STT_ACCESS_DENIED\b/.test(message)) return t("providerCheckAccessDenied");
  if (/^STT_RATE_LIMIT\b/.test(message)) return t("providerCheckRateLimited");
  if (/^STT_MODEL_OR_ENDPOINT_UNAVAILABLE\b/.test(message)) return t("providerCheckSttUnavailable");
  if (/^STT_UPSTREAM_ERROR\b/.test(message)) return t("providerCheckUpstreamError");
  if (/^STT_REQUEST_REJECTED\b/.test(message)) return t("providerCheckRequestError");
  if (/^STT_TIMEOUT\b/.test(message)) return t("providerCheckTimeout");
  if (/^STT_NETWORK_ERROR\b/.test(message)) return t("providerCheckNetworkError");
  if (/^STT_(?:READ_FAILED|EMPTY_FILE|EMPTY_TRANSCRIPT|FILE_TOO_LARGE|NO_URI|NO_BASE_URL|INSECURE_BASE|PROVIDER_NOT_CONFIGURED)\b/.test(message)) return t("providerCheckRequestError");

  if (message.startsWith("NETWORK:")) {
    if (/transport|network|fetch/i.test(message.slice("NETWORK:".length))) return t("providerCheckNetworkError");
    return t("errorNetworkTemplate", { message: message.slice("NETWORK:".length) });
  }

  if (message.startsWith("HTTP:")) {
    const rest = message.slice("HTTP:".length);
    const sepIdx = rest.indexOf(":");
    const status = sepIdx >= 0 ? rest.slice(0, sepIdx) : rest;
    const details = sepIdx >= 0 ? rest.slice(sepIdx + 1) : "";
    // Дневной лимит бесплатных запросов OpenRouter (общий на весь аккаунт,
    // не поломка конкретной модели) — показываем понятное сообщение вместо
    // сырого "OpenRouter вернул ошибку 429: Rate limit exceeded:
    // free-models-per-day...", которое выглядело как техническая поломка.
    if (status === "401") return t("apiKeyInvalid");
    if (status === "403") return t("providerCheckAccessDenied");
    if (status === "429" && /free-models-per-day|daily_free_quota/i.test(details)) return t("providerCheckDailyQuota");
    if (status === "429") return t("providerCheckRateLimited");
    if (status === "404") return t("providerCheckModelUnavailable");
    if (Number(status) >= 500 && Number(status) <= 599) return t("providerCheckUpstreamError");
    return t("errorHttpTemplate", { status, details });
  }

  return message;
}
