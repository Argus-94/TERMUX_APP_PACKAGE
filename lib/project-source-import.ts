const DEFAULT_SHARED_ROOT = "/storage/emulated/0/AIBuilderTermux";

function shellQuote(value: string): string {
  if (/[\0\r\n]/.test(value)) throw new Error("PROJECT_SOURCE_PATH_INVALID");
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function validateProofId(value: string | undefined): string {
  if (value === undefined || value === "") return "";
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(value)) throw new Error("PROJECT_SOURCE_PROOF_ID_INVALID");
  return value;
}

/** Validates the already assigned shell variable SRC before any ZIP extraction. */
export function buildProjectArchiveValidationCommand(): string {
  return [
    'command -v unzip >/dev/null 2>&1 && command -v zipinfo >/dev/null 2>&1 || { echo PROJECT_ARCHIVE_VALIDATOR_MISSING; exit 47; }',
    'unzip -tqq "$SRC" >/dev/null 2>&1 || { echo PROJECT_ARCHIVE_INVALID; exit 48; }',
    String.raw`unzip -Z1 "$SRC" | awk 'BEGIN{bad=0;n=0} {name=$0; n++; sub(/\/$/,"",name); if (name=="" || name ~ /^\// || name ~ /^[A-Za-z]:/ || name ~ /\\/ || name ~ /(^|\/)\.\.(\/|$)/ || name ~ /(^|\/)\.(\/|$)/ || name ~ /[\r\t]/) {bad=1; print "PROJECT_ARCHIVE_UNSAFE_MEMBER=" $0 > "/dev/stderr"} if (seen[name]++) {bad=1; print "PROJECT_ARCHIVE_DUPLICATE_MEMBER=" $0 > "/dev/stderr"}} END{if(n==0 || n>100000) {bad=1; print "PROJECT_ARCHIVE_ENTRY_COUNT_INVALID" > "/dev/stderr"} exit bad}' || { echo PROJECT_ARCHIVE_PATH_VALIDATION_FAILED; exit 49; }`,
    String.raw`zipinfo -l "$SRC" 2>/dev/null | awk 'NR>3 && substr($1,1,1) ~ /^[lbpcs]$/ {print "PROJECT_ARCHIVE_LINK_OR_SPECIAL_FILE_DENIED" > "/dev/stderr"; bad=1} END{exit bad}' || { echo PROJECT_ARCHIVE_LINK_OR_SPECIAL_FILE_DENIED; exit 50; }`,
    String.raw`zipinfo -l "$SRC" 2>/dev/null | awk 'BEGIN{n=0;total=0;bad=0} NR>3 && substr($1,1,1)=="-" {n++; size=$4+0; total+=size; if(size>2147483648) bad=1} END{if(n>100000 || total>8589934592) bad=1; if(bad) print "PROJECT_ARCHIVE_SIZE_LIMIT_EXCEEDED" > "/dev/stderr"; exit bad}' || { echo PROJECT_ARCHIVE_SIZE_LIMIT_EXCEEDED; exit 51; }`,
  ].join("\n");
}

/**
 * Builds the production, read-only source probe/import command. ZIPs and folders
 * are never modified; imports are copied into a new, collision-resistant
 * directory below AIBuilderTermux/projects. Temporary extraction stays in the
 * app-managed internal work area and is not used as the model-visible project.
 * When proofId is supplied, the complete source/root/kind record is committed
 * atomically to a run-scoped directory beneath the canonical shared root.
 */
