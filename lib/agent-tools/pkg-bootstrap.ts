/**
 * Smart pkg / bootstrap profiles (antigravity-inspired native pkg manager idea).
 * Ensures common toolchains via Termux `pkg` (host) or apt (ubuntu-proot).
 *
 * Full tool registration in agent-tools/index is left for wiring session;
 * this module provides pure profile definitions and command builders.
 */

import type { AgentShellBackend } from "../agent-shell-backend";

export type PkgProfileId = "base" | "node" | "python" | "android-build" | "git-extras";

export type PkgProfile = {
  id: PkgProfileId;
  description: string;
  termuxPackages: string[];
  aptPackages: string[];
};

export const PKG_PROFILES: Record<PkgProfileId, PkgProfile> = {
  base: {
    id: "base",
    description: "Core utilities: git, curl, wget, openssh",
    termuxPackages: ["git", "curl", "wget", "openssh"],
    aptPackages: ["git", "curl", "wget", "openssh-client"],
  },
  node: {
    id: "node",
    description: "Node.js toolchain",
    termuxPackages: ["nodejs", "yarn"],
    aptPackages: ["nodejs", "npm"],
  },
  python: {
    id: "python",
    description: "Python 3 + pip",
    termuxPackages: ["python", "python-pip"],
    aptPackages: ["python3", "python3-pip"],
  },
  "android-build": {
    id: "android-build",
    description: "Lightweight Android build helpers (openjdk when available)",
    termuxPackages: ["openjdk-17", "aapt", "dx"],
    aptPackages: ["openjdk-17-jdk-headless", "aapt", "dalvik-exchange"],
  },
  "git-extras": {
    id: "git-extras",
    description: "git + gh CLI extras",
    termuxPackages: ["git", "gh"],
    aptPackages: ["git", "gh"],
  },
};

export function listPkgProfiles(): PkgProfile[] {
  return Object.values(PKG_PROFILES);
}

export function getPkgProfile(id: string): PkgProfile | null {
  const key = String(id || "").trim() as PkgProfileId;
  return PKG_PROFILES[key] || null;
}

/** Build install command for the active backend. */
export function buildPkgEnsureCommand(
  profileId: PkgProfileId | string,
  backend: AgentShellBackend,
): { ok: true; command: string; packages: string[] } | { ok: false; error: string } {
  const profile = getPkgProfile(profileId);
  if (!profile) {
    return { ok: false, error: `Unknown profile: ${profileId}. Known: ${Object.keys(PKG_PROFILES).join(", ")}` };
  }
  if (backend === "ubuntu-proot") {
    const pkgs = profile.aptPackages.join(" ");
    return {
      ok: true,
      packages: profile.aptPackages,
      command: `export DEBIAN_FRONTEND=noninteractive; apt-get update -qq && apt-get install -y ${pkgs}`,
    };
  }
  const pkgs = profile.termuxPackages.join(" ");
  return {
    ok: true,
    packages: profile.termuxPackages,
    command: `pkg update -y && pkg install -y ${pkgs}`,
  };
}

/** Multi-profile ensure (deduped package list). */
export function buildMultiProfileEnsureCommand(
  profileIds: string[],
  backend: AgentShellBackend,
): { ok: true; command: string; packages: string[] } | { ok: false; error: string } {
  const packages = new Set<string>();
  for (const id of profileIds) {
    const p = getPkgProfile(id);
    if (!p) return { ok: false, error: `Unknown profile: ${id}` };
    const list = backend === "ubuntu-proot" ? p.aptPackages : p.termuxPackages;
    list.forEach((x) => packages.add(x));
  }
  const pkgs = Array.from(packages);
  if (!pkgs.length) return { ok: false, error: "No packages to install" };
  if (backend === "ubuntu-proot") {
    return {
      ok: true,
      packages: pkgs,
      command: `export DEBIAN_FRONTEND=noninteractive; apt-get update -qq && apt-get install -y ${pkgs.join(" ")}`,
    };
  }
  return {
    ok: true,
    packages: pkgs,
    command: `pkg update -y && pkg install -y ${pkgs.join(" ")}`,
  };
}
