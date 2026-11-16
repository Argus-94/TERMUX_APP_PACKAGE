/**
 * LeanCTX-inspired context engine for AI Builder (local-first).
 *
 * Goals (no network, no native binary):
 * 1. Multi-mode file reads with content-addressed cache (re-read ≈ free).
 * 2. Reversible compression handles (expand on demand).
 * 3. Shell/CLI output compression for common Android/build tools.
 * 4. Task-oriented compose (ranked paths + signatures).
 * 5. Session-scoped token/context metrics for UI + agent budgets.
 *
 * Does NOT change compilation / gradle / NDK settings.
 */

import AsyncStorage from "@react-native-async-storage/async-storage";

// ── Types ──────────────────────────────────────────────────────────────────

export type ReadMode =
  | "full"
  | "signatures"
  | "map"
  | "lines"
  | "density"
  | "auto";

export type ContextMetrics = {
  reads: number;
  cacheHits: number;
  bytesRaw: number;
  bytesEmitted: number;
  tokensEstRaw: number;
  tokensEstEmitted: number;
  expands: number;
  shellCompressed: number;
  lastUpdated: number;
};

export type ExpandHandle = {
  id: string;
  kind: "file" | "shell" | "blob";
  path?: string;
  mode?: string;
  createdAt: number;
  originalChars: number;
  truncated: boolean;
  /** Bounded text kept in memory; check `truncated` before treating it as complete. */
  content: string;
};

// ── In-memory session state ────────────────────────────────────────────────

const MAX_CACHE_ENTRIES = 80;
const MAX_HANDLE_ENTRIES = 40;
const MAX_HANDLE_CHARS = 120_000;
const METRICS_KEY = "aibuilder.context-metrics.v1";

type CacheEntry = {
  key: string;
  contentHash: string;
  mode: string;
  emitted: string;
  rawLen: number;
  at: number;
};

const fileCache = new Map<string, CacheEntry>();
const handles = new Map<string, ExpandHandle>();

let metrics: ContextMetrics = {
  reads: 0,
  cacheHits: 0,
  bytesRaw: 0,
  bytesEmitted: 0,
  tokensEstRaw: 0,
  tokensEstEmitted: 0,
  expands: 0,
  shellCompressed: 0,
  lastUpdated: Date.now(),
};

// ── Helpers ────────────────────────────────────────────────────────────────

/** Rough token estimate (~4 chars/token) — good enough for budgets. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

function simpleHash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function cacheKey(path: string, mode: string, extra = ""): string {
  return `${path}|${mode}|${extra}`;
}

function touchMetrics(patch: Partial<ContextMetrics>) {
  metrics = { ...metrics, ...patch, lastUpdated: Date.now() };
}

export function getContextMetrics(): ContextMetrics {
  return { ...metrics };
}

export function resetContextMetrics(): void {
  metrics = {
    reads: 0,
    cacheHits: 0,
    bytesRaw: 0,
    bytesEmitted: 0,
    tokensEstRaw: 0,
    tokensEstEmitted: 0,
    expands: 0,
    shellCompressed: 0,
    lastUpdated: Date.now(),
  };
}

/** Persist lightweight metrics snapshot (best-effort). */
export async function persistContextMetrics(): Promise<void> {
  try {
    await AsyncStorage.setItem(METRICS_KEY, JSON.stringify(metrics));
  } catch {
    /* ignore */
  }
}

