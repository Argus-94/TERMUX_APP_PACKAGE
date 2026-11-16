package com.karat.aibuilder;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URI;
import java.net.URL;
import java.net.HttpURLConnection;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Arrays;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.HashSet;
import java.util.Collections;
import java.util.HashMap;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

/** Native local-only LLM reverse proxy. It intentionally contains no request/body logging. */
public final class AibCredentialHttpProxyServer implements AutoCloseable {
  public static final String DUMMY_KEY = "dummy-aib-proxy-key";
  // Whisper accepts audio up to 25 MiB; allow bounded multipart framing overhead.
  private static final int MAX_REQUEST_BYTES = 32 * 1024 * 1024;
  // Allow slow model responses while ensuring a silent upstream cannot retain a native worker forever.
  private static final int UPSTREAM_READ_TIMEOUT_MS = 180_000;
  private static final Set<String> FORWARD_HEADERS = Collections.unmodifiableSet(new HashSet<>(Arrays.asList(
    "accept", "content-type", "anthropic-version", "openai-beta", "http-referer", "x-title"
  )));
  private static final Map<String, String> PROVIDER_BASES;
  static {
    HashMap<String, String> bases = new HashMap<>();
    bases.put("manus", "https://api.manus.ai");
    bases.put("openrouter", "https://openrouter.ai/api/v1");
    bases.put("opencode", "https://opencode.ai/zen/v1");
    PROVIDER_BASES = Collections.unmodifiableMap(bases);
  }

  private final String provider;
  private final String upstreamBase;
  private final String authHeader;
  private final String authScheme;
  private final boolean testLoopbackRoute;
  private final String token;
  private final char[] credential;
  private final ThreadPoolExecutor workers;
  private volatile ServerSocket listener;
  private volatile boolean closed;

  public AibCredentialHttpProxyServer(String provider, String credential) {
    this(provider, credential, null, "authorization", "Bearer", null, false);
  }

  /** User-configured routes are accepted only for the two custom slots and OpenCode. */
  public AibCredentialHttpProxyServer(String provider, String credential, String configuredBase, String authHeader, String authScheme) {
    this(provider, credential, configuredBase, authHeader, authScheme, null, false);
  }

  /** Existing JVM test constructor; HTTP is accepted only for an explicitly loopback test upstream. */
  AibCredentialHttpProxyServer(String provider, String credential, String testUpstreamBase, boolean allowLoopbackTest) {
    this(provider, credential, testUpstreamBase, "authorization", "Bearer", testUpstreamBase, allowLoopbackTest);
  }

  /** JVM test-only custom auth header route; never exposed through the React Native module. */
  AibCredentialHttpProxyServer(String provider, String credential, String testUpstreamBase, String testAuthHeader, String testAuthScheme, boolean allowLoopbackTest) {
    this(provider, credential, testUpstreamBase, testAuthHeader, testAuthScheme, testUpstreamBase, allowLoopbackTest);
  }

