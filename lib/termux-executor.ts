import { runEmbeddedTermuxCommand, runShellCommand, type TermuxCommandResult } from "./termux-bridge";
import {
  getBuildBackend,
  resolveAgentExecutionBackend,
  wrapCommandForAgentShell,
  type AgentShellBackend,
} from "./agent-shell-backend";
import { recordFastPathExecution } from "./fast-path-metrics";
import { guardTermuxCommand, guardReadOnlyTermuxCommand } from "./termux-guard";
import { assertCommandAllowed } from "./security-policy";
import { compressShellOutput } from "./context-engine";
import { normalizeTermuxCommandPaths } from "./termux-executor-paths";
export { normalizeTermuxCommandPaths } from "./termux-executor-paths";

const TERMUX_STDERR_MARKER = "__AIB_STDERR__";

function shellQuote(value: string): string {
  return "'" + String(value).replace(/'/g, "'\"'\"'") + "'";
}

/** Preserve stderr through the immutable native Termux bridge, which currently
 * pipes the live stderr stream away from the final callback. */
function captureTermuxStderr(command: string): string {
  // `read` returns non-zero for a final unterminated line while still assigning
  // its bytes to `line`; keep that tail so a callback cannot silently lose the
  // last diagnostic/marker fragment.
  return `bash -c ${shellQuote(command)} 2> >(while IFS= read -r line || [ -n "$line" ]; do printf '${TERMUX_STDERR_MARKER}%s\\n' "$line"; done)`;
}

function restoreTermuxStreams(result: TermuxCommandResult): TermuxCommandResult {
  const raw = String(result.stdout || "");
  if (!raw.includes(TERMUX_STDERR_MARKER)) return result;
  const stdout: string[] = [];
  const stderr: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith(TERMUX_STDERR_MARKER)) stderr.push(line.slice(TERMUX_STDERR_MARKER.length));
    else stdout.push(line);
  }
  return {
    ...result,
    stdout: stdout.join("\n").replace(/\n$/, ""),
    stderr: [String(result.stderr || ""), ...stderr].filter(Boolean).join("\n"),
  };
}


export interface GuardedTermuxOptions {
  workdir?: string;
  timeoutMs?: number;
  /** Abort a private one-shot process through the native request registry. */
  signal?: AbortSignal;
  isBuild?: boolean;
  /** Honor a finite caller-supplied phase timeout rather than the generic long-command floor. */
  honorExplicitTimeout?: boolean;
  allowDangerous?: boolean;
  confirmDangerous?: (command: string, reason: string) => Promise<boolean>;
  /** App-defined trusted maintenance commands (never model-generated). */
  trustedInternal?: boolean;
  /** Exact Android SDK license files from app-owned build preparation only. */
  allowSdkLicenseWrites?: boolean;
  /** Exact app-owned debug keystore token for the built-in signer only. */
  allowInternalDebugKeystore?: boolean;
  /** User-initiated built-in signing UI operations; never model-originated. */
  allowSigningKeyAccess?: boolean;
  /** Force host Termux (skip ubuntu-proot wrap). */
  hostTermux?: boolean;
  /** Preserve complete stdout for trusted structured consumers such as backup validation. */
  preserveOutput?: boolean;
  /** Explicit execution backend selected by the production runtime router. */
  backend?: AgentShellBackend;
  /** Explicit private runtime target. Missing/unready embedded runtime fails closed; this never falls back to RUN_COMMAND. */
  executionTarget?: "embedded-private";
  /** Dedicated cached/offline Gradle build path; accepted only for trusted private build helpers. */
  offlineBuild?: boolean;
  /** Correlates an agent tool/trace with all downstream shell and proot logs. */
  traceId?: string;
}

function isGradleBuildInvocation(command: string): boolean {
  return /\bgradle(?:w)?\b/i.test(command) &&
    /\b(?:assemble(?:[A-Za-z0-9_]+)?|build|bundle(?:[A-Za-z0-9_]+)?|install(?:[A-Za-z0-9_]+)?|clean|publish)\b/i.test(command);
}

/**
 * Single policy boundary for model-originated shell execution.
 * Callers must use this wrapper instead of invoking runShellCommand directly.
 */
