/** Only fixed enums and code-shaped identifiers cross into persistent diagnostics. */
export type CandidateDiagnosticStage = "press" | "confirmation-open" | "cancel" | "confirm" | "dispatch" | "result";
const REASONS: Record<string, string> = {
  OK: "success", AIB_FULL_CANDIDATE_REJECTED: "native_rejected",
  AIB_FULL_CANDIDATE_SESSION_DISABLED: "session_disabled",
  AIB_FULL_CANDIDATE_UNAVAILABLE: "runtime_unavailable", AIB_FULL_CANDIDATE_PRIVATE_RUNTIME_REQUIRED: "private_runtime_required",
  AIB_FULL_CANDIDATE_RELEASE_EXPIRED: "release_expired", AIB_FULL_CANDIDATE_CANCELLED: "cancelled",
  AIB_FULL_CANDIDATE_BUSY: "busy", AIB_FULL_CANDIDATE_TIMEOUT: "timeout", AIB_FULL_CANDIDATE_TRUNCATED: "output_truncated",
  AIB_FULL_CANDIDATE_UNCONFIRMED: "unconfirmed", AIB_FULL_CANDIDATE_ARGUMENT_INVALID: "invalid_arguments",
  AIB_FULL_CANDIDATE_SELECTION_INVALID: "invalid_selection", AIB_FULL_CANDIDATE_SELECTION_REQUIRED: "selection_required",
  AIB_FULL_CANDIDATE_BOOTSTRAP_INCOMPATIBLE: "bootstrap_incompatible", AIB_FULL_CANDIDATE_BOOTSTRAP_REMOVAL_FORBIDDEN: "protected_removal",
  EMBEDDED_EXEC_UNAVAILABLE: "runtime_unavailable", EMBEDDED_CANCEL_UNAVAILABLE: "cancel_unavailable",
  EMBEDDED_EXEC_RESULT_INVALID: "invalid_native_result", EMBEDDED_EXEC_CANCELLED: "cancelled",
};
const NATIVE_REASONS = ["ANDROID_ASSET_DIRECTORY_INVALID", "ANDROID_ASSET_EXTRA_DIRECTORY", "ANDROID_ASSET_EXTRA_FILE", "ANDROID_ASSET_HASH_MISMATCH", "ANDROID_ASSET_INCOMPLETE", "ANDROID_ASSET_SYMLINK", "ARCH_INVALID", "ASSET_FILE_SET_MISMATCH", "ASSET_HASH_MISMATCH", "ASSET_MISMATCH", "ASSET_OVERSIZE", "ASSET_SPECIAL", "ASSET_SYMLINK", "CACHE_EXTRA_DIRECTORY", "CACHE_EXTRA_FILE", "CACHE_FILE_SET_INVALID", "CACHE_HASH_INVALID", "CACHE_OBJECT_INVALID", "CACHE_OWNER_INVALID", "CACHE_SIZE_INVALID", "CACHE_UNREADABLE", "DIRECTORY_INVALID", "EXPECTED_82_PACKAGES", "EXPECTED_EXACT_SOURCE_FILES", "FILESDIR_NONCANONICAL", "FILESDIR_UNREADABLE", "INVENTORY_ENTRY_MISSING", "KEY_PIN_MISMATCH", "LOCAL_PINS_HASH_MISMATCH", "LOCAL_PINS_INVALID", "LOCAL_PINS_NOT_FINALIZED", "LOCAL_PINS_SHAPE_INVALID", "LOCAL_SCRIPT_PIN_INVALID", "PACKAGE_INVALID", "PACKAGE_INVENTORY_MISMATCH", "PACKAGE_NAME_INVALID", "PARENT_CREATE_FAILED", "PARTIAL_STAGE_LIMIT", "PIN_INVALID", "PINNED_DOCUMENTS_MISMATCH", "STAGE_COMMIT_FAILED", "STAGE_CREATE_FAILED", "TARGET_INVALID", "USRHOME_NONCANONICAL", "NATIVE_FAILURE", "ARGUMENT_INVALID", "SECURITY_DENIED", "IO_ACCESS_DENIED", "IO_NOT_FOUND", "IO_NO_SPACE", "IO_SYMLINK_LOOP", "IO_NOT_DIRECTORY", "IO_READ_ONLY", "IO_FAILURE"] as const;
for (const phase of ["STAGE", "TRANSACTION"] as const) {
  for (const reason of NATIVE_REASONS) REASONS[`AIB_FULL_CANDIDATE_${phase}_${reason}`] = `${phase.toLowerCase()}:${reason.toLowerCase()}`;
}
for (const action of ["verify", "check", "install", "reinstall", "remove"]) REASONS[`AIB_FULL_CANDIDATE_OK:${action}`] = "success";
const SAFE_CODES = new Set([...Object.keys(REASONS), "AIB_FULL_CANDIDATE_OK"]);
const DIAGNOSTIC_PHASES = new Set(["preflight", "native_rejection", "result_validation"]);
const DIAGNOSTIC_REASONS = new Set(["CANDIDATE_PREFLIGHT_REJECTED", "CANDIDATE_NATIVE_REJECTED", "CANDIDATE_NATIVE_TIMEOUT", "CANDIDATE_OUTPUT_TRUNCATED", "CANDIDATE_NONZERO_EXIT", "CANDIDATE_CONFIRMATION_NOT_PROVEN", "CANDIDATE_CONFIRMED"]);
function safeMetric(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? Math.min(1_000_000, value as number) : null;
}
export function classifyCandidateDiagnostic(input: { action: unknown; stage: unknown; code?: unknown; durationMs?: unknown; attemptId: unknown;
  diagnosticPhase?: unknown; diagnosticReasonCode?: unknown; exitCode?: unknown; timedOut?: unknown; outputTruncated?: unknown;
  stdoutChars?: unknown; stderrChars?: unknown; stdoutBytes?: unknown; stderrBytes?: unknown }) {
  const action = ["verify", "install", "reinstall", "remove", "check"].includes(String(input.action)) ? String(input.action) : "unknown";
  const stage = (["press", "confirmation-open", "cancel", "confirm", "dispatch", "result"] as unknown[]).includes(input.stage) ? input.stage as CandidateDiagnosticStage : "result";
  const raw = typeof input.code === "string" && (input.code === "OK" || SAFE_CODES.has(input.code)) ? input.code : "UNCLASSIFIED";
  const attemptId = typeof input.attemptId === "string" && /^fc-[0-9a-z-]{1,48}$/.test(input.attemptId) ? input.attemptId : "fc-invalid";
  const durationMs = Number.isFinite(input.durationMs) ? Math.max(0, Math.min(1800000, Math.floor(input.durationMs as number))) : null;
  const nativePhase = raw.startsWith("AIB_FULL_CANDIDATE_STAGE_") ? "stage" : raw.startsWith("AIB_FULL_CANDIDATE_TRANSACTION_") ? "transaction" : "none";
  const diagnosticDetailsProvided = [input.diagnosticPhase, input.diagnosticReasonCode, input.exitCode, input.timedOut, input.outputTruncated,
    input.stdoutChars, input.stderrChars, input.stdoutBytes, input.stderrBytes].some(value => value !== undefined);
  const details = diagnosticDetailsProvided ? {
    diagnosticPhase: DIAGNOSTIC_PHASES.has(String(input.diagnosticPhase)) ? String(input.diagnosticPhase) : "unknown",
    diagnosticReasonCode: typeof input.diagnosticReasonCode === "string" && DIAGNOSTIC_REASONS.has(input.diagnosticReasonCode) ? input.diagnosticReasonCode : "UNCLASSIFIED",
    exitCode: Number.isInteger(input.exitCode) && (input.exitCode as number) >= -1 && (input.exitCode as number) <= 255 ? input.exitCode as number : null,
    timedOut: typeof input.timedOut === "boolean" ? input.timedOut : null,
    outputTruncated: typeof input.outputTruncated === "boolean" ? input.outputTruncated : null,
    stdoutChars: safeMetric(input.stdoutChars), stderrChars: safeMetric(input.stderrChars),
    stdoutBytes: safeMetric(input.stdoutBytes), stderrBytes: safeMetric(input.stderrBytes),
  } : {};
  return { action, stage, nativePhase, resultCode: raw, nativeCode: SAFE_CODES.has(raw) ? raw : "none", reasonCategory: REASONS[raw] ?? (SAFE_CODES.has(raw) ? "native_reason" : "unclassified"), durationMs, attemptId, ...details };
}