  private AibCredentialHttpProxyServer(String provider, String credential, String configuredBase, String authHeader, String authScheme, String testUpstreamBase, boolean allowLoopbackTest) {
    this.provider = provider == null ? "" : provider.trim().toLowerCase(Locale.ROOT);
    if (!(this.provider.equals("manus") || this.provider.equals("openrouter") || this.provider.equals("opencode") || this.provider.equals("custom.slot1") || this.provider.equals("custom.slot2"))) throw new IllegalArgumentException("PROXY_PROVIDER_INVALID");
    if (credential == null || credential.trim().isEmpty() || credential.length() > 8192) throw new IllegalArgumentException("PROXY_CONFIGURATION_INVALID");
    this.authHeader = authHeader == null || authHeader.trim().isEmpty() ? "authorization" : authHeader.trim().toLowerCase(Locale.ROOT);
    this.authScheme = authScheme == null || authScheme.trim().isEmpty() ? "Bearer" : authScheme.trim();
    if (!(this.authHeader.equals("authorization") || this.authHeader.equals("x-api-key") || this.authHeader.equals("x-manus-api-key"))) throw new IllegalArgumentException("PROXY_AUTH_HEADER_INVALID");
    if (!(this.authScheme.equalsIgnoreCase("Bearer") || this.authScheme.equalsIgnoreCase("raw"))) throw new IllegalArgumentException("PROXY_AUTH_SCHEME_INVALID");
    if (this.provider.equals("manus") && (!this.authHeader.equals("x-manus-api-key") || !this.authScheme.equalsIgnoreCase("raw"))) throw new IllegalArgumentException("PROXY_MANUS_AUTH_PINNED");

    String builtInBase = PROVIDER_BASES.get(this.provider);
    String base = configuredBase == null || configuredBase.trim().isEmpty() ? builtInBase : configuredBase.trim().replaceAll("/+$", "");
    boolean testRoute = false;
    if (allowLoopbackTest && testUpstreamBase != null) {
      try { URL testUrl = new URL(testUpstreamBase); testRoute = "http".equalsIgnoreCase(testUrl.getProtocol()) && isLoopbackHost(testUrl.getHost()); }
      catch (Exception ignored) { testRoute = false; }
      if (!testRoute) throw new IllegalArgumentException("PROXY_TEST_ROUTE_INVALID");
      base = testUpstreamBase.replaceAll("/+$", "");
    }
    if (base == null || !isSafeProviderBase(base)) throw new IllegalArgumentException("PROXY_ROUTE_INVALID");
    if (!testRoute && builtInBase != null && !builtInBase.equals(base) && !this.provider.equals("opencode")) throw new IllegalArgumentException("PROXY_BUILTIN_ROUTE_OVERRIDE");
    if (!testRoute && builtInBase == null && configuredBase == null) throw new IllegalArgumentException("PROXY_CUSTOM_ROUTE_REQUIRED");
    this.upstreamBase = base;
    this.testLoopbackRoute = testRoute;
    this.credential = credential.toCharArray();
    byte[] random = new byte[24]; new SecureRandom().nextBytes(random);
    StringBuilder hex = new StringBuilder(random.length * 2);
    for (byte b : random) hex.append(String.format(Locale.ROOT, "%02x", b));
    Arrays.fill(random, (byte) 0);
    this.token = hex.toString();
    this.workers = new ThreadPoolExecutor(2, 4, 30L, TimeUnit.SECONDS, new ArrayBlockingQueue<>(32), r -> {
      Thread t = new Thread(r, "aib-credential-proxy-worker"); t.setDaemon(true); return t;
    }, new ThreadPoolExecutor.AbortPolicy());
  }

  private static boolean isSafeProviderBase(String value) {
    try {
      URI uri = URI.create(value);
      if (uri.getUserInfo() != null || uri.getQuery() != null || uri.getFragment() != null || uri.getHost() == null || uri.getPath() == null || uri.getPath().contains("\\")) return false;
      if ("https".equalsIgnoreCase(uri.getScheme())) return true;
      return "http".equalsIgnoreCase(uri.getScheme()) && isLoopbackHost(uri.getHost());
    } catch (RuntimeException e) { return false; }
  }

  private static boolean isLoopbackHost(String host) {
    if (host == null) return false;
    String value = host.toLowerCase(Locale.ROOT);
    return value.equals("127.0.0.1") || value.equals("localhost") || value.equals("[::1]") || value.equals("::1");
  }

  public synchronized String start() throws IOException {
    if (listener != null && !listener.isClosed()) return baseUrl();
    closed = false;
    ServerSocket socket = new ServerSocket(0, 32, InetAddress.getByName("127.0.0.1"));
    socket.setSoTimeout(0);
    listener = socket;
    Thread acceptor = new Thread(() -> acceptLoop(socket), "aib-credential-proxy-listener");
    acceptor.setDaemon(true); acceptor.start();
    return baseUrl();
  }

