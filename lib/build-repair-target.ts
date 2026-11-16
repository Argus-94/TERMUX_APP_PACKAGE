/** Classify the most likely repair target from build diagnostics.
 * This is guidance for the agent, not a substitute for reading the full log.
 */
export type BuildRepairTarget = "script" | "project" | "environment" | "mixed" | "unknown";

export function classifyBuildRepairTarget(input: string): BuildRepairTarget {
  const log = String(input || "").slice(-30000);
  if (!log.trim()) return "unknown";

  const scriptFailure = /(?:bash:.*(?:syntax error|unexpected token)|syntax error near unexpected token|unexpected EOF while looking for matching|BUILD_SCRIPT_(?:INVALID|WRITE_FAILED|CONTENT_INVALID)|PROJECT_BUILD_RUNNER_(?:WRITE_FAILED|CONTENT_INVALID|PATH_NOT_VERIFIED)|aib_primary: command not found)/i.test(log)
    || /(?:line \d+: .*syntax error|bad substitution|unbound variable)/i.test(log);
  const environmentFailure = /(?:JAVA_HOME.*(?:not set|invalid|missing)|(?:Android )?SDK (?:not found|missing|location)|ANDROID_HOME.*(?:not set|invalid)|NDK.*(?:missing|not configured)|Could not find .*SDK|licenses? .*not accepted|No space left on device|ENOSPC|UnknownHost|Temporary failure in name resolution|Connection timed out|command not found.*(?:java|node|npm|pnpm|cmake|clang|aapt2|sdkmanager)|(?:apt|pkg): (?:command )?not found|proot.*(?:rootfs|login).*(?:missing|failed))/i.test(log);
  const projectFailure = /(?:Execution failed for task.*(?:compile|merge|process|check|lint)|e: file:.*\.kt|\.kt:\d+:\d+: error:|\.java:\d+: error:|Android resource linking failed|AAPT: error|Manifest merger failed|Could not resolve all files for configuration|Could not find method .* for arguments|Could not find plugin|Plugin .* was not found|Unresolved reference|cannot find symbol|error: package .* does not exist)/i.test(log);

  if ((scriptFailure && environmentFailure) || (scriptFailure && projectFailure) || (environmentFailure && projectFailure)) return "mixed";
  if (scriptFailure) return "script";
  if (environmentFailure) return "environment";
  if (projectFailure) return "project";
  return "unknown";
}

export function buildRepairTargetInstruction(target: BuildRepairTarget, scriptPath?: string): string {
  const path = String(scriptPath || "").trim();
  const script = path ? `Generated runner path: ${path}.` : "Find the generated build runner from PROJECT_BUILD_SCRIPT marker in the execution output or recent runner file.";
  const byTarget: Record<BuildRepairTarget, string> = {
    script: `DIAGNOSIS TARGET=SCRIPT. ${script} Inspect its exact contents and run bash -n on it. If the generated runner itself has a syntax, quoting, path, or command-flow defect, repair the runner (keep a backup/revision first), then rerun it. Do not change project source/configuration unless logs independently prove a project defect.`,
    project: `DIAGNOSIS TARGET=PROJECT. Repair the actual project source/configuration/dependency declarations indicated by the first root cause. Keep the generated runner unchanged unless a separate runner defect is proven. Preserve the project's intended compile settings and lockfiles unless the root cause requires a narrowly scoped change.`,
    environment: `DIAGNOSIS TARGET=ENVIRONMENT. Repair the selected backend environment/toolchain (Termux uses pkg and Termux paths; Ubuntu guest uses apt and Ubuntu paths). Verify installed tool paths and versions. Do not edit project source or runner unless evidence shows a separate defect.`,
    mixed: `DIAGNOSIS TARGET=MIXED. There is evidence of multiple fault classes. Make the smallest independently justified repair to each affected layer (runner script, project, and/or selected environment), keeping a backup before modifying a generated runner and preserving unrelated project configuration.`,
    unknown: `DIAGNOSIS TARGET=UNKNOWN. Read the first causal error and surrounding stack/context before editing. Compare runner, project, and environment evidence; do not guess or apply broad destructive changes. Repair the layer supported by the evidence.`,
  };
  return byTarget[target];
}
