/**
 * Расшифровка аудио (STT) через OpenAI-compatible POST /audio/transcriptions.
 * Работает с OpenAI, Groq, OpenRouter (если есть whisper), и кастомными gateway.
 * Для free-tier: пробуем несколько моделей whisper по очереди.
 */

import { File } from "expo-file-system";
import { persistentLogger } from "./persistent-logger";
import { securedProviderFetch } from "../core/enhancements/auth/productionProviderTransport";
import { sanitizeProviderExtraHeadersJson } from "./custom-provider";

export type TranscribeOptions = {
  uri: string;
  fileName?: string;
  providerId: string;
  /** Base URL без хвоста, напр. https://openrouter.ai/api/v1 */
  baseUrl: string;
  language?: string; // "ru" | "uk" | "en" | undefined (auto)
  extraHeaders?: Record<string, string>;
};

const WHISPER_MODELS = [
  "whisper-1",
  "whisper-large-v3",
  "openai/whisper-large-v3",
  "openai/whisper-large-v3-turbo",
  "groq/whisper-large-v3",
];

function guessAudioMime(nameOrUri: string): string {
  const s = nameOrUri.toLowerCase();
  if (s.endsWith(".wav")) return "audio/wav";
  if (s.endsWith(".m4a") || s.endsWith(".aac")) return "audio/mp4";
  if (s.endsWith(".ogg") || s.endsWith(".opus")) return "audio/ogg";
  if (s.endsWith(".webm")) return "audio/webm";
  if (s.endsWith(".flac")) return "audio/flac";
  if (s.endsWith(".mp3")) return "audio/mpeg";
  return "audio/mpeg";
}

function normalizeBaseUrl(baseUrl: string): string {
  return String(baseUrl || "")
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/chat\/completions$/i, "");
}

/**
 * Пытается расшифровать аудиофайл. Возвращает текст или бросает Error с понятным сообщением.
 */
