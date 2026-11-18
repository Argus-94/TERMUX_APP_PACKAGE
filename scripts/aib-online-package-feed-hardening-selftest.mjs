#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = relative => fs.readFileSync(path.join(root, relative), "utf8");
const bridge = read("plugins/withTermuxBridge.js");
const feed = read("lib/online-package-feed.ts");
const transport = read("lib/github-release-asset-transport.ts");
const stageBridge = read("lib/termux-bridge.ts");
const offlineBundle = read("lib/offline-package-bundle.ts");

const acceptStart = bridge.indexOf("private fun onlineCatalogCheck(");
const acceptEnd = bridge.indexOf("/** Online feed path is separate", acceptStart);
assert.ok(acceptStart >= 0 && acceptEnd > acceptStart, "native catalog guard must be present");
const accept = bridge.slice(acceptStart, acceptEnd);
assert.match(bridge, /private val onlineCatalogAcceptLock = Any\(\)/, "native compare-and-commit needs a shared lock");
assert.match(accept, /synchronized\(onlineCatalogAcceptLock\)\s*\{[\s\S]*?prefs\.getLong\("sequence"[\s\S]*?previousSequence[\s\S]*?prefs\.edit\(\)[\s\S]*?\.commit\(\)/,
  "sequence/digest/clock read, replay decision, and durable commit must share one critical section");
assert.match(accept, /val persisted = prefs\.edit\(\)[\s\S]*?\.commit\(\)\s*if \(!persisted\) return false/,
  "catalog acceptance must fail closed when replay state cannot be persisted");
assert.match(accept, /if \(!persisted\) return false\s*\}\s*\}\s*true\s*\}\s*catch \(_: Throwable\) \{ false \}/,
  "catalog acceptance must return true only after the durable replay-state commit succeeds");
assert.match(accept, /"new" -> if \(sequence <= previousSequence\) return false/, "preflight must reject all previously accepted sequence numbers");
assert.match(accept, /"accept" -> if \(sequence <= previousSequence\) return false/, "durable catalog acceptance must be strictly monotonic");
assert.match(accept, /"current" -> if \(sequence != previousSequence \|\| previousDigest != digest\) return false/, "later plan/install revalidation may only reuse the exact currently accepted catalog");
assert.match(bridge, /onlineCatalogCheck\(manifestBytes, signatureBytes, "new"\)/, "download preflight must not consume the durable sequence");
const stageValidationStart = bridge.indexOf("private fun offlineValidateStage(");
const stageValidationEnd = bridge.indexOf("private fun offlineAptConfig(", stageValidationStart);
const stageValidation = bridge.slice(stageValidationStart, stageValidationEnd);
assert.ok(stageValidation.indexOf("if (records.size != packages.size)") < stageValidation.indexOf("onlineCatalogCheck(manifestBytes, signatureBytes, replayMode)"),
  "sequence is committed only after package index and inventory validation");
assert.match(bridge, /offlineValidateStage\(file, stageId, requestId, acceptOnlineCatalogSequence = true\)/,
  "only initial native stage acceptance advances replay state");

const exactPlanStart = bridge.indexOf("private fun offlineAptExactPlanCommand(");
const exactPlanEnd = bridge.indexOf("private fun offlineProxyPromise(", exactPlanStart);
const exactPlan = bridge.slice(exactPlanStart, exactPlanEnd);
assert.match(exactPlan, /awk[\s\S]*cmp -s/, "install must extract and compare a fresh APT simulation against the confirmed exact plan");
assert.match(exactPlan, /return update[\s\S]*comparePlan[\s\S]*install/, "a changed dependency simulation must fail before the mutating APT install command");

assert.match(feed, /const MAX_PACKAGE_BYTES = 190 \* 1024 \* 1024;/, "online package aggregate cap must match native validation");
assert.match(feed, /const MAX_TOTAL_BYTES = 200 \* 1024 \* 1024;/, "catalog byte cap must match online staging");
assert.match(stageBridge, /totalBytes > 200 \* 1024 \* 1024/, "online staging cap must be 200 MiB");
assert.match(stageBridge, /maxTotalBytes = 150 \* 1024 \* 1024/, "other/offline native stage results retain the 150 MiB ceiling");
assert.match(stageBridge, /packages: cleanPackages \}, 200 \* 1024 \* 1024\)/, "only online package staging may opt into 200 MiB");
assert.match(bridge, /maxPackageBytes = if \(onlineCatalog\) 190L \* 1024L \* 1024L else 150L \* 1024L \* 1024L/, "native online package aggregate is raised without widening offline ZIP policy");
assert.match(offlineBundle, /const MAX_PACKAGE_BYTES = 32 \* 1024 \* 1024;/, "offline ZIP per-package cap must remain 32 MiB");
assert.match(offlineBundle, /const MAX_TOTAL_PACKAGE_BYTES = 150 \* 1024 \* 1024;/, "offline ZIP aggregate package cap must remain 150 MiB");
  assert.match(feed, /const MAX_FILE_BYTES = 100 \* 1024 \* 1024;/, "per-file cap must remain bounded");

const assetCheckStart = feed.indexOf("async function getAssetLength(");
const assetCheckEnd = feed.indexOf("async function downloadPackageAsset(", assetCheckStart);
assert.ok(assetCheckStart >= 0 && assetCheckEnd > assetCheckStart, "bounded GitHub asset HEAD checker must exist");
const assetCheck = feed.slice(assetCheckStart, assetCheckEnd);
assert.match(assetCheck, /method: "HEAD"/, "asset size and redirect host must be checked before download");
assert.match(assetCheck, /isAllowedGitHubReleaseAssetResponse\(url, head\.url\)/, "the final HEAD URL must be restricted to GitHub/CDN hosts");

