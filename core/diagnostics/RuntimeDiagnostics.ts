import type { RuntimeHealth, HealthResult } from "./RuntimeHealth";
import type { RuntimeJournal } from "../runtime/RuntimeJournal";
import type { RuntimeSupervisor } from "../runtime/RuntimeSupervisor";

export type RuntimeDiagnosticsSnapshot = Readonly<{
  health: HealthResult[];
  pendingTransactions: Awaited<ReturnType<RuntimeJournal["pending"]>>;
  supervisor: ReturnType<RuntimeSupervisor["snapshot"]>;
  generatedAt: number;
}>;

export async function collectRuntimeDiagnostics(health: RuntimeHealth, journal: RuntimeJournal, supervisor: RuntimeSupervisor): Promise<RuntimeDiagnosticsSnapshot> {
  return { health: await health.run(), pendingTransactions: await journal.pending(), supervisor: supervisor.snapshot(), generatedAt: Date.now() };
}
