import { Directory, File, Paths } from "expo-file-system";
import { strFromU8, strToU8 } from "fflate";
import {
  extractSelectedZipEntries,
  hasZipStartSignature,
  listZipEntryNames,
  type ZipByteSource,
} from "./archive-utils";
import { getOfflineBundleFileSha256, isOfflinePackageSignatureVerifierAvailable, verifyOfflinePackageManifestSignature } from "./termux-bridge";

export type OfflineBundleStatus = "blocked" | "rejected" | "cancelled";
export type OfflineBundleProgressPhase = "reading" | "checking" | "done";

export interface OfflineBundleInspection {
  status: OfflineBundleStatus;
  code: string;
  packageCount?: number;
  declaredPackageBytes?: number;
}

export interface OfflineBundleProgress {
  percent: number;
  phase: OfflineBundleProgressPhase;
}

export interface OfflineBundleOptions {
  signal?: AbortSignal;
  onProgress?: (progress: OfflineBundleProgress) => void;
}

const MAX_ARCHIVE_BYTES = 200 * 1024 * 1024;
const MAX_ARCHIVE_MEMBERS = 258;
const MAX_MANIFEST_BYTES = 192 * 1024;
const MAX_SIGNATURE_BYTES = 256;
const MAX_PACKAGE_COUNT = 256;
const MAX_PACKAGE_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_PACKAGE_BYTES = 150 * 1024 * 1024;
const MAX_FEED_FILE_BYTES = 32 * 1024 * 1024;
const FORMAT = "aibuilder-offline-package-bundle";
const APP_ID = "com.karat.aibuilder";
const CERT_SHA256 = "661e5c868dbb38f8fe57d380e5c9b35e594e79bedb72d9ad2ad0113665c80418";

interface ManifestFile { path: string; sizeBytes: number; sha256: string }
interface ManifestPackage {
  name: string;
  version: string;
  architecture: "aarch64" | "all";
  filename: string;
  sizeBytes: number;
  sha256: string;
  depends: string[];
}
interface OfflineManifest {
  format: string;
  schemaVersion: number;
  appId: string;
  architecture: string;
  catalogState: string;
  catalogCommit: string;
  catalogSha256: string;
  dependencyClosureComplete: boolean;
  signatureAlgorithm: string;
  signerCertificateSha256: string;
  feedRoot: string;
  files: ManifestFile[];
  packages: ManifestPackage[];
}

export interface PreparedOfflinePackageBundleStage {
  status: "ready" | "blocked" | "rejected" | "cancelled";
  code: string;
  stageDirectoryUri?: string;
  packageCount?: number;
  totalBytes?: number;
  packages?: Array<{ name: string; version: string; architecture: "aarch64" | "all"; sizeBytes: number }>;
}

export interface OfflinePackageStageProgress {
  phase: "reading" | "checking" | "extracting";
  percent: number;
}

