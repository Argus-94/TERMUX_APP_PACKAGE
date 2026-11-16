const { withDangerousMod, withMainApplication, withAndroidManifest } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

function bridgeKotlin(pkg) {
  return `package ${pkg}

import android.content.Context
import android.content.Intent
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Uri
import android.os.Build
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.webkit.ValueCallback
import android.content.ActivityNotFoundException
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.spec.GCMParameterSpec
import android.widget.Toast
import android.app.Activity
import java.io.BufferedReader
import java.io.BufferedInputStream
import java.io.File
import java.io.FileOutputStream
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import org.json.JSONObject
import android.os.Environment
import android.media.MediaScannerConnection
import android.content.ContentValues
import android.provider.MediaStore

class GithubHttpRequestControl {
  private val cancelled = AtomicBoolean(false)
  @Volatile var connection: HttpURLConnection? = null
  @Volatile var phase: String = "queued"
  fun isCancelled(): Boolean = cancelled.get()
  fun cancel() {
    cancelled.set(true)
    try { connection?.disconnect() } catch (_: Exception) { }
  }
}

object GithubToolHost {
  val secretVaultLock = Any()
  @Volatile var current: WebView? = null
  @Volatile var pendingFileCallback: ValueCallback<Array<Uri>>? = null
  @Volatile var activity: Activity? = null
  const val FILE_PICK_REQUEST = 48173
  const val MULTI_PICK_REQUEST = 48174
  const val CREATE_DOC_REQUEST = 48175
  const val SAVE_DOC_REQUEST = 48176

  @Volatile var pendingSave: ByteArray? = null
  @Volatile var pendingSaveName: String = "file"
  @Volatile var pendingSavePromise: com.facebook.react.bridge.Promise? = null

  data class PickedFile(val uri: Uri, val name: String, val size: Long, val mime: String)
  data class PendingDownload(val id: String, val url: String, val token: String, val name: String)

  val pickedFiles = ConcurrentHashMap<String, PickedFile>()
  val transfers = ConcurrentHashMap<String, Boolean>()
  @Volatile var pendingDownload: PendingDownload? = null
  val downloadExecutor = Executors.newSingleThreadExecutor()
  val githubHttpExecutor = Executors.newFixedThreadPool(3)
  val githubHttpTimeouts = Executors.newSingleThreadScheduledExecutor()

  fun queryMeta(ctx: Context, uri: Uri): Pair<String, Long> {
    var name = "file"
    var size = -1L
    try {
      ctx.contentResolver.query(uri, null, null, null, null)?.use { c ->
        val ni = c.getColumnIndex(android.provider.OpenableColumns.DISPLAY_NAME)
        val si = c.getColumnIndex(android.provider.OpenableColumns.SIZE)
        if (c.moveToFirst()) {
          if (ni >= 0) name = c.getString(ni) ?: name
          if (si >= 0 && !c.isNull(si)) size = c.getLong(si)
        }
      }
    } catch (_: Exception) { }
    if (size < 0) {
      try { ctx.contentResolver.openInputStream(uri)?.use { size = it.available().toLong() } } catch (_: Exception) { }
    }
    return name to size
  }
}

class GithubToolBridge(private val context: Context) {
  private val prefs = context.getSharedPreferences("aib_github_secure", Context.MODE_PRIVATE)
  private val alias = "AIB_GITHUB_VAULT"
  @Volatile var lastSecretSetStage: String = "not_started"
    private set

  private data class SecretReadResult(val value: String?, val stage: String, val permanentlyUnreadable: Boolean = false)

  private fun key(): javax.crypto.SecretKey {
    val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    val existing = ks.getKey(alias, null)
    if (existing is javax.crypto.SecretKey) return existing
    val kg = KeyGenerator.getInstance("AES", "AndroidKeyStore")
    kg.init(android.security.keystore.KeyGenParameterSpec.Builder(alias, android.security.keystore.KeyProperties.PURPOSE_ENCRYPT or android.security.keystore.KeyProperties.PURPOSE_DECRYPT)
      .setBlockModes(android.security.keystore.KeyProperties.BLOCK_MODE_GCM)
      .setEncryptionPaddings(android.security.keystore.KeyProperties.ENCRYPTION_PADDING_NONE)
      .setUserAuthenticationRequired(false).build())
    return kg.generateKey()
  }

  private fun allowedSecretName(name: String): Boolean = name in setOf("unzipgit_token", "unzipgit_tokens", "unzipgit_apikeys")

  private fun readSecret(name: String): SecretReadResult {
    var phase = "prefs_read"
    return try {
      val raw = prefs.getString(name, null) ?: return SecretReadResult(null, "missing")
      phase = "decode"
      val packed = Base64.decode(raw, Base64.NO_WRAP)
      val ivLen = packed[0].toInt() and 0xff
      val iv = packed.copyOfRange(1, 1 + ivLen)
      val data = packed.copyOfRange(1 + ivLen, packed.size)
      phase = "keystore"
      val vaultKey = key()
      phase = "decrypt"
      val c = Cipher.getInstance("AES/GCM/NoPadding")
      c.init(Cipher.DECRYPT_MODE, vaultKey, GCMParameterSpec(128, iv))
      SecretReadResult(String(c.doFinal(data), Charsets.UTF_8), "ok")
    } catch (e: Exception) {
      val exceptionType = e.javaClass.simpleName
      val safeStage = when (phase) {
        "prefs_read" -> "prefs_error"
        "decode" -> "decode_error"
        "keystore" -> if (exceptionType == "ProviderException") "provider_error" else if (exceptionType == "KeyPermanentlyInvalidatedException" || exceptionType == "UnrecoverableKeyException") "key_invalidated" else "keystore_error"
        else -> if (exceptionType == "ProviderException") "provider_error" else if (exceptionType == "KeyPermanentlyInvalidatedException" || exceptionType == "UnrecoverableKeyException") "key_invalidated" else "decrypt_error"
      }
      val permanentlyUnreadable = phase == "decode" || exceptionType in setOf(
        "KeyPermanentlyInvalidatedException", "UnrecoverableKeyException", "InvalidKeyException",
        "AEADBadTagException", "BadPaddingException", "IllegalBlockSizeException", "InvalidAlgorithmParameterException"
      )
      SecretReadResult(null, safeStage, permanentlyUnreadable)
    }
  }

  private fun clearProvenUnreadableSecrets() {
    val names = listOf("unzipgit_token", "unzipgit_tokens", "unzipgit_apikeys")
    names.forEach { name ->
      if (!prefs.contains(name)) return@forEach
      val result = readSecret(name)
      if (result.value == null && result.permanentlyUnreadable) {
        try { prefs.edit().remove(name).commit() } catch (_: Exception) { }
      }
    }
  }

  @JavascriptInterface fun secretGet(name: String): String {
    return synchronized(GithubToolHost.secretVaultLock) {
      if (!allowedSecretName(name)) "" else {
        val result = readSecret(name)
        if (result.value == null && result.permanentlyUnreadable) {
          try { prefs.edit().remove(name).commit() } catch (_: Exception) { }
        }
        result.value ?: ""
      }
    }
  }

  private fun restoreSecret(name: String, previous: String?): Boolean {
    return try {
      val rollback = prefs.edit()
      if (previous == null) rollback.remove(name) else rollback.putString(name, previous)
      val committed = rollback.commit()
      committed && prefs.getString(name, null) == previous
    } catch (_: Exception) { false }
  }

  private fun secretSetOnce(name: String, value: String): Boolean {
    lastSecretSetStage = "input_check"
    if (!allowedSecretName(name) || value.length > 2_000_000) {
      lastSecretSetStage = "input_rejected"
      return false
    }
    var phase = "keystore"
    var previous: String? = null
    try {
      val vaultKey = key()
      phase = "encrypt"
      val c = Cipher.getInstance("AES/GCM/NoPadding")
      c.init(Cipher.ENCRYPT_MODE, vaultKey)
      val iv = c.iv
      val data = c.doFinal(value.toByteArray(Charsets.UTF_8))
      val packed = byteArrayOf(iv.size.toByte()) + iv + data
      phase = "snapshot"
      previous = prefs.getString(name, null)
      phase = "commit"
      val committed = prefs.edit().putString(name, Base64.encodeToString(packed, Base64.NO_WRAP)).commit()
      if (!committed) {
        lastSecretSetStage = "commit_failed"
        if (!restoreSecret(name, previous)) lastSecretSetStage = "rollback_failed"
        return false
      }
      phase = "readback"
      val readBack = readSecret(name)
      if (readBack.stage == "ok" && readBack.value == value) {
        lastSecretSetStage = "verified"
        clearProvenUnreadableSecrets()
        return true
      }
      lastSecretSetStage = when (readBack.stage) {
        "missing" -> "readback_missing"
        "prefs_error" -> "readback_storage_error"
        "decode_error" -> "readback_decode_error"
        "keystore_error" -> "readback_keystore_error"
        "key_invalidated" -> "readback_keystore_error"
        "provider_error" -> "readback_provider_error"
        "decrypt_error" -> "readback_decrypt_error"
        else -> "readback_mismatch"
      }
      // Restore and verify the last known encrypted value if commit/read-back did not verify.
      if (!restoreSecret(name, previous)) lastSecretSetStage = "rollback_failed"
      return false
    } catch (e: Exception) {
      val exceptionType = e.javaClass.simpleName
      val failureStage = when {
        exceptionType == "ProviderException" -> "provider_error"
        exceptionType == "KeyPermanentlyInvalidatedException" || exceptionType == "UnrecoverableKeyException" -> "key_invalidated"
        exceptionType == "InvalidKeyException" -> "key_invalidated"
        phase == "keystore" -> "keystore_error"
        phase == "encrypt" -> "encrypt_error"
        phase == "snapshot" -> "snapshot_error"
        phase == "commit" -> "commit_error"
        else -> "readback_storage_error"
      }
      lastSecretSetStage = if ((phase == "commit" || phase == "readback") && !restoreSecret(name, previous)) "rollback_failed" else failureStage
      return false
    }
  }

  private fun resetUnreadableSecretVault(): Boolean {
    return try {
      val names = listOf("unzipgit_token", "unzipgit_tokens", "unzipgit_apikeys")
      val existing = names.filter { prefs.contains(it) }
      val reads = existing.map { it to readSecret(it) }
      // Clear only if every stored ciphertext has been proven unreadable; never
      // discard a prior credential merely because a provider returned a transient error.
      if (reads.any { (_, result) -> result.value != null || !result.permanentlyUnreadable }) return false
      if (existing.isNotEmpty()) {
        val clear = prefs.edit()
        existing.forEach { clear.remove(it) }
        if (!clear.commit() || existing.any { prefs.contains(it) }) return false
      }
      val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
      if (ks.containsAlias(alias)) ks.deleteEntry(alias)
      !ks.containsAlias(alias) && names.none { prefs.contains(it) }
    } catch (_: Exception) { false }
  }

  @JavascriptInterface fun secretSet(name: String, value: String): Boolean = synchronized(GithubToolHost.secretVaultLock) {
    val first = secretSetOnce(name, value)
    if (first) return@synchronized true
    val firstStage = lastSecretSetStage
    if (firstStage == "input_rejected" || firstStage == "rollback_failed") return@synchronized false
    val recoverableKeyState = firstStage in setOf(
      "keystore_error", "key_invalidated", "provider_error", "encrypt_error",
      "readback_keystore_error", "readback_provider_error", "readback_decrypt_error", "readback_decode_error"
    )
    if (recoverableKeyState && !resetUnreadableSecretVault()) {
      lastSecretSetStage = "recovery_reset_failed"
      return@synchronized false
    }
    val retried = secretSetOnce(name, value)
    if (retried) lastSecretSetStage = if (recoverableKeyState) "verified_after_recovery" else "verified_retry"
    retried
  }

  fun secretSetWithStage(name: String, value: String): Pair<Boolean, String> = synchronized(GithubToolHost.secretVaultLock) {
    val saved = secretSet(name, value)
    saved to lastSecretSetStage
  }

  @JavascriptInterface fun secretDelete(name: String): Boolean {
    return synchronized(GithubToolHost.secretVaultLock) {
      if (!allowedSecretName(name)) false
      else try { prefs.edit().remove(name).commit() } catch (_: Exception) { false }
    }
  }

  @JavascriptInterface fun isOnline(): Boolean {
    return try {
      val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
      val n = cm.activeNetwork ?: return false
      val c = cm.getNetworkCapabilities(n) ?: return false
      c.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
    } catch (_: Exception) { false }
  }

  @JavascriptInterface fun openUrl(url: String) {
    try {
      val u = Uri.parse(url)
      val host = (u.host ?: "").lowercase()
      if (u.scheme != "https" || host !in setOf("github.com", "www.github.com")) return
      context.startActivity(Intent(Intent.ACTION_VIEW, u).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    } catch (_: Exception) { }
  }

  @JavascriptInterface fun keepScreenOn(on: Boolean) {
    val a = (context as? com.facebook.react.bridge.ReactContext)?.currentActivity ?: (context as? Activity) ?: return
    a.runOnUiThread { if (on) a.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON) else a.window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON) }
  }

  @JavascriptInterface fun showToast(message: String) {
    Toast.makeText(context, message, Toast.LENGTH_SHORT).show()
  }

  @JavascriptInterface fun showError(message: String) {
    Toast.makeText(context, message, Toast.LENGTH_LONG).show()
  }

  @JavascriptInterface fun getAppVersion(): String {
    return try {
      val pi = context.packageManager.getPackageInfo(context.packageName, 0)
      pi.versionName ?: "1.8.1"
    } catch (_: Exception) { "1.8.0" }
  }

  /** Close GitHub Tool activity and return to AI Builder (top hamburger). */
  /** Hamburger / menu: return to AI Builder and open the side drawer (not a tool-local sheet). */
  @JavascriptInterface fun closeHost() {
    try {
      val act = GithubToolHost.activity
      if (act != null) {
        act.runOnUiThread {
          try {
            val app = act.application
            val host = try { app.javaClass.getMethod("getReactNativeHost").invoke(app) } catch (_: Exception) { null }
            val mgr = try { host?.javaClass?.getMethod("getReactInstanceManager")?.invoke(host) } catch (_: Exception) { null }
            val ctx = try { mgr?.javaClass?.getMethod("getCurrentReactContext")?.invoke(mgr) } catch (_: Exception) { null }
            if (ctx != null) {
              val emitter = (ctx as com.facebook.react.bridge.ReactContext)
                .getJSModule(com.facebook.react.modules.core.DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
              emitter.emit("aib_open_drawer", null)
            }
            val launch = act.packageManager.getLaunchIntentForPackage(act.packageName)
            if (launch != null) {
              launch.addFlags(
                android.content.Intent.FLAG_ACTIVITY_REORDER_TO_FRONT or
                android.content.Intent.FLAG_ACTIVITY_SINGLE_TOP
              )
              launch.putExtra("aib_open_drawer", true)
              act.startActivity(launch)
            }
            act.finish()
          } catch (_: Exception) {
            try { act.finish() } catch (_: Exception) {}
          }
        }
      }
    } catch (_: Exception) {}
  }
  @JavascriptInterface fun openAppMenu() { closeHost() }

  /** Save base64 payload to public Downloads (or app external files). Used by files.js saveToDevice. */
  @JavascriptInterface fun saveFile(fileName: String, mime: String, base64: String) {
    saveFileInternal(fileName, mime, base64, null)
  }

  fun saveFileFromReact(fileName: String, mime: String, base64: String, promise: com.facebook.react.bridge.Promise) {
    saveFileInternal(fileName, mime, base64, promise)
  }

  private fun saveFileInternal(fileName: String, mime: String, base64: String, promise: com.facebook.react.bridge.Promise?) {
    val bytes = try {
      Base64.decode(base64, Base64.DEFAULT)
    } catch (_: Exception) { null }
    if (bytes == null) {
      promise?.reject("GITHUB_SAVE_DECODE", "Ошибка декодирования файла")
      try { Toast.makeText(context, "Ошибка декодирования файла", Toast.LENGTH_SHORT).show() } catch (_: Exception) {}
      return
    }
    if (bytes.size > 80 * 1024 * 1024) {
      promise?.reject("GITHUB_SAVE_TOO_LARGE", "Файл слишком большой для сохранения через WebView")
      try { Toast.makeText(context, "Файл слишком большой для сохранения через WebView", Toast.LENGTH_LONG).show() } catch (_: Exception) {}
      return
    }
    val safeName = sanitizeFileName(fileName)
    val mimeType = mime.ifBlank { "application/octet-stream" }
    val act = GithubToolHost.activity
    if (act != null) {
      if (GithubToolHost.pendingSave != null) {
        promise?.reject("GITHUB_SAVE_IN_PROGRESS", "Предыдущее сохранение ещё не завершено")
        return
      }
      // UnzipGit parity: system "Save as…"
      GithubToolHost.pendingSave = bytes
      GithubToolHost.pendingSaveName = safeName
      GithubToolHost.pendingSavePromise = promise
      act.runOnUiThread {
        try {
          val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = mimeType
            putExtra(Intent.EXTRA_TITLE, safeName)
          }
          act.startActivityForResult(intent, GithubToolHost.SAVE_DOC_REQUEST)
        } catch (e: Exception) {
          GithubToolHost.pendingSave = null
          val completion = GithubToolHost.pendingSavePromise
          GithubToolHost.pendingSavePromise = null
          try {
            saveFileToDownloads(safeName, mimeType, bytes)
            completion?.resolve(true)
          } catch (saveError: Exception) {
            completion?.reject("GITHUB_SAVE_FALLBACK", saveError)
          }
        }
      }
      return
    }
    try {
      saveFileToDownloads(safeName, mimeType, bytes)
      promise?.resolve(true)
    } catch (e: Exception) {
      promise?.reject("GITHUB_SAVE_WRITE", e)
    }
  }

  private fun saveFileToDownloads(safeName: String, mimeType: String, bytes: ByteArray): String {
    var insertedUri: Uri? = null
    try {
      var savedPath: String? = null
      if (Build.VERSION.SDK_INT >= 29) {
        val values = ContentValues().apply {
          put(MediaStore.Downloads.DISPLAY_NAME, safeName)
          put(MediaStore.Downloads.MIME_TYPE, mimeType)
          put(MediaStore.Downloads.IS_PENDING, 1)
        }
        val resolver = context.contentResolver
        val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
        if (uri != null) {
          insertedUri = uri
          val output = resolver.openOutputStream(uri) ?: throw IllegalStateException("Не удалось открыть файл для записи")
          output.use { it.write(bytes); it.flush() }
          values.clear()
          values.put(MediaStore.Downloads.IS_PENDING, 0)
          resolver.update(uri, values, null, null)
          savedPath = uri.toString()
        }
      }
      if (savedPath == null) {
        val dir = context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS) ?: context.filesDir
        dir.mkdirs()
        val out = File(dir, safeName)
        FileOutputStream(out).use { it.write(bytes) }
        savedPath = out.absolutePath
      }
      val msg = "Сохранено: " + (savedPath ?: safeName)
      try {
        (context as? Activity)?.runOnUiThread {
          Toast.makeText(context, msg, Toast.LENGTH_SHORT).show()
        } ?: Toast.makeText(context, msg, Toast.LENGTH_SHORT).show()
      } catch (_: Exception) {}
      return savedPath ?: safeName
    } catch (e: Exception) {
      try { insertedUri?.let { context.contentResolver.delete(it, null, null) } } catch (_: Exception) {}
      try { Toast.makeText(context, "Ошибка сохранения: " + (e.message ?: ""), Toast.LENGTH_LONG).show() } catch (_: Exception) {}
      throw e
    }
  }

  @JavascriptInterface fun shareText(text: String, title: String) {
    try {
      val i = Intent(Intent.ACTION_SEND).apply { type = "text/plain"; putExtra(Intent.EXTRA_TEXT, text) }
      context.startActivity(Intent.createChooser(i, title).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    } catch (_: Exception) { }
  }

  // ---- release asset download (auth, private repos) ----
  private val downloadExecutor = Executors.newFixedThreadPool(2)
  private val cancelFlags = ConcurrentHashMap<String, Boolean>()

  private fun sanitizeFileName(name: String): String {
    val sb = StringBuilder(name.length)
    for (ch in name) {
      when (ch) {
        '/', '\\\\', ':', '*', '?', '"', '<', '>', '|' -> sb.append('_')
        else -> sb.append(ch)
      }
    }
    val s = sb.toString().trim()
    return if (s.isEmpty()) "file" else s
  }





  private fun jsEval(script: String) {
    val w = GithubToolHost.current ?: return
    w.post {
      try { w.evaluateJavascript(script, null) } catch (_: Exception) { }
    }
  }

  private fun jsQuote(raw: String): String {
    val sb = StringBuilder(raw.length + 2)
    sb.append('"')
    for (ch in raw) {
      when (ch) {
        '\\\\' -> { sb.append('\\\\'); sb.append('\\\\') }
        '"' -> { sb.append('\\\\'); sb.append('"') }
        '\\n' -> { sb.append('\\\\'); sb.append('n') }
        '\\r' -> { sb.append('\\\\'); sb.append('r') }
        else -> sb.append(ch)
      }
    }
    sb.append('"')
    return sb.toString()
  }

  fun jsCallPublic(fn: String, vararg args: Any?) { jsCall(fn, *args) }

  /** React Native host: no WebView is attached to GithubToolHost, so callbacks are forwarded to JS via an event emitter. */
  @Volatile var eventSink: ((String, Array<out Any?>) -> Unit)? = null

  private fun jsCall(fn: String, vararg args: Any?) {
    val sink = eventSink
    if (sink != null) {
      try { sink(fn, args) } catch (_: Exception) { }
      return
    }
    val parts = args.map { a ->
      when (a) {
        null -> "null"
        is Boolean -> a.toString()
        is Number -> a.toString()
        else -> jsQuote(a.toString())
      }
    }
    jsEval("try{" + fn + "(" + parts.joinToString(",") + ")}catch(e){}")
  }





  @JavascriptInterface fun pickFiles() {
    val act = GithubToolHost.activity
    if (act == null) {
      jsCall("window.__ugPicked", "[]")
      return
    }
    act.runOnUiThread {
      try {
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
          addCategory(Intent.CATEGORY_OPENABLE)
          type = "*/*"
          putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
          addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        act.startActivityForResult(intent, GithubToolHost.MULTI_PICK_REQUEST)
      } catch (e: Exception) {
        Toast.makeText(act, "Не удалось открыть выбор файлов", Toast.LENGTH_SHORT).show()
        jsCall("window.__ugPicked", "[]")
      }
    }
  }

  @JavascriptInterface fun uploadAsset(id: String, uploadUrl: String, token: String, name: String, mime: String) {
    val f = GithubToolHost.pickedFiles[id]
    if (f == null) {
      jsCall("window.__ugDone", id, 0, "Файл не найден. Выберите его заново.")
      return
    }
    val uploadOrigin = try { URL(uploadUrl) } catch (_: Exception) { null }
    if (uploadOrigin == null || uploadOrigin.protocol != "https" || !uploadOrigin.host.equals("uploads.github.com", ignoreCase = true) || uploadOrigin.userInfo != null || (uploadOrigin.port >= 0 && uploadOrigin.port != 443)) {
      jsCall("window.__ugDone", id, 0, "Недопустимый адрес загрузки")
      return
    }
    GithubToolHost.transfers[id] = false
    GithubToolHost.downloadExecutor.execute {
      var conn: HttpURLConnection? = null
      try {
        val size = if (f.size > 0) f.size else {
          try { context.contentResolver.openInputStream(f.uri)?.use { it.available().toLong() } ?: -1L } catch (_: Exception) { -1L }
        }
        val c = (URL(uploadUrl).openConnection() as HttpURLConnection)
        conn = c
        c.requestMethod = "POST"
        c.connectTimeout = 30000
        c.readTimeout = 300000
        c.doOutput = true
        c.doInput = true
        c.instanceFollowRedirects = false
        c.setRequestProperty("Authorization", "token " + token)
        c.setRequestProperty("Accept", "application/vnd.github+json")
        c.setRequestProperty("X-GitHub-Api-Version", "2022-11-28")
        c.setRequestProperty("Content-Type", if (mime.isBlank()) "application/octet-stream" else mime)
        if (size > 0) c.setFixedLengthStreamingMode(size)
        val source = context.contentResolver.openInputStream(f.uri)
          ?: throw java.io.IOException("Не удалось открыть файл")
        var sent = 0L
        var lastEmit = 0L
        c.outputStream.use { os ->
          source.use { input ->
            val buf = ByteArray(64 * 1024)
            while (true) {
              if (GithubToolHost.transfers[id] == true) throw java.io.InterruptedIOException("cancelled")
              val n = input.read(buf)
              if (n < 0) break
              os.write(buf, 0, n)
              sent += n
              val now = System.currentTimeMillis()
              if (now - lastEmit > 200) {
                lastEmit = now
                jsCall("window.__ugProgress", id, sent, if (size > 0) size else sent)
              }
            }
          }
        }
        jsCall("window.__ugProgress", id, sent, sent)
        val status = c.responseCode
        val body = try {
          val stream = if (status >= 400) c.errorStream else c.inputStream
          stream?.bufferedReader()?.readText() ?: ""
        } catch (_: Exception) { "" }
        jsCall("window.__ugDone", id, status, body)
      } catch (e: java.io.InterruptedIOException) {
        jsCall("window.__ugDone", id, -1, "cancelled")
      } catch (e: Exception) {
        if (GithubToolHost.transfers[id] == true) {
          jsCall("window.__ugDone", id, -1, "cancelled")
        } else {
          jsCall("window.__ugDone", id, 0, e.javaClass.simpleName + ": " + (e.message ?: ""))
        }
      } finally {
        GithubToolHost.transfers.remove(id)
        try { conn?.disconnect() } catch (_: Exception) { }
      }
    }
  }


  @JavascriptInterface fun cancelTransfer(id: String) {
    cancelFlags[id] = true
    GithubToolHost.transfers[id] = true
  }

@JavascriptInterface fun downloadAsset(id: String, apiUrl: String, token: String, name: String) {
    if (!apiUrl.startsWith("https://api.github.com/")) {
      jsCall("window.__ugDownloadDone", id, false, "Недопустимый адрес")
      return
    }
    cancelFlags[id] = false
    GithubToolHost.transfers[id] = false
    val safeName = sanitizeFileName(name)
    val act = GithubToolHost.activity
    if (act != null) {
      // UnzipGit path: system "Save as…" then stream
      val prev = GithubToolHost.pendingDownload
      if (prev != null) jsCall("window.__ugDownloadDone", prev.id, false, "cancel")
      GithubToolHost.pendingDownload = GithubToolHost.PendingDownload(id, apiUrl, token, safeName)
      act.runOnUiThread {
        try {
          val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = "*/*"
            putExtra(Intent.EXTRA_TITLE, safeName)
          }
          act.startActivityForResult(intent, GithubToolHost.CREATE_DOC_REQUEST)
        } catch (e: Exception) {
          GithubToolHost.pendingDownload = null
          // fallback to app storage
          downloadAssetToAppDir(id, apiUrl, token, safeName)
        }
      }
      return
    }
    downloadAssetToAppDir(id, apiUrl, token, safeName)
  }

  private fun downloadAssetToAppDir(id: String, apiUrl: String, token: String, safeName: String) {
    downloadExecutor.execute {
      streamGithubDownload(id, apiUrl, token) { input, total ->
        val dir = context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS) ?: context.filesDir
        dir.mkdirs()
        val outFile = File(dir, safeName)
        var sent = 0L
        var lastEmit = 0L
        FileOutputStream(outFile).use { os ->
          val buf = ByteArray(64 * 1024)
          while (true) {
            if (cancelFlags[id] == true || GithubToolHost.transfers[id] == true) {
              try { outFile.delete() } catch (_: Exception) { }
              throw java.io.InterruptedIOException("cancel")
            }
            val n = input.read(buf)
            if (n < 0) break
            os.write(buf, 0, n)
            sent += n
            val now = System.currentTimeMillis()
            if (now - lastEmit > 200) {
              lastEmit = now
              jsCall("window.__ugProgress", id, sent, if (total > 0) total else sent)
            }
          }
        }
        jsCall("window.__ugProgress", id, sent, sent)
        jsCall("window.__ugDownloadDone", id, true, outFile.absolutePath)
      }
    }
  }

  /** Manual redirect loop: Authorization only for api.github.com, never for storage hosts. */
  private fun streamGithubDownload(id: String, apiUrl: String, token: String, write: (java.io.InputStream, Long) -> Unit) {
    var conn: HttpURLConnection? = null
    try {
      val initialUrl = URL(apiUrl)
      if (initialUrl.protocol != "https" || initialUrl.userInfo != null || !initialUrl.host.equals("api.github.com", ignoreCase = true) || (if (initialUrl.port >= 0) initialUrl.port else initialUrl.defaultPort) != 443) {
        throw java.io.IOException("Unsafe initial GitHub API URL")
      }
      var url = initialUrl.toString()
      var withAuth = true
      var hops = 0
      var total = -1L
      var stream: java.io.InputStream? = null
      while (true) {
        val c = URL(url).openConnection() as HttpURLConnection
        conn = c
        c.instanceFollowRedirects = false
        c.connectTimeout = 30000
        c.readTimeout = 300000
        if (withAuth) c.setRequestProperty("Authorization", "token " + token)
        c.setRequestProperty("Accept", "application/octet-stream")
        c.setRequestProperty("X-GitHub-Api-Version", "2022-11-28")
        val st = c.responseCode
        if (st == 301 || st == 302 || st == 303 || st == 307 || st == 308) {
          val loc = c.getHeaderField("Location") ?: throw java.io.IOException("Пустое перенаправление")
          c.disconnect()
          hops++
          if (hops > 5) throw java.io.IOException("Слишком много перенаправлений")
          val nextUrl = URL(URL(url), loc)
          val nextHost = nextUrl.host.lowercase()
          val redirectHosts = setOf(
            "api.github.com", "uploads.github.com", "raw.githubusercontent.com",
            "github.com", "www.github.com", "objects.githubusercontent.com",
            "codeload.github.com", "release-assets.githubusercontent.com"
          )
          val redirectAllowed = nextHost in redirectHosts || nextHost.endsWith(".githubusercontent.com")
          if (nextUrl.protocol != "https" || nextUrl.userInfo != null || (nextUrl.port >= 0 && nextUrl.port != 443) || !redirectAllowed) throw java.io.IOException("Небезопасное перенаправление")
          url = nextUrl.toString()
          withAuth = withAuth && nextHost == "api.github.com" && (if (nextUrl.port >= 0) nextUrl.port else nextUrl.defaultPort) == 443
          continue
        }
        if (st !in 200..299) {
          val err = try { c.errorStream?.bufferedReader()?.readText()?.take(300) } catch (_: Exception) { null }
          throw java.io.IOException("HTTP $st" + (err?.let { ": $it" } ?: ""))
        }
        total = c.contentLengthLong.let { if (it > 0) it else -1L }
        stream = c.inputStream
        break
      }
      write(stream ?: throw java.io.IOException("Пустой ответ"), total)
    } catch (e: java.io.InterruptedIOException) {
      jsCall("window.__ugDownloadDone", id, false, "cancel")
    } catch (e: Exception) {
      if (cancelFlags[id] == true || GithubToolHost.transfers[id] == true) {
        jsCall("window.__ugDownloadDone", id, false, "cancel")
      } else {
        jsCall("window.__ugDownloadDone", id, false, e.message ?: e.javaClass.simpleName)
      }
    } finally {
      cancelFlags.remove(id)
      GithubToolHost.transfers.remove(id)
      try { conn?.disconnect() } catch (_: Exception) { }
    }
  }

  @JavascriptInterface fun httpRequest(payload: String): String = httpRequest(payload, GithubHttpRequestControl())

  fun httpRequest(payload: String, control: GithubHttpRequestControl): String {
    var conn: HttpURLConnection? = null
    var timeoutTask: java.util.concurrent.ScheduledFuture<*>? = null
    var phase = "parse"
    return try {
      val o = JSONObject(payload)
      val url = URL(o.getString("url"))
      if (url.protocol != "https") throw SecurityException("GitHub Tool разрешает только HTTPS")
      if (url.userInfo != null || (url.port >= 0 && url.port != 443)) throw SecurityException("GitHub Tool разрешает только HTTPS origin на порту 443")
      val host = url.host.lowercase()
      val allowed = setOf(
        "api.github.com", "uploads.github.com", "raw.githubusercontent.com",
        "github.com", "www.github.com", "objects.githubusercontent.com",
        "codeload.github.com", "release-assets.githubusercontent.com"
      )
      if (!allowed.contains(host) && !host.endsWith(".githubusercontent.com")) {
        throw SecurityException("Домен не разрешён GitHub Tool: $host")
      }
      val wantBinary = o.optBoolean("binary", false)
      val initialApiOrigin = host == "api.github.com" && (url.port < 0 || url.port == 443)
      val timeoutMs = o.optInt("timeoutMs", 15000).coerceIn(1000, if (wantBinary) 180000 else 30000)
      val deadline = android.os.SystemClock.elapsedRealtime() + timeoutMs
      timeoutTask = GithubToolHost.githubHttpTimeouts.schedule({ control.cancel() }, timeoutMs.toLong(), TimeUnit.MILLISECONDS)
      val method = o.optString("method", "GET").uppercase()
      val h = o.optJSONObject("headers")
      val body = if (o.has("body") && !o.isNull("body")) o.getString("body") else null
      // Manual redirect hop (max 5) only to allowlisted hosts — keeps SSRF guard while supporting asset CDN.
      var currentUrl = url
      var status = 0
      var statusText = ""
      var bytes = ByteArray(0)
      var hops = 0
      var lastContentType = ""
      var lastHeaders = JSONObject()
      while (true) {
        if (control.isCancelled()) throw java.net.SocketTimeoutException("timeout")
        val remainingMs = (deadline - android.os.SystemClock.elapsedRealtime()).coerceAtLeast(1L).coerceAtMost(Int.MAX_VALUE.toLong()).toInt()
        try { conn?.disconnect() } catch (_: Exception) { }
        val c = (currentUrl.openConnection() as HttpURLConnection)
        conn = c
        control.connection = c
        c.connectTimeout = minOf(remainingMs, 10000)
        c.readTimeout = remainingMs
        c.instanceFollowRedirects = false
        c.requestMethod = if (hops == 0) method else "GET"
        c.doInput = true
        if (body != null && hops == 0 && method != "GET" && method != "HEAD") c.doOutput = true
        val sameOrigin = currentUrl.protocol.equals(url.protocol, ignoreCase = true) &&
          currentUrl.host.equals(url.host, ignoreCase = true) &&
          (if (currentUrl.port >= 0) currentUrl.port else currentUrl.defaultPort) ==
            (if (url.port >= 0) url.port else url.defaultPort)
        // Caller headers may include credentials. Never replay them to a different origin.
        if (h != null && sameOrigin) {
          val keys = h.keys()
          while (keys.hasNext()) {
            val k = keys.next()
            val lower = k.lowercase()
            val ambientCredential = lower == "proxy-authorization" || lower == "cookie"
            val apiOrigin = currentUrl.host.equals("api.github.com", ignoreCase = true) &&
              (currentUrl.port < 0 || currentUrl.port == 443)
            if (ambientCredential || (lower == "authorization" && (!initialApiOrigin || !apiOrigin))) continue
            c.setRequestProperty(k, h.getString(k))
          }
        }
        phase = "connect"
        control.phase = phase
        c.connect()
        if (body != null && hops == 0 && method != "GET" && method != "HEAD") {
          phase = "request-body"
          control.phase = phase
          c.outputStream.use { os -> os.write(body.toByteArray(Charsets.UTF_8)) }
        }
        phase = "response-headers"
        control.phase = phase
        status = c.responseCode
        statusText = try { c.responseMessage ?: "" } catch (_: Exception) { "" }
        if (status in 300..399 && hops < 5) {
          val loc = c.getHeaderField("Location")
          if (loc == null) break
          val next = try { URL(currentUrl, loc) } catch (_: Exception) { break }
          val nh = (next.host ?: "").lowercase()
          val allowedHop = nh in allowed || nh.endsWith(".githubusercontent.com")
          if (next.protocol != "https" || next.userInfo != null || (next.port >= 0 && next.port != 443) || !allowedHop) break
          currentUrl = next
          hops++
          continue
        }
        phase = "response-body"
        control.phase = phase
        val stream = if (status >= 400) c.errorStream else c.inputStream
        bytes = if (stream != null) stream.use { it.readBytes() } else ByteArray(0)
        if (control.isCancelled() || android.os.SystemClock.elapsedRealtime() > deadline) throw java.net.SocketTimeoutException("timeout")
        lastContentType = (c.contentType ?: "").lowercase()
        lastHeaders = JSONObject()
        c.headerFields.forEach { (k, v) ->
          if (k != null && v != null && v.isNotEmpty()) lastHeaders.put(k, v.joinToString("; "))
        }
        break
      }
      // Cap ~25MB in bridge to avoid OOM on WebView JS bridge
      if (bytes.size > 25 * 1024 * 1024) {
        return JSONObject().apply {
          put("ok", false); put("status", status); put("statusText", "payload too large")
          put("body", ""); put("isBase64", false); put("error", "Ответ больше 25 МБ — используйте downloadAsset/saveFile")
          put("headers", JSONObject())
        }.toString()
      }
      val asBinary = wantBinary ||
        lastContentType.contains("octet-stream") || lastContentType.contains("zip") || lastContentType.startsWith("image/") ||
        (lastContentType.startsWith("application/") && !lastContentType.contains("json") && !lastContentType.contains("text"))
      val bodyOut: String
      val isBase64: Boolean
      if (asBinary) {
        bodyOut = Base64.encodeToString(bytes, Base64.NO_WRAP)
        isBase64 = true
      } else {
        bodyOut = String(bytes, Charsets.UTF_8)
        isBase64 = false
      }
      JSONObject().apply {
        put("ok", status in 200..299)
        put("status", status)
        put("statusText", statusText)
        put("body", bodyOut)
        put("isBase64", isBase64)
        put("headers", lastHeaders)
      }.toString()
    } catch (e: Exception) {
      val timedOut = control.isCancelled() || e is java.net.SocketTimeoutException || e is java.io.InterruptedIOException
      val failurePhase = if (e is java.net.UnknownHostException) "dns" else phase
      JSONObject().apply {
        put("ok", false); put("status", 0); put("statusText", if (timedOut) "timeout:$failurePhase" else (e.message ?: "network error"))
        put("body", ""); put("isBase64", false); put("headers", JSONObject()); put("phase", failurePhase)
        put("error", if (timedOut) "timeout:$failurePhase" else (e.javaClass.simpleName + ": " + (e.message ?: "")))
      }.toString()
    } finally {
      try { timeoutTask?.cancel(false) } catch (_: Exception) { }
      control.connection = null
      try { conn?.disconnect() } catch (_: Exception) { }
    }
  }
}

class GithubToolModule(reactContext: com.facebook.react.bridge.ReactApplicationContext) : com.facebook.react.bridge.ReactContextBaseJavaModule(reactContext) {
  private val secretVault by lazy(LazyThreadSafetyMode.SYNCHRONIZED) { GithubToolBridge(reactContext) }
  @Volatile private var lastSecretSetStage: String = "not_started"
  @Volatile private var pendingPickPromise: com.facebook.react.bridge.Promise? = null
  private val rnBridge by lazy(LazyThreadSafetyMode.SYNCHRONIZED) {
    GithubToolBridge(reactContext).also { b ->
      b.eventSink = { fn, args -> emitToJs(fn, args) }
    }
  }

  private fun emitToJs(fn: String, args: Array<out Any?>) {
    val arr = org.json.JSONArray()
    for (a in args) {
      when (a) {
        null -> arr.put(org.json.JSONObject.NULL)
        is Boolean -> arr.put(a)
        is Number -> arr.put(a)
        else -> arr.put(a.toString())
      }
    }
    val map = com.facebook.react.bridge.Arguments.createMap()
    map.putString("fn", fn)
    map.putString("args", arr.toString())
    reactApplicationContext
      .getJSModule(com.facebook.react.modules.core.DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
      .emit("AibGithubToolEvent", map)
  }

  private fun handlePickResult(activity: Activity, resultCode: Int, data: Intent?) {
    val promise = pendingPickPromise
    pendingPickPromise = null
    if (promise == null) return
    if (resultCode != Activity.RESULT_OK || data == null) { promise.resolve("[]"); return }
    try {
      val arr = org.json.JSONArray()
      val list = mutableListOf<Uri>()
      val clip = data.clipData
      if (clip != null) {
        for (i in 0 until clip.itemCount) list.add(clip.getItemAt(i).uri)
      } else {
        data.data?.let { list.add(it) }
      }
      for (uri in list) {
        try { activity.contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION) } catch (_: Exception) { }
        val (name, size) = GithubToolHost.queryMeta(activity, uri)
        val mime = try { activity.contentResolver.getType(uri) } catch (_: Exception) { null } ?: "application/octet-stream"
        val id = java.util.UUID.randomUUID().toString()
        GithubToolHost.pickedFiles[id] = GithubToolHost.PickedFile(uri, name, size, mime)
        arr.put(org.json.JSONObject().apply {
          put("id", id)
          put("name", name)
          put("size", size)
          put("mime", mime)
        })
      }
      promise.resolve(arr.toString())
    } catch (e: Exception) {
      promise.resolve("[]")
    }
  }

  init {
    reactContext.addActivityEventListener(object : com.facebook.react.bridge.BaseActivityEventListener() {
      override fun onActivityResult(activity: Activity, requestCode: Int, resultCode: Int, data: Intent?) {
        if (requestCode == GithubToolHost.MULTI_PICK_REQUEST) { handlePickResult(activity, resultCode, data); return }
        if (requestCode != GithubToolHost.FILE_PICK_REQUEST) return
        val cb = GithubToolHost.pendingFileCallback ?: return
        GithubToolHost.pendingFileCallback = null
        val uris = if (resultCode == Activity.RESULT_OK) {
          val clip = data?.clipData
          if (clip != null) Array(clip.itemCount) { i -> clip.getItemAt(i).uri }
          else data?.data?.let { arrayOf(it) }
          ?: emptyArray()
        } else emptyArray()
        cb.onReceiveValue(uris)
      }
    })
  }
  override fun getName() = "AibGithubTool"
  @com.facebook.react.bridge.ReactMethod fun secretGet(name: String, promise: com.facebook.react.bridge.Promise) {
    try { promise.resolve(secretVault.secretGet(name)) } catch (e: Exception) { promise.reject("GITHUB_SECRET_GET", e) }
  }
  @com.facebook.react.bridge.ReactMethod fun secretSet(name: String, value: String, promise: com.facebook.react.bridge.Promise) {
    try {
      val saved = secretVault.secretSet(name, value)
      lastSecretSetStage = secretVault.lastSecretSetStage
      promise.resolve(saved)
    } catch (e: Exception) {
      lastSecretSetStage = "module_exception"
      promise.reject("GITHUB_SECRET_SET", e)
    }
  }
  @com.facebook.react.bridge.ReactMethod fun secretSetResult(name: String, value: String, promise: com.facebook.react.bridge.Promise) {
    try {
      val (saved, stage) = secretVault.secretSetWithStage(name, value)
      val result = com.facebook.react.bridge.Arguments.createMap()
      result.putBoolean("saved", saved)
      result.putString("stage", stage)
      lastSecretSetStage = stage
      promise.resolve(result)
    } catch (e: Exception) {
      lastSecretSetStage = "module_exception"
      promise.reject("GITHUB_SECRET_SET", e)
    }
  }
  @com.facebook.react.bridge.ReactMethod fun secretSetLastStage(promise: com.facebook.react.bridge.Promise) {
    promise.resolve(lastSecretSetStage)
  }
  @com.facebook.react.bridge.ReactMethod fun secretDelete(name: String, promise: com.facebook.react.bridge.Promise) {
    try { promise.resolve(GithubToolBridge(reactApplicationContext).secretDelete(name)) } catch (e: Exception) { promise.reject("GITHUB_SECRET_DELETE", e) }
  }
  @com.facebook.react.bridge.ReactMethod fun saveFile(fileName: String, mime: String, base64: String, promise: com.facebook.react.bridge.Promise) {
    try {
      val bridge = GithubToolBridge(reactApplicationContext)
      // Promise resolves only after chooser completion or a completed direct write.
      bridge.saveFileFromReact(fileName, mime, base64, promise)
    } catch (e: Exception) {
      promise.reject("GITHUB_SAVE", e)
    }
  }
  @com.facebook.react.bridge.ReactMethod fun httpRequest(payload: String, promise: com.facebook.react.bridge.Promise) {
    val timeoutMs = try {
      val json = JSONObject(payload)
      json.optInt("timeoutMs", 15000).coerceIn(1000, if (json.optBoolean("binary", false)) 180000 else 30000)
    } catch (_: Exception) { 15000 }
    val control = GithubHttpRequestControl()
    val settled = AtomicBoolean(false)
    try {
      val task = GithubToolHost.githubHttpExecutor.submit {
        try {
          val result = GithubToolBridge(reactApplicationContext).httpRequest(payload, control)
          if (settled.compareAndSet(false, true)) promise.resolve(result)
        } catch (e: Exception) {
          if (settled.compareAndSet(false, true)) promise.reject("GITHUB_HTTP", e)
        }
      }
      GithubToolHost.githubHttpTimeouts.schedule({
        if (settled.compareAndSet(false, true)) {
          control.cancel()
          task.cancel(true)
          promise.resolve(JSONObject().apply {
            put("ok", false); put("status", 0); put("statusText", "timeout")
            put("body", ""); put("isBase64", false); put("headers", JSONObject()); put("phase", control.phase); put("error", "timeout:\${control.phase}")
          }.toString())
        }
      }, timeoutMs.toLong() + 500L, TimeUnit.MILLISECONDS)
    } catch (e: Exception) {
      if (settled.compareAndSet(false, true)) promise.reject("GITHUB_HTTP", e)
    }
  }
  @com.facebook.react.bridge.ReactMethod fun pickFiles(promise: com.facebook.react.bridge.Promise) {
    val act = reactApplicationContext.currentActivity
    if (act == null) { promise.resolve("[]"); return }
    val prev = pendingPickPromise
    pendingPickPromise = promise
    if (prev != null) { try { prev.resolve("[]") } catch (_: Exception) { } }
    act.runOnUiThread {
      try {
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
          addCategory(Intent.CATEGORY_OPENABLE)
          type = "*/*"
          putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
          addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        act.startActivityForResult(intent, GithubToolHost.MULTI_PICK_REQUEST)
      } catch (e: Exception) {
        pendingPickPromise = null
        try { android.widget.Toast.makeText(act, "Не удалось открыть выбор файлов", android.widget.Toast.LENGTH_SHORT).show() } catch (_: Exception) { }
        promise.resolve("[]")
      }
    }
  }

  @com.facebook.react.bridge.ReactMethod fun uploadAsset(id: String, uploadUrl: String, token: String, name: String, mime: String) {
    try { rnBridge.uploadAsset(id, uploadUrl, token, name, mime) } catch (e: Exception) {
      try { emitToJs("window.__ugDone", arrayOf(id, 0, (e.message ?: e.javaClass.simpleName))) } catch (_: Exception) { }
    }
  }

  @com.facebook.react.bridge.ReactMethod fun cancelTransfer(id: String) {
    try { rnBridge.cancelTransfer(id) } catch (_: Exception) { }
  }

  @com.facebook.react.bridge.ReactMethod fun goBack(promise: com.facebook.react.bridge.Promise) {
    val w = GithubToolHost.current
    if (w == null) { promise.resolve(false); return }
    w.post { w.evaluateJavascript("(function(){try{return !!(window.__onBack&&window.__onBack())}catch(e){return false}})()") { result ->
      if (result == "true") promise.resolve(true) else if (w.canGoBack()) { w.goBack(); promise.resolve(true) } else promise.resolve(false)
    } }
  }

  @com.facebook.react.bridge.ReactMethod fun openHost(promise: com.facebook.react.bridge.Promise) {
    try {
      val act = reactApplicationContext.currentActivity
      val ctx: android.content.Context = act ?: reactApplicationContext
      val i = android.content.Intent(ctx, GithubToolActivity::class.java)
      if (act == null) i.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
      ctx.startActivity(i)
      promise.resolve(true)
    } catch (e: Exception) {
      promise.reject("GITHUB_OPEN", e.message, e)
    }
  }

}


class GithubToolActivity : Activity() {
  private var web: WebView? = null
  override fun onCreate(savedInstanceState: android.os.Bundle?) {
    super.onCreate(savedInstanceState)
    try {
      window.statusBarColor = android.graphics.Color.parseColor("#181C20")
      window.navigationBarColor = android.graphics.Color.parseColor("#181C20")
      if (Build.VERSION.SDK_INT >= 23) {
        @Suppress("DEPRECATION")
        window.decorView.systemUiVisibility = window.decorView.systemUiVisibility and android.view.View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR.inv()
      }
    } catch (_: Exception) { }
    try {
      val w = WebView(this)
      web = w
      GithubToolHost.current = w
      GithubToolHost.activity = this
      try {
        w.settings.javaScriptEnabled = true
        w.settings.domStorageEnabled = true
        w.settings.allowFileAccess = true
        w.settings.allowContentAccess = true
        w.settings.cacheMode = WebSettings.LOAD_DEFAULT
        w.settings.setSupportZoom(false)
        w.settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        w.settings.allowFileAccessFromFileURLs = false
        w.settings.allowUniversalAccessFromFileURLs = false
      } catch (_: Exception) { }
      w.webViewClient = object : WebViewClient() {
        fun isLocalAsset(u: Uri?): Boolean {
          if (u == null) return false
          val s = (u.scheme ?: "").lowercase()
          if (s != "file" || !u.authority.isNullOrEmpty() || !u.query.isNullOrEmpty() || !u.fragment.isNullOrEmpty()) return false
          val p = u.path ?: return false
          return Regex("^/android_asset/github-tool/[A-Za-z0-9_.-]+\\\\.html$").matches(p)
        }
        override fun shouldOverrideUrlLoading(view: WebView?, request: android.webkit.WebResourceRequest?): Boolean {
          val url = request?.url ?: return true
          if (isLocalAsset(url)) return false
          if (url.scheme == "https" && url.host?.lowercase() in setOf("github.com", "www.github.com")) {
            try { startActivity(Intent(Intent.ACTION_VIEW, url)) } catch (_: Exception) {}
            return true
          }
          // Block other external schemes; allow about:blank
          if ((url.scheme ?: "") == "about") return false
          return true
        }
        override fun shouldOverrideUrlLoading(view: WebView?, url: String?): Boolean {
          if (url == null) return true
          val u = try { Uri.parse(url) } catch (_: Exception) { return true }
          if (isLocalAsset(u)) return false
          if (u.scheme == "https" && u.host?.lowercase() in setOf("github.com", "www.github.com")) {
            try { startActivity(Intent(Intent.ACTION_VIEW, u)) } catch (_: Exception) {}
            return true
          }
          if ((u.scheme ?: "") == "about") return false
          return true
        }
        override fun onRenderProcessGone(view: WebView?, detail: android.webkit.RenderProcessGoneDetail?): Boolean {
          try {
            if (GithubToolHost.current === view) GithubToolHost.current = null
            view?.destroy()
          } catch (_: Exception) { }
          try {
            recreate()
          } catch (_: Exception) {
            finish()
          }
          return true
        }
        override fun onReceivedError(view: WebView?, request: android.webkit.WebResourceRequest?, error: android.webkit.WebResourceError?) {
          if (request?.isForMainFrame == true) {
            try {
              Toast.makeText(this@GithubToolActivity, "Ошибка загрузки: " + (error?.description ?: ""), Toast.LENGTH_SHORT).show()
            } catch (_: Exception) { }
          }
        }
      }
      w.webChromeClient = object : WebChromeClient() {
        override fun onJsAlert(view: WebView?, url: String?, message: String?, result: android.webkit.JsResult?): Boolean {
          try {
            android.app.AlertDialog.Builder(this@GithubToolActivity)
              .setMessage(message ?: "")
              .setPositiveButton(android.R.string.ok) { _, _ -> result?.confirm() }
              .setOnCancelListener { result?.cancel() }
              .show()
          } catch (_: Exception) { result?.confirm() }
          return true
        }
        override fun onJsConfirm(view: WebView?, url: String?, message: String?, result: android.webkit.JsResult?): Boolean {
          try {
            android.app.AlertDialog.Builder(this@GithubToolActivity)
              .setMessage(message ?: "")
              .setPositiveButton(android.R.string.ok) { _, _ -> result?.confirm() }
              .setNegativeButton(android.R.string.cancel) { _, _ -> result?.cancel() }
              .setOnCancelListener { result?.cancel() }
              .show()
          } catch (_: Exception) { result?.cancel() }
          return true
        }
        override fun onShowFileChooser(
          view: WebView?,
          filePathCallback: ValueCallback<Array<Uri>>?,
          fileChooserParams: FileChooserParams?
        ): Boolean {
          GithubToolHost.pendingFileCallback?.onReceiveValue(null)
          GithubToolHost.pendingFileCallback = filePathCallback
          return try {
            val intent = fileChooserParams?.createIntent() ?: Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
              addCategory(Intent.CATEGORY_OPENABLE); type = "*/*"; putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
            }
            startActivityForResult(intent, GithubToolHost.FILE_PICK_REQUEST)
            true
          } catch (_: ActivityNotFoundException) {
            GithubToolHost.pendingFileCallback = null
            false
          }
        }
      }
      w.addJavascriptInterface(GithubToolBridge(this), "AndroidInterface")
      if (savedInstanceState != null) {
        try { w.restoreState(savedInstanceState) } catch (_: Exception) {
          w.loadUrl("file:///android_asset/github-tool/repos.html")
        }
        if (w.url.isNullOrBlank()) w.loadUrl("file:///android_asset/github-tool/repos.html")
      } else {
        w.loadUrl("file:///android_asset/github-tool/repos.html")
      }
      setContentView(w)
    } catch (e: Exception) {
      Toast.makeText(this, "GitHub WebView: " + (e.message ?: e.toString()), Toast.LENGTH_LONG).show()
      finish()
    }
  }
  override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
    super.onActivityResult(requestCode, resultCode, data)
    if (requestCode == GithubToolHost.SAVE_DOC_REQUEST) {
      val dataBytes = GithubToolHost.pendingSave
      GithubToolHost.pendingSave = null
      val completion = GithubToolHost.pendingSavePromise
      GithubToolHost.pendingSavePromise = null
      if (resultCode != Activity.RESULT_OK || data?.data == null || dataBytes == null) {
        completion?.reject("GITHUB_SAVE_CANCELLED", "Сохранение отменено")
        try { Toast.makeText(this, "Сохранение отменено", Toast.LENGTH_SHORT).show() } catch (_: Exception) {}
        return
      }
      try {
        val output = contentResolver.openOutputStream(data.data!!) ?: throw IllegalStateException("Не удалось открыть файл для записи")
        output.use { it.write(dataBytes); it.flush() }
        completion?.resolve(true)
        Toast.makeText(this, "Файл сохранён", Toast.LENGTH_SHORT).show()
      } catch (e: Exception) {
        try { contentResolver.delete(data.data!!, null, null) } catch (_: Exception) {}
        completion?.reject("GITHUB_SAVE_WRITE", e)
        Toast.makeText(this, "Ошибка записи: " + (e.message ?: ""), Toast.LENGTH_LONG).show()
      }
      return
    }
    if (requestCode == GithubToolHost.MULTI_PICK_REQUEST) {
      val bridge = GithubToolBridge(this)
      if (resultCode != Activity.RESULT_OK || data == null) {
        bridge.jsCallPublic("window.__ugPicked", "[]")
        return
      }
      val arr = org.json.JSONArray()
      val list = mutableListOf<Uri>()
      val clip = data.clipData
      if (clip != null) {
        for (i in 0 until clip.itemCount) list.add(clip.getItemAt(i).uri)
      } else {
        data.data?.let { list.add(it) }
      }
      for (uri in list) {
        try {
          contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
        } catch (_: Exception) { }
        val (name, size) = GithubToolHost.queryMeta(this, uri)
        val mime = try { contentResolver.getType(uri) } catch (_: Exception) { null } ?: "application/octet-stream"
        val id = java.util.UUID.randomUUID().toString()
        GithubToolHost.pickedFiles[id] = GithubToolHost.PickedFile(uri, name, size, mime)
        arr.put(org.json.JSONObject().apply {
          put("id", id)
          put("name", name)
          put("size", size)
          put("mime", mime)
        })
      }
      bridge.jsCallPublic("window.__ugPicked", arr.toString())
      return
    }
    if (requestCode == GithubToolHost.CREATE_DOC_REQUEST) {
      val p = GithubToolHost.pendingDownload
      GithubToolHost.pendingDownload = null
      if (p == null) return
      if (resultCode != Activity.RESULT_OK || data?.data == null) {
        GithubToolBridge(this).jsCallPublic("window.__ugDownloadDone", p.id, false, "cancel")
        return
      }
      val dest = data.data!!
      GithubToolHost.transfers[p.id] = false
      GithubToolHost.downloadExecutor.execute {
        var conn: HttpURLConnection? = null
        var ok = false
        try {
          var url = p.url
          val initialUrl = try { URL(url) } catch (_: Exception) { null }
          if (initialUrl == null || initialUrl.protocol != "https" || initialUrl.userInfo != null || !initialUrl.host.equals("api.github.com", ignoreCase = true) || (if (initialUrl.port >= 0) initialUrl.port else initialUrl.defaultPort) != 443) throw java.io.IOException("Unsafe initial GitHub API URL")
          var withAuth = true
          var hops = 0
          var total = -1L
          var stream: java.io.InputStream? = null
          while (true) {
            val c = (URL(url).openConnection() as HttpURLConnection)
            conn = c
            c.instanceFollowRedirects = false
            c.connectTimeout = 30000
            c.readTimeout = 300000
            if (withAuth) c.setRequestProperty("Authorization", "token " + p.token)
            c.setRequestProperty("Accept", "application/octet-stream")
            c.setRequestProperty("X-GitHub-Api-Version", "2022-11-28")
            val st = c.responseCode
            if (st == 301 || st == 302 || st == 303 || st == 307 || st == 308) {
              val loc = c.getHeaderField("Location") ?: throw java.io.IOException("Пустое перенаправление")
              c.disconnect()
              hops++
              if (hops > 5) throw java.io.IOException("Слишком много перенаправлений")
              val nextUrl = URL(URL(url), loc)
              val nextHost = nextUrl.host.lowercase()
              val redirectHosts = setOf(
                "api.github.com", "uploads.github.com", "raw.githubusercontent.com",
                "github.com", "www.github.com", "objects.githubusercontent.com",
                "codeload.github.com", "release-assets.githubusercontent.com"
              )
              val redirectAllowed = nextHost in redirectHosts || nextHost.endsWith(".githubusercontent.com")
              if (nextUrl.protocol != "https" || nextUrl.userInfo != null || (nextUrl.port >= 0 && nextUrl.port != 443) || !redirectAllowed) throw java.io.IOException("Небезопасное перенаправление")
              url = nextUrl.toString()
              withAuth = withAuth && nextHost == "api.github.com" && (if (nextUrl.port >= 0) nextUrl.port else nextUrl.defaultPort) == 443
              continue
            }
            if (st !in 200..299) {
              val err = try { c.errorStream?.bufferedReader()?.readText()?.take(300) } catch (_: Exception) { null }
              throw java.io.IOException("HTTP $st" + (err?.let { ": $it" } ?: ""))
            }
            total = c.contentLengthLong.let { if (it > 0) it else -1L }
            stream = c.inputStream
            break
          }
          var sent = 0L
          var lastEmit = 0L
          contentResolver.openOutputStream(dest)?.use { os ->
            (stream ?: throw java.io.IOException("Пустой ответ")).use { input ->
              val buf = ByteArray(64 * 1024)
              while (true) {
                if (GithubToolHost.transfers[p.id] == true) throw java.io.InterruptedIOException("cancel")
                val n = input.read(buf)
                if (n < 0) break
                os.write(buf, 0, n)
                sent += n
                val now = System.currentTimeMillis()
                if (now - lastEmit > 200) {
                  lastEmit = now
                  GithubToolBridge(this@GithubToolActivity).jsCallPublic("window.__ugProgress", p.id, sent, if (total > 0) total else sent)
                }
              }
            }
          } ?: throw java.io.IOException("Не удалось открыть файл для записи")
          ok = true
          GithubToolBridge(this@GithubToolActivity).jsCallPublic("window.__ugProgress", p.id, sent, sent)
          GithubToolBridge(this@GithubToolActivity).jsCallPublic("window.__ugDownloadDone", p.id, true, dest.toString())
        } catch (e: java.io.InterruptedIOException) {
          GithubToolBridge(this@GithubToolActivity).jsCallPublic("window.__ugDownloadDone", p.id, false, "cancel")
        } catch (e: Exception) {
          GithubToolBridge(this@GithubToolActivity).jsCallPublic("window.__ugDownloadDone", p.id, false, e.message ?: e.toString())
        } finally {
          GithubToolHost.transfers.remove(p.id)
          try { conn?.disconnect() } catch (_: Exception) { }
          if (!ok) {
            try { contentResolver.delete(dest, null, null) } catch (_: Exception) { }
          }
        }
      }
      return
    }
    if (requestCode != GithubToolHost.FILE_PICK_REQUEST) return
    val cb = GithubToolHost.pendingFileCallback ?: return
    GithubToolHost.pendingFileCallback = null
    val uris = if (resultCode == Activity.RESULT_OK) {
      val clip = data?.clipData
      if (clip != null) Array(clip.itemCount) { i -> clip.getItemAt(i).uri }
      else data?.data?.let { arrayOf(it) } ?: emptyArray()
    } else emptyArray()
    cb.onReceiveValue(uris)
  }

  override fun onSaveInstanceState(outState: android.os.Bundle) {
    super.onSaveInstanceState(outState)
    try { web?.saveState(outState) } catch (_: Exception) { }
  }

  override fun onBackPressed() {
    val w = web
    if (w != null) {
      w.evaluateJavascript("(function(){try{return !!(window.__onBack&&window.__onBack())}catch(e){return false}})()") { result ->
        if (result == "true") return@evaluateJavascript
        if (w.canGoBack()) w.goBack() else finish()
      }
    } else finish()
  }
  override fun onDestroy() {
    try {
      if (GithubToolHost.current === web) GithubToolHost.current = null
      if (GithubToolHost.activity === this) GithubToolHost.activity = null
      web?.removeJavascriptInterface("AndroidInterface")
      web?.destroy()
    } catch (_: Exception) { }
    web = null
    super.onDestroy()
  }
}

class GithubToolPackage : com.facebook.react.ReactPackage {
  override fun createNativeModules(c: com.facebook.react.bridge.ReactApplicationContext) = listOf(GithubToolModule(c))
  override fun createViewManagers(c: com.facebook.react.bridge.ReactApplicationContext) = emptyList<com.facebook.react.uimanager.ViewManager<*, *>>()
}
`;
}

