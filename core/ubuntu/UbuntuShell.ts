/**
 * Ubuntu shell environment helper (userspace / proot-oriented).
 * Builds env and command prefixes; does not install images.
 * Projects stay on host under AIBuilderTermux HOME.
 */

import type { HomeLayout } from "../home/HomeLayout";
import { ubuntuInstanceStoragePath } from "./UbuntuProfile";

export type UbuntuShellSpec = {
  instanceId: string;
  projectRoot: string;
  /** Working directory inside container */
  containerCwd: string;
  env: Record<string, string>;
  /** Suggested login/shell command (backend-specific). */
  shellCommand: string;
};

/**
 * Build a shell spec for an Ubuntu instance with project mounted at /workspace.
 */
export function buildUbuntuShellSpec(
  home: HomeLayout,
  input: { instanceId: string; projectId: string; projectRoot?: string },
): UbuntuShellSpec {
  const projectRoot =
    input.projectRoot ?? `${home.projects}/${input.projectId}`;
  const storage = ubuntuInstanceStoragePath(home, input.instanceId);
  return {
    instanceId: input.instanceId,
    projectRoot,
    containerCwd: "/workspace",
    env: {
      HOME: "/root",
      PWD: "/workspace",
      PROJECT_ROOT: "/workspace",
      AI_BUILDER_HOME: home.root,
      AI_BUILDER_PROJECT: projectRoot,
      AIB_CONTAINER_STORAGE: storage,
      AIB_CONTAINER_PROFILE: "ubuntu",
    },
    // Placeholder for future proot/chroot backend; userspace tracks lifecycle only.
    shellCommand: "bash -l",
  };
}

/**
 * Format a diagnostic one-liner for logs / UI.
 */
export function describeUbuntuShell(spec: UbuntuShellSpec): string {
  return `ubuntu[${spec.instanceId}] cwd=${spec.containerCwd} project=${spec.projectRoot} shell=${spec.shellCommand}`;
}
