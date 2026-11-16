package com.karat.aibuilder;

import java.io.ByteArrayOutputStream;
import java.io.EOFException;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.SecureRandom;
import java.security.cert.X509Certificate;
import java.util.Base64;
import java.util.ArrayList;
import java.util.List;
import java.util.Collections;
import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;
import javax.net.ssl.KeyManagerFactory;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.TrustManagerFactory;

/** Host-JDK integration smoke for the exact production Java HTTP/CONNECT listener. */
public final class AibInterceptorProxyServerSelfTest {
  private static final String STORE_PASSWORD = "test-pass";

  public static void main(String[] args) throws Exception {
    if (args.length != 1) throw new IllegalArgumentException("Expected temporary PKCS12 path");
    assertFalse(AibInterceptorProxyServer.isPublicAddress(InetAddress.getByName("127.0.0.1")), "loopback must never be public");
    assertTrue(AibInterceptorProxyServer.isPublicAddress(InetAddress.getByName("1.1.1.1")), "public IPv4 literal should pass");
    testDnsAnswerFiltering();
    testHttpAndAuth();
    testOpaqueConnectTunnel();
    testMitmHandshake(args[0]);
    System.out.println("aib-interceptor-native-selftest: PASS (HTTP/auth, bounded body, CONNECT tunnel, explicit-trust HTTPS MITM)");
  }

  private static void testDnsAnswerFiltering() throws Exception {
    List<InetAddress> mixed = new ArrayList<>();
    mixed.add(InetAddress.getByName("127.0.0.1"));
    mixed.add(InetAddress.getByName("10.2.3.4"));
    mixed.add(InetAddress.getByName("169.254.169.254"));
    mixed.add(InetAddress.getByName("fc00::1"));
    mixed.add(InetAddress.getByName("1.1.1.1"));
    List<InetAddress> filtered = AibInterceptorProxyServer.filterPublicAddresses(mixed);
    assertEquals(1, filtered.size(), "DNS answers must retain only public addresses from the pinned connection set");
    assertEquals("1.1.1.1", filtered.get(0).getHostAddress(), "private DNS answers must never be connected");
    try {
      AibInterceptorProxyServer.filterPublicAddresses(mixed.subList(0, 4));
      throw new AssertionError("loopback/private-only DNS answer set must be denied");
    } catch (IOException expected) {
      assertEquals("DNS_PUBLIC_ADDRESS_REQUIRED", expected.getMessage(), "private-only DNS answers fail closed");
    }
  }

  private static void testHttpAndAuth() throws Exception {
    AtomicReference<AibInterceptorProxyServer.ProxyRequest> observed = new AtomicReference<>();
    AibInterceptorProxyServer server = new AibInterceptorProxyServer(request -> {
      observed.set(request);
      return new AibInterceptorProxyServer.ProxyResponse(201, "Created", Collections.singletonMap("content-type", "text/plain"), "echo:" + request.body);
    }, null, false);
    AibInterceptorProxyServer.StartResult started = server.start(freePort());
    try {
      assertEquals("127.0.0.1", started.address, "listener must bind loopback only");
      String unauthorized = httpRequest(started, "GET http://example.test/no-auth HTTP/1.1\r\nHost: example.test\r\n\r\n");
      assertContains(unauthorized, "HTTP/1.1 407", "proxy credentials are mandatory");

      String request = "POST http://example.test/path?q=1 HTTP/1.1\r\n" +
          "Host: example.test\r\n" +
          "Proxy-Authorization: Basic " + basic(started.authToken) + "\r\n" +
          "Content-Type: text/plain\r\nContent-Length: 7\r\nConnection: close\r\n\r\npayload";
      String response = httpRequest(started, request);
      assertContains(response, "HTTP/1.1 201 Created", "HTTP response should return to the client");
      assertContains(response, "echo:payload", "request body should be forwarded to the handler");
      AibInterceptorProxyServer.ProxyRequest captured = observed.get();
      assertEquals("POST", captured.method, "method should be captured");
      assertEquals("http://example.test/path?q=1", captured.url, "absolute-form URL should be normalized");
      assertEquals("payload", captured.body, "request body should be captured");
      assertFalse(captured.headers.containsKey("proxy-authorization"), "proxy password must not reach capture/handler");

      String oversized = httpRequest(started, "POST http://example.test/large HTTP/1.1\r\n" +
          "Proxy-Authorization: Basic " + basic(started.authToken) + "\r\nContent-Length: 256001\r\n\r\n");
      assertContains(oversized, "HTTP/1.1 413", "oversized request must be rejected before body read");
    } finally { server.stop(); }
  }

