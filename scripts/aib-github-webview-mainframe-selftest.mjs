#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classifyGithubToolEventUrl, createGithubToolMessageParser, createGithubToolOnMessage, routeGithubToolMessage } from "../lib/github-tool-bridge-host.ts";
import { EXPECTED_RN_WEBVIEW_VERSION, PATCH_MARKER, patchReactNativeWebViewSource } from "./aib-patch-rn-webview-postmessage.mjs";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const nativeJavaPath = path.join(root, "node_modules/react-native-webview/android/src/main/java/com/reactnativecommunity/webview/RNCWebView.java");
const version = JSON.parse(fs.readFileSync(path.join(root, "node_modules/react-native-webview/package.json"), "utf8")).version;
assert.equal(version, EXPECTED_RN_WEBVIEW_VERSION, "the patch is version-pinned to the installed React Native WebView dependency");
const installed = fs.readFileSync(nativeJavaPath, "utf8");
assert.ok(installed.includes(PATCH_MARKER), "postinstall must patch the installed Android WebMessageListener source");
assert.match(installed, /if \(!isMainFrame\)\s*\{\s*return;/, "foreign/same-origin subframe postMessages are dropped natively");
assert.match(installed, /String documentUrl = view\.getUrl\(\)/, "the native callback uses the full current WebView document URL");
assert.match(installed, /sourceIsOpaque[\s\S]*?localDocument[\s\S]*?localFileOrigin/, "opaque/local source origin is accepted only with a local top-level document");
assert.match(installed, /onMessage\(message\.getData\(\), documentUrl\)/, "native callback supplies document URL rather than origin serialization");
assert.doesNotMatch(installed, /onMessage\(message\.getData\(\), sourceOrigin\.toString\(\)\)/, "origin-only metadata no longer enters the document-path parser");

const upstreamSnippet = `public void onPostMessage(@NonNull WebView view, @NonNull WebMessageCompat message, @NonNull Uri sourceOrigin, boolean isMainFrame, @NonNull JavaScriptReplyProxy replyProxy) {\n                RNCWebView.this.onMessage(message.getData(), sourceOrigin.toString());\n              }`;
const transformed = patchReactNativeWebViewSource(upstreamSnippet, version);
assert.equal(transformed.changed, true, "the pinned upstream source snippet is transformed once");
assert.ok(transformed.source.includes(PATCH_MARKER));
assert.equal(patchReactNativeWebViewSource(transformed.source, version).changed, false, "the patch is idempotent");
assert.throws(() => patchReactNativeWebViewSource(upstreamSnippet, "13.14.0"), /Unsupported react-native-webview version/);
assert.throws(() => patchReactNativeWebViewSource("unrecognized upstream source", version), /Expected exactly one/);

// Contract model for the exact guard emitted above. It receives only an Android callback's main-frame bit,
// source origin and current WebView URL; route/parser remain the production implementations below.
function nativeDelivery({ isMainFrame, sourceOrigin, documentUrl, data }) {
  if (!isMainFrame || typeof documentUrl !== "string" || !documentUrl) return null;
  const localDocument = /^file:/i.test(documentUrl);
  const sourceIsOpaque = sourceOrigin === "null";
  const localFileOrigin = /^file:\/\//i.test(sourceOrigin) && !/^file:\/\/[^/]/i.test(sourceOrigin);
  if (!localDocument || !(sourceIsOpaque || localFileOrigin)) return null;
  return { nativeEvent: { url: documentUrl, data } };
}

const diagnostics = [];
const replies = [];
const nativeWrites = [];
const canonicalPage = "file:///android_asset/github-tool/repos.html";
const requestId = "lqf8nv0p-a1b2c3d4:c1";
const message = JSON.stringify({ type: "secretSet", id: requestId, documentId: "lqf8nv0p-a1b2c3d4", name: "unzipgit_token", value: "synthetic-secret-never-logged" });
const route = (event) => routeGithubToolMessage(event, {
  parseMessage: createGithubToolMessageParser((stage) => diagnostics.push(stage)),
  reply: (id, result) => replies.push([id, result]),
  native: { async secretSetResult(name, value) { nativeWrites.push([name, value]); return { saved: true, stage: "verified" }; } },
  stage: (stage) => diagnostics.push(stage),
});
const onMessage = createGithubToolOnMessage(() => canonicalPage, route, (stage) => diagnostics.push(stage));

const trustedEvent = nativeDelivery({ isMainFrame: true, sourceOrigin: "file://", documentUrl: canonicalPage, data: message });
assert.ok(trustedEvent, "an active packaged main-frame message obtains its exact document URL");
assert.equal(classifyGithubToolEventUrl(trustedEvent.nativeEvent.url), "trusted_asset");
await onMessage(trustedEvent);
assert.equal(nativeWrites.length, 1, "trusted page secretSet reaches the production host router/native contract");
assert.equal(nativeWrites[0][0], "unzipgit_token");
assert.equal(nativeWrites[0][1], "synthetic-secret-never-logged");
assert.deepEqual(replies, [[requestId, "1"]], "success returns only after mocked native verified save result");
assert.ok(diagnostics.some((stage) => stage.startsWith(`message.parse.accepted messageType=secretSet correlation=${requestId}`)));
assert.ok(diagnostics.some((stage) => stage === `secretSet.native.stage=verified correlation=${requestId}`));

const foreignFrame = nativeDelivery({ isMainFrame: false, sourceOrigin: "https://foreign.invalid", documentUrl: canonicalPage, data: message });
assert.equal(foreignFrame, null, "a foreign frame is rejected by the native main-frame-only bridge before JS routing");
const foreignPage = nativeDelivery({ isMainFrame: true, sourceOrigin: "https://foreign.invalid", documentUrl: "https://foreign.invalid/page", data: message });
assert.equal(foreignPage, null, "a foreign top-level page never enters this local-only bridge callback");
const originMismatch = nativeDelivery({ isMainFrame: true, sourceOrigin: "https://foreign.invalid", documentUrl: canonicalPage, data: message });
assert.equal(originMismatch, null, "a foreign source origin cannot be re-labeled with a current local URL");
const malformedMainDocument = nativeDelivery({ isMainFrame: true, sourceOrigin: "file://", documentUrl: "file:///android_asset/other-app/page.html", data: message });
assert.ok(malformedMainDocument, "native local boundary allows local main-frame URL to reach JS for exact parser validation");
await onMessage(malformedMainDocument);
assert.equal(nativeWrites.length, 1, "strict packaged-path parser rejects non-GitHub local documents");
assert.equal(replies.length, 1, "rejected local document receives no router reply");

const brokenJson = nativeDelivery({ isMainFrame: true, sourceOrigin: "file://", documentUrl: canonicalPage, data: "{" });
await onMessage(brokenJson);
assert.equal(nativeWrites.length, 1, "malformed message remains fail-closed even from a trusted packaged page");
assert.ok(diagnostics.some((stage) => stage.includes("message.parse.rejected trust=trusted messageType=unknown")));
const diagnosticText = diagnostics.join("\n");
for (const forbidden of ["synthetic-secret-never-logged", "foreign.invalid", "other-app", "unzipgit_token", "Authorization"]) {
  assert.equal(diagnosticText.includes(forbidden), false, `diagnostics exclude payload, URL, name, and header text (${forbidden})`);
}
console.log("AIB_GITHUB_WEBVIEW_MAINFRAME_SELFTEST_OK native_patch=version-pinned main-frame-only current-document-url origin-match=local parser=unchanged trusted-secretSet=accepted foreign-page/frame=denied malformed=denied redaction=pass");
