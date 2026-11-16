/**
 * Ubuntu container profile helpers (runtime-only).
 * Storage paths under AIBuilderTermux HOME/containers.
 */

import type { ContainerImage, MountSpec } from "../container/ContainerTypes";
import type { HomeLayout } from "../home/HomeLayout";

export const UBUNTU_IMAGE_ID = "ubuntu:base";
export const UBUNTU_IMAGE_NAME = "Ubuntu";
export const UBUNTU_IMAGE_TAG = "base";

export function ubuntuImageManifest(home: HomeLayout): ContainerImage {
  return {
    id: UBUNTU_IMAGE_ID,
    name: UBUNTU_IMAGE_NAME,
    tag: UBUNTU_IMAGE_TAG,
    profile: "ubuntu",
    path: `${home.containersUbuntu}/images/base`,
    createdAt: Date.now(),
  };
}

export function ubuntuInstanceStoragePath(home: HomeLayout, instanceId: string): string {
  return `${home.containers}/instances/${instanceId}`;
}

/** Mount project root into container at /workspace (rw). */
export function projectWorkspaceMount(projectRoot: string): MountSpec {
  return {
    hostPath: projectRoot,
    containerPath: "/workspace",
    mode: "rw",
  };
}
