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
function loadTs(file) {
  file = path.resolve(file);
  if (cache.has(file)) return cache.get(file).exports;
  const mod = new Module(file);
  mod.filename = file;
  mod.paths = Module._nodeModulePaths(path.dirname(file));
  cache.set(file, mod);
  mod.require = request => {
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
  console.log("AIB_ONLINE_PACKAGE_FEED_RUNTIME_SELFTEST_OK archive_stream=1 crc_size=1 bad_header=blocked traversal=blocked control_timeout=1 idle_download_timeout=1 cancel=1 progress_resets_idle=1 retry_recovers=1");
}

main().catch(error => { console.error(error?.stack || String(error)); process.exit(1); });
