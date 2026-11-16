/**
 * Ensures expected rootfs directory layout under HOME (mkdir only).
 * Does not download images; prepares paths for later extraction/proot.
 */

import type { HomeLayout } from "../home/HomeLayout";
import type { ContainerProfile } from "./ContainerShell";
import { rootfsCandidates } from "./RootfsDiscovery";

export type EnsureRootfsResult = {
  profile: ContainerProfile;
  primaryPath: string;
  created: string[];
  existing: string[];
};

export async function ensureRootfsLayout(
  home: HomeLayout,
  profile: ContainerProfile,
  mkdir: (path: string) => Promise<void>,
  exists: (path: string) => Promise<boolean>,
): Promise<EnsureRootfsResult> {
  const candidates = rootfsCandidates(home, profile);
  const primaryPath = candidates[0];
  const created: string[] = [];
  const existing: string[] = [];
  for (const path of candidates.slice(0, 2)) {
    if (await exists(path)) {
      existing.push(path);
    } else {
      await mkdir(path);
      created.push(path);
    }
  }
  return { profile, primaryPath, created, existing };
}
