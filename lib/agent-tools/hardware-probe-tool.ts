/**
 * Agent tool: hardware.probe
 * Quick device diagnostics (storage / cpu / uname).
 */
import { runInActiveEnv } from "../run-in-active-env";
import {
  buildHardwareProbeCommand,
  hardwareProbeDescription,
  type HardwareProbeKind,
} from "./hardware-probe";
import type { ToolArgs } from "./types";

const KINDS: HardwareProbeKind[] = ["storage-quick", "cpu-quick", "uname"];

export function validate(args: ToolArgs): string | null {
  if (args.kind == null || args.kind === "") return null;
  const kind = String(args.kind);
  if (!KINDS.includes(kind as HardwareProbeKind)) {
    return `HARDWARE_PROBE_KIND_INVALID: use one of ${KINDS.join(", ")}`;
  }
  return null;
}

export async function execute(args: ToolArgs) {
  const kind = (String(args.kind || "storage-quick") as HardwareProbeKind) || "storage-quick";
  const timeoutMs = Math.min(Math.max(Number(args.timeoutMs) || 60_000, 15_000), 180_000);
  const command = buildHardwareProbeCommand(kind);

  // Always on host Termux — hardware facts should not go through proot.
  const result = await runInActiveEnv(command, {
    timeoutMs,
    logTag: "HardwareProbe",
    executionTarget: "embedded-private",
  });

  return {
    ok: result.exitCode === 0,
    kind,
    description: hardwareProbeDescription(kind),
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}
