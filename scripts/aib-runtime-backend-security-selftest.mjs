#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { typescript } from "./test-helpers/load-typescript.mjs";

const root = process.cwd();
const require = createRequire(import.meta.url);
const ts = typescript;
const out = fs.mkdtempSync(path.join(os.tmpdir(), "aib-backend-auth-"));
const files = [
  "core/enhancements/auth/types.ts",
  "core/enhancements/auth/AgentAuthProxyAccess.ts",
  "core/enhancements/auth/CredentialProxy.ts",
  "core/enhancements/isolation/HardenedProotOptions.ts",
  "core/container/ProotCommandBuilder.ts",
  "core/runtime/RuntimeBackend.ts",
  "core/runtime/backends/TermuxNativeBackend.ts",
  "core/runtime/backends/ProotDistroBackend.ts",
  "lib/proot-distro-state.ts",
];
try {
  for (const rel of files) {
    const dest = path.join(out, rel.replace(/\.ts$/, ".js"));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, ts.transpile(fs.readFileSync(path.join(root, rel), "utf8"), { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }));
  }
  const { TermuxNativeBackend } = require(path.join(out, "core/runtime/backends/TermuxNativeBackend.js"));
  const { ProotDistroBackend } = require(path.join(out, "core/runtime/backends/ProotDistroBackend.js"));
  const { ProotCommandError } = require(path.join(out, "core/container/ProotCommandBuilder.js"));
  const rawEnv = {
    OPENROUTER_API_KEY: "provider-secret-must-not-appear",
    OPENROUTER_BASE_URL: "https://attacker.invalid/v1",
    ANTHROPIC_API_KEY: "another-secret-must-not-appear",
    SAFE_VALUE: "visible",
  };
  const token = "a".repeat(48);
  const proxy = { provider: "openrouter", sessionId: token, baseUrl: `http://127.0.0.1:32123/v1/session/${token}`, apiKey: "dummy-aib-proxy-key" };

  let termuxCommand = "";
  const termux = new TermuxNativeBackend(async (command) => { termuxCommand = command; return { exitCode: 0, stdout: "ok" }; });
  await termux.exec({ command: "printf ok", env: rawEnv });
  assert.ok(termuxCommand.includes("SAFE_VALUE='visible'"));
  assert.ok(!termuxCommand.includes("provider-secret-must-not-appear"));
  assert.ok(!termuxCommand.includes("attacker.invalid"));
  assert.ok(!termuxCommand.includes("dummy-aib-proxy-key"), "no dummy proxy config without an active session");

  await termux.exec({ command: "printf ok", env: rawEnv, credentialProxy: proxy });
  assert.ok(termuxCommand.includes("OPENROUTER_API_KEY='dummy-aib-proxy-key'"));
  assert.ok(termuxCommand.includes(`OPENROUTER_BASE_URL='${proxy.baseUrl}'`));
  assert.ok(!termuxCommand.includes("provider-secret-must-not-appear"));

  let prootCommand = "";
  const proot = new ProotDistroBackend(async (command) => { prootCommand = command; return { exitCode: 0, stdout: "ok" }; });
  let probeCommand = "";
  const probeBackend = new ProotDistroBackend(async (command) => {
    probeCommand = command;
    return {
      exitCode: 0,
      stdout: [
        "AIB_PROBE_BEGIN",
        "AIB_PROOT_TOOL:AVAILABLE",
        "AIB_HOST_UNAME:aarch64",
        "AIB_LIST_EXIT:0",
        "AIB_LIST_BEGIN",
        "Installed distributions:",
        "debian (bookworm)",
        "ubuntu (noble)",
        "AIB_LIST_END",
        "AIB_LOGIN_EXIT:0",
        "AIB_LOGIN_BEGIN",
        "AIB_PROBE_ID:debian",
        "AIB_PROBE_UID:0",
        "AIB_PROBE_UNAME:aarch64",
        "AIB_LOGIN_END",
        "AIB_PROBE_END",
      ].join("\n"),
    };
  });
  assert.equal((await probeBackend.probe()).health, "ready");
  assert.match(probeCommand, /proot-distro login debian -- sh -c 'grep -m1/);
  assert.ok(probeCommand.includes("AIB_PROBE_ID:"), "identity probe returns a fixed parseable marker");
  assert.doesNotMatch(probeCommand, /sh -lc/, "read-only probes must not source login files");
  await proot.exec({ command: "printf ok", env: rawEnv, hardening: { nofile: 48, nproc: 24 } });
  assert.match(prootCommand, /SAFE_VALUE=.*visible/);
  assert.ok(!prootCommand.includes("provider-secret-must-not-appear"));
  assert.ok(!prootCommand.includes("attacker.invalid"));
  assert.ok(prootCommand.includes("ulimit -n 48"));
  assert.ok(prootCommand.includes("ulimit -u 24"));
  assert.ok(!prootCommand.includes("dummy-aib-proxy-key"));

  await proot.exec({ command: "printf ok", env: rawEnv, credentialProxy: proxy, hardening: { nofile: 48, nproc: 24 } });
  assert.ok(prootCommand.includes(proxy.baseUrl));
  assert.match(prootCommand, /OPENROUTER_API_KEY=.*dummy-aib-proxy-key/);
  assert.ok(!prootCommand.includes("provider-secret-must-not-appear"));
  assert.ok(!prootCommand.includes("attacker.invalid"));

  await assert.rejects(() => proot.exec({ command: "true", credentialProxy: { ...proxy, baseUrl: "https://evil.invalid/" } }), (error) => error instanceof ProotCommandError && error.code === "PROXY_CLIENT_CONFIGURATION_INVALID");
  console.log("AIB_RUNTIME_BACKEND_SECURITY_SELFTEST_OK assertions=19 backends=termux,proot");
} finally {
  fs.rmSync(out, { recursive: true, force: true });
}
