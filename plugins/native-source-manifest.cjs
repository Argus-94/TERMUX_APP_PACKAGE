const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const REQUIRED_NATIVE_SOURCE_ASSETS = Object.freeze([
  "plugins/android/AibAccessibilityService.kt",
  "plugins/android/AibAccessibilityModule.kt",
  "plugins/android/AibAccessibilityPackage.kt",
  "plugins/android/AibLoopbackServer.kt",
  "plugins/android/AibMemoryPressureModule.kt",
  "plugins/android/AibMemoryPressurePackage.kt",
  "plugins/android/ADDITIONAL-SHA256SUMS",
  "plugins/android/SHA256SUMS",
  "plugins/android/aib_accessibility_service.xml",
  "native/aib-credential-proxy/AibCredentialHttpProxyServer.java",
  "native/aib-credential-proxy/AibCredentialProxyModule.kt",
  "native/aib-credential-proxy/AibCredentialProxyPackage.kt",
  "native/aib-interceptor/AibInterceptorProxyServer.java",
  "native/aib-interceptor/AibInterceptorCertificateStore.kt",
  "native/aib-interceptor/AibInterceptorProxyModule.kt",
  "native/aib-interceptor/AibInterceptorProxyPackage.kt",
]);

const NATIVE_SOURCE_CHECKSUM_MANIFESTS = Object.freeze([
  { path: "plugins/android/SHA256SUMS", files: ["AibAccessibilityService.kt", "AibAccessibilityModule.kt", "AibAccessibilityPackage.kt", "aib_accessibility_service.xml", "AibLoopbackServer.kt"] },
  { path: "plugins/android/ADDITIONAL-SHA256SUMS", files: ["AibMemoryPressureModule.kt", "AibMemoryPressurePackage.kt"] },
]);

function missingNativeSourceAssets(projectRoot) {
  const root = path.resolve(projectRoot);
  const missing = [];
  for (const relativePath of REQUIRED_NATIVE_SOURCE_ASSETS) {
    const absolutePath = path.resolve(root, relativePath);
    if (absolutePath !== root && !absolutePath.startsWith(`${root}${path.sep}`)) {
      missing.push(`${relativePath} (path escapes project root)`);
      continue;
    }
    try {
      const stat = fs.lstatSync(absolutePath);
      const realPath = fs.realpathSync(absolutePath);
      if (!stat.isFile() || stat.isSymbolicLink() || !realPath.startsWith(`${root}${path.sep}`)) {
        missing.push(`${relativePath} (must be a regular in-project file)`);
        continue;
      }
      if (stat.size === 0 || (stat.mode & 0o444) === 0) {
        missing.push(`${relativePath} (empty or unreadable)`);
        continue;
      }
      const fd = fs.openSync(absolutePath, "r");
      try {
        const probe = Buffer.alloc(1);
        fs.readSync(fd, probe, 0, 1, 0);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      missing.push(relativePath);
    }
  }
  return missing;
}

function nativeSourceChecksumErrors(projectRoot) {
  const root = path.resolve(projectRoot);
  const errors = [];
  for (const manifestSpec of NATIVE_SOURCE_CHECKSUM_MANIFESTS) {
    const manifestPath = path.resolve(root, manifestSpec.path);
    let text;
    try { text = fs.readFileSync(manifestPath, "utf8"); }
    catch { errors.push(`${manifestSpec.path} (unreadable checksum manifest)`); continue; }
    const parsed = new Map();
    let malformed = false;
    for (const raw of text.split(/\r?\n/).filter((line) => line.trim())) {
      const match = raw.match(/^([a-f0-9]{64})\s+([A-Za-z0-9_.-]+)$/i);
      if (!match || parsed.has(match[2])) { malformed = true; break; }
      parsed.set(match[2], match[1].toLowerCase());
    }
    const expected = new Set(manifestSpec.files);
    if (malformed || parsed.size !== expected.size || [...parsed.keys()].some((name) => !expected.has(name))) {
      errors.push(`${manifestSpec.path} (malformed or incomplete manifest)`);
      continue;
    }
    const dir = path.dirname(manifestPath);
    for (const name of manifestSpec.files) {
      const file = path.resolve(dir, name);
      try {
        const stat = fs.lstatSync(file);
        const real = fs.realpathSync(file);
        if (!stat.isFile() || stat.isSymbolicLink() || !real.startsWith(`${dir}${path.sep}`)) {
          errors.push(`${manifestSpec.path}:${name} (not a regular in-directory file)`);
          continue;
        }
        const actual = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
        if (actual !== parsed.get(name)) errors.push(`${manifestSpec.path}:${name} (SHA-256 mismatch)`);
      } catch { errors.push(`${manifestSpec.path}:${name} (unreadable source)`); }
    }
  }
  return errors;
}

function assertRequiredNativeSourceAssets(projectRoot) {
  const missing = missingNativeSourceAssets(projectRoot);
  if (missing.length) {
    throw new Error(
      `AIB_NATIVE_SOURCE_MISSING: required canonical Android sources are absent or unsafe: ${missing.join(", ")}. Restore the project-owned source assets before dependency installation or Expo prebuild; no substitute source will be generated.`,
    );
  }
  const checksumErrors = nativeSourceChecksumErrors(projectRoot);
  if (checksumErrors.length) {
    throw new Error(`AIB_NATIVE_SOURCE_INTEGRITY_ERROR: canonical Android assets failed pinned SHA-256 verification: ${checksumErrors.join(", ")}. Restore the reviewed project-owned source and update its pinned manifest only with an intentional reviewed change.`);
  }
}

module.exports = {
  REQUIRED_NATIVE_SOURCE_ASSETS,
  missingNativeSourceAssets,
  nativeSourceChecksumErrors,
  assertRequiredNativeSourceAssets,
};
