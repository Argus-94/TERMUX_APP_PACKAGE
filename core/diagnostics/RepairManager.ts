/**
 * RepairManager — runs DiagnosticRule.repair() deterministically.
 * LLM must never invent shell repair; it only picks a rule id.
 */
import type { DiagnosticRule, DiagnosticResult, RepairResult } from "./DiagnosticRule";
import { FailureJournal } from "./FailureJournal";

export class RepairManager {
  private readonly rules = new Map<string, DiagnosticRule>();

  constructor(private readonly failures?: FailureJournal) {}

  register(rule: DiagnosticRule): void {
    this.rules.set(rule.id, rule);
  }

  registerAll(rules: DiagnosticRule[]): void {
    for (const r of rules) this.register(r);
  }

  list(): DiagnosticRule[] {
    return [...this.rules.values()];
  }

  get(id: string): DiagnosticRule | undefined {
    return this.rules.get(id);
  }

  async checkAll(): Promise<DiagnosticResult[]> {
    const out: DiagnosticResult[] = [];
    for (const rule of this.rules.values()) {
      try {
        out.push(await Promise.resolve(rule.check()));
      } catch (e) {
        out.push({
          id: rule.id,
          level: "error",
          message: e instanceof Error ? e.message : String(e),
          repairable: Boolean(rule.repair),
          checkedAt: Date.now(),
        });
      }
    }
    return out;
  }

  async check(id: string): Promise<DiagnosticResult> {
    const rule = this.rules.get(id);
    if (!rule) {
      return { id, level: "error", message: `Unknown diagnostic rule: ${id}`, repairable: false, checkedAt: Date.now() };
    }
    return Promise.resolve(rule.check());
  }

  async repair(id: string): Promise<RepairResult> {
    const rule = this.rules.get(id);
    if (!rule) {
      return { id, ok: false, message: `Unknown rule: ${id}`, durationMs: 0 };
    }
    if (!rule.repair) {
      return { id, ok: false, message: `Rule ${id} has no repair action`, durationMs: 0 };
    }
    const started = Date.now();
    try {
      const result = await Promise.resolve(rule.repair());
      if (result.ok && this.failures) {
        const open = await this.failures.openFailures();
        const match = open.find((f) => f.component === id || f.code === id);
        if (match) await this.failures.markRepaired(match.id, id);
      }
      return { ...result, durationMs: result.durationMs || Date.now() - started };
    } catch (e) {
      return {
        id,
        ok: false,
        message: e instanceof Error ? e.message : String(e),
        durationMs: Date.now() - started,
      };
    }
  }

  async repairAllRepairable(): Promise<RepairResult[]> {
    const checks = await this.checkAll();
    const results: RepairResult[] = [];
    for (const c of checks) {
      if (c.repairable && c.level !== "ok") {
        results.push(await this.repair(c.id));
      }
    }
    return results;
  }
}