  public String sessionId() { return token; }
  public int port() { ServerSocket s = listener; return s == null ? -1 : s.getLocalPort(); }
  public String baseUrl() { return "http://127.0.0.1:" + port() + "/v1/session/" + token; }

  private void acceptLoop(ServerSocket socket) {
    while (!closed && !socket.isClosed()) {
      Socket client = null;
      try {
        client = socket.accept();
        client.setSoTimeout(60_000);
        final Socket accepted = client;
        workers.execute(() -> handle(accepted));
        client = null;
      } catch (IOException e) {
        if (client != null) try { client.close(); } catch (IOException ignored) { }
        if (!closed) closeQuietly(socket);
      } catch (RuntimeException e) {
        // Bounded queue exhaustion: reject work without logging request data.
        if (client != null) try { client.close(); } catch (IOException ignored) { }
      }
    }
  }

  private void handle(Socket client) {
    byte[] body = null;
    try (Socket socket = client; InputStream rawIn = new BufferedInputStream(socket.getInputStream()); OutputStream rawOut = new BufferedOutputStream(socket.getOutputStream())) {
      String startLine = readLine(rawIn, 8192);
      if (startLine == null) return;
      String[] parts = startLine.split(" ", 3);
      if (parts.length != 3 || !(parts[0].equals("POST") || parts[0].equals("GET"))) { writeError(rawOut, 405, "Method Not Allowed"); return; }
      Map<String, String> headers = readHeaders(rawIn);
      if (headers == null) { writeError(rawOut, 400, "Bad Request"); return; }
      if (!validClientKey(headers)) { writeError(rawOut, 401, "Unauthorized"); return; }
      URI target;
      try { target = URI.create(parts[1]); } catch (RuntimeException e) { writeError(rawOut, 400, "Bad Request"); return; }
      String prefix = "/v1/session/" + token + "/";
      String rawPath = target.getRawPath();
      if (target.getRawQuery() != null && containsCredentialQuery(target.getRawQuery())) { writeError(rawOut, 400, "Bad Request"); return; }
      if (rawPath == null || !rawPath.startsWith(prefix) || hasTraversal(rawPath)) { writeError(rawOut, 404, "Not Found"); return; }
      String suffix = rawPath.substring(prefix.length());
      if (provider.equals("manus")) {
        boolean allowed = parts[0].equals("GET")
          ? (suffix.equals("v2/user.me") || suffix.equals("v2/task.listMessages") || suffix.equals("v2/task.detail") || suffix.equals("v2/usage.availableCredits"))
          : (suffix.equals("v2/task.create") || suffix.equals("v2/task.sendMessage"));
        if (!allowed) { writeError(rawOut, 404, "Not Found"); return; }
      }
      if (suffix.isEmpty() || suffix.length() > 2048) { writeError(rawOut, 400, "Bad Request"); return; }
      try { body = readBody(rawIn, headers); } catch (IOException e) { writeError(rawOut, 413, "Request Too Large"); return; }
      forward(parts[0], suffix, target.getRawQuery(), headers, body, rawOut);
    } catch (IOException | RuntimeException e) {
      // Disconnect/transport failures are intentionally not logged.
    } finally { if (body != null) Arrays.fill(body, (byte) 0); }
  }

  private boolean containsCredentialQuery(String query) {
    String q = query.toLowerCase(Locale.ROOT);
    for (String part : q.split("&")) {
      String key = part.split("=", 2)[0];
      if (key.matches(".*(key|token|secret|auth|password|credential).*")) return true;
    }
    return false;
  }

  private boolean validClientKey(Map<String, String> headers) {
    String supplied = headers.getOrDefault("authorization", "");
    if (supplied.regionMatches(true, 0, "Bearer ", 0, 7)) supplied = supplied.substring(7).trim();
    if (supplied.isEmpty()) supplied = headers.getOrDefault("x-api-key", "");
    return constantTimeEquals(supplied, DUMMY_KEY);
  }

