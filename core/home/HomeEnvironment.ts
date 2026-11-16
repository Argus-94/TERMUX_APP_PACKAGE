/**
 * Canonical HOME environment for AIBuilderTermux.
 *
 * Runtime-only: this module does not edit project files, Gradle settings,
 * Expo configuration, or Android compilation settings.
 */

import { AI_BUILDER_HOME_ENV, AI_BUILDER_HOME_NAME, createHomeLayout, type HomeLayout } from './HomeLayout';
import { AI_BUILDER_SHARED_ROOT } from '../../lib/writable-path-policy';

export const DEFAULT_AI_BUILDER_HOME = '/storage/emulated/0/AIBuilderTermux' as const;

export interface HomeEnvironment {
  /** Real target HOME, only when the caller supplied it; never the app workspace. */
  readonly HOME?: string;
  readonly AI_BUILDER_HOME: string;
  readonly layout: HomeLayout;
}

export interface HomeEnvironmentInput {
  readonly AI_BUILDER_HOME?: string;
  readonly HOME?: string;
}

function normalizeCandidate(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Resolve the persistent Builder HOME.
 *
 * The application workspace is fixed at the Android shared-storage root.
 * HOME is the real target's Termux/OS home and never selects the app workspace.
 *
 * An unrelated Termux $HOME is never silently promoted to the Builder HOME.
 */
export function resolveAiBuilderHome(input: HomeEnvironmentInput = {}): string {
  const explicit = normalizeCandidate(input.AI_BUILDER_HOME);
  const canonical = explicit?.replace(/[\\/]+$/, '');
  if (canonical && canonical !== AI_BUILDER_SHARED_ROOT) throw new Error('AI_BUILDER_HOME_OUTSIDE_SHARED_ROOT');
  return AI_BUILDER_SHARED_ROOT;
}

/** Build the environment contract without mutating process.env. */
export function createHomeEnvironment(input: HomeEnvironmentInput = {}): HomeEnvironment {
  const root = resolveAiBuilderHome(input);
  const layout = createHomeLayout(root);
  const realHome = normalizeCandidate(input.HOME);

  return {
    ...(realHome ? { HOME: realHome } : {}),
    AI_BUILDER_HOME: layout.root,
    layout,
  };
}

export const HOME_ENVIRONMENT_KEYS = [AI_BUILDER_HOME_ENV, 'HOME'] as const;
