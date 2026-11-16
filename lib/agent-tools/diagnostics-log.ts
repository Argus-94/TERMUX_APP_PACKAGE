import { persistentLogger, type LogEntry } from "../persistent-logger";
import { getBuildBackend, backendLabel } from "../agent-shell-backend";

function clamp(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.floor(n))) : fallback;
}

export function validate(args: Record<string, unknown>): string | null {
  if (args.traceId !== undefined && typeof args.traceId !== "string") return "TRACE_ID_MUST_BE_STRING";
  if (args.maxEntries !== undefined && !Number.isFinite(Number(args.maxEntries))) return "MAX_ENTRIES_MUST_BE_NUMBER";
  if (args.maxChars !== undefined && !Number.isFinite(Number(args.maxChars))) return "MAX_CHARS_MUST_BE_NUMBER";
  return null;
}

function matches(entry: LogEntry, traceId: string, includeAll: boolean): boolean {
  if (includeAll) return true;
  const hay = `${entry.tag} ${entry.message}`;
  return hay.includes(`traceId=${traceId}`) || hay.includes(`traceId: ${traceId}`) || entry.source === "linux";
}

export async function execute(args: Record<string, unknown>): Promise<string> {
  const traceId = typeof args.traceId === "string" ? args.traceId.trim() : "";
  const maxEntries = clamp(args.maxEntries, 40, 1, 100);
  const maxChars = clamp(args.maxChars, 9000, 500, 20000);
  const includeAll = args.includeAll === true;
  const all = persistentLogger.getAll();
  const selected = all
    .filter((e) => matches(e, traceId, includeAll))
    .slice(-maxEntries);

  const backend = getBuildBackend();
  const lines: string[] = [
    `[BUILT_IN_LOG_DIAGNOSTICS] backend=${backend} (${backendLabel()}) traceId=${traceId || "*"}`,
    `entries=${selected.length} totalLogEntries=${all.length}`,
  ];
  for (const e of selected) {
    const ts = new Date(e.timestamp).toISOString();
    lines.push(`[${ts}] [${e.level}] [${e.tag}] [source=${e.source || "app"}] ${e.message.replace(/\s+/g, " ").trim()}`);
  }
  const text = lines.join("\n");
  return text.length <= maxChars ? text : text.slice(-maxChars);
}