function withGithubFiles(config) {
  return withDangerousMod(config, ['android', async (config) => {
    const root = config.modRequest.platformProjectRoot;
    const pkg = config.android?.package || 'com.karat.aibuilder';
    const pkgPath = pkg.replace(/\./g, '/');
    const src = path.join(config.modRequest.projectRoot, 'assets', 'github-tool');
    const dst = path.join(root, 'app', 'src', 'main', 'assets', 'github-tool');
    fs.mkdirSync(dst, { recursive: true });
    fs.cpSync(src, dst, { recursive: true });
    const javaDir = path.join(root, 'app', 'src', 'main', 'java', pkgPath);
    fs.mkdirSync(javaDir, { recursive: true });
    fs.writeFileSync(path.join(javaDir, 'GithubToolNative.kt'), bridgeKotlin(pkg), 'utf8');
    return config;
  }]);
}

function withGithubMainApplication(config) {
  return withMainApplication(config, (config) => {
    let contents = config.modResults.contents;
    const registrationSource = contents
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/^\s*\/\/.*$/gm, " ")
      .replace(/(\s)\/\/.*$/gm, "$1");
    if (/\badd\s*\(\s*(?:new\s+)?GithubToolPackage\s*\(\s*\)\s*\)/.test(registrationSource)) return config;
    const isKotlin = config.modResults.language === "kt";
    let matched = false;
    if (isKotlin) {
      const applyPattern = /(PackageList\s*\(\s*this\s*\)\s*\.packages)(\s*\.toMutableList\s*\(\s*\))?(\s*\.apply\s*\{)/;
      const packagesAssignment = /\bval\s+packages\s*=\s*PackageList\s*\(\s*this\s*\)\s*\.packages(?:\s*\.toMutableList\s*\(\s*\))?/;
      const packagesReturn = /\breturn\s+PackageList\s*\(\s*this\s*\)\s*\.packages(?:\s*\.toMutableList\s*\(\s*\))?\s*;?/;
      if (applyPattern.test(contents)) {
        contents = contents.replace(applyPattern, (_match, packageList, mutableList, apply) =>
          `${packageList}${mutableList || ".toMutableList()"}${apply}\n              add(GithubToolPackage())`);
        matched = true;
      } else {
        if (packagesAssignment.test(contents)) {
          contents = contents.replace(packagesAssignment, "val packages = PackageList(this).packages.toMutableList()\n            packages.add(GithubToolPackage())");
          matched = true;
        } else if (packagesReturn.test(contents)) {
          contents = contents.replace(packagesReturn, "val packages = PackageList(this).packages.toMutableList()\n            packages.add(GithubToolPackage())\n            return packages");
          matched = true;
        }
      }
    } else {
      const javaAssignment = /\bList\s*<\s*ReactPackage\s*>\s+packages\s*=\s*new\s+PackageList\s*\(\s*this\s*\)\s*\.getPackages\s*\(\s*\)\s*;/;
      const javaReturn = /\breturn\s+new\s+PackageList\s*\(\s*this\s*\)\s*\.getPackages\s*\(\s*\)\s*;/;
      if (javaAssignment.test(contents)) {
        contents = contents.replace(javaAssignment, (match) => match + "\n      packages.add(new GithubToolPackage());");
        matched = true;
      } else if (javaReturn.test(contents)) {
        contents = contents.replace(javaReturn, "List<ReactPackage> packages = new PackageList(this).getPackages();\n      packages.add(new GithubToolPackage());\n      return packages;");
        matched = true;
      }
    }
    if (!matched) throw new Error("[withGithubTool] Не удалось зарегистрировать GithubToolPackage в MainApplication");
    config.modResults.contents = contents;
    return config;
  });
}