  private static void testOpaqueConnectTunnel() throws Exception {
    ServerSocket origin = new ServerSocket(0, 10, InetAddress.getByName("127.0.0.1"));
    Thread originThread = new Thread(() -> {
      try (Socket socket = origin.accept()) {
        byte[] data = socket.getInputStream().readNBytes(4);
        if (!"PING".equals(new String(data, StandardCharsets.US_ASCII))) throw new AssertionError("tunnel client bytes mismatch");
        socket.getOutputStream().write("PONG".getBytes(StandardCharsets.US_ASCII)); socket.getOutputStream().flush();
      } catch (Exception error) { throw new RuntimeException(error); }
    }, "aib-test-origin");
    originThread.setDaemon(true); originThread.start();

    AibInterceptorProxyServer server = new AibInterceptorProxyServer(
        request -> new AibInterceptorProxyServer.ProxyResponse(200, "Allowed", Collections.emptyMap(), ""),
        null,
        false,
        host -> {
          if (!"tunnel.test".equals(host)) throw new IOException("TEST_HOST_DENIED");
          return Collections.singletonList(InetAddress.getByName("127.0.0.1"));
        });
    AibInterceptorProxyServer.StartResult started = server.start(freePort());
    try (Socket client = new Socket("127.0.0.1", started.port)) {
      client.setSoTimeout(8000);
      String authority = "tunnel.test:" + origin.getLocalPort();
      String request = "CONNECT " + authority + " HTTP/1.1\r\nHost: " + authority + "\r\nProxy-Authorization: Basic " + basic(started.authToken) + "\r\n\r\n";
      client.getOutputStream().write(request.getBytes(StandardCharsets.ISO_8859_1)); client.getOutputStream().flush();
      String status = readLine(client.getInputStream());
      assertContains(status, "200 Connection Established", "CONNECT tunnel should be established only after admission");
      while (!readLine(client.getInputStream()).isEmpty()) { /* consume CONNECT response headers */ }
      client.getOutputStream().write("PING".getBytes(StandardCharsets.US_ASCII)); client.getOutputStream().flush();
      byte[] response = client.getInputStream().readNBytes(4);
      assertEquals("PONG", new String(response, StandardCharsets.US_ASCII), "opaque tunnel should relay both directions");
    } finally { server.stop(); origin.close(); }
    originThread.join(1000L);
  }

  private static void testMitmHandshake(String keystorePath) throws Exception {
    KeyStore keyStore = KeyStore.getInstance("PKCS12");
    try (InputStream input = new java.io.FileInputStream(keystorePath)) { keyStore.load(input, STORE_PASSWORD.toCharArray()); }
    X509Certificate certificate = (X509Certificate) keyStore.getCertificate("leaf");
    KeyManagerFactory keyManagers = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm());
    keyManagers.init(keyStore, STORE_PASSWORD.toCharArray());
    SSLContext serverContext = SSLContext.getInstance("TLS"); serverContext.init(keyManagers.getKeyManagers(), null, new SecureRandom());