class BundleCancelled extends Error {}
function cancelled(signal?: AbortSignal): boolean { return signal?.aborted === true; }
function checkCancelled(signal?: AbortSignal): void { if (cancelled(signal)) throw new BundleCancelled(); }
function rejected(code: string): OfflineBundleInspection { return { status: "rejected", code }; }
function blocked(code: string, packageCount?: number, declaredPackageBytes?: number): OfflineBundleInspection {
  return { status: "blocked", code, packageCount, declaredPackageBytes };
}
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
function validFeedPath(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 512 || !value.startsWith("feed/")) return false;
  if (value.includes("\\") || value.includes("\0") || value.startsWith("/") || /^[A-Za-z]:/.test(value)) return false;
  const parts = value.split("/");
  return parts.length >= 2 && parts.every((part, index) => index === 0 ? part === "feed" : part.length > 0 && part !== "." && part !== "..");
}
function validateManifest(value: unknown): { manifest?: OfflineManifest; code?: string } {
  if (!isPlainObject(value) || !hasExactKeys(value, [
    "format", "schemaVersion", "appId", "architecture", "catalogState", "catalogCommit", "catalogSha256",
    "dependencyClosureComplete", "signatureAlgorithm", "signerCertificateSha256", "feedRoot", "files", "packages",
  ])) return { code: "AIB_OFFLINE_PACKAGE_MANIFEST_SCHEMA_INVALID" };
  if (value.format !== FORMAT || value.schemaVersion !== 2 || value.appId !== APP_ID || value.architecture !== "aarch64") {
    return { code: "AIB_OFFLINE_PACKAGE_BUNDLE_IDENTITY_INVALID" };
  }
  if (value.signatureAlgorithm !== "SHA256withRSA" || value.signerCertificateSha256 !== CERT_SHA256 || value.feedRoot !== "feed" ||
      value.catalogState !== "production-qualified" || value.dependencyClosureComplete !== true ||
      typeof value.catalogCommit !== "string" || !/^[a-f0-9]{40}$/i.test(value.catalogCommit) ||
      typeof value.catalogSha256 !== "string" || !/^[a-f0-9]{64}$/i.test(value.catalogSha256) ||
      !Array.isArray(value.files) || value.files.length < 1 || value.files.length > MAX_ARCHIVE_MEMBERS - 2 ||
      !Array.isArray(value.packages) || value.packages.length < 1 || value.packages.length > MAX_PACKAGE_COUNT) {
    return { code: "AIB_OFFLINE_PACKAGE_MANIFEST_FIELDS_INVALID" };
  }

  const files = new Map<string, ManifestFile>();
  let totalFileBytes = 0;
  for (const item of value.files) {
    if (!isPlainObject(item) || !hasExactKeys(item, ["path", "sizeBytes", "sha256"]) || !validFeedPath(item.path) ||
        !Number.isSafeInteger(item.sizeBytes) || (item.sizeBytes as number) < 1 || (item.sizeBytes as number) > MAX_FEED_FILE_BYTES ||
        typeof item.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(item.sha256) || files.has(item.path)) {
      return { code: "AIB_OFFLINE_PACKAGE_FILE_RECORD_INVALID" };
    }
    totalFileBytes += item.sizeBytes as number;
    if (!Number.isSafeInteger(totalFileBytes) || totalFileBytes > MAX_ARCHIVE_BYTES) return { code: "AIB_OFFLINE_PACKAGE_TOTAL_SIZE_LIMIT" };
    files.set(item.path, item as unknown as ManifestFile);
  }
  const packages = value.packages as unknown[];
  const seenNames = new Set<string>();
  const seenFiles = new Set<string>();
  let totalPackageBytes = 0;
  for (const raw of packages) {
    if (!isPlainObject(raw) || !hasExactKeys(raw, ["name", "version", "architecture", "filename", "sizeBytes", "sha256", "depends"])) {
      return { code: "AIB_OFFLINE_PACKAGE_RECORD_INVALID" };
    }
    if (typeof raw.name !== "string" || !/^[a-z0-9][a-z0-9.+-]{0,127}$/.test(raw.name) ||
        typeof raw.version !== "string" || !/^[A-Za-z0-9.+:~_-]{1,128}$/.test(raw.version) ||
        (raw.architecture !== "aarch64" && raw.architecture !== "all") || !validFeedPath(raw.filename) || !raw.filename.endsWith(".deb") ||
        !Number.isSafeInteger(raw.sizeBytes) || (raw.sizeBytes as number) < 1 || (raw.sizeBytes as number) > MAX_PACKAGE_BYTES ||
        typeof raw.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(raw.sha256) ||
        !Array.isArray(raw.depends) || raw.depends.length > 64 ||
        raw.depends.some(dep => typeof dep !== "string" || dep.length < 1 || dep.length > 512 || /[\r\n\0]/.test(dep))) {
      return { code: "AIB_OFFLINE_PACKAGE_RECORD_INVALID" };
    }
    const identity = `${raw.name}@${raw.version}`;
    if (seenNames.has(identity) || seenFiles.has(raw.filename)) return { code: "AIB_OFFLINE_PACKAGE_DUPLICATE_RECORD" };
    seenNames.add(identity);
    seenFiles.add(raw.filename);
    const inventory = files.get(raw.filename);
    if (!inventory || inventory.sizeBytes !== raw.sizeBytes || inventory.sha256.toLowerCase() !== raw.sha256.toLowerCase()) {
      return { code: "AIB_OFFLINE_PACKAGE_FILE_INVENTORY_MISMATCH" };
    }
    totalPackageBytes += raw.sizeBytes as number;
    if (!Number.isSafeInteger(totalPackageBytes) || totalPackageBytes > MAX_TOTAL_PACKAGE_BYTES) {
      return { code: "AIB_OFFLINE_PACKAGE_TOTAL_SIZE_LIMIT" };
    }
  }
  const packagesIndex = files.get("feed/dists/stable/main/binary-aarch64/Packages");
  if (!packagesIndex || packagesIndex.sha256.toLowerCase() !== (value.catalogSha256 as string).toLowerCase()) {
    return { code: "AIB_OFFLINE_PACKAGE_CATALOG_INDEX_MISMATCH" };
  }
  return { manifest: value as unknown as OfflineManifest };
}

