import { readEmbeddedCandidateApplyLog } from "./termux-bridge";

const TRANSACTION_ID = /^tx-[A-Za-z0-9-]{12,80}$/;
const MAX_LOG_BYTES = 64 * 1024;
const MAX_OUTPUT_CHARS = 12_000;
const ACTIONS = new Set(["verify", "install", "reinstall", "remove", "check"]);
const DIAGNOSTIC_REASONS = new Set([
  "CANDIDATE_PREFLIGHT_REJECTED",
  "CANDIDATE_NATIVE_REJECTED",
  "CANDIDATE_NATIVE_TIMEOUT",
  "CANDIDATE_OUTPUT_TRUNCATED",
  "CANDIDATE_NONZERO_EXIT",
  "CANDIDATE_CONFIRMATION_NOT_PROVEN",
  "CANDIDATE_CONFIRMED",
]);

export interface CandidateApplyLogDiagnostic {
  transactionId: string;
  content: string;
  byteLength: number;
  truncated: boolean;
}

export interface CandidateFailureLogInput {
  action: unknown;
  attemptId: unknown;
  resultCode: unknown;
  evidencePath: unknown;
  output: unknown;
  diagnostics?: unknown;
}

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
  }
  return bytes;
}

/** Accepts only the exact app-private transaction marker emitted by the fixed candidate script. */
export function candidateTransactionIdFromEvidencePath(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^\/data\/(?:user\/0|data)\/com\.karat\.aibuilder\/files\/candidate-transactions\/(tx-[A-Za-z0-9-]{12,80})$/.exec(value);
  return match && TRANSACTION_ID.test(match[1]) ? match[1] : undefined;
}

