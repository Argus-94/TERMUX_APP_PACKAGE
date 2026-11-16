package com.karat.aibuilder

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.ReadableType
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import okhttp3.Dns
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okio.Buffer
import java.io.IOException
import java.net.InetAddress
import java.net.URI
import java.net.UnknownHostException
import java.nio.ByteBuffer
import java.nio.charset.StandardCharsets
import java.nio.charset.CodingErrorAction
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import okhttp3.Response as OkHttpResponse

class AibInterceptorProxyModule(private val app: ReactApplicationContext) : ReactContextBaseJavaModule(app) {
  private data class Pending(var response: AibInterceptorProxyServer.ProxyResponse? = null, val latch: CountDownLatch = CountDownLatch(1))

  private val lock = Any()
  private val io = Executors.newFixedThreadPool(4) { task -> Thread(task, "aib-interceptor-native").apply { isDaemon = true } }
  private val pending = ConcurrentHashMap<String, Pending>()
  private val certificateStore = AibInterceptorCertificateStore(app)
  @Volatile private var server: AibInterceptorProxyServer? = null

  private val upstreamClient: OkHttpClient by lazy {
    OkHttpClient.Builder()
      .followRedirects(false)
      .followSslRedirects(false)
      .protocols(listOf(Protocol.HTTP_1_1))
      .connectTimeout(10, TimeUnit.SECONDS)
      .readTimeout(20, TimeUnit.SECONDS)
      .callTimeout(25, TimeUnit.SECONDS)
      .dns(object : Dns {
        override fun lookup(hostname: String): List<InetAddress> = try {
          // Return only this single resolution's public addresses. OkHttp connects to this
          // immutable address list; TLS still validates the original hostname normally.
          AibInterceptorProxyServer.resolvePublicAddresses(hostname)
        } catch (_: IOException) {
          throw UnknownHostException("DNS_PUBLIC_ADDRESS_REQUIRED")
        }
      })
      .build()
  }

  override fun getName(): String = "AibInterceptorProxy"

  @com.facebook.react.bridge.ReactMethod
  fun addListener(eventName: String) { /* NativeEventEmitter contract. */ }

  @com.facebook.react.bridge.ReactMethod
  fun removeListeners(count: Int) { /* NativeEventEmitter contract. */ }

  @com.facebook.react.bridge.ReactMethod
  fun startProxy(port: Int, mitmEnabled: Boolean, promise: Promise) {
    io.execute {
      try {
        synchronized(lock) {
          if (server != null) throw IllegalStateException("PROXY_ALREADY_RUNNING")
          val candidate = AibInterceptorProxyServer(
            AibInterceptorProxyServer.RequestHandler { request -> dispatchToJavaScript(request) },
            certificateStore,
            mitmEnabled,
          )
          val started = candidate.start(port)
          server = candidate
          val result = Arguments.createMap().apply {
            putString("address", started.address)
            putInt("port", started.port)
            putBoolean("verified", started.address == "127.0.0.1")
            putString("authToken", started.authToken)
          }
          promise.resolve(result)
        }
      } catch (error: Throwable) {
        promise.reject("PROXY_START_FAILED", safeCode(error))
      }
    }
  }

  @com.facebook.react.bridge.ReactMethod
  fun stopProxy(promise: Promise) {
    io.execute {
      try {
        stopResources()
        promise.resolve(null)
      } catch (_: Throwable) {
        promise.reject("PROXY_STOP_FAILED", "The local proxy could not be stopped cleanly.")
      }
    }
  }

  override fun invalidate() {
    stopResources()
    io.shutdownNow()
    super.invalidate()
  }

  private fun stopResources() {
    releasePending()
    synchronized(lock) { server?.stop(); server = null }
  }

