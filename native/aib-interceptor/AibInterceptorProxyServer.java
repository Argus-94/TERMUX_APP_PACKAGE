package com.karat.aibuilder;

import java.io.ByteArrayOutputStream;
import java.io.EOFException;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.Inet4Address;
import java.net.Inet6Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketException;
import java.net.URI;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLParameters;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;

/**
 * Explicit, loopback-only HTTP/1.1 proxy. It accepts one bounded request per socket,
 * supports opaque CONNECT tunnels, and only decrypts HTTPS when the user explicitly
 * enabled MITM and supplied a locally managed CA provider.
 *
 * No request data is written to logs. Unsupported bodies/protocols fail closed.
 */
public final class AibInterceptorProxyServer implements AutoCloseable {
  public interface RequestHandler { ProxyResponse handle(ProxyRequest request); }
  public interface AddressResolver { List<InetAddress> resolve(String host) throws IOException; }
  public interface CertificateProvider {
    boolean isReady();
    SSLContext createServerContext(String host) throws Exception;
  }

  public static final class ProxyRequest {
    public final String id;
    public final String url;
    public final String method;
    public final Map<String, String> headers;
    public final String body;
    ProxyRequest(String id, String url, String method, Map<String, String> headers, String body) {
      this.id = id; this.url = url; this.method = method; this.headers = headers; this.body = body;
    }
  }

  public static final class ProxyResponse {
    public final int status;
    public final String statusText;
    public final Map<String, String> headers;
    public final String body;
    public ProxyResponse(int status, String statusText, Map<String, String> headers, String body) {
      this.status = status; this.statusText = statusText == null ? "" : statusText;
      this.headers = headers == null ? Collections.emptyMap() : headers;
      this.body = body == null ? "" : body;
    }
  }

  public static final class StartResult {
    public final String address;
    public final int port;
    public final String authToken;
    StartResult(String address, int port, String authToken) { this.address = address; this.port = port; this.authToken = authToken; }
  }

  private static final int MAX_LINE_BYTES = 8192;
  private static final int MAX_HEADER_BYTES = 32768;
  private static final int MAX_HEADERS = 100;
  private static final int MAX_BODY_BYTES = 256_000;
  private static final int MAX_CONNECTIONS = 16;
  private static final int CONNECT_TIMEOUT_MS = 10_000;
  private static final int CLIENT_TIMEOUT_MS = 15_000;
  private static final Set<String> HOP_HEADERS = Collections.unmodifiableSet(new HashSet<>(Arrays.asList(
      "connection", "proxy-connection", "proxy-authorization", "proxy-authenticate",
      "keep-alive", "te", "trailer", "transfer-encoding", "upgrade")));
  private static final SecureRandom RANDOM = new SecureRandom();

  private final RequestHandler handler;
  private final CertificateProvider certificates;
  private final boolean mitmEnabled;
  private final AddressResolver addressResolver;
  private final Set<Socket> sockets = ConcurrentHashMap.newKeySet();
  private final AtomicInteger requestIds = new AtomicInteger();
  private volatile boolean running;
  private volatile ServerSocket listener;
  private volatile ExecutorService workers;
  private volatile String authToken;

  public AibInterceptorProxyServer(RequestHandler handler, CertificateProvider certificates, boolean mitmEnabled) {
    this(handler, certificates, mitmEnabled, AibInterceptorProxyServer::resolvePublicAddresses);
  }

  /** Test seam; production constructors always use the public-address validator. */
  public AibInterceptorProxyServer(RequestHandler handler, CertificateProvider certificates, boolean mitmEnabled, AddressResolver addressResolver) {
    if (handler == null) throw new IllegalArgumentException("REQUEST_HANDLER_REQUIRED");
    if (addressResolver == null) throw new IllegalArgumentException("ADDRESS_RESOLVER_REQUIRED");
    this.handler = handler; this.certificates = certificates; this.mitmEnabled = mitmEnabled; this.addressResolver = addressResolver;
  }