function validatePackagesIndex(bytes: Uint8Array, manifest: OfflineManifest): boolean {
  let text: string;
  try {
    text = strFromU8(bytes);
    const roundTrip = strToU8(text);
    if (roundTrip.length !== bytes.length || roundTrip.some((byte, index) => byte !== bytes[index])) return false;
  } catch { return false; }
  const records = new Map<string, Map<string, string>>();
  for (const stanza of text.split(/\r?\n\r?\n/)) {
    if (!stanza.trim()) continue;
    const fields = new Map<string, string>();
    for (const line of stanza.split(/\r?\n/)) {
      if (!line || /^[ \t]/.test(line)) continue;
      const separator = line.indexOf(":");
      if (separator <= 0) return false;
      const key = line.slice(0, separator);
      if (fields.has(key)) return false;
      fields.set(key, line.slice(separator + 1).replace(/^ /, ""));
    }
    const name = fields.get("Package");
    const version = fields.get("Version");
    if (!name || !version || records.has(`${name}@${version}`)) return false;
    records.set(`${name}@${version}`, fields);
  }
  if (records.size !== manifest.packages.length) return false;
  for (const pkg of manifest.packages) {
    const fields = records.get(`${pkg.name}@${pkg.version}`);
    if (!fields || fields.get("Architecture") !== pkg.architecture || !pkg.filename.startsWith("feed/") ||
      fields.get("Filename") !== pkg.filename.slice("feed/".length) || fields.get("Size") !== String(pkg.sizeBytes) ||
      fields.get("SHA256")?.toLowerCase() !== pkg.sha256.toLowerCase()) return false;
  }
  return true;
}