function withGithubActivity(config) {
  return withAndroidManifest(config, (config) => {
    const app = config.modResults.manifest.application?.[0];
    if (!app) return config;
    app.activity = app.activity || [];
    const name = '.GithubToolActivity';
    if (!app.activity.some((a) => a.$?.['android:name'] === name || a.$?.['android:name']?.endsWith('GithubToolActivity'))) {
      app.activity.push({
        $: {
          'android:name': name,
          'android:exported': 'false',
          'android:screenOrientation': 'portrait',
          'android:configChanges': 'keyboard|keyboardHidden|orientation|screenSize',
          'android:windowSoftInputMode': 'adjustResize',
        },
      });
    }
    return config;
  });
}

function withScopedStoragePermissionRemovals(config) {
  return withAndroidManifest(config, (config) => {
    const manifest = config.modResults.manifest;
    manifest.$ = manifest.$ || {};
    if (!manifest.$["xmlns:tools"]) {
      manifest.$["xmlns:tools"] = "http://schemas.android.com/tools";
    }
    if (!Array.isArray(manifest["uses-permission"])) manifest["uses-permission"] = [];

    // The pinned expo-image-picker and expo-file-system manifests declare
    // legacy broad-storage permissions, although these picker flows are scoped.
    // Expo's bare template also adds SYSTEM_ALERT_WINDOW as an optional
    // permission; this app has no overlay UI/request flow, so do not ship it.
    for (const name of [
      "android.permission.READ_EXTERNAL_STORAGE",
      "android.permission.WRITE_EXTERNAL_STORAGE",
      "android.permission.SYSTEM_ALERT_WINDOW",
    ]) {
      const matches = manifest["uses-permission"].filter((permission) => permission?.$?.["android:name"] === name);
      if (matches.length === 0) {
        manifest["uses-permission"].push({ $: { "android:name": name, "tools:node": "remove" } });
      } else {
        for (const permission of matches) permission.$["tools:node"] = "remove";
      }
    }
    return config;
  });
}

module.exports = function withGithubTool(config) {
  config = withGithubFiles(config);
  config = withGithubMainApplication(config);
  config = withGithubActivity(config);
  config = withScopedStoragePermissionRemovals(config);
  return config;
};
