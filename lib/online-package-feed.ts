import { Directory, File, Paths, type FileHandle } from "expo-file-system";
import { createDownloadResumable, type DownloadResumable } from "expo-file-system/legacy";
import { extractSelectedZipEntriesToSink, type ZipByteSource } from "./archive-utils";
import { buildGitHubReleaseAssetUrl, isAllowedGitHubReleaseAssetResponse } from "./github-release-asset-transport";
import { withOnlineFeedRequestDeadline, withOnlineFeedTransferDeadline } from "./online-feed-timeouts";
import {
  getOfflineBundleFileSha256,
  stagePreparedOnlinePackageDirectory,
  verifyOnlinePackageCatalog,
  cancelOfflinePackageBundle,
  type OfflinePackageBundlePackage,
  type OfflinePackageBundleStageResult,
} from "./termux-bridge";

/** No production release has been selected or published; stay blocked until an approved release is configured. */
export const ONLINE_PACKAGE_RELEASE_BASE_URL: string | null = null;
export const ONLINE_PACKAGE_CATALOG_ASSET = "online-catalog.json";
export const ONLINE_PACKAGE_SIGNATURE_ASSET = "online-catalog.sig";
export const ONLINE_PACKAGE_BUNDLE_ASSET = "online-feed-bundle.zip";

const MAX_MANIFEST_BYTES = 192 * 1024;
const MAX_SIGNATURE_BYTES = 256;
const MAX_FILE_BYTES = 100 * 1024 * 1024;
const MAX_PACKAGE_BYTES = 190 * 1024 * 1024;
const MAX_TOTAL_BYTES = 200 * 1024 * 1024;
const MAX_FEED_OPERATION_MS = 45 * 60 * 1000;
const REQUEST_ID = /^[A-Za-z0-9._-]{1,96}$/;
const STAGE_ID = /^[A-Za-z0-9_-]{16,128}$/;

export type OnlinePackageCatalogState = "candidate" | "production-qualified";

export type OnlinePackageCatalog = {
  format: "aibuilder-online-package-catalog";
  schemaVersion: 3;
  appId: "com.karat.aibuilder";
  architecture: "aarch64";
  catalogState: OnlinePackageCatalogState;
  catalogCommit: string;
  catalogSha256: string;
  dependencyClosureComplete: true;
  signatureAlgorithm: "SHA256withRSA";
  signerCertificateSha256: string;
  feedRoot: "feed";
  sequence: number;
  issuedAtMs: number;
  expiresAtMs: number;
  files: Array<{ path: string; sizeBytes: number; sha256: string }>;
  packages: Array<OfflinePackageBundlePackage & { filename: string; sha256: string; depends: string[] }>;
};

export type OnlineFeedProgress = (phase: string, percent: number) => void;
export type OnlinePackageFeedStageResult = OfflinePackageBundleStageResult & {
  catalog?: Pick<OnlinePackageCatalog, "catalogCommit" | "sequence" | "expiresAtMs">;
};
type FetchResponse = { ok: boolean; status: number; url?: string; headers?: { get(name: string): string | null }; arrayBuffer(): Promise<ArrayBuffer> };
type FetchLike = (url: string, init: { signal: AbortSignal; method?: "GET" | "HEAD" }) => Promise<FetchResponse>;
type ActiveRequest = { controller: AbortController; stageId: string | null };
const activeRequests = new Map<string, ActiveRequest>();
const activeDownloads = new Map<string, DownloadResumable>();
const activeNativeCancellations = new Map<string, Promise<boolean>>();

function cancelNativeStage(requestId: string): Promise<boolean> {
  const pending = activeNativeCancellations.get(requestId);
  if (pending) return pending;
  let cancellation!: Promise<boolean>;
  cancellation = cancelOfflinePackageBundle(requestId).catch(() => false).finally(() => {
    if (activeNativeCancellations.get(requestId) === cancellation) activeNativeCancellations.delete(requestId);
  });
  activeNativeCancellations.set(requestId, cancellation);
  return cancellation;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const want = [...expected].sort();
  return actual.length === want.length && actual.every((key, index) => key === want[index]);
}

function safeAssetName(path: string): string | null {
  const base = path.split("/").at(-1) ?? "";
  return /^[A-Za-z0-9._+@:-]{1,180}$/.test(base) && base !== "." && base !== ".." ? base : null;
}

