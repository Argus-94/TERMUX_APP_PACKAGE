const DEFAULT_PROJECT_ROOT_FILE = "$AIB_PRIVATE_ROOT/work/project_root";
const DEFAULT_BUILD_PATH_FILE = "$AIB_PRIVATE_ROOT/work/build_path";
const DEFAULT_PROJECT_PATH_FILE = "$AIB_PRIVATE_ROOT/work/proj_path";
const DEFAULT_SHARED_PROJECTS_ROOT = "/storage/emulated/0/AIBuilderTermux/projects";

/** Select a user-visible artifact destination; reject a source root outside the shared projects workspace. */
export function buildProjectArtifactRootShell(): string {
  return [
    'AIB_ROOT_CANON=$(CDPATH= cd -- "$AIB_ROOT" 2>/dev/null && pwd -P) || { echo AI_BUILDER_SHARED_ROOT_UNAVAILABLE; exit 1; }',
    'ARTIFACT_ROOT="$AIB_ROOT_CANON/outputs"',
    'if [ -n "$SRC" ]; then SRC_CANON=$(CDPATH= cd -- "$SRC" 2>/dev/null && pwd -P) || { echo PROJECT_SOURCE_PATH_INVALID; exit 1; }; case "$SRC_CANON/" in "$AIB_ROOT_CANON/projects/"*) ARTIFACT_ROOT="$SRC_CANON/outputs";; *) echo PROJECT_ARTIFACT_ROOT_INVALID; exit 1;; esac; fi',
    'mkdir -p "$ARTIFACT_ROOT"',
  ].join("; ") + ";";
}

