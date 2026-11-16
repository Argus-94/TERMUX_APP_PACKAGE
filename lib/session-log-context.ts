import { persistentLogger, type LogEntry } from "./persistent-logger";
import { getBuildBackend, backendLabel } from "./agent-shell-backend";

/**
 * Подбирает из persistent-лога записи, релевантные текущему запросу
 * пользователя. Нужно, чтобы при длинной сессии (история чата обрезается
 * ради токенов) модель всё равно «подсматривала» ранние шаги: созданные
 * файлы, пути, команды Termux, ответы ассистента — без протаскивания
 * всей истории в каждый запрос.
 *
 * v1.8.46+: structured LogEntry fields (correlationId, errorCategory, exitCode,
 * path, stackPreview, meta) are included in the agent-facing slice so
 * self-correction can map log → failure cluster / recipe without guessing.
 *
 * Стратегия:
 *  1. Из сообщения вытаскиваем токены (пути, имена файлов, слова ≥3 символов).
 *  2. Скоринг записей лога по совпадениям + бонус error/agent/structured.
 *  3. Берём топ по score, укладываемся в maxChars.
 */

const STOP = new Set([
  "the", "and", "for", "that", "this", "with", "from", "your", "have", "not",
  "are", "was", "were", "что", "это", "как", "для", "или", "при", "все",
  "его", "её", "их", "мне", "тебя", "нужно", "можешь", "пожалуйста",
  "будь", "ласка", "тоже", "ещё", "еще", "только", "сейчас", "файл",
  "the", "a", "an", "to", "of", "in", "on", "is", "it", "you", "me",
  "удали", "создай", "сделай", "покажи", "найди", "открой", "закрой",
  "please", "just", "make", "create", "delete", "show", "find", "open",
]);

function extractTokens(text: string): string[] {
  const raw = text
    .toLowerCase()
    .match(/[a-zа-яё0-9_./~-]{3,}/gi) || [];
  const tokens: string[] = [];
  const seen = new Set<string>();
  for (const t of raw) {
    const s = t.toLowerCase();
    if (STOP.has(s)) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    tokens.push(s);
    // имя файла из пути
    if (s.includes("/")) {
      const base = s.split("/").pop();
      if (base && base.length >= 3 && !seen.has(base)) {
        seen.add(base);
        tokens.push(base);
      }
    }
  }
  return tokens.slice(0, 24);
}

function scoreEntry(entry: LogEntry, tokens: string[]): number {
  const hay = `${entry.tag} ${entry.message} ${entry.path || ""} ${entry.action || ""} ${entry.errorCategory || ""} ${entry.correlationId || ""}`.toLowerCase();
  let score = 0;
  if (tokens.length === 0) {
    // No tokens: still surface recent errors / agent steps lightly
    if (entry.level === "error") score = 2;
    else if (entry.source === "agent" || entry.tag === "AgentStep" || entry.tag === "AgentShell") score = 1;
    return score;
  }
  for (const t of tokens) {
    if (hay.includes(t)) {
      score += t.includes("/") || t.includes(".") ? 3 : 1;
    }
  }
  // Termux/Chat / agent structured lines slightly preferred
  if (entry.tag === "Termux" || entry.tag === "Chat" || entry.tag === "AgentStep" || entry.tag === "AgentShell") score *= 1.4;
  if (entry.source === "agent" || entry.source === "linux" || entry.source === "termux") score *= 1.2;
  if (entry.level === "error") score *= 1.5;
  if (entry.level === "warn") score *= 1.2;
  if (entry.errorCategory) score += 2;
  if (entry.exitCode != null && entry.exitCode !== 0) score += 3;
  if (entry.path) score += 1;
  if (entry.stackPreview) score += 1;
  if (entry.correlationId) score += 0.5;
  return score;
}

/** Omit legacy attachment names and free-form errors from agent-facing context. */
function safeAgentLogMessage(e: LogEntry): string {
  if (e.tag === "FileIntake") {
    const source = e.message.replace(/^\[FILE_INTAKE\s+/, "").replace(/\]$/, "");
    const event = source.match(/^(CACHE_HIT|MAGIC_MISMATCH|ARCHIVE_INSPECT|READY|PRE_ANALYSIS_FAILED|ACTION_PICKER|ACTION_SELECTED)/)?.[1] || "FILE_INTAKE_EVENT";
    const fields = [...source.matchAll(/\b(type|extension|size|actions|durationMs|entries|extracted|safe|warningCount|action)=([A-Za-z0-9_,.-]+)/g)]
      .map((match) => `${match[1]}=${match[2]}`);
    return [event, ...fields].join(" ");
  }
  if (e.tag === "Chat" && /file selected|image selected|FILE_PARSE_FAILED|Materialized attachment|Materialize failed|errorReadFile/i.test(e.message)) {
    const fields = [...e.message.matchAll(/\b(type|extension|size)=([A-Za-z0-9_,.-]+)/g)]
      .map((match) => `${match[1]}=${match[2]}`);
    return ["ATTACHMENT_EVENT", ...fields].join(" ");
  }
  return e.message;
}