  public synchronized StartResult start(int port) throws IOException {
    if (running) throw new IOException("PROXY_ALREADY_RUNNING");
    if (port < 1024 || port > 65535) throw new IOException("PROXY_PORT_INVALID");
    if (mitmEnabled && (certificates == null || !certificates.isReady())) throw new IOException("MITM_CA_UNAVAILABLE");
    ServerSocket socket = new ServerSocket();
    socket.setReuseAddress(false);
    socket.bind(new InetSocketAddress(InetAddress.getByName("127.0.0.1"), port), MAX_CONNECTIONS);
    listener = socket;
    authToken = createToken();
    workers = new ThreadPoolExecutor(2, 8, 30L, TimeUnit.SECONDS,
        new LinkedBlockingQueue<>(MAX_CONNECTIONS), daemonFactory("aib-interceptor"), new ThreadPoolExecutor.AbortPolicy());
    running = true;
    Thread acceptor = daemonFactory("aib-interceptor-accept").newThread(this::acceptLoop);
    acceptor.start();
    return new StartResult(socket.getInetAddress().getHostAddress(), socket.getLocalPort(), authToken);
  }

  public synchronized void stop() {
    running = false;
    ServerSocket current = listener; listener = null;
    if (current != null) try { current.close(); } catch (IOException ignored) {}
    for (Socket socket : sockets) closeQuietly(socket);
    sockets.clear();
    ExecutorService pool = workers; workers = null;
    if (pool != null) pool.shutdownNow();
    authToken = null;
  }

  @Override public void close() { stop(); }

  private void acceptLoop() {
    while (running) {
      Socket client = null;
      try {
        ServerSocket current = listener;
        if (current == null) return;
        client = current.accept();
        if (sockets.size() >= MAX_CONNECTIONS) { writeSimple(client.getOutputStream(), 503, "Proxy capacity reached"); closeQuietly(client); continue; }
        client.setTcpNoDelay(true);
        client.setSoTimeout(CLIENT_TIMEOUT_MS);
        sockets.add(client);
        Socket accepted = client;
        ExecutorService pool = workers;
        if (pool == null) { closeQuietly(client); return; }
        pool.execute(() -> {
          try { handleClient(accepted); }
          catch (Exception ignored) { /* never log request data, URL, headers, or bodies */ }
          finally { sockets.remove(accepted); closeQuietly(accepted); }
        });
      } catch (SocketException closed) {
        if (client != null) { sockets.remove(client); closeQuietly(client); }
        if (!running) return;
      } catch (Exception ignored) {
        if (client != null) { sockets.remove(client); closeQuietly(client); }
        if (!running) return;
      }
    }
  }

  private void handleClient(Socket client) throws Exception {
    ParsedRequest first;
    try { first = readRequest(client.getInputStream(), false, null); }
    catch (IOException invalid) {
      int status = invalid.getMessage() != null && invalid.getMessage().contains("TOO_LARGE") ? 413 : 400;
      writeSimple(client.getOutputStream(), status, status == 413 ? "Proxy request too large" : "Bad proxy request");
      return;
    }
    if (first == null) return;
    if (!authorized(first.headers.get("proxy-authorization"))) {
      writeSimple(client.getOutputStream(), 407, "Proxy authentication required", Collections.singletonMap("proxy-authenticate", "Basic realm=\"AI Builder local proxy\""));
      return;
    }
    if ("CONNECT".equals(first.method)) {
      try { parseConnectAuthority(first.target); }
      catch (IOException invalid) { writeSimple(client.getOutputStream(), 400, "Bad CONNECT request"); return; }
      handleConnect(client, first);
      return;
    }
    URI uri;
    try { uri = parseAbsoluteHttpUri(first.target); }
    catch (IOException invalid) { writeSimple(client.getOutputStream(), 400, "Bad proxy URL"); return; }
    String url = uri.toASCIIString();
    Map<String, String> headers = publicHeaders(first.headers);
    ProxyResponse response = safeHandle(new ProxyRequest(nextId(), url, first.method, headers, first.body));
    writeResponse(client.getOutputStream(), response, "HEAD".equalsIgnoreCase(first.method));
  }