export function parseOnlinePackageCatalog(value: unknown): OnlinePackageCatalog | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const doc = value as Record<string, unknown>;
  const topKeys = ["format", "schemaVersion", "appId", "architecture", "catalogState", "catalogCommit", "catalogSha256", "dependencyClosureComplete", "signatureAlgorithm", "signerCertificateSha256", "feedRoot", "sequence", "issuedAtMs", "expiresAtMs", "files", "packages"];
  if (!exactKeys(doc, topKeys) || doc.format !== "aibuilder-online-package-catalog" || doc.schemaVersion !== 3 ||
      doc.appId !== "com.karat.aibuilder" || doc.architecture !== "aarch64" ||
      (doc.catalogState !== "candidate" && doc.catalogState !== "production-qualified") ||
      doc.dependencyClosureComplete !== true || doc.signatureAlgorithm !== "SHA256withRSA" || doc.feedRoot !== "feed" ||
      typeof doc.catalogCommit !== "string" || !/^[a-f0-9]{40}$/i.test(doc.catalogCommit) ||
      typeof doc.catalogSha256 !== "string" || !/^[a-f0-9]{64}$/i.test(doc.catalogSha256) ||
      typeof doc.signerCertificateSha256 !== "string" || !/^[a-f0-9]{64}$/i.test(doc.signerCertificateSha256) ||
      !Number.isSafeInteger(doc.sequence) || (doc.sequence as number) < 1 ||
      !Number.isSafeInteger(doc.issuedAtMs) || !Number.isSafeInteger(doc.expiresAtMs) ||
      !Array.isArray(doc.files) || doc.files.length < 1 || doc.files.length > 256 ||
      !Array.isArray(doc.packages) || doc.packages.length < 1 || doc.packages.length > 256) return null;

  const files = new Map<string, { path: string; sizeBytes: number; sha256: string }>();
  const assetNames = new Set<string>();
  let totalBytes = 0;
  for (const entry of doc.files) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    const row = entry as Record<string, unknown>;
    if (!exactKeys(row, ["path", "sizeBytes", "sha256"]) || typeof row.path !== "string" ||
        !/^feed\/[A-Za-z0-9._+@:/-]{1,500}$/.test(row.path) || row.path.includes("//") ||
        row.path.split("/").some(part => part === "." || part === "..") || files.has(row.path) ||
        !Number.isSafeInteger(row.sizeBytes) || (row.sizeBytes as number) < 1 || (row.sizeBytes as number) > MAX_FILE_BYTES ||
        typeof row.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(row.sha256)) return null;
    const assetName = safeAssetName(row.path);
    if (!assetName || assetNames.has(assetName)) return null;
    assetNames.add(assetName);
    totalBytes += row.sizeBytes as number;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_TOTAL_BYTES) return null;
    files.set(row.path, { path: row.path, sizeBytes: row.sizeBytes as number, sha256: row.sha256.toLowerCase() });
  }
  if (assetNames.has(ONLINE_PACKAGE_BUNDLE_ASSET)) return null;
  const index = files.get("feed/dists/stable/main/binary-aarch64/Packages");
  if (!index || index.sha256 !== String(doc.catalogSha256).toLowerCase()) return null;

  const packageRows: OnlinePackageCatalog["packages"] = [];
  const identities = new Set<string>();
  const filenames = new Set<string>();
  let packageBytes = 0;
  for (const entry of doc.packages) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    const row = entry as Record<string, unknown>;
    if (!exactKeys(row, ["name", "version", "architecture", "filename", "sizeBytes", "sha256", "depends"]) ||
        typeof row.name !== "string" || !/^[a-z0-9][a-z0-9+.-]{0,127}$/.test(row.name) ||
        typeof row.version !== "string" || row.version.length < 1 || row.version.length > 128 || /[\u0000-\u001f\u007f]/.test(row.version) ||
        (row.architecture !== "aarch64" && row.architecture !== "all") || typeof row.filename !== "string" ||
        !/^feed\/[A-Za-z0-9._+@:/-]{1,500}\.deb$/.test(row.filename) || !Number.isSafeInteger(row.sizeBytes) ||
        (row.sizeBytes as number) < 1 || (row.sizeBytes as number) > MAX_FILE_BYTES || typeof row.sha256 !== "string" ||
        !/^[a-f0-9]{64}$/i.test(row.sha256) || !Array.isArray(row.depends) || row.depends.length > 64 ||
        row.depends.some(dep => typeof dep !== "string" || dep.length < 1 || dep.length > 512 || /[\r\n\u0000]/.test(dep))) return null;
    const identity = `${row.name}@${row.version}`;
    const file = files.get(row.filename);
    if (identities.has(identity) || filenames.has(row.filename) || !file || file.sizeBytes !== row.sizeBytes || file.sha256 !== row.sha256.toLowerCase()) return null;
    identities.add(identity);
    filenames.add(row.filename);
    packageBytes += row.sizeBytes as number;
    if (!Number.isSafeInteger(packageBytes) || packageBytes > MAX_PACKAGE_BYTES) return null;
    packageRows.push({ name: row.name, version: row.version, architecture: row.architecture, sizeBytes: row.sizeBytes as number,
      filename: row.filename, sha256: row.sha256.toLowerCase(), depends: [...row.depends] as string[] });
  }
  if (packageRows.length !== doc.packages.length) return null;
  return { ...doc, catalogCommit: doc.catalogCommit.toLowerCase(), catalogSha256: doc.catalogSha256.toLowerCase(),
    signerCertificateSha256: doc.signerCertificateSha256.toLowerCase(), files: [...files.values()], packages: packageRows } as OnlinePackageCatalog;
}