export async function loadPersistedContextMetrics(): Promise<ContextMetrics | null> {
  try {
    const raw = await AsyncStorage.getItem(METRICS_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (p && typeof p === "object") {
      metrics = { ...metrics, ...p };
      return getContextMetrics();
    }
  } catch {
    /* ignore */
  }
  return null;
}

// ── Signature / map extractors (heuristic, no tree-sitter) ─────────────────

const SIG_PATTERNS: RegExp[] = [
  // Kotlin / Java / TS / JS / C-like
  /^\s*(?:export\s+)?(?:async\s+)?(?:public|private|protected|internal|open|override|fun|function|class|interface|object|enum|type|const|let|var|def|fn|pub|struct|impl)\b.+/m,
  /^\s*@\w+.*/m,
  /^\s*(?:import|package|from)\s+.+/m,
];

export function extractSignatures(content: string, maxLines = 80): string {
  const lines = content.split(/\r?\n/);
  const out: string[] = [];
  for (let i = 0; i < lines.length && out.length < maxLines; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("#") || trimmed.startsWith("*")) continue;
    if (
      /^(export\s+)?(async\s+)?(public|private|protected|internal|open|override|fun|function|class|interface|object|enum|type|const|let|var|def|fn|pub|struct|impl|package|import|from)\b/.test(
        trimmed,
      ) ||
      trimmed.startsWith("@")
    ) {
      out.push(`${i + 1}|${trimmed.slice(0, 200)}`);
    }
  }
  if (!out.length) {
    // fallback: first non-empty lines
    for (let i = 0; i < lines.length && out.length < 40; i++) {
      const t = lines[i].trim();
      if (t) out.push(`${i + 1}|${t.slice(0, 160)}`);
    }
  }
  return out.join("\n");
}

export function extractMap(content: string, path: string): string {
  const lines = content.split(/\r?\n/);
  const imports: string[] = [];
  const exports: string[] = [];
  const defs: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (/^(import|from|package)\b/.test(t)) imports.push(t.slice(0, 120));
    if (/^export\b/.test(t) || /\bexport\s+(default\s+)?(class|function|const|async)/.test(t))
      exports.push(`${i + 1}:${t.slice(0, 100)}`);
    if (
      /^(export\s+)?(async\s+)?(function|class|interface|fun|def|fn|struct|impl)\b/.test(t) ||
      /^(public|private|protected)\s+(static\s+)?(class|interface|fun|void|int|String)/.test(t)
    ) {
      defs.push(`${i + 1}:${t.slice(0, 120)}`);
    }
  }
  const parts = [
    `MAP ${path} (${lines.length}L)`,
    imports.length ? `imports(${imports.length}): ${imports.slice(0, 12).join(" | ")}` : null,
    exports.length ? `exports:\n  ${exports.slice(0, 20).join("\n  ")}` : null,
    defs.length ? `defs:\n  ${defs.slice(0, 30).join("\n  ")}` : null,
  ].filter(Boolean);
  return parts.join("\n");
}

/** Keep highest-entropy-ish lines until ~ratio of original length. */
export function densityFilter(content: string, ratio = 0.4): string {
  const lines = content.split(/\r?\n/);
  if (lines.length < 20) return content;
  const scored = lines.map((line, idx) => {
    const t = line.trim();
    // crude entropy proxy: unique chars / length + keyword boost
    const unique = new Set(t).size;
    const score =
      (t.length ? unique / t.length : 0) * 2 +
      (/function|class|error|fail|TODO|FIXME|export|import|return|throw|catch|async|await|fun |def /.test(t)
        ? 0.5
        : 0) -
      (t.length < 3 || /^[\s{}\[\]();,]*$/.test(t) ? 1 : 0);
    return { idx, line, score };
  });
  scored.sort((a, b) => b.score - a.score);
  const keep = Math.max(8, Math.floor(lines.length * ratio));
  const selected = scored.slice(0, keep).sort((a, b) => a.idx - b.idx);
  return selected.map((s) => `${s.idx + 1}|${s.line}`).join("\n");
}

// ── Public: shape raw file content by mode ─────────────────────────────────