function shellQuote(value: string): string {
  if (/[\0\r\n]/.test(value)) throw new Error("AIB_PROJECT_PATH_FILE_INVALID");
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function shellPath(value: string): string {
  const prefix = "$AIB_PRIVATE_ROOT/";
  if (!value.startsWith(prefix)) return shellQuote(value);
  const relative = value.slice(prefix.length);
  if (!relative || relative.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("AIB_PROJECT_PATH_FILE_INVALID");
  }
  return `"$AIB_PRIVATE_ROOT"/${relative.split("/").map(shellQuote).join("/")}`;
}

/**
 * Pin both paths as data. proj_path is the single canonical user-visible root
 * shared by filesystem tools and app registry; build_path is an in-project
 * build-system subdirectory used only as the executor cwd.
 */
export function buildProjectPathPinReadbackCommand(options: {
  projectRootFile?: string;
  buildPathFile?: string;
  projectPathFile?: string;
  sharedProjectsRoot?: string;
} = {}): string {
  const projectRootFile = shellPath(options.projectRootFile || DEFAULT_PROJECT_ROOT_FILE);
  const buildPathFile = shellPath(options.buildPathFile || DEFAULT_BUILD_PATH_FILE);
  const projectPathFile = shellPath(options.projectPathFile || DEFAULT_PROJECT_PATH_FILE);
  const sharedProjectsRoot = shellQuote(options.sharedProjectsRoot || DEFAULT_SHARED_PROJECTS_ROOT);
  return [
    "set -eu",
    `AIB_PROJECT_ROOT_FILE=${projectRootFile}`,
    `AIB_BUILD_PATH_FILE=${buildPathFile}`,
    `AIB_PROJECT_PATH_FILE=${projectPathFile}`,
    `AIB_SHARED_PROJECTS_ROOT=${sharedProjectsRoot}`,
    '[ -s "$AIB_PROJECT_ROOT_FILE" ] || { echo NO_PROJECT_ROOT; exit 20; }',
    '[ -s "$AIB_BUILD_PATH_FILE" ] || { echo NO_BUILD_PATH; exit 21; }',
    'AIB_PROJECT_ROOT_RAW=$(cat "$AIB_PROJECT_ROOT_FILE") || { echo AIB_PROJECT_ROOT_READ_FAILED; exit 22; }',
    'AIB_BUILD_PATH_RAW=$(cat "$AIB_BUILD_PATH_FILE") || { echo AIB_BUILD_PATH_READ_FAILED; exit 23; }',
    'AIB_PROJECT_PATH_NL=$(printf "\\nX"); AIB_PROJECT_PATH_NL=${AIB_PROJECT_PATH_NL%X}',
    'case "$AIB_PROJECT_ROOT_RAW" in *"$AIB_PROJECT_PATH_NL"*) echo AIB_PROJECT_PATH_NEWLINE_DENIED; exit 24;; esac',
    'case "$AIB_BUILD_PATH_RAW" in *"$AIB_PROJECT_PATH_NL"*) echo AIB_BUILD_PATH_NEWLINE_DENIED; exit 24;; esac',
    'case "/$AIB_PROJECT_ROOT_RAW/" in */../*|*/./*) echo AIB_PROJECT_PATH_TRAVERSAL_DENIED; exit 25;; esac',
    'case "/$AIB_BUILD_PATH_RAW/" in */../*|*/./*) echo AIB_BUILD_PATH_TRAVERSAL_DENIED; exit 26;; esac',
    'case "$AIB_PROJECT_ROOT_RAW" in /*) ;; *) echo AIB_PROJECT_PATH_NOT_ABSOLUTE; exit 27;; esac',
    'case "$AIB_BUILD_PATH_RAW" in /*) ;; *) echo AIB_BUILD_PATH_NOT_ABSOLUTE; exit 28;; esac',
    'AIB_PROJECT_CANONICAL=$(CDPATH= cd -- "$AIB_PROJECT_ROOT_RAW" 2>/dev/null && pwd -P) || { echo AIB_PROJECT_PATH_DIRECTORY_MISSING; exit 29; }',
    'AIB_BUILD_CANONICAL=$(CDPATH= cd -- "$AIB_BUILD_PATH_RAW" 2>/dev/null && pwd -P) || { echo AIB_BUILD_PATH_DIRECTORY_MISSING; exit 30; }',
    'AIB_PROJECTS_CANONICAL=$(CDPATH= cd -- "$AIB_SHARED_PROJECTS_ROOT" 2>/dev/null && pwd -P) || { echo AIB_PROJECTS_ROOT_MISSING; exit 31; }',
    'case "$AIB_PROJECT_CANONICAL/" in "$AIB_PROJECTS_CANONICAL/"*) ;; *) echo AIB_PROJECT_PATH_OUTSIDE_SHARED_PROJECTS; exit 32;; esac',
    'case "$AIB_BUILD_CANONICAL/" in "$AIB_PROJECT_CANONICAL/"*) ;; *) echo AIB_BUILD_PATH_OUTSIDE_PROJECT; exit 33;; esac',
    'mkdir -p "$(dirname "$AIB_PROJECT_PATH_FILE")" "$(dirname "$AIB_BUILD_PATH_FILE")"',
    'AIB_PROJECT_TMP="${AIB_PROJECT_PATH_FILE}.tmp.$$"; AIB_BUILD_TMP="${AIB_BUILD_PATH_FILE}.tmp.$$"',
    String.raw`trap 'rm -f "$AIB_PROJECT_TMP" "$AIB_BUILD_TMP"' EXIT`,
    'printf "%s\\n" "$AIB_PROJECT_CANONICAL" > "$AIB_PROJECT_TMP"',
    'printf "%s\\n" "$AIB_BUILD_CANONICAL" > "$AIB_BUILD_TMP"',
    'mv -f -- "$AIB_PROJECT_TMP" "$AIB_PROJECT_PATH_FILE"; mv -f -- "$AIB_BUILD_TMP" "$AIB_BUILD_PATH_FILE"',
    'trap - EXIT',
    'AIB_PROJECT_READBACK=$(cat "$AIB_PROJECT_PATH_FILE"); AIB_BUILD_READBACK=$(cat "$AIB_BUILD_PATH_FILE")',
    '[ "$AIB_PROJECT_READBACK" = "$AIB_PROJECT_CANONICAL" ] && [ -d "$AIB_PROJECT_READBACK" ] || { echo AIB_PROJECT_PATH_READBACK_FAILED; exit 34; }',
    '[ "$AIB_BUILD_READBACK" = "$AIB_BUILD_CANONICAL" ] && [ -d "$AIB_BUILD_READBACK" ] || { echo AIB_BUILD_PATH_READBACK_FAILED; exit 35; }',
    'echo PINNED_DIR_OK; echo PINNED_BUILD_DIR_OK',
  ].join("\n");
}
