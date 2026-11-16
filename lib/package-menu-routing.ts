import type { AgentShellBackend } from "./agent-shell-backend";

/** The right-side package menu is a Termux host tools panel, not a build-target selector. */
export const RIGHT_PACKAGE_MENU_BACKEND: AgentShellBackend = "termux";

/**
 * Keep this entry-point policy separate from the generic package runner: build
 * and runtime flows may still target Debian/Ubuntu, but the right menu never does.
 */
export function resolveRightPackageMenuBackend(_selectedBuildBackend: AgentShellBackend): AgentShellBackend {
  return RIGHT_PACKAGE_MENU_BACKEND;
}

export const RIGHT_PACKAGE_MENU_SECTIONS = ["compile", "reverse", "custom"] as const;
export type RightPackageMenuSection = (typeof RIGHT_PACKAGE_MENU_SECTIONS)[number];

/** Resolve one lazy scan request; expanding a section never schedules its siblings. */
export function resolveRightPackageMenuExpansionScanPlan(
  selectedBuildBackend: AgentShellBackend,
  section: RightPackageMenuSection,
): Readonly<{ target: AgentShellBackend; section: RightPackageMenuSection }> {
  return {
    target: resolveRightPackageMenuBackend(selectedBuildBackend),
    section,
  };
}

/** Rootfs provisioning belongs to the dedicated runtime screen, not a tools list. */
const RIGHT_MENU_EXCLUDED_PACKAGE_IDS = new Set(["debian-rootfs", "ubuntu-rootfs"]);

export function isRightPackageMenuPackage(packageId: string): boolean {
  return !RIGHT_MENU_EXCLUDED_PACKAGE_IDS.has(packageId);
}
