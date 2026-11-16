export type DurablePersistenceAdapter = Readonly<{
  read(key: string): Promise<string | null>;
  write(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}>;

const RECORDS: Readonly<Record<string, string>> = Object.freeze({
  "aibuilder.settings.v1": "app-settings.json",
  "aibuilder.activeProject.v1": "active-project.json",
  "aibuilder.projectList.v1": "project-list.json",
  "aibuilder.session-memory.v1": "session-memory.json",
  "aibuilder.termuxPacks.v1": "termux-packs.json",
});
const SECRET_VALUE = /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,}|aib_[A-Za-z0-9_-]{8,}[0-9]{10,13})\b/gi;
const SECRET_ASSIGNMENT = /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|passwd|secret|authorization|bearer)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi;

let adapter: DurablePersistenceAdapter | null = null;

/** Called by RuntimeFacade after it constructs the HOME-backed store. */
export function configureDurablePersistence(next: DurablePersistenceAdapter): void { adapter = next; }

/** Mirrors only explicitly listed records; unrecognized keys are intentionally ignored. */
export async function mirrorDurableRecord(sourceKey: string, value: string): Promise<void> {
  const path = RECORDS[sourceKey];
  if (!adapter || !path) return;
  const safe = sanitize(sourceKey, value);
  if (safe === null) return;
  await adapter.write(`app-state/${path}`, safe);
}

/** Reads a previously mirrored record and re-sanitizes it before use. */
export async function readDurableRecord(sourceKey: string): Promise<string | null> {
  const path = RECORDS[sourceKey];
  if (!adapter || !path) return null;
  const raw = await adapter.read(`app-state/${path}`);
  return raw === null ? null : sanitize(sourceKey, raw);
}

export async function removeDurableRecord(sourceKey: string): Promise<void> {
  const path = RECORDS[sourceKey];
  if (adapter && path) await adapter.remove(`app-state/${path}`);
}

function sanitize(sourceKey: string, raw: string): string | null {
  if (typeof raw !== "string" || raw.length > 300_000) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (sourceKey === "aibuilder.settings.v1") return sanitizeSettings(value);
    if (sourceKey === "aibuilder.activeProject.v1") return JSON.stringify(value === null ? null : sanitizeProject(value));
    if (sourceKey === "aibuilder.projectList.v1") {
      if (!Array.isArray(value)) return null;
      return JSON.stringify(value.slice(0, 30).map(sanitizeProject).filter((item): item is Record<string, unknown> => item !== null));
    }
    if (sourceKey === "aibuilder.session-memory.v1") return sanitizeMemory(value);
    if (sourceKey === "aibuilder.termuxPacks.v1") {
      if (!isRecord(value)) return null;
      const flags: Record<string, boolean> = {};
      for (const [key, enabled] of Object.entries(value).slice(0, 200)) {
        if (/^[A-Za-z0-9_.-]{1,100}$/.test(key) && typeof enabled === "boolean") flags[key] = enabled;
      }
      return JSON.stringify(flags);
    }
  } catch {
    return null;
  }
  return null;
}

function sanitizeSettings(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const result: Record<string, unknown> = {};
  if (typeof value.mode === "string" && /^[A-Za-z0-9_-]{1,32}$/.test(value.mode)) result.mode = value.mode;
  if (typeof value.localParamsAuto === "boolean") result.localParamsAuto = value.localParamsAuto;
  for (const name of ["localParams", "localGenParams", "onlineGenParams"] as const) {
    const record = value[name];
    if (!isRecord(record)) continue;
    const picked: Record<string, number> = {};
    for (const [key, item] of Object.entries(record)) {
      if (["nCtx", "nThreads", "nGpuLayers", "temperature", "maxTokens", "topP", "frequencyPenalty", "presencePenalty"].includes(key) && typeof item === "number" && Number.isFinite(item)) picked[key] = item;
    }
    result[name] = picked;
  }
  if (typeof value.openRouterModelId === "string" && /^[A-Za-z0-9_.:/-]{1,200}$/.test(value.openRouterModelId)) result.openRouterModelId = value.openRouterModelId;
  if (value.activeCustomSlot === 1 || value.activeCustomSlot === 2) result.activeCustomSlot = value.activeCustomSlot;
  // Custom provider URLs/headers, system prompts, model URLs and all API keys are deliberately omitted.
  return JSON.stringify(result);
}

function sanitizeProject(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const { id, name, packageName, path, createdAt, updatedAt } = value;
  if (typeof id !== "string" || id.length > 120 || typeof name !== "string" || name.length > 120 || typeof packageName !== "string" || packageName.length > 200 || typeof path !== "string" || !path.startsWith("/") || path.length > 700 || /[\0\r\n]/.test(path) || typeof createdAt !== "number" || !Number.isFinite(createdAt) || typeof updatedAt !== "number" || !Number.isFinite(updatedAt)) return null;
  const result: Record<string, unknown> = { id, name: name.slice(0, 120), packageName: packageName.slice(0, 200), path, createdAt, updatedAt };
  if (typeof value.useCompose === "boolean") result.useCompose = value.useCompose;
  if (typeof value.template === "string" && /^[A-Za-z0-9_-]{1,50}$/.test(value.template)) result.template = value.template;
  if (typeof value.minSdk === "number" && Number.isSafeInteger(value.minSdk)) result.minSdk = value.minSdk;
  if (typeof value.targetSdk === "number" && Number.isSafeInteger(value.targetSdk)) result.targetSdk = value.targetSdk;
  if (typeof value.gitInit === "boolean") result.gitInit = value.gitInit;
  return result;
}

function sanitizeMemory(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const result: Record<string, { digest: string; updatedAt: number; items?: Array<{ id: string; kind: string; text: string; updatedAt: number }> }> = {};
  for (const [project, rawEntry] of Object.entries(value).slice(0, 30)) {
    if (!project.startsWith("/") || project.length > 240 || /[\0\r\n]/.test(project) || !isRecord(rawEntry)) continue;
    const digest = typeof rawEntry.digest === "string" ? redact(rawEntry.digest).slice(0, 1500) : "";
    const updatedAt = typeof rawEntry.updatedAt === "number" && Number.isFinite(rawEntry.updatedAt) ? rawEntry.updatedAt : Date.now();
    const items = Array.isArray(rawEntry.items) ? rawEntry.items.slice(-40).flatMap((item) => {
      if (!isRecord(item) || typeof item.id !== "string" || typeof item.kind !== "string" || typeof item.text !== "string") return [];
      if (!["fact", "decision", "lesson", "digest"].includes(item.kind)) return [];
      const at = typeof item.updatedAt === "number" && Number.isFinite(item.updatedAt) ? item.updatedAt : updatedAt;
      return [{ id: item.id.slice(0, 100), kind: item.kind, text: redact(item.text).slice(0, 2000), updatedAt: at }];
    }) : [];
    result[project] = { digest, updatedAt, ...(items.length ? { items } : {}) };
  }
  return JSON.stringify(result);
}

function redact(value: string): string {
  return value.replace(SECRET_VALUE, "[REDACTED]").replace(SECRET_ASSIGNMENT, "$1[REDACTED]");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
