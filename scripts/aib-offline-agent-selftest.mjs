#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import Module, { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const require = createRequire(import.meta.url);
const tsPath = (() => {
  try { return require.resolve("typescript"); } catch { /* global toolchain */ }
  const globalModules = path.resolve(path.dirname(process.execPath), "../lib/node_modules");
  for (const candidate of [
    path.join(globalModules, "typescript/lib/typescript.js"),
    path.join(globalModules, "graphql-language-service-cli/node_modules/typescript/lib/typescript.js"),
    "/usr/local/lib/node_modules/typescript/lib/typescript.js",
  ]) if (fs.existsSync(candidate)) return candidate;
  throw new Error("TYPESCRIPT_LOADER_UNAVAILABLE");
})();
const ts = require(tsPath);
const cache = new Map();
function resolveTs(parent, request) {
  const base = path.resolve(path.dirname(parent), request);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, path.join(base, "index.ts")]) {
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
  mod.require = (request) => {
    const resolved = request.startsWith(".") ? resolveTs(file, request) : null;
    return resolved ? loadTs(resolved) : createRequire(file)(request);
  };
  const js = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: file,
  }).outputText;
  mod._compile(js, file);
  return mod.exports;
}
const { OfflineAgentRuntime, OfflineAgentError } = loadTs(path.join(root, "core/enhancements/offline/OfflineAgentRuntime.ts"));
function assertCode(code) { return (error) => error instanceof OfflineAgentError && error.code === code; }
const cases = [];
async function scenario(name, fn) {
  await fn();
  cases.push(name);
  console.log(`PASS ${name}`);
}
await scenario("explicit local tool call returns final answer with metadata-only events", async () => {
  const replies = [
    JSON.stringify({ tool_call: { name: "sum", arguments: { a: 2, b: 3 } } }),
    JSON.stringify({ final: "5" }),
  ];
  const events = [];
  const runtime = new OfflineAgentRuntime({
    model: { async chat() { return replies.shift(); } },
    tools: [{ name: "sum", description: "Add two values", execute: ({ a, b }) => Number(a) + Number(b) }],
    onEvent: (event) => events.push(event), now: () => 7,
  });
  assert.equal(await runtime.run({ prompt: "sum" }), "5");
  assert.equal(events.some((event) => event.action === "tool-finished"), true);
  assert.equal(JSON.stringify(events).includes("2"), false, "events must not include tool arguments or results");
});
await scenario("implicit online fallback is impossible", async () => {
  let proxyCalls = 0;
  const runtime = new OfflineAgentRuntime({
    model: { async chat() { throw new Error("native error with sensitive detail"); } },
    hybrid: { enabled: true, credentialProxy: { async complete() { proxyCalls += 1; return "not allowed"; } } },
  });
  await assert.rejects(runtime.run({ prompt: "offline only" }), assertCode("LOCAL_MODEL_FAILED"));
  assert.equal(proxyCalls, 0);
});
await scenario("hybrid online fallback works only with explicit proxy opt-in", async () => {
  let proxyCalls = 0;
  let passedMessages;
  const privateCredentialSentinel = "proxy-secret-must-stay-private";
  const events = [];
  const runtime = new OfflineAgentRuntime({
    model: { async chat() { throw new Error("local failure"); } },
    hybrid: { enabled: true, credentialProxy: { async complete(request) { proxyCalls += 1; passedMessages = request.messages; assert.equal(JSON.stringify(request).includes(privateCredentialSentinel), false); return "online result"; } } },
    onEvent: (event) => events.push(event),
  });
  assert.equal(await runtime.run({ prompt: "hello", allowHybridFallback: true }), "online result");
  assert.equal(proxyCalls, 1);
  assert.equal(JSON.stringify(passedMessages).includes(privateCredentialSentinel), false);
  assert.equal(JSON.stringify(events).includes(privateCredentialSentinel), false);
});
await scenario("secret-like tool result values are redacted before returning to the model", async () => {
  let count = 0;
  let nextHistory = [];
  const runtime = new OfflineAgentRuntime({
    model: { async chat(history) {
      count += 1;
      if (count === 1) return JSON.stringify({ tool_call: { name: "lookup", arguments: {} } });
      nextHistory = history;
      return JSON.stringify({ final: "done" });
    } },
    tools: [{ name: "lookup", description: "Read test metadata", execute: () => ({ password: "correct-horse", token: "fresh-token-value", note: "Bearer abcdefghijklmnop" }) }],
  });
  assert.equal(await runtime.run({ prompt: "inspect" }), "done");
  const visible = JSON.stringify(nextHistory);
  assert.equal(visible.includes("correct-horse"), false);
  assert.equal(visible.includes("fresh-token-value"), false);
  assert.equal(visible.includes("abcdefghijklmnop"), false);
  assert.equal(visible.includes("[REDACTED]"), true);
});
await scenario("invalid JSON tool call fails closed", async () => {
  const runtime = new OfflineAgentRuntime({ model: { async chat() { return "{tool_call:"; } } });
  await assert.rejects(runtime.run({ prompt: "do work" }), assertCode("INVALID_MODEL_RESPONSE"));
});
await scenario("unsupported tool fails closed without executing another capability", async () => {
  let called = false;
  const runtime = new OfflineAgentRuntime({
    model: { async chat() { return JSON.stringify({ tool_call: { name: "shell", arguments: {} } }); } },
    tools: [{ name: "read", description: "Read a value", execute: () => { called = true; return null; } }],
  });
  await assert.rejects(runtime.run({ prompt: "run shell" }), assertCode("UNSUPPORTED_TOOL"));
  assert.equal(called, false);
});
await scenario("excessive tool steps are bounded", async () => {
  let calls = 0;
  const runtime = new OfflineAgentRuntime({
    limits: { maxToolSteps: 1 },
    model: { async chat() { return JSON.stringify({ tool_call: { name: "tick", arguments: {} } }); } },
    tools: [{ name: "tick", description: "Increment test counter", execute: () => { calls += 1; return calls; } }],
  });
  await assert.rejects(runtime.run({ prompt: "loop" }), assertCode("TOOL_STEP_LIMIT"));
  assert.equal(calls, 1);
});
await scenario("AbortSignal cancellation is propagated and observed", async () => {
  const controller = new AbortController();
  const runtime = new OfflineAgentRuntime({ model: { chat(_history, _generation, _language, _system, signal) {
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("stopped")), { once: true }));
  } } });
  const pending = runtime.run({ prompt: "wait", signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, assertCode("ABORTED"));
});
console.log(`aib-offline-agent-selftest: OK (${cases.length} scenarios)`);
