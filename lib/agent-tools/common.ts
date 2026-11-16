export type ValidationError = string | null;

export function safePath(path: string): string {
  if (
    !path ||
    path.includes("\0") ||
    path.split(/[\\/]/).includes("..") ||
    path.startsWith("/") ||
    path.startsWith("~") ||
    /^[A-Za-z]:[\\/]/.test(path)
  ) {
    throw new Error("PATH_NOT_ALLOWED: use a project-relative path");
  }
  return path;
}

export function quote(value: string): string {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

export function dependencyMutationError(command: string): string | null {
  const normalized = command.trim().replace(/\s+/g, " ");
  const pmMutation =
    /^(?:npm|yarn|bun)\s+(?:add|remove|rm|uninstall|update|upgrade|link|unlink|install)\b/i;
  const pnpmMutation =
    /^pnpm\s+(?:add|remove|rm|uninstall|update|upgrade|link|unlink)\b/i;

  if (pmMutation.test(normalized) || pnpmMutation.test(normalized)) {
    return "BUILD_DEPENDENCY_MUTATION_NOT_ALLOWED";
  }
  if (
    /^pnpm\s+install\b/i.test(normalized) &&
    !/\b--frozen-lockfile\b/i.test(normalized)
  ) {
    return "BUILD_DEPENDENCY_INSTALL_NOT_FROZEN";
  }
  return null;
}

export function isArgsObject(args: unknown): args is Record<string, unknown> {
  return !!args && typeof args === "object" && !Array.isArray(args);
}

export function isInteger(value: unknown): boolean {
  return Number.isInteger(Number(value));
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
