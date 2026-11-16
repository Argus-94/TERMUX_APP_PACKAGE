/** Shell-safe command builders for profile transfer paths. */
import { SECRET_ARCHIVE_SHELL_CASE_GLOBS, SECRET_ARCHIVE_TAR_EXCLUDES, SECRET_CONTENT_EGREP_PATTERN } from "./secret-archive-policy.ts";
import { AI_BUILDER_SHARED_ROOT } from "./writable-path-policy.ts";

/** Quote one POSIX shell argument without evaluating substitutions or backticks. */
export function shellQuote(value: string): string {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

export function buildProfileExportCommand(destPath: string, homeRoot: string, trustedRoot = AI_BUILDER_SHARED_ROOT): string {
  const dest = shellQuote(destPath);
  const home = shellQuote(homeRoot);
  const destRoot = shellQuote(trustedRoot);
  const excludes = SECRET_ARCHIVE_TAR_EXCLUDES.map((pattern) => `--exclude=${shellQuote(pattern)}`).join(" ");
  const scanPattern = shellQuote(SECRET_CONTENT_EGREP_PATTERN);
  return [
    `set -e; DEST=${dest}; DEST_ROOT=${destRoot}; DEST_PARENT=$(dirname "$DEST");`,
    `[ ! -L "$DEST_ROOT" ] || { echo PROFILE_EXPORT_SYMLINK_ESCAPE >&2; exit 39; };`,
    `ROOT_PARENT_REAL=$(realpath -e "$(dirname "$DEST_ROOT")") || { echo PROFILE_EXPORT_PATH_RESOLUTION_FAILED >&2; exit 39; }; ROOT_BASE_REAL="$ROOT_PARENT_REAL/$(basename "$DEST_ROOT")";`,
    `PARENT_PRE_REAL=$(realpath -m "$DEST_PARENT") || { echo PROFILE_EXPORT_PATH_RESOLUTION_FAILED >&2; exit 39; }; case "$PARENT_PRE_REAL/" in "$ROOT_BASE_REAL/"*) ;; *) echo PROFILE_EXPORT_SYMLINK_ESCAPE >&2; exit 39;; esac;`,
    `mkdir -p "$DEST_PARENT"; PARENT_REAL=$(realpath -e "$DEST_PARENT") || { echo PROFILE_EXPORT_PATH_RESOLUTION_FAILED >&2; exit 39; }; case "$PARENT_REAL/" in "$ROOT_BASE_REAL/"*) ;; *) echo PROFILE_EXPORT_SYMLINK_ESCAPE >&2; exit 39;; esac;`,
    `ARCHIVE_TMP="\${DEST}.aibuilder.tmp.$$"; trap 'rm -f "$ARCHIVE_TMP"' EXIT;`,
    `cd ${home};`,
    `set --; for entry in metadata projects .aibuilder; do [ ! -e "$entry" ] || set -- "$@" "$entry"; done;`,
    `[ "$#" -gt 0 ] || { echo PROFILE_EXPORT_FAIL:no_profile_data; exit 1; };`,
    `if tar -czf "$ARCHIVE_TMP" ${excludes} "$@" 2>/dev/null && [ -s "$ARCHIVE_TMP" ]; then`,
    `  if ! tar -xzf "$ARCHIVE_TMP" -O >/dev/null; then echo PROFILE_EXPORT_CONTENT_READ_FAILED >&2; exit 38; fi;`,
    `  if tar -xzf "$ARCHIVE_TMP" -O | grep -a -i -E ${scanPattern} >/dev/null; then echo PROFILE_EXPORT_SECRET_CONTENT_FORBIDDEN >&2; exit 37; else scan_status=$?; [ "$scan_status" -eq 1 ] || { echo PROFILE_EXPORT_CONTENT_SCAN_FAILED >&2; exit 38; }; fi;`,
    `  PARENT_REAL=$(realpath -e "$DEST_PARENT") || { echo PROFILE_EXPORT_PATH_RESOLUTION_FAILED >&2; exit 39; }; case "$PARENT_REAL/" in "$ROOT_BASE_REAL/"*) ;; *) echo PROFILE_EXPORT_SYMLINK_ESCAPE >&2; exit 39;; esac; mv -f "$ARCHIVE_TMP" "$DEST";`,
    `else ec=$?; echo PROFILE_EXPORT_FAIL; exit "$ec"; fi;`,
    `test -s "$DEST" && ls -la "$DEST" && echo PROFILE_EXPORT_OK || { echo PROFILE_EXPORT_FAIL; exit 1; }`,
  ].join(" ");
}

export function buildProfileImportCommand(sourcePath: string, homeRoot: string): string {
  const source = shellQuote(sourcePath);
  const home = shellQuote(homeRoot);
  const scanPattern = shellQuote(SECRET_CONTENT_EGREP_PATTERN);
  return [
    `set -eu; SRC=${source}; HOME_DIR=${home}; mkdir -p "$HOME_DIR"; test -f "$SRC";`,
    `STAGE=$(mktemp -d "$HOME_DIR/.aib-profile-stage.XXXXXX"); BACKUP=$(mktemp -d "$HOME_DIR/.aib-profile-backup.XXXXXX");`,
    `AFFECTED=""; BACKUP_READY=0; COMMIT_STARTED=0;`,
    `cleanup_profile_import() { status=$?; if [ "$status" -ne 0 ] && [ "$COMMIT_STARTED" -eq 1 ] && [ "$BACKUP_READY" -eq 1 ]; then set +e; for entry in $AFFECTED; do rm -rf "$HOME_DIR/$entry"; if [ -e "$BACKUP/$entry" ] || [ -L "$BACKUP/$entry" ]; then cp -a "$BACKUP/$entry" "$HOME_DIR/$entry"; fi; done; fi; rm -rf "$STAGE" "$BACKUP"; return "$status"; }; trap cleanup_profile_import EXIT;`,
    `tar -tvzf "$SRC" > "$STAGE/.types"; [ -s "$STAGE/.types" ] || { echo PROFILE_IMPORT_EMPTY >&2; exit 31; };`,
    `while IFS= read -r type_line || [ -n "$type_line" ]; do case "$type_line" in -*) ;; d*) ;; *) echo PROFILE_IMPORT_LINK_FORBIDDEN >&2; exit 35;; esac; done < "$STAGE/.types";`,
    `tar -tzf "$SRC" > "$STAGE/.members"; [ -s "$STAGE/.members" ] || { echo PROFILE_IMPORT_EMPTY >&2; exit 31; };`,
    `while IFS= read -r raw || [ -n "$raw" ]; do name="\${raw#./}"; name="\${name%/}"; case "$name" in ""|/*|*\\\\*|..|../*|*/../*|*/..|*/./*|./*|*//*) echo PROFILE_IMPORT_UNSAFE_PATH >&2; exit 32;; esac; case "$name" in ${SECRET_ARCHIVE_SHELL_CASE_GLOBS}) echo PROFILE_IMPORT_SECRET_FORBIDDEN >&2; exit 36;; esac; case "$name" in metadata|metadata/*|projects|projects/*|.aibuilder|.aibuilder/*) ;; *) echo PROFILE_IMPORT_UNEXPECTED_PATH >&2; exit 33;; esac; done < "$STAGE/.members";`,
    `if tar -xzf "$SRC" -O | grep -a -i -E ${scanPattern} >/dev/null; then echo PROFILE_IMPORT_SECRET_CONTENT_FORBIDDEN >&2; exit 37; else scan_status=$?; [ "$scan_status" -eq 1 ] || { echo PROFILE_IMPORT_CONTENT_SCAN_FAILED >&2; exit 38; }; fi;`,
    `tar -xzf "$SRC" -C "$STAGE" --no-same-owner --no-same-permissions;`,
    `if find "$STAGE" ! -type f ! -type d -print -quit | grep -q .; then echo PROFILE_IMPORT_LINK_OR_SPECIAL_FILE_FORBIDDEN >&2; exit 35; fi;`,
    `for entry in metadata projects .aibuilder; do if [ -e "$STAGE/$entry" ] || [ -L "$STAGE/$entry" ]; then AFFECTED="$AFFECTED $entry"; fi; done; [ -n "$AFFECTED" ] || { echo PROFILE_IMPORT_EMPTY >&2; exit 34; };`,
    `for entry in $AFFECTED; do if [ -e "$HOME_DIR/$entry" ] || [ -L "$HOME_DIR/$entry" ]; then cp -a "$HOME_DIR/$entry" "$BACKUP/$entry"; fi; done; BACKUP_READY=1; COMMIT_STARTED=1;`,
    `for entry in $AFFECTED; do rm -rf "$HOME_DIR/$entry"; if [ -e "$STAGE/$entry" ] || [ -L "$STAGE/$entry" ]; then mv "$STAGE/$entry" "$HOME_DIR/$entry"; fi; done;`,
    `COMMIT_STARTED=0; echo PROFILE_IMPORT_OK`,
  ].join(" ");
}
