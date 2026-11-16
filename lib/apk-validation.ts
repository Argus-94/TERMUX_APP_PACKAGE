export type ApkValidation = Readonly<{
  ok: boolean;
  sizeBytes: number;
  sizeLabel: string;
  packageName?: string;
  versionCode?: string;
  certificateSha256?: string;
  log: string;
}>;

export type ApkValidationBackend = "termux" | "ubuntu-proot";

export type ApkValidationExpectations = Readonly<{
  expectedPackageName?: string;
  expectedVersionName?: string;
}>;

function shellQuote(value: string): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** Build a read-only, fail-closed on-device archive, identity and signature validation command. */
export function buildApkValidationCommand(
  apkPath: string,
  backend: ApkValidationBackend = "termux",
  expectations: ApkValidationExpectations = {},
): string {
  if (/[\0\r\n]/.test(apkPath)) throw new Error("APK_PATH_INVALID");
  for (const value of [expectations.expectedPackageName, expectations.expectedVersionName]) {
    if (value !== undefined && /[\0\r\n]/.test(value)) throw new Error("APK_EXPECTED_IDENTITY_INVALID");
  }
  const quoted = shellQuote(apkPath);
  const expectedPackageName = shellQuote(expectations.expectedPackageName || "");
  const expectedVersionName = shellQuote(expectations.expectedVersionName || "");
  const sdkCandidates = backend === "termux"
    ? [
        '"${ANDROID_HOME:-}"',
        '"${ANDROID_SDK_ROOT:-}"',
        '"$HOME/android-sdk"',
        '"$HOME/Android/Sdk"',
        '"$PREFIX/opt/aibuilder-toolpack/android-sdk"',
        '"$PREFIX/opt/android-sdk"',
        '"$PREFIX/share/android-sdk"',
        '"$PREFIX/lib/android-sdk"',
      ]
    : [
        '"${ANDROID_HOME:-}"',
        '"${ANDROID_SDK_ROOT:-}"',
        '"$HOME/android-sdk"',
        '"$HOME/Android/Sdk"',
        '"/opt/aibuilder-toolpack/android-sdk"',
        '"/opt/android-sdk"',
        '"/usr/local/android-sdk"',
        '"/usr/lib/android-sdk"',
      ];
  const backendInit = backend === "termux"
    ? 'PREFIX="${PREFIX:-/data/data/com.karat.aibuilder/files/usr}"'
    : "unset PREFIX";
  return [
    `APK=${quoted}`,
    `EXPECTED_PACKAGE=${expectedPackageName}`,
    `EXPECTED_VERSION_NAME=${expectedVersionName}`,
    `AIB_APK_VALIDATION_BACKEND=${backend}`,
    'echo "AIB_APK_VALIDATION_BACKEND=$AIB_APK_VALIDATION_BACKEND"',
    'if [ ! -f "$APK" ] || [ -L "$APK" ]; then echo AIB_APK_MISSING_OR_NOT_REGULAR; exit 2; fi',
    'SZ=$(wc -c < "$APK" | tr -d " ")',
    '[ "${SZ:-0}" -gt 0 ] || { echo AIB_APK_EMPTY; exit 3; }',
    'echo "AIB_APK_SIZE=$SZ"',
    'command -v unzip >/dev/null 2>&1 || { echo AIB_APK_ZIP_TOOL_MISSING; exit 4; }',
    'unzip -tqq "$APK" >/dev/null 2>&1 || { echo AIB_APK_ARCHIVE_CORRUPT; exit 5; }',
    'case "$APK" in',
    '  *.apk|*.APK)',
    '    unzip -Z1 "$APK" 2>/dev/null | grep -Fxq AndroidManifest.xml || { echo AIB_APK_MANIFEST_MISSING; exit 15; }',
    `    APKSIGNER=""; ${backendInit}`,
    '    AAPT2=""',
    `    for SDK in ${sdkCandidates.join(" ")}; do`,
    '      [ -n "$SDK" ] || continue',
    '      for CANDIDATE in "$SDK"/build-tools/*/apksigner; do [ -x "$CANDIDATE" ] && APKSIGNER="$CANDIDATE"; done',
    '      for CANDIDATE in "$SDK"/build-tools/*/aapt2; do [ -x "$CANDIDATE" ] && AAPT2="$CANDIDATE"; done',
    '    done',
    '    [ -n "$APKSIGNER" ] || APKSIGNER=$(command -v apksigner 2>/dev/null || true)',
    '    [ -n "$AAPT2" ] || AAPT2=$(command -v aapt2 2>/dev/null || true)',
    '    [ -n "$APKSIGNER" ] || { echo AIB_APK_APKSIGNER_MISSING; exit 6; }',
    '    [ -n "$AAPT2" ] || { echo AIB_APK_AAPT2_MISSING; exit 16; }',
    '    VERIFY=$("$APKSIGNER" verify --verbose --print-certs "$APK" 2>&1); VEC=$?',
    '    printf "%s\\n" "$VERIFY"',
    '    [ "$VEC" -eq 0 ] || { echo AIB_APK_SIGNATURE_INVALID; exit 7; }',
    '    printf "%s\\n" "$VERIFY" | grep -Eiq "Verified using v1 scheme.*true|v1.*true" || { echo AIB_APK_V1_SIGNATURE_MISSING; exit 8; }',
    '    printf "%s\\n" "$VERIFY" | grep -Eiq "Verified using v2 scheme.*true|v2.*true" || { echo AIB_APK_V2_SIGNATURE_MISSING; exit 9; }',
    '    printf "%s\\n" "$VERIFY" | grep -Eiq "Verified using v3 scheme.*true|v3.*true" || { echo AIB_APK_V3_SIGNATURE_MISSING; exit 10; }',
    '    CERT_SHA256=$(printf "%s\\n" "$VERIFY" | sed -nE "s/.*certificate SHA-256 digest: ([[:xdigit:]]{64}).*/\\1/ip" | head -1 | tr "A-F" "a-f")',
    '    printf "%s\\n" "$CERT_SHA256" | grep -Eq "^[0-9a-f]{64}$" || { echo AIB_APK_CERTIFICATE_DIGEST_MISSING; exit 17; }',
    '    echo "AIB_APK_CERT_SHA256=$CERT_SHA256"',
    '    BADGING=$("$AAPT2" dump badging "$APK" 2>&1); AEC=$?',
    '    printf "%s\\n" "$BADGING" | head -20',
    '    [ "$AEC" -eq 0 ] || { echo AIB_APK_IDENTITY_READ_FAILED; exit 18; }',
    '    PKG_LINE=$(printf "%s\\n" "$BADGING" | grep "^package:" | head -1)',
    '    APP_ID=$(printf "%s\\n" "$PKG_LINE" | sed -n "s/.*name=\\x27\\([^\\x27]*\\)\\x27.*/\\1/p")',
    '    VERSION_CODE=$(printf "%s\\n" "$PKG_LINE" | sed -n "s/.*versionCode=\\x27\\([^\\x27]*\\)\\x27.*/\\1/p")',
    '    VERSION_NAME=$(printf "%s\\n" "$PKG_LINE" | sed -n "s/.*versionName=\\x27\\([^\\x27]*\\)\\x27.*/\\1/p")',
    '    printf "%s\\n" "$APP_ID" | grep -Eq "^[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z0-9_]+)+$" || { echo AIB_APK_PACKAGE_INVALID; exit 19; }',
    '    case "$VERSION_CODE" in ""|*[!0-9]*) echo AIB_APK_VERSION_CODE_INVALID; exit 20;; esac',
    '    [ -z "$EXPECTED_PACKAGE" ] || [ "$APP_ID" = "$EXPECTED_PACKAGE" ] || { echo AIB_APK_PACKAGE_MISMATCH; exit 21; }',
    '    [ -z "$EXPECTED_VERSION_NAME" ] || [ "$VERSION_NAME" = "$EXPECTED_VERSION_NAME" ] || { echo AIB_APK_VERSION_NAME_MISMATCH; exit 22; }',
    '    echo "AIB_APK_PACKAGE=$APP_ID"',
    '    echo "AIB_APK_VERSION_CODE=$VERSION_CODE"',
    '    echo "AIB_APK_VERSION_NAME=$VERSION_NAME"',
    '    echo AIB_APK_IDENTITY_OK',
    '    echo AIB_APK_SIGNATURE_V1_V2_V3_OK',
    '    ;;',
    '  *.aab|*.AAB)',
    '    unzip -Z1 "$APK" 2>/dev/null | grep -Eq "^(base/manifest/AndroidManifest.xml|manifest/AndroidManifest.xml)$" || { echo AIB_AAB_MANIFEST_MISSING; exit 23; }',
    '    command -v jarsigner >/dev/null 2>&1 || { echo AIB_AAB_JARSIGNER_MISSING; exit 12; }',
    '    JAR_VERIFY=$(jarsigner -verify "$APK" 2>&1); JEC=$?',
    '    printf "%s\\n" "$JAR_VERIFY"',
    '    [ "$JEC" -eq 0 ] || { echo AIB_AAB_SIGNATURE_INVALID; exit 13; }',
    '    printf "%s\\n" "$JAR_VERIFY" | grep -Eiq "jar verified" || { echo AIB_AAB_SIGNATURE_INVALID; exit 14; }',
    '    echo AIB_AAB_SIGNATURE_VERIFIED',
    '    ;;',
    '  *) echo AIB_APK_UNSUPPORTED_EXTENSION; exit 11 ;;',
    'esac',
    'echo AIB_APK_VERIFIED',
  ].join("\n");
}