  private void handleConnect(Socket client, ParsedRequest request) throws Exception {
    Authority authority = parseConnectAuthority(request.target);
    String url = "https://" + bracketHost(authority.host) + ":" + authority.port + "/";
    ProxyResponse admission = safeHandle(new ProxyRequest(nextId(), url, "CONNECT", publicHeaders(request.headers), ""));
    if (admission.status < 200 || admission.status >= 300) { writeResponse(client.getOutputStream(), admission, false); return; }

    if (!mitmEnabled) {
      Socket upstream;
      try { upstream = connectPinned(authority.host, authority.port); }
      catch (IOException denied) { writeSimple(client.getOutputStream(), 502, "Upstream connection failed"); return; }
      sockets.add(upstream);
      writeConnectEstablished(client.getOutputStream());
      try { tunnel(client, upstream); }
      finally { sockets.remove(upstream); closeQuietly(upstream); }
      return;
    }

    SSLContext context;
    try { context = certificates.createServerContext(authority.host); }
    catch (Exception denied) { writeSimple(client.getOutputStream(), 502, "Local TLS certificate unavailable"); return; }
    writeConnectEstablished(client.getOutputStream());
    SSLSocket tls = (SSLSocket) context.getSocketFactory().createSocket(client, authority.host, authority.port, true);
    tls.setUseClientMode(false);
    tls.setSoTimeout(CLIENT_TIMEOUT_MS);
    configureHttp11Only(tls);
    tls.startHandshake();
    try {
      ParsedRequest inner = readRequest(tls.getInputStream(), true, authority);
      if (inner == null) return;
      String target = "https://" + bracketHost(authority.host) + ":" + authority.port + inner.target;
      ProxyResponse response = safeHandle(new ProxyRequest(nextId(), target, inner.method, publicHeaders(inner.headers), inner.body));
      writeResponse(tls.getOutputStream(), response, "HEAD".equalsIgnoreCase(inner.method));
    } finally {
      sockets.remove(tls);
      closeQuietly(tls);
    }
  }

  private ProxyResponse safeHandle(ProxyRequest request) {
    try {
      ProxyResponse response = handler.handle(request);
      if (response == null || response.status < 100 || response.status > 599 || response.body.length() > MAX_BODY_BYTES) return new ProxyResponse(502, "Invalid proxy response", Collections.emptyMap(), "Proxy response was invalid.");
      return response;
    } catch (Throwable ignored) {
      return new ProxyResponse(502, "Proxy handler failed", Collections.emptyMap(), "The interceptor handler failed.");
    }
  }

  private boolean authorized(String header) {
    String token = authToken;
    if (token == null || header == null || !header.regionMatches(true, 0, "Basic ", 0, 6)) return false;
    try {
      byte[] decoded = decodeBase64(header.substring(6).trim());
      if (decoded == null) return false;
      byte[] expected = ("aib:" + token).getBytes(StandardCharsets.UTF_8);
      boolean equal = MessageDigest.isEqual(expected, decoded);
      Arrays.fill(decoded, (byte) 0);
      Arrays.fill(expected, (byte) 0);
      return equal;
    } catch (IllegalArgumentException ignored) { return false; }
  }

  private static ParsedRequest readRequest(InputStream input, boolean originForm, Authority expectedAuthority) throws IOException {
    String line = readLine(input, MAX_LINE_BYTES);
    if (line == null || line.isEmpty()) return null;
    String[] parts = line.split(" ", 3);
    if (parts.length != 3 || !parts[2].matches("HTTP/1\\.[01]") || !parts[0].matches("[A-Z!#$%&'*+.^_`|~0-9-]{1,20}")) throw new IOException("HTTP_REQUEST_LINE_INVALID");
    String method = parts[0];
    String target = parts[1];
    if (target.length() > 8192 || containsControl(target)) throw new IOException("HTTP_TARGET_INVALID");

    LinkedHashMap<String, String> headers = new LinkedHashMap<>();
    int total = line.getBytes(StandardCharsets.ISO_8859_1).length + 2;
    for (int count = 0; count < MAX_HEADERS; count++) {
      String headerLine = readLine(input, MAX_LINE_BYTES);
      if (headerLine == null) throw new EOFException("HTTP_HEADERS_TRUNCATED");
      total += headerLine.getBytes(StandardCharsets.ISO_8859_1).length + 2;
      if (total > MAX_HEADER_BYTES) throw new IOException("HTTP_HEADERS_TOO_LARGE");
      if (headerLine.isEmpty()) break;
      int colon = headerLine.indexOf(':');
      if (colon <= 0) throw new IOException("HTTP_HEADER_INVALID");
      String name = headerLine.substring(0, colon).trim().toLowerCase(Locale.ROOT);
      String value = headerLine.substring(colon + 1).trim();
      if (!name.matches("[!#$%&'*+.^_`|~0-9a-z-]{1,128}") || containsControl(value)) throw new IOException("HTTP_HEADER_INVALID");
      headers.merge(name, value, (a, b) -> a + ", " + b);
    }
    if (headers.size() >= MAX_HEADERS) throw new IOException("HTTP_TOO_MANY_HEADERS");

    byte[] body = readBody(input, headers);
    String bodyText = decodeUtf8(body);
    if (originForm) {
      if (!(target.startsWith("/") || target.equals("*")) || target.startsWith("//")) throw new IOException("HTTP_ORIGIN_TARGET_INVALID");
      if (expectedAuthority == null || !hostHeaderMatches(headers.get("host"), expectedAuthority)) throw new IOException("HTTP_HOST_MISMATCH");
    }
    return new ParsedRequest(method, target, headers, bodyText);
  }