export function shapeFileContent(
  path: string,
  content: string,
  mode: ReadMode,
  opts?: { start?: number; end?: number; density?: number },
): { text: string; modeUsed: ReadMode; rawLen: number } {
  const rawLen = content.length;
  let modeUsed: ReadMode = mode === "auto" ? pickAutoMode(path, content) : mode;
  let text: string;

  switch (modeUsed) {
    case "signatures":
      text = extractSignatures(content);
      break;
    case "map":
      text = extractMap(content, path);
      break;
    case "density":
      text = densityFilter(content, opts?.density ?? 0.4);
      break;
    case "lines": {
      const lines = content.split(/\r?\n/);
      const start = Math.max(1, opts?.start ?? 1);
      const end = Math.min(lines.length, opts?.end ?? start + 120);
      const slice = lines.slice(start - 1, end);
      text = slice.map((l, i) => `${start + i}|${l}`).join("\n");
      break;
    }
    case "full":
    default:
      text = content;
      modeUsed = "full";
      break;
  }

  // Record cache + metrics
  const hash = simpleHash(content);
  const key = cacheKey(path, modeUsed, `${opts?.start ?? ""}-${opts?.end ?? ""}`);
  if (fileCache.size >= MAX_CACHE_ENTRIES) {
    const oldest = [...fileCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) fileCache.delete(oldest[0]);
  }
  fileCache.set(key, {
    key,
    contentHash: hash,
    mode: modeUsed,
    emitted: text,
    rawLen,
    at: Date.now(),
  });

  touchMetrics({
    reads: metrics.reads + 1,
    bytesRaw: metrics.bytesRaw + rawLen,
    bytesEmitted: metrics.bytesEmitted + text.length,
    tokensEstRaw: metrics.tokensEstRaw + estimateTokens(content),
    tokensEstEmitted: metrics.tokensEstEmitted + estimateTokens(text),
  });

  return { text, modeUsed, rawLen };
}

function pickAutoMode(path: string, content: string): ReadMode {
  const lower = path.toLowerCase();
  if (content.length > 40_000) return "map";
  if (/\.(ts|tsx|js|jsx|kt|java|py|go|rs)$/.test(lower) && content.length > 4_000) return "signatures";
  if (content.length > 12_000) return "density";
  return "full";
}

/** Return cached emission if same path+mode and content hash still matches (caller supplies hash or content). */
export function tryCacheHit(
  path: string,
  mode: ReadMode,
  contentOrHash: string,
  opts?: { start?: number; end?: number },
): string | null {
  const key = cacheKey(path, mode === "auto" ? "full" : mode, `${opts?.start ?? ""}-${opts?.end ?? ""}`);
  // also try exact mode keys
  for (const m of [mode, "full", "signatures", "map", "density", "lines"] as ReadMode[]) {
    const k = cacheKey(path, m, `${opts?.start ?? ""}-${opts?.end ?? ""}`);
    const hit = fileCache.get(k);
    if (!hit) continue;
    const h =
      contentOrHash.length === 8 && /^[0-9a-f]+$/i.test(contentOrHash)
        ? contentOrHash
        : simpleHash(contentOrHash);
    if (hit.contentHash === h || hit.emitted === contentOrHash) {
      touchMetrics({ cacheHits: metrics.cacheHits + 1, reads: metrics.reads + 1 });
      return `[CACHE_HIT mode=${hit.mode} path=${path} raw=${hit.rawLen}]\n${hit.emitted}`;
    }
  }
  return null;
}

// ── Expand handles (reversible compression) ────────────────────────────────

export function storeExpandHandle(
  kind: ExpandHandle["kind"],
  content: string,
  meta?: { path?: string; mode?: string },
): string {
  const id = `h_${Date.now().toString(36)}_${simpleHash(content).slice(0, 6)}`;
  if (handles.size >= MAX_HANDLE_ENTRIES) {
    const oldest = [...handles.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)[0];
    if (oldest) handles.delete(oldest[0]);
  }
  const clipped = content.length > MAX_HANDLE_CHARS ? content.slice(0, MAX_HANDLE_CHARS) : content;
  handles.set(id, {
    id,
    kind,
    path: meta?.path,
    mode: meta?.mode,
    createdAt: Date.now(),
    originalChars: content.length,
    truncated: content.length > MAX_HANDLE_CHARS,
    content: clipped,
  });
  return id;
}

