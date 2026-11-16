export const AI_BUILDER_WORKSPACE_ROOT = "/storage/emulated/0/AIBuilderTermux" as const;
export const AI_BUILDER_WORKSPACE_TREE_DOCUMENT_ID = "primary:AIBuilderTermux" as const;
export const AI_BUILDER_WORKSPACE_MAX_BYTES = 2 * 1024 * 1024;

/** Relative nested path accepted by the native procfd/no-follow file API. */
export function isSafeAIBuilderWorkspaceRelativePath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 1024 || value.includes("\0") || value.includes("\\") || value.startsWith("/")) return false;
  const parts = value.split("/");
  return parts.length > 0 && parts.every((part) => part.length > 0 && part.length <= 255 && part !== "." && part !== "..");
}

/** Shell cwd allowlist: absolute canonical private HOME or exact workspace descendants only. */
export function isAllowedEmbeddedWorkdir(value: unknown): value is string {
  if (typeof value !== "string" || !value.startsWith("/") || value.includes("\0") || value.includes("\\")) return false;
  const parts = value.split("/");
  if (parts.some((part, index) => index > 0 && (part === "" || part === "." || part === ".."))) return false;
  if (isCanonicalAIBuilderWorkspacePath(value)) return true;
  return /^\/data\/(?:data|user\/[0-9]+)\/com\.karat\.aibuilder\/files\/home(?:\/[^/]+)*$/.test(value);
}

/**
 * This policy is for the SAF-backed metadata adapter only. It does not widen
 * embedded Bash cwd containment or make a shared-storage path shell-readable.
 */
export function isCanonicalAIBuilderWorkspacePath(candidate: unknown): candidate is string {
  if (typeof candidate !== "string" || candidate.includes("\0") || candidate.includes("\\")) return false;
  if (candidate !== AI_BUILDER_WORKSPACE_ROOT && !candidate.startsWith(`${AI_BUILDER_WORKSPACE_ROOT}/`)) return false;
  const segments = candidate.split("/");
  if (segments.some((segment, index) => index > 0 && (segment === "" || segment === "." || segment === ".."))) return false;
  return segments[0] === "" && segments[1] === "storage" && segments[2] === "emulated" &&
    segments[3] === "0" && segments[4] === "AIBuilderTermux";
}

/** SAF tree document IDs are provider-scoped, not POSIX paths. Accept only the exact primary-volume root. */
export function isExactAIBuilderWorkspaceTreeDocumentId(documentId: unknown): documentId is string {
  return documentId === AI_BUILDER_WORKSPACE_TREE_DOCUMENT_ID;
}

/** A metadata child must be exactly one ordinary name below the granted tree; never follow nested IDs or traversal. */
export function isDirectAIBuilderWorkspaceChildDocumentId(documentId: unknown): documentId is string {
  if (typeof documentId !== "string" || !documentId.startsWith(`${AI_BUILDER_WORKSPACE_TREE_DOCUMENT_ID}/`)) return false;
  const name = documentId.slice(AI_BUILDER_WORKSPACE_TREE_DOCUMENT_ID.length + 1);
  return isSafeAIBuilderWorkspaceChildName(name);
}

export function isSafeAIBuilderWorkspaceChildName(name: unknown): name is string {
  return typeof name === "string" && name.length > 0 && name.length <= 255 && name !== "." && name !== ".." &&
    !name.includes("/") && !name.includes("\\") && !name.includes("\0");
}

/** Build a display/reference path only after exact-root and single-name validation. */
export function aiBuilderWorkspaceChildPath(root: unknown, name: unknown): string {
  if (root !== AI_BUILDER_WORKSPACE_ROOT || !isCanonicalAIBuilderWorkspacePath(root)) {
    throw new Error("AIB_WORKSPACE_ROOT_NOT_CANONICAL");
  }
  if (!isSafeAIBuilderWorkspaceChildName(name)) throw new Error("AIB_WORKSPACE_CHILD_NAME_INVALID");
  return `${root}/${name}`;
}
