/**
 * RuntimeHealth — facade over RepairManager + DiagnosticRule registry.
 */
import type { DiagnosticRule, DiagnosticResult, RepairResult } from "./DiagnosticRule";
import { RepairManager } from "./RepairManager";
import type { FailureJournal } from "./FailureJournal";

export type HealthLevel = "ok" | "info" | "warn" | "error";
export type HealthResult = DiagnosticResult;

export interface HealthCheck {
  id: string;
  check(): Promise<DiagnosticResult> | DiagnosticResult;
  repair?(): Promise<RepairResult> | RepairResult;
}

export class RuntimeHealth {
  private readonly repairManager: RepairManager;

  constructor(failures?: FailureJournal) {
    this.repairManager = new RepairManager(failures);
  }

  register(check: HealthCheck | DiagnosticRule): void {
    if ("title" in check && "category" in check) {
      this.repairManager.register(check as DiagnosticRule);
      return;
    }
    const legacy = check as HealthCheck;
    this.repairManager.register({
      id: legacy.id,
      title: legacy.id,
      category: "runtime",
      check: () => legacy.check(),
      repair: legacy.repair
        ? async () => {
            const r = await Promise.resolve(legacy.repair!());
            return r;
          }
        : undefined,
    });
  }

  registerRule(rule: DiagnosticRule): void {
    this.repairManager.register(rule);
  }

  registerRules(rules: DiagnosticRule[]): void {
    this.repairManager.registerAll(rules);
  }

  list(): DiagnosticRule[] {
    return this.repairManager.list();
  }

  async run(): Promise<DiagnosticResult[]> {
    return this.repairManager.checkAll();
  }

  async repair(id: string): Promise<RepairResult | HealthResult> {
    return this.repairManager.repair(id);
  }

  async repairAll(): Promise<RepairResult[]> {
    return this.repairManager.repairAllRepairable();
  }

  getRepairManager(): RepairManager {
    return this.repairManager;
  }
}