export async function inspectOfflinePackageBundleSource(
  source: ZipByteSource,
  options: OfflineBundleOptions = {},
): Promise<OfflineBundleInspection> {
  const { signal, onProgress } = options;
  const report = (percent: number, phase: OfflineBundleProgressPhase) => onProgress?.({ percent: Math.max(0, Math.min(100, percent)), phase });
  try {
    checkCancelled(signal);
    if (!Number.isSafeInteger(source.size) || source.size < 22 || source.size > MAX_ARCHIVE_BYTES) return rejected("AIB_OFFLINE_PACKAGE_ARCHIVE_SIZE_INVALID");
    const prefix = await source.read(0, Math.min(4, source.size));
    checkCancelled(signal);
    if (!hasZipStartSignature(prefix)) return rejected("AIB_OFFLINE_PACKAGE_NOT_ZIP");
    report(2, "reading");
    let sequentialOffset = 0;
    const monitored: ZipByteSource = {
      size: source.size,
      async read(start, end) {
        checkCancelled(signal);
        const bytes = await source.read(start, end);
        checkCancelled(signal);
        if (start === sequentialOffset) {
          sequentialOffset = end;
          report(2 + Math.floor((end / source.size) * 86), "reading");
        }
        return bytes;
      },
    };
    const listing = await listZipEntryNames(monitored, "zip", MAX_ARCHIVE_MEMBERS);
    checkCancelled(signal);
    if (!listing.inspection.safe || listing.error) return rejected("AIB_OFFLINE_PACKAGE_ARCHIVE_STRUCTURE_INVALID");
    const names = listing.names;
    if (names.length < 3 || !names.includes("manifest.json") || !names.includes("manifest.sig")) return rejected("AIB_OFFLINE_PACKAGE_METADATA_MISSING");
    if (names.some(name => name !== "manifest.json" && name !== "manifest.sig" && name !== "feed/" && !validFeedPath(name))) {
      return rejected("AIB_OFFLINE_PACKAGE_UNEXPECTED_MEMBER");
    }
    if (names.filter(name => name.endsWith(".deb")).length > MAX_PACKAGE_COUNT) return rejected("AIB_OFFLINE_PACKAGE_COUNT_LIMIT");
    const metadata = new Map(listing.entries.map(entry => [entry.name, entry]));
    const manifestEntry = metadata.get("manifest.json");
    const signatureEntry = metadata.get("manifest.sig");
    if (!manifestEntry || manifestEntry.uncompressedBytes < 1 || manifestEntry.uncompressedBytes > MAX_MANIFEST_BYTES ||
        !signatureEntry || signatureEntry.uncompressedBytes !== MAX_SIGNATURE_BYTES || (signatureEntry.compression !== 0 && signatureEntry.compression !== 8)) {
      return rejected("AIB_OFFLINE_PACKAGE_METADATA_SIZE_INVALID");
    }
    report(90, "checking");
    const extracted = await extractSelectedZipEntries(
      monitored,
      "zip",
      name => name === "manifest.json" || name === "manifest.sig",
      { maxEntries: 2, maxEntryBytes: MAX_MANIFEST_BYTES, maxTotalBytes: MAX_MANIFEST_BYTES + MAX_SIGNATURE_BYTES },
    );
    checkCancelled(signal);
    if (!extracted.ok) return rejected("AIB_OFFLINE_PACKAGE_METADATA_INVALID");
    const rawManifest = extracted.entries.get("manifest.json");
    const signature = extracted.entries.get("manifest.sig");
    if (!rawManifest || !signature || signature.byteLength !== MAX_SIGNATURE_BYTES) return rejected("AIB_OFFLINE_PACKAGE_SIGNATURE_FORMAT_INVALID");

    // Authenticate exact bytes before decoding JSON or using any manifest field as trusted input.
    if (!isOfflinePackageSignatureVerifierAvailable()) {
      report(100, "done");
      return blocked("AIB_OFFLINE_PACKAGE_KARAT_VERIFIER_UNAVAILABLE");
    }
    const signatureValid = await verifyOfflinePackageManifestSignature(rawManifest, signature);
    checkCancelled(signal);
    if (!signatureValid) return rejected("AIB_OFFLINE_PACKAGE_SIGNATURE_INVALID");

    let parsed: unknown;
    try {
      const manifestText = strFromU8(rawManifest);
      const roundTrip = strToU8(manifestText);
      if (roundTrip.length !== rawManifest.length || roundTrip.some((byte, index) => byte !== rawManifest[index])) return rejected("AIB_OFFLINE_PACKAGE_MANIFEST_INVALID");
      parsed = JSON.parse(manifestText);
    } catch { return rejected("AIB_OFFLINE_PACKAGE_MANIFEST_INVALID"); }
    const validation = validateManifest(parsed);
    if (!validation.manifest) return rejected(validation.code || "AIB_OFFLINE_PACKAGE_MANIFEST_INVALID");
    const manifest = validation.manifest;
    const expectedNames = ["manifest.json", "manifest.sig", ...manifest.files.map(item => item.path)];
    if (names.includes("feed/")) expectedNames.push("feed/");
    expectedNames.sort();
    const actualNames = [...names].sort();
    if (actualNames.length !== expectedNames.length || actualNames.some((name, index) => name !== expectedNames[index])) {
      return rejected("AIB_OFFLINE_PACKAGE_MEMBERS_DO_NOT_MATCH_MANIFEST");
    }
    for (const item of manifest.files) {
      const entry = metadata.get(item.path);
      if (!entry || entry.uncompressedBytes !== item.sizeBytes || entry.uncompressedBytes > MAX_FEED_FILE_BYTES ||
          (entry.compression !== 0 && entry.compression !== 8)) return rejected("AIB_OFFLINE_PACKAGE_SIZE_MISMATCH");
    }
    const declaredPackageBytes = manifest.packages.reduce((sum, item) => sum + item.sizeBytes, 0);
    report(100, "done");
    // Deliberately fail closed: JS currently cannot stream ZIP members into private native staging,
    // hash all files, inspect .deb control data, solve closure, or run a local-only APT simulation.
    return blocked("AIB_OFFLINE_PACKAGE_NATIVE_PREFLIGHT_UNAVAILABLE", manifest.packages.length, declaredPackageBytes);
  } catch (error) {
    if (error instanceof BundleCancelled || cancelled(signal)) return { status: "cancelled", code: "AIB_OFFLINE_PACKAGE_CANCELLED" };
    return rejected("AIB_OFFLINE_PACKAGE_READ_FAILED");
  }
}