  private static byte[] readBody(InputStream input, Map<String, String> headers) throws IOException {
    String transfer = headers.get("transfer-encoding");
    if (transfer != null && !transfer.equalsIgnoreCase("chunked")) throw new IOException("HTTP_TRANSFER_ENCODING_UNSUPPORTED");
    ByteArrayOutputStream body = new ByteArrayOutputStream();
    if ("chunked".equalsIgnoreCase(transfer)) {
      while (true) {
        String chunkLine = readLine(input, 128);
        if (chunkLine == null) throw new EOFException("HTTP_CHUNK_TRUNCATED");
        String sizeToken = chunkLine.split(";", 2)[0].trim();
        long size;
        try { size = Long.parseLong(sizeToken, 16); } catch (NumberFormatException e) { throw new IOException("HTTP_CHUNK_SIZE_INVALID"); }
        if (size < 0 || size > MAX_BODY_BYTES - body.size()) throw new IOException("HTTP_BODY_TOO_LARGE");
        if (size == 0) {
          int trailerBytes = 0;
          for (int i = 0; i < MAX_HEADERS; i++) {
            String trailer = readLine(input, MAX_LINE_BYTES);
            if (trailer == null) throw new EOFException("HTTP_TRAILER_TRUNCATED");
            trailerBytes += trailer.length() + 2;
            if (trailerBytes > MAX_HEADER_BYTES) throw new IOException("HTTP_TRAILERS_TOO_LARGE");
            if (trailer.isEmpty()) return body.toByteArray();
            if (trailer.indexOf(':') <= 0 || containsControl(trailer)) throw new IOException("HTTP_TRAILER_INVALID");
          }
          throw new IOException("HTTP_TOO_MANY_TRAILERS");
        }
        copyExactly(input, body, size);
        expectCrlf(input);
      }
    }
    String contentLength = headers.get("content-length");
    if (contentLength == null) return new byte[0];
    long size;
    try { size = Long.parseLong(contentLength); } catch (NumberFormatException e) { throw new IOException("HTTP_CONTENT_LENGTH_INVALID"); }
    if (size < 0 || size > MAX_BODY_BYTES) throw new IOException("HTTP_BODY_TOO_LARGE");
    copyExactly(input, body, size);
    return body.toByteArray();
  }

  private static URI parseAbsoluteHttpUri(String raw) throws IOException {
    try {
      URI uri = new URI(raw);
      if (!"http".equalsIgnoreCase(uri.getScheme()) || uri.getHost() == null || uri.getUserInfo() != null || uri.getFragment() != null || uri.getPort() == 0 || uri.getPort() > 65535) throw new IOException("HTTP_ABSOLUTE_URI_INVALID");
      return uri;
    } catch (Exception e) { throw new IOException("HTTP_ABSOLUTE_URI_INVALID"); }
  }

