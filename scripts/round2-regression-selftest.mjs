#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (name) => fs.readFileSync(path.join(root, name), "utf8");
let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

check("empty GitHub repository uploads all blobs before one root tree/commit/ref", () => {
  const source = read("assets/github-tool/js/files.js");
  const start = source.indexOf("async function commit(changes, message)");
  const end = source.indexOf("\n    async function ", start + 1);
  assert.ok(start >= 0 && end > start, "commit() definition not located");
  const body = source.slice(start, end);
  for (const marker of [
    "if (!changes.length) return ''",
    "repoBase() + '/git/blobs'",
    "repoBase() + '/git/trees'",
    "repoBase() + '/git/commits'",
    "parents: []",
    "repoBase() + '/git/refs'",
    "S.empty = false",
  ]) assert.ok(body.includes(marker), `missing ${marker}`);
  assert.ok(!body.includes("putContents("), "empty-repo path must not commit files one by one");
});

check("release command prints the actual zip/tar output path, not an unset shell variable", () => {
  const source = read("lib/release-artifact-manager.ts");
  assert.ok(source.includes('"ARCHIVE=" + zipPath'));
  assert.ok(source.includes('"ARCHIVE=" + tarPath'));
  assert.ok(!source.includes('echo "ARCHIVE=$ZIP"'));
  assert.ok(!source.includes('echo "ARCHIVE=$TAR"'));
});

check("explicit long Termux commands retain up to 60 minutes while build default stays 30 minutes", () => {
  const source = read("lib/termux-bridge.ts");
  assert.ok(source.includes("BUILD_TIMEOUT_MS = 9_300_000"));
  assert.ok(source.includes("MAX_COMMAND_TIMEOUT_MS = 10_800_000"));
  assert.ok(source.includes("Math.min(Math.max(1_000, timeout), MAX_COMMAND_TIMEOUT_MS)"));
});