    KeyStore trust = KeyStore.getInstance(KeyStore.getDefaultType()); trust.load(null, null); trust.setCertificateEntry("local-test-ca", certificate);
    TrustManagerFactory trustManagers = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm()); trustManagers.init(trust);
    SSLContext clientContext = SSLContext.getInstance("TLS"); clientContext.init(null, trustManagers.getTrustManagers(), new SecureRandom());

    AibInterceptorProxyServer server = new AibInterceptorProxyServer(
        request -> new AibInterceptorProxyServer.ProxyResponse(200, "OK", Collections.singletonMap("content-type", "text/plain"), "mitm-ok"),
        new AibInterceptorProxyServer.CertificateProvider() {
          @Override public boolean isReady() { return true; }
          @Override public SSLContext createServerContext(String host) throws Exception {
            if (!"example.test".equals(host)) throw new IOException("TEST_HOST_MISMATCH");
            return serverContext;
          }
        }, true);
    AibInterceptorProxyServer.StartResult started = server.start(freePort());
    try (Socket socket = new Socket("127.0.0.1", started.port)) {
      socket.setSoTimeout(10000);
      String connect = "CONNECT example.test:443 HTTP/1.1\r\nHost: example.test:443\r\nProxy-Authorization: Basic " + basic(started.authToken) + "\r\n\r\n";
      socket.getOutputStream().write(connect.getBytes(StandardCharsets.ISO_8859_1)); socket.getOutputStream().flush();
      assertContains(readLine(socket.getInputStream()), "200 Connection Established", "MITM mode should first complete CONNECT");
      while (!readLine(socket.getInputStream()).isEmpty()) { /* consume CONNECT response headers */ }
      SSLSocket tls = (SSLSocket) clientContext.getSocketFactory().createSocket(socket, "example.test", 443, true);
      tls.setSoTimeout(10000); tls.startHandshake();
      String http = "GET /secure HTTP/1.1\r\nHost: example.test:443\r\nConnection: close\r\n\r\n";
      tls.getOutputStream().write(http.getBytes(StandardCharsets.ISO_8859_1)); tls.getOutputStream().flush();
      String response = readHttpResponse(tls);
      assertContains(response, "HTTP/1.1 200 OK", "trusted TLS client should receive intercepted HTTPS response");
      assertContains(response, "mitm-ok", "HTTPS request must reach the response handler after TLS decryption");
      tls.close();
    } finally { server.stop(); }
  }

  private static String httpRequest(AibInterceptorProxyServer.StartResult started, String request) throws Exception {
    try (Socket client = new Socket("127.0.0.1", started.port)) {
      client.setSoTimeout(8000);
      client.getOutputStream().write(request.getBytes(StandardCharsets.ISO_8859_1)); client.getOutputStream().flush();
      return readHttpResponse(client);
    }
  }

  private static String readHttpResponse(Socket socket) throws Exception {
    String status = readLine(socket.getInputStream());
    int contentLength = 0;
    while (true) {
      String line = readLine(socket.getInputStream());
      if (line.isEmpty()) break;
      if (line.toLowerCase().startsWith("content-length:")) contentLength = Integer.parseInt(line.substring(line.indexOf(':') + 1).trim());
    }
    if (contentLength < 0 || contentLength > 256_000) throw new IOException("TEST_RESPONSE_SIZE_INVALID");
    byte[] body = socket.getInputStream().readNBytes(contentLength);
    if (body.length != contentLength) throw new EOFException("TEST_RESPONSE_TRUNCATED");
    return status + "\n" + new String(body, StandardCharsets.UTF_8);
  }

  private static String readLine(InputStream input) throws IOException {
    ByteArrayOutputStream line = new ByteArrayOutputStream();
    while (line.size() < 8192) {
      int value = input.read();
      if (value < 0) throw new EOFException("TEST_LINE_TRUNCATED");
      if (value == '\n') {
        byte[] bytes = line.toByteArray();
        int size = bytes.length > 0 && bytes[bytes.length - 1] == '\r' ? bytes.length - 1 : bytes.length;
        return new String(bytes, 0, size, StandardCharsets.ISO_8859_1);
      }
      line.write(value);
    }
    throw new IOException("TEST_LINE_TOO_LARGE");
  }

  private static int freePort() throws IOException { try (ServerSocket socket = new ServerSocket(0)) { return socket.getLocalPort(); } }
  private static String basic(String token) { return Base64.getEncoder().encodeToString(("aib:" + token).getBytes(StandardCharsets.UTF_8)); }
  private static void assertContains(String text, String expected, String message) { if (text == null || !text.contains(expected)) throw new AssertionError(message); }
  private static void assertEquals(Object expected, Object actual, String message) { if (!expected.equals(actual)) throw new AssertionError(message); }
  private static void assertTrue(boolean value, String message) { if (!value) throw new AssertionError(message); }
  private static void assertFalse(boolean value, String message) { assertTrue(!value, message); }
}