/** Redaction for the small result preview shown in the UI; raw apply.log is never persisted. */
export function redactCandidateLog(value: string): string {
  return value
    .replace(/\b((?:https?|ftp):\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[REDACTED]@")
    .replace(/\b(?:https?|ftp):\/\/[^\s"'<>]*/gi, "[URL]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]")
    .replace(/\b["']?(password|passwd|token|secret|api[_-]?key|authorization)\b["']?(\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;]+)/gi, "$1$2[REDACTED]")
    .replace(/\/data\/(?:user\/0|data)\/com\.karat\.aibuilder(?:\/[^\s"'<>]*)?/g, "[APP_PRIVATE_PATH]")
    .replace(/\/home\/[^/\s]+/g, "[HOME_PATH]");
}

/** Reads only the exact failed transaction; a missing ID never falls back to a newer check/verify. */
export async function readCandidateApplyLog(evidencePath: unknown): Promise<CandidateApplyLogDiagnostic> {
  const transactionId = candidateTransactionIdFromEvidencePath(evidencePath);
  if (!transactionId) throw new Error("AIB_CANDIDATE_APPLY_LOG_PATH_INVALID");
  const result = await readEmbeddedCandidateApplyLog(transactionId);
  if (!result || !TRANSACTION_ID.test(result.transactionId) || typeof result.content !== "string" ||
      !Number.isSafeInteger(result.byteLength) || result.byteLength < 0 || result.byteLength > MAX_LOG_BYTES ||
      utf8ByteLength(result.content) !== result.byteLength || typeof result.truncated !== "boolean" ||
      result.transactionId !== transactionId) {
    throw new Error("AIB_CANDIDATE_APPLY_LOG_RESULT_INVALID");
  }
  return { ...result, content: redactCandidateLog(result.content) };
}

function safeFailureStage(output: string): { stage: string; packageName?: string } {
  const boundedOutput = output.slice(-MAX_OUTPUT_CHARS);
  const markerPattern = /AIB_FULL_CANDIDATE_FAIL:\s*([^\r\n]*)/g;
  let marker = markerPattern.exec(boundedOutput);
  let reason = "";
  while (marker) {
    reason = marker[1].trim();
    marker = markerPattern.exec(boundedOutput);
  }
  if (/^coherent install transaction failed$/i.test(reason)) return { stage: "APT_APPLY_FAILED" };
  if (/^remove transaction failed$/i.test(reason)) return { stage: "APT_REMOVE_FAILED" };
  if (/^authenticated APT update failed$/i.test(reason)) return { stage: "APT_UPDATE_FAILED" };
  if (/^coherent APT plan failed$/i.test(reason)) return { stage: "APT_PLAN_FAILED" };
  if (/^authenticated archive download failed$/i.test(reason)) return { stage: "APT_ARCHIVE_DOWNLOAD_FAILED" };
  const registry = /^private registry outcome mismatch:\s*([a-z0-9][a-z0-9+.-]{0,127})$/i.exec(reason);
  if (registry) return { stage: "POST_APT_DPKG_VERIFY_FAILED", packageName: registry[1] };
  const remains = /^package remains installed:\s*([a-z0-9][a-z0-9+.-]{0,127})$/i.exec(reason);
  if (remains) return { stage: "POST_APT_REMOVE_VERIFY_FAILED", packageName: remains[1] };
  if (/^installed payload hash mismatch/i.test(reason)) return { stage: "POST_APT_PAYLOAD_HASH_VERIFY_FAILED" };
  if (/^(installed (?:file missing|conffile missing\/redirected|link mismatch|directory mismatch)|redirected installed ancestor):/i.test(reason)) {
    return { stage: "POST_APT_PAYLOAD_VERIFY_FAILED" };
  }
  if (reason) return { stage: "CANDIDATE_STAGE_FAILED" };
  return { stage: "CANDIDATE_FAILURE_UNCLASSIFIED" };
}

function aptFailureDetail(content: string): { category: string; dpkgExitCode?: number } {
  const lower = content.toLowerCase();
  if (!content) return { category: "APT_LOG_EMPTY" };
  if (lower.includes("no space left on device")) return { category: "STORAGE_EXHAUSTED" };
  if (lower.includes("could not get lock") || lower.includes("unable to acquire the dpkg frontend lock")) {
    return { category: "PACKAGE_MANAGER_LOCKED" };
  }
  if (lower.includes("failed to fetch") || lower.includes("could not resolve") || lower.includes("temporary failure resolving")) {
    return { category: "APT_FETCH_FAILED" };
  }
  if (lower.includes("unable to locate package")) return { category: "APT_PACKAGE_NOT_FOUND" };
  if (lower.includes("hash sum mismatch") || lower.includes("hash mismatch")) return { category: "PACKAGE_HASH_MISMATCH" };
  const postinst = /post-installation script[^\n]*?(?:returned error exit status|exit status)\s+(\d{1,3})/i.exec(content);
  if (postinst) return { category: "PACKAGE_POST_INSTALL_SCRIPT_FAILED", dpkgExitCode: Number(postinst[1]) };
  if (lower.includes("error unpacking") || lower.includes("dpkg: error processing archive")) {
    return { category: "DPKG_ARCHIVE_FAILED" };
  }
  if (lower.includes("dependency problems prevent configuration") || lower.includes("unmet dependencies") || lower.includes("held broken packages")) {
    return { category: "DEPENDENCY_FAILURE" };
  }
  const dpkg = /(?:dpkg|\[(?:APP_PRIVATE|HOME)_PATH\]) returned an error code\s*\((\d{1,3})\)/i.exec(content);
  if (dpkg) return { category: "DPKG_FAILED", dpkgExitCode: Number(dpkg[1]) };
  return { category: "APT_FAILURE_UNCLASSIFIED" };
}

function safeApplyLogReadError(error: unknown): string {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const code = /^AIB_CANDIDATE_APPLY_LOG_[A-Z0-9_]{1,64}$/.exec(raw)?.[0];
  if (!code) return "AIB_CANDIDATE_APPLY_LOG_READ_FAILED";
  return code;
}

/**
 * Builds a bounded structured record for the ordinary persistent log. It stores
 * validated transaction identity and symbolic APT/post-install details only;
 * raw shell output, APT output, credentials and absolute paths are never returned.
 */
export async function buildCandidateFailureLogEntry(input: CandidateFailureLogInput): Promise<string> {
  const action = typeof input.action === "string" && ACTIONS.has(input.action) ? input.action : "unknown";
  const attemptId = typeof input.attemptId === "string" && /^fc-[A-Za-z0-9-]{1,80}$/.test(input.attemptId) ? input.attemptId : "unknown";
  const transactionId = candidateTransactionIdFromEvidencePath(input.evidencePath) ?? null;
  const resultCode = typeof input.resultCode === "string" && /^AIB_FULL_CANDIDATE_[A-Z0-9_:-]{1,80}$/.test(input.resultCode)
    ? input.resultCode : "AIB_FULL_CANDIDATE_UNCONFIRMED";
  const output = typeof input.output === "string" ? input.output : "";
  const failure = safeFailureStage(output);
  const partialMutation = output.slice(-MAX_OUTPUT_CHARS).includes("AIB_FULL_CANDIDATE_PARTIAL_RUNTIME_REPAIR_REQUIRED");
  const diagnostic = input.diagnostics && typeof input.diagnostics === "object" ? input.diagnostics as Record<string, unknown> : {};
  const diagnosticPhase = ["preflight", "native_rejection", "result_validation"].includes(String(diagnostic.phase)) ? String(diagnostic.phase) : "unknown";
  const diagnosticReasonCode = typeof diagnostic.reasonCode === "string" && DIAGNOSTIC_REASONS.has(diagnostic.reasonCode)
    ? diagnostic.reasonCode : "unknown";
  const candidateExitCode = typeof diagnostic.exitCode === "number" && Number.isSafeInteger(diagnostic.exitCode) ? diagnostic.exitCode : null;
  const timedOut = typeof diagnostic.timedOut === "boolean" ? diagnostic.timedOut : null;
  const outputTruncated = typeof diagnostic.outputTruncated === "boolean" ? diagnostic.outputTruncated : null;

  let applyLogStatus = "not_required";
  let applyLogTruncated: boolean | null = null;
  let aptDetail: string | null = null;
  let dpkgExitCode: number | null = null;
  if (failure.stage === "APT_APPLY_FAILED" || failure.stage === "APT_REMOVE_FAILED") {
    if (!transactionId) {
      applyLogStatus = "transaction_id_unavailable";
    } else {
      try {
        const log = await readCandidateApplyLog(input.evidencePath);
        if (log.transactionId !== transactionId) {
          applyLogStatus = "transaction_mismatch";
        } else {
          applyLogStatus = "read";
          applyLogTruncated = log.truncated;
          const detail = aptFailureDetail(log.content);
          aptDetail = detail.category;
          dpkgExitCode = detail.dpkgExitCode ?? null;
        }
      } catch (error) {
        const code = safeApplyLogReadError(error);
        applyLogStatus = code === "AIB_CANDIDATE_APPLY_LOG_NOT_FOUND" ? "not_found" : code.replace("AIB_CANDIDATE_APPLY_LOG_", "").toLowerCase();
      }
    }
  }

  const record = {
    schema: "AIB_CANDIDATE_FAILURE_V1",
    action,
    attemptId,
    transactionId,
    resultCode,
    failureStage: failure.stage,
    ...(failure.packageName ? { packageName: failure.packageName } : {}),
    candidateExitCode,
    diagnosticPhase,
    diagnosticReasonCode,
    timedOut,
    outputTruncated,
    partialMutation,
    applyLogStatus,
    applyLogTruncated,
    aptDetail,
    dpkgExitCode,
  };
  return JSON.stringify(record);
}
