/** Canonical path boundary for host-side writes performed outside a Proot guest. */
export type PathResolver = (path: string) => Promise<string>;

export const AI_BUILDER_SHARED_ROOT = "/storage/emulated/0/AIBuilderTermux" as const;
export const SHARED_APP_WRITE_ROOTS = [AI_BUILDER_SHARED_ROOT] as const;

/** Lexical containment helper for paths already routed through the Termux host. */
export function isWithinSharedAppRoot(candidate: string): boolean {
  if (!candidate.startsWith("/") || candidate.includes("\0") || /[\r\n]/.test(candidate)) return false;
  const parts = candidate.split("/").filter(Boolean);
  if (parts.some((part) => part === "..")) return false;
  const normalized = `/${parts.filter((part) => part !== ".").join("/")}`;
  return normalized === AI_BUILDER_SHARED_ROOT || normalized.startsWith(`${AI_BUILDER_SHARED_ROOT}/`);
}

function isWithin(candidate: string, root: string): boolean {
  const normalizedRoot = root.replace(/\/+$/, "") || "/";
  return candidate === normalizedRoot || candidate.startsWith(`${normalizedRoot === "/" ? "" : normalizedRoot}/`);
}

/** Return the canonical destination only when it is within one of the supplied trusted roots. */
export async function resolveAllowedWritePath(candidate: string, roots: readonly string[], resolve: PathResolver): Promise<string> {
  if (!candidate.startsWith("/") || candidate.includes("\0") || /[\r\n]/.test(candidate)) throw new Error("PATH_INVALID");
  let canonicalCandidate: string;
  try { canonicalCandidate = await resolve(candidate); }
  catch { throw new Error("PATH_RESOLVE_FAILED"); }
  if (!canonicalCandidate.startsWith("/") || canonicalCandidate.includes("\0") || /[\r\n]/.test(canonicalCandidate)) throw new Error("PATH_RESOLVE_FAILED");
  for (const root of roots) {
    if (!root.startsWith("/") || root.includes("\0") || /[\r\n]/.test(root)) continue;
    let canonicalRoot: string;
    try { canonicalRoot = await resolve(root); }
    catch { continue; }
    if (canonicalRoot.startsWith("/") && isWithin(canonicalCandidate, canonicalRoot)) return canonicalCandidate;
  }
  throw new Error("PATH_OUTSIDE_ALLOWED_WRITE_ROOT");
}