  private static Authority parseConnectAuthority(String raw) throws IOException {
    try {
      URI uri = new URI("https://" + raw);
      int port = uri.getPort() == -1 ? 443 : uri.getPort();
      if (uri.getHost() == null || uri.getUserInfo() != null || port < 1 || port > 65535 || uri.getRawPath() != null && !uri.getRawPath().isEmpty() || uri.getQuery() != null || uri.getFragment() != null) throw new IOException("CONNECT_AUTHORITY_INVALID");
      String host = uri.getHost();
      if (host.isEmpty() || host.length() > 253 || containsControl(host)) throw new IOException("CONNECT_HOST_INVALID");
      return new Authority(host, port);
    } catch (Exception e) { throw new IOException("CONNECT_AUTHORITY_INVALID"); }
  }

  private static Map<String, String> publicHeaders(Map<String, String> input) {
    LinkedHashMap<String, String> out = new LinkedHashMap<>();
    for (Map.Entry<String, String> item : input.entrySet()) {
      if (!"proxy-authorization".equalsIgnoreCase(item.getKey()) && !"proxy-authenticate".equalsIgnoreCase(item.getKey())) out.put(item.getKey(), item.getValue());
    }
    return Collections.unmodifiableMap(out);
  }

  private static boolean hostHeaderMatches(String hostHeader, Authority expected) {
    if (hostHeader == null) return false;
    String normalized = hostHeader.trim().toLowerCase(Locale.ROOT);
    String expectedHost = bracketHost(expected.host).toLowerCase(Locale.ROOT);
    return normalized.equals(expectedHost) || normalized.equals(expectedHost + ":" + expected.port);
  }

  private static void writeResponse(OutputStream output, ProxyResponse response, boolean head) throws IOException {
    byte[] body = head || response.status == 204 || response.status == 304 ? new byte[0] : response.body.getBytes(StandardCharsets.UTF_8);
    String reason = cleanReason(response.statusText);
    StringBuilder headerBlock = new StringBuilder("HTTP/1.1 ").append(response.status).append(' ').append(reason).append("\r\n");
    for (Map.Entry<String, String> item : response.headers.entrySet()) {
      String name = item.getKey(); String value = item.getValue();
      boolean authChallenge = response.status == 407 && "proxy-authenticate".equalsIgnoreCase(name);
      if (name == null || value == null || !name.matches("[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}") || containsControl(value) || (HOP_HEADERS.contains(name.toLowerCase(Locale.ROOT)) && !authChallenge) || "content-length".equalsIgnoreCase(name)) continue;
      headerBlock.append(name).append(": ").append(value).append("\r\n");
    }
    headerBlock.append("Content-Length: ").append(body.length).append("\r\nConnection: close\r\n\r\n");
    output.write(headerBlock.toString().getBytes(StandardCharsets.ISO_8859_1));
    output.write(body); output.flush();
  }

  private static void writeSimple(OutputStream output, int status, String message) throws IOException { writeSimple(output, status, message, Collections.emptyMap()); }
  private static void writeSimple(OutputStream output, int status, String message, Map<String, String> extra) throws IOException {
    LinkedHashMap<String, String> headers = new LinkedHashMap<>(extra); headers.put("content-type", "text/plain; charset=utf-8");
    writeResponse(output, new ProxyResponse(status, message, headers, message), false);
  }

  private static void writeConnectEstablished(OutputStream output) throws IOException {
    output.write("HTTP/1.1 200 Connection Established\r\nProxy-Agent: AIBuilder-Local-Debug-Proxy\r\n\r\n".getBytes(StandardCharsets.ISO_8859_1));
    output.flush();
  }

  private static void tunnel(Socket client, Socket upstream) throws IOException {
    Thread reverse = daemonFactory("aib-interceptor-tunnel").newThread(() -> {
      try { copy(upstream.getInputStream(), client.getOutputStream()); }
      catch (IOException ignored) { }
      finally { closeQuietly(client); closeQuietly(upstream); }
    });
    reverse.start();
    try { copy(client.getInputStream(), upstream.getOutputStream()); }
    finally { closeQuietly(client); closeQuietly(upstream); try { reverse.join(1500L); } catch (InterruptedException e) { Thread.currentThread().interrupt(); } }
  }

