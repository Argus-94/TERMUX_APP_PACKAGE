#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const EXPECTED_RN_WEBVIEW_VERSION = "13.15.0";
export const PATCH_MARKER = "AIB_GITHUB_MAIN_FRAME_URL_PATCH_V272_01";
const SOURCE_CALL = "RNCWebView.this.onMessage(message.getData(), sourceOrigin.toString());";
const REPLACEMENT = `// ${PATCH_MARKER}: origin is not a document URL; keep the strict JS asset-path trust gate.
                // WebMessageListener injects into matching frames, so never route a subframe message.
                if (!isMainFrame) {
                    return;
                }
                String documentUrl = view.getUrl();
                if (documentUrl == null) {
                    return;
                }
                android.net.Uri documentUri = android.net.Uri.parse(documentUrl);
                String documentScheme = documentUri.getScheme();
                String sourceScheme = sourceOrigin.getScheme();
                boolean sourceIsOpaque = "null".equals(sourceOrigin.toString());
                boolean localDocument = "file".equalsIgnoreCase(documentScheme);
                boolean localFileOrigin = "file".equalsIgnoreCase(sourceScheme)
                        && sourceOrigin.getHost() == null
                        && documentUri.getHost() == null;
                if (!localDocument || !(sourceIsOpaque || localFileOrigin)) {
                    return;
                }
                RNCWebView.this.onMessage(message.getData(), documentUrl);`;

export function patchReactNativeWebViewSource(source, version) {
  if (version !== EXPECTED_RN_WEBVIEW_VERSION) {
    throw new Error(`Unsupported react-native-webview version ${String(version)}; expected ${EXPECTED_RN_WEBVIEW_VERSION}`);
  }
  if (typeof source !== "string") throw new Error("react-native-webview Android source is not text");
  if (source.includes(PATCH_MARKER)) {
    if (!source.includes("if (!isMainFrame)") || !source.includes("onMessage(message.getData(), documentUrl)")) {
      throw new Error("react-native-webview source contains an incomplete GitHub bridge patch");
    }
    return { source, changed: false };
  }
  const count = source.split(SOURCE_CALL).length - 1;
  if (count !== 1) throw new Error(`Expected exactly one react-native-webview sourceOrigin callback, found ${count}`);
  const patched = source.replace(SOURCE_CALL, REPLACEMENT);
  if (!patched.includes(PATCH_MARKER) || patched.includes(SOURCE_CALL)) {
    throw new Error("Could not verify the react-native-webview main-frame URL patch");
  }
  return { source: patched, changed: true };
}

export function applyReactNativeWebViewPatch(projectRoot = process.cwd()) {
  const packageJsonPath = path.join(projectRoot, "node_modules/react-native-webview/package.json");
  const javaPath = path.join(projectRoot, "node_modules/react-native-webview/android/src/main/java/com/reactnativecommunity/webview/RNCWebView.java");
  if (!fs.existsSync(packageJsonPath) || !fs.existsSync(javaPath)) {
    throw new Error("react-native-webview Android source is missing; refusing to leave GitHub bridge unpatched");
  }
  const version = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")).version;
  const original = fs.readFileSync(javaPath, "utf8");
  const result = patchReactNativeWebViewSource(original, version);
  if (result.changed) fs.writeFileSync(javaPath, result.source, "utf8");
  return { version, changed: result.changed, javaPath };
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  try {
    const result = applyReactNativeWebViewPatch();
    console.log(`AIB_RN_WEBVIEW_MAINFRAME_PATCH_${result.changed ? "APPLIED" : "ALREADY_PRESENT"} version=${result.version} marker=${PATCH_MARKER}`);
  } catch (error) {
    console.error(`[aib-webview-patch] ${error instanceof Error ? error.message : "AIB_WEBVIEW_PATCH_FAILED"}`);
    process.exitCode = 1;
  }
}
