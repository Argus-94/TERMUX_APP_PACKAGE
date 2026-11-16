import { redactSecrets } from "./log-redaction.ts";

export type SafeMemoryKind = "fact" | "decision" | "lesson" | "digest";
export type SafeMemoryItem = { id: string; kind: SafeMemoryKind; text: string; updatedAt: number };
export type SafeStoredMemory = { digest: string; updatedAt: number; items?: SafeMemoryItem[] };

const KINDS = new Set<SafeMemoryKind>(["fact", "decision", "lesson", "digest"]);

export function sanitizeMemoryText(value: unknown, maxChars: number): string {
  if (typeof value !== "string") return "";
  return redactSecrets(value.trim()).slice(0, maxChars);
}

function finiteTimestamp(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Validate untrusted persisted JSON and apply the same secret policy before any consumer sees it. */
export function sanitizeProjectMemoryMap(value: unknown): Record<string, SafeStoredMemory> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const rows: Array<[string, SafeStoredMemory]> = [];
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!key || key.length > 240 || key.includes("\0") || ["__proto__", "constructor", "prototype"].includes(key)) continue;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const entry = raw as Record<string, unknown>;
    const items: SafeMemoryItem[] = [];
    if (Array.isArray(entry.items)) {
      for (const candidate of entry.items.slice(-40)) {
        if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
        const item = candidate as Record<string, unknown>;
        const timestamp = finiteTimestamp(item.updatedAt);
        if (typeof item.id !== "string" || item.id.length > 100 || typeof item.kind !== "string" || !KINDS.has(item.kind as SafeMemoryKind) || timestamp === null || typeof item.text !== "string") continue;
        const text = sanitizeMemoryText(item.text, 2000);
        if (!text) continue;
        items.push({ id: item.id, kind: item.kind as SafeMemoryKind, text, updatedAt: timestamp });
      }
    }
    const updatedAt = finiteTimestamp(entry.updatedAt) ?? Math.max(0, ...items.map((item) => item.updatedAt));
    rows.push([key, {
      digest: sanitizeMemoryText(entry.digest, 1500),
      updatedAt,
      items,
    }]);
  }
  rows.sort((a, b) => b[1].updatedAt - a[1].updatedAt);
  return Object.fromEntries(rows.slice(0, 30));
}
