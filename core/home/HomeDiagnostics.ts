/**
 * Runtime diagnostics for the canonical AIBuilderTermux HOME.
 *
 * The adapter is injected so Android/Termux storage permissions are handled by
 * the runtime bridge rather than by changing compilation configuration.
 */
import { HOME_INITIALIZATION_PATHS } from './HomeInitializer';
import type { HomeLayout } from './HomeLayout';

export interface HomeDiagnosticsAdapter {
  isDirectory(path: string): Promise<boolean> | boolean;
  canRead?(path: string): Promise<boolean> | boolean;
  canWrite?(path: string): Promise<boolean> | boolean;
  canExecute?(path: string): Promise<boolean> | boolean;
  getFreeSpaceBytes?(path: string): Promise<number | null> | number | null;
}

export interface HomeDiagnosticsPermissions {
  read: boolean | null;
  write: boolean | null;
  execute: boolean | null;
}

export interface HomeDiagnosticsResult {
  readonly status: 'ready' | 'incomplete';
  readonly path: string;
  readonly permissions: HomeDiagnosticsPermissions;
  readonly exists: boolean;
  readonly missing: readonly string[];
  readonly freeSpaceBytes: number | null;
}

async function optionalCheck(
  fn: ((path: string) => Promise<boolean> | boolean) | undefined,
  path: string,
): Promise<boolean | null> {
  return fn ? Boolean(await fn(path)) : null;
}

/** Collect HOME status without creating, deleting, or modifying storage. */
export async function diagnoseHome(
  layout: HomeLayout,
  adapter: HomeDiagnosticsAdapter,
): Promise<HomeDiagnosticsResult> {
  const paths = HOME_INITIALIZATION_PATHS(layout);
  const missing: string[] = [];

  for (const path of paths) {
    if (!(await adapter.isDirectory(path))) missing.push(path);
  }

  const permissions: HomeDiagnosticsPermissions = {
    read: await optionalCheck(adapter.canRead, layout.root),
    write: await optionalCheck(adapter.canWrite, layout.root),
    execute: await optionalCheck(adapter.canExecute, layout.root),
  };

  const freeSpaceBytes = adapter.getFreeSpaceBytes
    ? await adapter.getFreeSpaceBytes(layout.root)
    : null;

  return {
    status: missing.length === 0 ? 'ready' : 'incomplete',
    path: layout.root,
    permissions,
    exists: missing.indexOf(layout.root) === -1,
    missing,
    freeSpaceBytes,
  };
}
