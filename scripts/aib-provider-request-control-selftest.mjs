#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const tmp = mkdtempSync(path.join(os.tmpdir(), "aib-provider-request-control-"));
try {
  const compile = spawnSync("pnpm", ["exec", "tsc", "--target", "ES2022", "--module", "commonjs", "--lib", "ES2022,DOM", "--strict", "--outDir", tmp, "lib/provider-request-control.ts"], { cwd: root, encoding: "utf8" });
  assert.equal(compile.status, 0, `provider request helper compile failed:\n${compile.stdout}\n${compile.stderr}`);
  const { withProviderRequestControl } = await import(pathToFileURL(path.join(tmp, "provider-request-control.js")));

  assert.equal(await withProviderRequestControl(async () => "ok", { timeoutMs: 100 }), "ok");
  const networkError = new Error("Network request failed");
  await assert.rejects(withProviderRequestControl(async () => { throw networkError; }, { timeoutMs: 100 }), (error) => error === networkError);

  let timeoutSignalAborted = false;
  await assert.rejects(
    withProviderRequestControl((signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => { timeoutSignalAborted = true; reject(new Error("fetch aborted")); }, { once: true })), { timeoutMs: 20 }),
    (error) => error?.name === "TimeoutError" && error?.code === "PROVIDER_TIMEOUT" && error?.message === "PROVIDER_TIMEOUT",
  );
  assert.equal(timeoutSignalAborted, true, "internal abort signal must be delivered on timeout");

  const caller = new AbortController();
  let callerSignalAborted = false;
  const pending = withProviderRequestControl((signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => { callerSignalAborted = true; reject(new Error("fetch aborted")); }, { once: true })), { timeoutMs: 1_000, signal: caller.signal });
  await new Promise((resolve) => setImmediate(resolve));
  caller.abort();
  await assert.rejects(pending, (error) => error?.name === "AbortError" && error?.code === "PROVIDER_ABORTED" && error?.message === "ABORTED");
  assert.equal(callerSignalAborted, true, "caller abort must be forwarded to the request signal");

  const alreadyCancelled = new AbortController();
  alreadyCancelled.abort();
  let preAbortedOperationStarted = false;
  await assert.rejects(withProviderRequestControl(() => { preAbortedOperationStarted = true; return "unexpected"; }, { timeoutMs: 100, signal: alreadyCancelled.signal }), (error) => error?.code === "PROVIDER_ABORTED");
  assert.equal(preAbortedOperationStarted, false, "a pre-aborted request must not start its transport callback");

  const nonCooperativeStart = Date.now();
  await assert.rejects(withProviderRequestControl(() => new Promise(() => {}), { timeoutMs: 20 }), (error) => error?.code === "PROVIDER_TIMEOUT");
  assert.ok(Date.now() - nonCooperativeStart < 500, "timeout must settle even when the transport ignores AbortSignal");
  console.log("AIB_PROVIDER_REQUEST_CONTROL_OK timeout=20ms caller_abort=forwarded network_error=preserved");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

function pathToFileURL(file) {
  return new URL(`file://${file}`);
}