check("local llama cancellation calls native stopCompletion and waits before returning ABORTED", () => {
  const source = read("lib/local-model.ts");
  assert.ok(source.includes("context.stopCompletion()"));
  assert.ok(source.includes("await stopPromise"));
  assert.ok(source.includes('new Error("ABORTED")'));
  assert.ok((source.match(/this\.completionWithSignal\(context,/g) || []).length >= 3);
});

check("OpenRouter passes AbortSignal to fetch and aborts retry backoff", () => {
  const source = read("lib/online-model.ts");
  assert.ok(source.includes("async function callOpenRouterOnce(body: Record<string, unknown>, signal?: AbortSignal, transport: typeof securedProviderFetch = securedProviderFetch)"));
  assert.ok(source.includes("signal: requestSignal,"));
  assert.ok(source.includes("withProviderRequestControl(async (requestSignal)"));
  assert.ok(source.includes("await abortableDelay(delay, signal)"));
  assert.ok(source.includes("modelId: string = ONLINE_MODEL.id,\n    signal?: AbortSignal"));
});

check("Custom Provider passes AbortSignal to Axios, image chat and all retry waits", () => {
  const source = read("lib/custom-provider.ts");
  assert.ok(source.includes("withProviderRequestControl(async (requestSignal)"));
  assert.ok(source.includes("signal: requestSignal"));
  assert.ok(source.includes("}, { timeoutMs: isMimoLike ? 300_000 : 180_000, signal })"));
  assert.ok(source.includes("return this.chat(messages, params, signal)"));
  assert.ok((source.match(/await sleepMs\(delayMs, signal\)/g) || []).length >= 2);
});

check("chat requests route one request controller to every provider family", () => {
  const source = read("hooks/useLLM.ts");
  const start = source.indexOf("const sendMessage = useCallback");
  const end = source.indexOf("\n  const analyzeImage =", start);
  const body = source.slice(start, end);
  assert.ok(body.includes("customProviderEngine.chat(") && body.includes("requestAbortController.signal"));
  assert.ok(body.includes("onlineModelEngine.chat(") && body.includes("requestAbortController.signal"));
  assert.ok(body.includes("localModelEngine.chat(") && body.includes("requestAbortController.signal"));
  assert.ok(body.includes("if (activeGenerationAbortRef.current === requestAbortController)"));
});

check("image-analysis request controller reaches online/custom/local provider calls", () => {
  const source = read("hooks/useLLM.ts");
  const start = source.indexOf("const analyzeImage = useCallback");
  const end = source.indexOf("\n  /**\n   * Full build", start);
  const body = source.slice(start, end);
  for (const marker of ["customProviderEngine.analyzeImage(", "onlineModelEngine.analyzeImage(", "localModelEngine.analyzeImage(", "imageAbortController.signal"]) {
    assert.ok(body.includes(marker), `missing ${marker}`);
  }
  assert.ok(body.includes("if (activeGenerationAbortRef.current === imageAbortController)"));
});

check("Stop aborts model work but retains Termux agent ownership until its finally block", () => {
  const source = read("hooks/useLLM.ts");
  const start = source.indexOf("const stopGeneration = useCallback");
  const end = source.indexOf("\n\n  return {", start);
  const body = source.slice(start, end);
  assert.ok(body.includes("activeController.abort()"));
  assert.ok(body.includes("abortAgentRef.current = true"));
  assert.ok(body.includes("waiting for the current Termux command to return"));
  assert.ok(!body.includes("agentBusyRef.current = false"));
  assert.ok(!body.includes("setAgentSessionId(null)"));
  assert.ok(!body.includes("setTermuxActivity(null)"));
});

check("multiple selected attachments are not silently cleared before processing", () => {
  const source = read("app/index.tsx");
  const start = source.indexOf("const handleSend = useCallback");
  const end = source.indexOf("\n  }, [input, pendingAttachments", start);
  const body = source.slice(start, end);
  const guard = body.indexOf("if (pendingAttachments.length > 1)");
  const clear = body.indexOf("setPendingAttachments([])");
  assert.ok(guard >= 0 && clear > guard, "cardinality guard must precede composer clear");
  assert.ok(body.includes('showDialog(t("oneAttachmentTitle"), t("oneAttachmentBody")'));
});

check("archive transfer failure restores the selected file and draft text", () => {
  const source = read("app/index.tsx");
  const start = source.indexOf('if (attType === "ARCHIVE" || /\\.(zip|apk|aab)$/i.test(attachment.name))');
  assert.ok(start >= 0);
  const body = source.slice(start, start + 650);
  assert.ok(body.includes("setPendingAttachments([attachment])"));
  assert.ok(body.includes("setInput(trimmed)"));
  assert.ok(body.includes("archiveTransferFailedBody"));
});

check("backup verification reads RestorePlan manifest fields and reports the recovery backup path", () => {
  const source = read("app/runtime.tsx");
  assert.ok(source.includes("p.manifest.scope"));
  assert.ok(source.includes("p.manifest.fileCount"));
  assert.ok(source.includes("p.manifest.digest"));
  assert.ok(source.includes("result.preBackupPath"));
});

check("runtime drawer labels use centralized localization and do not remount on locale key", () => {
  const layout = read("app/_layout.tsx");
  const drawer = read("components/DrawerContent.tsx");
  assert.ok(layout.includes('t("runtimeEnvironment")'));
  assert.ok(layout.includes('t("packagesMenu")'));
  assert.ok(!layout.includes('t("showConsole")') && !layout.includes('t("hideConsole")'));
  assert.ok(!layout.includes("TermuxConsoleProvider"));
  assert.ok(drawer.includes('t("runtimeEnvironment")'));
  assert.ok(!layout.includes("key={language}"));
});

console.log(`ROUND2_REGRESSIONS ${passed}/${passed + failed}`);
if (failed) process.exitCode = 1;