/** Parse only explicit completion markers emitted by buildApkValidationCommand. */
export function parseApkValidation(log: string, exitCode = 1): ApkValidation {
  const text = String(log ?? "");
  const size = Number(text.match(/AIB_APK_SIZE=(\d+)/)?.[1] || 0);
  const sizeLabel = size >= 1048576
    ? `${(size / 1048576).toFixed(2)} MB`
    : size > 0
      ? `${Math.max(1, Math.round(size / 1024))} KB`
      : "";
  const packageName = text.match(/^AIB_APK_PACKAGE=([A-Za-z0-9_.]+)$/m)?.[1];
  const versionCode = text.match(/^AIB_APK_VERSION_CODE=(\d+)$/m)?.[1];
  const certificateSha256 = text.match(/^AIB_APK_CERT_SHA256=([a-f0-9]{64})$/m)?.[1];
  const verifiedMarker = /(?:^|\n)AIB_APK_VERIFIED(?:\r?\n|$)/.test(text);
  const apkIdentityOk = !!packageName && !!versionCode && !!certificateSha256 && /(?:^|\n)AIB_APK_IDENTITY_OK(?:\r?\n|$)/.test(text);
  const apkSignatureOk = /(?:^|\n)AIB_APK_SIGNATURE_V1_V2_V3_OK(?:\r?\n|$)/.test(text);
  const aabSignatureOk = /(?:^|\n)AIB_AAB_SIGNATURE_VERIFIED(?:\r?\n|$)/.test(text);
  const ok = exitCode === 0 && size > 0 && verifiedMarker && ((apkIdentityOk && apkSignatureOk) || aabSignatureOk);
  return { ok, sizeBytes: size, sizeLabel, packageName, versionCode, certificateSha256, log: text };
}