  @com.facebook.react.bridge.ReactMethod
  fun respond(requestId: String, response: ReadableMap, promise: Promise) {
    if (requestId.length !in 1..80) { promise.resolve(false); return }
    val item = pending[requestId]
    if (item == null) { promise.resolve(false); return }
    try {
      item.response = parseProxyResponse(response)
      item.latch.countDown()
      promise.resolve(true)
    } catch (_: Throwable) {
      item.response = AibInterceptorProxyServer.ProxyResponse(502, "Invalid interceptor response", emptyMap(), "The interceptor response was invalid.")
      item.latch.countDown()
      promise.resolve(false)
    }
  }

  @com.facebook.react.bridge.ReactMethod
  fun fetchUpstream(request: ReadableMap, promise: Promise) {
    io.execute {
      try {
        val response = performPinnedUpstreamRequest(request)
        promise.resolve(response)
      } catch (_: Throwable) {
        // Do not propagate raw URLs, headers, certificates, or body data into JS errors/logs.
        promise.reject("UPSTREAM_NETWORK_FAILED", "The validated upstream request failed.")
      }
    }
  }

  @com.facebook.react.bridge.ReactMethod
  fun generateAndStoreCertificate(promise: Promise) {
    io.execute {
      try {
        val result = certificateStore.generateAndStore()
        promise.resolve(Arguments.createMap().apply {
          putString("fingerprint", result.fingerprint)
          putString("subject", result.subject)
        })
      } catch (_: Throwable) { promise.reject("CA_CREATE_FAILED", "The local CA could not be created or loaded.") }
    }
  }

  @com.facebook.react.bridge.ReactMethod
  fun exportPublicCertificate(promise: Promise) {
    io.execute {
      try {
        val result = certificateStore.exportPublicCertificate()
        promise.resolve(Arguments.createMap().apply {
          putString("pem", result.pem)
          putString("fingerprint", result.fingerprint)
          putString("subject", result.subject)
        })
      } catch (_: Throwable) { promise.reject("CA_EXPORT_FAILED", "The public CA certificate is unavailable.") }
    }
  }

  @com.facebook.react.bridge.ReactMethod
  fun checkCertificateTrust(promise: Promise) { promise.resolve(certificateStore.checkTrust()) }

  @com.facebook.react.bridge.ReactMethod
  fun removeCertificate(promise: Promise) {
    io.execute {
      try { certificateStore.remove(); promise.resolve(null) }
      catch (_: Throwable) { promise.reject("CA_REMOVE_FAILED", "The app-managed CA key could not be removed.") }
    }
  }

  private fun dispatchToJavaScript(request: AibInterceptorProxyServer.ProxyRequest): AibInterceptorProxyServer.ProxyResponse {
    if (!app.hasActiveReactInstance()) return AibInterceptorProxyServer.ProxyResponse(503, "App unavailable", emptyMap(), "The interceptor UI is not active.")
    if (pending.size >= MAX_PENDING) return AibInterceptorProxyServer.ProxyResponse(503, "Proxy busy", emptyMap(), "The proxy is at its request limit.")
    val waiting = Pending()
    if (pending.putIfAbsent(request.id, waiting) != null) return AibInterceptorProxyServer.ProxyResponse(503, "Request collision", emptyMap(), "The request could not be correlated.")
    try {
      val event = Arguments.createMap().apply {
        putString("requestId", request.id)
        putString("url", request.url)
        putString("method", request.method)
        putString("body", request.body)
        val headerMap = Arguments.createMap()
        request.headers.forEach { (key, value) -> headerMap.putString(key, value) }
        putMap("headers", headerMap)
      }
      app.runOnJSQueueThread {
        if (app.hasActiveReactInstance()) {
          app.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            .emit(REQUEST_EVENT, event)
        } else {
          waiting.response = AibInterceptorProxyServer.ProxyResponse(503, "App unavailable", emptyMap(), "The interceptor UI is not active.")
          waiting.latch.countDown()
        }
      }
      if (!waiting.latch.await(JS_TIMEOUT_SECONDS, TimeUnit.SECONDS)) return AibInterceptorProxyServer.ProxyResponse(504, "Interceptor timeout", emptyMap(), "The interceptor handler did not respond in time.")
      return waiting.response ?: AibInterceptorProxyServer.ProxyResponse(502, "Missing interceptor response", emptyMap(), "The interceptor did not provide a response.")
    } catch (_: InterruptedException) {
      Thread.currentThread().interrupt()
      return AibInterceptorProxyServer.ProxyResponse(503, "Proxy stopped", emptyMap(), "The request was cancelled.")
    } finally {
      pending.remove(request.id)
    }
  }