function stageId(): string {
  const bytes = new Uint8Array(18);
  try { globalThis.crypto?.getRandomValues(bytes); } catch { /* use fallback below */ }
  if (bytes.every(value => value === 0)) for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, value => value.toString(16).padStart(2, "0")).join("");
}

async function getBytes(url: string, signal: AbortSignal, maxBytes: number, fetcher: FetchLike): Promise<Uint8Array> {
  return withOnlineFeedRequestDeadline(async requestSignal => {
    const response = await fetcher(url, { signal: requestSignal });
    if (!isAllowedGitHubReleaseAssetResponse(url, response.url)) throw new Error("AIB_ONLINE_PACKAGE_REDIRECT_REJECTED");
    if (!response.ok || response.status !== 200) throw new Error(response.status === 404 ? "AIB_ONLINE_PACKAGE_FEED_NOT_PUBLISHED" : "AIB_ONLINE_PACKAGE_HTTP_FAILED");
    const declaredLength = response.headers?.get("content-length");
    if (!declaredLength || !/^(0|[1-9][0-9]*)$/.test(declaredLength)) throw new Error("AIB_ONLINE_PACKAGE_CONTENT_LENGTH_INVALID");
    const declaredBytes = Number(declaredLength);
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes < 1 || declaredBytes > maxBytes) throw new Error("AIB_ONLINE_PACKAGE_ASSET_SIZE_INVALID");
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (requestSignal.aborted) throw new Error("AIB_ONLINE_PACKAGE_CANCELLED");
    if (bytes.length !== declaredBytes || bytes.length < 1 || bytes.length > maxBytes) throw new Error("AIB_ONLINE_PACKAGE_ASSET_SIZE_MISMATCH");
    return bytes;
  }, signal);
}

async function getAssetLength(
  url: string,
  signal: AbortSignal,
  fetcher: FetchLike,
  maxBytes: number,
  expectedSize: number | null = null,
  missingAllowed = false,
): Promise<{ url: string; sizeBytes: number } | null> {
  const head = await withOnlineFeedRequestDeadline(requestSignal => fetcher(url, { signal: requestSignal, method: "HEAD" }), signal);
  if (!isAllowedGitHubReleaseAssetResponse(url, head.url)) throw new Error("AIB_ONLINE_PACKAGE_REDIRECT_REJECTED");
  if (head.status === 404 && missingAllowed) return null;
  if (!head.ok || head.status !== 200) throw new Error(head.status === 404 ? "AIB_ONLINE_PACKAGE_ASSET_MISSING" : "AIB_ONLINE_PACKAGE_HTTP_FAILED");
  const declaredLength = head.headers?.get("content-length");
  if (!declaredLength || !/^(0|[1-9][0-9]*)$/.test(declaredLength)) throw new Error("AIB_ONLINE_PACKAGE_CONTENT_LENGTH_INVALID");
  const declaredBytes = Number(declaredLength);
  if (!Number.isSafeInteger(declaredBytes) || declaredBytes < 1 || declaredBytes > maxBytes ||
      (expectedSize !== null && declaredBytes !== expectedSize)) throw new Error("AIB_ONLINE_PACKAGE_ASSET_SIZE_MISMATCH");
  return { url: head.url!, sizeBytes: declaredBytes };
}

