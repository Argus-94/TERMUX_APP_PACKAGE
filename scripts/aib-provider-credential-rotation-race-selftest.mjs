#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const authDir = path.join(root, "core/enhancements/auth");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "aib-credential-rotation-race-"));
try {
  const tsc = path.join(root, "node_modules", "typescript", "bin", "tsc");
  const compile = spawnSync(process.execPath, [
    tsc,
    "--target", "ES2022",
    "--module", "CommonJS",
    "--moduleResolution", "Node",
    "--lib", "ES2022,DOM",
    "--skipLibCheck",
    "--outDir", temp,
    "types.ts", "AgentAuthStore.ts", "AgentAuthProxyAccess.ts", "CredentialProxy.ts",
  ], { cwd: authDir, encoding: "utf8", timeout: 30_000 });
  if (compile.error || compile.status !== 0) throw new Error(`auth graph compile failed: ${compile.stderr || compile.error || compile.stdout}`);
  const require = createRequire(import.meta.url);
  const { AgentAuthStore } = require(path.join(temp, "AgentAuthStore.js"));
  const { CredentialProxy, DUMMY_PROXY_API_KEY } = require(path.join(temp, "CredentialProxy.js"));

  class MemorySecureStorage {
    values = new Map();
    async get(key) { return this.values.get(key) ?? null; }
    async set(key, value) { this.values.set(key, value); }
    async delete(key) { this.values.delete(key); }
  }

  const storage = new MemorySecureStorage();
  const authStore = new AgentAuthStore(storage);
  await authStore.setProviderKey("openrouter", "synthetic-old-key");

  let nativeStartCount = 0;
  const nativeCredentials = [];
  const stoppedSessions = [];
  let releaseFirstStart;
  let firstStartEntered;
  const firstStartGate = new Promise((resolve) => { releaseFirstStart = resolve; });
  const firstStartReady = new Promise((resolve) => { firstStartEntered = resolve; });
  const nativeTransport = {
    async start(provider, credential) {
      nativeStartCount += 1;
      nativeCredentials.push({ provider, credential });
      const sessionId = `race-session-${nativeStartCount}`;
      if (nativeStartCount === 1) {
        firstStartEntered();
        await firstStartGate;
      }
      return {
        sessionId,
        baseUrl: `http://127.0.0.1:${43000 + nativeStartCount}/v1/session/${sessionId}`,
        apiKey: DUMMY_PROXY_API_KEY,
      };
    },
    async stop(sessionId) { stoppedSessions.push(sessionId); return true; },
  };
  const requestedUrls = [];
  const proxy = new CredentialProxy(authStore, {
    openrouter: { baseUrl: "https://openrouter.ai/api/v1" },
  }, {
    nativeTransport,
    fetcher: async (input) => {
      requestedUrls.push(String(input));
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  const request = { provider: "openrouter", path: "key", method: "GET" };

  const firstRequest = proxy.forward(request);
  await firstStartReady;
  let mutationRan = false;
  const rotation = proxy.rotateProviderCredential("openrouter", async () => {
    mutationRan = true;
    await authStore.setProviderKey("openrouter", "synthetic-new-key");
  });
  const requestQueuedAfterRotation = proxy.forward(request);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(mutationRan, false, "credential mutation must wait for the in-flight native session start/request");
  assert.deepEqual(stoppedSessions, [], "rotation must not miss a native session that has not yet completed start");

  releaseFirstStart();
  await firstRequest;
  await rotation;
  await requestQueuedAfterRotation;

  assert.equal(nativeStartCount, 2, "a post-rotation request must start a fresh native session");
  assert.deepEqual(nativeCredentials.map((item) => item.credential), ["synthetic-old-key", "synthetic-new-key"]);
  assert.ok(stoppedSessions.includes("race-session-1"), "rotation must stop the old native session before writing the replacement key");
  assert.ok(requestedUrls[0].includes("/v1/session/race-session-1/key"));
  assert.ok(requestedUrls[1].includes("/v1/session/race-session-2/key"));
  assert.equal((await authStore.getProviderKey("openrouter")).configured, true);
  console.log("AIB_PROVIDER_CREDENTIAL_ROTATION_RACE_OK synthetic=only old-session-stopped-before-new-key post-rotation-request=new-session");
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