  private fun releasePending() {
    pending.values.forEach { item ->
      item.response = AibInterceptorProxyServer.ProxyResponse(503, "Proxy stopped", emptyMap(), "The request was cancelled.")
      item.latch.countDown()
    }
    pending.clear()
  }

  private fun parseProxyResponse(value: ReadableMap): AibInterceptorProxyServer.ProxyResponse {
    val status = if (value.hasKey("status") && value.getType("status") == ReadableType.Number) value.getInt("status") else 502
    val statusText = if (value.hasKey("statusText") && value.getType("statusText") == ReadableType.String) value.getString("statusText") else ""
    val body = if (value.hasKey("body") && value.getType("body") == ReadableType.String) value.getString("body") ?: "" else ""
    if (status !in 100..599 || body.toByteArray(StandardCharsets.UTF_8).size > MAX_BODY_BYTES) throw IllegalArgumentException("RESPONSE_INVALID")
    val headers = linkedMapOf<String, String>()
    if (value.hasKey("headers") && value.getType("headers") == ReadableType.Map) {
      val source = value.getMap("headers")
      val keys = source?.keySetIterator()
      while (keys?.hasNextKey() == true) {
        val key = keys.nextKey()
        if (source.getType(key) != ReadableType.String) continue
        val headerValue = source.getString(key) ?: continue
        if (!HEADER_NAME.matches(key) || headerValue.length > MAX_HEADER_VALUE || headerValue.any { it == '\r' || it == '\n' || it == '\u0000' }) continue
        headers[key] = headerValue
        if (headers.size >= MAX_HEADERS) break
      }
    }
    return AibInterceptorProxyServer.ProxyResponse(status, statusText, headers, body)
  }

  private fun performPinnedUpstreamRequest(input: ReadableMap): WritableMap {
    val url = requiredString(input, "url", 4096)
    val method = requiredString(input, "method", 20).uppercase(Locale.ROOT)
    if (!METHOD.matches(method)) throw IllegalArgumentException("METHOD_INVALID")
    val uri = URI(url)
    if (uri.scheme !in setOf("http", "https") || uri.host.isNullOrBlank() || uri.rawUserInfo != null || uri.rawFragment != null) throw IllegalArgumentException("URL_INVALID")
    val bodyText = if (input.hasKey("body") && input.getType("body") == ReadableType.String) input.getString("body") ?: "" else ""
    val bodyBytes = bodyText.toByteArray(StandardCharsets.UTF_8)
    if (bodyBytes.size > MAX_BODY_BYTES) throw IllegalArgumentException("BODY_TOO_LARGE")
    val headers = input.getMap("headers")
    val builder = Request.Builder().url(url)
    if (headers != null) {
      val keys = headers.keySetIterator()
      while (keys.hasNextKey()) {
        val name = keys.nextKey()
        if (!HEADER_NAME.matches(name) || name.lowercase(Locale.ROOT) in HOP_HEADERS) continue
        if (headers.getType(name) != ReadableType.String) continue
        val value = headers.getString(name) ?: continue
        if (value.length > MAX_HEADER_VALUE || value.any { it == '\r' || it == '\n' || it == '\u0000' }) continue
        builder.addHeader(name, value)
      }
    }
    val contentType = headers?.let { map ->
      val keys = map.keySetIterator()
      var found: String? = null
      while (keys.hasNextKey()) { val name = keys.nextKey(); if (name.equals("content-type", true) && map.getType(name) == ReadableType.String) found = map.getString(name) }
      found
    }?.toMediaTypeOrNull()
    val requestBody = when {
      method in BODY_METHODS -> bodyBytes.toRequestBody(contentType)
      bodyBytes.isNotEmpty() -> bodyBytes.toRequestBody(contentType)
      else -> null
    }
    val call = upstreamClient.newCall(builder.method(method, requestBody).build())
    return call.execute().use { response -> responseToMap(response) }
  }