export async function executeGuardedTermuxCommand(
  command: string,
  options: GuardedTermuxOptions = {},
): Promise<TermuxCommandResult> {
  const commandNorm = normalizeTermuxCommandPaths(command);
  if (options.executionTarget === "embedded-private" && options.offlineBuild !== true && isGradleBuildInvocation(commandNorm)) {
    throw new Error("AIB_PRIVATE_BUILD_USE_TYPED_OFFLINE_TOOL");
  }
  const guard = guardTermuxCommand(commandNorm, {
    allowDangerous: options.allowDangerous,
    projectPath: options.workdir,
    allowSdkLicenseWrites: options.trustedInternal === true && options.allowSdkLicenseWrites === true,
    allowInternalDebugKeystore: options.trustedInternal === true && options.allowInternalDebugKeystore === true,
    allowSigningKeyAccess: options.trustedInternal === true && options.allowSigningKeyAccess === true,
  });

  if ("reason" in guard) {
    const reason = guard.reason;
    // Trusted internal maintenance commands are authored by the app itself
    // (for example verified tool-pack installers). They may use shell
    // constructs such as $() for deterministic path discovery, but they must
    // still obey the hard-block rules enforced above. Model-originated
    // commands never set trustedInternal.
    if (!(options.trustedInternal === true && guard.confirmable === true)) {
      let allowed = false;
      if (guard.confirmable === true && options.confirmDangerous) {
        try {
          allowed = await options.confirmDangerous(commandNorm, reason);
        } catch {
          allowed = false;
        }
      }
      if (!allowed) {
        throw new Error(`BLOCKED_BY_APP: ${reason}`);
      }
    }
  }

  assertCommandAllowed(commandNorm, "termux", { interactive: false });
  let result: TermuxCommandResult;
  if (options.executionTarget === "embedded-private" || (!options.backend && options.hostTermux !== true)) {
    // This path uses the native app-private PREFIX/HOME resolver and has no external Termux/proot fallback.
    if (options.offlineBuild && !(options.executionTarget === "embedded-private" && options.trustedInternal === true && options.isBuild === true)) {
      throw new Error("AIB_OFFLINE_BUILD_CONTEXT_INVALID");
    }
    const embedded = await runEmbeddedTermuxCommand(commandNorm, {
      workdir: options.workdir,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
      ...(options.offlineBuild ? { offlineBuild: true } : {}),
    });
    result = {
      commandId: embedded.commandId,
      stdout: embedded.stdout,
      stderr: embedded.stderr,
      exitCode: embedded.exitCode,
      timedOut: embedded.timedOut,
      outputTruncated: embedded.outputTruncated,
    };
  } else {
    // Host lifecycle commands stay in Termux; guest commands wrap into the exact
    // selected profile. Explicit backend wins over mutable global selection.
    // Shared-storage operations follow the selected backend; callers may request
    // Termux host explicitly for the guarded Ubuntu-rootfs failure fallback.
    const preferredBackend: AgentShellBackend = options.hostTermux
      ? "termux"
      : options.backend ?? getBuildBackend();
    const executionBackend = resolveAgentExecutionBackend(commandNorm, preferredBackend);
    try {
      recordFastPathExecution(executionBackend, preferredBackend === "ubuntu-proot" ? "ubuntu-proot" : "termux");
    } catch {
      // metrics must never break execution
    }
    const toRun = executionBackend === "termux"
      ? `AIB_PRIVATE_ROOT="$HOME/.aibuilder"; export AIB_PRIVATE_ROOT; ${commandNorm}`
      : wrapCommandForAgentShell(commandNorm, options.workdir, executionBackend);
    // Preserve stderr without changing the native/compilation layer.
    const bridgeCommand = captureTermuxStderr(toRun);
    // When wrapped into proot, cwd is applied inside the guest via the command itself if needed
    result = restoreTermuxStreams(await runShellCommand(bridgeCommand, {
      workdir: options.hostTermux || toRun === commandNorm ? options.workdir : undefined,
      timeoutMs: options.timeoutMs,
      isBuild: options.isBuild,
      honorExplicitTimeout: options.honorExplicitTimeout,
      traceId: options.traceId,
      backend: executionBackend,
    }));
  }
  try {
    // Never compress trusted/build pipeline output — markers APK_PATH/SIGNED_*/AAB_OK/gradle_ec must survive
    if (
      result &&
      typeof result === "object" &&
      options.trustedInternal !== true &&
      options.preserveOutput !== true &&
      options.isBuild !== true
    ) {
      const r = result as { stdout?: string; stderr?: string };
      if (typeof r.stdout === "string" && r.stdout.length > 1500) {
        const hasMarkers =
          /APK_PATH=|SIGNED_V1_V2_V3_OK|UNSIGNED_APK_OK|AAB_OK=|gradle_ec=|PREPARE_OK/.test(
            r.stdout,
          );
        if (!hasMarkers) {
          r.stdout = compressShellOutput(
            r.stdout,
            typeof r.stderr === "string" ? r.stderr : "",
          );
        }
      }
    }
  } catch {
    /* compression is best-effort */
  }
  return result;
}


/** Execute a command under the strict subagent read-only policy. */
export async function executeReadOnlyTermuxCommand(
  command: string,
  options: Pick<GuardedTermuxOptions, "workdir" | "timeoutMs"> = {},
): Promise<TermuxCommandResult> {
  const guard = guardReadOnlyTermuxCommand(command);
  if ("reason" in guard) {
    throw new Error(`BLOCKED_READ_ONLY_SUBAGENT: ${guard.reason}`);
  }
  assertCommandAllowed(command, "termux", { interactive: false });
  const embedded = await runEmbeddedTermuxCommand(command, {
    workdir: options.workdir,
    timeoutMs: options.timeoutMs,
  });
  return {
    commandId: embedded.commandId,
    stdout: embedded.stdout,
    stderr: embedded.stderr,
    exitCode: embedded.exitCode,
    timedOut: embedded.timedOut,
    outputTruncated: embedded.outputTruncated,
  };
}