  private Socket connectPinned(String host, int port) throws IOException {
    IOException last = null;
    for (InetAddress address : addressResolver.resolve(host)) {
      Socket socket = new Socket();
      try { socket.connect(new InetSocketAddress(address, port), CONNECT_TIMEOUT_MS); socket.setSoTimeout(CLIENT_TIMEOUT_MS); socket.setTcpNoDelay(true); return socket; }
      catch (IOException error) { last = error; closeQuietly(socket); }
    }
    throw last == null ? new IOException("UPSTREAM_ADDRESS_DENIED") : new IOException("UPSTREAM_CONNECT_FAILED");
  }

  /** Called by the native OkHttp upstream adapter. The returned addresses are the exact pinned set. */
  public static List<InetAddress> resolvePublicAddresses(String host) throws IOException {
    InetAddress[] resolved;
    try { resolved = InetAddress.getAllByName(host); } catch (Exception e) { throw new IOException("DNS_LOOKUP_FAILED"); }
    return filterPublicAddresses(Arrays.asList(resolved));
  }

  /** Retain only public answers so the client can connect to this exact pinned set. */
  public static List<InetAddress> filterPublicAddresses(List<InetAddress> resolved) throws IOException {
    ArrayList<InetAddress> safe = new ArrayList<>();
    if (resolved != null) for (InetAddress address : resolved) if (isPublicAddress(address)) safe.add(address);
    if (safe.isEmpty()) throw new IOException("DNS_PUBLIC_ADDRESS_REQUIRED");
    return Collections.unmodifiableList(safe);
  }

  public static boolean isPublicAddress(InetAddress address) {
    if (address == null || address.isAnyLocalAddress() || address.isLoopbackAddress() || address.isLinkLocalAddress() || address.isSiteLocalAddress() || address.isMulticastAddress()) return false;
    byte[] b = address.getAddress();
    if (address instanceof Inet4Address && b.length == 4) {
      int a = b[0] & 255, second = b[1] & 255, third = b[2] & 255;
      return !(a == 0 || a == 10 || a == 127 || (a == 100 && second >= 64 && second <= 127) ||
          (a == 169 && second == 254) || (a == 172 && second >= 16 && second <= 31) ||
          (a == 192 && (second == 0 || second == 168) || a == 192 && second == 88 && third == 99) ||
          (a == 198 && (second == 18 || second == 19 || second == 51) || a == 203 && second == 0 && third == 113) || a >= 224);
    }
    if (address instanceof Inet6Address && b.length == 16) {
      int first = b[0] & 255;
      if ((first & 0xE0) != 0x20) return false; // global unicast only: 2000::/3
      if ((b[0] & 255) == 0x20 && (b[1] & 255) == 0x01 && ((b[2] & 255) == 0x0d && (b[3] & 255) == 0xb8 || (b[2] & 255) == 0x00 && (b[3] & 255) == 0x10)) return false;
      if ((b[0] & 255) == 0x20 && (b[1] & 255) == 0x02) return false; // 6to4
      return !((b[0] & 255) == 0x00 && (b[1] & 255) == 0x64 && (b[2] & 255) == 0xff && (b[3] & 255) == 0x9b); // NAT64 well-known prefix
    }
    return false;
  }

  private static String readLine(InputStream input, int maxBytes) throws IOException {
    ByteArrayOutputStream line = new ByteArrayOutputStream();
    int previous = -1;
    while (line.size() <= maxBytes) {
      int next = input.read();
      if (next == -1) { if (line.size() == 0) return null; throw new EOFException("HTTP_LINE_TRUNCATED"); }
      if (previous == '\r' && next == '\n') {
        byte[] bytes = line.toByteArray();
        if (bytes.length == 0 || bytes[bytes.length - 1] != '\r') throw new IOException("HTTP_LINE_INVALID");
        return new String(bytes, 0, bytes.length - 1, StandardCharsets.ISO_8859_1);
      }
      line.write(next); previous = next;
    }
    throw new IOException("HTTP_LINE_TOO_LARGE");
  }

