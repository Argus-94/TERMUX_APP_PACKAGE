/**
 * DiagnosticRule — check + optional deterministic repair.
 * DSHA has ~23 self-checks; we expose a typed registry so agent and UI share the same contract.
 */
export type HealthLevel = "ok" | "info" | "warn" | "error";

export type DiagnosticResult = Readonly<{
  id: string;
  level: HealthLevel;
  message: string;
  repairable: boolean;
  details?: Readonly<Record<string, unknown>>;
  checkedAt: number;
}>;

export type RepairResult = Readonly<{
  id: string;
  ok: boolean;
  message: string;
  durationMs: number;
}>;

export interface DiagnosticRule {
  readonly id: string;
  readonly title: string;
  readonly category: "runtime" | "toolchain" | "device" | "project" | "agent";
  check(): Promise<DiagnosticResult> | DiagnosticResult;
  repair?(): Promise<RepairResult> | RepairResult;
}

export function okResult(id: string, message: string, details?: Record<string, unknown>): DiagnosticResult {
  return { id, level: "ok", message, repairable: false, details, checkedAt: Date.now() };
}

export function warnResult(id: string, message: string, repairable = false, details?: Record<string, unknown>): DiagnosticResult {
  return { id, level: "warn", message, repairable, details, checkedAt: Date.now() };
}

export function errorResult(id: string, message: string, repairable = true, details?: Record<string, unknown>): DiagnosticResult {
  return { id, level: "error", message, repairable, details, checkedAt: Date.now() };
}