export function buildProjectSourcePreflightCommand(
  sourcePath: string,
  options: { sharedRoot?: string; proofId?: string } = {},
): string {
  const source = shellQuote(sourcePath);
  const sharedRoot = shellQuote(options.sharedRoot || DEFAULT_SHARED_ROOT);
  const proofId = validateProofId(options.proofId);
  return [
    "set -eu",
    `AIB_ROOT=${sharedRoot}`,
    'AIB_INTERNAL="${AIB_INTERNAL_ROOT:-$AIB_ROOT/.aibuilder}"',
    'AIB_WORK="$AIB_INTERNAL/work"',
    `PROOF_ID=${shellQuote(proofId)}`,
    'PROOF_STAGE=""',
    'mkdir -p "$AIB_ROOT" "$AIB_ROOT/projects" "$AIB_INTERNAL/tmp" "$AIB_WORK"',
    'ROOT_CANON=$(CDPATH= cd -- "$AIB_ROOT" 2>/dev/null && pwd -P) || { echo PROJECT_SOURCE_ACCESS_DENIED; exit 40; }',
    'PROJECTS="$ROOT_CANON/projects"',
    'PROJECTS_CANON=$(CDPATH= cd -- "$PROJECTS" 2>/dev/null && pwd -P) || { echo PROJECT_WORKSPACE_UNAVAILABLE; exit 41; }',
    '[ "$PROJECTS_CANON" = "$PROJECTS" ] || { echo PROJECT_WORKSPACE_SYMLINK_DENIED; exit 42; }',
    'write_project_source_proof() {',
    '  [ -n "$PROOF_ID" ] || return 0',
    '  local proof_parent proof_parent_canon proof_dir',
    '  proof_parent="$ROOT_CANON/.aibuilder/project-source-proofs"',
    '  mkdir -p "$proof_parent" || { echo PROJECT_SOURCE_PROOF_WRITE_FAILED; return 1; }',
    '  proof_parent_canon=$(CDPATH= cd -- "$proof_parent" 2>/dev/null && pwd -P) || { echo PROJECT_SOURCE_PROOF_WRITE_FAILED; return 1; }',
    '  [ "$proof_parent_canon" = "$ROOT_CANON/.aibuilder/project-source-proofs" ] || { echo PROJECT_SOURCE_PROOF_CONTAINMENT_FAILED; return 1; }',
    '  proof_dir="$proof_parent_canon/$PROOF_ID"',
    '  [ ! -e "$proof_dir" ] && [ ! -L "$proof_dir" ] || { echo PROJECT_SOURCE_PROOF_COLLISION; return 1; }',
    '  PROOF_STAGE=$(mktemp -d "$proof_parent_canon/.proof-${PROOF_ID}.XXXXXXXX") || { echo PROJECT_SOURCE_PROOF_WRITE_FAILED; return 1; }',
    '  printf "%s\\n" "$1" > "$PROOF_STAGE/project_root"',
    '  printf "%s\\n" "$2" > "$PROOF_STAGE/project_kind"',
    '  printf "%s\\n" "$3" > "$PROOF_STAGE/project_source"',
    '  mv -T -- "$PROOF_STAGE" "$proof_dir" || { echo PROJECT_SOURCE_PROOF_COMMIT_FAILED; return 1; }',
    '  PROOF_STAGE=""',
    '}',
    'emit_project_source_proof() {',
    '  if [ -n "$PROOF_ID" ]; then printf "PROJECT_SOURCE_PROOF_V1=%s.%s.%s.%s\\n" "$PROOF_ID" "$(printf "%s" "$1" | base64 | tr -d "\\r\\n")" "$(printf "%s" "$2" | base64 | tr -d "\\r\\n")" "$(printf "%s" "$PROJECTS_CANON" | base64 | tr -d "\\r\\n")"; fi',
    '  echo "PROJECT_SOURCE_READ_OK=1"',
    '  [ -z "$PROOF_ID" ] || echo "PROJECT_SOURCE_PROOF_ID=$PROOF_ID"',
    '  echo "PROJECT_KIND_PROVEN=$1"',
    '  echo "PROJECT_ROOT=$2"',
    '  echo "PROJECTS_ROOT=$PROJECTS_CANON"',
    '}',
    `SRC=${source}`,
    'SRC_NL=$(printf "\\nX"); SRC_NL=${SRC_NL%X}; SRC_CR=$(printf "\\r"); case "$SRC" in *"$SRC_NL"*|*"$SRC_CR"*) echo PROJECT_SOURCE_PATH_INVALID; exit 43;; esac',
    'if [ ! -e "$SRC" ]; then echo "PROJECT_SOURCE_NOT_FOUND=$SRC"; exit 44; fi',
    '[ ! -L "$SRC" ] || { echo PROJECT_SOURCE_SYMLINK_DENIED; exit 44; }',
    'IMPORT_STAGING=""',
    'STAGE=$(mktemp -d "$AIB_INTERNAL/tmp/project-source.XXXXXXXX") || { echo PROJECT_PREPARATION_TEMP_FAILED; exit 45; }',
    'cleanup_project_source_preflight() { if [ -n "$IMPORT_STAGING" ]; then rm -rf -- "$IMPORT_STAGING" 2>/dev/null || true; fi; if [ -n "${STAGE:-}" ]; then rm -rf -- "$STAGE" 2>/dev/null || true; fi; if [ -n "${PROOF_STAGE:-}" ]; then rm -rf -- "$PROOF_STAGE" 2>/dev/null || true; fi; }',
    "trap 'cleanup_project_source_preflight' EXIT",
    "trap 'exit 129' HUP",
    "trap 'exit 130' INT",
    "trap 'exit 143' TERM",
    'TREE="$STAGE/tree"; mkdir -p "$TREE"',
    'if [ -f "$SRC" ]; then',
    '  case "$SRC" in *.zip|*.ZIP) ;; *) echo PROJECT_SOURCE_NOT_A_PROJECT_OR_ZIP; exit 46;; esac',
    `  ${buildProjectArchiveValidationCommand()}`,
    '  unzip -oq "$SRC" -d "$TREE" || { echo PROJECT_ARCHIVE_EXTRACT_FAILED; exit 52; }',
    'else',
    '  [ -d "$SRC" ] || { echo PROJECT_SOURCE_NOT_DIRECTORY; exit 53; }',
    '  SRC_CANON=$(CDPATH= cd -- "$SRC" 2>/dev/null && pwd -P) || { echo PROJECT_SOURCE_ACCESS_DENIED; exit 54; }',
    // Refuse workspace root / projects root and any source that contains TREE (self-copy).
    '  case "$SRC_CANON" in "$ROOT_CANON"|"$PROJECTS_CANON") echo "PROJECT_SOURCE_IS_WORKSPACE_ROOT=$SRC_CANON"; exit 53;; esac',
    '  case "$TREE" in "$SRC_CANON"|"$SRC_CANON"/*) echo "PROJECT_SOURCE_NESTED_DEST_DENIED src=$SRC_CANON dest=$TREE"; exit 57;; esac',
    '  if find "$SRC_CANON" -type l -print -quit | grep -q .; then echo PROJECT_SOURCE_SYMLINK_DENIED; exit 55; fi',
    '  if find "$SRC_CANON" ! -type d ! -type f -print -quit | grep -q .; then echo PROJECT_SOURCE_SPECIAL_FILE_DENIED; exit 56; fi',
    '  cp -a "$SRC_CANON"/. "$TREE"/ || { echo PROJECT_SOURCE_COPY_FAILED; exit 57; }',
    'fi',
    'if find "$TREE" -type l -print -quit | grep -q .; then echo PROJECT_ARCHIVE_SYMLINK_DENIED; exit 58; fi',
    'if find "$TREE" ! -type d ! -type f -print -quit | grep -q .; then echo PROJECT_ARCHIVE_SPECIAL_FILE_DENIED; exit 59; fi',
    'find_project_root() {',
    String.raw`  if [ -f "$1/package.json" ]; then if grep -qE '"expo"[[:space:]]*:' "$1/package.json" || [ -f "$1/app.json" ] || [ -f "$1/app.config.js" ] || [ -f "$1/app.config.ts" ]; then printf "expo\t%s\n" "$1"; return 0; fi; if grep -qE '"react-native"[[:space:]]*:' "$1/package.json" && { [ -d "$1/android" ] || [ -f "$1/android/gradlew" ]; }; then printf "react-native\t%s\n" "$1"; return 0; fi; fi`,
    '  local root="$1" mark dir pkg cfg expo_root; root=""; mark=""; dir=""; pkg=""; cfg=""; expo_root=""',
    String.raw`  expo_root=$(find "$1" -maxdepth 12 -type f \( -name app.json -o -name app.config.js -o -name app.config.ts \) -print0 2>/dev/null | while IFS= read -r -d '' cfg; do dir=$(dirname "$cfg"); if [ -f "$dir/package.json" ]; then printf "%s\n" "$dir"; break; fi; done)`,
    String.raw`  if [ -n "$expo_root" ]; then printf "expo\t%s\n" "$expo_root"; return 0; fi`,
    '  pkg=$(find "$1" -maxdepth 12 -type f -name package.json -print 2>/dev/null | head -1 || true)',
    String.raw`  if [ -n "$pkg" ]; then dir=$(dirname "$pkg"); if grep -qE '"expo"[[:space:]]*:' "$pkg" 2>/dev/null || [ -f "$dir/app.json" ] || [ -f "$dir/app.config.js" ] || [ -f "$dir/app.config.ts" ]; then printf "expo\t%s\n" "$dir"; return 0; fi; if grep -qE '"react-native"[[:space:]]*:' "$pkg" 2>/dev/null && { [ -d "$dir/android" ] || [ -f "$dir/android/gradlew" ]; }; then printf "react-native\t%s\n" "$dir"; return 0; fi; fi`,
    '  mark=$(find "$1" -maxdepth 12 -type f \\( -name gradlew -o -name settings.gradle -o -name settings.gradle.kts \\) -print 2>/dev/null | head -1 || true)',
    String.raw`  if [ -n "$mark" ]; then dir=$(dirname "$mark"); parent=$(dirname "$dir"); pkg="$parent/package.json"; if [ -f "$pkg" ] && { grep -qE '"expo"[[:space:]]*:' "$pkg" 2>/dev/null || [ -f "$parent/app.json" ] || [ -f "$parent/app.config.js" ] || [ -f "$parent/app.config.ts" ]; }; then printf "expo\t%s\n" "$parent"; return 0; fi; if [ -f "$pkg" ] && grep -qE '"react-native"[[:space:]]*:' "$pkg"; then printf "react-native\t%s\n" "$parent"; return 0; fi; if [ -f "$dir/app/build.gradle" ] || [ -f "$dir/app/build.gradle.kts" ] || [ -f "$dir/app/src/main/AndroidManifest.xml" ] || [ -f "$dir/AndroidManifest.xml" ] || grep -R -qE "com\.android\.(application|library)" "$dir" --include="*.gradle" --include="*.gradle.kts" 2>/dev/null; then printf "gradle\t%s\n" "$dir"; return 0; fi; fi`,
    '  pkg=$(find "$1" -maxdepth 12 -type f -name package.json -print 2>/dev/null | head -1 || true)',
    String.raw`  if [ -n "$pkg" ]; then dir=$(dirname "$pkg"); if grep -qE '"expo"[[:space:]]*:' "$pkg" 2>/dev/null || [ -f "$dir/app.json" ] || [ -f "$dir/app.config.js" ] || [ -f "$dir/app.config.ts" ]; then printf "expo\t%s\n" "$dir"; return 0; fi; if grep -qE '"react-native"[[:space:]]*:' "$pkg" 2>/dev/null && { [ -d "$dir/android" ] || [ -f "$dir/android/gradlew" ]; }; then printf "react-native\t%s\n" "$dir"; return 0; fi; if find "$dir" -maxdepth 2 -type f \( -name capacitor.config.ts -o -name capacitor.config.js -o -name capacitor.config.json \) -print -quit | grep -q .; then printf "capacitor\t%s\n" "$dir"; return 0; fi; fi`,
    '  mark=$(find "$1" -maxdepth 12 -type f -name pubspec.yaml -print 2>/dev/null | head -1 || true); if [ -n "$mark" ] && grep -qE "^[[:space:]]*flutter:" "$mark"; then printf "flutter\\t%s\\n" "$(dirname "$mark")"; return 0; fi',
    '  cfg=$(find "$1" -maxdepth 12 -type f -name config.xml -print 2>/dev/null | head -1 || true); if [ -n "$cfg" ] && grep -qE "<widget([[:space:]>])" "$cfg"; then printf "cordova\\t%s\\n" "$(dirname "$cfg")"; return 0; fi',
    '  mark=$(find "$1" -maxdepth 12 -type f -name Android.mk -print 2>/dev/null | head -1 || true); if [ -n "$mark" ]; then printf "native\\t%s\\n" "$(dirname "$mark")"; return 0; fi',
    '  mark=$(find "$1" -maxdepth 12 -type f -name pom.xml -print 2>/dev/null | head -1 || true); if [ -n "$mark" ] && grep -qE "com\\.android\\.tools\\.build|android" "$mark"; then printf "maven-android\\t%s\\n" "$(dirname "$mark")"; return 0; fi',
    '  return 1',
    '}',
    'INFO=$(find_project_root "$TREE" || true)',
    'if [ -z "$INFO" ]; then echo "PROJECT_SOURCE_INVALID kind=unrecognized"; exit 60; fi',
    'TAB=$(printf "\\t"); KIND=${INFO%%"$TAB"*}; PROJECT_REL=${INFO#*"$TAB"}',
    '[ -d "$PROJECT_REL" ] || { echo PROJECT_SOURCE_INVALID kind=root-missing; exit 61; }',
    'case "$PROJECT_REL" in "$TREE") REL="";; "$TREE"/*) REL=${PROJECT_REL#"$TREE"/};; *) echo PROJECT_SOURCE_ROOT_ESCAPE; exit 62;; esac',
    'case "$SRC" in *.zip|*.ZIP) COPY_REQUIRED=1;; *)',
    '  SRC_CANON=$(CDPATH= cd -- "$SRC" 2>/dev/null && pwd -P)',
    '  case "$SRC_CANON" in "$PROJECTS_CANON"/*) printf "%s\\n" "$SRC_CANON" > "$AIB_WORK/project_root.tmp.$$"; mv -f -- "$AIB_WORK/project_root.tmp.$$" "$AIB_WORK/project_root"; printf "%s\\n" "$KIND" > "$AIB_WORK/project_kind.tmp.$$"; mv -f -- "$AIB_WORK/project_kind.tmp.$$" "$AIB_WORK/project_kind"; printf "%s\\n" "$SRC" > "$AIB_WORK/project_source.tmp.$$"; mv -f -- "$AIB_WORK/project_source.tmp.$$" "$AIB_WORK/project_source"; write_project_source_proof "$SRC_CANON" "$KIND" "$SRC"; emit_project_source_proof "$KIND" "$SRC_CANON"; echo "PROJECT_IMPORT=existing"; exit 0;; esac',
    '  COPY_REQUIRED=1;;',
    'esac',
    'SAFE=$(basename "$SRC" 2>/dev/null || echo ImportedProject); SAFE=${SAFE%.*}; SAFE=$(printf "%s" "$SAFE" | tr -cd "A-Za-z0-9_-" | cut -c1-48); [ -n "$SAFE" ] || SAFE=ImportedProject',
    'STAMP=$(date +%s)',
    'DEST=""; IMPORT_STAGING=""; i=0; while [ "$i" -lt 100 ]; do i=$((i+1)); CAND="$PROJECTS_CANON/$SAFE-$STAMP-$$-$i"; CAND_STAGE="$PROJECTS_CANON/.aib-import-${SAFE}-${STAMP}-$$-${i}.pending"; if [ ! -e "$CAND" ] && [ ! -L "$CAND" ] && [ ! -e "$CAND_STAGE" ] && [ ! -L "$CAND_STAGE" ] && mkdir -- "$CAND_STAGE" 2>/dev/null; then DEST="$CAND"; IMPORT_STAGING="$CAND_STAGE"; break; fi; done',
    '[ -n "$DEST" ] || { echo PROJECT_IMPORT_COLLISION_LIMIT; exit 63; }',
    'if ! cp -a "$TREE"/. "$IMPORT_STAGING"/; then echo PROJECT_IMPORT_COPY_FAILED; exit 64; fi',
    'if [ -n "$REL" ]; then PROJECT_ROOT="$IMPORT_STAGING/$REL"; else PROJECT_ROOT="$IMPORT_STAGING"; fi',
    'PROJECT_ROOT=$(CDPATH= cd -- "$PROJECT_ROOT" 2>/dev/null && pwd -P) || { echo PROJECT_IMPORT_ROOT_INVALID; exit 65; }',
    'case "$PROJECT_ROOT" in "$IMPORT_STAGING"|"$IMPORT_STAGING"/*) ;; *) echo PROJECT_IMPORT_OUTSIDE_STAGING; exit 66;; esac',
    '[ ! -e "$DEST" ] && [ ! -L "$DEST" ] || { echo PROJECT_IMPORT_DEST_COLLISION; exit 67; }',
    'mv -T -- "$IMPORT_STAGING" "$DEST" || { echo PROJECT_IMPORT_COMMIT_FAILED; exit 68; }',
    'IMPORT_STAGING=""',
    'if [ -n "$REL" ]; then PROJECT_ROOT="$DEST/$REL"; else PROJECT_ROOT="$DEST"; fi',
    'PROJECT_ROOT=$(CDPATH= cd -- "$PROJECT_ROOT" 2>/dev/null && pwd -P) || { echo PROJECT_IMPORT_ROOT_INVALID; exit 69; }',
    'case "$PROJECT_ROOT" in "$PROJECTS_CANON"/*) ;; *) echo PROJECT_IMPORT_OUTSIDE_PROJECTS; exit 70;; esac',
    'printf "%s\\n" "$PROJECT_ROOT" > "$AIB_WORK/project_root.tmp.$$"; mv -f -- "$AIB_WORK/project_root.tmp.$$" "$AIB_WORK/project_root"',
    'printf "%s\\n" "$KIND" > "$AIB_WORK/project_kind.tmp.$$"; mv -f -- "$AIB_WORK/project_kind.tmp.$$" "$AIB_WORK/project_kind"',
    // Keep the legacy work markers for existing project-management callers, but recover this run only from the atomic record.
    'printf "%s\\n" "$SRC" > "$AIB_WORK/project_source.tmp.$$"; mv -f -- "$AIB_WORK/project_source.tmp.$$" "$AIB_WORK/project_source"',
    'write_project_source_proof "$PROJECT_ROOT" "$KIND" "$SRC"',
    'emit_project_source_proof "$KIND" "$PROJECT_ROOT"',
    'echo "PROJECT_IMPORT=created"',
    'echo "PROJECT_SOURCE_PRESERVED=1"',
  ].join("\n");
}

