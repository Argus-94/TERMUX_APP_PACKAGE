import { executeGuardedTermuxCommand } from "./termux-executor";

/** Display form expanded by the signing UI's Termux-host shell commands. */
export const SIGNING_ROOT = "~/.aibuilder/keys";
export const SIGNED_APK_ROOT = "/storage/emulated/0/AIBuilderTermux/outputs";
/** Read-only source for an explicit, user-confirmed migration; never a new write target. */
export const LEGACY_SIGNING_ROOT = "/storage/emulated/0/AIBuilderTermux/.aibuilder/keys";

function shellQuote(value: string): string {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function shellQuotePath(value: string, label: string): string {
  const p = assertPath(value, label);
  const home = /^(?:~|\$HOME|\$\{HOME\})(?:\/(.*))?$/.exec(p);
  if (!home) return shellQuote(p);
  return home[1] ? `"$HOME"/${shellQuote(home[1])}` : '"$HOME"';
}

function sanitizeFileName(value: string): string {
  const clean = value.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return clean || "aib-signing-key";
}

function normalizeKeystoreFileName(value: string): string {
  const clean = sanitizeFileName(value);
  const ext = /\.jks$/i.test(clean) ? ".jks" : ".keystore";
  const stem = clean.replace(/\.(?:keystore|jks)$/i, "");
  return `${stem || "aib-signing-key"}${ext}`;
}

function privateKeyRootSetup(): string {
  return 'AIB_PRIVATE_ROOT="${AIB_PRIVATE_ROOT:-$HOME/.aibuilder}"; SIGNING_ROOT="$AIB_PRIVATE_ROOT/keys"; [ ! -L "$AIB_PRIVATE_ROOT" ] && [ ! -L "$SIGNING_ROOT" ] && [ ! -L "$AIB_PRIVATE_ROOT/tmp" ] || { echo PRIVATE_SIGNING_ROOT_UNAVAILABLE >&2; exit 40; }; mkdir -p "$SIGNING_ROOT" "$AIB_PRIVATE_ROOT/tmp"; chmod 700 "$AIB_PRIVATE_ROOT" "$SIGNING_ROOT" "$AIB_PRIVATE_ROOT/tmp" 2>/dev/null || { echo PRIVATE_SIGNING_ROOT_UNAVAILABLE >&2; exit 40; }; ';
}

/** Reject empty/short passwords before they reach keytool/apksigner. */
export function assertPassword(value: string, label = "PASSWORD"): string {
  const v = String(value ?? "").trim();
  if (v.length < 6) {
    throw new Error(`${label}_TOO_SHORT`);
  }
  if (/[\n\r]/.test(v)) {
    throw new Error(`${label}_INVALID`);
  }
  return v;
}

function assertPath(value: string, label: string): string {
  const p = String(value ?? "").trim();
  if (!p) throw new Error(`${label}_REQUIRED`);
  if (/[\0\n\r]/.test(p)) throw new Error(`${label}_INVALID`);
  return p;
}

export { materializeUriForTermux } from "./materialize-uri";

export type SigningCommandResult = { stdout: string; stderr: string; exitCode: number; timedOut: boolean };
export type SigningKeyInfo = { name: string; path: string; size: number };

export async function createSigningKeystore(options: {
  fileName: string;
  alias: string;
  storePassword: string;
  keyPassword: string;
  validityDays: number;
  commonName: string;
}): Promise<SigningCommandResult> {
  const file = normalizeKeystoreFileName(options.fileName);
  const alias = options.alias.trim().replace(/[^A-Za-z0-9._-]/g, "-") || "release";
  const validity = Math.max(1, Math.min(36500, Math.floor(options.validityDays || 3650)));
  const cn = options.commonName.trim() || "AI Builder Signing Key";
  const storePassword = assertPassword(options.storePassword, "STORE_PASSWORD");
  const keyPassword = assertPassword(options.keyPassword, "KEY_PASSWORD");
  const command =
    `set -eu; ${privateKeyRootSetup()}` +
    `KEYSTORE_PATH="$SIGNING_ROOT"/${shellQuote(file)}; ` +
    `if [ -e "$KEYSTORE_PATH" ]; then echo "KEYSTORE_EXISTS:$KEYSTORE_PATH" >&2; exit 2; fi; ` +
    `command -v keytool >/dev/null 2>&1 || { echo "KEYTOOL_MISSING" >&2; exit 127; }; ` +
    `KEYSTORE_PASSWORD=${shellQuote(storePassword)}; KEY_PASSWORD=${shellQuote(keyPassword)}; ` +
    `STAGE=$(mktemp "$SIGNING_ROOT/.create-${file}.XXXXXXXX") || { echo KEYSTORE_STAGE_FAILED >&2; exit 41; }; ` +
    `trap 'rm -f -- "$STAGE"' EXIT HUP INT TERM; ` +
    `keytool -genkeypair -v -keystore "$STAGE" -storepass "$KEYSTORE_PASSWORD" -keypass "$KEY_PASSWORD" ` +
    `-alias ${shellQuote(alias)} -keyalg RSA -keysize 4096 -validity ${validity} ` +
    `-dname ${shellQuote(`CN=${cn}, O=AI Builder`)}; ` +
    `chmod 600 "$STAGE"; ` +
    `keytool -list -v -keystore "$STAGE" -storepass "$KEYSTORE_PASSWORD" -alias ${shellQuote(alias)} | ` +
    `grep -E 'Alias name:|Creation date:|Entry type:|Owner:|Valid from:|SHA256:' || true; ` +
    `ln "$STAGE" "$KEYSTORE_PATH" 2>/dev/null || { echo KEYSTORE_CREATE_COLLISION >&2; exit 42; }; ` +
    `rm -f -- "$STAGE"; trap - EXIT HUP INT TERM; ` +
    `echo "KEYSTORE_CREATED=$KEYSTORE_PATH"`;
  return executeGuardedTermuxCommand(command, { timeoutMs: 120_000, trustedInternal: true, allowSigningKeyAccess: true, executionTarget: "embedded-private" });
}

export async function inspectSigningKeystore(options: {
  path: string;
  password: string;
  alias?: string;
}): Promise<SigningCommandResult> {
  const path = shellQuotePath(options.path, "KEYSTORE_PATH");
  const password = assertPassword(options.password, "STORE_PASSWORD");
  const aliasArg = options.alias?.trim() ? `-alias ${shellQuote(options.alias.trim())}` : "";
  const command =
    `set -e; test -s ${path} || { echo "KEYSTORE_NOT_FOUND" >&2; exit 2; }; ` +
    `KEYSTORE_PASSWORD=${shellQuote(password)}; command -v keytool >/dev/null 2>&1 || { echo "KEYTOOL_MISSING" >&2; exit 127; }; ` +
    `keytool -list -v -keystore ${path} -storepass "$KEYSTORE_PASSWORD" ${aliasArg} | ` +
    `grep -E 'Keystore type:|Keystore provider:|Alias name:|Creation date:|Entry type:|Owner:|Issuer:|Valid from:|Certificate fingerprints:|SHA256:' || true`;
  return executeGuardedTermuxCommand(command, { timeoutMs: 60_000, trustedInternal: true, allowSigningKeyAccess: true, executionTarget: "embedded-private" });
}

export async function signApk(options: {
  inputApk: string;
  outputApk: string;
  keystorePath: string;
  alias: string;
  storePassword: string;
  keyPassword: string;
}): Promise<SigningCommandResult> {
  const inputApk = shellQuotePath(options.inputApk, "APK_PATH");
  const outputApk = shellQuotePath(options.outputApk, "OUTPUT_APK_PATH");
  const keystorePath = shellQuotePath(options.keystorePath, "KEYSTORE_PATH");
  const alias = options.alias.trim() || "release";
  const storePassword = assertPassword(options.storePassword, "STORE_PASSWORD");
  const keyPassword = assertPassword(options.keyPassword, "KEY_PASSWORD");
  const command =
    `set -e; ${privateKeyRootSetup()}` +
    `test -s ${inputApk} || { echo "APK_NOT_FOUND" >&2; exit 2; }; ` +
    `test -s ${keystorePath} || { echo "KEYSTORE_NOT_FOUND" >&2; exit 2; }; ` +
    `export KEYSTORE_PASSWORD=${shellQuote(storePassword)}; export KEY_PASSWORD=${shellQuote(keyPassword)}; ` +
    `APKSIGNER=$(command -v apksigner || true); ` +
    `if [ -z "$APKSIGNER" ]; then APKSIGNER=$(find "$PREFIX" -type f -name apksigner 2>/dev/null | head -n 1); fi; ` +
    `if [ -z "$APKSIGNER" ]; then echo "APKSIGNER_MISSING" >&2; exit 127; fi; ` +
    `ZIPALIGN=$(command -v zipalign || true); ` +
    `if [ -z "$ZIPALIGN" ]; then ZIPALIGN=$(find "$PREFIX" -type f -name zipalign 2>/dev/null | head -n 1); fi; ` +
    `mkdir -p "$(dirname ${outputApk})"; ` +
    `TMP="$AIB_PRIVATE_ROOT/tmp/apksign-$$.aligned.apk"; trap 'rm -f -- "$TMP"' EXIT; ` +
    `if [ -n "$ZIPALIGN" ]; then "$ZIPALIGN" -f -p 4 ${inputApk} "$TMP"; SRC="$TMP"; else SRC=${inputApk}; fi; ` +
    `"$APKSIGNER" sign --v1-signing-enabled true --v2-signing-enabled true --v3-signing-enabled true ` +
    `--ks ${keystorePath} --ks-pass env:KEYSTORE_PASSWORD --key-pass env:KEY_PASSWORD ` +
    `--ks-key-alias ${shellQuote(alias)} --out ${outputApk} "$SRC"; ` +
    `rm -f -- "$TMP"; trap - EXIT; ` +
    `"$APKSIGNER" verify --verbose --print-certs ${outputApk}; ` +
    `echo "APK_SIGNED=${options.outputApk}"`;
  return executeGuardedTermuxCommand(command, { timeoutMs: 180_000, isBuild: true, trustedInternal: true, allowSigningKeyAccess: true, executionTarget: "embedded-private" });
}

export async function importSigningKeystore(
  sourcePath: string,
  fileName: string,
): Promise<SigningCommandResult> {
  const source = shellQuotePath(sourcePath, "KEYSTORE_SOURCE");
  const file = normalizeKeystoreFileName(fileName);
  const command =
    `set -eu; ${privateKeyRootSetup()}` +
    `SOURCE=${source}; DEST="$SIGNING_ROOT"/${shellQuote(file)}; ` +
    `test -s "$SOURCE" || { echo KEYSTORE_IMPORT_SOURCE_MISSING >&2; exit 2; }; ` +
    `[ ! -e "$DEST" ] || { echo "KEYSTORE_EXISTS:$DEST" >&2; exit 3; }; ` +
    `STAGE=$(mktemp "$SIGNING_ROOT/.import.XXXXXXXX") || { echo KEYSTORE_STAGE_FAILED >&2; exit 41; }; ` +
    `trap 'rm -f -- "$STAGE"' EXIT HUP INT TERM; ` +
    `cp -- "$SOURCE" "$STAGE"; chmod 600 "$STAGE"; ` +
    `cmp -s -- "$SOURCE" "$STAGE" || { echo KEYSTORE_IMPORT_VERIFY_FAILED >&2; exit 42; }; ` +
    `ln "$STAGE" "$DEST" 2>/dev/null || { echo KEYSTORE_IMPORT_COLLISION >&2; exit 43; }; ` +
    `rm -f -- "$STAGE"; trap - EXIT HUP INT TERM; ` +
    `echo "KEYSTORE_IMPORTED=~/.aibuilder/keys/${file}"`;
  return executeGuardedTermuxCommand(command, { timeoutMs: 60_000, trustedInternal: true, allowSigningKeyAccess: true, executionTarget: "embedded-private" });
}

/** Explicitly copies old shared-storage keystores; source files are never deleted or modified. */
export function buildLegacySigningKeystoreCopyCommand(): string {
  return [
    "set -u",
    'AIB_PRIVATE_ROOT="${AIB_PRIVATE_ROOT:-$HOME/.aibuilder}"',
    'PRIVATE_KEYS="$AIB_PRIVATE_ROOT/keys"',
    'LEGACY_KEYS="${AIB_SHARED_ROOT:-/storage/emulated/0/AIBuilderTermux}/.aibuilder/keys"',
    '[ ! -L "$AIB_PRIVATE_ROOT" ] && [ ! -L "$PRIVATE_KEYS" ] || { echo PRIVATE_SIGNING_ROOT_UNAVAILABLE >&2; exit 40; }',
    'mkdir -p "$PRIVATE_KEYS" || { echo PRIVATE_SIGNING_ROOT_UNAVAILABLE >&2; exit 40; }',
    'chmod 700 "$AIB_PRIVATE_ROOT" "$PRIVATE_KEYS" 2>/dev/null || { echo PRIVATE_SIGNING_ROOT_UNAVAILABLE >&2; exit 40; }',
    'stage=""; cleanup_copy_stage() { [ -z "$stage" ] || rm -f -- "$stage"; }; trap cleanup_copy_stage EXIT; trap "exit 130" HUP INT TERM',
    'copied=0; already=0; conflicts=0; failed=0; found=0',
    'for source in "$LEGACY_KEYS"/*.keystore "$LEGACY_KEYS"/*.jks; do',
    '  [ -f "$source" ] && [ ! -L "$source" ] || continue; found=1; name=$(basename "$source")',
    '  case "$name" in *[!A-Za-z0-9._-]*) echo "KEYSTORE_COPY_INVALID_NAME:$name"; failed=$((failed+1)); continue;; esac',
    '  dest="$PRIVATE_KEYS/$name"',
    '  if [ -e "$dest" ]; then',
    '    if cmp -s -- "$source" "$dest"; then echo "KEYSTORE_COPY_ALREADY_PRESENT:$name"; already=$((already+1));',
    '    else echo "KEYSTORE_COPY_CONFLICT:$name"; conflicts=$((conflicts+1)); fi',
    '    continue',
    '  fi',
    '  stage=$(mktemp "$PRIVATE_KEYS/.copy.XXXXXXXX") || { echo "KEYSTORE_COPY_STAGE_FAILED:$name"; failed=$((failed+1)); continue; }',
    '  if ! (umask 077; cp -- "$source" "$stage") || ! chmod 600 "$stage" || ! cmp -s -- "$source" "$stage"; then rm -f -- "$stage"; stage=""; echo "KEYSTORE_COPY_FAILED:$name"; failed=$((failed+1)); continue; fi',
    '  if ! ln "$stage" "$dest" 2>/dev/null; then rm -f -- "$stage"; stage=""; echo "KEYSTORE_COPY_CONFLICT:$name"; conflicts=$((conflicts+1)); continue; fi',
    '  rm -f -- "$stage"; stage=""',
    '  if cmp -s -- "$source" "$dest"; then echo "KEYSTORE_COPIED:$name"; copied=$((copied+1)); else echo "KEYSTORE_COPY_READBACK_FAILED:$name"; failed=$((failed+1)); fi',
    'done',
    '[ "$found" -eq 1 ] || echo NO_LEGACY_SIGNING_KEYS',
    'echo "KEYSTORE_COPY_SUMMARY copied=$copied already_private=$already conflicts=$conflicts failed=$failed source_preserved=1"',
    '[ "$failed" -eq 0 ] && [ "$conflicts" -eq 0 ]',
  ].join("\n");
}

export async function copyLegacySigningKeystores(): Promise<SigningCommandResult> {
  const command = buildLegacySigningKeystoreCopyCommand();
  return executeGuardedTermuxCommand(command, { timeoutMs: 60_000, trustedInternal: true, allowSigningKeyAccess: true, executionTarget: "embedded-private" });
}

export async function listSigningKeystores(): Promise<SigningCommandResult> {
  const command =
    `set -e; ${privateKeyRootSetup()}` +
    `found=0; private_found=0; for f in "$SIGNING_ROOT"/*.keystore "$SIGNING_ROOT"/*.jks; do ` +
    `if [ -f "$f" ] && [ ! -L "$f" ]; then found=1; private_found=1; printf 'PRIVATE\\t%s\\t%s\\n' "$(basename "$f")" "$(stat -c %s "$f" 2>/dev/null || wc -c < "$f")"; fi; ` +
    `done; ` +
    `LEGACY_KEYS="${LEGACY_SIGNING_ROOT}"; legacy_found=0; for f in "$LEGACY_KEYS"/*.keystore "$LEGACY_KEYS"/*.jks; do ` +
    `if [ -f "$f" ] && [ ! -L "$f" ]; then found=1; legacy_found=1; printf 'LEGACY\\t%s\\t%s\\n' "$(basename "$f")" "$(stat -c %s "$f" 2>/dev/null || wc -c < "$f")"; fi; done; ` +
    `[ "$legacy_found" -eq 0 ] || echo LEGACY_KEYS_PRESENT; [ "$found" -eq 0 ] && echo NO_SIGNING_KEYS || true`;
  return executeGuardedTermuxCommand(command, { timeoutMs: 30_000, trustedInternal: true, allowSigningKeyAccess: true, executionTarget: "embedded-private" });
}

export async function deleteSigningKeystore(path: string): Promise<SigningCommandResult> {
  const normalized = assertPath(path, "SIGNING_KEY_PATH");
  const prefixes = [
    `${SIGNING_ROOT}/`,
    `${LEGACY_SIGNING_ROOT}/`,
    
  ];
  const prefix = prefixes.find((candidate) => normalized.startsWith(candidate));
  const name = prefix ? normalized.slice(prefix.length) : "";
  if (!prefix || !/^[A-Za-z0-9._-]+\.(?:keystore|jks)$/i.test(name) || name.includes("/")) {
    throw new Error("INVALID_SIGNING_KEY_PATH");
  }
  // Legacy keys are never deleted from this screen; migrate them explicitly first.
  if (prefix === `${LEGACY_SIGNING_ROOT}/`) throw new Error("MIGRATE_LEGACY_KEY_FIRST");
  const command =
    `set -eu; ${privateKeyRootSetup()}` +
    `target="$SIGNING_ROOT"/${shellQuote(name)}; ` +
    `[ -f "$target" ] && [ ! -L "$target" ] || { echo KEYSTORE_NOT_FOUND_OR_UNSAFE >&2; exit 2; }; ` +
    `rm -f -- "$target"; echo "KEYSTORE_DELETED=~/.aibuilder/keys/${name}"`;
  return executeGuardedTermuxCommand(command, { timeoutMs: 30_000, trustedInternal: true, allowSigningKeyAccess: true, executionTarget: "embedded-private" });
}

export async function verifyApkSignature(path: string): Promise<SigningCommandResult> {
  const p = shellQuotePath(path, "APK_PATH");
  const command =
    `set -e; test -s ${p} || { echo "APK_NOT_FOUND" >&2; exit 2; }; ` +
    `APKSIGNER=$(command -v apksigner || true); ` +
    `if [ -z "$APKSIGNER" ]; then APKSIGNER=$(find "$PREFIX" -type f -name apksigner 2>/dev/null | head -n 1); fi; ` +
    `if [ -z "$APKSIGNER" ]; then echo "APKSIGNER_MISSING" >&2; exit 127; fi; ` +
    `"$APKSIGNER" verify --verbose --print-certs ${p}`;
  return executeGuardedTermuxCommand(command, { timeoutMs: 60_000, isBuild: true, trustedInternal: true, executionTarget: "embedded-private" });
}
