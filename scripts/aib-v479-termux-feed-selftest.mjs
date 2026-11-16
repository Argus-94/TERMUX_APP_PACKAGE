#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { buildTermuxPackageWorkflowInputs } from "../lib/termux-package-workflow-inputs.ts";

const root = process.cwd();
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const appId = "com.karat.aibuilder";
const appDataDir = `/runtime/user/${appId}`;
const filesDir = `${appDataDir}/files`;
const runtime = {
  ready: true,
  bootstrapManifestValid: true,
  applicationId: appId,
  architecture: "aarch64",
  applicationDataDir: appDataDir,
  filesDir,
  termuxPrefix: `${filesDir}/usr`,
};

assert.deepEqual(buildTermuxPackageWorkflowInputs(runtime), {
  app_data_dir: appDataDir,
  termux_prefix: `${filesDir}/usr`,
});
for (const invalid of [
  null,
  { ...runtime, ready: false },
  { ...runtime, bootstrapManifestValid: false },
  { ...runtime, applicationId: "com.termux" },
  { ...runtime, architecture: "x86_64" },
  { ...runtime, termuxPrefix: "/data/data/com.termux/files/usr" },
  { ...runtime, filesDir: `${appDataDir}/files/../files` },
]) {
  assert.throws(() => buildTermuxPackageWorkflowInputs(invalid), /AIB_TERMUX_PACKAGE_WORKFLOW_/);
}

const installer = read("plugins/termuxBootstrapInstallerKotlin.js");
const bridge = read("plugins/withTermuxBridge.js");
const runtimeBridge = read("lib/termux-bridge.ts");
const policy = read("lib/agent-private-tool-policy.ts");
const workflowHelper = read("lib/termux-package-workflow-inputs.ts");
const feedUrl = "https://argus-94.github.io/TERMUX_APP_PACKAGE/apt/termux-main";

assert.ok(installer.includes(`PACKAGE_FEED_URL = "${feedUrl}"`));
assert.match(installer, /return PackageFeedState\(false, "blocked_signing_key_unprovisioned"\)/);
assert.doesNotMatch(installer, /PACKAGE_FEED_KEY_SHA256\s*=\s*"(?!UNPROVISIONED)/);
assert.doesNotMatch(installer + bridge, /A7EE64180D30C6DCD498F12FDC3AF8E50872E21F|a19da39a2dcfe805be612ce886e8eb644e56ea9fbbb5e74b71aab79949717df2|BEGIN PGP (?:PUBLIC|PRIVATE) KEY BLOCK|OPENPGP/i);
assert.doesNotMatch(installer, /signed-by=|gpgv|trusted=yes|AllowUnauthenticated\s+"true"|AllowInsecureRepositories\s+"true"/i);
const productionAssets = path.join(root, "assets/termux-production");
assert.ok(!fs.existsSync(productionAssets) || fs.readdirSync(productionAssets).length === 0, "no production feed signing key asset is provisioned");
assert.match(bridge, /blocked_signing_key_unprovisioned/);
assert.match(installer, /private fun packageFeedAptConfigBytes\(\): ByteArray/);
assert.match(installer, /AllowUnauthenticated " \+ quote \+ "false"/);
assert.match(installer, /AllowInsecureRepositories " \+ quote \+ "false"/);
assert.match(bridge, /applicationInfo\.dataDir/);
assert.match(bridge, /val filesDirPath = appFiles\.absolutePath/);
assert.match(bridge, /val termuxPrefixPath = prefix\.absolutePath/);
assert.match(bridge, /packageFeedStatus == "signed_source_configured"/);
assert.match(runtimeBridge, /getEmbeddedTermuxPackageWorkflowInputs/);
assert.match(runtimeBridge, /buildTermuxPackageWorkflowInputs/);
assert.match(workflowHelper, /app_data_dir: applicationDataDir/);
assert.match(workflowHelper, /termux_prefix: termuxPrefix/);
assert.match(workflowHelper, /applicationDataDir, filesDir, termuxPrefix/);
assert.match(policy, /if \(tool === "pkg\.ensure"\) return "AIB_TOOL_PRIVATE_PACKAGE_INSTALL_UNSUPPORTED"/);

console.log("AIB_V479_TERMUX_FEED_SELFTEST_OK runtime-derived-workflow-inputs=1 production-feed=blocked_signing_key_unprovisioned feed-key=UNPROVISIONED no-A7EE-or-OpenPGP-key=1 embedded-pkg-install=blocked");
