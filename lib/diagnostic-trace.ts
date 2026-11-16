/** Privacy-safe, structured application trace records shared by UI, runtime and native bridges. */
export type TraceStatus = "started" | "progress" | "succeeded" | "failed" | "blocked" | "timed_out" | "cancelled";
export type TraceBackend = "app" | "termux" | "ubuntu-proot" | "provider" | "github" | "native" | "unknown";
export type TraceScreen = "app" | "runtime" | "termux" | "packages" | "github" | "settings" | "chat" | "build" | "unknown";
export type TraceErrorCategory =
  | "permission-denied" | "external-apps-disabled" | "callback-missing" | "callback-invalid"
  | "timeout" | "cancelled" | "native-module-missing" | "command-failed" | "output-truncated"
  | "network" | "http-error" | "empty-response" | "invalid-response" | "unknown";

export type DiagnosticTraceInput = Readonly<{
  correlationId?: string;
  commandId?: string;
  nativeCommandId?: string;
  action: string;
  step: string;
  status: TraceStatus;
  backend?: TraceBackend;
  target?: "termux" | "ubuntu" | "debian" | "provider" | "github" | "unknown";
  screen?: TraceScreen;
  durationMs?: number;
  timeoutMs?: number;
  exitCode?: number;
  stdoutBytes?: number;
  stderrBytes?: number;
  stdoutChars?: number;
  stderrChars?: number;
  outputMetricSource?: "normalized-callback-redacted";
  parserOutcome?: "healthy" | "missing" | "tool-unavailable" | "incomplete-envelope" | "evidence-conflict" | "architecture-mismatch" | "identity-unverified" | "list-unverified" | "installed-unhealthy";
  progressPercent?: number;
  attempt?: number;
  httpStatus?: number;
  resultCode?: "ready" | "missing" | "unknown" | "available" | "unavailable" | "valid" | "invalid" | "empty" | "truncated" | "installed" | "not-installed";
  errorCategory?: TraceErrorCategory;
  androidRunCommand?: "granted" | "missing" | "unknown";
  termuxExternalApps?: "allowed" | "blocked" | "unknown" | "not-observed";
}>;

export type DiagnosticTraceRecord = Readonly<{
  eventId: string;
  correlationId: string;
  commandId?: string;
  nativeCommandId?: string;
  action: string;
  step: string;
  status: TraceStatus;
  backend: TraceBackend;
  target: NonNullable<DiagnosticTraceInput["target"]>;
  screen: TraceScreen;
  durationMs?: number;
  timeoutMs?: number;
  exitCode?: number;
  stdoutBytes?: number;
  stderrBytes?: number;
  stdoutChars?: number;
  stderrChars?: number;
  outputMetricSource?: DiagnosticTraceInput["outputMetricSource"];
  parserOutcome?: DiagnosticTraceInput["parserOutcome"];
  progressPercent?: number;
  attempt?: number;
  httpStatus?: number;
  resultCode?: DiagnosticTraceInput["resultCode"];
  errorCategory?: TraceErrorCategory;
  androidRunCommand?: DiagnosticTraceInput["androidRunCommand"];
  termuxExternalApps?: DiagnosticTraceInput["termuxExternalApps"];
}>;

const BACKENDS = new Set<TraceBackend>(["app", "termux", "ubuntu-proot", "ubuntu-proot", "provider", "github", "native", "unknown"]);
const TARGETS = new Set<NonNullable<DiagnosticTraceInput["target"]>>(["termux", "ubuntu", "debian", "provider", "github", "unknown"]);
const SCREENS = new Set<TraceScreen>(["app", "runtime", "termux", "packages", "github", "settings", "chat", "build", "unknown"]);
const STATUSES = new Set<TraceStatus>(["started", "progress", "succeeded", "failed", "blocked", "timed_out", "cancelled"]);
const PARSER_OUTCOMES = new Set<NonNullable<DiagnosticTraceInput["parserOutcome"]>>([
  "healthy", "missing", "tool-unavailable", "incomplete-envelope", "evidence-conflict",
  "architecture-mismatch", "identity-unverified", "list-unverified", "installed-unhealthy",
]);
const ERRORS = new Set<TraceErrorCategory>([
  "permission-denied", "external-apps-disabled", "callback-missing", "callback-invalid", "timeout",
  "cancelled", "native-module-missing", "command-failed", "output-truncated", "network", "http-error",
  "empty-response", "invalid-response", "unknown",
]);
const RESULT_CODES = new Set(["ready", "missing", "unknown", "available", "unavailable", "valid", "invalid", "empty", "truncated", "installed", "not-installed"]);