  private fun responseToMap(response: OkHttpResponse): WritableMap {
    val buffer = Buffer()
    val source = response.body?.source()
    if (source != null) {
      var total = 0L
      while (true) {
        val read = source.read(buffer, 8192)
        if (read == -1L) break
        total += read
        if (total > MAX_BODY_BYTES) throw IOException("UPSTREAM_BODY_TOO_LARGE")
      }
    }
    val bodyBytes = buffer.readByteArray()
    val bodyText = try {
      StandardCharsets.UTF_8.newDecoder()
        .onMalformedInput(CodingErrorAction.REPORT)
        .onUnmappableCharacter(CodingErrorAction.REPORT)
        .decode(ByteBuffer.wrap(bodyBytes))
        .toString()
    } catch (_: Exception) {
      bodyBytes.fill(0)
      throw IOException("UPSTREAM_BINARY_BODY_UNSUPPORTED")
    }
    bodyBytes.fill(0)
    val headers = Arguments.createMap()
    val groups = linkedMapOf<String, MutableList<String>>()
    for (index in 0 until response.headers.size) {
      val name = response.headers.name(index)
      val value = response.headers.value(index)
      if (name.lowercase(Locale.ROOT) in HOP_HEADERS || name.equals("content-length", true)) continue
      groups.getOrPut(name.lowercase(Locale.ROOT)) { mutableListOf() }.add(value.take(MAX_HEADER_VALUE))
    }
    groups.forEach { (name, values) -> headers.putString(name, values.joinToString(", ").take(MAX_HEADER_VALUE)) }
    return Arguments.createMap().apply {
      putInt("status", response.code)
      putString("statusText", response.message.take(120))
      putMap("headers", headers)
      putString("body", bodyText)
    }
  }

  private fun requiredString(map: ReadableMap, key: String, max: Int): String {
    if (!map.hasKey(key) || map.getType(key) != ReadableType.String) throw IllegalArgumentException("REQUEST_INVALID")
    return (map.getString(key) ?: throw IllegalArgumentException("REQUEST_INVALID")).also { if (it.isBlank() || it.length > max) throw IllegalArgumentException("REQUEST_INVALID") }
  }

  private fun safeCode(error: Throwable): String = when (error.message) {
    "MITM_CA_UNAVAILABLE" -> "MITM_CA_UNAVAILABLE"
    "PROXY_PORT_INVALID" -> "PROXY_PORT_INVALID"
    "PROXY_ALREADY_RUNNING" -> "PROXY_ALREADY_RUNNING"
    else -> "PROXY_START_FAILED"
  }

  companion object {
    private const val REQUEST_EVENT = "aibInterceptorRequest"
    private const val JS_TIMEOUT_SECONDS = 22L
    private const val MAX_PENDING = 16
    private const val MAX_BODY_BYTES = 256_000
    private const val MAX_HEADERS = 100
    private const val MAX_HEADER_VALUE = 8192
    private val METHOD = Regex("[A-Z!#$%&'*+.^_`|~0-9-]{1,20}")
    private val HEADER_NAME = Regex("[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}")
    private val BODY_METHODS = setOf("POST", "PUT", "PATCH", "PROPPATCH", "REPORT")
    private val HOP_HEADERS = setOf("host", "content-length", "connection", "proxy-connection", "proxy-authorization", "proxy-authenticate", "keep-alive", "te", "trailer", "transfer-encoding", "upgrade")
  }
}
