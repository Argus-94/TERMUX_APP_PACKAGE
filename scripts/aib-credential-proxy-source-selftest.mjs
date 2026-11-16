#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const plugin = fs.readFileSync(path.join(root, "plugins/withAibCredentialProxy.js"), "utf8");
const moduleSource = fs.readFileSync(path.join(root, "native/aib-credential-proxy/AibCredentialProxyModule.kt"), "utf8");
const server = fs.readFileSync(path.join(root, "native/aib-credential-proxy/AibCredentialHttpProxyServer.java"), "utf8");

assert.match(plugin, /AibCredentialProxyPackage/);
assert.match(plugin, /AibCredentialHttpProxyServer\.java/);
assert.match(moduleSource, /startProxy\(provider: String, credential: String/);
assert.match(server, /UPSTREAM_READ_TIMEOUT_MS\s*=\s*180_000/);
assert.match(server, /setReadTimeout\(UPSTREAM_READ_TIMEOUT_MS\)/);
assert.doesNotMatch(server, /setReadTimeout\(0\)/, "upstream reads must have a finite timeout");
assert.doesNotMatch(server, /System\.out|Log\.[dievw]\(/, "native proxy source must not log raw provider payloads");

console.log("AIB_CREDENTIAL_PROXY_SOURCE_SELFTEST_OK boundedReadTimeout=PASS nativeCompile=NOT_RUN");
