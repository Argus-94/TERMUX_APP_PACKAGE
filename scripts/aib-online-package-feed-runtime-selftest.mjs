#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import Module from "node:module";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { zipSync } from "fflate";
import { typescript } from "./test-helpers/load-typescript.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cache = new Map();
function resolveTs(parent, request) {
  const base = path.resolve(path.dirname(parent), request);
  for (const candidate of [base, `${base}.ts`, path.join(base, "index.ts")]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}
function loadTs(file, mocks = new Map()) {
  file = path.resolve(file);
  if (cache.has(file)) return cache.get(file).exports;
  const mod = new Module(file);
  mod.filename = file;
  mod.paths = Module._nodeModulePaths(path.dirname(file));
  cache.set(file, mod);
  mod.require = request => {
    if (mocks.has(request)) return mocks.get(request);
    if (request.startsWith(".")) {
      const resolved = resolveTs(file, request);
      if (resolved) return loadTs(resolved);
    }
    return createRequire(file)(request);
  };
  const js = typescript.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: file,
  }).outputText;
  mod._compile(js, file);
  return mod.exports;
}

async function main() {
  const { withOnlineFeedRequestDeadline, withOnlineFeedTransferDeadline } = loadTs(path.join(root, "lib/online-feed-timeouts.ts"));
  const feedSource = fs.readFileSync(path.join(root, "lib/online-package-feed.ts"), "utf8");
  assert.match(feedSource, /withOnlineFeedRequestDeadline\(/, "catalog and HEAD requests must use a bounded deadline");
  assert.match(feedSource, /withOnlineFeedTransferDeadline\(/, "native package transfers must use idle and total deadlines");
  assert.match(feedSource, /extractSelectedZipEntriesToSink\(/, "single-archive delivery must use bounded streaming extraction");
  assert.match(feedSource, /ONLINE_PACKAGE_BUNDLE_ASSET/, "single-archive GitHub Release asset must be supported");

  const { byteArrayZipSource, extractSelectedZipEntriesToSink } = loadTs(path.join(root, "lib/archive-utils.ts"));
  const archiveBytes = zipSync({
    "feed/dists/stable/main/binary-aarch64/Packages": new TextEncoder().encode("Package: zlib\nVersion: 1.0\nArchitecture: aarch64\n\n"),
    "feed/pool/main/z/zlib.deb": new Uint8Array([0, 1, 2, 3, 4, 5, 6]),
  });
  const extracted = new Map();
  const sink = {
    begin(name) { extracted.set(name, []); },
    write(name, bytes) { extracted.get(name).push(bytes.slice()); },
    finish(name, sizeBytes) { extracted.set(name, { chunks: extracted.get(name), sizeBytes }); },
  };
  const zipResult = await extractSelectedZipEntriesToSink(byteArrayZipSource(archiveBytes), "zip", () => true,
    { maxEntries: 2, maxEntryBytes: 1024, maxTotalBytes: 2048 }, sink);
  assert.equal(zipResult.ok, true, "single archive streams through the bounded ZIP parser");
  assert.equal(zipResult.names.length, 2, "only the exact archive entries are exposed");
  assert.equal(extracted.get("feed/pool/main/z/zlib.deb").sizeBytes, 7, "streamed entry size is checked");

  const malformed = archiveBytes.slice();
  malformed[0] = 0;
  const rejectedZip = await extractSelectedZipEntriesToSink(byteArrayZipSource(malformed), "zip", () => true,
    { maxEntries: 2, maxEntryBytes: 1024, maxTotalBytes: 2048 }, {
      begin() { assert.fail("invalid local ZIP headers must be rejected before writing"); }, write() {}, finish() {},
    });
  assert.equal(rejectedZip.ok, false, "mismatched local ZIP header is rejected");
  const traversalZip = zipSync({ "../outside.deb": new Uint8Array([1]) });
  const rejectedTraversal = await extractSelectedZipEntriesToSink(byteArrayZipSource(traversalZip), "zip", () => true,
    { maxEntries: 2, maxEntryBytes: 1024, maxTotalBytes: 2048 }, { begin() {}, write() {}, finish() {} });
  assert.equal(rejectedTraversal.ok, false, "archive traversal is rejected");

  const { buildGitHubReleaseAssetUrl, isAllowedGitHubReleaseAssetResponse } = loadTs(path.join(root, "lib/github-release-asset-transport.ts"));
  const releaseBase = "https://github.com/Argus-94/TERMUX_APP_PACKAGE/releases/download/test-aib-feed-1/";
  const directBundleUrl = buildGitHubReleaseAssetUrl(releaseBase, "online-feed-bundle.zip");
  assert.equal(directBundleUrl, `${releaseBase}online-feed-bundle.zip`, "the selected asset URL is a direct GitHub Release URL");
  assert.equal(buildGitHubReleaseAssetUrl(releaseBase, "pkg+1:2.deb"), `${releaseBase}pkg%2B1%3A2.deb`, "asset names are encoded as one path component");
  for (const badBase of [
    "https://github.com/other/repo/releases/download/tag/",
    "https://github.com/Argus-94/TERMUX_APP_PACKAGE/releases/download/tag/../",
    "https://github.com/Argus-94/TERMUX_APP_PACKAGE/releases/download/tag/?query=1",
    "http://github.com/Argus-94/TERMUX_APP_PACKAGE/releases/download/tag/",
    "https://github.com:444/Argus-94/TERMUX_APP_PACKAGE/releases/download/tag/",
  ]) assert.throws(() => buildGitHubReleaseAssetUrl(badBase, "online-feed-bundle.zip"), /AIB_ONLINE_PACKAGE_RELEASE_CONFIG_INVALID/);
  assert.throws(() => buildGitHubReleaseAssetUrl(releaseBase, "../outside.zip"), /AIB_ONLINE_PACKAGE_RELEASE_CONFIG_INVALID/);
  assert.equal(isAllowedGitHubReleaseAssetResponse(directBundleUrl, directBundleUrl), true, "same-origin direct asset responses are accepted");
  assert.equal(isAllowedGitHubReleaseAssetResponse(directBundleUrl,
    "https://release-assets.githubusercontent.com/github-production-release-asset/123/asset.zip?token=temporary"), true,
  "GitHub Release assets may resolve to the HTTPS release CDN");
  assert.equal(isAllowedGitHubReleaseAssetResponse(directBundleUrl,
    "https://objects.githubusercontent.com/github-production-release-asset/123/asset.zip?token=temporary"), true,
  "GitHub release object CDN redirects are accepted");
  for (const badResponseUrl of [
    "https://attacker.example/collect",
    "https://github.com/login",
    "https://release-assets.githubusercontent.com.evil.example/asset",
    "http://release-assets.githubusercontent.com/asset",
    "https://release-assets.githubusercontent.com:444/asset",
    "https://github.com/Argus-94/TERMUX_APP_PACKAGE/releases/download/test-aib-feed-1/nested/asset.zip",
    undefined,
  ]) assert.equal(isAllowedGitHubReleaseAssetResponse(directBundleUrl, badResponseUrl), false, `untrusted redirect rejected: ${badResponseUrl}`);
  assert.equal(isAllowedGitHubReleaseAssetResponse("https://github.com/other/repo/releases/download/tag/asset.zip", directBundleUrl), false,
    "a response cannot legitimize a request outside the approved repository");
  assert.equal(isAllowedGitHubReleaseAssetResponse(`${directBundleUrl}?tracking=1`, directBundleUrl), false,
    "asset request query strings are not accepted");

  let downloaderFactory;
  const mockDownloadModule = { createDownloadResumable: (...args) => downloaderFactory(...args) };
  const mockFileSystem = { Directory: class {}, File: class {}, Paths: { cache: {} } };
  const mockBridge = {
    getOfflineBundleFileSha256: async () => "",
    stagePreparedOnlinePackageDirectory: async () => ({ status: "blocked" }),
    verifyOnlinePackageCatalog: async () => false,
    cancelOfflinePackageBundle: async () => true,
  };
  const feed = loadTs(path.join(root, "lib/online-package-feed.ts"), new Map([
    ["expo-file-system", mockFileSystem],
    ["expo-file-system/legacy", mockDownloadModule],
    ["./termux-bridge", mockBridge],
  ]));
  assert.equal(feed.ONLINE_PACKAGE_RELEASE_BASE_URL, null, "production feed remains unconfigured until an approved release exists");
  let unconfiguredFetchCalls = 0;
  const unconfigured = await feed.fetchAndStageOnlinePackageCatalog("no-release-selected", undefined, async () => {
    unconfiguredFetchCalls++;
    throw new Error("network must remain untouched without a selected release");
  });
  assert.deepEqual(unconfigured, { status: "blocked", code: "AIB_ONLINE_PACKAGE_RELEASE_NOT_CONFIGURED" });
  assert.equal(unconfiguredFetchCalls, 0, "unconfigured production feed fails closed before network access");
  let controlRequestedUrl = "";
  const controlRedirect = await feed.fetchAndStageOnlinePackageCatalog("control-redirect-test", undefined, async url => {
    controlRequestedUrl = url;
    return { ok: true, status: 200, url: "https://attacker.example/online-catalog.json",
      headers: { get: () => "2" }, arrayBuffer: async () => new Uint8Array([123, 125]).buffer };
  }, releaseBase);
  assert.equal(controlRequestedUrl, buildGitHubReleaseAssetUrl(releaseBase, "online-catalog.json"),
    "control metadata is requested from the direct GitHub Release asset URL");
  assert.deepEqual(controlRedirect, { status: "rejected", code: "AIB_ONLINE_PACKAGE_REDIRECT_REJECTED" },
    "the live catalog fetch path rejects an external redirect before parsing bytes");

  const cdnUrl = "https://release-assets.githubusercontent.com/github-production-release-asset/123/bundle.zip?token=temporary";
  const file = { uri: "file:///private/cache/feed.zip", size: 0, exists: true, delete() { this.exists = false; this.deleted = true; } };
  let downloaderUrl = "";
  let streamedProgress = 0;
  const assetHead = async (url, init) => {
    assert.equal(url, directBundleUrl, "HEAD preflight uses the direct selected release asset URL");
    assert.equal(init.method, "HEAD", "asset metadata is checked before the body transfer");
    return { ok: true, status: 200, url: cdnUrl, headers: { get: name => name.toLowerCase() === "content-length" ? "8" : null } };
  };
  downloaderFactory = (url, destinationUri, _options, onProgress) => {
    downloaderUrl = url;
    assert.equal(destinationUri, file.uri);
    return {
      async downloadAsync() {
        onProgress({ totalBytesWritten: 4, totalBytesExpectedToWrite: 8 });
        onProgress({ totalBytesWritten: 8, totalBytesExpectedToWrite: 8 });
        file.size = 8;
        return { status: 200, uri: file.uri };
      },
      async cancelAsync() {},
    };
  };
  await feed.downloadPackageAsset(directBundleUrl, file, 8, null, 1024, "runtime-stream-test", new AbortController().signal,
    assetHead, written => { streamedProgress = written; });
  assert.equal(downloaderUrl, cdnUrl, "native streaming downloads use the validated final CDN URL, not the opaque redirecting URL");
  assert.equal(streamedProgress, 8, "native file-download progress is propagated without buffering response bytes in JS");

  let rejectedRedirectDownloaderCalls = 0;
  downloaderFactory = () => { rejectedRedirectDownloaderCalls++; throw new Error("untrusted redirect must stop before download"); };
  await assert.rejects(feed.downloadPackageAsset(directBundleUrl, file, 8, null, 1024, "runtime-reject-test", new AbortController().signal,
    async () => ({ ok: true, status: 200, url: "https://attacker.example/bundle.zip", headers: { get: () => "8" } }), () => undefined),
  error => error?.message === "AIB_ONLINE_PACKAGE_REDIRECT_REJECTED");
  assert.equal(rejectedRedirectDownloaderCalls, 0, "no native body transfer starts after a disallowed redirect");

  const cancelFile = { uri: "file:///private/cache/cancel.zip", size: 0, exists: true, delete() { this.exists = false; this.deleted = true; } };
  const cancellationController = new AbortController();
  let downloadStartedResolve;
  const downloadStarted = new Promise(resolve => { downloadStartedResolve = resolve; });
  let cancelAsyncCalls = 0;
  downloaderFactory = url => ({
    downloadAsync() { assert.equal(url, cdnUrl); downloadStartedResolve(); return new Promise(() => undefined); },
    async cancelAsync() { cancelAsyncCalls++; },
  });
  const cancelledTransfer = feed.downloadPackageAsset(directBundleUrl, cancelFile, 8, null, 1024, "runtime-cancel-test", cancellationController.signal,
    assetHead, () => undefined);
  await downloadStarted;
  cancellationController.abort();
  await assert.rejects(cancelledTransfer, error => error?.message === "AIB_ONLINE_PACKAGE_CANCELLED");
  assert.equal(cancelAsyncCalls, 1, "aborting the caller cancels the active native stream exactly once");
  assert.equal(cancelFile.deleted, true, "cancelled partial downloads are deleted from the private cache");

  let packageFixtureCount = "not-supplied";
  const realBundlePath = process.env.AIB_ONLINE_PACKAGE_BUNDLE_FIXTURE;
  if (realBundlePath) {
    const realBundleBytes = new Uint8Array(fs.readFileSync(realBundlePath));
    const realEntries = [];
    let realDebBytes = 0;
    const realBundleResult = await extractSelectedZipEntriesToSink(byteArrayZipSource(realBundleBytes), "zip",
      name => name.startsWith("feed/") && name !== "feed/",
      { maxEntries: 256, maxEntryBytes: 100 * 1024 * 1024, maxTotalBytes: 200 * 1024 * 1024 }, {
        begin(name) { realEntries.push(name); },
        write(name, bytes) { if (name.endsWith(".deb")) realDebBytes += bytes.length; },
        finish() {},
      });
    assert.equal(realBundleResult.ok, true, "the real Karat package bundle is parsed through the bounded streaming ZIP path");
    assert.equal(realEntries.length, 138, "the fixture contains the expected complete 138-file feed inventory");
    assert.equal(realEntries.filter(name => name.endsWith(".deb")).length, 135, "all 135 package archive entries are seen as opaque bytes");
    assert.ok(realDebBytes > 0, "package archive payloads are streamed through without running any .deb maintainer scripts");
    packageFixtureCount = `${realEntries.length}/${realEntries.filter(name => name.endsWith(".deb")).length}`;
  }

  let requestSignalAborted = false;
  const requestStart = Date.now();
  await assert.rejects(
    withOnlineFeedRequestDeadline(signal => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => { requestSignalAborted = true; reject(new Error("transport aborted")); }, { once: true });
    }), new AbortController().signal, 25),
    error => error?.message === "AIB_ONLINE_PACKAGE_REQUEST_TIMEOUT",
    "an unresponsive control request returns a stable timeout result",
  );
  assert.ok(Date.now() - requestStart < 1_000, "request timeout must not wait for the ignored transport promise");
  assert.equal(requestSignalAborted, true, "deadline aborts the underlying request signal");

  let cancelledTransfers = 0;
  const transferStart = Date.now();
  await assert.rejects(
    withOnlineFeedTransferDeadline(() => new Promise(() => undefined), new AbortController().signal,
      () => { cancelledTransfers++; }, { idleTimeoutMs: 25, totalTimeoutMs: 100 }),
    error => error?.message === "AIB_ONLINE_PACKAGE_TRANSFER_IDLE_TIMEOUT",
    "a stalled asset download is cancelled instead of leaving the screen busy forever",
  );
  assert.ok(Date.now() - transferStart < 1_000, "idle watchdog settles quickly");
  assert.equal(cancelledTransfers, 1, "native downloader cancellation is requested exactly once");

  const progressController = new AbortController();
  const progressResult = await withOnlineFeedTransferDeadline(
    onProgress => new Promise(resolve => {
      const heartbeat = setInterval(onProgress, 5);
      setTimeout(() => { clearInterval(heartbeat); resolve("complete"); }, 35);
    }), progressController.signal, () => assert.fail("successful transfer must not be cancelled"),
    { idleTimeoutMs: 15, totalTimeoutMs: 100 },
  );
  assert.equal(progressResult, "complete", "valid progress resets the idle watchdog");

  const cancelController = new AbortController();
  let userCancelCalls = 0;
  const cancelPromise = withOnlineFeedTransferDeadline(() => new Promise(() => undefined), cancelController.signal,
    () => { userCancelCalls++; }, { idleTimeoutMs: 500, totalTimeoutMs: 1_000 });
  setTimeout(() => cancelController.abort(), 10);
  await assert.rejects(cancelPromise, error => error?.message === "AIB_ONLINE_PACKAGE_CANCELLED");
  assert.equal(userCancelCalls, 1, "user cancellation reaches the native transfer");

  const recovered = await withOnlineFeedRequestDeadline(async () => "next request ok", new AbortController().signal, 100);
  assert.equal(recovered, "next request ok", "a timed-out request leaves no stuck global slot for the next attempt");
  console.log(`AIB_ONLINE_PACKAGE_FEED_RUNTIME_SELFTEST_OK direct_asset=1 redirects_allowed=2 redirects_rejected=6 cdn_target_stream=1 cancellation=1 production_fail_closed=1 archive_fixture=${packageFixtureCount} bad_header=blocked traversal=blocked control_timeout=1 idle_download_timeout=1 retry_recovers=1`);
}

main().catch(error => { console.error(error?.stack || String(error)); process.exit(1); });
