/**
 * Ubuntu container lifecycle helpers on top of UserspaceContainerBackend.
 * Runtime-only; does not own or delete projects.
 */

import type { UserspaceContainerBackend } from "../container/UserspaceContainerBackend";
import type { ContainerInstance } from "../container/ContainerTypes";
import {
  UBUNTU_IMAGE_ID,
  projectWorkspaceMount,
  ubuntuInstanceStoragePath,
} from "./UbuntuProfile";
import type { HomeLayout } from "../home/HomeLayout";

export type UbuntuLaunchOptions = {
  name?: string;
  projectId: string;
  projectRoot: string;
  policy?: "PROJECT_ONLY" | "PROJECT_AND_WORKSPACE" | "INTEGRATED_HOME";
};

export async function launchUbuntuForProject(
  backend: UserspaceContainerBackend,
  home: HomeLayout,
  options: UbuntuLaunchOptions,
): Promise<{ instance: ContainerInstance; storagePath: string }> {
  const instance = await backend.create({
    imageId: UBUNTU_IMAGE_ID,
    name: options.name ?? `ubuntu-${options.projectId}`,
    mounts: [projectWorkspaceMount(options.projectRoot)],
    policy: options.policy ?? "PROJECT_ONLY",
    projectId: options.projectId,
  });
  await backend.start(instance.id);
  const storagePath = ubuntuInstanceStoragePath(home, instance.id);
  return { instance: backend.get(instance.id)!, storagePath };
}

export async function stopUbuntu(
  backend: UserspaceContainerBackend,
  instanceId: string,
): Promise<void> {
  await backend.stop(instanceId);
}

export async function restartUbuntu(
  backend: UserspaceContainerBackend,
  instanceId: string,
): Promise<void> {
  await backend.restart(instanceId);
}

/** Remove container instance only — project path is left intact. */
export async function destroyUbuntuInstance(
  backend: UserspaceContainerBackend,
  instanceId: string,
): Promise<void> {
  await backend.remove(instanceId);
}
