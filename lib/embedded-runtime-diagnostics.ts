/** Fixed diagnostic vocabulary only: never persist native messages, paths or shell text. */
export const EMBEDDED_EXEC_FAILURE_CODES = [
  "EMBEDDED_EXEC_RUNTIME_NOT_READY", "EMBEDDED_EXEC_IDENTITY_REJECTED",
  "EMBEDDED_EXEC_LAYOUT_REJECTED", "EMBEDDED_EXEC_CWD_REJECTED",
  "EMBEDDED_EXEC_TMP_FAILED", "EMBEDDED_EXEC_START_FAILED",
  "EMBEDDED_EXEC_IO_FAILED", "EMBEDDED_EXEC_WAIT_FAILED",
  "EMBEDDED_EXEC_FAILED", "EMBEDDED_EXEC_BUSY", "EMBEDDED_EXEC_ID_IN_USE",
  "EMBEDDED_EXEC_REQUEST_ID_INVALID", "EMBEDDED_EXEC_COMMAND_INVALID",
  "EMBEDDED_EXEC_TIMEOUT_INVALID", "EMBEDDED_TERMUX_STATUS_FAILED",
] as const;
export type EmbeddedFailureCode = typeof EMBEDDED_EXEC_FAILURE_CODES[number] | "UNCLASSIFIED_NATIVE_REJECTION";
const allowed = new Set<string>(EMBEDDED_EXEC_FAILURE_CODES);
export function embeddedFailureCode(error: unknown): EmbeddedFailureCode {
  if (error && typeof error === "object") {
    const value = error as { code?: unknown; message?: unknown };
    if (typeof value.code === "string" && allowed.has(value.code)) return value.code as EmbeddedFailureCode;
    if (typeof value.message === "string" && allowed.has(value.message)) return value.message as EmbeddedFailureCode;
  }
  return typeof error === "string" && allowed.has(error) ? error as EmbeddedFailureCode : "UNCLASSIFIED_NATIVE_REJECTION";
}
export type EmbeddedCwdRejectionDetails = {
  reasonCode: "EMBEDDED_EXEC_CWD_REJECTED" | "EMBEDDED_EXEC_CWD_SCOPE_REJECTED" | "EMBEDDED_EXEC_CWD_ALL_FILES_ACCESS_REQUIRED" | "EMBEDDED_EXEC_CWD_WORKSPACE_ROOT_MISSING" | "EMBEDDED_EXEC_CWD_DIRECTORY_MISSING" | "EMBEDDED_EXEC_CWD_NOT_DIRECTORY" | "EMBEDDED_EXEC_CWD_ROOT_SYMLINK_REJECTED" | "EMBEDDED_EXEC_CWD_COMPONENT_SYMLINK_REJECTED";
  pathCategory: "scope_or_resolution" | "permission_required" | "workspace_root_missing" | "directory_missing" | "not_directory" | "allowlisted_root_symlink" | "path_component_symlink" | "unclassified_resolution";
};
/** Map only stable native enums to a path category; never persist the native message or requested cwd. */
export function embeddedCwdRejectionDetails(error: unknown): EmbeddedCwdRejectionDetails | undefined {
  if (embeddedFailureCode(error) !== "EMBEDDED_EXEC_CWD_REJECTED") return undefined;
  const message = error && typeof error === "object" ? (error as { message?: unknown }).message : undefined;
  if (message === "EMBEDDED_EXEC_CWD_SCOPE_REJECTED") {
    return { reasonCode: "EMBEDDED_EXEC_CWD_SCOPE_REJECTED", pathCategory: "scope_or_resolution" };
  }
  if (message === "EMBEDDED_EXEC_CWD_ALL_FILES_ACCESS_REQUIRED") {
    return { reasonCode: "EMBEDDED_EXEC_CWD_ALL_FILES_ACCESS_REQUIRED", pathCategory: "permission_required" };
  }
  if (message === "EMBEDDED_EXEC_CWD_WORKSPACE_ROOT_MISSING") {
    return { reasonCode: "EMBEDDED_EXEC_CWD_WORKSPACE_ROOT_MISSING", pathCategory: "workspace_root_missing" };
  }
  if (message === "EMBEDDED_EXEC_CWD_DIRECTORY_MISSING") {
    return { reasonCode: "EMBEDDED_EXEC_CWD_DIRECTORY_MISSING", pathCategory: "directory_missing" };
  }
  if (message === "EMBEDDED_EXEC_CWD_NOT_DIRECTORY") {
    return { reasonCode: "EMBEDDED_EXEC_CWD_NOT_DIRECTORY", pathCategory: "not_directory" };
  }
  if (message === "EMBEDDED_EXEC_CWD_ROOT_SYMLINK_REJECTED") {
    return { reasonCode: "EMBEDDED_EXEC_CWD_ROOT_SYMLINK_REJECTED", pathCategory: "allowlisted_root_symlink" };
  }
  if (message === "EMBEDDED_EXEC_CWD_COMPONENT_SYMLINK_REJECTED") {
    return { reasonCode: "EMBEDDED_EXEC_CWD_COMPONENT_SYMLINK_REJECTED", pathCategory: "path_component_symlink" };
  }
  return { reasonCode: "EMBEDDED_EXEC_CWD_REJECTED", pathCategory: "unclassified_resolution" };
}
export function embeddedStatusDiagnostic(value: unknown): Record<string, string | boolean> {
  const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const result: Record<string, string | boolean> = {};
  for (const key of ["ready", "prefixPresent", "homePresent", "shellPresent", "packageManagerPresent", "dpkgPresent", "termuxConfigPresent", "aptSourcesPresent", "dpkgDatabasePresent", "prefixWritable", "bootstrapManifestPresent", "bootstrapManifestValid"]) {
    result[key] = typeof source[key] === "boolean" ? source[key] as boolean : "invalid_or_absent";
  }
  return result;
}