  private boolean constantTimeEquals(String a, String b) {
    return MessageDigest.isEqual(a.getBytes(java.nio.charset.StandardCharsets.UTF_8), b.getBytes(java.nio.charset.StandardCharsets.UTF_8));
  }

  private boolean hasTraversal(String path) {
    if (path.indexOf('\\') >= 0 || path.indexOf('\0') >= 0) return true;
    String decoded = path.toLowerCase(Locale.ROOT).replace("%2e", ".").replace("%2f", "/").replace("%5c", "\\");
    if (decoded.indexOf('\\') >= 0) return true;
    for (String segment : decoded.split("/")) if (segment.equals("..") || segment.equals(".")) return true;
    return false;
  }

  private Map<String, String> readHeaders(InputStream in) throws IOException {
    java.util.HashMap<String, String> headers = new java.util.HashMap<>();
    int total = 0;
    for (int i = 0; i < 64; i++) {
      String line = readLine(in, 8192);
      if (line == null) return null;
      total += line.length(); if (total > 32768) return null;
      if (line.isEmpty()) return headers;
      int colon = line.indexOf(':'); if (colon <= 0) return null;
      String name = line.substring(0, colon).trim().toLowerCase(Locale.ROOT);
      String value = line.substring(colon + 1).trim();
      if (name.length() > 128 || value.length() > 8192 || name.contains("\0") || value.contains("\0")) return null;
      headers.merge(name, value, (a, b) -> a + "," + b);
    }
    return null;
  }

  private String readLine(InputStream in, int max) throws IOException {
    ByteArrayOutputStream bytes = new ByteArrayOutputStream();
    int b;
    while ((b = in.read()) != -1) {
      if (b == '\n') break;
      if (b != '\r') { if (bytes.size() >= max) throw new IOException("LINE_TOO_LONG"); bytes.write(b); }
    }
    if (b == -1 && bytes.size() == 0) return null;
    return new String(bytes.toByteArray(), java.nio.charset.StandardCharsets.ISO_8859_1);
  }

  private byte[] readBody(InputStream in, Map<String, String> headers) throws IOException {
    String transfer = headers.getOrDefault("transfer-encoding", "");
    if (transfer.equalsIgnoreCase("chunked")) {
      ByteArrayOutputStream out = new ByteArrayOutputStream();
      while (true) {
        String sizeLine = readLine(in, 128); if (sizeLine == null) throw new IOException("CHUNK_INVALID");
        int semi = sizeLine.indexOf(';'); String sizeText = (semi < 0 ? sizeLine : sizeLine.substring(0, semi)).trim();
        int size; try { size = Integer.parseInt(sizeText, 16); } catch (NumberFormatException e) { throw new IOException("CHUNK_INVALID"); }
        if (size < 0 || out.size() + size > MAX_REQUEST_BYTES) throw new IOException("BODY_TOO_LARGE");
        if (size == 0) { while (true) { String trailer = readLine(in, 4096); if (trailer == null || trailer.isEmpty()) break; } return out.toByteArray(); }
        byte[] chunk = readExactly(in, size); if (chunk.length != size) throw new IOException("CHUNK_TRUNCATED");
        out.write(chunk); Arrays.fill(chunk, (byte) 0);
        String end = readLine(in, 8); if (end == null || !end.isEmpty()) throw new IOException("CHUNK_INVALID");
      }
    }
    long length = 0;
    try { length = Long.parseLong(headers.getOrDefault("content-length", "0")); } catch (NumberFormatException e) { throw new IOException("LENGTH_INVALID"); }
    if (length < 0 || length > MAX_REQUEST_BYTES) throw new IOException("BODY_TOO_LARGE");
    byte[] body = readExactly(in, (int) length);
    if (body.length != length) throw new IOException("BODY_TRUNCATED");
    return body;
  }