export async function inspectOfflinePackageBundle(uri: string, options: OfflineBundleOptions = {}): Promise<OfflineBundleInspection> {
  try {
    const file = new File(uri);
    const size = file.size;
    if (!Number.isSafeInteger(size) || size < 22 || size > MAX_ARCHIVE_BYTES) return rejected("AIB_OFFLINE_PACKAGE_ARCHIVE_SIZE_INVALID");
    const source: ZipByteSource = {
      size,
      async read(start, end) {
        checkCancelled(options.signal);
        if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > size) throw new Error("AIB_OFFLINE_PACKAGE_RANGE_INVALID");
        return new Uint8Array(await file.slice(start, end).arrayBuffer());
      },
    };
    return inspectOfflinePackageBundleSource(source, options);
  } catch (error) {
    if (error instanceof BundleCancelled || cancelled(options.signal)) return { status: "cancelled", code: "AIB_OFFLINE_PACKAGE_CANCELLED" };
    return rejected("AIB_OFFLINE_PACKAGE_READ_FAILED");
  }
}


/** Authenticates, validates and extracts a feed into an app-private JS-owned cache directory. */
export async function prepareOfflinePackageBundleStage(
  uri: string,
  stageId: string,
  signal?: AbortSignal,
  onProgress?: (progress: OfflinePackageStageProgress) => void,
): Promise<PreparedOfflinePackageBundleStage> {
  let stageDirectory: Directory | null = null;
  let stageCreated = false;
  let stageReady = false;
  const report = (phase: OfflinePackageStageProgress["phase"], percent: number) => {
    try { onProgress?.({ phase, percent: Math.max(0, Math.min(98, Math.floor(percent))) }); } catch { /* isolate UI listeners */ }
  };
  try {
    checkCancelled(signal);
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(stageId)) return rejected("AIB_OFFLINE_PACKAGE_STAGE_ID_INVALID");
    const sourceFile = new File(uri);
    const size = sourceFile.size;
    if (!Number.isSafeInteger(size) || size < 22 || size > MAX_ARCHIVE_BYTES) return rejected("AIB_OFFLINE_PACKAGE_ARCHIVE_SIZE_INVALID");
    const source: ZipByteSource = {
      size,
      async read(start, end) {
        checkCancelled(signal);
        if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > size) throw new Error("AIB_OFFLINE_PACKAGE_RANGE_INVALID");
        const result = new Uint8Array(await sourceFile.slice(start, end).arrayBuffer());
        checkCancelled(signal);
        return result;
      },
    };
    const prefix = await source.read(0, Math.min(4, size));
    if (!hasZipStartSignature(prefix)) return rejected("AIB_OFFLINE_PACKAGE_NOT_ZIP");
    report("reading", 1);
    const listing = await listZipEntryNames(source, "zip", MAX_ARCHIVE_MEMBERS);
    checkCancelled(signal);
    if (!listing.inspection.safe || listing.error) return rejected("AIB_OFFLINE_PACKAGE_ARCHIVE_STRUCTURE_INVALID");
    const names = listing.names;
    if (names.length < 3 || !names.includes("manifest.json") || !names.includes("manifest.sig")) return rejected("AIB_OFFLINE_PACKAGE_METADATA_MISSING");
    if (names.some(name => name !== "manifest.json" && name !== "manifest.sig" && name !== "feed/" && !validFeedPath(name))) {
      return rejected("AIB_OFFLINE_PACKAGE_UNEXPECTED_MEMBER");
    }
    if (names.filter(name => name.endsWith(".deb")).length > MAX_PACKAGE_COUNT) return rejected("AIB_OFFLINE_PACKAGE_COUNT_LIMIT");
    const metadata = new Map(listing.entries.map(entry => [entry.name, entry]));
    const manifestEntry = metadata.get("manifest.json");
    const signatureEntry = metadata.get("manifest.sig");
    if (!manifestEntry || manifestEntry.uncompressedBytes < 1 || manifestEntry.uncompressedBytes > MAX_MANIFEST_BYTES ||
      !signatureEntry || signatureEntry.uncompressedBytes !== MAX_SIGNATURE_BYTES || (signatureEntry.compression !== 0 && signatureEntry.compression !== 8)) {
      return rejected("AIB_OFFLINE_PACKAGE_METADATA_SIZE_INVALID");
    }
    report("checking", 10);
    const extractedMetadata = await extractSelectedZipEntries(source, "zip", name => name === "manifest.json" || name === "manifest.sig",
      { maxEntries: 2, maxEntryBytes: MAX_MANIFEST_BYTES, maxTotalBytes: MAX_MANIFEST_BYTES + MAX_SIGNATURE_BYTES });
    checkCancelled(signal);
    if (!extractedMetadata.ok) return rejected("AIB_OFFLINE_PACKAGE_METADATA_INVALID");
    const rawManifest = extractedMetadata.entries.get("manifest.json");
    const signature = extractedMetadata.entries.get("manifest.sig");
    if (!rawManifest || !signature || signature.byteLength !== MAX_SIGNATURE_BYTES) return rejected("AIB_OFFLINE_PACKAGE_SIGNATURE_FORMAT_INVALID");
    if (!isOfflinePackageSignatureVerifierAvailable()) return blocked("AIB_OFFLINE_PACKAGE_KARAT_VERIFIER_UNAVAILABLE");
    const signatureValid = await verifyOfflinePackageManifestSignature(rawManifest, signature);
    checkCancelled(signal);
    if (!signatureValid) return rejected("AIB_OFFLINE_PACKAGE_SIGNATURE_INVALID");
    let parsed: unknown;
    try {
      const text = strFromU8(rawManifest);
      const roundTrip = strToU8(text);
      if (roundTrip.length !== rawManifest.length || roundTrip.some((byte, index) => byte !== rawManifest[index])) return rejected("AIB_OFFLINE_PACKAGE_MANIFEST_INVALID");
      parsed = JSON.parse(text);
    } catch { return rejected("AIB_OFFLINE_PACKAGE_MANIFEST_INVALID"); }
    const validation = validateManifest(parsed);
    if (!validation.manifest) return rejected(validation.code || "AIB_OFFLINE_PACKAGE_MANIFEST_INVALID");
    const manifest = validation.manifest;
    const expectedNames = ["manifest.json", "manifest.sig", ...manifest.files.map(item => item.path)];
    if (names.includes("feed/")) expectedNames.push("feed/");
    expectedNames.sort();
    const actualNames = [...names].sort();
    if (actualNames.length !== expectedNames.length || actualNames.some((name, index) => name !== expectedNames[index])) {
      return rejected("AIB_OFFLINE_PACKAGE_MEMBERS_DO_NOT_MATCH_MANIFEST");
    }
    for (const item of manifest.files) {
      checkCancelled(signal);
      const entry = metadata.get(item.path);
      if (!entry || entry.uncompressedBytes !== item.sizeBytes || entry.uncompressedBytes > MAX_FEED_FILE_BYTES ||
        (entry.compression !== 0 && entry.compression !== 8)) return rejected("AIB_OFFLINE_PACKAGE_SIZE_MISMATCH");
    }

    checkCancelled(signal);
    stageDirectory = new Directory(Paths.cache, `offline-bundle-${stageId}`);
    if (stageDirectory.exists) return blocked("AIB_OFFLINE_PACKAGE_STAGE_COLLISION");
    stageDirectory.create({ intermediates: false, idempotent: false });
    stageCreated = true;
    checkCancelled(signal);

    const writeFile = (path: string, bytes: Uint8Array): File => {
      checkCancelled(signal);
      let directory = stageDirectory!;
      const segments = path.split("/");
      for (const segment of segments.slice(0, -1)) {
        checkCancelled(signal);
        directory = directory.createDirectory(segment);
      }
      const file = new File(directory, segments[segments.length - 1]);
      file.create();
      file.write(bytes);
      checkCancelled(signal);
      return file;
    };
    writeFile("manifest.json", rawManifest);
    writeFile("manifest.sig", signature);
    const nativeHash = async (file: File): Promise<string> => {
      checkCancelled(signal);
      if (file.size < 0) throw new Error("AIB_OFFLINE_PACKAGE_STAGE_WRITE_FAILED");
      const hash = await getOfflineBundleFileSha256(file.uri);
      checkCancelled(signal);
      return hash;
    };
    const filesCompleted = 0;
    for (let index = 0; index < manifest.files.length; index++) {
      checkCancelled(signal);
      const item = manifest.files[index];
      const extracted = await extractSelectedZipEntries(source, "zip", name => name === item.path,
        { maxEntries: 1, maxEntryBytes: MAX_FEED_FILE_BYTES, maxTotalBytes: MAX_FEED_FILE_BYTES });
      checkCancelled(signal);
      if (!extracted.ok) return rejected("AIB_OFFLINE_PACKAGE_EXTRACTION_FAILED");
      const bytes = extracted.entries.get(item.path);
      if (!bytes || bytes.byteLength !== item.sizeBytes) return rejected("AIB_OFFLINE_PACKAGE_SIZE_MISMATCH");
      if (item.path === "feed/dists/stable/main/binary-aarch64/Packages" && !validatePackagesIndex(bytes, manifest)) {
        return rejected("AIB_OFFLINE_PACKAGE_CATALOG_INDEX_MISMATCH");
      }
      const file = writeFile(item.path, bytes);
      if (!file.exists || file.size !== item.sizeBytes) return rejected("AIB_OFFLINE_PACKAGE_STAGE_WRITE_FAILED");
      const actualHash = await nativeHash(file);
      if (typeof actualHash !== "string" || !/^[a-f0-9]{64}$/i.test(actualHash) || actualHash.toLowerCase() !== item.sha256.toLowerCase()) {
        return rejected("AIB_OFFLINE_PACKAGE_HASH_MISMATCH");
      }
      report("extracting", 20 + ((index + 1) / manifest.files.length) * 76);
      checkCancelled(signal);
    }
    checkCancelled(signal);
    const packages = manifest.packages.map(item => ({ name: item.name, version: item.version, architecture: item.architecture, sizeBytes: item.sizeBytes }));
    const totalBytes = manifest.packages.reduce((sum, item) => sum + item.sizeBytes, 0);
    report("checking", 98);
    stageReady = true;
    return { status: "ready", code: "AIB_OFFLINE_PACKAGE_STAGE_PREPARED", stageDirectoryUri: stageDirectory.uri,
      packageCount: packages.length, totalBytes, packages };
  } catch (error) {
    if (error instanceof BundleCancelled || cancelled(signal)) return { status: "cancelled", code: "AIB_OFFLINE_PACKAGE_CANCELLED" };
    return rejected("AIB_OFFLINE_PACKAGE_STAGE_PREPARATION_FAILED");
  } finally {
    if (stageCreated && stageDirectory && !stageReady) {
      try { if (stageDirectory.exists) stageDirectory.delete(); } catch { /* best-effort private-stage cleanup */ }
    }
  }
}
