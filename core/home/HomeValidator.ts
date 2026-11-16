/**
 * Validates the canonical AIBuilderTermux HOME directory tree.
 *
 * Runtime-only: validation is read-only and never creates, deletes, or
 * modifies directories or Android/Gradle/Expo compilation configuration.
 */

import { HOME_INITIALIZATION_PATHS } from './HomeInitializer';
import type { HomeLayout } from './HomeLayout';

export interface HomeDirectoryValidatorAdapter {
  /** Return true only when the path exists and is a directory. */
  isDirectory(path: string): Promise<boolean> | boolean;
}

export interface HomeValidationResult {
  readonly valid: boolean;
  readonly root: string;
  readonly missing: readonly string[];
  readonly checked: readonly string[];
}

/** Validate every canonical HOME directory without mutating storage. */
export async function validateHome(
  layout: HomeLayout,
  adapter: HomeDirectoryValidatorAdapter,
): Promise<HomeValidationResult> {
  const paths = HOME_INITIALIZATION_PATHS(layout);
  const missing: string[] = [];

  for (const path of paths) {
    if (!(await adapter.isDirectory(path))) {
      missing.push(path);
    }
  }

  return {
    valid: missing.length === 0,
    root: layout.root,
    missing,
    checked: paths,
  };
}
