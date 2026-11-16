import type { DeviceEvidenceStore, EvidenceRef } from "./DeviceEvidenceStore";

export type DeviceCaseReport = { id: string; title: string; status: "passed" | "failed" | "blocked"; reason: string; steps: Array<{ id: string; status: string; assertionsPassed: boolean; evidence: EvidenceRef[] }> };
export type DeviceTestReport = { version: 1; runId: string; goal: string; packageName?: string; startedAt: string; finishedAt: string; status: "passed" | "failed"; totals: { cases: number; passed: number; failed: number; blocked: number }; cases: DeviceCaseReport[]; evidenceRoot: string };

export function renderDeviceTestReport(report: DeviceTestReport, store?: DeviceEvidenceStore): string {
  const lines = [`# AI Builder Device Test Report`, ``, `- Status: **${report.status.toUpperCase()}**`, `- Run: \`${report.runId}\``, `- Goal: ${report.goal}`, `- Package: ${report.packageName || "auto-detected"}`, `- Started: ${report.startedAt}`, `- Finished: ${report.finishedAt}`, `- Cases: ${report.totals.cases} · passed ${report.totals.passed} · failed ${report.totals.failed} · blocked ${report.totals.blocked}`, ``];
  for (const c of report.cases) {
    lines.push(`## ${c.id} — ${c.title}`, `Status: **${c.status}** — ${c.reason}`);
    for (const s of c.steps) {
      lines.push(`- ${s.id}: ${s.status}${s.assertionsPassed ? " · assertions passed" : ""}`);
      for (const e of s.evidence) lines.push(`  - ${e.kind}: ${store ? store.relative(e) : e.path}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}