export async function transcribeAudioFile(opts: TranscribeOptions): Promise<string> {
  const providerId = String(opts.providerId || "").trim();
  const base = normalizeBaseUrl(opts.baseUrl);
  if (!providerId) throw new Error("STT_PROVIDER_NOT_CONFIGURED");
  if (!base) throw new Error("STT_NO_BASE_URL");
  if (!/^https:\/\//i.test(base)) throw new Error("STT_INSECURE_BASE");
  if (!opts.uri) throw new Error("STT_NO_URI");

  const fileName = opts.fileName || opts.uri.split("/").pop() || "audio.mp3";
  const mime = guessAudioMime(fileName || opts.uri);
  const url = `${base}/audio/transcriptions`;

  // Читаем файл как blob через fetch file:// или expo File
  let blob: Blob;
  try {
    const res = await fetch(opts.uri);
    blob = await res.blob();
  } catch {
    // fallback: base64 → data URL → blob (тяжелее, но работает на части URI)
    try {
      const f = new File(opts.uri);
      const b64 = await f.base64();
      const dataUrl = `data:${mime};base64,${b64}`;
      const r2 = await fetch(dataUrl);
      blob = await r2.blob();
    } catch (e: unknown) {
      throw new Error("STT_READ_FAILED");
    }
  }

  if (!blob || blob.size === 0) {
    throw new Error("STT_EMPTY_FILE");
  }
  // Лимит ~25 МБ как у OpenAI Whisper
  if (blob.size > 25 * 1024 * 1024) {
    throw new Error("STT_FILE_TOO_LARGE");
  }

  let lastErr = "unknown";
  for (const model of WHISPER_MODELS) {
    try {
      const form = new FormData();
      form.append("file", blob as any, fileName);
      form.append("model", model);
      form.append("response_format", "json");
      if (opts.language && opts.language !== "auto") {
        // whisper: "ru", "en", "uk" — uk может не поддерживаться везде
        const lang =
          opts.language === "uk" ? "ukrainian" : opts.language === "ru" ? "ru" : "en";
        form.append("language", opts.language === "uk" ? "uk" : opts.language);
      }

      const headers: Record<string, string> = { ...(opts.extraHeaders || {}) };
      const route = {
        baseUrl: base,
        authHeader: /anthropic/i.test(base) ? "x-api-key" as const : "authorization" as const,
        authScheme: /anthropic/i.test(base) ? "raw" as const : "Bearer" as const,
      };
      // Не ставим Content-Type — RN/fetch сам выставит boundary для FormData

      persistentLogger.add(
        "debug",
        "STT",
        `POST ${url} model=${model} size=${blob.size}`
      );

      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 60_000);
      let response: Response;
      try {
        response = await securedProviderFetch(providerId, route, "audio/transcriptions", {
          method: "POST",
          headers,
          body: form as any,
          signal: ac.signal,
        });
      } catch (fetchErr: unknown) {
        clearTimeout(timer);
        const fm = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
        if (/abort|timeout/i.test(fm)) {
          lastErr = "STT_TIMEOUT";
          continue;
        }
        lastErr = "STT_NETWORK_ERROR";
        continue;
      }
      clearTimeout(timer);

      if (response.status === 404 || response.status === 400) {
        // модель/эндпоинт не поддерживается — пробуем следующую
        lastErr = `STT_MODEL_OR_ENDPOINT_UNAVAILABLE: HTTP ${response.status}`;
        continue;
      }
      if (response.status === 401) throw new Error("STT_AUTH_REJECTED: HTTP 401");
      if (response.status === 403) throw new Error("STT_ACCESS_DENIED: HTTP 403; the saved key is not proven invalid");
      if (response.status === 429) {
        throw new Error("STT_RATE_LIMIT: HTTP 429; retry after the provider limit resets");
      }
      if (response.status >= 400) {
        lastErr = response.status >= 500 ? `STT_UPSTREAM_ERROR: HTTP ${response.status}` : `STT_REQUEST_REJECTED: HTTP ${response.status}`;
        continue;
      }

      const textBody = await response.text();
      let data: any = null;
      try {
        data = JSON.parse(textBody);
      } catch {
        data = { raw: textBody };
      }

      const transcript =
        (typeof data?.text === "string" && data.text) ||
        (typeof data?.transcript === "string" && data.transcript) ||
        (typeof data?.result === "string" && data.result) ||
        "";

      if (!String(transcript).trim()) {
        lastErr = "STT_EMPTY_TRANSCRIPT";
        continue;
      }

      persistentLogger.add(
        "info",
        "STT",
        `OK model=${model} chars=${String(transcript).trim().length}`
      );
      return String(transcript).trim();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.startsWith("STT_")) throw e;
      lastErr = msg;
      continue;
    }
  }

  throw new Error(`STT_FAILED: ${lastErr}`);
}

/** Подбирает baseUrl/apiKey под текущий режим приложения. */
export function resolveSttEndpoint(mode: string, settings: {
  onlineModel?: { hasApiKey?: boolean };
  customProvider?: { providerId?: string; hasApiKey?: boolean; baseUrl?: string; extraHeadersJson?: string };
  openCode?: { hasApiKey?: boolean; baseUrl?: string };
}): { providerId: string; baseUrl: string; extraHeaders?: Record<string, string> } | null {
  if (mode === "custom") {
    const cfg = settings.customProvider;
    if (cfg?.baseUrl?.trim() && cfg?.hasApiKey) {
      let extra: Record<string, string> | undefined;
      if (cfg.extraHeadersJson?.trim()) {
        try {
          extra = JSON.parse(sanitizeProviderExtraHeadersJson(cfg.extraHeadersJson));
        } catch {
          /* ignore */
        }
      }
      return {
        providerId: cfg.providerId || "custom.slot1",
        baseUrl: cfg.baseUrl.trim(),
        extraHeaders: extra,
      };
    }
  }
  if (mode === "opencode") {
    const oc = settings.openCode;
    if (oc?.baseUrl?.trim() && oc?.hasApiKey) {
      return { providerId: "opencode", baseUrl: oc.baseUrl.trim() };
    }
  }
  if (mode === "online") {
    if (settings.onlineModel?.hasApiKey) {
      return {
        providerId: "openrouter",
        baseUrl: "https://openrouter.ai/api/v1",
        extraHeaders: {
          "HTTP-Referer": "https://aibuilder.app",
          "X-Title": "AI Builder",
        },
      };
    }
  }
  return null;
}
