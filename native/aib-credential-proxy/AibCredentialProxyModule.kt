package com.karat.aibuilder

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.util.concurrent.ConcurrentHashMap

/** React Native control plane. The key enters only this in-app proxy and is never returned to JS. */
class AibCredentialProxyModule(context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
  private val sessions = ConcurrentHashMap<String, AibCredentialHttpProxyServer>()
  override fun getName(): String = "AibCredentialProxy"

  @ReactMethod
  fun startProxy(provider: String, credential: String, baseUrl: String?, authHeader: String?, authScheme: String?, promise: Promise) {
    try {
      if (credential.isBlank()) throw IllegalArgumentException("CREDENTIAL_MISSING")
      val server = AibCredentialHttpProxyServer(provider, credential, baseUrl, authHeader, authScheme)
      val baseUrl = server.start()
      sessions[server.sessionId()] = server
      val result = Arguments.createMap().apply {
        putString("sessionId", server.sessionId())
        putString("baseUrl", baseUrl)
        putString("apiKey", AibCredentialHttpProxyServer.DUMMY_KEY)
      }
      promise.resolve(result)
    } catch (_: Exception) {
      promise.reject("PROXY_START_FAILED", "Local credential proxy could not be started")
    }
  }

  @ReactMethod
  fun stopProxy(sessionId: String, promise: Promise) {
    val server = sessions.remove(sessionId)
    server?.close()
    promise.resolve(server != null)
  }

  override fun invalidate() {
    sessions.values.forEach { try { it.close() } catch (_: Exception) { } }
    sessions.clear()
    super.invalidate()
  }
}