export function expandHandle(id: string): ExpandHandle | null {
  const h = handles.get(id);
  if (!h) return null;
  touchMetrics({ expands: metrics.expands + 1 });
  return h;
}

/** If text is huge, store handle and return compact stub. */
export function maybeCompressToHandle(
  kind: ExpandHandle["kind"],
  text: string,
  meta?: { path?: string; mode?: string },
  threshold = 8_000,
): string {
  if (text.length <= threshold) return text;
  const id = storeExpandHandle(kind, text, meta);
  const preview = text.slice(0, 400).replace(/\n/g, "\\n");
  const handle = expandHandle(id);
  if (handle?.truncated) {
    return `[CTX_HANDLE id=${id} kind=${kind} chars=${text.length} storedChars=${handle.content.length} truncated=true tokens≈${estimateTokens(text)}] ${preview}…\nctx.expand returns only the stored prefix; the omitted content is unavailable. Do not treat this handle as the full original.`;
  }
  return `[CTX_HANDLE id=${id} kind=${kind} chars=${text.length} tokens≈${estimateTokens(text)}] ${preview}…\nUse ctx.expand id=${id} for full content.`;
}

// ── Shell output compression ───────────────────────────────────────────────

const SHELL_RULES: Array<{ re: RegExp; name: string; compress: (s: string) => string }> = [
  {
    name: "gradle",
    re: /gradle|BUILD SUCCESSFUL|BUILD FAILED|Task :/i,
    compress: (s) => {
      const lines = s.split(/\r?\n/);
      const keep = lines.filter(
        (l) =>
          /BUILD SUCCESSFUL|BUILD FAILED|FAILURE:|error:|e: |w: |Task :|FAILED|Exception|What went wrong|Try:|error\.|FAILED/.test(
            l,
          ) ||
          /^\s*>\s/.test(l) ||
          /APK_PATH=|RAW_APK=|SIGNED_V1_V2_V3_OK|UNSIGNED_APK_OK|AAB_OK=|COPIED_TO=|gradle_ec=|ONLINE_END|OFFLINE_END|PREPARE_OK|NO_APK_OUTPUT|DISK_FULL|SKIP_OFFLINE/.test(
            l,
          ),
      );
      if (keep.length < 5) return s.slice(0, 4000);
      return `[gradle compressed ${lines.length}→${keep.length}]\n` + keep.slice(0, 80).join("\n");
    },
  },
  {
    name: "git",
    re: /^(On branch |diff --git|commit |Author:|Date:|\s*[MADRC]\s+|\s*\d+\s+files? changed)/m,
    compress: (s) => {
      const lines = s.split(/\r?\n/);
      if (lines.length < 40) return s;
      const head = lines.slice(0, 25);
      const stats = lines.filter((l) => /files? changed|insertions|deletions|On branch|Your branch/.test(l));
      return `[git compressed ${lines.length}L]\n` + [...head, ...stats].slice(0, 40).join("\n");
    },
  },
  {
    name: "pnpm_npm",
    re: /pnpm |npm |added \d|removed \d|Packages:|Progress:/i,
    compress: (s) => {
      const lines = s.split(/\r?\n/);
      const keep = lines.filter(
        (l) =>
          /error|ERR!|WARN|added |removed |Packages:|Done in|built in|FAIL|ERROR/.test(l) ||
          /^\s*[\w@/-]+@[\d.]+/.test(l),
      );
      return keep.length
        ? `[pkg compressed ${lines.length}→${keep.length}]\n` + keep.slice(0, 50).join("\n")
        : s.slice(0, 3000);
    },
  },
  {
    name: "adb",
    re: /\badb\b|daemon started|error:\s*device|package:|Success/i,
    compress: (s) => {
      const lines = s.split(/\r?\n/);
      if (lines.length < 30) return s;
      return `[adb compressed]\n` + lines.filter((l) => l.trim()).slice(0, 40).join("\n");
    },
  },
];

