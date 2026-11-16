/**
 * Pre-LLM policy table: environment + goal → forced host, skip rootfs, preferred tools.
 */
import type { AgentGoal } from "./agent-goal";
import type { AgentShellBackend } from "./agent-shell-backend";
import { isSharedStorageOnlyUserTask } from "./agent-shell-backend";
export { classifyAgentOperationClass } from "./agent-operation-class";
export type { AgentOperationClass, AgentOperationClassificationInput } from "./agent-operation-class";

export type AgentPolicyDecision = Readonly<{
  forceHostTermux: boolean;
  skipLinuxRootfsPreflight: boolean;
  preferredTools: string[];
  forbidShellFor: string[];
  notes: string[];
}>;


export function routeAgentPolicy(
  userTask: string,
  goal: AgentGoal,
  backend: AgentShellBackend,
): AgentPolicyDecision {
  const notes: string[] = [];
  let forceHostTermux = false;
  let skipLinuxRootfsPreflight = false;
  const preferredTools: string[] = [];
  const forbidShellFor: string[] = [];

  const shared =
    isSharedStorageOnlyUserTask(userTask) ||
    goal.kind === "file_write" ||
    goal.kind === "dir_mkdir" ||
    goal.kind === "file_delete" ||
    goal.kind === "file_rename" ||
    goal.kind === "file_copy" ||
    goal.kind === "dir_list";

  if (shared) {
    forceHostTermux = backend === "termux";
    skipLinuxRootfsPreflight = true;
    notes.push(
      backend === "termux"
        ? "shared-storage on Termux host"
        : "shared-storage: try active Ubuntu proot first (binds /storage), host fallback if rootfs broken",
    );
  }

  if (goal.kind === "interceptor") {
    preferredTools.push(
      "interceptor.status",
      "interceptor.enable",
      "interceptor.disable",
      "interceptor.last",
      "interceptor.command",
    );
    forbidShellFor.push("interceptor");
    notes.push("interceptor is app-native; ignore SHELL_BACKEND");
  }

  if (goal.kind === "github_local" || goal.kind === "github_remote") {
    preferredTools.push(
      "github.repoCreate",
      "github.parse",
      "github.repo",
      "github.tree",
      "github.read",
      "github.materialize",
      "github.pack",
      "github.apply",
      "github.branch",
      "github.prCreate",
    );
    notes.push("prefer github.* AIB_TOOL including repoCreate");
  }

  if (backend === "ubuntu-proot") {
    notes.push("ENV=ubuntu-proot use apt-get in guest; storage binds active");
  } else {
    notes.push("ENV=termux use pkg on host");
  }

  if (goal.kind === "apk_build") {
    preferredTools.push("toolchain.ensure", "build.run", "fs.list", "diagnostics.log");
    if (backend !== "termux" && !shared) {
      notes.push("APK build on Ubuntu proot; use apt not pkg");
    } else {
      notes.push("APK build on Termux host; use pkg");
    }
  }

  if (
    goal.kind === "file_write" ||
    goal.kind === "dir_mkdir" ||
    goal.kind === "file_delete" ||
    goal.kind === "file_rename" ||
    goal.kind === "file_copy" ||
    goal.kind === "dir_list"
  ) {
    preferredTools.push("fs.create");
    forceHostTermux = backend === "termux";
    skipLinuxRootfsPreflight = true;
  }

  return {
    forceHostTermux,
    skipLinuxRootfsPreflight,
    preferredTools,
    forbidShellFor,
    notes,
  };
}

export function formatPolicyBlock(d: AgentPolicyDecision): string {
  return [
    "[POLICY]",
    "force_host_termux=" + (d.forceHostTermux ? "yes" : "no"),
    "skip_rootfs_preflight=" + (d.skipLinuxRootfsPreflight ? "yes" : "no"),
    d.preferredTools.length ? "prefer_tools=" + d.preferredTools.join(",") : "prefer_tools=none",
    d.forbidShellFor.length ? "forbid_shell_for=" + d.forbidShellFor.join(",") : "",
    d.notes.length ? "notes=" + d.notes.join(" | ") : "",
  ]
    .filter(Boolean)
    .join("\n");
}
