import fs from 'node:fs';
import Module from 'node:module';

const pluginPath = new URL('../plugins/withTermuxBridge.js', import.meta.url).pathname;
const source = fs.readFileSync(pluginPath, 'utf8');
const uiSource = fs.readFileSync(new URL('../components/PackagesRightMenu.tsx', import.meta.url), 'utf8');
const onlineUiSource = fs.readFileSync(new URL('../components/OnlinePackageFeedPanel.tsx', import.meta.url), 'utf8');
const onlineFeedSource = fs.readFileSync(new URL('../lib/online-package-feed.ts', import.meta.url), 'utf8');
const temp = `${pluginPath}.offline-selftest.cjs`;
fs.writeFileSync(temp, `${source}\nmodule.exports={moduleKotlin};\n`, 'utf8');
const originalLoad = Module._load;
try {
  Module._load = function(request, parent, isMain) {
    if (request === '@expo/config-plugins') {
      return {
        withAndroidManifest(config) { return config; },
        withMainApplication(config) { return config; },
        withDangerousMod(config) { return config; },
      };
    }
    return originalLoad.apply(this, arguments);
  };
  const { moduleKotlin } = await import(`file://${temp}?t=${Date.now()}`);
  const generated = moduleKotlin('com.karat.aibuilder');
  const required = [
    'private fun verifyOfflinePackageManifestBytes(manifestBytes: ByteArray, signatureBytes: ByteArray): Boolean',
    'PackageManager.GET_SIGNING_CERTIFICATES',
    'if (appSigners.size != 1 || appSigners.single() != expectedAppSigner) return false',
    'EXPECTED_RELEASE_SIGNER_SHA256 = "661e5c868dbb38f8fe57d380e5c9b35e594e79bedb72d9ad2ad0113665c80418"',
    'LEGACY_RELEASE_SIGNER_SHA256 = "b5dacc6f9c37adceace5c0d715eecb2762b5a0417468e221ec9c534ea1e6328e"',
    'EXPECTED_RELEASE_SIGNATURE_BYTES = 256',
    'android.util.Base64.decode(EXPECTED_RELEASE_SIGNER_CERT_DER_BASE64, android.util.Base64.DEFAULT)',
    'digest != EXPECTED_RELEASE_SIGNER_SHA256',
    'java.security.Signature.getInstance("SHA256withRSA")',
    'verifier.update(manifestBytes)',
    'Regex("^feed/[A-Za-z0-9._+@:/-]{1,500}\\\\.deb$")',
    'Regex("^feed/[A-Za-z0-9._+@:/-]{1,500}$")',
    'fun stageOfflinePackageBundle(stageDirectoryUri: String, stageId: String, requestId: String, promise: Promise)',
    'fun planOfflinePackageBundle(stageId: String, requestId: String, selectedPackageNames: com.facebook.react.bridge.ReadableArray, promise: Promise)',
    'fun installOfflinePackageBundle(stageId: String, requestId: String, selectedPackageNames: com.facebook.react.bridge.ReadableArray, planId: String?, promise: Promise)',
    'fun verifyOnlinePackageCatalog(rawManifest: com.facebook.react.bridge.ReadableArray, detachedSignature: com.facebook.react.bridge.ReadableArray, promise: Promise)',
    'aib_online_catalog_guard_v1',
    'lastWallClockMs',
    'sequence <= previousSequence',
    'expiresAt - issuedAt > maxAge',
    'aibuilder-online-package-catalog',
    'schemaVersion == 3',
    'AIB_OFFLINE_PACKAGE_SELECTION_INVALID',
    'selectedPackages.joinToString',
    'fun cancelOfflinePackageBundle(requestId: String, promise: Promise)',
    'private val offlineArchivePickerRequestCode = 48323',
    'if (requestCode == offlineArchivePickerRequestCode)',
    'Intent.ACTION_GET_CONTENT',
    'Intent.createChooser(getContentIntent, "Choose an offline archive")',
    'Intent.ACTION_OPEN_DOCUMENT',
    'private fun copyOfflineArchiveToPrivateCache(sourceUri: Uri): File',
    'if (totalBytes > maxOfflineArchiveBytes)',
    'File.createTempFile("aib-offline-", ".part", directory)',
    'if (!temporary.renameTo(destination))',
    '.emit("offlineBundleProgress", event)',
    'private fun offlineValidateStage(root: File, stageId: String, requestId: String, acceptOnlineCatalogSequence: Boolean = false)',
    'File(ctx.cacheDir.canonicalFile, "offline-bundle-" + stageId)',
    '^[A-Za-z0-9_-]{16,128}$',
    '^[A-Za-z0-9._-]{1,96}$',
    'offlineReadBounded(manifestFile, 192 * 1024)',
    'offlineReadBounded(signatureFile, EXPECTED_RELEASE_SIGNATURE_BYTES)',
    'if (signatureBytes.size != EXPECTED_RELEASE_SIGNATURE_BYTES || !verifyOfflinePackageManifestBytes(manifestBytes, signatureBytes))',
    'val doc = org.json.JSONObject(text)',
    'Os.lstat(child.absolutePath)',
    'offlineHash(File(expected, path), pair.first)',
    'offline_tree_inventory_mismatch',
    'feed/dists/stable/main/binary-aarch64/Packages',
    'pkg.filename.removePrefix("feed/")',
    '!seenNames.add(name + "@" + version)',
    'records.put(name + "@" + version, fields.toMap())',
    'records[pkg.name + "@" + pkg.version]',
    'val indexDeps = listOf("Depends", "Pre-Depends")',
    'if (indexDeps != pkg.depends)',
    'trusted=yes] file://',
    'Dir::Etc::sourcelist=',
    'Dir::Etc::parts=-',
    'Dir::Etc::sourceparts=-',
    'Dir::Etc::trusted=/dev/null',
    'val statusVersionFormat',
    'install ok installed " + it.version',
    'Acquire::http::Proxy=http://127.0.0.1:9',
    'Acquire::https::Proxy=http://127.0.0.1:9',
    '--simulate --no-download --no-install-recommends --no-remove install',
    '--assume-yes --no-download --no-install-recommends --no-remove install',
    'AIB_OFFLINE_APT_SIMULATION_OK',
    'private fun offlineParseAptPlan(value: Any?, stage: OfflineStage, roots: List<String>)',
    'private fun offlineStatusSha256(prefix: File)',
    'private fun offlineAptExactPlanCommand(stage: OfflineStage, prefix: File, packages: List<OfflinePlannedPkg>)',
    'offlinePlans.remove(selectedPlan.planId, selectedPlan)',
    'AIB_OFFLINE_APT_PLAN_REQUIRED_OR_EXPIRED',
    'AIB_OFFLINE_INSTALL_VERIFIED',
    'requestAibEmbeddedCancellation(requestId)',
    'fun sha256File(fileUri: String, promise: Promise)',
    'offline-bundle-[A-Za-z0-9_-]{16,128}',
    'ByteArray(32768)',
    'AIB_OFFLINE_PACKAGE_HASH_PATH_REJECTED',
    'runEmbeddedTermuxCommandInternal(command, null, 900000.0, requestId, proxy, 900000L, true)',
    'offlineResultHasMarker(value,',
  ];
  for (const token of required) {
    if (!generated.includes(token)) throw new Error(`generated native offline boundary is missing ${token}`);
  }
  if (/AIB_OFFLINE_BUNDLE_NATIVE_FLOW_UNAVAILABLE/.test(generated)) {
    throw new Error('native offline implementation must not retain blocked placeholders');
  }
  function blockAfter(signature, nextSignature) {
    const start = generated.indexOf(signature);
    if (start < 0) throw new Error(`missing Kotlin block ${signature}`);
    const next = generated.indexOf(nextSignature, start + signature.length);
    return generated.slice(start, next < 0 ? generated.length : next);
  }
  const validation = blockAfter('private fun offlineValidateStage(', 'private fun offlineAptConfig(');
  if (validation.indexOf('verifyOfflinePackageManifestBytes(manifestBytes, signatureBytes)') > validation.indexOf('org.json.JSONObject(text)')) {
    throw new Error('Karat raw-byte verification must happen before JSON parsing');
  }
  if (!validation.includes('path.contains("//")') || !validation.includes(`path.split('/').any { it == "." || it == ".." }`)) {
    throw new Error('colon-bearing feed names must retain duplicate-separator and traversal rejection');
  }
  const stage = blockAfter('fun stageOfflinePackageBundle(stageDirectoryUri:', 'fun installOfflinePackageBundle(');
  if (!stage.includes('uri.scheme != "file"') || !stage.includes('startsWith("file://")') || stage.includes('content://') || !stage.includes('offlineValidateStage(file, stageId, requestId, acceptOnlineCatalogSequence = true)') ||
      !stage.includes('reserveAibEmbeddedRequest(requestId)') || !stage.includes('offlineRunCommand(command, requestId, promise)')) {
    throw new Error('stage must verify its canonical file cache stage and transfer request ownership to the command runner');
  }
  const install = blockAfter('fun installOfflinePackageBundle(', 'fun cancelOfflinePackageBundle(');
  if (!install.includes('offlineValidateStage(stage.root, stageId, requestId)') ||
      !install.includes('offlineAptCommand(checked, prefix, false, requestedNames)') || !install.includes('offlineAptExactPlanCommand(checked, prefix, selectedPlan.packages)') ||
      !install.includes('offlineStatusSha256(prefix) != selectedPlan.statusSha256') || !install.includes('reserveAibEmbeddedRequest(requestId)') ||
      !install.includes('selectedPackageNames.getType(index)')) {
    throw new Error('online install must revalidate the stage, plan token, exact closure and dpkg status before applying');
  }
  const exactPlan = blockAfter('private fun offlineAptExactPlanCommand(', 'private fun offlineProxyPromise(');
  if (!exactPlan.includes('cmp -s') || !exactPlan.includes('comparePlan') || exactPlan.indexOf('comparePlan') > exactPlan.indexOf('&& " + install')) {
    throw new Error('the fresh APT simulation must exactly match the confirmed package/version list before install');
  }
  const plan = blockAfter('fun planOfflinePackageBundle(', 'fun stageOfflinePackageBundle(');
  if (!plan.includes('offlineValidateStage(stage.root, stageId, requestId)') || !plan.includes('offlineAptCommand(checked, prefix, true, roots)') ||
      !plan.includes('offlineStatusSha256(prefix)') || !plan.includes('offlineRunPlanCommand(command, requestId, checked, roots, statusSha256, promise)')) {
    throw new Error('APT plan must be generated from a freshly revalidated local signed catalog and pinned to the current dpkg database');
  }
  const cancel = blockAfter('fun cancelOfflinePackageBundle(', '/** Explicit offline test evidence only;');
  if (!cancel.includes('requestAibEmbeddedCancellation(requestId)') || !cancel.includes('AibEmbeddedProcessRegistry.active[requestId]') ||
      !cancel.includes('stopAibEmbeddedProcess(current, root, tracked)')) {
    throw new Error('cancellation must mark the request and stop any active native process before acknowledging');
  }
  if (!cancel.includes('val settled = waitForRequestFinish()') || !cancel.includes('val settled = stopped && waitForRequestFinish()')) {
    throw new Error('native cancel must wait for preflight or process worker settlement before deleting its stage');
  }
  const stopIndex = cancel.indexOf('val stopped = stopCurrent()');
  const cleanupAfterStopIndex = cancel.indexOf('cleanupStages()', stopIndex + 1);
  if (stopIndex < 0 || cleanupAfterStopIndex < 0 || cancel.indexOf('promise.resolve(settled)', stopIndex) < cleanupAfterStopIndex) {
    throw new Error('native stage files may be removed only after process stop/request settlement and before cancellation acknowledgement');
  }
  const picker = blockAfter('@ReactMethod\n    fun pickOfflinePackageArchive(', 'private fun copyOfflineArchiveToPrivateCache(');
  if (!picker.includes('Intent.createChooser(getContentIntent') || !picker.includes('Intent.ACTION_GET_CONTENT') ||
      !picker.includes('Intent.ACTION_OPEN_DOCUMENT') || !picker.includes('pendingOfflineArchivePickerPromise')) {
    throw new Error('offline archive selection must launch an explicit Android chooser with an OPEN_DOCUMENT fallback');
  }
  const pickerCopy = blockAfter('private fun copyOfflineArchiveToPrivateCache(', '@ReactMethod\n    fun getAIBuilderAllFilesAccessStatus(');
  if (!pickerCopy.includes('contentResolver.openInputStream(sourceUri)') || !pickerCopy.includes('maxOfflineArchiveBytes') ||
      !pickerCopy.includes('output.fd.sync()') || !pickerCopy.includes('temporary.renameTo(destination)')) {
    throw new Error('selected archive must be streamed with a size bound into app-private cache before JS random-access inspection');
  }
  const aptBuilder = blockAfter('private fun offlineAptCommand(', 'private fun offlineProxyPromise(');
  if (/signed-by=|gpgv?|OpenPGP/i.test(aptBuilder)) throw new Error('offline package flow must not introduce an OpenPGP or package key trust path');
  if (!aptBuilder.includes('--assume-yes --no-download --no-install-recommends --no-remove install')) throw new Error('APT must not download packages during installation');
  if (!aptBuilder.includes('checks + " && printf') || aptBuilder.indexOf('checks + " && printf') < aptBuilder.indexOf('install = apt')) {
    throw new Error('install success marker must follow every signed package version check');
  }
  if (!aptBuilder.includes('val uniquePackages = stage.packages.distinctBy { it.name }') ||
      !aptBuilder.includes('stage.packages.filter { it.name == pkg.name }') || !aptBuilder.includes('grep -F -x')) {
    throw new Error('multi-version catalogs must install each package name once and verify the installed version against its signed records');
  }
  if (!uiSource.includes('Before this confirmation, native preflight verified') ||
      !uiSource.includes('await pickOfflinePackageArchive()') || uiSource.includes('DocumentPicker.getDocumentAsync') ||
      !uiSource.includes('showDialog(') || !uiSource.includes('onPress: () => void installReadyOfflineBundle(staged)')) {
    throw new Error('the explicit install confirmation gate must remain in the package UI');
  }
  for (const token of ['ONLINE_PACKAGE_RELEASE_BASE_URL', 'verifyOnlinePackageCatalog', 'getOfflineBundleFileSha256', 'stagePreparedOnlinePackageDirectory', 'cancelOnlinePackageCatalog', 'dependencyClosureComplete']) {
    if (!onlineFeedSource.includes(token)) throw new Error(`online feed path is missing ${token}`);
  }
  for (const token of ['Review dependency plan', 'Install planned packages', 'planOfflinePackageBundle(stage.stageId, requestId, selectedNames)', 'installOfflinePackageBundle(stage.stageId, requestId, selectedNames, confirmedPlan.planId)', 'Ordinary pkg/apt/dpkg commands remain blocked']) {
    if (!onlineUiSource.includes(token)) throw new Error(`online package UI is missing ${token}`);
  }
  console.log('AIB_OFFLINE_PACKAGE_NATIVE_BOUNDARY_SELFTEST_OK bounded_stage=1 karat_before_json=1 exact_inventory_hash=1 local_apt=1 selected_roots=1 exact_apt_plan=1 plan_replay=blocked dpkg_snapshot=1 online_schema=v3 freshness=1 anti_replay=1 redirects=bounded progress_cancel=1 ui_confirmation=1');
} finally {
  Module._load = originalLoad;
  fs.rmSync(temp, { force: true });
}
