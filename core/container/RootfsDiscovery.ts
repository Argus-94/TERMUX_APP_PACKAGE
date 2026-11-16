/**
 * Read-only discovery of container rootfs under AIBuilderTermux HOME.
 * Does not download or extract images.
 */

import type { HomeLayout } from "../home/HomeLayout";
import type { ContainerProfile } from "./ContainerShell";

export type PathExists = (path: string) => Promise<boolean> | boolean;

/**
 * Candidate rootfs directories for a profile.
 */
export function rootfsCandidates(
  home: HomeLayout,
  profile: ContainerProfile,
): string[] {
  const base =
    home.containersUbuntu;
  return [
    `${base}/images/base/rootfs`,
    `${base}/images/base`,
    `${home.containers}/images/${profile}/rootfs`,
    `${home.containers}/images/${profile}`,
  ];
}

export async function discoverRootfsPath(
  home: HomeLayout,
  profile: ContainerProfile,
  exists: PathExists,
): Promise<string | undefined> {
  for (const candidate of rootfsCandidates(home, profile)) {
    try {
      if (await exists(candidate)) return candidate;
    } catch {
      // ignore
    }
  }
  return undefined;
}