export async function downloadPackageAsset(
  url: string,
  destination: File,
  expectedSize: number,
  expectedSha256: string | null,
  maxBytes: number,
  requestId: string,
  signal: AbortSignal,
  fetcher: FetchLike,
  onProgress: (writtenBytes: number) => void,
  prevalidatedAsset: { url: string; sizeBytes: number } | null = null,
): Promise<void> {
  if (signal.aborted) throw new Error("AIB_ONLINE_PACKAGE_CANCELLED");
  const asset = prevalidatedAsset ?? await getAssetLength(url, signal, fetcher, maxBytes, expectedSize);
  if (!asset) throw new Error("AIB_ONLINE_PACKAGE_ASSET_SIZE_MISMATCH");
  if (!isAllowedGitHubReleaseAssetResponse(url, asset.url)) throw new Error("AIB_ONLINE_PACKAGE_REDIRECT_REJECTED");
  if (asset.sizeBytes !== expectedSize) throw new Error("AIB_ONLINE_PACKAGE_ASSET_SIZE_MISMATCH");

  let downloader: DownloadResumable | null = null;
  let cancelled = false;
  let transferActivity: (() => void) | null = null;
  let lastWritten = 0;
  const cancel = () => {
    if (cancelled) return;
    cancelled = true;
    void downloader?.cancelAsync().catch(() => undefined);
  };
  downloader = createDownloadResumable(asset.url, destination.uri, {}, progress => {
    if (progress.totalBytesWritten > maxBytes || progress.totalBytesExpectedToWrite > maxBytes) cancel();
    const written = Math.max(0, Math.min(expectedSize, progress.totalBytesWritten));
    if (written > lastWritten) { lastWritten = written; transferActivity?.(); }
    onProgress(written);
  });
  activeDownloads.set(requestId, downloader);
  try {
    const result = await withOnlineFeedTransferDeadline(
      onActivity => { transferActivity = onActivity; return downloader!.downloadAsync(); }, signal, cancel,
    );
    if (signal.aborted || cancelled || !result) throw new Error("AIB_ONLINE_PACKAGE_CANCELLED");
    if (result.status !== 200 || result.uri !== destination.uri || destination.size !== expectedSize) {
      throw new Error("AIB_ONLINE_PACKAGE_ASSET_SIZE_MISMATCH");
    }
    if (expectedSha256) {
      const actualHash = await withOnlineFeedRequestDeadline(() => getOfflineBundleFileSha256(destination.uri), signal, 120_000);
      if (actualHash.toLowerCase() !== expectedSha256) throw new Error("AIB_ONLINE_PACKAGE_ASSET_HASH_MISMATCH");
    }
  } catch (error) {
    try { if (destination.exists) destination.delete(); } catch { /* best-effort private-cache cleanup */ }
    throw error;
  } finally {
    if (activeDownloads.get(requestId) === downloader) activeDownloads.delete(requestId);
  }
}

function writeBytes(file: File, bytes: Uint8Array): void {
  file.create({ overwrite: true, intermediates: true });
  file.write(bytes);
}

