#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { typescript } from "./test-helpers/load-typescript.mjs";

const root = process.cwd();
const require = createRequire(import.meta.url);
const out = fs.mkdtempSync(path.join(os.tmpdir(), "aib-private-runtime-provider-"));
try {
  const lib = path.join(out, "lib");
  fs.mkdirSync(lib, { recursive: true });
  fs.writeFileSync(path.join(lib, "termux-executor.js"), [
    "exports.calls = [];",
    "exports.executeGuardedTermuxCommand = async (command, options) => {",
    "  exports.calls.push({ command, options });",
    "  return { commandId: 'private-1', stdout: 'private-ok', stderr: '', exitCode: 0, timedOut: false, outputTruncated: false };",
    "};",
  ].join("\n"));
  const source = fs.readFileSync(path.join(root, "lib/private-runtime-provider.ts"), "utf8");
  fs.writeFileSync(path.join(lib, "private-runtime-provider.js"), typescript.transpile(source, {
    module: typescript.ModuleKind.CommonJS,
    target: typescript.ScriptTarget.ES2022,
  }));

  const guarded = require(path.join(lib, "termux-executor.js"));
  const { privateRuntimeProvider, createPrivateRuntimeProvider } = require(path.join(lib, "private-runtime-provider.js"));
  const controller = new AbortController();
  const result = await privateRuntimeProvider.execute("printf private-ok", {
    workdir: "/native-validates-this-private-cwd",
    timeoutMs: 1200,
    signal: controller.signal,
    trustedInternal: true,
    preserveOutput: true,
    traceId: "private-probe-test",
    // Runtime callers cannot redirect this provider; unknown legacy options are ignored.
    executionTarget: "host-termux",
    backend: "termux",
    hostTermux: true,
  });
  assert.equal(result.stdout, "private-ok");
  assert.equal(guarded.calls.length, 1);
  assert.equal(guarded.calls[0].command, "printf private-ok");
  assert.deepEqual(guarded.calls[0].options, {
    executionTarget: "embedded-private",
    workdir: "/native-validates-this-private-cwd",
    timeoutMs: 1200,
    signal: controller.signal,
    trustedInternal: true,
    preserveOutput: true,
    traceId: "private-probe-test",
  });
  assert.equal("backend" in guarded.calls[0].options, false, "external backend selectors never cross the private provider boundary");
  assert.equal("hostTermux" in guarded.calls[0].options, false, "external-Termux opt-in is not part of the private provider contract");

  const failure = new Error("EMBEDDED_EXEC_UNAVAILABLE");
  const failClosed = createPrivateRuntimeProvider(async (_command, options) => {
    assert.equal(options.executionTarget, "embedded-private");
    throw failure;
  });
  await assert.rejects(() => failClosed.execute("true"), (error) => error === failure,
    "private capability failure propagates instead of being retried on another backend");

  console.log("AIB_PRIVATE_RUNTIME_PROVIDER_SELFTEST_OK private-target=forced unsupported-routing-options=dropped native-cwd-validation=delegated errors=fail-closed");
} finally {
  fs.rmSync(out, { recursive: true, force: true });
}