export function compressShellOutput(stdout: string, stderr = ""): string {
  const combined = stderr ? `${stdout}\n${stderr}` : stdout;
  if (combined.length < 1500) return combined;
  for (const rule of SHELL_RULES) {
    if (rule.re.test(combined)) {
      const out = rule.compress(combined);
      touchMetrics({ shellCompressed: metrics.shellCompressed + 1 });
      // Preserve APK/build markers — never replace a useful compress result with CTX_HANDLE
      const hasMarkers =
        /APK_PATH=|SIGNED_V1_V2_V3_OK|UNSIGNED_APK_OK|AAB_OK=|gradle_ec=|PREPARE_OK|BUILD SUCCESSFUL|BUILD FAILED/.test(
          out,
        );
      if (!hasMarkers && out.length < combined.length * 0.7) {
        return maybeCompressToHandle("shell", combined, { mode: rule.name }, 20_000);
      }
      return out;
    }
  }
  // generic: keep head + tail
  if (combined.length > 6_000) {
    const lines = combined.split(/\r?\n/);
    const head = lines.slice(0, 40).join("\n");
    const tail = lines.slice(-20).join("\n");
    touchMetrics({ shellCompressed: metrics.shellCompressed + 1 });
    return maybeCompressToHandle(
      "shell",
      combined,
      { mode: "generic" },
      12_000,
    ).startsWith("[CTX_HANDLE")
      ? maybeCompressToHandle("shell", combined, { mode: "generic" }, 12_000)
      : `[shell truncated ${lines.length}L]\n${head}\n…\n${tail}`;
  }
  return combined;
}

// ── Compose (task-oriented preload hints) ──────────────────────────────────

export type ComposeResult = {
  task: string;
  keywords: string[];
  suggestedPaths: string[];
  notes: string;
};

/** Lightweight keyword extraction + path ranking from a task string + optional tree listing. */
export function composeContext(
  task: string,
  fileList: string[] = [],
): ComposeResult {
  const lower = (task || "").toLowerCase();
  const keywords = Array.from(
    new Set(
      (lower.match(/\b[a-z][a-z0-9_-]{2,}\b/g) || [])
        .filter(
          (w) =>
            ![
              "the",
              "and",
              "for",
              "with",
              "from",
              "that",
              "this",
              "please",
              "make",
              "create",
              "add",
              "fix",
              "fix",
              "file",
              "code",
              "project",
            ].includes(w),
        )
        .slice(0, 16),
    ),
  );

  const scored = fileList.map((p) => {
    const pl = p.toLowerCase();
    let score = 0;
    for (const k of keywords) {
      if (pl.includes(k)) score += 3;
      if (pl.split(/[\\/]/).pop()?.includes(k)) score += 2;
    }
    if (/\.(ts|tsx|kt|java|py|gradle)$/.test(pl)) score += 1;
    if (/readme|package\.json|app\.config|build\.gradle|androidmanifest/i.test(pl)) score += 2;
    return { p, score };
  });
  scored.sort((a, b) => b.score - a.score);
  const suggestedPaths = scored.filter((x) => x.score > 0).slice(0, 12).map((x) => x.p);

  const notes = [
    keywords.length ? `keywords: ${keywords.join(", ")}` : "keywords: (none extracted)",
    suggestedPaths.length
      ? `read first (signatures/map): ${suggestedPaths.slice(0, 6).join(", ")}`
      : "no path ranking — provide project file list for better compose",
    "prefer fs.read mode=signatures|map before full; use ctx.expand for handles",
  ].join("\n");

  return { task: task.slice(0, 400), keywords, suggestedPaths, notes };
}

/** Summary line for overlay / status. */
export function formatMetricsLine(m: ContextMetrics = metrics): string {
  const saved =
    m.tokensEstRaw > 0
      ? Math.round((1 - m.tokensEstEmitted / Math.max(1, m.tokensEstRaw)) * 100)
      : 0;
  return `ctx r=${m.reads} hit=${m.cacheHits} ~tok ${m.tokensEstEmitted}/${m.tokensEstRaw} (−${saved}%) sh=${m.shellCompressed}`;
}