async function extractGitHubFeedArchive(
  archive: File,
  feedRoot: Directory,
  catalog: OnlinePackageCatalog,
  signal: AbortSignal,
  onProgress: OnlineFeedProgress,
): Promise<void> {
  if (!Number.isSafeInteger(archive.size) || archive.size < 22 || archive.size > MAX_TOTAL_BYTES) {
    throw new Error("AIB_ONLINE_PACKAGE_ARCHIVE_SIZE_INVALID");
  }
  const expected = new Map(catalog.files.map(row => [row.path, row]));
  const targets = new Map<string, File>();
  const writers = new Map<string, FileHandle>();
  const archiveHandle = archive.open();
  const source: ZipByteSource = {
    size: archive.size,
    async read(start, end) {
      if (signal.aborted) throw new Error("AIB_ONLINE_PACKAGE_CANCELLED");
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > archive.size) {
        throw new Error("AIB_ONLINE_PACKAGE_ARCHIVE_RANGE_INVALID");
      }
      archiveHandle.offset = start;
      const bytes = archiveHandle.readBytes(end - start);
      if (bytes.length !== end - start) throw new Error("AIB_ONLINE_PACKAGE_ARCHIVE_TRUNCATED");
      return bytes;
    },
  };
  let extraction: Awaited<ReturnType<typeof extractSelectedZipEntriesToSink>>;
  try {
    extraction = await extractSelectedZipEntriesToSink(
      source,
      "zip",
      () => true,
      { maxEntries: catalog.files.length, maxEntryBytes: MAX_FILE_BYTES, maxTotalBytes: MAX_TOTAL_BYTES },
      {
        begin(name) {
          if (signal.aborted) throw new Error("AIB_ONLINE_PACKAGE_CANCELLED");
          const row = expected.get(name);
          if (!row || !name.startsWith("feed/")) throw new Error("AIB_ONLINE_PACKAGE_ARCHIVE_INVENTORY_MISMATCH");
          const parts = name.slice("feed/".length).split("/");
          if (parts.some(part => !part || part === "." || part === "..")) throw new Error("AIB_ONLINE_PACKAGE_ARCHIVE_PATH_INVALID");
          let parent = feedRoot;
          for (const part of parts.slice(0, -1)) {
            parent = new Directory(parent, part);
            if (!parent.exists) parent.create({ intermediates: true });
          }
          const destination = new File(parent, parts[parts.length - 1]);
          destination.create({ overwrite: true, intermediates: true });
          targets.set(name, destination);
          writers.set(name, destination.open());
        },
        write(name, bytes) {
          const writer = writers.get(name);
          if (!writer) throw new Error("AIB_ONLINE_PACKAGE_ARCHIVE_WRITER_MISSING");
          writer.writeBytes(bytes);
        },
        finish(name, sizeBytes) {
          const writer = writers.get(name);
          if (!writer) throw new Error("AIB_ONLINE_PACKAGE_ARCHIVE_WRITER_MISSING");
          writer.close();
          writers.delete(name);
          if (targets.get(name)?.size !== sizeBytes) throw new Error("AIB_ONLINE_PACKAGE_ARCHIVE_SIZE_MISMATCH");
        },
      },
    );
  } finally {
    for (const writer of writers.values()) { try { writer.close(); } catch { /* best-effort close before stage cleanup */ } }
    try { archiveHandle.close(); } catch { /* best-effort close before cleanup */ }
  }
  const extractedNames = extraction.names ?? [];
  if (!extraction.ok || extractedNames.length !== expected.size || extractedNames.some(name => !expected.has(name))) {
    throw new Error("AIB_ONLINE_PACKAGE_ARCHIVE_INVALID");
  }
  for (let index = 0; index < catalog.files.length; index++) {
    if (signal.aborted) throw new Error("AIB_ONLINE_PACKAGE_CANCELLED");
    const row = catalog.files[index];
    const destination = targets.get(row.path);
    if (!destination || destination.size !== row.sizeBytes) throw new Error("AIB_ONLINE_PACKAGE_ASSET_SIZE_MISMATCH");
    const actualHash = await withOnlineFeedRequestDeadline(() => getOfflineBundleFileSha256(destination.uri), signal, 120_000);
    if (actualHash.toLowerCase() !== row.sha256) throw new Error("AIB_ONLINE_PACKAGE_ASSET_HASH_MISMATCH");
    onProgress("downloading", 8 + Math.floor((index + 1) / catalog.files.length * 78));
  }
}

function removeStage(id: string): void {
  try {
    const root = new Directory(Paths.cache, `offline-bundle-${id}`);
    if (root.exists) root.delete();
  } catch { /* best-effort private-cache cleanup */ }
}