/** Format one log entry for agent consumption (includes structured fields). */
function formatEntryLine(e: LogEntry, withMs = false): string {
  const ts = withMs
    ? new Date(e.timestamp).toISOString().slice(11, 23)
    : new Date(e.timestamp).toISOString().slice(11, 19);
  const parts = [`[${ts}]`, `[${e.level}]`, `[${e.tag}]`];
  if (e.source) parts.push(`[${e.source}]`);
  if (e.correlationId) parts.push(`cid=${e.correlationId}`);
  if (e.action) parts.push(`action=${e.action}`);
  if (e.errorCategory) parts.push(`errCat=${e.errorCategory}`);
  if (e.exitCode != null) parts.push(`exit=${e.exitCode}`);
  if (e.path) parts.push(`path=${e.path}`);
  if (e.meta?.recipeId) parts.push(`recipeId=${e.meta.recipeId}`);
  if (e.meta?.failureCluster) parts.push(`cluster=${e.meta.failureCluster}`);
  parts.push(safeAgentLogMessage(e).replace(/\s+/g, " ").trim());
  if (e.stackPreview) parts.push(`stack=${e.stackPreview.slice(0, 240)}`);
  return parts.join(" ");
}

export function buildRelevantSessionLogContext(
  userMessage: string,
  options?: { maxChars?: number; maxEntries?: number }
): string {
  const maxChars = options?.maxChars ?? 3200;
  const maxEntries = options?.maxEntries ?? 22;
  const tokens = extractTokens(userMessage);

  const all = persistentLogger.getAll();
  if (all.length === 0) return "";

  // Always include a small set of the most recent errors even if token match is weak
  const recentErrors = all
    .filter((e) => e.level === "error")
    .slice(-8);

  const ranked = all
    .map((e) => ({ e, score: scoreEntry(e, tokens) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || b.e.timestamp - a.e.timestamp)
    .slice(0, maxEntries);

  const byId = new Map<string, LogEntry>();
  for (const { e } of ranked) byId.set(e.id, e);
  for (const e of recentErrors) {
    if (byId.size >= maxEntries + 4) break;
    byId.set(e.id, e);
  }

  const ordered = [...byId.values()].sort((a, b) => a.timestamp - b.timestamp);
  if (ordered.length === 0) return "";

  const lines: string[] = [];
  let used = 0;
  for (const e of ordered) {
    const line = formatEntryLine(e);
    if (used + line.length + 1 > maxChars) break;
    lines.push(line);
    used += line.length + 1;
  }

  if (lines.length === 0) return "";
  return (
    "[SESSION_LOG — релевантные записи лога этой сессии (structured: cid/action/errCat/exit/path); используй для диагностики и самоисправления, если в недавней истории чата не хватает деталей]\n" +
    lines.join("\n")
  );
}


/** Diagnostic slice for the active agent trace. This is the agent's view of the
 * same persistent log shown by the built-in Log screen. It deliberately favors
 * the active trace, failures, Linux/Termux shell output and tool events.
 * v1.8.46+: includes structured fields and groups by correlationId when present. */
export function buildAgentDiagnosticLogContext(
  traceId: string,
  options?: { maxChars?: number; maxEntries?: number },
): string {
  const maxChars = options?.maxChars ?? 10000;
  const maxEntries = options?.maxEntries ?? 56;
  const all = persistentLogger.getAll();
  const matched = all
    .filter((e) => {
      const hay = `${e.tag} ${e.message} ${e.correlationId || ""}`;
      return (traceId && (
          hay.includes(`traceId=${traceId}`) ||
          hay.includes(`traceId: ${traceId}`) ||
          (e.correlationId != null && e.correlationId.includes(traceId))
        )) ||
        e.source === "linux" ||
        e.source === "agent" ||
        e.tag === "AgentShell" ||
        e.tag === "AgentTool" ||
        e.tag === "AgentStep" ||
        e.tag === "Termux" ||
        e.level === "error";
    })
    .slice(-Math.max(maxEntries * 3, maxEntries));

  const ranked = matched
    .map((e) => {
      const hay = `${e.tag} ${e.message} ${e.correlationId || ""}`;
      let score = 0;
      if (traceId && (
        hay.includes(`traceId=${traceId}`) ||
        hay.includes(`traceId: ${traceId}`) ||
        (e.correlationId != null && e.correlationId.includes(traceId))
      )) score += 10;
      if (e.level === "error") score += 6;
      if (e.level === "warn") score += 3;
      if (e.source === "linux" || e.source === "agent" || e.tag === "AgentShell" || e.tag === "AgentTool" || e.tag === "AgentStep") score += 4;
      if (e.errorCategory) score += 2;
      if (e.exitCode != null && e.exitCode !== 0) score += 3;
      if (e.path) score += 1;
      return { e, score };
    })
    .sort((a, b) => b.score - a.score || b.e.timestamp - a.e.timestamp)
    .slice(0, maxEntries)
    .sort((a, b) => a.e.timestamp - b.e.timestamp);

  const lines = [
    `[AGENT_BUILT_IN_LOG] backend=${getBuildBackend()} (${backendLabel()}) traceId=${traceId}`,
    "This is the same persistent log visible in AI Builder → Log. Structured fields: cid=correlationId, action, errCat=errorCategory, exit, path, recipeId, cluster. Use concrete stderr/exit/lifecycle evidence below to diagnose the failing layer before retrying. Prefer deterministic repair recipes over invented shell when cluster/recipeId is present.",
  ];
  for (const { e } of ranked) {
    lines.push(formatEntryLine(e, true));
  }
  const text = lines.join("\n");
  return text.length <= maxChars ? text : text.slice(-maxChars);
}