  private byte[] readExactly(InputStream in, int length) throws IOException {
    byte[] out = new byte[length]; int offset = 0;
    while (offset < length) { int n = in.read(out, offset, length - offset); if (n < 0) break; offset += n; }
    return offset == length ? out : Arrays.copyOf(out, offset);
  }

  private void forward(String method, String path, String query, Map<String, String> headers, byte[] body, OutputStream clientOut) throws IOException {
    String target = upstreamBase + "/" + path + (query == null ? "" : "?" + query);
    HttpURLConnection connection = null;
    boolean responseStarted = false;
    try {
      URL url = new URL(target);
      boolean loopbackHttp = "http".equalsIgnoreCase(url.getProtocol()) && isLoopbackHost(url.getHost());
      if ((!("https".equalsIgnoreCase(url.getProtocol()) || loopbackHttp)) || !url.getHost().equalsIgnoreCase(new URL(upstreamBase).getHost())) { writeError(clientOut, 502, "Bad Gateway"); return; }
      String builtInBase = PROVIDER_BASES.get(provider);
      if (builtInBase != null && !upstreamBase.equals(builtInBase) && !testLoopbackRoute) { writeError(clientOut, 502, "Bad Gateway"); return; }
      connection = (HttpURLConnection) url.openConnection();
      connection.setInstanceFollowRedirects(false);
      connection.setConnectTimeout(15_000); connection.setReadTimeout(UPSTREAM_READ_TIMEOUT_MS); connection.setRequestMethod(method);
      for (String name : FORWARD_HEADERS) { String value = headers.get(name); if (value != null) connection.setRequestProperty(name, value); }
      String secret = new String(credential);
      String authValue = authScheme.equalsIgnoreCase("raw") || !authHeader.equals("authorization") ? secret : "Bearer " + secret;
      connection.setRequestProperty(authHeader, authValue);
      secret = null; authValue = null;
      if (method.equals("POST")) { connection.setDoOutput(true); connection.setFixedLengthStreamingMode(body.length); try (OutputStream upstreamOut = connection.getOutputStream()) { upstreamOut.write(body); upstreamOut.flush(); } }
      int status = connection.getResponseCode();
      String reason = connection.getResponseMessage();
      responseStarted = true;
      writeResponseHead(clientOut, status, reason, connection);
      InputStream upstreamIn = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
      if (upstreamIn != null) {
        try (InputStream stream = upstreamIn) {
          streamRedacted(stream, clientOut);
        }
      }
      clientOut.write("0\r\n\r\n".getBytes(java.nio.charset.StandardCharsets.US_ASCII)); clientOut.flush();
    } catch (IOException | RuntimeException e) {
      // A second status line after a committed chunked head corrupts framing and may expose details.
      if (!responseStarted) writeError(clientOut, 502, "Bad Gateway");
    } finally { if (connection != null) connection.disconnect(); }
  }

  private void writeResponseHead(OutputStream out, int status, String reason, HttpURLConnection connection) throws IOException {
    String cleanReason = reason == null ? "Response" : reason.replaceAll("[\\r\\n]", " ");
    out.write(("HTTP/1.1 " + status + " " + cleanReason + "\r\n").getBytes(java.nio.charset.StandardCharsets.US_ASCII));
    String contentType = connection.getContentType(); if (contentType != null) out.write(("Content-Type: " + contentType.replaceAll("[\\r\\n]", "") + "\r\n").getBytes(java.nio.charset.StandardCharsets.ISO_8859_1));
    for (String name : new String[] { "Cache-Control", "Retry-After" }) { String value = connection.getHeaderField(name); if (value != null) out.write((name + ": " + value.replaceAll("[\\r\\n]", "") + "\r\n").getBytes(java.nio.charset.StandardCharsets.ISO_8859_1)); }
    out.write("Transfer-Encoding: chunked\r\nConnection: close\r\n\r\n".getBytes(java.nio.charset.StandardCharsets.US_ASCII)); out.flush();
  }

