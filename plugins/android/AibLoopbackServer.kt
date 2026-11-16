package __PACKAGE__

import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.concurrent.atomic.AtomicBoolean

/** Loopback-only token-gated HTTP host. Device actions are dispatched to JS, where DevicePolicy audits them. */
internal class AibLoopbackServer(private val dispatch: (String, String, String) -> String) {
  companion object {
    @Volatile var activeServer: AibLoopbackServer? = null
    private const val MAX_HEADER_BYTES = 8192
    private const val MAX_RESPONSE_CHARS = 65_536
    private val ALLOWED_ROUTES = setOf(
      "GET /v1/status", "GET /v1/screen/tree", "GET /v1/adb/list", "GET /v1/virtualdisplay/capture",
      "POST /v1/input/tap", "POST /v1/input/swipe", "POST /v1/input/text", "POST /v1/input/key", "POST /v1/input/click-text",
      "POST /v1/adb/pair", "POST /v1/adb/connect", "POST /v1/files/read", "POST /v1/sensors/read"
    )
  }
  private val running = AtomicBoolean(false)
  @Volatile private var server: ServerSocket? = null
  @Volatile private var worker: Thread? = null
  @Volatile private var secret: ByteArray? = null
  data class Started(val url: String, val token: String)

  @Synchronized fun start(): Started {
    if (running.get()) throw IllegalStateException("DEVICE_BRIDGE_ALREADY_LISTENING")
    val address = InetAddress.getByName("127.0.0.1")
    val socket = ServerSocket(0, 8, address)
    socket.soTimeout = 1000
    val key = ByteArray(32).also { SecureRandom().nextBytes(it) }
    server = socket
    secret = key
    running.set(true)
    activeServer = this
    worker = Thread({ serve(socket) }, "AibLoopbackDeviceBridge").apply { isDaemon = true; start() }
    return Started("http://127.0.0.1:${socket.localPort}", key.joinToString("") { "%02x".format(it) })
  }

  @Synchronized fun stop() {
    running.set(false)
    try { server?.close() } catch (_: Exception) { }
    server = null
    secret?.fill(0)
    secret = null
    if (activeServer === this) activeServer = null
    worker?.interrupt()
    worker = null
  }

  private fun serve(listener: ServerSocket) {
    while (running.get()) {
      try { listener.accept().use { client -> client.soTimeout = 3000; handle(client) } }
      catch (_: java.net.SocketTimeoutException) { }
      catch (_: Exception) { if (!running.get()) break }
    }
  }

  private fun handle(client: Socket) {
    val input = client.getInputStream()
    val headerBytes = readHeaders(input) ?: return respond(client, 400, "{\"error\":\"invalid_request\"}")
    val lines = String(headerBytes, Charsets.US_ASCII).split("\r\n")
    val first = lines.firstOrNull()?.split(' ') ?: return respond(client, 400, "{\"error\":\"invalid_request\"}")
    if (first.size != 3 || first[2] != "HTTP/1.1") return respond(client, 400, "{\"error\":\"invalid_request\"}")
    val method = first[0]
    val path = first[1]
    if (!ALLOWED_ROUTES.contains("$method $path")) return respond(client, 404, "{\"error\":\"endpoint_not_allowed\"}")

    val headers = HashMap<String, String>()
    for (line in lines.drop(1)) {
      if (line.isEmpty()) continue
      val sep = line.indexOf(':')
      if (sep <= 0) return respond(client, 400, "{\"error\":\"invalid_header\"}")
      val name = line.substring(0, sep).trim().lowercase()
      if (headers.containsKey(name)) return respond(client, 400, "{\"error\":\"duplicate_header\"}")
      headers[name] = line.substring(sep + 1).trim()
    }
    if (headers["host"]?.substringBefore(':') != "127.0.0.1") return respond(client, 400, "{\"error\":\"invalid_host\"}")
    if (headers.containsKey("transfer-encoding")) return respond(client, 400, "{\"error\":\"unsupported_encoding\"}")
    val suppliedHeader = headers["authorization"] ?: ""
    if (!suppliedHeader.startsWith("Bearer ")) return respond(client, 401, "{\"error\":\"token_required\"}")
    val supplied = suppliedHeader.removePrefix("Bearer ").toByteArray(Charsets.UTF_8)
    val expected = secret?.let { it.joinToString("") { b -> "%02x".format(b) }.toByteArray(Charsets.UTF_8) } ?: ByteArray(0)
    if (expected.isEmpty() || !MessageDigest.isEqual(expected, supplied)) return respond(client, 403, "{\"error\":\"token_rejected\"}")

    val length = if (method == "POST") headers["content-length"]?.toIntOrNull() ?: -1 else headers["content-length"]?.toIntOrNull() ?: 0
    if (length < 0 || length > 16_384) return respond(client, 413, "{\"error\":\"request_too_large\"}")
    if (method == "POST" && !headers["content-type"].orEmpty().lowercase().startsWith("application/json")) return respond(client, 400, "{\"error\":\"json_required\"}")
    val body = ByteArray(length)
    var offset = 0
    while (offset < length) {
      val n = input.read(body, offset, length - offset)
      if (n <= 0) return respond(client, 400, "{\"error\":\"short_body\"}")
      offset += n
    }

    try {
      val response = dispatch(method, path, String(body, Charsets.UTF_8))
      if (response.length > MAX_RESPONSE_CHARS) return respond(client, 502, "{\"ok\":false,\"error\":\"response_too_large\"}")
      respond(client, 200, response)
    } catch (_: Exception) {
      respond(client, 504, "{\"ok\":false,\"error\":\"device_policy_dispatch_unavailable\"}")
    }
  }

  private fun readHeaders(input: InputStream): ByteArray? {
    val out = ByteArrayOutputStream()
    var state = 0
    while (out.size() < MAX_HEADER_BYTES) {
      val b = input.read()
      if (b < 0) return null
      out.write(b)
      state = when {
        state == 0 && b == 13 -> 1
        state == 1 && b == 10 -> 2
        state == 2 && b == 13 -> 3
        state == 3 && b == 10 -> 4
        b == 13 -> 1
        else -> 0
      }
      if (state == 4) return out.toByteArray()
    }
    return null
  }

  private fun respond(socket: Socket, status: Int, body: String) {
    try {
      val bytes = body.toByteArray(Charsets.UTF_8)
      val phrase = when (status) {
        200 -> "OK"; 400 -> "Bad Request"; 401 -> "Unauthorized"; 403 -> "Forbidden"; 404 -> "Not Found"; 413 -> "Payload Too Large"; 502 -> "Bad Gateway"; 504 -> "Gateway Timeout"; else -> "Error"
      }
      socket.getOutputStream().write("HTTP/1.1 $status $phrase\r\nContent-Type: application/json\r\nContent-Length: ${bytes.size}\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n".toByteArray(Charsets.US_ASCII))
      socket.getOutputStream().write(bytes)
      socket.getOutputStream().flush()
    } catch (_: Exception) { }
  }
}

internal object AibLoopbackLifecycle { fun stop() { AibLoopbackServer.activeServer?.stop() } }
