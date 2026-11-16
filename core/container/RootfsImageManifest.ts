/**
 * Manifest for optional rootfs images (ubuntu/kali).
 * Describes expected layout and download metadata; does not fetch bytes.
 */

import type { ContainerProfile } from "./ContainerShell";
import type { HomeLayout } from "../home/HomeLayout";

export type RootfsImageManifest = {
  profile: ContainerProfile;
  version: string;
  /** Expected primary rootfs directory under HOME */
  rootfsPath: string;
  /** Optional upstream URL (documentation / future downloader) */
  sourceUrl?: string;
  /** Marker file that indicates a complete extract */
  readyMarker: string;
  notes: string[];
};

export function buildRootfsImageManifest(
  home: HomeLayout,
  profile: ContainerProfile,
  version = "base",
): RootfsImageManifest {
  const base =
    home.containersUbuntu;
  const rootfsPath = `${base}/images/${version}/rootfs`;
  return {
    profile,
    version,
    rootfsPath,
    sourceUrl:
      profile === "ubuntu"
        ? "https://cloud-images.ubuntu.com/"
        : "https://http.kali.org/kali/",
    readyMarker: `${rootfsPath}/.aib-rootfs-ready`,
    notes: [
      "Image bytes are not bundled in AI Builder",
      "Use ensureRootfs to create directories, then extract rootfs offline/device-side",
      "proot plan binds project to /workspace without owning project files",
    ],
  };
}

export async function isRootfsReady(
  manifest: RootfsImageManifest,
  exists: (path: string) => Promise<boolean>,
): Promise<boolean> {
  return exists(manifest.readyMarker);
}
