/** Shared fail-closed policy for archives that may contain credentials or private key material. */
export const SECRET_ARCHIVE_TAR_EXCLUDES: readonly string[] = Object.freeze([
  ".env", ".env.*", "**/.env", "**/.env.*",
  ".secrets", ".secrets/**", "**/.secrets", "**/.secrets/**",
  "**/*credential*", "**/*secret*", "**/*token*", "**/*api-key*", "**/*api_key*", "**/*apikey*", "**/*private-key*",
  "keys", "keys/**", "**/keys", "**/keys/**", ".aibuilder/keys", ".aibuilder/keys/**",
  "**/*.pem", "**/*.key", "**/*.p12", "**/*.keystore", "**/*.jks", "**/*.pfx",
  "**/id_rsa*", "**/id_ed25519*", "**/bridge-token*", "**/lanBridge*",
]);

/** GNU/Termux grep ERE used against decompressed archive contents; never prints matching data. */
export const SECRET_CONTENT_EGREP_PATTERN = String.raw`(-----BEGIN[[:space:]]+(RSA[[:space:]]+|EC[[:space:]]+|OPENSSH[[:space:]]+|DSA[[:space:]]+)?PRIVATE[[:space:]]+KEY-----|Bearer[[:space:]]+[A-Za-z0-9._~+/-]{16,}|sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,}|glpat-[A-Za-z0-9_-]{20,}|aib_[A-Za-z0-9_-]{8,}[0-9]{10,13}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|xox[baprs]-[A-Za-z0-9-]{12,}|eyJ[A-Za-z0-9_-]{10,}[.][A-Za-z0-9_-]{10,}[.][A-Za-z0-9_-]{8,}|(api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|password|passwd|private[_ -]?key|credential|authorization|auth)[[:space:]]*["']?[[:space:]]*[:=][[:space:]]*["']?[^[:space:],;"']{6,})`;

const SECRET_ARCHIVE_SEGMENT = /^(?:\.env(?:\..*)?|\.secrets|[^/]*(?:credential|secret|token|api[-_]?key|private[-_]key)[^/]*|keys|id_(?:rsa|ed25519)[^/]*|bridge-token[^/]*|lanBridge[^/]*|[^/]+\.(?:pem|key|p12|keystore|jks|pfx))$/i;

export function isSecretArchiveMember(name: string): boolean {
  const normalized = String(name).replace(/^(?:\.\/)+/, "").replace(/\/+$/, "");
  if (!normalized || normalized === ".") return false;
  return normalized.split("/").some((segment) => SECRET_ARCHIVE_SEGMENT.test(segment));
}

export function shellQuote(value: string): string {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

/** Scan archive bytes through grep without exposing matching lines to app logs/stdout. */
export function buildArchiveSecretScanCommand(archivePath: string): string {
  return `tar -xzf ${shellQuote(archivePath)} -O | grep -a -i -E ${shellQuote(SECRET_CONTENT_EGREP_PATTERN)} >/dev/null`;
}

/** Shell `case` alternatives equivalent to the path policy, for import scripts. */
export const SECRET_ARCHIVE_SHELL_CASE_GLOBS = [
  ".env", ".env.*", "*/.env", "*/.env.*", ".secrets", ".secrets/*", "*/.secrets", "*/.secrets/*",
  "*credential*", "*secret*", "*token*", "*api-key*", "*api_key*", "*apikey*", "*private-key*",
  "keys", "keys/*", "*/keys", "*/keys/*", ".aibuilder/keys", ".aibuilder/keys/*",
  "*.pem", "*.key", "*.p12", "*.keystore", "*.jks", "*.pfx",
  "id_rsa*", "id_ed25519*", "*bridge-token*", "*lanBridge*",
].join("|");
