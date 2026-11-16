import { executeGuardedTermuxCommand } from "./termux-executor";
import type { ProotDistroAlias, ProotDistroState } from "./proot-distro-state";
import { buildProotDistroProbeCommand, buildProotDistroInstallCommand, parseProotDistroProbe } from "./proot-distro-state";
export { withProotDistroInstallLock } from "./proot-distro-state";

export async function inspectTermuxProotDistro(alias: ProotDistroAlias, timeoutMs = 90_000): Promise<ProotDistroState> {
  const result = await executeGuardedTermuxCommand(buildProotDistroProbeCommand(alias), { timeoutMs, executionTarget: "embedded-private", trustedInternal: true, preserveOutput: true });
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  return parseProotDistroProbe(alias, output, result.exitCode ?? 1);
}

export async function installTermuxProotDistro(alias: ProotDistroAlias, timeoutMs = 45 * 60_000): Promise<Readonly<{ exitCode: number; log: string }>> {
  const result = await executeGuardedTermuxCommand(buildProotDistroInstallCommand(alias), { timeoutMs, executionTarget: "embedded-private", trustedInternal: true, preserveOutput: true });
  return { exitCode: result.exitCode ?? 1, log: `${result.stdout || ""}\n${result.stderr || ""}`.slice(-16_000) };
}