/**
 * Read the complete proof record for one source-preflight run. With proofId,
 * recovery is isolated to that run's atomic record; without it, legacy marker
 * locations are checked for compatibility. All accepted records remain bound
 * to the exact source path and canonical project containment.
 */
export function buildProjectSourceMarkerRecoveryCommand(
  sourcePath: string,
  options: { sharedRoot?: string; proofId?: string } = {},
): string {
  const expectedSource = shellQuote(sourcePath);
  const sharedRoot = shellQuote(options.sharedRoot || DEFAULT_SHARED_ROOT);
  const proofId = validateProofId(options.proofId);
  return [
    "set -eu",
    `AIB_ROOT=${sharedRoot}`,
    `EXPECTED_SOURCE=${expectedSource}`,
    `PROOF_ID=${shellQuote(proofId)}`,
    'ROOT_CANON=$(CDPATH= cd -- "$AIB_ROOT" 2>/dev/null && pwd -P) || { echo PROJECT_SOURCE_WORKSPACE_MISSING; exit 72; }',
    'PROJECTS_CANON=$(CDPATH= cd -- "$ROOT_CANON/projects" 2>/dev/null && pwd -P) || { echo PROJECT_SOURCE_WORKSPACE_MISSING; exit 72; }',
    '[ "$PROJECTS_CANON" = "$ROOT_CANON/projects" ] || { echo PROJECT_SOURCE_WORKSPACE_SYMLINK_DENIED; exit 72; }',
    'emit_project_source_proof() {',
    '  if [ -n "$PROOF_ID" ]; then printf "PROJECT_SOURCE_PROOF_V1=%s.%s.%s.%s\\n" "$PROOF_ID" "$(printf "%s" "$1" | base64 | tr -d "\\r\\n")" "$(printf "%s" "$2" | base64 | tr -d "\\r\\n")" "$(printf "%s" "$PROJECTS_CANON" | base64 | tr -d "\\r\\n")"; fi',
    '}',
    'if [ -n "$PROOF_ID" ]; then',
    '  PROOF_PARENT="$ROOT_CANON/.aibuilder/project-source-proofs"',
    '  [ -d "$PROOF_PARENT" ] || { echo PROJECT_SOURCE_MARKERS_MISSING; exit 73; }',
    '  PROOF_PARENT_CANON=$(CDPATH= cd -- "$PROOF_PARENT" 2>/dev/null && pwd -P) || { echo PROJECT_SOURCE_MARKERS_MISSING; exit 73; }',
    '  [ "$PROOF_PARENT_CANON" = "$ROOT_CANON/.aibuilder/project-source-proofs" ] || { echo PROJECT_SOURCE_PROOF_CONTAINMENT_FAILED; exit 73; }',
    '  set -- "$PROOF_PARENT_CANON/$PROOF_ID"',
    'else',
    '  PRIVATE_WORK="${AIB_PRIVATE_ROOT:-$HOME/.aibuilder}/work"',
    '  INTERNAL_WORK="${AIB_INTERNAL_ROOT:-$AIB_ROOT/.aibuilder}/work"',
    '  set -- "$INTERNAL_WORK" "$AIB_ROOT/.aibuilder/work" "$PRIVATE_WORK" "$HOME/.aibuilder/work"',
    'fi',
    'for AIB_WORK do',
    '  [ -d "$AIB_WORK" ] || continue',
    '  [ -f "$AIB_WORK/project_root" ] && [ -f "$AIB_WORK/project_kind" ] && [ -f "$AIB_WORK/project_source" ] || continue',
    '  [ "$(wc -l < "$AIB_WORK/project_root" 2>/dev/null || echo 0)" -eq 1 ] || continue',
    '  [ "$(wc -l < "$AIB_WORK/project_kind" 2>/dev/null || echo 0)" -eq 1 ] || continue',
    '  [ "$(wc -l < "$AIB_WORK/project_source" 2>/dev/null || echo 0)" -eq 1 ] || continue',
    '  IFS= read -r R < "$AIB_WORK/project_root" || continue',
    '  IFS= read -r K < "$AIB_WORK/project_kind" || continue',
    '  IFS= read -r S < "$AIB_WORK/project_source" || continue',
    '  [ "$S" = "$EXPECTED_SOURCE" ] || continue',
    '  [ -d "$R" ] && [ ! -L "$R" ] || continue',
    '  R_CANON=$(CDPATH= cd -- "$R" 2>/dev/null && pwd -P) || continue',
    '  case "$R_CANON" in "$PROJECTS_CANON"/*) ;; *) continue;; esac',
    '  case "$K" in expo|react-native|gradle|flutter|capacitor|cordova|native|maven-android) ;; *) continue;; esac',
    '  emit_project_source_proof "$K" "$R_CANON"',
    '  echo PROJECT_SOURCE_READ_OK=1',
    '  [ -z "$PROOF_ID" ] || echo "PROJECT_SOURCE_PROOF_ID=$PROOF_ID"',
    '  echo PROJECT_SOURCE_MARKERS_OK=1',
    '  echo "PROJECT_KIND_PROVEN=$K"',
    '  echo "PROJECT_ROOT=$R_CANON"',
    '  echo "PROJECTS_ROOT=$PROJECTS_CANON"',
    '  exit 0',
    'done',
    'echo PROJECT_SOURCE_MARKERS_MISSING',
    'exit 73',
  ].join("\n");
}