function enumValue<T extends string>(value: unknown, allowed: Set<T>, fallback: T): T {
  return typeof value === "string" && allowed.has(value as T) ? value as T : fallback;
}

function boundedId(value: unknown, fallback: string): string {
  const text = typeof value === "string" ? value : "";
  return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/.test(text) ? text : fallback;
}

function boundedLabel(value: unknown, fallback: string): string {
  const text = typeof value === "string" ? value : "";
  return /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/.test(text) ? text : fallback;
}

function boundedCommandId(value: unknown): string | undefined {
  const text = typeof value === "string" ? value : "";
  return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/.test(text) ? text : undefined;
}

function boundedNativeCommandId(value: unknown): string | undefined {
  const text = typeof value === "string" ? value : "";
  return /^[a-f0-9]{32}$/.test(text) ? text : undefined;
}

function boundedInt(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

export function createTraceCorrelationId(prefix = "trace", now = Date.now(), random = Math.random()): string {
  const safePrefix = /^[A-Za-z][A-Za-z0-9_-]{0,19}$/.test(prefix) ? prefix : "trace";
  return `tr-${safePrefix}-${Math.max(0, Math.trunc(now))}-${random.toString(36).slice(2, 8)}`;
}

/** Build a bounded record from an allowlisted schema; free-form data is never accepted. */
export function buildDiagnosticTraceRecord(
  input: DiagnosticTraceInput,
  now = Date.now(),
  random = Math.random(),
): DiagnosticTraceRecord {
  const idBase = Math.max(0, Math.trunc(now));
  const randomPart = random.toString(36).slice(2, 10) || "00000000";
  const record: DiagnosticTraceRecord = {
    eventId: `evt-${idBase}-${randomPart}`,
    correlationId: boundedId(input.correlationId, `tr-app-${idBase}`),
    ...(boundedCommandId(input.commandId) ? { commandId: boundedCommandId(input.commandId) } : {}),
    ...(boundedNativeCommandId(input.nativeCommandId) ? { nativeCommandId: boundedNativeCommandId(input.nativeCommandId) } : {}),
    action: boundedLabel(input.action, "app.unknown"),
    step: boundedLabel(input.step, "unknown"),
    status: enumValue(input.status, STATUSES, "failed"),
    backend: enumValue(input.backend, BACKENDS, "unknown"),
    target: enumValue(input.target, TARGETS, "unknown"),
    screen: enumValue(input.screen, SCREENS, "unknown"),
    ...(boundedInt(input.durationMs, 0, 86_400_000) !== undefined ? { durationMs: boundedInt(input.durationMs, 0, 86_400_000) } : {}),
    ...(boundedInt(input.timeoutMs, 1, 86_400_000) !== undefined ? { timeoutMs: boundedInt(input.timeoutMs, 1, 86_400_000) } : {}),
    ...(boundedInt(input.exitCode, -255, 255) !== undefined ? { exitCode: boundedInt(input.exitCode, -255, 255) } : {}),
    ...(boundedInt(input.stdoutBytes, 0, 1_000_000_000) !== undefined ? { stdoutBytes: boundedInt(input.stdoutBytes, 0, 1_000_000_000) } : {}),
    ...(boundedInt(input.stderrBytes, 0, 1_000_000_000) !== undefined ? { stderrBytes: boundedInt(input.stderrBytes, 0, 1_000_000_000) } : {}),
    ...(boundedInt(input.stdoutChars, 0, 1_000_000_000) !== undefined ? { stdoutChars: boundedInt(input.stdoutChars, 0, 1_000_000_000) } : {}),
    ...(boundedInt(input.stderrChars, 0, 1_000_000_000) !== undefined ? { stderrChars: boundedInt(input.stderrChars, 0, 1_000_000_000) } : {}),
    ...(input.outputMetricSource === "normalized-callback-redacted" ? { outputMetricSource: input.outputMetricSource } : {}),
    ...(typeof input.parserOutcome === "string" && PARSER_OUTCOMES.has(input.parserOutcome) ? { parserOutcome: input.parserOutcome } : {}),
    ...(boundedInt(input.progressPercent, 0, 100) !== undefined ? { progressPercent: boundedInt(input.progressPercent, 0, 100) } : {}),
    ...(boundedInt(input.attempt, 1, 8) !== undefined ? { attempt: boundedInt(input.attempt, 1, 8) } : {}),
    ...(boundedInt(input.httpStatus, 100, 599) !== undefined ? { httpStatus: boundedInt(input.httpStatus, 100, 599) } : {}),
    ...(typeof input.resultCode === "string" && RESULT_CODES.has(input.resultCode) ? { resultCode: input.resultCode } : {}),
    ...(typeof input.errorCategory === "string" && ERRORS.has(input.errorCategory) ? { errorCategory: input.errorCategory } : {}),
    ...(input.androidRunCommand === "granted" || input.androidRunCommand === "missing" || input.androidRunCommand === "unknown" ? { androidRunCommand: input.androidRunCommand } : {}),
    ...(input.termuxExternalApps === "allowed" || input.termuxExternalApps === "blocked" || input.termuxExternalApps === "unknown" || input.termuxExternalApps === "not-observed" ? { termuxExternalApps: input.termuxExternalApps } : {}),
  };
  return record;
}

/** Only an explicit false value is evidence that Termux disabled external apps. */
export function isExplicitTermuxExternalAppsFalse(value: unknown): boolean {
  const text = value instanceof Error ? value.message : String(value ?? "");
  return /\ballow[-_ ]external[-_ ]apps\s*(?:=|:)\s*false\b/i.test(text);
}

/** Map raw exception text to a generic category. The text itself must never be persisted. */
export function classifyDiagnosticError(value: unknown): TraceErrorCategory {
  const text = value instanceof Error ? `${value.name} ${value.message}` : String(value ?? "");
  if (/RUN_COMMAND_PERMISSION|permission\s+denied|securityexception|eacces|eperm/i.test(text)) return "permission-denied";
  if (isExplicitTermuxExternalAppsFalse(value)) return "external-apps-disabled";
  if (/TERMUX_NATIVE_RESULT_MISSING|callback.*missing|no result object/i.test(text)) return "callback-missing";
  if (/TERMUX_NATIVE_RESULT_INVALID|callback.*invalid|omitted required|ID_MISMATCH|NATIVE_ID_INVALID/i.test(text)) return "callback-invalid";
  if (/timeout|timed\s*out|deadline/i.test(text)) return "timeout";
  if (/cancel|interrupt|aborted/i.test(text)) return "cancelled";
  if (/NATIVE_MODULE_MISSING/i.test(text)) return "native-module-missing";
  if (/network|fetch|socket|dns|connection/i.test(text)) return "network";
  if (/HTTP[_ :][45]\d\d|HTTP [45]\d\d/i.test(text)) return "http-error";
  if (/empty.*response/i.test(text)) return "empty-response";
  if (/invalid.*response|parse/i.test(text)) return "invalid-response";
  if (/truncat/i.test(text)) return "output-truncated";
  if (/exit|command failed|failed/i.test(text)) return "command-failed";
  return "unknown";
}
