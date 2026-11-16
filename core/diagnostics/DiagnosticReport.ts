/**
 * Runtime-only aggregated diagnostic report.
 */

export type DiagnosticLevel = "ok" | "warn" | "error" | "info";

export type DiagnosticItem = {
  readonly area: string;
  readonly level: DiagnosticLevel;
  readonly message: string;
  readonly details?: Readonly<Record<string, string | number | boolean>>;
};

export type DiagnosticReport = {
  readonly generatedAt: number;
  readonly items: DiagnosticItem[];
  readonly summary: {
    ok: number;
    warn: number;
    error: number;
    info: number;
  };
};

export function buildDiagnosticReport(items: DiagnosticItem[]): DiagnosticReport {
  const summary = { ok: 0, warn: 0, error: 0, info: 0 };
  for (const item of items) {
    summary[item.level]++;
  }
  return {
    generatedAt: Date.now(),
    items: [...items],
    summary,
  };
}

export function reportHasErrors(report: DiagnosticReport): boolean {
  return report.summary.error > 0;
}