  private static void copyExactly(InputStream input, OutputStream output, long count) throws IOException {
    byte[] buffer = new byte[8192]; long remaining = count;
    while (remaining > 0) { int read = input.read(buffer, 0, (int) Math.min(buffer.length, remaining)); if (read < 0) throw new EOFException("HTTP_BODY_TRUNCATED"); output.write(buffer, 0, read); remaining -= read; }
  }
  private static void expectCrlf(InputStream input) throws IOException { if (input.read() != '\r' || input.read() != '\n') throw new IOException("HTTP_CHUNK_TERMINATOR_INVALID"); }
  private static String decodeUtf8(byte[] body) throws IOException {
    if (body.length == 0) return "";
    try { return StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(body)).toString(); }
    catch (CharacterCodingException e) { throw new IOException("BINARY_BODY_NOT_SUPPORTED"); }
  }
  private static boolean containsControl(String value) { for (int i = 0; i < value.length(); i++) if (value.charAt(i) == 0 || value.charAt(i) == '\r' || value.charAt(i) == '\n' || (value.charAt(i) < 0x20 && value.charAt(i) != '\t')) return true; return false; }
  private static String bracketHost(String host) { return host != null && host.indexOf(':') >= 0 && !host.startsWith("[") ? "[" + host + "]" : host; }
  private static String cleanReason(String value) { String reason = value == null ? "Proxy response" : value.replaceAll("[^A-Za-z0-9 ._-]", " ").trim(); return reason.isEmpty() ? "Proxy response" : reason.substring(0, Math.min(reason.length(), 96)); }
  private static void configureHttp11Only(SSLSocket socket) {
    try {
      SSLParameters parameters = socket.getSSLParameters();
      SSLParameters.class.getMethod("setApplicationProtocols", String[].class).invoke(parameters, (Object) new String[] { "http/1.1" });
      socket.setSSLParameters(parameters);
    } catch (Exception ignored) { /* API < 29 has no public ALPN setter; it negotiates HTTP/1.1 without ALPN. */ }
  }
  private String nextId() { return "native-" + Integer.toString(requestIds.incrementAndGet(), 36); }
  private static String createToken() { byte[] bytes = new byte[24]; RANDOM.nextBytes(bytes); StringBuilder out = new StringBuilder(48); for (byte b : bytes) out.append(String.format(Locale.ROOT, "%02x", b & 255)); Arrays.fill(bytes, (byte) 0); return out.toString(); }
  private static ThreadFactory daemonFactory(String prefix) { AtomicInteger count = new AtomicInteger(); return task -> { Thread thread = new Thread(task, prefix + "-" + count.incrementAndGet()); thread.setDaemon(true); return thread; }; }
  private static void copy(InputStream input, OutputStream output) throws IOException { byte[] buffer = new byte[8192]; int count; while ((count = input.read(buffer)) != -1) { output.write(buffer, 0, count); output.flush(); } }
  private static byte[] decodeBase64(String input) {
    if (input == null || input.isEmpty() || input.length() > 4096 || (input.length() & 3) != 0) return null;
    int padding = input.endsWith("==") ? 2 : input.endsWith("=") ? 1 : 0;
    ByteArrayOutputStream output = new ByteArrayOutputStream((input.length() * 3) / 4);
    int accumulator = 0, bits = 0;
    for (int i = 0; i < input.length(); i++) {
      char c = input.charAt(i);
      if (c == '=') { if (i < input.length() - padding) return null; continue; }
      int value = c >= 'A' && c <= 'Z' ? c - 'A' : c >= 'a' && c <= 'z' ? c - 'a' + 26 : c >= '0' && c <= '9' ? c - '0' + 52 : c == '+' ? 62 : c == '/' ? 63 : -1;
      if (value < 0 || i >= input.length() - padding) return null;
      accumulator = (accumulator << 6) | value;
      bits += 6;
      if (bits >= 8) { bits -= 8; output.write((accumulator >> bits) & 255); }
    }
    if (bits > 0 && (accumulator & ((1 << bits) - 1)) != 0) return null;
    byte[] result = output.toByteArray();
    return result.length == (input.length() * 3) / 4 - padding ? result : null;
  }
  private static void closeQuietly(Socket socket) { if (socket != null) try { socket.close(); } catch (IOException ignored) {} }

  private static final class ParsedRequest {
    final String method; final String target; final Map<String, String> headers; final String body;
    ParsedRequest(String method, String target, Map<String, String> headers, String body) { this.method = method; this.target = target; this.headers = headers; this.body = body; }
  }
  private static final class Authority {
    final String host; final int port;
    Authority(String host, int port) { this.host = host; this.port = port; }
  }
}