export interface ProjectSourceProof {
  proofId: string;
  projectRoot: string;
  projectKind: string;
  projectsRoot: string;
}

/**
 * Parse an entire source proof from one callback only. A success marker, root,
 * or kind from a partial/different callback is never combined with other data.
 */
export function parseProjectSourceProofOutput(
  output: string,
  expectedProofId: string,
  expectedProjectsRoot: string = `${DEFAULT_SHARED_ROOT}/projects`,
): ProjectSourceProof | null {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(expectedProofId)) return null;
  const text = String(output || "").replace(/\r/g, "");
  const lines = [...text.matchAll(/^PROJECT_SOURCE_PROOF_V1=([A-Za-z0-9_-]{1,64})\.([A-Za-z0-9+/]+={0,2})\.([A-Za-z0-9+/]+={0,2})\.([A-Za-z0-9+/]+={0,2})$/gm)];
  const firstLine = text.split("\n", 1)[0];
  if (lines.length !== 1 || lines[0][0] !== firstLine || lines[0][1] !== expectedProofId) return null;
  const decode = (encoded: string): string | null => {
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) return null;
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const bytes: number[] = [];
    for (let i = 0; i < encoded.length; i += 4) {
      const a = alphabet.indexOf(encoded[i]);
      const b = alphabet.indexOf(encoded[i + 1]);
      const c = encoded[i + 2] === "=" ? 0 : alphabet.indexOf(encoded[i + 2]);
      const d = encoded[i + 3] === "=" ? 0 : alphabet.indexOf(encoded[i + 3]);
      if (a < 0 || b < 0 || c < 0 || d < 0) return null;
      bytes.push((a << 2) | (b >> 4));
      if (encoded[i + 2] !== "=") bytes.push(((b & 15) << 4) | (c >> 2));
      if (encoded[i + 3] !== "=") bytes.push(((c & 3) << 6) | d);
    }
    try {
      return decodeURIComponent(bytes.map((byte) => `%${byte.toString(16).padStart(2, "0")}`).join(""));
    } catch {
      return null;
    }
  };
  const proofId = lines[0][1];
  const projectKind = decode(lines[0][2])?.toLowerCase() || "";
  const projectRoot = decode(lines[0][3]) || "";
  const projectsRoot = decode(lines[0][4]) || "";
  // Bind the callback to the caller's exact workspace, not any shorter ancestor.
  // Alternate expected roots are used only by isolated host fixtures; app callers
  // use the canonical default above and never accept a root from callback text.
  if (projectsRoot !== expectedProjectsRoot) return null;
  if (!projectKind || !projectRoot || !projectsRoot) return null;
  if (!/^(expo|react-native|gradle|flutter|capacitor|cordova|native|maven-android)$/.test(projectKind)) return null;
  if (!projectRoot.startsWith("/") || !projectsRoot.startsWith("/") || projectRoot.endsWith("/") || projectsRoot.endsWith("/")) return null;
  if (projectRoot === projectsRoot || !projectRoot.startsWith(`${projectsRoot}/`)) return null;
  if (projectRoot.split("/").some((part) => part === "." || part === "..") || projectsRoot.split("/").some((part) => part === "." || part === "..")) return null;
  if (projectRoot.includes("\\") || projectsRoot.includes("\\") || /[\0\r\n]/.test(projectRoot + projectsRoot)) return null;
  return { proofId, projectRoot, projectKind, projectsRoot };
}

