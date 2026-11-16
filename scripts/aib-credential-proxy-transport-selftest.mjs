#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const javac = spawnSync("javac", ["-version"], { encoding: "utf8" });
if (javac.error || javac.status !== 0) throw new Error("JDK javac is required for the native TCP integration test");
const plugin = fs.readFileSync(path.join(root, "plugins/withAibCredentialProxy.js"), "utf8");
const appConfig = fs.readFileSync(path.join(root, "app.config.ts"), "utf8");
const kotlin = fs.readFileSync(path.join(root, "native/aib-credential-proxy/AibCredentialProxyModule.kt"), "utf8");
const javaSource = fs.readFileSync(path.join(root, "native/aib-credential-proxy/AibCredentialHttpProxyServer.java"), "utf8");
assert.match(plugin, /AibCredentialProxyPackage/);
assert.match(plugin, /AibCredentialHttpProxyServer\.java/);
assert.match(appConfig, /withAibCredentialProxy/);
assert.match(plugin, /withAndroidManifest/);
assert.match(plugin, /android:networkSecurityConfig/);
assert.match(plugin, /base-config cleartextTrafficPermitted="false"/);
assert.match(plugin, /domain-config cleartextTrafficPermitted="true"/);
assert.match(plugin, /<domain includeSubdomains="false">127\.0\.0\.1<\/domain>/);
assert.match(plugin, /<domain includeSubdomains="false">localhost<\/domain>/);
assert.doesNotMatch(plugin, /usesCleartextTraffic["']?\s*[:=]\s*["']?true/i);
assert.match(kotlin, /startProxy\(provider: String, credential: String/);
assert.match(kotlin, /putString\("apiKey", AibCredentialHttpProxyServer\.DUMMY_KEY\)/);
assert.match(javaSource, /InetAddress\.getByName\("127\.0\.0\.1"\)/);
assert.match(javaSource, /PROVIDER_BASES/);
assert.match(javaSource, /bases\.put\("manus", "https:\/\/api\.manus\.ai"\)/);
assert.match(javaSource, /PROXY_MANUS_AUTH_PINNED/);
assert.match(javaSource, /x-manus-api-key/);
assert.match(javaSource, /provider.equals\("manus"\)/);
assert.match(javaSource, /v2\/task/);
assert.match(javaSource, /Transfer-Encoding: chunked/);
assert.match(javaSource, /MAX_REQUEST_BYTES = 32 \* 1024 \* 1024/);
assert.match(javaSource, /UPSTREAM_READ_TIMEOUT_MS = 180_000/);
assert.match(javaSource, /setReadTimeout\(UPSTREAM_READ_TIMEOUT_MS\)/);
assert.doesNotMatch(javaSource, /setReadTimeout\(0\)/, "the upstream socket must not wait forever");
assert.doesNotMatch(javaSource, /System\.out|Log\.[dievw]\(/);

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "aib-proxy-tcp-"));
const harness = String.raw`package com.karat.aibuilder;
import com.sun.net.httpserver.HttpServer;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;
public final class ProxyTransportHarness {
  private static String readLine(InputStream in) throws IOException {
    ByteArrayOutputStream bytes = new ByteArrayOutputStream(); int b;
    while ((b = in.read()) != -1) { if (b == '\n') break; if (b != '\r') bytes.write(b); }
    if (b == -1 && bytes.size() == 0) return null;
    return bytes.toString(StandardCharsets.US_ASCII);
  }
  private static byte[] readChunk(InputStream in) throws IOException {
    String line = readLine(in); if (line == null) throw new IOException("chunk header missing");
    int size = Integer.parseInt(line.trim(), 16);
    if (size == 0) { while (true) { String trailer = readLine(in); if (trailer == null || trailer.isEmpty()) break; } return null; }
    byte[] data = in.readNBytes(size); if (data.length != size) throw new IOException("chunk truncated");
    int cr = in.read(); int lf = in.read();
    if (cr != '\r' || lf != '\n') throw new IOException("chunk terminator invalid size=" + size + " bytes=" + cr + "," + lf + " payloadTail=" + java.util.Arrays.toString(java.util.Arrays.copyOfRange(data, Math.max(0, data.length - 12), data.length)));
    return data;
  }
  public static void main(String[] args) throws Exception {
    final String realKey = "test-secret-never-returned-or-logged";
    final AtomicBoolean authOk = new AtomicBoolean(false);
    final AtomicBoolean customAuthOk = new AtomicBoolean(false);
    final AtomicBoolean largeBodyOk = new AtomicBoolean(false);
    final CountDownLatch releaseSecondChunk = new CountDownLatch(1);
    HttpServer upstream = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
    upstream.createContext("/api/v1/chat/completions", exchange -> {
      authOk.set(("Bearer " + realKey).equals(exchange.getRequestHeaders().getFirst("Authorization")));
      byte[] request = exchange.getRequestBody().readAllBytes();
      if (!new String(request, StandardCharsets.UTF_8).contains("hello")) throw new IOException("request body missing");
      exchange.getResponseHeaders().set("Content-Type", "text/event-stream");
      exchange.sendResponseHeaders(200, 0);
      OutputStream out = exchange.getResponseBody();
      // Redaction holds a bounded look-behind (credential length - 1 bytes) so a
      // secret split across upstream reads can never escape. Send enough safe
      // prefix data to prove streaming before releasing the credential-bearing chunk.
      out.write(("FIRST" + ".".repeat(realKey.length() + 16)).getBytes(StandardCharsets.UTF_8)); out.flush();
      try { releaseSecondChunk.await(4, TimeUnit.SECONDS); } catch (InterruptedException e) { Thread.currentThread().interrupt(); throw new IOException("stream interrupted", e); }
      String secretPrefix = realKey.substring(0, realKey.length() / 2);
      String secretSuffix = realKey.substring(realKey.length() / 2);
      out.write(("SECOND:" + ".".repeat(realKey.length() + 16) + secretPrefix).getBytes(StandardCharsets.UTF_8)); out.flush();
      try { Thread.sleep(150); } catch (InterruptedException e) { Thread.currentThread().interrupt(); throw new IOException("stream interrupted", e); }
      out.write(secretSuffix.getBytes(StandardCharsets.UTF_8)); out.flush(); out.close();
    });
    upstream.createContext("/api/v1/audio/transcriptions", exchange -> {
      customAuthOk.set(realKey.equals(exchange.getRequestHeaders().getFirst("X-API-Key")));
      byte[] request = exchange.getRequestBody().readAllBytes();
      largeBodyOk.set(request.length == 9 * 1024 * 1024 && request[0] == 'm');
      exchange.getResponseHeaders().set("Content-Type", "application/json");
      byte[] response = "{\"text\":\"ok\"}".getBytes(StandardCharsets.UTF_8);
      exchange.sendResponseHeaders(200, response.length);
      try (OutputStream out = exchange.getResponseBody()) { out.write(response); }
    });
    AtomicBoolean manusAuthOk = new AtomicBoolean(false);
    upstream.createContext("/api/v1/v2/task.listMessages", exchange -> {
      manusAuthOk.set(realKey.equals(exchange.getRequestHeaders().getFirst("x-manus-api-key"))
        && exchange.getRequestHeaders().getFirst("Authorization") == null
        && exchange.getRequestHeaders().getFirst("x-api-key") == null
        && "task_id=t&cursor=next%2B%2F".equals(exchange.getRequestURI().getRawQuery()));
      byte[] response = "{\"ok\":true,\"messages\":[]}".getBytes(StandardCharsets.UTF_8);
      exchange.sendResponseHeaders(200, response.length);
      try (OutputStream out = exchange.getResponseBody()) { out.write(response); }
    });
    ExecutorService upstreamExecutor = Executors.newSingleThreadExecutor(); upstream.setExecutor(upstreamExecutor); upstream.start();
    String upstreamBase = "http://127.0.0.1:" + upstream.getAddress().getPort() + "/api/v1";
    AibCredentialHttpProxyServer proxy = new AibCredentialHttpProxyServer("custom.slot1", realKey, upstreamBase, true);
    AibCredentialHttpProxyServer customAuthProxy = new AibCredentialHttpProxyServer("custom.slot1", realKey, upstreamBase, "x-api-key", "raw", true);
    AibCredentialHttpProxyServer manusProxy = new AibCredentialHttpProxyServer("manus", realKey, upstreamBase, "x-manus-api-key", "raw", true);
    AibCredentialHttpProxyServer alternateOpenCode = new AibCredentialHttpProxyServer("opencode", realKey, "https://gateway.example/v1", "authorization", "Bearer");
    try {
      String alternateOpenCodeBase = alternateOpenCode.start();
      if (!alternateOpenCodeBase.startsWith("http://127.0.0.1:")) throw new AssertionError("configured OpenCode HTTPS route was rejected");
      boolean deepSeekOverrideRejected = false;
      try { new AibCredentialHttpProxyServer("deepseek", realKey, "https://api.deepseek.com/v1", "authorization", "Bearer"); }
      catch (IllegalArgumentException expected) { deepSeekOverrideRejected = true; }
      if (!deepSeekOverrideRejected) throw new AssertionError("built-in DeepSeek route override was accepted");
      String base = proxy.start();
      if (!base.startsWith("http://127.0.0.1:") || !base.endsWith("/v1/session/" + proxy.sessionId())) throw new AssertionError("bad loopback session URL");
      byte[] payload = "hello".getBytes(StandardCharsets.UTF_8);
      Socket request = new Socket("127.0.0.1", proxy.port()); request.setSoTimeout(5_000);
      InputStream stream = request.getInputStream(); OutputStream requestOut = request.getOutputStream();
      String requestPath = new URL(base + "/chat/completions").getFile();
      requestOut.write(("POST " + requestPath + " HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer " + AibCredentialHttpProxyServer.DUMMY_KEY + "\r\nContent-Type: text/plain\r\nContent-Length: " + payload.length + "\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
      requestOut.write(payload); requestOut.flush();
      String responseHead = readLine(stream);
      if (responseHead == null || !responseHead.startsWith("HTTP/1.1 200 ")) throw new AssertionError("proxy request failed: " + responseHead);
      boolean chunked = false; String responseHeader;
      while ((responseHeader = readLine(stream)) != null && !responseHeader.isEmpty()) if (responseHeader.equalsIgnoreCase("Transfer-Encoding: chunked")) chunked = true;
      if (!chunked) throw new AssertionError("proxy omitted chunked transfer framing");
      ByteArrayOutputStream streamed = new ByteArrayOutputStream();
      byte[] first = readChunk(stream);
      if (first == null || !new String(first, StandardCharsets.UTF_8).startsWith("FIRST")) throw new AssertionError("first streamed chunk missing");
      streamed.write(first);
      if (releaseSecondChunk.getCount() != 1) throw new AssertionError("upstream completed before first chunk arrived");
      releaseSecondChunk.countDown();
      byte[] next;
      while ((next = readChunk(stream)) != null) streamed.write(next);
      String returnedTail = new String(streamed.toByteArray(), StandardCharsets.UTF_8);
      String secretPrefix = realKey.substring(0, realKey.length() / 2);
      if (!returnedTail.contains("SECOND:") || !returnedTail.contains("[REDACTED]") || returnedTail.contains(realKey) || returnedTail.contains(secretPrefix)) {
        String safeTail = returnedTail.replace(realKey, "[SECRET]").replace(secretPrefix, "[SECRET_PREFIX]");
        throw new AssertionError("stream continuation/credential redaction failed continuation=" + returnedTail.contains("SECOND:") + " redacted=" + returnedTail.contains("[REDACTED]") + " echo=" + returnedTail.contains(realKey) + " prefixEcho=" + returnedTail.contains(secretPrefix) + " tail=" + safeTail);
      }
      request.close();
      if (!authOk.get()) throw new AssertionError("provider credential was not injected upstream");

      // Whisper multipart payloads may exceed the former 8 MiB limit. The native proxy still
      // accepts only the dummy client key, injects the provider x-api-key, and bounds buffering.
      String customBase = customAuthProxy.start();
      URL audioUrl = new URL(customBase + "/audio/transcriptions");
      HttpURLConnection audio = (HttpURLConnection) audioUrl.openConnection();
      audio.setRequestMethod("POST"); audio.setDoOutput(true);
      audio.setRequestProperty("Authorization", "Bearer " + AibCredentialHttpProxyServer.DUMMY_KEY);
      audio.setRequestProperty("Content-Type", "multipart/form-data; boundary=aib-test-boundary");
      byte[] largePayload = new byte[9 * 1024 * 1024]; java.util.Arrays.fill(largePayload, (byte) 'm');
      audio.setFixedLengthStreamingMode(largePayload.length);
      try (OutputStream out = audio.getOutputStream()) { out.write(largePayload); }
      if (audio.getResponseCode() != 200) throw new AssertionError("large audio upload failed");
      audio.getInputStream().close(); audio.disconnect(); java.util.Arrays.fill(largePayload, (byte) 0);
      if (!customAuthOk.get() || !largeBodyOk.get()) throw new AssertionError("custom x-api-key/multipart route failed");

      String manusBase = manusProxy.start();
      HttpURLConnection manus = (HttpURLConnection) new URL(manusBase + "/v2/task.listMessages?task_id=t&cursor=next%2B%2F").openConnection();
      manus.setRequestMethod("GET");
      manus.setRequestProperty("Authorization", "Bearer " + AibCredentialHttpProxyServer.DUMMY_KEY);
      manus.setRequestProperty("x-manus-api-key", "attacker-supplied-header");
      if (manus.getResponseCode() != 200) throw new AssertionError("cloud task-list route failed");
      manus.getInputStream().close(); manus.disconnect();
      if (!manusAuthOk.get()) throw new AssertionError("cloud raw header, auth isolation or cursor encoding failed");
      HttpURLConnection confirmDenied = (HttpURLConnection) new URL(manusBase + "/v2/task.confirmAction").openConnection();
      confirmDenied.setRequestMethod("POST"); confirmDenied.setRequestProperty("Authorization", "Bearer " + AibCredentialHttpProxyServer.DUMMY_KEY);
      if (confirmDenied.getResponseCode() != 404) throw new AssertionError("unsupported action confirmation was accepted"); confirmDenied.disconnect();
      boolean cloudHostDenied = false;
      try { new AibCredentialHttpProxyServer("manus", realKey, "https://attacker.invalid", "x-manus-api-key", "raw"); } catch (IllegalArgumentException expected) { cloudHostDenied = true; }
      if (!cloudHostDenied) throw new AssertionError("cloud host override accepted");
      boolean cloudBearerDenied = false;
      try { new AibCredentialHttpProxyServer("manus", realKey, "https://api.manus.ai", "authorization", "Bearer"); } catch (IllegalArgumentException expected) { cloudBearerDenied = true; }
      if (!cloudBearerDenied) throw new AssertionError("cloud bearer auth accepted");

      HttpURLConnection denied = (HttpURLConnection) new URL(base + "/chat/completions").openConnection(); denied.setRequestMethod("GET"); denied.setRequestProperty("Authorization", "Bearer wrong-key");
      if (denied.getResponseCode() != 401) throw new AssertionError("invalid client key was accepted"); denied.disconnect();
      HttpURLConnection pathDenied = (HttpURLConnection) new URL(base.replace(proxy.sessionId(), "wrong-session") + "/chat/completions").openConnection(); pathDenied.setRequestMethod("GET"); pathDenied.setRequestProperty("Authorization", "Bearer " + AibCredentialHttpProxyServer.DUMMY_KEY);
      if (pathDenied.getResponseCode() != 404) throw new AssertionError("invalid session path was accepted"); pathDenied.disconnect();
      if (base.contains(realKey) || AibCredentialHttpProxyServer.DUMMY_KEY.equals(realKey)) throw new AssertionError("credential leaked into client config");
      System.out.println("AIB_NATIVE_PROXY_JVM_LOOPBACK_OK checks=18 bind=loopback stream=chunked auth=fail-closed echo=redacted multipart=9MiB custom-x-api-key=verified OpenCode-route=HTTPS builtins=immutable cloud-x-manus-api-key=verified cloud-cursor=encoded cloud-confirm=blocked client=java-harness");
    } finally { releaseSecondChunk.countDown(); proxy.close(); customAuthProxy.close(); manusProxy.close(); alternateOpenCode.close(); upstream.stop(0); upstreamExecutor.shutdownNow(); }
  }
}`;
try {
  const harnessPath = path.join(temp, "ProxyTransportHarness.java");
  fs.writeFileSync(harnessPath, harness);
  const source = path.join(root, "native/aib-credential-proxy/AibCredentialHttpProxyServer.java");
  const compile = spawnSync("javac", ["-d", temp, source, harnessPath], { encoding: "utf8", timeout: 30_000 });
  if (compile.error || compile.status !== 0) throw new Error(`native Java compile failed: ${compile.stderr || compile.error}`);
  const run = spawnSync("java", ["-cp", temp, "com.karat.aibuilder.ProxyTransportHarness"], { encoding: "utf8", timeout: 45_000 });
  if (run.error || run.status !== 0) throw new Error(`native proxy TCP test failed: ${run.stderr || run.error || run.stdout}`);
  assert.match(run.stdout, /AIB_NATIVE_PROXY_JVM_LOOPBACK_OK checks=18/);
  console.log("AIB_CREDENTIAL_PROXY_JVM_TRANSPORT_OK RN_TERMUX_PROOT_DEVICE_PATH=NOT_TESTED");
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
