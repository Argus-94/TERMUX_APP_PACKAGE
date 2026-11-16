/**
 * Unified container shell API — Ubuntu only (Kali removed).
 */
import type { HomeLayout } from "../home/HomeLayout";
import {
  buildUbuntuShellSpec,
  describeUbuntuShell,
  type UbuntuShellSpec,
} from "../ubuntu/UbuntuShell";

export type ContainerProfile = "ubuntu";

export type ContainerShellSpec = {
  profile: ContainerProfile;
  instanceId: string;
  projectRoot: string;
  containerCwd: string;
  env: Record<string, string>;
  shellCommand: string;
};

export function buildContainerShellSpec(
  home: HomeLayout,
  _profile: ContainerProfile,
  input: { instanceId: string; projectId: string; projectRoot?: string },
): ContainerShellSpec {
  const s: UbuntuShellSpec = buildUbuntuShellSpec(home, input);
  return { profile: "ubuntu", ...s };
}

export function describeContainerShell(spec: ContainerShellSpec): string {
  return describeUbuntuShell(spec);
}