/** Pure marker classifier for hermetic tests and diagnostics. */
export function classifyProjectSourceMarkers(paths: readonly string[]): string | null {
  const normalized = paths.map((p) => p.replace(/\\/g, "/").replace(/^\.\//, ""));
  const has = (suffix: string) => normalized.some((p) => p === suffix || p.endsWith(`/${suffix}`));
  const packageRoots = new Set(normalized
    .filter((p) => p === "package.json" || p.endsWith("/package.json"))
    .map((p) => p === "package.json" ? "" : p.slice(0, p.lastIndexOf("/"))));
  const hasPairedExpoConfig = normalized.some((p) => {
    const name = p.slice(p.lastIndexOf("/") + 1);
    const directory = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
    return (name === "app.json" || name === "app.config.js" || name === "app.config.ts") && packageRoots.has(directory);
  });
  // Expo markers must belong to the same package root; nested native-module
  // manifests must not override an explicit Expo app configuration.
  if (hasPairedExpoConfig) return "expo";
  if (has("gradlew") || has("settings.gradle") || has("settings.gradle.kts")) {
    if (has("app/build.gradle") || has("app/build.gradle.kts") || has("app/src/main/AndroidManifest.xml") || has("AndroidManifest.xml")) return "gradle";
  }
  if (has("package.json") && has("android/gradlew")) return "react-native";
  if (has("pubspec.yaml")) return "flutter";
  if (has("capacitor.config.ts") || has("capacitor.config.js") || has("capacitor.config.json")) return "capacitor";
  if (has("config.xml")) return "cordova";
  if (has("Android.mk")) return "native";
  return null;
}