  private void writeChunk(OutputStream out, byte[] bytes, int length) throws IOException {
    out.write(Integer.toHexString(length).getBytes(java.nio.charset.StandardCharsets.US_ASCII)); out.write("\r\n".getBytes(java.nio.charset.StandardCharsets.US_ASCII)); out.write(bytes, 0, length); out.write("\r\n".getBytes(java.nio.charset.StandardCharsets.US_ASCII));
  }

  /** Stream supported text/JSON/SSE responses while removing any exact credential echo. */
  private void streamRedacted(InputStream input, OutputStream output) throws IOException {
    byte[] needle = new String(credential).getBytes(java.nio.charset.StandardCharsets.UTF_8);
    byte[] replacement = "[REDACTED]".getBytes(java.nio.charset.StandardCharsets.US_ASCII);
    byte[] chunk = new byte[8192];
    ByteArrayOutputStream pending = new ByteArrayOutputStream();
    try {
      int read;
      while ((read = input.read(chunk)) != -1) {
        if (read == 0) continue;
        pending.write(chunk, 0, read);
        byte[] data = pending.toByteArray();
        int searchableEnd = Math.max(0, data.length - needle.length + 1);
        int cursor = 0;
        int emitted = 0;
        while (cursor < searchableEnd) {
          if (matchesAt(data, cursor, needle)) {
            writeChunk(output, data, emitted, cursor - emitted);
            writeChunk(output, replacement, replacement.length);
            cursor += needle.length;
            emitted = cursor;
          } else {
            cursor++;
          }
        }
        int carryStart = Math.max(searchableEnd, emitted);
        writeChunk(output, data, emitted, carryStart - emitted);
        output.flush();
        pending.reset();
        if (carryStart < data.length) pending.write(data, carryStart, data.length - carryStart);
        Arrays.fill(data, (byte) 0);
      }
      byte[] tail = pending.toByteArray();
      if (tail.length > 0) writeChunk(output, tail, tail.length);
      Arrays.fill(tail, (byte) 0);
    } finally {
      Arrays.fill(needle, (byte) 0);
      Arrays.fill(replacement, (byte) 0);
      Arrays.fill(chunk, (byte) 0);
      byte[] remaining = pending.toByteArray();
      Arrays.fill(remaining, (byte) 0);
      pending.reset();
    }
  }

  private boolean matchesAt(byte[] data, int offset, byte[] needle) {
    if (offset < 0 || offset + needle.length > data.length) return false;
    int mismatch = 0;
    for (int i = 0; i < needle.length; i++) mismatch |= data[offset + i] ^ needle[i];
    return mismatch == 0;
  }

  private void writeChunk(OutputStream out, byte[] data, int offset, int length) throws IOException {
    if (length <= 0) return;
    out.write(Integer.toHexString(length).getBytes(java.nio.charset.StandardCharsets.US_ASCII));
    out.write("\r\n".getBytes(java.nio.charset.StandardCharsets.US_ASCII));
    out.write(data, offset, length);
    out.write("\r\n".getBytes(java.nio.charset.StandardCharsets.US_ASCII));
  }

  private void writeError(OutputStream out, int status, String text) throws IOException {
    byte[] body = text.getBytes(java.nio.charset.StandardCharsets.UTF_8);
    out.write(("HTTP/1.1 " + status + " " + text + "\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: " + body.length + "\r\nConnection: close\r\n\r\n").getBytes(java.nio.charset.StandardCharsets.US_ASCII)); out.write(body); out.flush();
  }

  private void closeQuietly(ServerSocket socket) { try { socket.close(); } catch (IOException ignored) { } }

  @Override public synchronized void close() {
    closed = true; ServerSocket socket = listener; listener = null; if (socket != null) closeQuietly(socket);
    workers.shutdownNow(); Arrays.fill(credential, '\0');
  }
}