const downloaderStart = feed.indexOf("export async function downloadPackageAsset(");
const downloaderEnd = feed.indexOf("function writeBytes(", downloaderStart);
assert.ok(downloaderStart >= 0 && downloaderEnd > downloaderStart, "streamed package downloader must exist");
const downloader = feed.slice(downloaderStart, downloaderEnd);
assert.match(assetCheck, /expectedSize !== null.*declaredBytes !== expectedSize/, "asset content length must exactly match the signed catalog");
assert.match(downloader, /createDownloadResumable\(/, "package bodies must be streamed by the native file downloader");
assert.match(downloader, /createDownloadResumable\(asset\.url/, "the body must be fetched directly from the already-validated response URL");
assert.match(downloader, /prevalidatedAsset \?\? await getAssetLength/, "an existing validated HEAD target may be reused for the archive body");
assert.match(downloader, /isAllowedGitHubReleaseAssetResponse\(url, asset\.url\)/, "both fresh and reused targets must pass the same allowlist guard");
assert.match(downloader, /totalBytesWritten > maxBytes/, "stream progress must cancel an over-limit transfer");
assert.match(downloader, /cancelAsync\(\)/, "the native file transfer must be cancellable");
assert.match(downloader, /destination\.size !== expectedSize/, "downloaded file size must be rechecked before staging");
assert.match(downloader, /getOfflineBundleFileSha256\(destination\.uri\)/, "downloaded bytes must be SHA-256 checked");
assert.doesNotMatch(downloader, /arrayBuffer\(/, "package assets must never be buffered as a whole response in JS memory");
assert.match(feed, /withOnlineFeedRequestDeadline\(/, "metadata fetches must be deadline-bound");
assert.match(feed, /withOnlineFeedTransferDeadline\(/, "native transfers must have an idle and total deadline");
assert.match(feed, /ONLINE_PACKAGE_BUNDLE_ASSET/, "a single GitHub Release archive must be supported");
assert.match(feed, /ONLINE_PACKAGE_RELEASE_BASE_URL: string \| null = null/, "no unpublished production release may be selected by default");
assert.match(feed, /releaseBaseUrl === null[\s\S]*AIB_ONLINE_PACKAGE_RELEASE_NOT_CONFIGURED/, "the feed must fail closed before network access until a release is selected");
assert.match(transport, /TERMUX_APP_PACKAGE/, "direct asset URLs must be scoped to the approved GitHub repository");
assert.match(transport, /isCanonicalReleaseAssetPath/, "only one exact tag/asset pair may be requested");
assert.match(transport, /release-assets\.githubusercontent\.com[\s\S]*objects\.githubusercontent\.com/, "only the known GitHub release CDN hosts may receive redirected asset requests");
assert.match(feed, /if \(downloader\) await downloader\.cancelAsync\(\)/, "UI cancellation must reach the active native transfer");
assert.match(feed, /controller\.signal\.aborted \? "AIB_ONLINE_PACKAGE_CANCELLED"/, "native transfer aborts must produce a stable cancellation result instead of generic fetch failure");
assert.match(bridge, /stopAibEmbeddedProcess\(current, root, tracked\)/, "native feed cancellation must stop the running APT process, not only mark a flag");
const feedCatchStart = feed.indexOf("} catch (error) {", feed.indexOf("export async function fetchAndStageOnlinePackageCatalog"));
const feedCatchEnd = feed.indexOf("} finally {", feedCatchStart);
const feedCatch = feed.slice(feedCatchStart, feedCatchEnd);
const cancelAckIndex = feedCatch.indexOf("() => nativeStageCancellation!");
const stageSettleIndex = feedCatch.indexOf("() => nativeStageOperation!.then");
const cleanupIndex = feedCatch.indexOf("removeStage(id)");
assert.ok(cancelAckIndex >= 0 && stageSettleIndex > cancelAckIndex && cleanupIndex > stageSettleIndex,
  "partial stage cleanup must await bounded cancel acknowledgement and native-stage settlement");
assert.match(feedCatch, /if \(!nativeCancelUnconfirmed\) removeStage\(id\)/, "an unconfirmed native process must retain ownership of its stage until native cleanup can finish safely");
assert.match(feedCatch, /AIB_ONLINE_PACKAGE_NATIVE_CANCEL_UNCONFIRMED/, "unconfirmed native cancellation stays blocked and visible");
const userCancelStart = feed.indexOf("export async function cancelOnlinePackageCatalog");
assert.ok(userCancelStart >= 0, "UI cancellation entry point must exist");
assert.doesNotMatch(feed.slice(userCancelStart), /removeStage\(active\.stageId\)/, "UI cancellation must delegate stage cleanup to the active native operation");

const smallFetchStart = feed.indexOf("async function getBytes(");
const smallFetchEnd = feed.indexOf("async function downloadPackageAsset(", smallFetchStart);
const smallFetch = feed.slice(smallFetchStart, smallFetchEnd);
assert.match(smallFetch, /declaredBytes > maxBytes/, "catalog/signature response length must be bounded before allocation");
assert.match(smallFetch, /bytes\.length !== declaredBytes/, "small control assets must match their declared length exactly");

console.log("AIB_ONLINE_PACKAGE_FEED_HARDENING_SELFTEST_OK anti_replay_atomic=1 package_cap_190MiB=1 total_cap_200MiB=1 offline_caps_preserved=1 native_streaming=1 size_hash_verified=1 cancel=1 small_control_assets_bounded=1");