export async function fetchAndStageOnlinePackageCatalog(
  requestId: string,
  onProgress: OnlineFeedProgress = () => undefined,
  fetcher: FetchLike = (url, init) => fetch(url, { signal: init.signal, method: init.method }) as unknown as Promise<FetchResponse>,
  releaseBaseUrl: string | null = ONLINE_PACKAGE_RELEASE_BASE_URL,
): Promise<OnlinePackageFeedStageResult> {
  if (!REQUEST_ID.test(requestId)) return { status: "rejected", code: "AIB_OFFLINE_BUNDLE_REQUEST_ID_INVALID" };
  if (releaseBaseUrl === null) return { status: "blocked", code: "AIB_ONLINE_PACKAGE_RELEASE_NOT_CONFIGURED" };
  let catalogUrl: string;
  let signatureUrl: string;
  let bundleUrl: string;
  try {
    catalogUrl = buildGitHubReleaseAssetUrl(releaseBaseUrl, ONLINE_PACKAGE_CATALOG_ASSET);
    signatureUrl = buildGitHubReleaseAssetUrl(releaseBaseUrl, ONLINE_PACKAGE_SIGNATURE_ASSET);
    bundleUrl = buildGitHubReleaseAssetUrl(releaseBaseUrl, ONLINE_PACKAGE_BUNDLE_ASSET);
  } catch {
    return { status: "blocked", code: "AIB_ONLINE_PACKAGE_RELEASE_CONFIG_INVALID" };
  }
  const controller = new AbortController();
  const id = stageId();
  const prior = activeRequests.get(requestId);
  if (prior) prior.controller.abort();
  activeRequests.set(requestId, { controller, stageId: id });
  let operationTimedOut = false;
  const operationTimer = setTimeout(() => { operationTimedOut = true; controller.abort(); }, MAX_FEED_OPERATION_MS);
  let root: Directory | null = null;
  let nativeStageCancellation: Promise<boolean> | null = null;
  let nativeStageOperation: Promise<OfflinePackageBundleStageResult> | null = null;
  let nativeCancelUnconfirmed = false;
  try {
    onProgress("catalog", 2);
    const rawManifest = await getBytes(catalogUrl, controller.signal, MAX_MANIFEST_BYTES, fetcher);
    const signature = await getBytes(signatureUrl, controller.signal, MAX_SIGNATURE_BYTES, fetcher);
    if (signature.length !== MAX_SIGNATURE_BYTES || !await verifyOnlinePackageCatalog(rawManifest, signature)) {
      return { status: "rejected", code: "AIB_ONLINE_PACKAGE_CATALOG_SIGNATURE_OR_FRESHNESS_INVALID" };
    }
    let parsed: unknown;
    try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(rawManifest)); }
    catch { return { status: "rejected", code: "AIB_ONLINE_PACKAGE_CATALOG_JSON_INVALID" }; }
    const catalog = parseOnlinePackageCatalog(parsed);
    if (!catalog) return { status: "rejected", code: "AIB_ONLINE_PACKAGE_CATALOG_SCHEMA_INVALID" };
    if (controller.signal.aborted) throw new Error("AIB_ONLINE_PACKAGE_CANCELLED");
    if (catalog.catalogState !== "production-qualified") {
      return { status: "blocked", code: "AIB_ONLINE_PACKAGE_CATALOG_NOT_PRODUCTION_QUALIFIED" };
    }

    root = new Directory(Paths.cache, `offline-bundle-${id}`);
    if (root.exists) root.delete();
    root.create({ intermediates: true });
    writeBytes(new File(root, "manifest.json"), rawManifest);
    writeBytes(new File(root, "manifest.sig"), signature);
    let feedRoot = new Directory(root, "feed");
    feedRoot.create({ intermediates: true });
    const totalBytes = catalog.files.reduce((sum, file) => sum + file.sizeBytes, 0);
    const bundleAsset = await getAssetLength(bundleUrl, controller.signal, fetcher, MAX_TOTAL_BYTES, null, true);
    if (bundleAsset !== null) {
      const bundle = new File(root, ONLINE_PACKAGE_BUNDLE_ASSET);
      // The archive container itself is not trusted; every extracted file is checked against the Karat-signed catalog.
      await downloadPackageAsset(bundleUrl, bundle, bundleAsset.sizeBytes, null, MAX_TOTAL_BYTES, requestId, controller.signal, fetcher,
        writtenBytes => onProgress("downloading", 8 + Math.floor(writtenBytes / Math.max(bundleAsset.sizeBytes, 1) * 78)), bundleAsset);
      try {
        await extractGitHubFeedArchive(bundle, feedRoot, catalog, controller.signal, onProgress);
      } finally {
        try { if (bundle.exists) bundle.delete(); } catch { /* stage cleanup remains fail-closed */ }
      }
    } else {
      let completedBytes = 0;
      for (let index = 0; index < catalog.files.length; index++) {
        if (controller.signal.aborted) throw new Error("AIB_ONLINE_PACKAGE_CANCELLED");
        const row = catalog.files[index];
        const relative = row.path.slice("feed/".length).split("/");
        let parent = feedRoot;
        for (const part of relative.slice(0, -1)) {
          parent = new Directory(parent, part);
          if (!parent.exists) parent.create({ intermediates: true });
        }
        const asset = safeAssetName(row.path);
        if (!asset) throw new Error("AIB_ONLINE_PACKAGE_ASSET_PATH_INVALID");
        const url = buildGitHubReleaseAssetUrl(releaseBaseUrl, asset);
        const destination = new File(parent, relative[relative.length - 1]);
        if (row.sizeBytes > MAX_FILE_BYTES) throw new Error("AIB_ONLINE_PACKAGE_ASSET_SIZE_INVALID");
        await downloadPackageAsset(url, destination, row.sizeBytes, row.sha256, MAX_FILE_BYTES, requestId, controller.signal, fetcher,
          writtenBytes => onProgress("downloading", 8 + Math.floor((completedBytes + writtenBytes) / Math.max(totalBytes, 1) * 78)));
        completedBytes += row.sizeBytes;
        onProgress("downloading", 8 + Math.floor(completedBytes / Math.max(totalBytes, 1) * 78));
      }
    }
    if (controller.signal.aborted) throw new Error("AIB_ONLINE_PACKAGE_CANCELLED");
    onProgress("native_stage", 90);
    const packageRows = catalog.packages.map(pkg => ({ name: pkg.name, version: pkg.version, architecture: pkg.architecture, sizeBytes: pkg.sizeBytes }));
    const staged = await withOnlineFeedRequestDeadline(stageSignal => {
      stageSignal.addEventListener("abort", () => { nativeStageCancellation = cancelNativeStage(requestId); }, { once: true });
      nativeStageOperation = stagePreparedOnlinePackageDirectory(root!.uri, id, packageRows, totalBytes, requestId);
      return nativeStageOperation;
    }, controller.signal, 180_000);
    if (staged.status !== "ready") {
      removeStage(id);
      return { ...staged, catalog: { catalogCommit: catalog.catalogCommit, sequence: catalog.sequence, expiresAtMs: catalog.expiresAtMs } };
    }
    onProgress("ready", 100);
    return { ...staged, catalog: { catalogCommit: catalog.catalogCommit, sequence: catalog.sequence, expiresAtMs: catalog.expiresAtMs } };
  } catch (error) {
    if (nativeStageCancellation) {
      let acknowledged = await withOnlineFeedRequestDeadline(
        () => nativeStageCancellation!, new AbortController().signal, 5_000,
      ).catch(() => false);
      if (acknowledged && nativeStageOperation) {
        acknowledged = await withOnlineFeedRequestDeadline(
          () => nativeStageOperation!.then(() => true, () => true), new AbortController().signal, 5_000,
        ).catch(() => false);
      }
      nativeCancelUnconfirmed = !acknowledged;
    }
    if (!nativeCancelUnconfirmed) removeStage(id);
    const rawCode = error instanceof Error ? error.message : "";
    const code = operationTimedOut ? "AIB_ONLINE_PACKAGE_TOTAL_DEADLINE" : nativeCancelUnconfirmed ? "AIB_ONLINE_PACKAGE_NATIVE_CANCEL_UNCONFIRMED" : rawCode === "AIB_ONLINE_PACKAGE_REQUEST_TIMEOUT" ? rawCode : controller.signal.aborted ? "AIB_ONLINE_PACKAGE_CANCELLED" : /^[A-Z0-9_]{1,80}$/.test(rawCode) ? rawCode : "AIB_ONLINE_PACKAGE_FETCH_FAILED";
    return { status: operationTimedOut || controller.signal.aborted || nativeCancelUnconfirmed || code === "AIB_ONLINE_PACKAGE_CANCELLED" ? "blocked" : "rejected", code };
  } finally {
    clearTimeout(operationTimer);
    if (activeRequests.get(requestId)?.controller === controller) activeRequests.delete(requestId);
  }
}

export async function cancelOnlinePackageCatalog(requestId: string): Promise<void> {
  if (!REQUEST_ID.test(requestId)) return;
  const active = activeRequests.get(requestId);
  if (active) active.controller.abort();
  const downloader = activeDownloads.get(requestId);
  if (downloader) await downloader.cancelAsync().catch(() => undefined);
  await cancelNativeStage(requestId);
}
