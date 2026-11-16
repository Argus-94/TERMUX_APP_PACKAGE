/**
 * Minimal POSIX path operations for Android/Termux project roots.
 * This module deliberately has no Node built-in imports so Metro can bundle it.
 */
export function isAbsolutePosixPath(value: string): boolean {
  return typeof value === "string" && value.startsWith("/");
}

export function normalizeAbsolutePosixPath(value: string): string {
  if (!isAbsolutePosixPath(value)) throw new Error("PROJECT_ROOT_REQUIRED");
  if (value.includes("\0")) throw new Error("PATH_NOT_ALLOWED");
  const segments: string[] = [];
  for (const segment of value.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return `/${segments.join("/")}`;
}

export function resolvePosixPath(root: string, value: string): string {
  if (typeof value !== "string" || value.includes("\0")) throw new Error("PATH_NOT_ALLOWED");
  const normalizedRoot = normalizeAbsolutePosixPath(root);
  return normalizeAbsolutePosixPath(isAbsolutePosixPath(value) ? value : `${normalizedRoot}/${value}`);
}
