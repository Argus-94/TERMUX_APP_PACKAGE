/**
 * Initializes the canonical AIBuilderTermux HOME directory tree.
 *
 * Storage access is injected deliberately: the Builder must not assume that
 * Android shared storage is directly writable from the JS runtime. A future
 * Termux/bridge backend can provide the actual directory creator.
 *
 * Runtime-only: this module does not touch Android/Gradle/Expo compilation
 * configuration.
 */

import type { HomeLayout } from './HomeLayout';

export interface HomeDirectoryAdapter {
  /** Create a directory and its parents; existing directories are allowed. */
  ensureDirectory(path: string): Promise<void> | void;
}

export interface HomeInitializationResult {
  readonly root: string;
  readonly created: readonly string[];
}

export const HOME_INITIALIZATION_PATHS = (layout: HomeLayout): readonly string[] => [
  layout.root,
  layout.projects,
  layout.workspace,
  layout.containers,
  layout.containersUbuntu,
  layout.containersKali,
  layout.toolchains,
  layout.sdk,
  layout.cache,
  layout.logs,
  layout.backups,
  layout.metadata,
] as const;

/**
 * Create the complete persistent HOME layout in deterministic parent-first
 * order. The adapter decides how the paths are materialized on the device.
 */
export async function initializeHome(
  layout: HomeLayout,
  adapter: HomeDirectoryAdapter,
): Promise<HomeInitializationResult> {
  const paths = HOME_INITIALIZATION_PATHS(layout);

  for (const path of paths) {
    await adapter.ensureDirectory(path);
  }

  return {
    root: layout.root,
    created: paths,
  };
}
