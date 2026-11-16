/**
 * Centralized redaction rules for persistent/application logs.
 * Keep this module dependency-free so all log surfaces can reuse the same rules.
 */

import { sanitizeCommandOutputSummary, utf8ByteLengthForDiagnostics } from "./command-log-redaction.ts";

export function redactSecrets(value: string): string {
  return String(value ?? "")
    // Authorization headers / bearer tokens.
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/(authorization\s*[:=]\s*)["']?[^\s,;}"']+["']?/gi, "$1[REDACTED]")
    .replace(/(x-api-key|x-goog-api-key|api-key)\s*[:=]\s*["']?[^\s,;}"']+["']?/gi, "$1: [REDACTED]")
    .replace(/(\bbearer\s+)[A-Za-z0-9._~+/=\-]{8,}/gi, "$1[REDACTED]")
    // Provider token formats commonly seen in logs. Keep the prefix only.
    .replace(/\bsk-(?:proj-|ant-|or-v1-)?[A-Za-z0-9_-]{8,}/g, "sk-[REDACTED]")
    .replace(/\bor-[A-Za-z0-9_-]{8,}/g, "or-[REDACTED]")
    .replace(/\bghp_[A-Za-z0-9_]{12,}/g, "ghp_[REDACTED]")
    .replace(/\bgho_[A-Za-z0-9_]{12,}/g, "gho_[REDACTED]")
    .replace(/\bgha_[A-Za-z0-9_]{12,}/g, "gha_[REDACTED]")
    .replace(/\bghu_[A-Za-z0-9_]{12,}/g, "ghu_[REDACTED]")
    .replace(/\bghr_[A-Za-z0-9_]{12,}/g, "ghr_[REDACTED]")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{12,}/g, "github_pat_[REDACTED]")
    .replace(/\bglpat-[A-Za-z0-9_-]{8,}/gi, "glpat-[REDACTED]")
    .replace(/\bxai-[A-Za-z0-9_-]{8,}/g, "xai-[REDACTED]")
    .replace(/\bAIza[0-9A-Za-z_-]{20,}/g, "AIza[REDACTED]")
    // Common machine credentials that may appear without an explicit field name.
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "AKIA[REDACTED]")
    .replace(/\bASIA[0-9A-Z]{16}\b/g, "ASIA[REDACTED]")
    // JWTs are bearer credentials even when they are logged as plain values.
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[REDACTED_JWT]")
    // Basic auth and cookie credentials are commonly exposed by request/debug dumps.
    .replace(/(\bbasic\s+)[A-Za-z0-9+/=]{12,}/gi, "$1[REDACTED]")
    .replace(/(\b(?:cookie|set-cookie)\s*[:=]\s*)[^\r\n]+/gi, "$1[REDACTED]")
    // PEM private keys must never reach persistent storage.
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]")
    // Query-string credentials. Also redact URL userinfo (https://user:pass@host).
    .replace(/([?&](?:key|api[_-]?key|apikey|token|access_token|authorization|secret|password|client_secret)=)[^&\s]+/gi, "$1[REDACTED]")
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[REDACTED]:[REDACTED]@")
    // Credential-like CLI flags.
    .replace(/(\s--?(?:api[-_]?key|token|access[-_]?token|secret|password|passwd|credential|auth(?:orization)?)(?:=|\s+))["']?[^\s"']+["']?/gi, "$1[REDACTED]")
    // Package-manager and environment credential forms.
    .replace(/(^|[\s,{;])(_?npm_config_?(?:_authToken|authToken)|npm_token)\s*[=:]\s*["']?[^\s,;}"']+["']?/gim, "$1$2=[REDACTED]")
    .replace(/(^|[\s,{;])(?:[A-Z0-9_]*(?:API[_-]?KEY|ACCESS[_-]?TOKEN|AUTH[_-]?TOKEN|CLIENT[_-]?SECRET|PASSWORD|SECRET|PRIVATE[_-]?KEY))\s*[=:]\s*["']?[^\s,;}"']+["']?/g, "$1[REDACTED_SECRET]")
    // JSON/object-style credential fields, including single-quoted values.
    .replace(/("?(?:api[_-]?key|apikey|apiKey|token|access_token|authorization|secret|password|client_secret)"?\s*[:=]\s*)["'][^"']*["']/gi, '$1"[REDACTED]"')
    .replace(/(\b(?:api[_-]?key|apikey|apiKey|token|access_token|authorization|secret|password|client_secret)\b\s*[:=]\s*)[^\s,;}]+/gi, "$1[REDACTED]")
    // URLs can disclose private hosts, repository/project paths, signed URLs,
    // and non-credential query data; logs keep the event/status, not the URI.
    .replace(/\b(?:https?|wss?|file|content|github):\/\/[^\s<>"'`]+/gi, "[URL_REDACTED]");
}

/** Redact build output before it is persisted, shown in diagnostics, or sent for recovery. */
export function redactBuildDiagnostics(value: string, projectRoot?: string): string {
  let safe = String(value ?? "")
    .replace(/\u001B\[[0-9;]*m/g, "")
    .replace(/\0/g, "");
  const root = String(projectRoot ?? "").trim();
  if (root.length > 1) safe = safe.split(root).join("[PROJECT_ROOT]");
  return redactSecrets(safe)
    .replace(/\/storage\/emulated\/0(?:\/[^\s"'<>]*)?/gi, "[PRIVATE_PATH]")
    .replace(/\/sdcard(?:\/[^\s"'<>]*)?/gi, "[PRIVATE_PATH]")
    .replace(/\/data\/data\/[^/\s:]+(?:\/[^\s:]+)*/gi, "[PRIVATE_PATH]")
    .replace(/\/home\/[^/\s:]+(?:\/[^\s:]+)*/gi, "[PRIVATE_PATH]")
    .replace(/\/data\/(?:data\/[^/\s:]+|user\/\d+\/[^/\s:]+)\/files\/home\/[^/\s:]+/g, "/data/data/[APP]/files/home/[PROJECT]")
    .replace(/\/storage\/emulated\/0\/[^/\s:]+\/[^/\s:]+/g, "/storage/emulated/0/[APP]/[PROJECT]")
    .replace(/\/home\/[^/\s:]+\/[^/\s:]+/g, "/home/[USER]/[PROJECT]")
    .replace(/\/Users\/[^/\s:]+\/[^/\s:]+/g, "/Users/[USER]/[PROJECT]")
    .replace(/[A-Za-z]:\\Users\\[^\\\s:]+\\[^\\\s:]+/g, "[PRIVATE_PATH]");
}

/** Omit free-form conversation content from persistent diagnostic logs. */
export function redactPersistentLogPayload(tag: string, value: string): string {
  const text = String(value ?? "");
  const normalizedTag = String(tag ?? "").trim().toLowerCase();
  if (normalizedTag === "termuxsmoke") {
    // Keep only exact AI Builder-owned runtime paths requested for this smoke
    // report. Other private paths, URLs and credentials still go through the
    // normal redaction rules, including any external Termux home/prefix.
    const preservedPaths: string[] = [];
    let safe = text.replace(
      /\/data\/(?:user\/\d+|data)\/com\.karat\.aibuilder(?:\/files(?:\/usr)?)?(?=$|[\s,;])/g,
      (match) => {
        const marker = `__AIB_TERMUX_SMOKE_PATH_${preservedPaths.length}__`;
        preservedPaths.push(match);
        return marker;
      },
    );
    safe = safe.replace(/\/storage\/emulated\/0\/AIBuilderTermux(?=$|[\s,;])/g, (match) => {
      const marker = `__AIB_TERMUX_SMOKE_PATH_${preservedPaths.length}__`;
      preservedPaths.push(match);
      return marker;
    });
    safe = redactBuildDiagnostics(safe);
    return preservedPaths.reduce(
      (result, path, index) => result.replaceAll(`__AIB_TERMUX_SMOKE_PATH_${index}__`, path),
      safe,
    );
  }
  if (/^(?:termux|linux(?::[^:]+)*):.*:(?:stdout|stderr)$/.test(normalizedTag) || /^termux:(?:stdout|stderr)$/.test(normalizedTag)) {
    // runShellCommand already converts callback output to an allowlisted summary.
    // Validate that summary rather than summarizing its text a second time (which
    // used to log the summary's 71/122 chars instead of the callback's 25/77).
    const existingSummary = sanitizeCommandOutputSummary(text);
    if (existingSummary) return existingSummary;
    const safeMarkers = new Set([
      "AIB_PROBE_BEGIN", "AIB_PROBE_END", "AIB_LIST_BEGIN", "AIB_LIST_END", "AIB_LOGIN_BEGIN", "AIB_LOGIN_END",
      "AIB_LIST_MODE:quiet", "AIB_LIST_MODE:human",
      "AIB_PROOT_TOOL:AVAILABLE", "AIB_PROOT_TOOL:MISSING", "AIB_LIST_EXIT:0", "AIB_LIST_EXIT:1", "AIB_LOGIN_EXIT:0", "AIB_LOGIN_EXIT:1",
      "AIB_PROBE_ID:ubuntu", "AIB_PROBE_ID:debian", "ROOTFS_STATE_UNVERIFIED:ubuntu", "ROOTFS_STATE_UNVERIFIED:debian",
      "ROOTFS_ALREADY_HEALTHY:ubuntu", "ROOTFS_ALREADY_HEALTHY:debian", "ROOTFS_INSTALLED_LOGIN_FAILED:ubuntu", "ROOTFS_INSTALLED_LOGIN_FAILED:debian",
      "AIB_UBUNTU_ROOTFS_OK", "AIB_DEBIAN_ROOTFS_OK", "AIB_UBUNTU_ROOTFS_MISSING", "AIB_DEBIAN_ROOTFS_MISSING",
      "AIB_UBUNTU_ROOTFS_STATE_UNVERIFIED", "AIB_DEBIAN_ROOTFS_STATE_UNVERIFIED",
    ]);
    const markers = [...new Set(text.split(/\r?\n/).map((line) => line.trim()).filter((line) => safeMarkers.has(line)))].slice(0, 32);
    return markers.length
      ? `[SAFE_MARKERS ${markers.join(" ")}] [OTHER_OUTPUT_OMITTED chars=${text.length} utf8Bytes=${utf8ByteLengthForDiagnostics(text)}]`
      : `[COMMAND_OUTPUT_OMITTED chars=${text.length} utf8Bytes=${utf8ByteLengthForDiagnostics(text)} lines=${text.split(/\r?\n/).length}]`;
  }
  if (normalizedTag === "console") return `[CONSOLE_TEXT_OMITTED chars=${text.length}]`;
  if (["crash", "globalerror", "unhandledrejection"].includes(normalizedTag)) {
    const name = text.match(/\b(?:Error|Exception|TypeError|RangeError|ReferenceError|SyntaxError|AbortError|SecurityException)\b/)?.[0] ?? "Error";
    const lower = text.toLowerCase();
    const category = /permission|securityexception|eacces|eperm/.test(lower) ? "permission-denied"
      : /timeout|timed out|deadline/.test(lower) ? "timeout"
        : /cancel|abort|interrupt/.test(lower) ? "cancelled"
          : /network|fetch|socket|dns/.test(lower) ? "network"
            : /undefined is not (a )?function|is not a function/.test(lower) ? "undefined-function"
              : /cannot read propert/.test(lower) ? "undefined-property"
                : "unknown";
    // Keep a safe diagnostic slice so the agent can self-correct render/runtime crashes.
    // Strip secrets/paths with user data; keep error kind, short message, and file:line frames.
    // Prefer "TypeError: …" then any first-line text after a colon; always keep something for self-repair.
    const msgMatch =
      text.match(/\b(?:TypeError|ReferenceError|RangeError|SyntaxError):\s*([^\n]{1,160})/i) ||
      text.match(/\bError:\s*([^\n]{1,160})/i);
    let safeMsg = (msgMatch && msgMatch[1] ? msgMatch[1] : "")
      .replace(/https?:\/\/\S+/gi, "[url]")
      .replace(/\/[\w./-]*storage\/[\w./-]*/gi, "[path]")
      .replace(/[A-Za-z0-9+/]{40,}/g, "[tok]")
      .trim()
      .slice(0, 140);
    if (!safeMsg) {
      const firstLine = String(text).split(/\r?\n/)[0] || "";
      safeMsg = firstLine
        .replace(/\[RENDER ERROR\]\s*/i, "")
        .replace(/\[JS ERROR\]\s*/i, "")
        .replace(/\[FATAL\]\s*/i, "")
        .replace(/https?:\/\/\S+/gi, "[url]")
        .trim()
        .slice(0, 140);
    }
    // Hermes stacks often use "index.android.bundle:line:col" without source paths.
    const frames = [
      ...text.matchAll(/(?:at\s+)?([A-Za-z0-9_./()-]+\.(?:tsx?|jsx?|mjs)):(\d+)(?::(\d+))?/g),
      ...text.matchAll(/(?:at\s+)?(index\.android\.bundle):(\d+)(?::(\d+))?/g),
      ...text.matchAll(/\(address at ([^)]+):(\d+):(\d+)\)/g),
    ]
      .slice(0, 8)
      .map((m) => {
        const file = String(m[1] || "").split("/").slice(-2).join("/") || "bundle";
        return m[3] ? `${file}:${m[2]}:${m[3]}` : `${file}:${m[2]}`;
      })
      .join("|");
    const components = [...text.matchAll(/\bin\s+([A-Z][A-Za-z0-9_]{1,60})/g)]
      .map((m) => m[1])
      .filter((n, i, a) => a.indexOf(n) === i)
      .slice(0, 8)
      .join(">");
    return `[EXCEPTION name=${name} category=${category}${safeMsg ? ` msg=${safeMsg}` : ""}${frames ? ` stack=${frames}` : ""}${components ? ` components=${components}` : ""}]`;
  }
  if ((normalizedTag === "termux" || normalizedTag.endsWith(":command")) && /^\s*(?:\$\s|guest command\b)/i.test(text)) {
    return `[SHELL_COMMAND_OMITTED chars=${text.length}]`;
  }
  if (normalizedTag === "agenttool") {
    const direction = text.match(/^\s*([→←×])/u)?.[1] ?? "•";
    const tool = text.match(/\btool=([A-Za-z0-9][A-Za-z0-9._-]{0,79})/)?.[1] ?? "unknown";
    const traceId = text.match(/\btraceId=([A-Za-z0-9._-]{1,96}|-)/)?.[1] ?? "-";
    const exitValue = text.match(/\bexit=(-?\d{1,4}|ok|failed)\b/i)?.[1] ?? "pending";
    const durationMs = text.match(/\bdurationMs=(\d{1,10})\b/)?.[1];
    return `${direction} tool=${tool} traceId=${traceId} exit=${exitValue}${durationMs ? ` durationMs=${durationMs}` : ""} [TOOL_PAYLOAD_OMITTED chars=${text.length}]`;
  }
  if (normalizedTag === "fileintake") {
    // File names and archive-member paths are private user data. Preserve only
    // event names and a narrow allowlist of diagnostic metadata, including for
    // legacy entries re-redacted during persistent-log hydration.
    const event = text.match(/^(CACHE_HIT|MAGIC_MISMATCH|ARCHIVE_INSPECT|READY|PRE_ANALYSIS_FAILED|ACTION_PICKER|ACTION_SELECTED)\b/)?.[1] || "FILE_INTAKE_EVENT";
    const fields = [...text.matchAll(/\b(type|extension|size|actions|durationMs|entries|extracted|safe|warningCount|magicType|extensionType|action)=([A-Za-z0-9_,.-]+)/g)]
      .map((match) => `${match[1]}=${match[2]}`);
    return `[FILE_INTAKE ${[event, ...fields].join(" ")}]`;
  }
  if (normalizedTag === "chat") {
    // Preserve only the current metadata-only request marker. All other Chat
    // records (including legacy request bodies) are treated as private text.
    if (/^Отправка запроса mode=[^\r\n]* chars=\d+$/u.test(text)) {
      return redactBuildDiagnostics(text);
    }
    return `[CHAT_CONTENT_OMITTED chars=${text.length}]`;
  }
  if (normalizedTag === "advisor" || normalizedTag === "reviewer") {
    return `[MODEL_RESPONSE_OMITTED chars=${text.length}]`;
  }
  if (normalizedTag === "termux" && /^Новая задача:/u.test(text.trim())) {
    return `[USER_TASK_OMITTED chars=${text.length}]`;
  }
  return redactBuildDiagnostics(text);
}
