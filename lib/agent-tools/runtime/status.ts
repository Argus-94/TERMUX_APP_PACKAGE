import { getRuntimeFacade } from "../../runtime-facade";
import { snapshotRuntimeStatus } from "../../../core/RuntimeStatus";
import { privateRuntimeProvider } from "../../private-runtime-provider";
import type { ToolArgs, ToolExecutionContext } from "../types";

const PRIVATE_STATUS_MARKER = "AIB_PRIVATE_RUNTIME_STATUS_V1";
const PRIVATE_STATUS_COMMAND = `printf '%s\\n' '${PRIVATE_STATUS_MARKER}'`;
const PRIVATE_STATUS_TIMEOUT_MS = 5_000;

export function validate(_args: ToolArgs): string | null {
  return null;
}

export async function execute(
  _args: ToolArgs,
  _projectPath?: string | null,
  context?: ToolExecutionContext,
) {
  const snapshot = await snapshotRuntimeStatus(getRuntimeFacade());
  if (context?.executionTarget !== "embedded-private") return snapshot;

  // No caller-supplied command or cwd is accepted; the native provider uses its
  // app-private HOME default and exposes no external Termux/proot fallback.
  try {
    const result = await privateRuntimeProvider.execute(PRIVATE_STATUS_COMMAND, {
      timeoutMs: PRIVATE_STATUS_TIMEOUT_MS,
      preserveOutput: true,
      traceId: context.traceId,
    });
    const ready = result.exitCode === 0 &&
      result.timedOut === false &&
      result.outputTruncated === false &&
      result.stdout === `${PRIVATE_STATUS_MARKER}\n`;
    return {
      ...snapshot,
      agentShellProbe: ready
        ? { target: "embedded-private", ready: true, capability: "native-bash" }
        : { target: "embedded-private", ready: false, reason: privateProbeResultReason(result) },
    };
  } catch (error: unknown) {
    return {
      ...snapshot,
      agentShellProbe: {
        target: "embedded-private",
        ready: false,
        reason: privateProbeErrorCode(error),
      },
    };
  }
}

function privateProbeResultReason(result: {
  exitCode: number;
  timedOut: boolean;
  outputTruncated?: boolean;
  stdout: string;
}): string {
  if (result.timedOut !== false) return "PRIVATE_AIB_TOOL_PROBE_TIMEOUT";
  if (result.outputTruncated !== false) return "PRIVATE_AIB_TOOL_PROBE_OUTPUT_INCOMPLETE";
  if (result.exitCode !== 0) return "PRIVATE_AIB_TOOL_PROBE_NONZERO_EXIT";
  if (result.stdout !== `${PRIVATE_STATUS_MARKER}\n`) return "PRIVATE_AIB_TOOL_PROBE_MARKER_MISMATCH";
  return "PRIVATE_AIB_TOOL_PROBE_FAILED";
}

function privateProbeErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const code = message.match(/^([A-Z][A-Z0-9_]{1,80})(?::|\s|$)/)?.[1];
  return code || "PRIVATE_RUNTIME_COMMAND_FAILED";
}
