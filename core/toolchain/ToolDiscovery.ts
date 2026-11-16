/**
 * Read-only discovery helpers for Java / Node / Python / Git.
 * Uses injected path probes; never mutates PATH or project files.
 */

import type { ToolchainKind, ToolchainManifest } from "./ToolchainManifest";
import { createToolchainManifest } from "./ToolchainManifest";
import { discoverAndroidSdk, type PathProbe } from "./AndroidSdkDiscovery";

export type CommandProbe = {
  /** Returns stdout of `command --version` or similar, or null if missing. */
  whichVersion: (
    command: string,
    versionArgs?: string[],
  ) => Promise<{ path?: string; version?: string } | null>;
};

type SimpleToolSpec = {
  kind: ToolchainKind;
  name: string;
  command: string;
  versionArgs?: string[];
};

const SIMPLE_TOOLS: SimpleToolSpec[] = [
  { kind: "java", name: "Java", command: "java", versionArgs: ["-version"] },
  { kind: "node", name: "Node.js", command: "node", versionArgs: ["--version"] },
  { kind: "python", name: "Python", command: "python3", versionArgs: ["--version"] },
  { kind: "python", name: "Python", command: "python", versionArgs: ["--version"] },
  { kind: "git", name: "Git", command: "git", versionArgs: ["--version"] },
  { kind: "gradle", name: "Gradle", command: "gradle", versionArgs: ["--version"] },
];

export async function discoverSimpleTools(
  commandProbe: CommandProbe,
): Promise<ToolchainManifest[]> {
  const results: ToolchainManifest[] = [];
  const seenKinds = new Set<string>();

  for (const tool of SIMPLE_TOOLS) {
    // Prefer first successful probe per kind (e.g. python3 before python)
    const key = `${tool.kind}:${tool.command}`;
    if (seenKinds.has(key)) continue;

    try {
      const info = await commandProbe.whichVersion(
        tool.command,
        tool.versionArgs,
      );
      if (!info) continue;
      seenKinds.add(key);
      results.push(
        createToolchainManifest({
          id: `${tool.kind}:${tool.command}`,
          kind: tool.kind,
          name: tool.name,
          path: info.path,
          version: info.version,
          health: info.path || info.version ? "healthy" : "degraded",
          metadata: { command: tool.command },
        }),
      );
    } catch {
      // ignore probe failures
    }
  }

  return results;
}

/** Convenience: probe common HOME/toolchains layout paths (read-only). */
export async function discoverHomeToolchainDirs(
  probe: PathProbe,
  toolchainsRoot: string,
): Promise<ToolchainManifest[]> {
  const kinds: Array<{ dir: string; kind: ToolchainKind; name: string }> = [
    { dir: "java", kind: "java", name: "Java (HOME)" },
    { dir: "node", kind: "node", name: "Node (HOME)" },
    { dir: "python", kind: "python", name: "Python (HOME)" },
  ];

  const out: ToolchainManifest[] = [];
  for (const item of kinds) {
    const path = `${toolchainsRoot.replace(/\/$/, "")}/${item.dir}`;
    if (await probe.exists(path)) {
      out.push(
        createToolchainManifest({
          id: `home:${item.kind}`,
          kind: item.kind,
          name: item.name,
          path,
          home: path,
          health: "healthy",
          metadata: { source: "AIBuilderTermux/toolchains" },
        }),
      );
    }
  }
  return out;
}

/** Discover common HOME toolchains while applying SDK-specific validation to Android. */
export async function discoverRuntimeToolchains(
  probe: PathProbe,
  toolchainsRoot: string,
  homeSdkPath: string,
): Promise<ToolchainManifest[]> {
  const normalizedRoot = toolchainsRoot.replace(/\/+$/, "");
  const [homeTools, androidSdks] = await Promise.all([
    discoverHomeToolchainDirs(probe, normalizedRoot),
    discoverAndroidSdk(probe, {
      homeSdkPath,
      extraCandidates: [`${normalizedRoot}/android-sdk`],
    }),
  ]);
  // Defense in depth: never allow a generic path-presence manifest to override SDK evidence.
  return [...homeTools.filter((item) => item.kind !== "android-sdk"), ...androidSdks];
}
