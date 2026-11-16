/**
 * Canonical persistent HOME layout for AIBuilderTermux.
 *
 * This module is runtime-only: it does not alter Android/Gradle/Expo
 * compilation configuration.
 */

export const AI_BUILDER_HOME_ENV = 'AI_BUILDER_HOME' as const;
export const AI_BUILDER_HOME_NAME = 'AIBuilderTermux' as const;

export type HomePathKey =
  | 'root'
  | 'projects'
  | 'workspace'
  | 'containers'
  | 'containersUbuntu'
  | 'containersKali'
  | 'toolchains'
  | 'sdk'
  | 'cache'
  | 'logs'
  | 'backups'
  | 'metadata';

export interface HomeLayout {
  readonly root: string;
  readonly projects: string;
  readonly workspace: string;
  readonly containers: string;
  readonly containersUbuntu: string;
  readonly containersKali: string;
  readonly toolchains: string;
  readonly sdk: string;
  readonly cache: string;
  readonly logs: string;
  readonly backups: string;
  readonly metadata: string;
}

function joinPath(root: string, child: string): string {
  const normalized = root.replace(/[\\/]+$/, '');
  return `${normalized}/${child}`;
}

/** Build the complete layout below one canonical AIBuilderTermux HOME. */
export function createHomeLayout(root: string): HomeLayout {
  if (!root || root.trim() === '') {
    throw new Error('AI_BUILDER_HOME_REQUIRED');
  }

  const canonicalRoot = root.replace(/[\\/]+$/, '') || '/';

  return {
    root: canonicalRoot,
    projects: joinPath(canonicalRoot, 'projects'),
    workspace: joinPath(canonicalRoot, 'workspace'),
    containers: joinPath(canonicalRoot, 'containers'),
    containersUbuntu: joinPath(joinPath(canonicalRoot, 'containers'), 'ubuntu'),
    containersKali: joinPath(joinPath(canonicalRoot, 'containers'), 'kali'),
    toolchains: joinPath(canonicalRoot, 'toolchains'),
    sdk: joinPath(canonicalRoot, 'sdk'),
    cache: joinPath(canonicalRoot, 'cache'),
    logs: joinPath(canonicalRoot, 'logs'),
    backups: joinPath(canonicalRoot, 'backups'),
    metadata: joinPath(joinPath(canonicalRoot, '.ai-builder'), 'metadata'),
  };
}

export const HOME_PATH_KEYS: readonly HomePathKey[] = [
  'root',
  'projects',
  'workspace',
  'containers',
  'containersUbuntu',
  'containersKali',
  'toolchains',
  'sdk',
  'cache',
  'logs',
  'backups',
  'metadata',
] as const;
