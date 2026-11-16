/**
 * Runtime-only toolchain description.
 * Does not install, download or rewrite project build configuration.
 */

export type ToolchainKind =
  | "android-sdk"
  | "java"
  | "node"
  | "python"
  | "git"
  | "gradle"
  | "cmake"
  | "ndk"
  | "other";

export type ToolchainHealth = "unknown" | "healthy" | "degraded" | "missing";

export type ToolchainManifest = {
  readonly id: string;
  readonly kind: ToolchainKind;
  readonly name: string;
  readonly version?: string;
  readonly path?: string;
  readonly home?: string;
  readonly health: ToolchainHealth;
  readonly discoveredAt: number;
  readonly metadata?: Readonly<Record<string, string>>;
};

export function createToolchainManifest(
  input: Omit<ToolchainManifest, "discoveredAt" | "health"> & {
    health?: ToolchainHealth;
    discoveredAt?: number;
  },
): ToolchainManifest {
  if (!input.id || !input.kind || !input.name) {
    throw new Error("ToolchainManifest requires id, kind and name");
  }
  return {
    id: input.id,
    kind: input.kind,
    name: input.name,
    version: input.version,
    path: input.path,
    home: input.home,
    health: input.health ?? "unknown",
    discoveredAt: input.discoveredAt ?? Date.now(),
    metadata: input.metadata ? { ...input.metadata } : undefined,
  };
}
