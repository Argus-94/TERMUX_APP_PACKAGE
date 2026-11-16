/**
 * Runtime-only ToolchainManager.
 *
 * Discovers and reports available toolchains under AIBuilderTermux HOME.
 * Never mutates project Gradle/Expo/Android compilation settings.
 */

import type { ToolchainKind, ToolchainManifest } from "./ToolchainManifest";
import { createToolchainManifest } from "./ToolchainManifest";

export type ToolchainDiscoveryResult = {
  readonly found: ToolchainManifest[];
  readonly missing: ToolchainKind[];
  readonly scannedAt: number;
};

export type ToolchainDiscoverySource = {
  /** Optional async probe that returns zero or more manifests. */
  discover: () => Promise<ToolchainManifest[]> | ToolchainManifest[];
};

export class ToolchainManager {
  private readonly registry = new Map<string, ToolchainManifest>();
  private readonly sources: ToolchainDiscoverySource[] = [];
  private readonly sourceOwnedIds = new Set<string>();
  private readonly manualIds = new Set<string>();

  registerSource(source: ToolchainDiscoverySource): void {
    this.sources.push(source);
  }

  register(manifest: ToolchainManifest): void {
    this.registry.set(manifest.id, manifest);
    this.manualIds.add(manifest.id);
  }

  get(id: string): ToolchainManifest | undefined {
    return this.registry.get(id);
  }

  list(kind?: ToolchainKind): ToolchainManifest[] {
    const all = [...this.registry.values()];
    if (!kind) return all;
    return all.filter((m) => m.kind === kind);
  }

  async refresh(): Promise<ToolchainDiscoveryResult> {
    const found: ToolchainManifest[] = [];
    const nextSourceIds = new Set<string>();
    for (const source of this.sources) {
      const items = await source.discover();
      for (const item of items) {
        const normalized = createToolchainManifest(item);
        nextSourceIds.add(normalized.id);
        if (!this.manualIds.has(normalized.id)) this.registry.set(normalized.id, normalized);
        found.push(normalized);
      }
    }
    for (const id of this.sourceOwnedIds) {
      if (!nextSourceIds.has(id) && !this.manualIds.has(id)) this.registry.delete(id);
    }
    this.sourceOwnedIds.clear();
    for (const id of nextSourceIds) this.sourceOwnedIds.add(id);
    const presentKinds = new Set(found.map((m) => m.kind));
    const expected: ToolchainKind[] = [
      "android-sdk",
      "java",
      "node",
      "python",
      "git",
    ];
    const missing = expected.filter((k) => !presentKinds.has(k));
    return {
      found,
      missing,
      scannedAt: Date.now(),
    };
  }

  diagnostics(): {
    available: number;
    byKind: Record<string, number>;
    items: ToolchainManifest[];
  } {
    const items = this.list();
    const byKind: Record<string, number> = {};
    for (const item of items) {
      byKind[item.kind] = (byKind[item.kind] ?? 0) + 1;
    }
    return {
      available: items.length,
      byKind,
      items,
    };
  }
}

/** Factory with empty registry; callers inject discovery sources. */
export function createToolchainManager(): ToolchainManager {
  return new ToolchainManager();
}
