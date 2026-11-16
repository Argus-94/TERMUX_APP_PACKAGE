/**
 * Final validation harness (runtime-only contracts).
 * Aggregates presence checks for stages 0–12 without touching build config.
 */

export type FinalCheck = { name: string; ok: boolean; detail?: string };

export type FinalValidationReport = {
  passed: number;
  failed: number;
  checks: FinalCheck[];
  generatedAt: number;
};

export function runFinalValidation(modules: {
  homeLayout?: unknown;
  executionEnvironment?: unknown;
  projectManager?: unknown;
  terminalSessionManager?: unknown;
  toolchainManager?: unknown;
  processRegistry?: unknown;
  sessionManager?: unknown;
  containerManager?: unknown;
  agentManager?: unknown;
  androidBridge?: unknown;
  privilegeNone?: unknown;
  nativeRuntime?: unknown;
}): FinalValidationReport {
  const checks: FinalCheck[] = [
    { name: "home", ok: !!modules.homeLayout },
    { name: "execution_environment", ok: !!modules.executionEnvironment },
    { name: "project_manager", ok: !!modules.projectManager },
    { name: "terminal_session_manager", ok: !!modules.terminalSessionManager },
    { name: "toolchain_manager", ok: !!modules.toolchainManager },
    { name: "process_registry", ok: !!modules.processRegistry },
    { name: "session_manager", ok: !!modules.sessionManager },
    { name: "container_manager", ok: !!modules.containerManager },
    { name: "agent_manager", ok: !!modules.agentManager },
    { name: "android_bridge", ok: !!modules.androidBridge },
    { name: "privilege_none", ok: !!modules.privilegeNone },
    { name: "native_runtime", ok: !!modules.nativeRuntime },
  ];
  const passed = checks.filter((c) => c.ok).length;
  const failed = checks.length - passed;
  return {
    passed,
    failed,
    checks,
    generatedAt: Date.now(),
  };
}

export function assertFinalValidationOk(report: FinalValidationReport): void {
  if (report.failed > 0) {
    const names = report.checks.filter((c) => !c.ok).map((c) => c.name).join(", ");
    throw new Error(`Final validation failed: ${names}`);
  }
}
