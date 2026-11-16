const {
  withAndroidManifest,
  withMainApplication,
  withDangerousMod,
} = require("@expo/config-plugins");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const OFFLINE_PACKAGE_SIGNER_CERT_DER = fs.readFileSync(path.join(__dirname, "..", "assets", "offline-package-signing", "karat-current-cert.der"));
const OFFLINE_PACKAGE_SIGNER_CERT_BASE64 = OFFLINE_PACKAGE_SIGNER_CERT_DER.toString("base64");
const OFFLINE_PACKAGE_SIGNER_CERT_SHA256 = crypto.createHash("sha256").update(OFFLINE_PACKAGE_SIGNER_CERT_DER).digest("hex");
const bootstrapInstallerKotlin = require("./termuxBootstrapInstallerKotlin");
const { candidateProbeKotlin, stageCandidateProbeAssets } = require("./candidateFeedProbe");
const { candidateFullKotlin, stageFullCandidateAssets } = require("./candidateFullFeed");
const { PRIVATE_PACKAGE_MUTATION_PATTERNS } = require("./privatePackageShellPolicy");
/**
 * Integrates AI Builder's bundled app-private Termux-compatible userland.
 * The bundled bootstrap is built for this exact application ID and arm64-v8a ABI; it is hash-verified,
 * installed atomically under filesDir, and never replaces an unmanaged prefix. This is a userland bundle,
 * not the Termux application or a Linux kernel. Legacy native method names remain
 * available to JavaScript callers; all command execution uses the bundled private runtime.
 */


function moduleKotlin(pkg) {
  return `package ${pkg}

import android.app.Activity
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Debug
import android.os.Environment
import android.os.ParcelFileDescriptor
import android.provider.DocumentsContract
import android.provider.OpenableColumns
import android.provider.Settings
import android.system.Os
import android.system.OsConstants
import androidx.core.content.FileProvider
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap
import com.facebook.react.bridge.ActivityEventListener
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.security.MessageDigest
import android.app.PendingIntent
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

/**
 * Native bridge for the bundled private runtime. Legacy JS method names are retained,
 * and never discovers or dispatches to the external Termux application. Generic app utilities remain available.
 */
private data class TermuxCommandCallback(
    val commandId: String,
    val stdout: String,
    val stderr: String,
    val exitCode: Int,
    val errCode: Int,
    val errMsg: String,
    val outputTruncated: Boolean
)

private object TermuxResultStore {
    private val waiters = java.util.concurrent.ConcurrentHashMap<String, java.util.concurrent.CountDownLatch>()
    private val results = java.util.concurrent.ConcurrentHashMap<String, TermuxCommandCallback>()

    fun register(id: String) {
        waiters[id] = java.util.concurrent.CountDownLatch(1)
    }

    fun publish(id: String, result: TermuxCommandCallback) {
        // A callback can arrive after the waiter timed out or was cancelled.
        // Do not retain an orphan result; accept only one callback per request.
        val latch = waiters[id] ?: return
        if (results.putIfAbsent(id, result) != null) return
        if (waiters.remove(id, latch)) latch.countDown()
        else results.remove(id, result)
    }

    fun await(id: String, timeoutMs: Long): TermuxCommandCallback? {
        val latch = waiters[id] ?: return results.remove(id)
        latch.await(timeoutMs, java.util.concurrent.TimeUnit.MILLISECONDS)
        return results.remove(id)
    }

    fun cancel(id: String) {
        val latch = waiters.remove(id)
        if (latch != null) {
            results.putIfAbsent(
                id,
                TermuxCommandCallback(
                    id,
                    "",
                    "AIB_COMMAND_CANCELLED",
                    -1,
                    0,
                    "cancelled",
                    false
                )
            )
            latch.countDown()
        } else {
            results.remove(id)
        }
    }

    /** Drop a waiter after its callback deadline without pretending the Termux process was cancelled. */
    fun abandon(id: String) {
        waiters.remove(id)
        results.remove(id)
    }

  fun cancelAll(): Int {
    val ids = waiters.keys.toList()
    for (id in ids) cancel(id)
    return ids.size
  }
}

private object AibEmbeddedProcessRegistry {
    val active = ConcurrentHashMap<String, Process>()
    val rootPids = ConcurrentHashMap<String, AibEmbeddedTrackedRoot>()
    val pending = ConcurrentHashMap.newKeySet<String>()
    val cancelRequested = ConcurrentHashMap.newKeySet<String>()
    val descendants = ConcurrentHashMap<String, ConcurrentHashMap<Int, String>>()
    val slots = java.util.concurrent.Semaphore(2, true)
    val lifecycleLock = Any()
}

/** Reserve a request ID and its process slot as one registry operation. */
private fun reserveAibEmbeddedRequest(id: String): String? = synchronized(AibEmbeddedProcessRegistry.lifecycleLock) {
    if (AibEmbeddedProcessRegistry.pending.contains(id)) return@synchronized "in_use"
    if (!AibEmbeddedProcessRegistry.slots.tryAcquire()) return@synchronized "busy"
    if (!AibEmbeddedProcessRegistry.pending.add(id)) {
        AibEmbeddedProcessRegistry.slots.release()
        return@synchronized "in_use"
    }
    null
}

/** Remove cancellation state and release the owned slot exactly once. */
private fun releaseAibEmbeddedRequest(id: String) = synchronized(AibEmbeddedProcessRegistry.lifecycleLock) {
    if (AibEmbeddedProcessRegistry.pending.remove(id)) {
        AibEmbeddedProcessRegistry.cancelRequested.remove(id)
        AibEmbeddedProcessRegistry.slots.release()
    } else {
        AibEmbeddedProcessRegistry.cancelRequested.remove(id)
    }
}

private fun requestAibEmbeddedCancellation(id: String): Boolean = synchronized(AibEmbeddedProcessRegistry.lifecycleLock) {
    if (!AibEmbeddedProcessRegistry.pending.contains(id)) false
    else { AibEmbeddedProcessRegistry.cancelRequested.add(id); true }
}

private data class AibEmbeddedCapturedOutput(val text: String, val truncated: Boolean)
private data class AibEmbeddedTrackedRoot(val pid: Int, val startTicks: String)

private fun captureAibEmbeddedOutput(stream: java.io.InputStream): AibEmbeddedCapturedOutput {
    val reader = stream.bufferedReader(Charsets.UTF_8)
    val text = StringBuilder()
    val buffer = CharArray(8192)
    val limit = 512 * 1024
    var length = 0
    var truncated = false
    while (true) {
        val count = reader.read(buffer)
        if (count < 0) break
        val accepted = minOf(count, limit - length)
        if (accepted > 0) {
            text.append(buffer, 0, accepted)
            length += accepted
        }
        if (accepted < count) truncated = true
    }
    return AibEmbeddedCapturedOutput(text.toString(), truncated)
}

private fun captureAibEmbeddedPackageOutput(
    stream: java.io.InputStream,
    maxBytes: Int,
    maxLines: Int
): AibEmbeddedCapturedOutput {
    val output = java.io.ByteArrayOutputStream(minOf(maxBytes, 8192))
    val buffer = ByteArray(4096)
    var lineCount = 0
    var truncated = false
    while (true) {
        val count = stream.read(buffer)
        if (count < 0) break
        for (index in 0 until count) {
            val value = buffer[index].toInt() and 0xff
            if (lineCount >= maxLines || output.size() >= maxBytes) {
                truncated = true
                continue
            }
            output.write(value)
            if (value == '\\n'.code) lineCount += 1
        }
    }
    var bytes = output.toByteArray()
    if (truncated && bytes.isNotEmpty() && bytes.last() != '\\n'.code.toByte()) {
        var lastNewline = bytes.size - 1
        while (lastNewline >= 0 && bytes[lastNewline] != '\\n'.code.toByte()) lastNewline -= 1
        bytes = if (lastNewline >= 0) bytes.copyOf(lastNewline + 1) else ByteArray(0)
    }
    return AibEmbeddedCapturedOutput(String(bytes, Charsets.UTF_8), truncated)
}

/** Close both helper pipes and join their readers before the process slot can be returned. */
private fun stopAibEmbeddedPackageReaders(process: Process, readers: List<Thread>): Boolean {
    for (reader in readers) try { reader.join(1_000L) } catch (_: InterruptedException) { Thread.currentThread().interrupt() }
    if (readers.any { it.isAlive }) {
        try { process.inputStream.close() } catch (_: Throwable) { }
        try { process.errorStream.close() } catch (_: Throwable) { }
        readers.forEach { it.interrupt() }
        for (reader in readers) try { reader.join(1_000L) } catch (_: InterruptedException) { Thread.currentThread().interrupt() }
    }
    return readers.none { it.isAlive }
}

private fun aibProcStartTicks(pid: Int): String? = try {
    val stat = File("/proc/$pid/stat").readText(Charsets.US_ASCII)
    val fields = stat.substring(stat.lastIndexOf(')') + 1).trim().split(Regex("\\\\s+"))
    fields.getOrNull(19)
} catch (_: Throwable) { null }

/** Obtain the shell PID through its private handshake file; fail closed if /proc cannot validate it. */
private fun awaitAibEmbeddedRootPid(process: Process, pidFile: File, timeoutMs: Long): AibEmbeddedTrackedRoot? {
    val deadline = System.nanoTime() + timeoutMs.coerceIn(1L, 2000L) * 1_000_000L
    while (System.nanoTime() < deadline) {
        try {
            if (pidFile.canonicalPath == pidFile.absolutePath && pidFile.isFile &&
                (Os.lstat(pidFile.absolutePath).st_mode and OsConstants.S_IFMT) == OsConstants.S_IFREG) {
                val text = pidFile.readText(Charsets.US_ASCII).trim()
                if (text.matches(Regex("^[1-9][0-9]{0,9}$"))) {
                    val pid = text.toIntOrNull()
                    val startTicks = pid?.takeIf { it > 1 }?.let { aibProcStartTicks(it) }
                    if (pid != null && startTicks != null) {
                        try { process.exitValue() } catch (_: IllegalThreadStateException) {
                            return AibEmbeddedTrackedRoot(pid, startTicks)
                        }
                        return null
                    }
                }
            }
        } catch (_: Throwable) { }
        try { process.exitValue(); return null } catch (_: IllegalThreadStateException) { }
        Thread.sleep(10)
    }
    return null
}

/** Record only processes observed as descendants of this request's shell. */
private fun trackAibEmbeddedDescendants(rootPid: Int, tracked: ConcurrentHashMap<Int, String>) {
    val visited = HashSet<Int>()
    fun visit(parent: Int, depth: Int) {
        if (depth > 64 || !visited.add(parent)) return
    val taskDir = File("/proc/$parent/task")
    val tasks = taskDir.listFiles()?.mapNotNull { it.name.toIntOrNull() } ?: listOf(parent)
    for (task in tasks) {
        val children = try { File("/proc/$parent/task/$task/children").readText(Charsets.US_ASCII).trim().split(Regex("\\\\s+")).mapNotNull { it.toIntOrNull() } } catch (_: Throwable) { emptyList() }
        for (child in children) {
            val stat = try { File("/proc/$child/stat").readText(Charsets.US_ASCII) } catch (_: Throwable) { continue }
            val fields = stat.substring(stat.lastIndexOf(')') + 1).trim().split(Regex("\\\\s+"))
            if (fields.getOrNull(1)?.toIntOrNull() != parent) continue
            val startTicks = fields.getOrNull(19) ?: continue
                tracked.putIfAbsent(child, startTicks)
                visit(child, depth + 1)
                if (visited.size >= 4096) return
            }
        }
    }
    visit(rootPid, 0)
}

private fun sendAibTrackedSignal(tracked: Map<Int, String>, signal: Int) {
    for ((pid, startTicks) in tracked.entries.toList()) {
        try {
            if (aibProcStartTicks(pid) == startTicks) Os.kill(pid, signal)
        } catch (_: Throwable) { }
    }
}

private fun stopAibEmbeddedProcess(process: Process, root: AibEmbeddedTrackedRoot, tracked: ConcurrentHashMap<Int, String>? = null): Boolean {
    val owned = tracked ?: ConcurrentHashMap<Int, String>()
    val rootPid = root.pid
    trackAibEmbeddedDescendants(rootPid, owned)
    sendAibTrackedSignal(owned, OsConstants.SIGTERM)
    try { process.destroy() } catch (_: Throwable) { }
    val gracefulDeadline = System.nanoTime() + 750_000_000L
    while (System.nanoTime() < gracefulDeadline) {
        trackAibEmbeddedDescendants(rootPid, owned)
        val rootAlive = try { process.exitValue(); false } catch (_: IllegalThreadStateException) { true }
        if (!rootAlive && owned.keys.none { aibProcStartTicks(it) == owned[it] }) return true
        Thread.sleep(25)
    }
    trackAibEmbeddedDescendants(rootPid, owned)
    sendAibTrackedSignal(owned, OsConstants.SIGKILL)
    try { if (aibProcStartTicks(root.pid) == root.startTicks) Os.kill(root.pid, OsConstants.SIGKILL) } catch (_: Throwable) { }
    try { process.javaClass.getMethod("destroyForcibly").invoke(process) } catch (_: Throwable) { try { process.destroy() } catch (_: Throwable) { } }
    val killDeadline = System.nanoTime() + 750_000_000L
    while (System.nanoTime() < killDeadline) {
        val rootAlive = try { process.exitValue(); false } catch (_: IllegalThreadStateException) { true }
        if (!rootAlive && owned.keys.none { aibProcStartTicks(it) == owned[it] }) return true
        Thread.sleep(25)
    }
    val rootAlive = try { process.exitValue(); false } catch (_: IllegalThreadStateException) { true }
    return !rootAlive && owned.keys.none { aibProcStartTicks(it) == owned[it] }
}

private fun waitForAibEmbeddedProcess(process: Process, timeoutMs: Long, root: AibEmbeddedTrackedRoot, tracked: ConcurrentHashMap<Int, String>): Pair<Boolean, Int> {
    val deadline = System.nanoTime() + timeoutMs * 1_000_000L
    while (System.nanoTime() < deadline) {
        trackAibEmbeddedDescendants(root.pid, tracked)
        try { return Pair(false, process.exitValue()) } catch (_: IllegalThreadStateException) { }
        Thread.sleep(25)
    }
    if (!stopAibEmbeddedProcess(process, root, tracked)) throw java.io.IOException("embedded_process_cleanup_failed")
    return Pair(true, try { process.exitValue() } catch (_: IllegalThreadStateException) { 124 })
}

/** API-24-compatible bounded wait for short-lived fixed-executable helpers that do not need descendant tracking. */
private fun waitForAibEmbeddedProcess(process: Process, timeoutMs: Long): Pair<Boolean, Int> {
    val deadline = System.nanoTime() + timeoutMs.coerceAtLeast(1L) * 1_000_000L
    while (System.nanoTime() < deadline) {
        try { return Pair(false, process.exitValue()) } catch (_: IllegalThreadStateException) { }
        Thread.sleep(25)
    }
    try { process.destroy() } catch (_: Throwable) { }
    val stopDeadline = System.nanoTime() + 750_000_000L
    while (System.nanoTime() < stopDeadline) {
        try { return Pair(true, process.exitValue()) } catch (_: IllegalThreadStateException) { }
        Thread.sleep(25)
    }
    return Pair(true, try { process.exitValue() } catch (_: IllegalThreadStateException) { 124 })
}

private fun cleanupAibEmbeddedDescendants(rootPid: Int, tracked: ConcurrentHashMap<Int, String>): Boolean {
    trackAibEmbeddedDescendants(rootPid, tracked)
    sendAibTrackedSignal(tracked, OsConstants.SIGTERM)
    val deadline = System.nanoTime() + 500_000_000L
    while (System.nanoTime() < deadline && tracked.keys.any { aibProcStartTicks(it) == tracked[it] }) Thread.sleep(25)
    sendAibTrackedSignal(tracked, OsConstants.SIGKILL)
    val killDeadline = System.nanoTime() + 500_000_000L
    while (System.nanoTime() < killDeadline && tracked.keys.any { aibProcStartTicks(it) == tracked[it] }) Thread.sleep(25)
    return tracked.keys.none { aibProcStartTicks(it) == tracked[it] }
}

class TermuxResultReceiver : android.content.BroadcastReceiver() {
    companion object {
        const val EXTRA_EXECUTION_ID = "aibuilder.termux.execution_id"
    }

    override fun onReceive(context: Context?, intent: Intent?) {
        if (intent == null) return
        val id = intent.getStringExtra(EXTRA_EXECUTION_ID) ?: return
        val bundle = intent.getBundleExtra("result")
        if (bundle == null) {
            TermuxResultStore.publish(id, TermuxCommandCallback(id, "", "TERMUX_RESULT_BUNDLE_MISSING", -1, Int.MIN_VALUE, "result bundle missing", false))
            return
        }
        val stdout = bundle.getString("stdout", "")
        val stderr = bundle.getString("stderr", "")
        fun originalLength(key: String, actual: String): Long {
            val raw = bundle.get(key)
            return (raw as? Number)?.toLong() ?: raw?.toString()?.toLongOrNull() ?: actual.length.toLong()
        }
        val outputTruncated = originalLength("stdout_original_length", stdout) > stdout.length ||
            originalLength("stderr_original_length", stderr) > stderr.length
        TermuxResultStore.publish(
            id,
            TermuxCommandCallback(
                commandId = id,
                stdout = stdout,
                stderr = stderr,
                exitCode = bundle.getInt("exitCode", -1),
                // Callback parsing retained only for backwards-compatible internal event handling.
                // only when Termux raised no internal service/session error.
                errCode = if (bundle.containsKey("err")) bundle.getInt("err", Int.MIN_VALUE) else Int.MIN_VALUE,
                errMsg = bundle.getString("errmsg", ""),
                outputTruncated = outputTruncated
            )
        )
    }
}

class TermuxLiveOutputReceiver(private val module: TermuxBridgeModule) : android.content.BroadcastReceiver() {
    override fun onReceive(context: Context?, intent: Intent?) {
        if (intent == null) return
        module.forwardLiveOutput(
            intent.getStringExtra("cmdId") ?: "",
            intent.getStringExtra("stream") ?: "stdout",
            intent.getStringExtra("chunk") ?: ""
        )
    }
}

class TermuxBridgeModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    private var liveReceiver: TermuxLiveOutputReceiver? = null
    private var pendingModelExportPromise: Promise? = null
    private var pendingModelExportFiles: Array<String>? = null
    private var pendingModelExportNames: Array<String>? = null
    private val modelExportRequestCode = 48321
    private var pendingOfflineArchivePickerPromise: Promise? = null
    private val offlineArchivePickerRequestCode = 48323
    private val maxOfflineArchiveBytes = 200L * 1024L * 1024L
    private var pendingAIBuilderWorkspaceGrantPromise: Promise? = null
    private val aiBuilderWorkspaceGrantRequestCode = 48322
    private val aiBuilderWorkspaceAuthority = "com.android.externalstorage.documents"
    private val aiBuilderWorkspaceTreeDocumentId = "primary:AIBuilderTermux"

    private val activityEventListener = object : ActivityEventListener {
        override fun onActivityResult(activity: Activity, requestCode: Int, resultCode: Int, data: Intent?) {
            if (requestCode == offlineArchivePickerRequestCode) {
                val promise = pendingOfflineArchivePickerPromise
                pendingOfflineArchivePickerPromise = null
                if (promise == null) return
                if (resultCode != Activity.RESULT_OK) {
                    val result = Arguments.createMap()
                    result.putBoolean("canceled", true)
                    promise.resolve(result)
                    return
                }
                val sourceUri = data?.data ?: data?.clipData?.let { clip ->
                    if (clip.itemCount > 0) clip.getItemAt(0).uri else null
                }
                if (sourceUri == null) {
                    promise.reject("AIB_OFFLINE_PACKAGE_PICKER_URI_MISSING", "AIB_OFFLINE_PACKAGE_PICKER_URI_MISSING", null)
                    return
                }
                Thread {
                    try {
                        val copiedFile = copyOfflineArchiveToPrivateCache(sourceUri)
                        val result = Arguments.createMap()
                        result.putBoolean("canceled", false)
                        result.putString("uri", Uri.fromFile(copiedFile).toString())
                        promise.resolve(result)
                    } catch (e: Exception) {
                        val code = if (e.message == "AIB_OFFLINE_PACKAGE_ARCHIVE_SIZE_INVALID") {
                            "AIB_OFFLINE_PACKAGE_ARCHIVE_SIZE_INVALID"
                        } else {
                            "AIB_OFFLINE_PACKAGE_PICKER_COPY_FAILED"
                        }
                        promise.reject(code, code, e)
                    }
                }.start()
                return
            }
            if (requestCode == aiBuilderWorkspaceGrantRequestCode) {
                val workspacePromise = pendingAIBuilderWorkspaceGrantPromise
                pendingAIBuilderWorkspaceGrantPromise = null
                if (workspacePromise == null) return
                if (resultCode != Activity.RESULT_OK || data?.data == null) {
                    workspacePromise.reject("AIB_WORKSPACE_GRANT_CANCELLED", "AIB_WORKSPACE_GRANT_CANCELLED", null)
                    return
                }
                val treeUri = data.data!!
                val flags = data.flags
                val invalidReason = when {
                    workspaceTreeDocumentId(treeUri) != aiBuilderWorkspaceTreeDocumentId -> "AIB_WORKSPACE_ROOT_MISMATCH"
                    (flags and Intent.FLAG_GRANT_READ_URI_PERMISSION) == 0 -> "AIB_WORKSPACE_READ_GRANT_MISSING"
                    (flags and Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION) == 0 -> "AIB_WORKSPACE_PERSISTABLE_GRANT_MISSING"
                    else -> null
                }
                if (invalidReason != null) {
                    workspacePromise.reject(invalidReason, invalidReason, null)
                    return
                }
                try {
                    reactApplicationContext.contentResolver.takePersistableUriPermission(
                        treeUri,
                        Intent.FLAG_GRANT_READ_URI_PERMISSION,
                    )
                    if (findAIBuilderWorkspaceGrantUri() == null) {
                        workspacePromise.reject("AIB_WORKSPACE_GRANT_NOT_PERSISTED", "AIB_WORKSPACE_GRANT_NOT_PERSISTED", null)
                    } else {
                        workspacePromise.resolve(aiBuilderWorkspaceGrantStatus(true, null))
                    }
                } catch (e: Exception) {
                    workspacePromise.reject("AIB_WORKSPACE_GRANT_PERSIST_FAILED", "AIB_WORKSPACE_GRANT_PERSIST_FAILED", e)
                }
                return
            }
            if (requestCode != modelExportRequestCode) return
            val promise = pendingModelExportPromise
            val files = pendingModelExportFiles
            val names = pendingModelExportNames
            pendingModelExportPromise = null
            pendingModelExportFiles = null
            pendingModelExportNames = null
            if (promise == null) return
            if (resultCode != Activity.RESULT_OK || data?.data == null || files == null || names == null || files.isEmpty() || names.isEmpty()) {
                promise.resolve(false)
                return
            }
            val treeUri = data.data!!
            try {
                val flags = data.flags and (Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
                if (flags != 0) {
                    try { reactApplicationContext.contentResolver.takePersistableUriPermission(treeUri, flags) } catch (_: Exception) { }
                }
            } catch (_: Exception) { }
            Thread {
                val created = mutableListOf<Uri>()
                try {
                    val n = minOf(files.size, names.size)
                    for (i in 0 until n) {
                        val src = files[i]
                        val name = names[i]
                        if (src.isBlank() || name.isBlank()) continue
                        created += copyModelFileToTree(src, name, treeUri)
                    }
                    if (created.isEmpty()) {
                        promise.reject("MODEL_EXPORT_FAILED", "Нет файлов для экспорта", null)
                    } else {
                        promise.resolve(true)
                    }
                } catch (e: Exception) {
                    for (uri in created) {
                        try { reactApplicationContext.contentResolver.delete(uri, null, null) } catch (_: Exception) { }
                    }
                    promise.reject("MODEL_EXPORT_FAILED", e.message ?: e.toString(), e)
                }
            }.start()
        }

        override fun onNewIntent(intent: Intent) { }
    }

    init {
        try {
            reactApplicationContext.addActivityEventListener(activityEventListener)
        } catch (_: Exception) { }
        try {
            liveReceiver = TermuxLiveOutputReceiver(this)
            val filter = android.content.IntentFilter(ACTION_LIVE_OUTPUT)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                reactContext.registerReceiver(liveReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
            } else {
                @Suppress("DEPRECATION")
                reactContext.registerReceiver(liveReceiver, filter)
            }
        } catch (_: Exception) {
            liveReceiver = null
        }
    }

    override fun getName() = "TermuxBridge"

    private fun installedSignerSha256(): List<String> {
        val packageName = reactApplicationContext.packageName
        val signatures = if (Build.VERSION.SDK_INT >= 28) {
            val info = reactApplicationContext.packageManager.getPackageInfo(packageName, PackageManager.GET_SIGNING_CERTIFICATES)
            info.signingInfo?.apkContentsSigners?.toList()
        } else {
            @Suppress("DEPRECATION")
            val info = reactApplicationContext.packageManager.getPackageInfo(packageName, PackageManager.GET_SIGNATURES)
            @Suppress("DEPRECATION")
            info.signatures?.toList()
        }
        if (signatures.isNullOrEmpty()) throw IllegalStateException("AIB_SIGNER_UNAVAILABLE")
        return signatures.map { signature ->
            MessageDigest.getInstance("SHA-256").digest(signature.toByteArray()).joinToString("") {
                byte -> (byte.toInt() and 255).toString(16).padStart(2, '0')
            }
        }.sorted()
    }

    private fun runtimeHookEvidence(): Pair<List<String>, Boolean> {
        val signals = linkedSetOf<String>()
        if (Debug.isDebuggerConnected()) signals.add("debugger_attached")
        val needles = listOf("frida", "gum-js-loop", "libsubstrate", "xposed", "lsposed", "edxposed", "zygisk", "riru")
        var mapsReadable = false
        val maps = File("/proc/self/maps")
        if (maps.isFile && maps.canRead()) {
            try {
                maps.bufferedReader().use { reader ->
                    mapsReadable = true
                    var count = 0
                    while (count < 8192) {
                        val line = reader.readLine() ?: break
                        count += 1
                        val normalized = line.lowercase(java.util.Locale.ROOT)
                        if (needles.any { normalized.contains(it) }) {
                            signals.add("known_instrumentation_mapping")
                            break
                        }
                    }
                }
            } catch (_: Throwable) {
                mapsReadable = false
            }
        }
        val hookClasses = listOf("de.robv.android.xposed.XposedBridge", "org.lsposed.lspd.Yahfa")
        if (hookClasses.any { className ->
                try { Class.forName(className, false, reactApplicationContext.classLoader); true }
                catch (_: Throwable) { false }
            }) {
            signals.add("xposed_class_detected")
        }
        return Pair(signals.toList().sorted(), mapsReadable)
    }

    private fun releaseIntegrityFailureCode(): String? {
        if (BuildConfig.DEBUG) return null
        if (reactApplicationContext.packageName != EXPECTED_PACKAGE_NAME) return "AIB_APP_ID_MISMATCH"
        if ((reactApplicationContext.applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
            return "AIB_RELEASE_DEBUGGABLE"
        }
        val signers = installedSignerSha256()
        val expectedSigner = if (Build.VERSION.SDK_INT >= 28) EXPECTED_RELEASE_SIGNER_SHA256 else LEGACY_RELEASE_SIGNER_SHA256
        if (signers.size != 1 || signers.single() != expectedSigner) return "AIB_APP_SIGNATURE_MISMATCH"
        val (signals, mapsReadable) = runtimeHookEvidence()
        if (signals.isNotEmpty()) return "AIB_RUNTIME_HOOK_DETECTED"
        if (!mapsReadable) return "AIB_INTEGRITY_PROBE_INCOMPLETE"
        return null
    }

    @ReactMethod
    fun getReleaseIntegrityEvidence(promise: Promise) {
        try {
            val debugBuild = BuildConfig.DEBUG
            val hookEvidence = if (debugBuild) Pair(emptyList(), true) else runtimeHookEvidence()
            val signerDigests = if (debugBuild) emptyList() else installedSignerSha256()
            val result = Arguments.createMap()
            result.putString("applicationId", reactApplicationContext.packageName)
            result.putBoolean("debugBuild", debugBuild)
            result.putBoolean("debuggable", (reactApplicationContext.applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0)
            result.putBoolean("probeComplete", true)
            result.putBoolean("hookScanComplete", hookEvidence.second)
            val signers = Arguments.createArray()
            signerDigests.forEach { signers.pushString(it) }
            result.putArray("signerSha256", signers)
            val hookSignals = Arguments.createArray()
            hookEvidence.first.forEach { hookSignals.pushString(it) }
            result.putArray("hookSignals", hookSignals)
            promise.resolve(result)
        } catch (_: Throwable) {
            promise.reject("AIB_INTEGRITY_PROBE_FAILED", "Local integrity probe failed", null)
        }
    }

    companion object {
        const val ACTION_LIVE_OUTPUT = "${pkg}.TERMUX_LIVE_OUTPUT"
        private const val EXPECTED_RELEASE_SIGNER_SHA256 = "${OFFLINE_PACKAGE_SIGNER_CERT_SHA256}"
        private const val LEGACY_RELEASE_SIGNER_SHA256 = "b5dacc6f9c37adceace5c0d715eecb2762b5a0417468e221ec9c534ea1e6328e"
        private const val EXPECTED_RELEASE_SIGNER_CERT_DER_BASE64 = "${OFFLINE_PACKAGE_SIGNER_CERT_BASE64}"
        private const val EXPECTED_RELEASE_SIGNATURE_BYTES = 256
        private const val EXPECTED_PACKAGE_NAME = "${pkg}"
    }

    fun forwardLiveOutput(cmdId: String, stream: String, chunk: String) {
        if (chunk.isEmpty()) return
        emitOutput(cmdId, stream, chunk)
    }

    override fun invalidate() {
        try { liveReceiver?.let { reactApplicationContext.unregisterReceiver(it) } } catch (_: Exception) { }
        liveReceiver = null
        pendingModelExportPromise = null
        pendingModelExportFiles = null
        pendingModelExportNames = null
        try { reactApplicationContext.removeActivityEventListener(activityEventListener) } catch (_: Exception) { }
        super.invalidate()
    }

    // RN требует эти методы для NativeEventEmitter
    @ReactMethod
    fun addListener(eventName: String) { }

    @ReactMethod
    fun removeListeners(count: Int) { }

    private fun nativeLogTag(): String = "AIB-TermuxBridge"

    /** Android Logcat is device-wide: accept only structured, non-content fields. */
    private fun nativeLog(
        cmdId: String,
        level: String,
        phase: String,
        code: String? = null,
        timeoutMs: Long? = null,
        elapsedMs: Long? = null,
        exitCode: Int? = null,
        stdoutBytes: Long? = null,
        stderrBytes: Long? = null,
        truncated: Boolean? = null,
        clientCommandId: String? = null
    ) {
        val safeId = cmdId.takeIf { it.matches("[a-f0-9]{32}".toRegex()) } ?: "unknown"
        val safePhase = phase.takeIf {
            it in setOf("dispatch", "started", "timeout", "callback-error", "finished", "exception", "heartbeat", "emit-error")
        } ?: "event"
        val safeCode = code?.takeIf {
            it in setOf("LIFECYCLE_EMIT", "OUTPUT_EMIT", "TERMUX_CALLBACK_ERROR", "TERMUX_TIMEOUT", "TERMUX_RUN_COMMAND_FAILED")
        }
        val fields = mutableListOf("cmdId=\$safeId", "phase=\$safePhase")
        if (safeCode != null) fields.add("code=\$safeCode")
        if (timeoutMs != null && timeoutMs >= 0) fields.add("timeoutMs=\$timeoutMs")
        if (elapsedMs != null && elapsedMs >= 0) fields.add("durationMs=\$elapsedMs")
        if (exitCode != null) fields.add("exitCode=\$exitCode")
        if (stdoutBytes != null && stdoutBytes >= 0) fields.add("stdoutBytes=\$stdoutBytes")
        if (stderrBytes != null && stderrBytes >= 0) fields.add("stderrBytes=\$stderrBytes")
        if (truncated != null) fields.add("truncated=\$truncated")
        val safeClientCommandId = clientCommandId?.takeIf { it.matches("(?:js|tr)-[A-Za-z0-9_-]{1,96}".toRegex()) }
        if (safeClientCommandId != null) fields.add("jsCommandId=\$safeClientCommandId")
        val tag = nativeLogTag()
        val text = fields.joinToString(" ")
        try {
            when (level) {
                "error" -> android.util.Log.e(tag, text)
                "warn" -> android.util.Log.w(tag, text)
                "debug" -> android.util.Log.d(tag, text)
                else -> android.util.Log.i(tag, text)
            }
        } catch (_: Exception) { }
    }

    private fun emitLifecycle(cmdId: String, event: String, detail: String = "", clientCommandId: String? = null) {
        nativeLog(cmdId, if (event == "exception" || event == "timeout") "error" else "info", event, clientCommandId = clientCommandId)
        try {
            val params: WritableMap = Arguments.createMap()
            params.putString("cmdId", clientCommandId ?: cmdId)
            if (clientCommandId != null) params.putString("nativeCmdId", cmdId)
            params.putString("stream", "lifecycle")
            params.putString("event", event)
            params.putString("chunk", detail)
            reactApplicationContext
                .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit("TermuxCommandOutput", params)
        } catch (_: Exception) {
            nativeLog(cmdId, "warn", "emit-error", code = "LIFECYCLE_EMIT")
        }
    }

    private fun emitOutput(cmdId: String, stream: String, chunk: String) {
        if (chunk.isEmpty()) return
        try {
            val params: WritableMap = Arguments.createMap()
            params.putString("cmdId", cmdId)
            params.putString("stream", stream)
            params.putString("chunk", chunk)
            reactApplicationContext
                .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit("TermuxCommandOutput", params)
        } catch (_: Exception) {
            nativeLog(cmdId, "warn", "emit-error", code = "OUTPUT_EMIT")
        }
    }

    private fun emitHeartbeat(cmdId: String, elapsedSec: Long, clientCommandId: String? = null) {
        nativeLog(cmdId, "debug", "heartbeat", elapsedMs = elapsedSec * 1000L, clientCommandId = clientCommandId)
        try {
            val params: WritableMap = Arguments.createMap()
            params.putString("cmdId", clientCommandId ?: cmdId)
            if (clientCommandId != null) params.putString("nativeCmdId", cmdId)
            params.putString("stream", "heartbeat")
            params.putString("chunk", "Ожидание результата Termux: \${elapsedSec}s; live stdout не измеряется")
            params.putDouble("elapsedSec", elapsedSec.toDouble())
            reactApplicationContext
                .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit("TermuxCommandOutput", params)
        } catch (e: Exception) { }
    }


    /** Shared first-run/retry entry point, independent of rendering a TerminalView. */
    @ReactMethod
    fun prepareEmbeddedTermuxRuntime(promise: Promise) {
        AibEmbeddedTermuxBootstrapInstaller.installIfNeeded(reactApplicationContext) { outcome ->
            if (outcome.ready) promise.resolve(true)
            else {
                val safe = outcome.status.takeIf { it.matches(Regex("^[a-z0-9_]{1,80}$")) } ?: "install_failed"
                val code = "EMBEDDED_BOOTSTRAP_" + safe.uppercase(java.util.Locale.ROOT)
                promise.reject(code, code)
            }
        }
    }

    /** Verify the exact raw manifest bytes using the embedded pinned feed certificate and the app's rotated signer identity. */
    private fun verifyOfflinePackageManifestBytes(manifestBytes: ByteArray, signatureBytes: ByteArray): Boolean {
        if (reactApplicationContext.packageName != "com.karat.aibuilder" || manifestBytes.isEmpty() ||
            manifestBytes.size > 192 * 1024 || signatureBytes.size != EXPECTED_RELEASE_SIGNATURE_BYTES) return false
        val expectedAppSigner = if (Build.VERSION.SDK_INT >= 28) EXPECTED_RELEASE_SIGNER_SHA256 else LEGACY_RELEASE_SIGNER_SHA256
        val appSigners = try { installedSignerSha256() } catch (_: Throwable) { return false }
        if (appSigners.size != 1 || appSigners.single() != expectedAppSigner) return false
        val certificateBytes = try {
            android.util.Base64.decode(EXPECTED_RELEASE_SIGNER_CERT_DER_BASE64, android.util.Base64.DEFAULT)
        } catch (_: Throwable) { return false }
        val certificate = try {
            java.security.cert.CertificateFactory.getInstance("X.509")
                .generateCertificate(java.io.ByteArrayInputStream(certificateBytes)) as java.security.cert.X509Certificate
        } catch (_: Throwable) { return false }
        val digest = MessageDigest.getInstance("SHA-256").digest(certificate.encoded)
            .joinToString("") { byte -> "%02x".format(java.util.Locale.ROOT, byte.toInt() and 0xff) }
        if (digest != EXPECTED_RELEASE_SIGNER_SHA256) return false
        val verifier = java.security.Signature.getInstance("SHA256withRSA")
        verifier.initVerify(certificate.publicKey)
        verifier.update(manifestBytes)
        return verifier.verify(signatureBytes)
    }

    /** Existing JS wrapper: convert byte arrays, then authenticate before any caller parses JSON. */
    @ReactMethod
    fun verifyOfflinePackageManifest(rawManifest: com.facebook.react.bridge.ReadableArray, detachedSignature: com.facebook.react.bridge.ReadableArray, promise: Promise) {
        try {
            if (rawManifest.size() < 1 || rawManifest.size() > 192 * 1024 || detachedSignature.size() != EXPECTED_RELEASE_SIGNATURE_BYTES) {
                promise.resolve(false); return
            }
            val manifestBytes = ByteArray(rawManifest.size()) { index ->
                if (rawManifest.getType(index) != com.facebook.react.bridge.ReadableType.Number) throw IllegalArgumentException("manifest_bytes_invalid")
                val value = rawManifest.getDouble(index)
                if (!value.isFinite() || value < 0.0 || value > 255.0 || value != value.toInt().toDouble()) throw IllegalArgumentException("manifest_bytes_invalid")
                value.toInt().toByte()
            }
            val signatureBytes = ByteArray(detachedSignature.size()) { index ->
                if (detachedSignature.getType(index) != com.facebook.react.bridge.ReadableType.Number) throw IllegalArgumentException("signature_bytes_invalid")
                val value = detachedSignature.getDouble(index)
                if (!value.isFinite() || value < 0.0 || value > 255.0 || value != value.toInt().toDouble()) throw IllegalArgumentException("signature_bytes_invalid")
                value.toInt().toByte()
            }
            promise.resolve(verifyOfflinePackageManifestBytes(manifestBytes, signatureBytes))
        } catch (_: Throwable) {
            promise.resolve(false)
        }
    }

    private val onlineCatalogAcceptLock = Any()

    private fun onlineCatalogCheck(manifestBytes: ByteArray, signatureBytes: ByteArray, replayMode: String): Boolean {
        if (!verifyOfflinePackageManifestBytes(manifestBytes, signatureBytes)) return false
        return try {
            val text = String(manifestBytes, Charsets.UTF_8)
            if (!text.toByteArray(Charsets.UTF_8).contentEquals(manifestBytes)) return false
            offlineRejectDuplicateJsonKeys(manifestBytes)
            val doc = org.json.JSONObject(text)
            val keys = setOf("format", "schemaVersion", "appId", "architecture", "catalogState", "catalogCommit", "catalogSha256", "dependencyClosureComplete", "signatureAlgorithm", "signerCertificateSha256", "feedRoot", "sequence", "issuedAtMs", "expiresAtMs", "files", "packages")
            if (!offlineExactKeys(doc, keys) || doc.optString("format") != "aibuilder-online-package-catalog" || doc.optInt("schemaVersion", -1) != 3 ||
                doc.optString("appId") != "com.karat.aibuilder" || doc.optString("architecture") != "aarch64" ||
                doc.optString("catalogState") != "production-qualified" || doc.opt("dependencyClosureComplete") != true ||
                doc.optString("signatureAlgorithm") != "SHA256withRSA" || doc.optString("signerCertificateSha256") != EXPECTED_RELEASE_SIGNER_SHA256 ||
                doc.optString("feedRoot") != "feed" || !doc.optString("catalogCommit").matches(Regex("^[a-fA-F0-9]{40}$")) ||
                !doc.optString("catalogSha256").matches(Regex("^[a-fA-F0-9]{64}$")) || doc.optJSONArray("files").let { it == null || it.length() !in 1..256 } ||
                doc.optJSONArray("packages").let { it == null || it.length() !in 1..256 }) return false
            fun exactLong(key: String): Long? {
                val value = doc.opt(key)
                return if (value is Int || value is Long) (value as Number).toLong() else null
            }
            val sequence = exactLong("sequence") ?: return false
            val issuedAt = exactLong("issuedAtMs") ?: return false
            val expiresAt = exactLong("expiresAtMs") ?: return false
            val now = System.currentTimeMillis()
            val maxAge = 7L * 24L * 60L * 60L * 1000L
            val skew = 5L * 60L * 1000L
            if (sequence < 1L || issuedAt > now + skew || issuedAt < now - maxAge || expiresAt <= now ||
                expiresAt <= issuedAt || expiresAt - issuedAt > maxAge) return false
            val digest = offlineHex(MessageDigest.getInstance("SHA-256").digest(manifestBytes))
            synchronized(onlineCatalogAcceptLock) {
                val prefs = reactApplicationContext.getSharedPreferences("aib_online_catalog_guard_v1", Context.MODE_PRIVATE)
                val previousSequence = prefs.getLong("sequence", 0L)
                val previousDigest = prefs.getString("manifestSha256", "").orEmpty()
                val previousClock = prefs.getLong("lastWallClockMs", 0L)
                if (previousClock > 0L && now + skew < previousClock) return false
                if (previousSequence < 0L || previousSequence == 0L && previousDigest.isNotEmpty() ||
                    previousSequence > 0L && !previousDigest.matches(Regex("^[a-fA-F0-9]{64}$"))) return false
                when (replayMode) {
                    "new" -> if (sequence <= previousSequence) return false
                    "accept" -> if (sequence <= previousSequence) return false
                    "current" -> if (sequence != previousSequence || previousDigest != digest) return false
                    else -> return false
                }
                if (replayMode == "accept") {
                    val persisted = prefs.edit().putLong("sequence", sequence).putString("manifestSha256", digest)
                        .putLong("lastWallClockMs", maxOf(previousClock, now)).commit()
                    if (!persisted) return false
                }
            }
            true
        } catch (_: Throwable) { false }
    }

    /** Online feed path is separate from the ordinary package-manager shell gate. */
    @ReactMethod
    fun verifyOnlinePackageCatalog(rawManifest: com.facebook.react.bridge.ReadableArray, detachedSignature: com.facebook.react.bridge.ReadableArray, promise: Promise) {
        try {
            if (rawManifest.size() < 1 || rawManifest.size() > 192 * 1024 || detachedSignature.size() != EXPECTED_RELEASE_SIGNATURE_BYTES) { promise.resolve(false); return }
            val manifestBytes = ByteArray(rawManifest.size()) { index ->
                if (rawManifest.getType(index) != com.facebook.react.bridge.ReadableType.Number) throw IllegalArgumentException("manifest_bytes_invalid")
                val value = rawManifest.getDouble(index); if (!value.isFinite() || value < 0.0 || value > 255.0 || value != value.toInt().toDouble()) throw IllegalArgumentException("manifest_bytes_invalid"); value.toInt().toByte()
            }
            val signatureBytes = ByteArray(detachedSignature.size()) { index ->
                if (detachedSignature.getType(index) != com.facebook.react.bridge.ReadableType.Number) throw IllegalArgumentException("signature_bytes_invalid")
                val value = detachedSignature.getDouble(index); if (!value.isFinite() || value < 0.0 || value > 255.0 || value != value.toInt().toDouble()) throw IllegalArgumentException("signature_bytes_invalid"); value.toInt().toByte()
            }
            promise.resolve(onlineCatalogCheck(manifestBytes, signatureBytes, "new"))
        } catch (_: Throwable) { promise.resolve(false) }
    }

    private fun emitOfflineBundleProgress(requestId: String, phase: String, percent: Int) {
        try {
            val event = Arguments.createMap()
            event.putString("requestId", requestId)
            event.putString("phase", phase)
            event.putInt("percent", percent.coerceIn(0, 100))
            reactApplicationContext.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit("offlineBundleProgress", event)
        } catch (_: Throwable) { }
    }

    private data class OfflinePkg(val name: String, val version: String, val architecture: String, val filename: String, val sizeBytes: Long, val sha256: String, val depends: List<String>)
    private data class OfflineStage(val stageId: String, val requestId: String, val root: File, val manifestBytes: ByteArray, val signatureBytes: ByteArray, val packages: List<OfflinePkg>, val onlineCatalog: Boolean, @Volatile var expiryMs: Long, @Volatile var ready: Boolean)
    private data class OfflinePlannedPkg(val name: String, val version: String, val architecture: String, val sizeBytes: Long)
    private data class OfflineAptPlan(val planId: String, val stageId: String, val requestId: String, val roots: List<String>, val packages: List<OfflinePlannedPkg>, val statusSha256: String, val expiryMs: Long)
    private val offlineStages = ConcurrentHashMap<String, OfflineStage>()
    private val offlinePlans = ConcurrentHashMap<String, OfflineAptPlan>()
    private val offlineStageLock = Any()
    private val offlineStageLifetimeMs = 30L * 60L * 1000L
    private val offlinePlanLifetimeMs = 5L * 60L * 1000L
    private val offlineStageExpiry = java.util.concurrent.Executors.newSingleThreadScheduledExecutor { runnable -> Thread(runnable, "AIB-OfflineStageExpiry").apply { isDaemon = true } }
    private fun offlineScheduleStageExpiry(stage: OfflineStage) {
        val delay = (stage.expiryMs - System.currentTimeMillis()).coerceAtLeast(0L)
        offlineStageExpiry.schedule({
            if (offlineStages[stage.stageId] === stage && stage.expiryMs <= System.currentTimeMillis() && offlineStages.remove(stage.stageId, stage)) offlineDeleteStage(stage.stageId)
        }, delay, java.util.concurrent.TimeUnit.MILLISECONDS)
    }
    private fun offlineResult(status: String, code: String): WritableMap = Arguments.createMap().also { it.putString("status", status); it.putString("code", code) }
    private fun offlineHex(bytes: ByteArray): String = bytes.joinToString("") { "%02x".format(java.util.Locale.ROOT, it.toInt() and 255) }
    private fun offlineExactKeys(obj: org.json.JSONObject, keys: Set<String>): Boolean {
        val actual = obj.keys().asSequence().toSet()
        return actual == keys
    }
    private fun offlineRejectDuplicateJsonKeys(bytes: ByteArray) {
        val reader = android.util.JsonReader(java.io.InputStreamReader(java.io.ByteArrayInputStream(bytes), Charsets.UTF_8))
        reader.isLenient = false
        var tokens = 0
        fun value(depth: Int) {
            if (depth > 32 || ++tokens > 20000) throw IllegalArgumentException("offline_manifest_invalid")
            when (reader.peek()) {
                android.util.JsonToken.BEGIN_OBJECT -> {
                    reader.beginObject(); val keys = HashSet<String>()
                    while (reader.hasNext()) { val key = reader.nextName(); if (!keys.add(key)) throw IllegalArgumentException("offline_manifest_duplicate_key"); value(depth + 1) }
                    reader.endObject()
                }
                android.util.JsonToken.BEGIN_ARRAY -> { reader.beginArray(); while (reader.hasNext()) value(depth + 1); reader.endArray() }
                android.util.JsonToken.STRING -> reader.nextString()
                android.util.JsonToken.NUMBER -> reader.nextString()
                android.util.JsonToken.BOOLEAN -> reader.nextBoolean()
                android.util.JsonToken.NULL -> reader.nextNull()
                else -> throw IllegalArgumentException("offline_manifest_invalid")
            }
        }
        value(0)
        if (reader.peek() != android.util.JsonToken.END_DOCUMENT) throw IllegalArgumentException("offline_manifest_invalid")
        reader.close()
    }
    private fun offlineRequiredString(obj: org.json.JSONObject, key: String, regex: Regex): String {
        val value = obj.opt(key)
        if (value !is String || !regex.matches(value)) throw IllegalArgumentException("offline_manifest_invalid")
        return value
    }
    private fun offlineReadBounded(file: File, max: Int): ByteArray {
        val st = Os.lstat(file.absolutePath)
        if ((st.st_mode and OsConstants.S_IFMT) != OsConstants.S_IFREG || st.st_size < 1 || st.st_size > max) throw IllegalArgumentException("offline_file_invalid")
        return FileInputStream(file).use { input ->
            val out = java.io.ByteArrayOutputStream()
            val buf = ByteArray(8192)
            while (true) { val n = input.read(buf); if (n < 0) break; if (out.size() + n > max) throw IllegalArgumentException("offline_file_oversize"); out.write(buf, 0, n) }
            out.toByteArray()
        }
    }
    private fun offlineHash(file: File, expectedSize: Long): String {
        val st = Os.lstat(file.absolutePath)
        if ((st.st_mode and OsConstants.S_IFMT) != OsConstants.S_IFREG || st.st_size != expectedSize || expectedSize > 100L * 1024L * 1024L) throw IllegalArgumentException("offline_file_invalid")
        val digest = MessageDigest.getInstance("SHA-256")
        FileInputStream(file).use { input -> val buf = ByteArray(32768); var total = 0L; while (true) { val n = input.read(buf); if (n < 0) break; total += n; if (total > expectedSize) throw IllegalArgumentException("offline_file_invalid"); digest.update(buf, 0, n) }; if (total != expectedSize) throw IllegalArgumentException("offline_file_invalid") }
        return offlineHex(digest.digest())
    }
    private fun offlineValidateStage(root: File, stageId: String, requestId: String, acceptOnlineCatalogSequence: Boolean = false): OfflineStage {
        val ctx = reactApplicationContext
        if (!stageId.matches(Regex("^[A-Za-z0-9_-]{16,128}$")) || !requestId.matches(Regex("^[A-Za-z0-9._-]{1,96}$"))) throw IllegalArgumentException("offline_argument_invalid")
        val expected = File(ctx.cacheDir.canonicalFile, "offline-bundle-" + stageId)
        if (root.canonicalPath != expected.canonicalPath || root.absolutePath != expected.absolutePath || expected.parentFile?.canonicalPath != ctx.cacheDir.canonicalPath) throw IllegalArgumentException("offline_stage_path_invalid")
        fun requireDir(file: File) { val st = Os.lstat(file.absolutePath); if ((st.st_mode and OsConstants.S_IFMT) != OsConstants.S_IFDIR || file.canonicalPath != file.absolutePath) throw IllegalArgumentException("offline_tree_invalid") }
        requireDir(expected)
        val rootChildren = expected.listFiles()?.map { it.name }?.toSet() ?: throw IllegalArgumentException("offline_tree_invalid")
        if (rootChildren != setOf("manifest.json", "manifest.sig", "feed")) throw IllegalArgumentException("offline_tree_inventory_mismatch")
        val manifestFile = File(expected, "manifest.json")
        val signatureFile = File(expected, "manifest.sig")
        val manifestBytes = offlineReadBounded(manifestFile, 192 * 1024)
        val signatureBytes = offlineReadBounded(signatureFile, EXPECTED_RELEASE_SIGNATURE_BYTES)
        // Authenticate exact raw bytes before parsing any JSON fields.
        if (signatureBytes.size != EXPECTED_RELEASE_SIGNATURE_BYTES || !verifyOfflinePackageManifestBytes(manifestBytes, signatureBytes)) throw IllegalArgumentException("offline_signature_invalid")
        val text = String(manifestBytes, Charsets.UTF_8)
        if (!text.toByteArray(Charsets.UTF_8).contentEquals(manifestBytes)) throw IllegalArgumentException("offline_manifest_invalid")
        offlineRejectDuplicateJsonKeys(manifestBytes)
        val doc = org.json.JSONObject(text)
        val schemaRaw = doc.opt("schemaVersion")
        val schemaVersion = if (schemaRaw is Int || schemaRaw is Long) (schemaRaw as Number).toInt() else -1
        val onlineCatalog = doc.optString("format") == "aibuilder-online-package-catalog" && schemaVersion == 3
        val offlineBundle = doc.optString("format") == "aibuilder-offline-package-bundle" && schemaVersion == 2
        val topKeys = if (onlineCatalog) setOf("format", "schemaVersion", "appId", "architecture", "catalogState", "catalogCommit", "catalogSha256", "dependencyClosureComplete", "signatureAlgorithm", "signerCertificateSha256", "feedRoot", "sequence", "issuedAtMs", "expiresAtMs", "files", "packages") else setOf("format", "schemaVersion", "appId", "architecture", "catalogState", "catalogCommit", "catalogSha256", "dependencyClosureComplete", "signatureAlgorithm", "signerCertificateSha256", "feedRoot", "files", "packages")
        if (!offlineExactKeys(doc, topKeys) || !onlineCatalog && !offlineBundle || listOf("format", "appId", "architecture", "catalogState", "catalogCommit", "catalogSha256", "signatureAlgorithm", "signerCertificateSha256", "feedRoot").any { doc.opt(it) !is String } || doc.opt("dependencyClosureComplete") != true || doc.optString("appId") != "com.karat.aibuilder" || doc.optString("architecture") != "aarch64" || doc.optString("catalogState") != "production-qualified" || doc.optString("signatureAlgorithm") != "SHA256withRSA" || doc.optString("signerCertificateSha256") != "${OFFLINE_PACKAGE_SIGNER_CERT_SHA256}" || doc.optString("feedRoot") != "feed" || !doc.optString("catalogCommit").matches(Regex("^[a-fA-F0-9]{40}$")) || !doc.optString("catalogSha256").matches(Regex("^[a-fA-F0-9]{64}$"))) throw IllegalArgumentException("offline_manifest_invalid")
        val files = doc.optJSONArray("files") ?: throw IllegalArgumentException("offline_manifest_invalid")
        val packagesJson = doc.optJSONArray("packages") ?: throw IllegalArgumentException("offline_manifest_invalid")
        if (files.length() < 1 || files.length() > 256 || packagesJson.length() !in 1..256) throw IllegalArgumentException("offline_manifest_invalid")
        val fileRows = LinkedHashMap<String, Pair<Long, String>>()
        var totalBytes = 0L
        for (i in 0 until files.length()) {
            val row = files.optJSONObject(i) ?: throw IllegalArgumentException("offline_manifest_invalid")
            if (!offlineExactKeys(row, setOf("path", "sizeBytes", "sha256"))) throw IllegalArgumentException("offline_manifest_invalid")
            val path = offlineRequiredString(row, "path", Regex("^feed/[A-Za-z0-9._+@:/-]{1,500}$"))
            if (path.contains("//") || path.split('/').any { it == "." || it == ".." } || fileRows.containsKey(path)) throw IllegalArgumentException("offline_manifest_invalid")
            val rawSize = row.opt("sizeBytes"); if (rawSize !is Int && rawSize !is Long) throw IllegalArgumentException("offline_manifest_invalid")
            val size = (rawSize as Number).toLong(); val hash = row.optString("sha256")
            if (size !in 1L..(100L * 1024L * 1024L) || !hash.matches(Regex("^[a-fA-F0-9]{64}$"))) throw IllegalArgumentException("offline_manifest_invalid")
            totalBytes += size; if (totalBytes > 200L * 1024L * 1024L) throw IllegalArgumentException("offline_manifest_limit")
            fileRows[path] = Pair(size, hash.lowercase(java.util.Locale.ROOT))
        }
        val pkgKeys = setOf("name", "version", "architecture", "filename", "sizeBytes", "sha256", "depends")
        val packages = ArrayList<OfflinePkg>()
        val seenNames = HashSet<String>(); val seenFiles = HashSet<String>(); var packageBytes = 0L
        val maxPackageBytes = if (onlineCatalog) 190L * 1024L * 1024L else 150L * 1024L * 1024L
        for (i in 0 until packagesJson.length()) {
            val row = packagesJson.optJSONObject(i) ?: throw IllegalArgumentException("offline_manifest_invalid")
            if (!offlineExactKeys(row, pkgKeys)) throw IllegalArgumentException("offline_manifest_invalid")
            val name = offlineRequiredString(row, "name", Regex("^[a-z0-9][a-z0-9.+-]{0,127}$"))
            val version = offlineRequiredString(row, "version", Regex("^[A-Za-z0-9.+:~_-]{1,128}$"))
            val arch = row.optString("architecture"); if (arch != "aarch64" && arch != "all") throw IllegalArgumentException("offline_manifest_invalid")
            val filename = offlineRequiredString(row, "filename", Regex("^feed/[A-Za-z0-9._+@:/-]{1,500}\\\\.deb$"))
            val rawSize = row.opt("sizeBytes"); if (rawSize !is Int && rawSize !is Long) throw IllegalArgumentException("offline_manifest_invalid")
            val size = (rawSize as Number).toLong(); val hash = row.optString("sha256")
            if (size !in 1L..(100L * 1024L * 1024L) || !hash.matches(Regex("^[a-fA-F0-9]{64}$")) || !seenNames.add(name + "@" + version) || !seenFiles.add(filename)) throw IllegalArgumentException("offline_manifest_invalid")
            val inventory = fileRows[filename] ?: throw IllegalArgumentException("offline_manifest_invalid")
            if (inventory.first != size || inventory.second != hash.lowercase(java.util.Locale.ROOT)) throw IllegalArgumentException("offline_manifest_invalid")
            val depsJson = row.optJSONArray("depends") ?: throw IllegalArgumentException("offline_manifest_invalid")
            if (depsJson.length() > 64) throw IllegalArgumentException("offline_manifest_invalid")
            val deps = ArrayList<String>(); for (j in 0 until depsJson.length()) { val dep = depsJson.opt(j); if (dep !is String || dep.isEmpty() || dep.length > 512 || dep.any { it == '\\r' || it == '\\n' || it == '\\u0000' }) throw IllegalArgumentException("offline_manifest_invalid"); deps.add(dep) }
            packageBytes += size; if (packageBytes > maxPackageBytes) throw IllegalArgumentException("offline_manifest_limit")
            packages.add(OfflinePkg(name, version, arch, filename, size, hash.lowercase(java.util.Locale.ROOT), deps))
        }
        val indexPath = "feed/dists/stable/main/binary-aarch64/Packages"
        val indexRecord = fileRows[indexPath] ?: throw IllegalArgumentException("offline_index_missing")
        if (indexRecord.second != doc.optString("catalogSha256").lowercase(java.util.Locale.ROOT)) throw IllegalArgumentException("offline_index_hash_invalid")
        val feed = File(expected, "feed")
        requireDir(feed)
        val actual = LinkedHashSet<String>(); val actualDirs = LinkedHashSet<String>(); actualDirs.add("feed"); var count = 0
        fun walk(dir: File, rel: String) {
            val children = dir.listFiles() ?: throw IllegalArgumentException("offline_tree_invalid")
            for (child in children) {
                val st = Os.lstat(child.absolutePath); val kind = st.st_mode and OsConstants.S_IFMT
                if (kind == OsConstants.S_IFLNK || (kind != OsConstants.S_IFDIR && kind != OsConstants.S_IFREG)) throw IllegalArgumentException("offline_tree_invalid")
                if (child.canonicalPath != child.absolutePath) throw IllegalArgumentException("offline_tree_invalid")
                val path = if (rel.isEmpty()) child.name else rel + "/" + child.name
                if (kind == OsConstants.S_IFDIR) { actualDirs.add("feed/" + path); walk(child, path) } else { count++; if (count > 256 || !actual.add("feed/" + path)) throw IllegalArgumentException("offline_tree_invalid") }
            }
        }
        walk(feed, "")
        val expectedDirs = LinkedHashSet<String>()
        for (path in fileRows.keys) { val parts = path.split('/'); var dirPath = ""; for (part in parts.dropLast(1)) { dirPath = if (dirPath.isEmpty()) part else dirPath + "/" + part; expectedDirs.add(dirPath) } }
        if (actual != fileRows.keys || actualDirs != expectedDirs) throw IllegalArgumentException("offline_tree_inventory_mismatch")
        for ((path, pair) in fileRows) {
            var cursor = expected
            for (part in path.split('/')) { cursor = File(cursor, part); val st = Os.lstat(cursor.absolutePath); val mode = st.st_mode and OsConstants.S_IFMT; if (mode == OsConstants.S_IFLNK || (cursor != File(expected, path) && mode != OsConstants.S_IFDIR) || cursor == File(expected, path) && mode != OsConstants.S_IFREG) throw IllegalArgumentException("offline_tree_invalid") }
            if (offlineHash(File(expected, path), pair.first) != pair.second) throw IllegalArgumentException("offline_hash_mismatch")
        }
        val index = String(File(expected, indexPath).readBytes(), Charsets.UTF_8)
        val records = LinkedHashMap<String, Map<String, String>>()
        var fields = LinkedHashMap<String, String>(); var current = ""
        fun finishRecord() { if (fields.isNotEmpty()) { val name = fields["Package"] ?: throw IllegalArgumentException("offline_index_invalid"); val version = fields["Version"] ?: throw IllegalArgumentException("offline_index_invalid"); if (records.put(name + "@" + version, fields.toMap()) != null) throw IllegalArgumentException("offline_index_invalid"); fields = LinkedHashMap() } }
        for (line in index.split('\\n')) {
            if (line.isEmpty()) { finishRecord(); current = ""; continue }
            if ((line[0] == ' ' || line[0] == '\\t') && current.isNotEmpty()) fields[current] = (fields[current] ?: "") + "\\n" + line.drop(1)
            else { val colon = line.indexOf(':'); if (colon <= 0) throw IllegalArgumentException("offline_index_invalid"); current = line.substring(0, colon); if (fields.containsKey(current)) throw IllegalArgumentException("offline_index_invalid"); fields[current] = line.substring(colon + 1).trimStart() }
        }
        finishRecord()
        for (pkg in packages) {
            val row = records[pkg.name + "@" + pkg.version] ?: throw IllegalArgumentException("offline_index_mismatch")
            if (row["Package"] != pkg.name || row["Version"] != pkg.version || row["Architecture"] != pkg.architecture || row["Filename"] != pkg.filename.removePrefix("feed/") || row["Size"] != pkg.sizeBytes.toString() || row["SHA256"]?.lowercase(java.util.Locale.ROOT) != pkg.sha256) throw IllegalArgumentException("offline_index_mismatch")
            val indexDeps = listOf("Depends", "Pre-Depends").mapNotNull { key ->
                val value = row[key] ?: return@mapNotNull null
                val normalized = value.replace('\\n', ' ').replace('\\r', ' ').replace('\\t', ' ').split(' ').filter { it.isNotEmpty() }.joinToString(" ")
                if (normalized.isEmpty()) null else "$key: $normalized"
            }
            if (indexDeps != pkg.depends) throw IllegalArgumentException("offline_index_mismatch")
        }
        if (records.size != packages.size) throw IllegalArgumentException("offline_index_mismatch")
        if (onlineCatalog) {
            val replayMode = if (acceptOnlineCatalogSequence) "accept" else "current"
            if (!onlineCatalogCheck(manifestBytes, signatureBytes, replayMode)) throw IllegalArgumentException("online_catalog_not_fresh_or_replay")
        }
        return OfflineStage(stageId, requestId, expected, manifestBytes, signatureBytes, packages, onlineCatalog, System.currentTimeMillis() + offlineStageLifetimeMs, false)
    }
    private fun offlineAptConfig(stage: OfflineStage, prefix: File): Pair<File, String> {
        val base = File(reactApplicationContext.cacheDir, "offline-apt-" + stage.stageId)
        if (!base.exists() && !base.mkdirs()) throw IllegalStateException("offline_apt_setup_failed")
        if (base.canonicalPath != base.absolutePath) throw IllegalStateException("offline_apt_setup_failed")
        val source = File(base, "sources.list")
        val feed = File(stage.root, "feed").canonicalPath
        if (!feed.startsWith(stage.root.canonicalPath + File.separator)) throw IllegalStateException("offline_stage_path_invalid")
        source.writeText("deb [trusted=yes] file://" + feed + " stable main\\n", Charsets.UTF_8)
        val lists = File(base, "lists"); val archives = File(base, "archives")
        listOf(lists, archives, File(lists, "partial"), File(archives, "partial")).forEach { if (!it.exists() && !it.mkdirs()) throw IllegalStateException("offline_apt_setup_failed") }
        val q: (String) -> String = { "'" + it.replace("'", "'\\''") + "'" }
        val statusFile = File(prefix, "var/lib/dpkg/status")
        val status = statusFile.canonicalPath
        val prefixPath = prefix.canonicalPath
        val statusMode = Os.lstat(status).st_mode and OsConstants.S_IFMT
        if (!statusFile.isFile || !status.startsWith(prefixPath + File.separator) || statusMode != OsConstants.S_IFREG) throw IllegalStateException("offline_runtime_status_missing")
        val opts = listOf("Dir::Etc::main=/dev/null", "Dir::Etc::parts=-", "Dir::Etc::sourcelist=" + source.canonicalPath, "Dir::Etc::sourceparts=-", "Dir::Etc::trusted=/dev/null", "Dir::Etc::trustedparts=-", "Dir::State::status=" + status, "Dir::State::lists=" + lists.canonicalPath, "Dir::Cache=" + base.canonicalPath, "Dir::Cache::archives=" + archives.canonicalPath, "Acquire::http::Proxy=http://127.0.0.1:9", "Acquire::https::Proxy=http://127.0.0.1:9", "Acquire::ftp::Proxy=http://127.0.0.1:9", "Acquire::Retries=0", "Acquire::Languages=none")
        val args = opts.joinToString(" ") { "-o " + q(it) }
        return Pair(source, args)
    }
    private fun offlineAptCommand(stage: OfflineStage, prefix: File, simulateOnly: Boolean, selectedNames: List<String>? = null): String {
        val (source, options) = offlineAptConfig(stage, prefix)
        val q: (String) -> String = { "'" + it.replace("'", "'\\''") + "'" }
        val apt = q(File(prefix, "bin/apt-get").canonicalPath)
        val uniquePackages = stage.packages.distinctBy { it.name }
        val selected = selectedNames ?: uniquePackages.map { it.name }
        if (selected.isEmpty() || selected.size > 256 || selected.distinct().size != selected.size || selected.any { name -> !name.matches(Regex("^[a-z0-9][a-z0-9.+-]{0,127}$")) || uniquePackages.none { it.name == name } }) throw IllegalArgumentException("offline_selection_invalid")
        val selectedPackages = selected.map { name -> uniquePackages.first { it.name == name } }
        val names = selected.joinToString(" ") { q(it) }
        val update = apt + " " + options + " update"
        val simulate = apt + " " + options + " --simulate --no-download --no-install-recommends --no-remove install " + names
        if (simulateOnly) return update + " && " + simulate + " && printf '%s\\n' AIB_OFFLINE_APT_SIMULATION_OK"
        val dpkgQuery = q(File(prefix, "bin/dpkg-query").canonicalPath)
        val statusVersionFormat = "'" + '$' + "{Status} " + '$' + "{Version}'"
        val checks = selectedPackages.joinToString(" && ") { pkg -> dpkgQuery + " -W -f=" + statusVersionFormat + " " + q(pkg.name) + " | grep -F -x " + stage.packages.filter { it.name == pkg.name }.map { "-e " + q("install ok installed " + it.version) }.distinct().joinToString(" ") + " >/dev/null" }
        val install = apt + " " + options + " --assume-yes --no-download --no-install-recommends --no-remove install " + names
        return update + " && " + simulate + " && " + install + " && " + checks + " && printf '%s\\n' AIB_OFFLINE_INSTALL_VERIFIED"
    }
    private fun offlineStatusSha256(prefix: File): String {
        val status = File(prefix, "var/lib/dpkg/status")
        val stat = Os.lstat(status.absolutePath)
        if ((stat.st_mode and OsConstants.S_IFMT) != OsConstants.S_IFREG || stat.st_size !in 1L..(8L * 1024L * 1024L) || status.canonicalPath != status.absolutePath) throw IllegalArgumentException("offline_runtime_status_invalid")
        val digest = MessageDigest.getInstance("SHA-256")
        FileInputStream(status).use { input -> val buffer = ByteArray(32768); var total = 0L; while (true) { val count = input.read(buffer); if (count < 0) break; total += count; if (total > stat.st_size) throw IllegalArgumentException("offline_runtime_status_changed"); digest.update(buffer, 0, count) }; if (total != stat.st_size) throw IllegalArgumentException("offline_runtime_status_changed") }
        return offlineHex(digest.digest())
    }
    private fun offlineAptExactPlanCommand(stage: OfflineStage, prefix: File, packages: List<OfflinePlannedPkg>): String {
        if (packages.isEmpty() || packages.size > 256 || packages.map { it.name }.distinct().size != packages.size) throw IllegalArgumentException("offline_plan_invalid")
        val (_, options) = offlineAptConfig(stage, prefix)
        val q: (String) -> String = { "'" + it.replace("'", "'\\''") + "'" }
        val apt = q(File(prefix, "bin/apt-get").canonicalPath)
        val dpkgQuery = q(File(prefix, "bin/dpkg-query").canonicalPath)
        val targets = packages.joinToString(" ") { pkg ->
            if (!pkg.name.matches(Regex("^[a-z0-9][a-z0-9.+-]{0,127}$")) || !pkg.version.matches(Regex("^[A-Za-z0-9.+:~_-]{1,128}$")) || stage.packages.none { it.name == pkg.name && it.version == pkg.version && it.architecture == pkg.architecture }) throw IllegalArgumentException("offline_plan_package_invalid")
            q(pkg.name + "=" + pkg.version)
        }
        val update = apt + " " + options + " update"
        val simulate = apt + " " + options + " --simulate --no-download --no-install-recommends --no-remove install " + targets
        val planDir = File(reactApplicationContext.cacheDir, "offline-apt-" + stage.stageId)
        if (planDir.canonicalPath != planDir.absolutePath || planDir.parentFile?.canonicalPath != reactApplicationContext.cacheDir.canonicalPath) throw IllegalArgumentException("offline_plan_path_invalid")
        val nonce = UUID.randomUUID().toString().replace("-", "")
        val simulationOutput = q(File(planDir, "plan-sim-" + nonce + ".txt").absolutePath)
        val actualPlan = q(File(planDir, "plan-actual-" + nonce + ".txt").absolutePath)
        val expectedPlan = q(File(planDir, "plan-expected-" + nonce + ".txt").absolutePath)
        val awkScript = "/^Remv / || /^Purg / { bad=1 }\\n" +
            "/^Inst / { tail=\$0; sub(/^Inst /, \"\", tail); name=tail; sub(/ .*/, \"\", name); open=index(\$0, \"(\"); if (open < 1) { bad=1; next }; version=substr(\$0, open+1); sub(/[[:space:]].*$/, \"\", version); sub(/\\)$/, \"\", version); if (name == \"\" || version == \"\") { bad=1; next }; print name \"@\" version; count++ }\\n" +
            "END { if (bad || count < 1) exit 1 }"
        val extractActual = "awk " + q(awkScript) + " " + simulationOutput + " > " + actualPlan + " && LC_ALL=C sort -o " + actualPlan + " " + actualPlan
        val expectedRows = packages.map { it.name + "@" + it.version }.sorted()
        val expectedArgs = expectedRows.joinToString(" ") { q(it) }
        val writeExpected = "printf '%s\\n' " + expectedArgs + " > " + expectedPlan + " && LC_ALL=C sort -o " + expectedPlan + " " + expectedPlan
        val comparePlan = extractActual + " && " + writeExpected + " && cmp -s " + actualPlan + " " + expectedPlan
        val install = apt + " " + options + " --assume-yes --no-download --no-install-recommends --no-remove install " + targets
        val statusVersionFormat = "'" + '$' + "{Status} " + '$' + "{Version}'"
        val checks = packages.joinToString(" && ") { pkg -> dpkgQuery + " -W -f=" + statusVersionFormat + " " + q(pkg.name) + " | grep -F -x " + q("install ok installed " + pkg.version) + " >/dev/null" }
        return update + " && " + simulate + " > " + simulationOutput + " 2>&1 && " + comparePlan + " && " + install + " && " + checks + " && printf '%s\\n' AIB_OFFLINE_INSTALL_VERIFIED"
    }
    private fun offlineProxyPromise(real: Promise, onValue: (Any?) -> Unit): Promise = java.lang.reflect.Proxy.newProxyInstance(Promise::class.java.classLoader, arrayOf(Promise::class.java)) { _, method, args ->
        if (method.name == "resolve") { val value = args?.getOrNull(0); onValue(value); real.resolve(value); null }
        else { if (method.name.startsWith("reject")) onValue(null); val a = args ?: emptyArray(); try { method.invoke(real, *a) } catch (e: java.lang.reflect.InvocationTargetException) { throw e.targetException } }
    } as Promise
    private fun offlineResultHasMarker(value: Any?, marker: String): Boolean {
        if (value !is com.facebook.react.bridge.ReadableMap) return false
        val stdout = if (value.hasKey("stdout")) value.getString("stdout") ?: "" else ""
        return value.hasKey("exitCode") && value.getInt("exitCode") == 0 && value.hasKey("timedOut") && !value.getBoolean("timedOut") && value.hasKey("outputTruncated") && !value.getBoolean("outputTruncated") && Regex("(?m)^" + Regex.escape(marker) + "\\r?$", RegexOption.MULTILINE).containsMatchIn(stdout)
    }
    private fun offlineParseAptPlan(value: Any?, stage: OfflineStage, roots: List<String>): List<OfflinePlannedPkg>? {
        if (!offlineResultHasMarker(value, "AIB_OFFLINE_APT_SIMULATION_OK") || value !is com.facebook.react.bridge.ReadableMap) return null
        val stdout = value.getString("stdout") ?: return null
        val lines = stdout.lineSequence().toList()
        if (lines.any { it.startsWith("Remv ") || it.startsWith("Purg ") }) return null
        val installLines = lines.filter { it.startsWith("Inst ") }
        if (installLines.isEmpty() || installLines.size > 256) return null
        val planned = ArrayList<OfflinePlannedPkg>()
        for (line in installLines) {
            val tail = line.removePrefix("Inst ")
            val name = tail.substringBefore(' ')
            val open = tail.indexOf('(')
            if (!name.matches(Regex("^[a-z0-9][a-z0-9.+-]{0,127}$")) || open < 0) return null
            val version = tail.substring(open + 1).substringBefore(' ').removeSuffix(")")
            if (!version.matches(Regex("^[A-Za-z0-9.+:~_-]{1,128}$"))) return null
            val pkg = stage.packages.firstOrNull { it.name == name && it.version == version } ?: return null
            planned.add(OfflinePlannedPkg(pkg.name, pkg.version, pkg.architecture, pkg.sizeBytes))
        }
        if (planned.map { it.name }.distinct().size != planned.size || roots.any { root -> planned.none { it.name == root } }) return null
        return planned
    }
    private fun offlineDeleteStage(stageId: String) {
        offlinePlans.entries.filter { it.value.stageId == stageId }.forEach { offlinePlans.remove(it.key, it.value) }
        val root = File(reactApplicationContext.cacheDir, "offline-bundle-" + stageId)
        if (root.parentFile?.canonicalPath != reactApplicationContext.cacheDir.canonicalPath || root.canonicalPath != root.absolutePath) return
        fun remove(file: File) { val st = try { Os.lstat(file.absolutePath) } catch (_: Throwable) { return }; if ((st.st_mode and OsConstants.S_IFMT) == OsConstants.S_IFDIR) file.listFiles()?.forEach { remove(it) }; try { Os.remove(file.absolutePath) } catch (_: Throwable) { } }
        remove(root)
        val apt = File(reactApplicationContext.cacheDir, "offline-apt-" + stageId); if (apt.parentFile?.canonicalPath == reactApplicationContext.cacheDir.canonicalPath) remove(apt)
    }
    private fun offlineRunCommand(command: String, requestId: String, promise: Promise, onSuccess: (Boolean) -> Unit) {
        val proxy = offlineProxyPromise(promise) { value -> onSuccess(offlineResultHasMarker(value, if (command.contains("AIB_OFFLINE_INSTALL_VERIFIED")) "AIB_OFFLINE_INSTALL_VERIFIED" else "AIB_OFFLINE_APT_SIMULATION_OK")) }
        runEmbeddedTermuxCommandInternal(command, null, 900000.0, requestId, proxy, 900000L, true)
    }
    private fun offlineRunPlanCommand(command: String, requestId: String, stage: OfflineStage, roots: List<String>, statusSha256: String, promise: Promise) {
        val proxy = java.lang.reflect.Proxy.newProxyInstance(Promise::class.java.classLoader, arrayOf(Promise::class.java)) { _, method, args ->
            if (method.name == "resolve") {
                val value = args?.getOrNull(0)
                val packages = offlineParseAptPlan(value, stage, roots)
                val result = if (packages == null) offlineResult("blocked", "AIB_OFFLINE_APT_PLAN_UNRESOLVED") else {
                    val id = UUID.randomUUID().toString().replace("-", "")
                    offlinePlans.entries.filter { it.value.stageId == stage.stageId || it.value.expiryMs < System.currentTimeMillis() }.forEach { offlinePlans.remove(it.key, it.value) }
                    val plan = OfflineAptPlan(id, stage.stageId, requestId, roots.toList(), packages, statusSha256, System.currentTimeMillis() + offlinePlanLifetimeMs)
                    offlinePlans[id] = plan
                    val output = offlineResult("ready", "AIB_OFFLINE_APT_PLAN_READY")
                    output.putString("planId", id)
                    val rows = Arguments.createArray()
                    packages.forEach { pkg -> rows.pushMap(Arguments.createMap().also { it.putString("name", pkg.name); it.putString("version", pkg.version); it.putString("architecture", pkg.architecture); it.putDouble("sizeBytes", pkg.sizeBytes.toDouble()) }) }
                    output.putArray("packages", rows)
                    output
                }
                promise.resolve(result)
                null
            } else {
                val values = args ?: emptyArray()
                try { method.invoke(promise, *values) } catch (error: java.lang.reflect.InvocationTargetException) { throw error.targetException }
            }
        } as Promise
        runEmbeddedTermuxCommandInternal(command, null, 900000.0, requestId, proxy, 900000L, true)
    }

    @ReactMethod
    fun planOfflinePackageBundle(stageId: String, requestId: String, selectedPackageNames: com.facebook.react.bridge.ReadableArray, promise: Promise) {
        if (!requestId.matches(Regex("^[A-Za-z0-9._-]{1,96}$")) || !stageId.matches(Regex("^[A-Za-z0-9_-]{16,128}$"))) { promise.resolve(offlineResult("rejected", "AIB_OFFLINE_BUNDLE_ARGUMENT_INVALID")); return }
        val stage = offlineStages[stageId]
        if (stage == null || !stage.ready || !stage.onlineCatalog) { promise.resolve(offlineResult("blocked", "AIB_OFFLINE_APT_PLAN_STAGE_NOT_READY")); return }
        if (stage.expiryMs < System.currentTimeMillis()) { if (offlineStages.remove(stageId, stage)) offlineDeleteStage(stageId); promise.resolve(offlineResult("blocked", "AIB_OFFLINE_BUNDLE_STAGE_EXPIRED")); return }
        val roots = try {
            if (selectedPackageNames.size() !in 1..256) throw IllegalArgumentException("offline_selection_invalid")
            (0 until selectedPackageNames.size()).map { index ->
                if (selectedPackageNames.getType(index) != com.facebook.react.bridge.ReadableType.String) throw IllegalArgumentException("offline_selection_invalid")
                selectedPackageNames.getString(index) ?: throw IllegalArgumentException("offline_selection_invalid")
            }.also { names -> if (names.distinct().size != names.size || names.any { name -> !name.matches(Regex("^[a-z0-9][a-z0-9.+-]{0,127}$")) || stage.packages.none { it.name == name } }) throw IllegalArgumentException("offline_selection_invalid") }
        } catch (_: Throwable) { promise.resolve(offlineResult("rejected", "AIB_OFFLINE_PACKAGE_SELECTION_INVALID")); return }
        when (reserveAibEmbeddedRequest(requestId)) { "busy" -> { promise.resolve(offlineResult("blocked", "EMBEDDED_EXEC_BUSY")); return }; "in_use" -> { promise.resolve(offlineResult("blocked", "EMBEDDED_EXEC_ID_IN_USE")); return } }
        emitOfflineBundleProgress(requestId, "planning", 5)
        val worker = Thread({ var handed = false; try {
            val checked = offlineValidateStage(stage.root, stageId, requestId)
            if (!checked.onlineCatalog || !checked.manifestBytes.contentEquals(stage.manifestBytes) || !checked.signatureBytes.contentEquals(stage.signatureBytes) || checked.packages != stage.packages) throw IllegalArgumentException("offline_stage_changed")
            val (prefix, _, _) = validatedEmbeddedRuntimeLayout()
            val statusSha256 = offlineStatusSha256(prefix)
            val command = offlineAptCommand(checked, prefix, true, roots)
            handed = true
            emitOfflineBundleProgress(requestId, "apt_simulation", 35)
            offlineRunPlanCommand(command, requestId, checked, roots, statusSha256, promise)
        } catch (_: Throwable) { promise.resolve(offlineResult("blocked", "AIB_OFFLINE_APT_PLAN_PREFLIGHT_REJECTED")); emitOfflineBundleProgress(requestId, "failed", 100) }
        finally { if (!handed) releaseAibEmbeddedRequest(requestId) }
        }, "AIB-OfflineAptPlan").apply { isDaemon = true }
        try { worker.start() } catch (_: Throwable) { releaseAibEmbeddedRequest(requestId); promise.resolve(offlineResult("blocked", "AIB_OFFLINE_APT_PLAN_FAILED")) }
    }

    @ReactMethod
    fun stageOfflinePackageBundle(stageDirectoryUri: String, stageId: String, requestId: String, promise: Promise) {
        if (!requestId.matches(Regex("^[A-Za-z0-9._-]{1,96}$")) || !stageId.matches(Regex("^[A-Za-z0-9_-]{16,128}$"))) { promise.resolve(offlineResult("rejected", "AIB_OFFLINE_BUNDLE_ARGUMENT_INVALID")); return }
        val uri = try { Uri.parse(stageDirectoryUri) } catch (_: Throwable) { null }
        if (uri == null || uri.scheme != "file" || !stageDirectoryUri.startsWith("file://") || !uri.authority.isNullOrEmpty() || stageDirectoryUri.length > 8192) { promise.resolve(offlineResult("rejected", "AIB_OFFLINE_BUNDLE_URI_INVALID")); emitOfflineBundleProgress(requestId, "rejected", 0); return }
        when (reserveAibEmbeddedRequest(requestId)) { "busy" -> { promise.resolve(offlineResult("blocked", "EMBEDDED_EXEC_BUSY")); return }; "in_use" -> { promise.resolve(offlineResult("blocked", "EMBEDDED_EXEC_ID_IN_USE")); return } }
        emitOfflineBundleProgress(requestId, "checking", 5)
        val worker = Thread({ var handed = false; try {
            val file = File(uri.path ?: throw IllegalArgumentException("offline_uri_invalid"))
            val stage = offlineValidateStage(file, stageId, requestId, acceptOnlineCatalogSequence = true)
            synchronized(offlineStageLock) { val now = System.currentTimeMillis(); offlineStages.entries.filter { it.value.expiryMs < now }.forEach { expired -> if (offlineStages.remove(expired.key, expired.value)) offlineDeleteStage(expired.key) }; offlineStages[stageId] = stage; offlineScheduleStageExpiry(stage) }
            if (AibEmbeddedProcessRegistry.cancelRequested.contains(requestId)) throw IllegalStateException("embedded_exec_cancelled")
            val (prefix, _, _) = validatedEmbeddedRuntimeLayout()
            val command = offlineAptCommand(stage, prefix, true)
            handed = true
            emitOfflineBundleProgress(requestId, "apt_update", 35)
            offlineRunCommand(command, requestId, promise) { ok ->
                if (ok) { stage.ready = true; emitOfflineBundleProgress(requestId, "ready", 100) }
                else { offlineStages.remove(stageId, stage); offlineDeleteStage(stageId); emitOfflineBundleProgress(requestId, "failed", 100) }
            }
        } catch (_: Throwable) { offlineStages.remove(stageId); offlineDeleteStage(stageId); promise.resolve(offlineResult(if (AibEmbeddedProcessRegistry.cancelRequested.contains(requestId)) "rejected" else "blocked", if (AibEmbeddedProcessRegistry.cancelRequested.contains(requestId)) "EMBEDDED_EXEC_CANCELLED" else "AIB_OFFLINE_BUNDLE_PREFLIGHT_REJECTED")); emitOfflineBundleProgress(requestId, "failed", 100) }
        finally { if (!handed) releaseAibEmbeddedRequest(requestId) }
        }, "AIB-OfflineStage").apply { isDaemon = true }
        try { worker.start() } catch (_: Throwable) { releaseAibEmbeddedRequest(requestId); promise.resolve(offlineResult("blocked", "AIB_OFFLINE_BUNDLE_STAGE_FAILED")) }
    }

    @ReactMethod
    fun installOfflinePackageBundle(stageId: String, requestId: String, selectedPackageNames: com.facebook.react.bridge.ReadableArray, planId: String?, promise: Promise) {
        if (!requestId.matches(Regex("^[A-Za-z0-9._-]{1,96}$")) || !stageId.matches(Regex("^[A-Za-z0-9_-]{16,128}$"))) { promise.resolve(offlineResult("rejected", "AIB_OFFLINE_BUNDLE_ARGUMENT_INVALID")); return }
        val stage = offlineStages[stageId]
        if (stage == null || !stage.ready) { promise.resolve(offlineResult("blocked", "AIB_OFFLINE_BUNDLE_STAGE_NOT_READY")); return }
        val requestedNames = try {
            if (selectedPackageNames.size() !in 1..256) throw IllegalArgumentException("offline_selection_invalid")
            (0 until selectedPackageNames.size()).map { index ->
                if (selectedPackageNames.getType(index) != com.facebook.react.bridge.ReadableType.String) throw IllegalArgumentException("offline_selection_invalid")
                selectedPackageNames.getString(index) ?: throw IllegalArgumentException("offline_selection_invalid")
            }.also { names ->
                if (names.distinct().size != names.size || names.any { name -> !name.matches(Regex("^[a-z0-9][a-z0-9.+-]{0,127}$")) || stage.packages.none { it.name == name } }) throw IllegalArgumentException("offline_selection_invalid")
            }
        } catch (_: Throwable) { promise.resolve(offlineResult("rejected", "AIB_OFFLINE_PACKAGE_SELECTION_INVALID")); return }
        val selectedPlan = if (stage.onlineCatalog) {
            val candidate = planId?.takeIf { it.matches(Regex("^[A-Fa-f0-9]{32}$")) }?.let { offlinePlans[it] }
            if (candidate == null || candidate.stageId != stageId || candidate.roots != requestedNames || candidate.expiryMs < System.currentTimeMillis()) { promise.resolve(offlineResult("blocked", "AIB_OFFLINE_APT_PLAN_REQUIRED_OR_EXPIRED")); return }
            candidate
        } else {
            if (planId != null) { promise.resolve(offlineResult("rejected", "AIB_OFFLINE_APT_PLAN_NOT_APPLICABLE")); return }
            null
        }
        if (stage.expiryMs < System.currentTimeMillis()) { if (offlineStages.remove(stageId, stage)) offlineDeleteStage(stageId); promise.resolve(offlineResult("blocked", "AIB_OFFLINE_BUNDLE_STAGE_EXPIRED")); return }
        when (reserveAibEmbeddedRequest(requestId)) { "busy" -> { promise.resolve(offlineResult("blocked", "EMBEDDED_EXEC_BUSY")); return }; "in_use" -> { promise.resolve(offlineResult("blocked", "EMBEDDED_EXEC_ID_IN_USE")); return } }
        if (selectedPlan != null && !offlinePlans.remove(selectedPlan.planId, selectedPlan)) { releaseAibEmbeddedRequest(requestId); promise.resolve(offlineResult("blocked", "AIB_OFFLINE_APT_PLAN_ALREADY_USED")); return }
        stage.expiryMs = System.currentTimeMillis() + offlineStageLifetimeMs
        offlineScheduleStageExpiry(stage)
        emitOfflineBundleProgress(requestId, "revalidating", 5)
        val worker = Thread({ var handed = false; try {
            val checked = offlineValidateStage(stage.root, stageId, requestId)
            if (!checked.manifestBytes.contentEquals(stage.manifestBytes) || !checked.signatureBytes.contentEquals(stage.signatureBytes) || checked.packages != stage.packages) throw IllegalArgumentException("offline_stage_changed")
            val (prefix, _, _) = validatedEmbeddedRuntimeLayout()
            if (selectedPlan != null && (selectedPlan.expiryMs < System.currentTimeMillis() || offlineStatusSha256(prefix) != selectedPlan.statusSha256)) throw IllegalArgumentException("offline_apt_plan_state_changed")
            val command = if (selectedPlan != null) offlineAptExactPlanCommand(checked, prefix, selectedPlan.packages) else offlineAptCommand(checked, prefix, false, requestedNames)
            handed = true
            emitOfflineBundleProgress(requestId, "installing", 35)
            offlineRunCommand(command, requestId, promise) { ok ->
                if (selectedPlan != null) offlinePlans.remove(selectedPlan.planId, selectedPlan)
                offlineStages.remove(stageId)
                offlineDeleteStage(stageId)
                emitOfflineBundleProgress(requestId, if (ok) "installed" else "partial", 100)
            }
        } catch (_: Throwable) { if (selectedPlan != null) offlinePlans.remove(selectedPlan.planId, selectedPlan); offlineStages.remove(stageId); offlineDeleteStage(stageId); promise.resolve(offlineResult("blocked", "AIB_OFFLINE_BUNDLE_INSTALL_PREFLIGHT_REJECTED")); emitOfflineBundleProgress(requestId, "failed", 100) }
        finally { if (!handed) releaseAibEmbeddedRequest(requestId) }
        }, "AIB-OfflineInstall").apply { isDaemon = true }
        try { worker.start() } catch (_: Throwable) { releaseAibEmbeddedRequest(requestId); promise.resolve(offlineResult("blocked", "AIB_OFFLINE_BUNDLE_INSTALL_FAILED")) }
    }

    @ReactMethod
    fun cancelOfflinePackageBundle(requestId: String, promise: Promise) {
        if (!requestId.matches(Regex("^[A-Za-z0-9._-]{1,96}$"))) { promise.resolve(false); return }
        val cancelled = requestAibEmbeddedCancellation(requestId)
        offlinePlans.entries.filter { it.value.requestId == requestId }.forEach { offlinePlans.remove(it.key, it.value) }
        val expired = offlineStages.entries.filter { it.value.requestId == requestId }
        val current = if (cancelled) AibEmbeddedProcessRegistry.active[requestId] else null
        val cleanupStages = {
            expired.forEach { entry -> if (offlineStages.remove(entry.key, entry.value)) offlineDeleteStage(entry.key) }
        }
        val waitForRequestFinish = {
            val deadline = System.nanoTime() + 3_000_000_000L
            while (AibEmbeddedProcessRegistry.pending.contains(requestId) && System.nanoTime() < deadline) {
                try { Thread.sleep(25) } catch (_: InterruptedException) { Thread.currentThread().interrupt(); break }
            }
            !AibEmbeddedProcessRegistry.pending.contains(requestId)
        }
        if (current == null) {
            if (!cancelled) {
                cleanupStages()
                if (expired.isNotEmpty()) emitOfflineBundleProgress(requestId, "cancelled", 0)
                promise.resolve(expired.isNotEmpty())
                return
            }
            try {
                Thread({
                    val settled = waitForRequestFinish()
                    if (settled) cleanupStages()
                    if (settled) emitOfflineBundleProgress(requestId, "cancelled", 0)
                    promise.resolve(settled)
                }, "AIB-OfflineBundleCancel").apply { isDaemon = true; start() }
            } catch (_: Throwable) { promise.resolve(false) }
            return
        }
        val stopCurrent = {
            try {
                val root = AibEmbeddedProcessRegistry.rootPids[requestId]
                val tracked = AibEmbeddedProcessRegistry.descendants[requestId]
                root != null && aibProcStartTicks(root.pid) == root.startTicks && tracked != null &&
                    stopAibEmbeddedProcess(current, root, tracked)
            } catch (_: Throwable) { false }
        }
        try {
            Thread({
                val stopped = stopCurrent()
                val settled = stopped && waitForRequestFinish()
                if (settled) {
                    cleanupStages()
                    emitOfflineBundleProgress(requestId, "cancelled", 0)
                }
                promise.resolve(settled)
            }, "AIB-OfflineBundleCancel").apply { isDaemon = true; start() }
        } catch (_: Throwable) {
            val stopped = stopCurrent()
            val settled = stopped && waitForRequestFinish()
            if (settled) cleanupStages()
            promise.resolve(settled)
        }
    }

    /** Explicit offline test evidence only; never configures the ordinary package feed. */
    @ReactMethod
    fun stageEmbeddedCandidateFeedProbe(promise: Promise) {
        Thread {
            try {
                promise.resolve(AibCandidateFeedProbe.stage(reactApplicationContext))
            } catch (_: Exception) {
                promise.reject("AIB_CANDIDATE_STAGE_FAILED", "AIB_CANDIDATE_STAGE_FAILED")
            }
        }.start()
    }

    /** A complete pinned test feed; never enables the ordinary production installer. */
    @ReactMethod
    fun stageEmbeddedCandidateFullFeed(promise: Promise) {
        Thread {
            try { promise.resolve(AibCandidateFullFeed.stage(reactApplicationContext)) }
            catch (_: Exception) { promise.reject("AIB_FULL_CANDIDATE_STAGE_FAILED", "AIB_FULL_CANDIDATE_STAGE_FAILED") }
        }.start()
    }
    /** Only read-only actions are currently permitted: the exact feed conflicts with this bootstrap. */
    @ReactMethod
    fun runEmbeddedCandidateFullTransaction(action: String, packages: com.facebook.react.bridge.ReadableArray, requestId: String, promise: Promise) {
        if (action !in setOf("verify", "check", "install", "reinstall", "remove") || packages.size() > 82 ||
            !requestId.matches(Regex("^[A-Za-z0-9._-]{1,96}$"))) {
            promise.reject("AIB_FULL_CANDIDATE_ARGUMENT_INVALID", "AIB_FULL_CANDIDATE_ARGUMENT_INVALID"); return
        }
        when (reserveAibEmbeddedRequest(requestId)) {
            "busy" -> { promise.reject("EMBEDDED_EXEC_BUSY", "Request slot limit reached"); return }
            "in_use" -> { promise.reject("EMBEDDED_EXEC_ID_IN_USE", "Request id is already active"); return }
        }
        val candidateWorker = Thread {
            var phase = "stage"
            var ownershipTransferred = false
            try {
                val root = AibCandidateFullFeed.stage(reactApplicationContext)
                if (AibEmbeddedProcessRegistry.cancelRequested.contains(requestId)) throw IllegalStateException("embedded_exec_cancelled")
                val allowed = File(root, "packages.tsv").readLines().map { it.substringBefore(9.toChar()) }.toSet()
                val names = (0 until packages.size()).map {
                    require(packages.getType(it) == com.facebook.react.bridge.ReadableType.String)
                    packages.getString(it) ?: throw IllegalArgumentException()
                }
                require(names.size == names.toSet().size && names.all { it.matches(Regex("^[a-z0-9][a-z0-9+.-]{0,127}$")) && allowed.contains(it) })
                when (action) {
                    "verify", "check" -> require(names.isEmpty())
                    "install", "reinstall" -> require(names.size == allowed.size && names.toSet() == allowed)
                    "remove" -> require(names.isNotEmpty() && names.size < allowed.size)
                }
                val quote = "'"
                val shell = File(reactApplicationContext.filesDir, "usr/bin/bash").canonicalPath
                val command = quote + shell + quote + " --noprofile --norc " + quote + root + "/candidate-command.sh" + quote + " " +
                    quote + root + quote + " " + quote + action + quote + " " + names.joinToString(" ") { quote + it + quote }
                if (AibEmbeddedProcessRegistry.cancelRequested.contains(requestId)) throw IllegalStateException("embedded_exec_cancelled")
                phase = "transaction"
                ownershipTransferred = true
                runEmbeddedTermuxCommandInternal(command, null, 900000.0, requestId, promise, 900000L, true)
            } catch (error: Exception) {
                if (error.message == "embedded_exec_cancelled") {
                    promise.reject("EMBEDDED_EXEC_CANCELLED", "EMBEDDED_EXEC_CANCELLED")
                    return@Thread
                }
                // Closed reason vocabulary: never persist paths or arbitrary exception messages.
                val knownReasons = setOf(
                    "candidate_full_android_asset_directory_invalid",
                    "candidate_full_android_asset_extra_directory",
                    "candidate_full_android_asset_extra_file",
                    "candidate_full_android_asset_hash_mismatch",
                    "candidate_full_android_asset_incomplete",
                    "candidate_full_android_asset_symlink",
                    "candidate_full_arch_invalid",
                    "candidate_full_asset_file_set_mismatch",
                    "candidate_full_asset_hash_mismatch",
                    "candidate_full_asset_mismatch",
                    "candidate_full_asset_oversize",
                    "candidate_full_asset_special",
                    "candidate_full_asset_symlink",
                    "candidate_full_cache_extra_directory",
                    "candidate_full_cache_extra_file",
                    "candidate_full_cache_file_set_invalid",
                    "candidate_full_cache_hash_invalid",
                    "candidate_full_cache_object_invalid",
                    "candidate_full_cache_owner_invalid",
                    "candidate_full_cache_size_invalid",
                    "candidate_full_cache_unreadable",
                    "candidate_full_directory_invalid",
                    "candidate_full_expected_82_packages",
                    "candidate_full_expected_exact_source_files",
                    "candidate_full_filesdir_noncanonical",
                    "candidate_full_filesdir_unreadable",
                    "candidate_full_inventory_entry_missing",
                    "candidate_full_key_pin_mismatch",
                    "candidate_full_local_pins_hash_mismatch",
                    "candidate_full_local_pins_invalid",
                    "candidate_full_local_pins_not_finalized",
                    "candidate_full_local_pins_shape_invalid",
                    "candidate_full_local_script_pin_invalid",
                    "candidate_full_package_invalid",
                    "candidate_full_package_inventory_mismatch",
                    "candidate_full_package_name_invalid",
                    "candidate_full_parent_create_failed",
                    "candidate_full_partial_stage_limit",
                    "candidate_full_pin_invalid",
                    "candidate_full_pinned_documents_mismatch",
                    "candidate_full_stage_commit_failed",
                    "candidate_full_stage_create_failed",
                    "candidate_full_target_invalid",
                    "candidate_full_usrhome_noncanonical",
                    "candidate_full_native_failure",
                    "candidate_full_argument_invalid",
                    "candidate_full_security_denied",
                    "candidate_full_io_access_denied",
                    "candidate_full_io_not_found",
                    "candidate_full_io_no_space",
                    "candidate_full_io_symlink_loop",
                    "candidate_full_io_not_directory",
                    "candidate_full_io_read_only",
                    "candidate_full_io_failure"
                )
                val messageReason = error.message?.substringBefore(':')
                val reason = if (messageReason in knownReasons) messageReason!! else when (error) {
                    is android.system.ErrnoException -> when (error.errno) {
                        android.system.OsConstants.EACCES, android.system.OsConstants.EPERM -> "candidate_full_io_access_denied"
                        android.system.OsConstants.ENOENT -> "candidate_full_io_not_found"
                        android.system.OsConstants.ENOSPC -> "candidate_full_io_no_space"
                        android.system.OsConstants.ELOOP -> "candidate_full_io_symlink_loop"
                        android.system.OsConstants.ENOTDIR -> "candidate_full_io_not_directory"
                        android.system.OsConstants.EROFS -> "candidate_full_io_read_only"
                        else -> "candidate_full_io_failure"
                    }
                    is SecurityException -> "candidate_full_security_denied"
                    is IllegalArgumentException -> "candidate_full_argument_invalid"
                    is java.io.IOException -> "candidate_full_io_failure"
                    else -> "candidate_full_native_failure"
                }
                val code = "AIB_FULL_CANDIDATE_" + phase.uppercase() + "_" + reason.removePrefix("candidate_full_").uppercase()
                promise.reject(code, code)
            } finally {
                if (!ownershipTransferred) releaseAibEmbeddedRequest(requestId)
            }
        }.apply { isDaemon = true }
        try { candidateWorker.start() } catch (_: Throwable) {
            releaseAibEmbeddedRequest(requestId)
            promise.reject("AIB_FULL_CANDIDATE_STAGE_NATIVE_FAILURE", "AIB_FULL_CANDIDATE_STAGE_NATIVE_FAILURE")
        }
    }

    /** Reads only a bounded apply.log from the app-private candidate transaction store. */
    @ReactMethod
    fun readEmbeddedCandidateApplyLog(transactionId: String, promise: Promise) {
        if (!transactionId.matches(Regex("^tx-[A-Za-z0-9-]{12,80}$"))) {
            promise.reject("AIB_CANDIDATE_APPLY_LOG_TRANSACTION_INVALID", "AIB_CANDIDATE_APPLY_LOG_TRANSACTION_INVALID"); return
        }
        Thread({
            try {
                val filesRoot = reactApplicationContext.filesDir.canonicalFile
                val transactionRoot = File(filesRoot, "candidate-transactions")
                val rootStat = Os.lstat(transactionRoot.path)
                if ((rootStat.st_mode and OsConstants.S_IFMT) != OsConstants.S_IFDIR || transactionRoot.canonicalFile.path != transactionRoot.absolutePath) {
                    throw SecurityException("AIB_CANDIDATE_APPLY_LOG_ROOT_REJECTED")
                }
                val transaction = File(transactionRoot, transactionId)
                val transactionStat = Os.lstat(transaction.path)
                if ((transactionStat.st_mode and OsConstants.S_IFMT) != OsConstants.S_IFDIR ||
                    transaction.canonicalFile.parentFile?.path != transactionRoot.canonicalPath) {
                    throw SecurityException("AIB_CANDIDATE_APPLY_LOG_TRANSACTION_REJECTED")
                }
                val logFile = File(transaction, "apply.log")
                val fd = Os.open(logFile.path, OsConstants.O_RDONLY or OsConstants.O_NOFOLLOW or OsConstants.O_NONBLOCK or OsConstants.O_CLOEXEC, 0)
                val pfd = try { ParcelFileDescriptor.dup(fd) } finally { Os.close(fd) }
                val maxBytes = 64 * 1024
                val payload = ParcelFileDescriptor.AutoCloseInputStream(pfd).use { input ->
                    val metadata = Os.fstat(input.fd)
                    if ((metadata.st_mode and OsConstants.S_IFMT) != OsConstants.S_IFREG || metadata.st_size < 0L) {
                        throw SecurityException("AIB_CANDIDATE_APPLY_LOG_FILE_REJECTED")
                    }
                    val size = metadata.st_size
                    val truncated = size > maxBytes
                    val offset = (size - maxBytes).coerceAtLeast(0L)
                    Os.lseek(input.fd, offset, OsConstants.SEEK_SET)
                    val wanted = (size - offset).toInt()
                    val output = java.io.ByteArrayOutputStream(wanted)
                    val buffer = ByteArray(8192)
                    while (output.size() < wanted) {
                        val count = input.read(buffer, 0, minOf(buffer.size, wanted - output.size()))
                        if (count < 0) break
                        if (count == 0) throw java.io.IOException("AIB_CANDIDATE_APPLY_LOG_READ_FAILED")
                        output.write(buffer, 0, count)
                    }
                    if (output.size() != wanted) throw java.io.IOException("AIB_CANDIDATE_APPLY_LOG_READ_FAILED")
                    val bytes = output.toByteArray()
                    var validStart = 0
                    if (truncated) while (validStart < 3 && validStart < bytes.size && (bytes[validStart].toInt() and 0xC0) == 0x80) validStart++
                    val textBytes = if (validStart == 0) bytes else bytes.copyOfRange(validStart, bytes.size)
                    val decoder = Charsets.UTF_8.newDecoder().onMalformedInput(java.nio.charset.CodingErrorAction.REPORT)
                        .onUnmappableCharacter(java.nio.charset.CodingErrorAction.REPORT)
                    val text = decoder.decode(java.nio.ByteBuffer.wrap(textBytes)).toString()
                    Triple(textBytes, text, truncated)
                }
                val result = Arguments.createMap()
                result.putString("transactionId", transaction.name)
                result.putString("content", payload.second)
                result.putInt("byteLength", payload.first.size)
                result.putBoolean("truncated", payload.third)
                promise.resolve(result)
            } catch (error: Exception) {
                val errno = (error as? android.system.ErrnoException)?.errno
                val code = when {
                    error.message == "AIB_CANDIDATE_APPLY_LOG_NOT_FOUND" || errno == OsConstants.ENOENT -> "AIB_CANDIDATE_APPLY_LOG_NOT_FOUND"
                    error is SecurityException || errno == OsConstants.ELOOP -> "AIB_CANDIDATE_APPLY_LOG_PATH_REJECTED"
                    else -> "AIB_CANDIDATE_APPLY_LOG_READ_FAILED"
                }
                promise.reject(code, code, error)
            }
        }, "AIB-CandidateLogRead").apply { isDaemon = true; start() }
    }

    /** One identity gate shared by readiness and execution; usr/home symlinks are never accepted. */
    private fun canonicalEmbeddedRuntimeRoots(): Pair<File, File> {
        val context = reactApplicationContext
        if (context.packageName != "com.karat.aibuilder") throw SecurityException("wrong_package")
        if (Build.SUPPORTED_ABIS.firstOrNull().orEmpty() != "arm64-v8a") throw SecurityException("unsupported_abi")
        val files = context.filesDir.canonicalFile
        val prefixExpected = File(files, "usr")
        val homeExpected = File(files, "home")
        val prefix = prefixExpected.canonicalFile
        val home = homeExpected.canonicalFile
        if (prefix.path != prefixExpected.absolutePath || home.path != homeExpected.absolutePath) {
            throw SecurityException("private_layout_symlink_rejected")
        }
        return Pair(prefix, home)
    }

    /** Reports whether the app-private bootstrap and its second stage completed. */
    @ReactMethod
    fun getEmbeddedTermuxRuntimeStatus(promise: Promise) {
        try {
            val appFiles = reactApplicationContext.filesDir
            val runtimeRoots = try { canonicalEmbeddedRuntimeRoots() } catch (_: Throwable) { null }
            val prefix = runtimeRoots?.first ?: File(appFiles, "usr")
            val home = runtimeRoots?.second ?: File(appFiles, "home")
            val login = File(prefix, "bin/login")
            val bash = File(prefix, "bin/bash")
            val apt = File(prefix, "bin/apt")
            val dpkg = File(prefix, "bin/dpkg")
            val termuxConfig = File(prefix, "etc/termux")
            val aptSources = File(prefix, "etc/apt/sources.list")
            val dpkgStatus = File(prefix, "var/lib/dpkg/status")
            val bootstrapManifestFile = File(appFiles, "termux-bootstrap.json")
            val bootstrapManifest = try {
                if (bootstrapManifestFile.isFile) org.json.JSONObject(bootstrapManifestFile.readText(Charsets.UTF_8)) else null
            } catch (_: Throwable) { null }
            val bootstrapManifestPresent = bootstrapManifest != null
            val bootstrapManifestValid = bootstrapManifest != null && bootstrapManifest.optInt("schemaVersion", 0) == 1 &&
                bootstrapManifest.optString("applicationId") == reactApplicationContext.packageName &&
                bootstrapManifest.optString("androidAbi") == Build.SUPPORTED_ABIS.firstOrNull().orEmpty() &&
                bootstrapManifest.optString("architecture") == "aarch64" &&
                bootstrapManifest.optString("prefixRelativePath") == "usr" &&
                bootstrapManifest.optString("homeRelativePath") == "home" &&
                bootstrapManifest.optString("installState") == "complete" &&
                bootstrapManifest.optBoolean("secondStageCompleted", false) &&
                bootstrapManifest.optString("sourceCommit").matches(Regex("^[a-fA-F0-9]{40}$")) &&
                bootstrapManifest.optString("bootstrapVersion").matches(Regex("^[A-Za-z0-9._-]{1,80}$")) &&
                bootstrapManifest.optString("archiveSha256").matches(Regex("^[a-fA-F0-9]{64}$"))
            val applicationDataDir = reactApplicationContext.applicationInfo.dataDir
            val filesDirPath = appFiles.absolutePath
            val termuxPrefixPath = prefix.absolutePath
            val packageFeedUrl = "https://argus-94.github.io/TERMUX_APP_PACKAGE/apt/termux-main"
            val packageFeedSource = File(prefix, "etc/apt/sources.list.d/aibuilder-termux-feed.list")
            val packageFeedKeyring = File(prefix, "etc/apt/keyrings/aibuilder-termux-feed.gpg")
            val packageFeedStatus = if (bootstrapManifestValid) {
                bootstrapManifest?.optString("packageFeedStatus")?.takeIf { it.matches(Regex("^[a-z0-9_]{1,80}$")) } ?: "blocked_signing_key_unprovisioned"
            } else "blocked_bootstrap_manifest_invalid"
            val expectedFeedSourceLine = "deb [arch=aarch64 signed-by=" + packageFeedKeyring.absolutePath + "] " + packageFeedUrl + " stable main"
            val packageFeedSourceMatches = try {
                runtimeRoots != null && packageFeedSource.isFile && packageFeedSource.readLines(Charsets.UTF_8).any { it.trim() == expectedFeedSourceLine }
            } catch (_: Throwable) { false }
            val packageFeedEnabled = packageFeedStatus == "signed_source_configured" &&
                bootstrapManifest?.optBoolean("packageFeedEnabled", false) == true &&
                packageFeedKeyring.isFile && packageFeedSourceMatches
            val shellPresent = runtimeRoots != null && (login.canExecute() || bash.canExecute())
            val packageManagerPresent = runtimeRoots != null && apt.canExecute()
            val dpkgPresent = runtimeRoots != null && dpkg.canExecute()
            val configPresent = runtimeRoots != null && termuxConfig.isDirectory
            val aptSourcesPresent = runtimeRoots != null && aptSources.isFile && aptSources.canRead()
            val dpkgDatabasePresent = runtimeRoots != null && dpkgStatus.isFile && dpkgStatus.canRead()
            val prefixPresent = runtimeRoots != null && prefix.isDirectory
            val homePresent = runtimeRoots != null && home.isDirectory
            // This is only a filesystem preflight. Android may still reject execution
            // (for example because of ABI/linker or noexec restrictions), so it is not
            // proof that a shell can actually start.
            val prefixWritable = runtimeRoots != null && prefix.isDirectory && prefix.canWrite()
            val ready = bootstrapManifestValid && prefixPresent && homePresent && shellPresent && packageManagerPresent &&
                dpkgPresent && configPresent && aptSourcesPresent && dpkgDatabasePresent && prefixWritable
            val result = Arguments.createMap()
            result.putBoolean("prefixPresent", prefixPresent)
            result.putBoolean("homePresent", homePresent)
            result.putBoolean("shellPresent", shellPresent)
            result.putBoolean("packageManagerPresent", packageManagerPresent)
            result.putBoolean("dpkgPresent", dpkgPresent)
            result.putBoolean("termuxConfigPresent", configPresent)
            result.putBoolean("aptSourcesPresent", aptSourcesPresent)
            result.putBoolean("dpkgDatabasePresent", dpkgDatabasePresent)
            result.putBoolean("prefixWritable", prefixWritable)
            result.putBoolean("bootstrapManifestPresent", bootstrapManifestPresent)
            result.putBoolean("bootstrapManifestValid", bootstrapManifestValid)
            result.putString("bootstrapVersion", bootstrapManifest?.optString("bootstrapVersion", "") ?: "")
            result.putString("bootstrapArchiveSha256", bootstrapManifest?.optString("archiveSha256", "") ?: "")
            result.putString("applicationId", reactApplicationContext.packageName)
            result.putString("architecture", "aarch64")
            result.putString("applicationDataDir", applicationDataDir)
            result.putString("filesDir", filesDirPath)
            result.putString("termuxPrefix", termuxPrefixPath)
            result.putString("packageFeedUrl", packageFeedUrl)
            result.putString("packageFeedStatus", packageFeedStatus)
            result.putBoolean("packageFeedEnabled", packageFeedEnabled)
            result.putString("packageFeedKeyFingerprint", bootstrapManifest?.optString("packageFeedKeyFingerprint", "") ?: "")
            result.putBoolean("ready", ready)
            result.putString("status", if (ready) "embedded_prefix_ready" else "bootstrap_missing_or_incomplete")
            promise.resolve(result)
        } catch (e: Exception) {
            promise.reject("EMBEDDED_TERMUX_STATUS_FAILED", e)
        }
    }

    private fun validatedEmbeddedRuntimeLayout(): Triple<File, File, File> {
        val context = reactApplicationContext
        val files = context.filesDir.canonicalFile
        val roots = canonicalEmbeddedRuntimeRoots()
        val prefix = roots.first
        val home = roots.second
        val manifest = try {
            val file = File(files, "termux-bootstrap.json")
            if (file.isFile) org.json.JSONObject(file.readText(Charsets.UTF_8)) else null
        } catch (_: Throwable) { null }
        val manifestValid = manifest != null && manifest.optInt("schemaVersion", 0) == 1 &&
            manifest.optString("applicationId") == context.packageName &&
            manifest.optString("androidAbi") == "arm64-v8a" &&
            manifest.optString("architecture") == "aarch64" &&
            manifest.optString("prefixRelativePath") == "usr" &&
            manifest.optString("homeRelativePath") == "home" &&
            manifest.optString("installState") == "complete" &&
            manifest.optBoolean("secondStageCompleted", false) &&
            manifest.optString("sourceCommit").matches(Regex("^[a-fA-F0-9]{40}$")) &&
            manifest.optString("bootstrapVersion").matches(Regex("^[A-Za-z0-9._-]{1,80}$")) &&
            manifest.optString("archiveSha256") == AibEmbeddedTermuxBootstrapInstaller.EXPECTED_ARCHIVE_SHA256
        val bash = File(prefix, "bin/bash")
        if (!manifestValid || !prefix.isDirectory || !home.isDirectory || !bash.canExecute() ||
            !File(prefix, "bin/apt").canExecute() || !File(prefix, "bin/dpkg").canExecute()) {
            throw IllegalStateException("embedded_runtime_not_ready")
        }
        return Triple(prefix, home, bash)
    }

    /** Do not expose raw exception messages: they may contain commands or private paths. */
    private fun embeddedExecFailureCode(error: Throwable, phase: String): String {
        return when (error.message) {
            "embedded_runtime_not_ready" -> "EMBEDDED_EXEC_RUNTIME_NOT_READY"
            "embedded_exec_cancelled" -> "EMBEDDED_EXEC_CANCELLED"
            "embedded_process_tracking_unavailable" -> "EMBEDDED_EXEC_PROCESS_TRACKING_UNAVAILABLE"
            "wrong_package", "unsupported_abi" -> "EMBEDDED_EXEC_IDENTITY_REJECTED"
            "private_layout_symlink_rejected" -> "EMBEDDED_EXEC_LAYOUT_REJECTED"
            "cwd_scope_violation", "cwd_all_files_access_required", "cwd_workspace_root_missing", "cwd_directory_missing", "cwd_not_directory", "cwd_root_symlink_rejected", "cwd_symlink_rejected" -> "EMBEDDED_EXEC_CWD_REJECTED"
            "private_app_data_root_unavailable", "private_tmp_create_failed", "private_tmp_scope_violation" -> "EMBEDDED_EXEC_TMP_FAILED"
            "embedded_exec_id_collision" -> "EMBEDDED_EXEC_ID_IN_USE"
            else -> when (phase) {
                "layout" -> "EMBEDDED_EXEC_LAYOUT_REJECTED"
                "cwd" -> "EMBEDDED_EXEC_CWD_REJECTED"
                "tmp" -> "EMBEDDED_EXEC_TMP_FAILED"
                "start" -> "EMBEDDED_EXEC_START_FAILED"
                "io" -> "EMBEDDED_EXEC_IO_FAILED"
                "wait" -> "EMBEDDED_EXEC_WAIT_FAILED"
                else -> "EMBEDDED_EXEC_FAILED"
            }
        }
    }

    /** Stable, path-free detail for JS diagnostics; never return exception text. */
    private fun embeddedExecFailureDetail(error: Throwable, phase: String): String {
        return when (error.message) {
            "cwd_scope_violation" -> "EMBEDDED_EXEC_CWD_SCOPE_REJECTED"
            "cwd_all_files_access_required" -> "EMBEDDED_EXEC_CWD_ALL_FILES_ACCESS_REQUIRED"
            "cwd_workspace_root_missing" -> "EMBEDDED_EXEC_CWD_WORKSPACE_ROOT_MISSING"
            "cwd_directory_missing" -> "EMBEDDED_EXEC_CWD_DIRECTORY_MISSING"
            "cwd_not_directory" -> "EMBEDDED_EXEC_CWD_NOT_DIRECTORY"
            "cwd_root_symlink_rejected" -> "EMBEDDED_EXEC_CWD_ROOT_SYMLINK_REJECTED"
            "cwd_symlink_rejected" -> "EMBEDDED_EXEC_CWD_COMPONENT_SYMLINK_REJECTED"
            else -> embeddedExecFailureCode(error, phase)
        }
    }

    private val privatePackageMutationPatterns = listOf(
        ${PRIVATE_PACKAGE_MUTATION_PATTERNS.map((pattern) => JSON.stringify(pattern)).join(",\n        ")}
    )
    private fun isPrivatePackageMutationCommand(command: String): Boolean =
        privatePackageMutationPatterns.any { pattern ->
            Regex(pattern, RegexOption.IGNORE_CASE).containsMatchIn(command)
        }

    /** Runs one bounded command with a trusted app-private environment; never dispatches an external command intent. */
    @ReactMethod
    fun runEmbeddedTermuxCommand(command: String, workdir: String?, timeoutMs: Double, requestId: String?, promise: Promise) {
        if (isPrivatePackageMutationCommand(command)) {
            promise.reject(
                "AIB_PRIVATE_PACKAGE_FEED_NOT_QUALIFIED",
                "Package mutations require the independently qualified signed AI Builder feed",
                null
            )
            return
        }
        runEmbeddedTermuxCommandInternal(command, workdir, timeoutMs, requestId, promise, 120000L)
    }
    /** Long-running path is reserved for the app-built, offline assembleDebug command contract. */
    @ReactMethod
    fun runEmbeddedTermuxBuildCommand(command: String, workdir: String?, timeoutMs: Double, requestId: String?, promise: Promise) {
        val approved = command.contains("AIB_PRIVATE_OFFLINE_BUILD_V1=1") &&
            command.contains("AIB_ASSEMBLE_TASK=assembleDebug") &&
            command.contains("AIB_GRADLE_EXTRA_FLAGS=--offline") &&
            command.contains("AIB_CACHED_GRADLE_BIN") &&
            !Regex("""(?i)(?:^|[;&|]\\s*)(curl|wget|pkg|apt-get|apt|dpkg|npm|pnpm|yarn|pip3?)\\b""").containsMatchIn(command)
        if (!approved) { promise.reject("EMBEDDED_BUILD_COMMAND_INVALID", "Only the fixed private offline assembleDebug command is permitted"); return }
        runEmbeddedTermuxCommandInternal(command, workdir, timeoutMs, requestId, promise, 900000L)
    }
    /** Shared private executor: only the fixed candidate action and marked offline build may request larger caps. */
    private fun runEmbeddedTermuxCommandInternal(command: String, workdir: String?, timeoutMs: Double, requestId: String?, promise: Promise, hardTimeoutCapMs: Long, requestAlreadyReserved: Boolean = false) {
        val id = requestId?.takeIf { it.matches("^[A-Za-z0-9._-]{1,96}$".toRegex()) }
        if (id == null) {
            if (requestAlreadyReserved && requestId != null) releaseAibEmbeddedRequest(requestId)
            promise.reject("EMBEDDED_EXEC_REQUEST_ID_INVALID", "Invalid request id"); return
        }
        if (command.isBlank() || command.length > 128 * 1024 || command.indexOf(0.toChar()) >= 0) {
            if (requestAlreadyReserved) releaseAibEmbeddedRequest(id)
            promise.reject("EMBEDDED_EXEC_COMMAND_INVALID", "Command is empty, too large, or contains NUL"); return
        }
        if (timeoutMs.isNaN() || timeoutMs.isInfinite()) {
            if (requestAlreadyReserved) releaseAibEmbeddedRequest(id)
            promise.reject("EMBEDDED_EXEC_TIMEOUT_INVALID", "Timeout must be finite"); return
        }
        if (requestAlreadyReserved) {
            if (!AibEmbeddedProcessRegistry.pending.contains(id)) {
                promise.reject("EMBEDDED_EXEC_ID_IN_USE", "Request id is no longer active"); return
            }
        } else {
            when (reserveAibEmbeddedRequest(id)) {
                "busy" -> { promise.reject("EMBEDDED_EXEC_BUSY", "Private runtime process limit reached"); return }
                "in_use" -> { promise.reject("EMBEDDED_EXEC_ID_IN_USE", "Request id is already active"); return }
            }
        }
        val integrityFailure = try { releaseIntegrityFailureCode() } catch (_: Throwable) { "AIB_INTEGRITY_PROBE_FAILED" }
        if (integrityFailure != null) {
            releaseAibEmbeddedRequest(id)
            promise.reject(integrityFailure, integrityFailure, null)
            return
        }
        val timeout = timeoutMs.toLong().coerceIn(1000L, hardTimeoutCapMs)
        val worker = Thread({
            var process: Process? = null
            var processRoot: AibEmbeddedTrackedRoot? = null
            var pidFile: File? = null
            var phase = "layout"
            val startedAt = System.currentTimeMillis()
            try {
                val (prefix, home, shell) = validatedEmbeddedRuntimeLayout()
                if (AibEmbeddedProcessRegistry.cancelRequested.contains(id)) throw IllegalStateException("embedded_exec_cancelled")
                phase = "cwd"
                val homePath = home.canonicalPath
                val requestedText = workdir?.takeIf { it.isNotBlank() } ?: homePath
                val rawCwd = File(requestedText).absoluteFile
                val sharedLexicalRoots = listOf("/storage/emulated/0/AIBuilderTermux")
                val lexicalPath = rawCwd.path.trimEnd(File.separatorChar).ifEmpty { File.separator }
                val privateAliasRoot = homePath.replaceFirst("/data/user/0/", "/data/data/")
                val lexicalHomeRoot = listOf(homePath, privateAliasRoot).firstOrNull { lexicalPath == it || lexicalPath.startsWith(it + File.separator) }
                val lexicalInHome = lexicalHomeRoot != null
                val lexicalSharedRoot = sharedLexicalRoots.firstOrNull { lexicalPath == it || lexicalPath.startsWith(it + File.separator) }
                // Reject out-of-scope input before any filesystem metadata query; never probe arbitrary private paths.
                if (!lexicalInHome && lexicalSharedRoot == null) throw SecurityException("cwd_scope_violation")
                if (!lexicalInHome && !hasAIBuilderAllFilesAccess()) throw SecurityException("cwd_all_files_access_required")
                // Canonicalize only an allowlisted private home or the single authorized shared root,
                // then inspect components below it. This is still a path-based check, not race-free openat.
                val trustedRoot = if (lexicalInHome) File(homePath) else File(lexicalSharedRoot!!)
                fun cwdLstat(path: String, root: Boolean): android.system.StructStat = try {
                    Os.lstat(path)
                } catch (error: android.system.ErrnoException) {
                    if (error.errno == OsConstants.ENOENT) throw SecurityException(if (root) "cwd_workspace_root_missing" else "cwd_directory_missing")
                    throw error
                }
                if ((cwdLstat(trustedRoot.path, true).st_mode and OsConstants.S_IFMT) == OsConstants.S_IFLNK) throw SecurityException("cwd_root_symlink_rejected")
                val canonicalRoot = trustedRoot.canonicalFile
                val selectedLexicalRoot = lexicalHomeRoot ?: lexicalSharedRoot!!
                val suffix = if (lexicalPath == selectedLexicalRoot) "" else lexicalPath.removePrefix(selectedLexicalRoot).trimStart(File.separatorChar)
                val requestedCwd = if (suffix.isEmpty()) canonicalRoot else File(canonicalRoot, suffix)
                var component = canonicalRoot
                if ((cwdLstat(component.absolutePath, true).st_mode and OsConstants.S_IFMT) == OsConstants.S_IFLNK) throw SecurityException("cwd_symlink_rejected")
                for (part in suffix.split(File.separatorChar).filter { it.isNotEmpty() }) {
                    if (part == "." || part == "..") throw SecurityException("cwd_scope_violation")
                    component = File(component, part)
                    if ((cwdLstat(component.absolutePath, false).st_mode and OsConstants.S_IFMT) == OsConstants.S_IFLNK) throw SecurityException("cwd_symlink_rejected")
                }
                if ((cwdLstat(requestedCwd.absolutePath, false).st_mode and OsConstants.S_IFMT) != OsConstants.S_IFDIR) throw SecurityException("cwd_not_directory")
                val cwdPath = requestedCwd.canonicalPath
                val inPrivateHome = cwdPath == homePath || cwdPath.startsWith(homePath + File.separator)
                val canonicalSharedRoot = File("/storage/emulated/0/AIBuilderTermux").canonicalPath
                val inSharedWorkspaceRoot = cwdPath == canonicalSharedRoot || cwdPath.startsWith(canonicalSharedRoot + File.separator)
                if (!inPrivateHome && !inSharedWorkspaceRoot) throw SecurityException("cwd_scope_violation")
                if (!inPrivateHome && !hasAIBuilderAllFilesAccess()) throw SecurityException("cwd_all_files_access_required")
                phase = "tmp"
                val appDataRoot = reactApplicationContext.filesDir.parentFile?.canonicalFile
                    ?: throw IllegalStateException("private_app_data_root_unavailable")
                val tempDir = File(reactApplicationContext.cacheDir, "termux-tmp")
                if (!tempDir.exists() && !tempDir.mkdirs()) throw IllegalStateException("private_tmp_create_failed")
                if (!tempDir.canonicalPath.startsWith(appDataRoot.path + File.separator)) {
                    throw SecurityException("private_tmp_scope_violation")
                }
                val rootPidFile = File.createTempFile("aib-embedded-pid-", ".txt", tempDir.canonicalFile)
                if (rootPidFile.canonicalPath != rootPidFile.absolutePath || !rootPidFile.isFile) {
                    throw IllegalStateException("embedded_process_tracking_unavailable")
                }
                pidFile = rootPidFile
                phase = "start"
                if (AibEmbeddedProcessRegistry.cancelRequested.contains(id)) throw IllegalStateException("embedded_exec_cancelled")
                val wrapper = "printf '%s\\n' \\\"\\$\\$\\\" > \\\"\\$2\\\" || exit 125; IFS= read -r _aib_start || exit 125; set +m; eval \\\"\\$1\\\"; command_status=\\$?; wait; exit \\$command_status"
                val builder = ProcessBuilder(AibEmbeddedTermuxBootstrapInstaller.shellCommand(prefix, "--noprofile", "--norc", "-c", wrapper, "aib-embedded", command, rootPidFile.absolutePath)).directory(requestedCwd)
                val env = builder.environment()
                env.clear()
                env.putAll(AibEmbeddedTermuxBootstrapInstaller.executionEnvironment(reactApplicationContext, prefix, home, tempDir))
                env["PWD"] = requestedCwd.path
                process = builder.start()
                processRoot = awaitAibEmbeddedRootPid(process!!, rootPidFile, 1_000L)
                    ?: throw IllegalStateException("embedded_process_tracking_unavailable")
                val trackedDescendants = ConcurrentHashMap<Int, String>()
                AibEmbeddedProcessRegistry.descendants[id] = trackedDescendants
                phase = "io"
                AibEmbeddedProcessRegistry.rootPids[id] = processRoot!!
                if (AibEmbeddedProcessRegistry.active.putIfAbsent(id, process!!) != null) {
                    process!!.destroy()
                    throw IllegalStateException("embedded_exec_id_collision")
                }
                if (AibEmbeddedProcessRegistry.cancelRequested.contains(id)) {
                    stopAibEmbeddedProcess(process!!, processRoot!!, trackedDescendants)
                } else {
                    process!!.outputStream.write('\\n'.code)
                    process!!.outputStream.flush()
                    process!!.outputStream.close()
                }
                val stdout = java.util.concurrent.atomic.AtomicReference(AibEmbeddedCapturedOutput("", false))
                val stderr = java.util.concurrent.atomic.AtomicReference(AibEmbeddedCapturedOutput("", false))
                val stdoutThread = Thread({ try { stdout.set(captureAibEmbeddedOutput(process!!.inputStream)) } catch (_: Throwable) { } }, "AIB-EmbeddedStdout")
                val stderrThread = Thread({ try { stderr.set(captureAibEmbeddedOutput(process!!.errorStream)) } catch (_: Throwable) { } }, "AIB-EmbeddedStderr")
                stdoutThread.isDaemon = true
                stderrThread.isDaemon = true
                stdoutThread.start()
                stderrThread.start()
                phase = "wait"
                val (timedOut, exitCode) = waitForAibEmbeddedProcess(process!!, timeout, processRoot!!, trackedDescendants)
                val childrenClean = cleanupAibEmbeddedDescendants(processRoot!!.pid, trackedDescendants)
                stdoutThread.join(1500)
                stderrThread.join(1500)
                if (stdoutThread.isAlive) try { process!!.inputStream.close(); stdoutThread.interrupt() } catch (_: Throwable) { }
                if (stderrThread.isAlive) try { process!!.errorStream.close(); stderrThread.interrupt() } catch (_: Throwable) { }
                stdoutThread.join(1500)
                stderrThread.join(1500)
                if (stdoutThread.isAlive || stderrThread.isAlive) throw java.io.IOException("embedded_output_reader_cleanup_failed")
                if (!childrenClean) throw java.io.IOException("embedded_child_cleanup_failed")
                val stdoutResult = stdout.get()
                val stderrResult = stderr.get()
                val readersStillOpen = false
                val result = Arguments.createMap()
                result.putString("commandId", id)
                result.putString("stdout", stdoutResult.text)
                result.putString("stderr", stderrResult.text)
                result.putInt("exitCode", exitCode)
                result.putBoolean("timedOut", timedOut)
                result.putBoolean("outputTruncated", stdoutResult.truncated || stderrResult.truncated || readersStillOpen)
                result.putDouble("durationMs", (System.currentTimeMillis() - startedAt).toDouble())
                result.putString("backendId", "embedded-termux")
                promise.resolve(result)
            } catch (error: Throwable) {
                val code = embeddedExecFailureCode(error, phase)
                promise.reject(code, embeddedExecFailureDetail(error, phase))
            } finally {
                val current = process
                if (current != null) {
                    val root = AibEmbeddedProcessRegistry.rootPids[id] ?: processRoot
                    val tracked = AibEmbeddedProcessRegistry.descendants[id]
                    if (root != null && tracked != null) stopAibEmbeddedProcess(current, root, tracked)
                    else try { current.destroy() } catch (_: Throwable) { }
                    AibEmbeddedProcessRegistry.active.remove(id, current)
                    try { current.inputStream.close() } catch (_: Throwable) { }
                    try { current.errorStream.close() } catch (_: Throwable) { }
                    try { current.outputStream.close() } catch (_: Throwable) { }
                }
                AibEmbeddedProcessRegistry.rootPids.remove(id)
                AibEmbeddedProcessRegistry.descendants.remove(id)
                try { pidFile?.delete() } catch (_: Throwable) { }
                releaseAibEmbeddedRequest(id)
            }
        }, "AIB-EmbeddedTermuxExec").apply { isDaemon = true }
        try { worker.start() } catch (_: Throwable) {
            releaseAibEmbeddedRequest(id)
            promise.reject("EMBEDDED_EXEC_FAILED", "Unable to start private runtime worker")
        }
    }

    /** Read the app-private dpkg registry with a fixed executable/argv; no shell or external fallback. */
    @ReactMethod
    fun queryEmbeddedTermuxPackages(name: String?, limit: Double, promise: Promise) {
        val queryName = name?.takeIf { it.matches("^[a-z0-9][a-z0-9+.-]{0,127}$".toRegex()) }
        if (name != null && queryName == null) {
            promise.reject("AIB_PRIVATE_PACKAGE_NAME_INVALID", "AIB_PRIVATE_PACKAGE_NAME_INVALID")
            return
        }
        if (!limit.isFinite() || limit < 1.0 || limit > 100.0 || limit != limit.toInt().toDouble()) {
            promise.reject("AIB_PRIVATE_PACKAGE_LIMIT_INVALID", "AIB_PRIVATE_PACKAGE_LIMIT_INVALID")
            return
        }
        if (!AibEmbeddedProcessRegistry.slots.tryAcquire()) {
            promise.reject("AIB_PRIVATE_PACKAGE_QUERY_BUSY", "AIB_PRIVATE_PACKAGE_QUERY_BUSY")
            return
        }
        try {
            val queryWorker = Thread({
                var process: Process? = null
                var processRoot: AibEmbeddedTrackedRoot? = null
                var pidFile: File? = null
                var stdoutThread: Thread? = null
                var stderrThread: Thread? = null
                val trackedDescendants = ConcurrentHashMap<Int, String>()
                val stdout = java.util.concurrent.atomic.AtomicReference(AibEmbeddedCapturedOutput("", false))
                val stderr = java.util.concurrent.atomic.AtomicReference(AibEmbeddedCapturedOutput("", false))
                var processTreeClean = false
                var releaseSlot = false
                try {
                    val (prefix, home, _) = validatedEmbeddedRuntimeLayout()
                    val dpkgDatabase = File(prefix, "var/lib/dpkg")
                    val statusFile = File(dpkgDatabase, "status")
                    val dpkgQuery = File(prefix, "bin/dpkg-query")
                    val expectedPrivateHome = File(prefix.parentFile, "home")
                    if (dpkgDatabase.canonicalPath != dpkgDatabase.absolutePath || !dpkgDatabase.isDirectory ||
                        statusFile.canonicalPath != statusFile.absolutePath || !statusFile.isFile || !statusFile.canRead() ||
                        statusFile.length() > 8L * 1024L * 1024L ||
                        dpkgQuery.canonicalPath != dpkgQuery.absolutePath || !dpkgQuery.isFile || !dpkgQuery.canExecute() ||
                        !home.isDirectory || home.canonicalPath != expectedPrivateHome.absolutePath) {
                        throw IllegalStateException("AIB_PRIVATE_PACKAGE_QUERY_REGISTRY_UNAVAILABLE")
                    }
                    val showFormat = "\${'$'}{binary:Package}\\t\${'$'}{Version}\\t\${'$'}{db:Status-Status}\\n"
                    val argv = mutableListOf(
                        dpkgQuery.absolutePath,
                        "--admindir=" + dpkgDatabase.absolutePath,
                        "--show",
                        "--showformat=" + showFormat,
                    )
                    if (queryName != null) argv.add(queryName)
                    val appDataRoot = reactApplicationContext.filesDir.parentFile?.canonicalFile
                        ?: throw IllegalStateException("AIB_PRIVATE_PACKAGE_QUERY_REGISTRY_UNAVAILABLE")
                    val tempDir = reactApplicationContext.cacheDir
                    if (tempDir.canonicalPath != tempDir.absolutePath ||
                        !tempDir.canonicalPath.startsWith(appDataRoot.path + File.separator)) {
                        throw IllegalStateException("AIB_PRIVATE_PACKAGE_QUERY_REGISTRY_UNAVAILABLE")
                    }
                    val rootPidFile = File.createTempFile("aib-package-query-pid-", ".txt", tempDir.canonicalFile)
                    if (rootPidFile.canonicalPath != rootPidFile.absolutePath || !rootPidFile.isFile) {
                        throw IllegalStateException("AIB_PRIVATE_PACKAGE_QUERY_REGISTRY_UNAVAILABLE")
                    }
                    pidFile = rootPidFile
                    // The command and all its operands remain distinct argv entries; no eval or input concatenation.
                    val wrapper = "printf '%s\\n' \\\"\\$\\$\\\" > \\\"\\$1\\\" || exit 125; IFS= read -r _aib_start || exit 125; shift; exec \\\"\\$@\\\""
                    val command = AibEmbeddedTermuxBootstrapInstaller.shellCommand(
                        prefix, "--noprofile", "--norc", "-c", wrapper,
                        "aib-package-query", rootPidFile.absolutePath, *argv.toTypedArray()
                    )
                    val builder = ProcessBuilder(command).directory(home)
                    val env = builder.environment()
                    env.clear()
                    env.putAll(AibEmbeddedTermuxBootstrapInstaller.executionEnvironment(reactApplicationContext, prefix, home, tempDir))
                    env["LC_ALL"] = "C"
                    process = builder.start()
                    processRoot = awaitAibEmbeddedRootPid(process!!, rootPidFile, 1_000L)
                        ?: throw IllegalStateException("AIB_PRIVATE_PACKAGE_QUERY_PROCESS_TRACKING_UNAVAILABLE")
                    process!!.outputStream.write('\\n'.code)
                    process!!.outputStream.flush()
                    process!!.outputStream.close()
                    stdoutThread = Thread({
                        try { stdout.set(captureAibEmbeddedPackageOutput(process!!.inputStream, 32 * 1024, limit.toInt())) }
                        catch (_: Throwable) { }
                    }, "AIB-EmbeddedPackageStdout")
                    stderrThread = Thread({
                        try { stderr.set(captureAibEmbeddedPackageOutput(process!!.errorStream, 4 * 1024, 8)) }
                        catch (_: Throwable) { }
                    }, "AIB-EmbeddedPackageStderr")
                    stdoutThread!!.isDaemon = true
                    stderrThread!!.isDaemon = true
                    stdoutThread!!.start()
                    stderrThread!!.start()
                    val (timedOut, exitCode) = waitForAibEmbeddedProcess(process!!, 5_000L, processRoot!!, trackedDescendants)
                    if (!cleanupAibEmbeddedDescendants(processRoot!!.pid, trackedDescendants)) {
                        throw java.io.IOException("embedded_child_cleanup_failed")
                    }
                    try { process!!.exitValue() } catch (_: IllegalThreadStateException) {
                        throw java.io.IOException("embedded_process_cleanup_failed")
                    }
                    processTreeClean = true
                    if (!stopAibEmbeddedPackageReaders(process!!, listOf(stdoutThread!!, stderrThread!!))) {
                        throw java.io.IOException("embedded_output_reader_cleanup_failed")
                    }
                    val stdoutResult = stdout.get()
                    val stderrResult = stderr.get()
                    val result = Arguments.createMap()
                    result.putString("stdout", stdoutResult.text)
                    result.putString("stderr", stderrResult.text)
                    result.putInt("exitCode", exitCode)
                    result.putBoolean("timedOut", timedOut)
                    result.putBoolean("outputTruncated", stdoutResult.truncated || stderrResult.truncated)
                    promise.resolve(result)
                } catch (error: Throwable) {
                    val message = error.message.orEmpty()
                    val code = message.takeIf { it.matches("^AIB_PRIVATE_PACKAGE_QUERY_[A-Z_]+$".toRegex()) }
                        ?: "AIB_PRIVATE_PACKAGE_QUERY_FAILED"
                    promise.reject(code, code)
                } finally {
                    val current = process
                    if (current != null) {
                        if (!processTreeClean) {
                            val root = processRoot
                            processTreeClean = if (root != null) {
                                val stopped = try { stopAibEmbeddedProcess(current, root, trackedDescendants) } catch (_: Throwable) { false }
                                val childrenClean = try { cleanupAibEmbeddedDescendants(root.pid, trackedDescendants) } catch (_: Throwable) { false }
                                val reaped = try { current.exitValue(); true } catch (_: IllegalThreadStateException) { false }
                                stopped && childrenClean && reaped
                            } else {
                                // The command is not released until its validated PID handshake succeeds.
                                try { current.destroy() } catch (_: Throwable) { }
                                val deadline = System.nanoTime() + 1_000_000_000L
                                while (System.nanoTime() < deadline) {
                                    try { current.exitValue(); break } catch (_: IllegalThreadStateException) { }
                                    try { Thread.sleep(25) } catch (_: InterruptedException) { Thread.currentThread().interrupt(); break }
                                }
                                try { current.exitValue(); true } catch (_: IllegalThreadStateException) { false }
                            }
                        }
                        try { current.inputStream.close() } catch (_: Throwable) { }
                        try { current.errorStream.close() } catch (_: Throwable) { }
                        try { current.outputStream.close() } catch (_: Throwable) { }
                        val readersClean = try {
                            stopAibEmbeddedPackageReaders(current, listOfNotNull(stdoutThread, stderrThread))
                        } catch (_: Throwable) { false }
                        releaseSlot = processTreeClean && readersClean
                    } else {
                        releaseSlot = true
                    }
                    try { pidFile?.delete() } catch (_: Throwable) { }
                    if (releaseSlot) AibEmbeddedProcessRegistry.slots.release()
                }
            }, "AIB-EmbeddedPackageQuery").apply { isDaemon = true }
            queryWorker.start()
        } catch (error: Throwable) {
            AibEmbeddedProcessRegistry.slots.release()
            promise.reject("AIB_PRIVATE_PACKAGE_QUERY_FAILED", "AIB_PRIVATE_PACKAGE_QUERY_FAILED")
        }
    }

    @ReactMethod
    fun cancelEmbeddedTermuxCommand(requestId: String?, promise: Promise) {
        val id = requestId?.takeIf { it.matches("^[A-Za-z0-9._-]{1,96}$".toRegex()) }
        if (id == null) { promise.reject("EMBEDDED_CANCEL_REQUEST_ID_INVALID", "Invalid request id"); return }
        if (!requestAibEmbeddedCancellation(id)) { promise.resolve(false); return }
        val current = AibEmbeddedProcessRegistry.active[id]
        if (current == null) {
            promise.resolve(true)
            return
        }
        Thread({
            try {
                val root = AibEmbeddedProcessRegistry.rootPids[id]
                val tracked = AibEmbeddedProcessRegistry.descendants[id]
                promise.resolve(root != null && aibProcStartTicks(root.pid) == root.startTicks && tracked != null &&
                    stopAibEmbeddedProcess(current, root, tracked))
            }
            catch (_: Throwable) { promise.resolve(false) }
        }, "AIB-EmbeddedTermuxCancel").apply { isDaemon = true; start() }
    }

    @ReactMethod
    fun isTermuxInstalled(promise: Promise) {
        // Legacy JS probe means the bundled private runtime is ready, not that another app exists.
        try {
            val files = reactApplicationContext.filesDir
            val manifestFile = File(files, "termux-bootstrap.json")
            val manifest = if (manifestFile.isFile) org.json.JSONObject(manifestFile.readText(Charsets.UTF_8)) else null
            val prefix = File(files, "usr")
            val home = File(files, "home")
            val ready = manifest != null &&
                manifest.optString("applicationId") == reactApplicationContext.packageName &&
                manifest.optString("installState") == "complete" &&
                manifest.optBoolean("secondStageCompleted", false) &&
                File(prefix, "bin/bash").canExecute() && File(prefix, "bin/apt").canExecute() &&
                File(prefix, "bin/dpkg").canExecute() && home.isDirectory
            promise.resolve(ready)
        } catch (_: Exception) { promise.resolve(false) }
    }
    @ReactMethod
    fun hasRunCommandPermission(promise: Promise) {
        // Compatibility capability probe: embedded execution is available without a foreign grant.
        promise.resolve(true)
    }
    @ReactMethod
    fun getSupportedAbis(promise: Promise) {
        try {
            val arr = Arguments.createArray()
            Build.SUPPORTED_ABIS.forEach { arr.pushString(it) }
            promise.resolve(arr)
        } catch (e: Exception) {
            promise.reject("ABI_CHECK_FAILED", e)
        }
    }

    @ReactMethod
    fun sha256File(fileUri: String, promise: Promise) {
        try {
            if (fileUri.length <= 8192 && fileUri.startsWith("file://")) {
                val uri = Uri.parse(fileUri)
                val decodedPath = uri.path ?: throw IllegalArgumentException("offline_hash_uri_invalid")
                val candidate = File(decodedPath)
                val canonicalCache = reactApplicationContext.cacheDir.canonicalFile
                val parent = candidate.parentFile
                var possibleStage: File? = parent
                while (possibleStage != null && possibleStage?.parentFile?.canonicalPath?.startsWith(canonicalCache.path + File.separator) == true &&
                    !possibleStage.name.matches(Regex("^offline-bundle-[A-Za-z0-9_-]{16,128}$"))) possibleStage = possibleStage?.parentFile
                val stageName = possibleStage?.name ?: ""
                if (stageName.matches(Regex("^offline-bundle-[A-Za-z0-9_-]{16,128}$"))) {
                    val stageRoot = possibleStage!!
                    val feedRoot = File(stageRoot, "feed")
                    if (!uri.authority.isNullOrEmpty() || candidate.absolutePath != candidate.canonicalPath ||
                        stageRoot.parentFile?.canonicalPath != canonicalCache.path ||
                        stageRoot.canonicalPath != stageRoot.absolutePath ||
                        !candidate.canonicalPath.startsWith(feedRoot.canonicalPath + File.separator)) {
                        promise.reject("AIB_OFFLINE_PACKAGE_HASH_PATH_REJECTED", "AIB_OFFLINE_PACKAGE_HASH_PATH_REJECTED"); return
                    }
                    val rel = candidate.canonicalPath.removePrefix(feedRoot.canonicalPath + File.separator)
                    if (rel.isEmpty() || rel.split(File.separatorChar).any { it.isEmpty() || it == "." || it == ".." }) {
                        promise.reject("AIB_OFFLINE_PACKAGE_HASH_PATH_REJECTED", "AIB_OFFLINE_PACKAGE_HASH_PATH_REJECTED"); return
                    }
                    var component = stageRoot
                    for (part in (listOf("feed") + rel.split(File.separatorChar))) {
                        component = File(component, part)
                        val st = Os.lstat(component.absolutePath); val mode = st.st_mode and OsConstants.S_IFMT
                        val isLast = component.absolutePath == candidate.absolutePath
                        if (mode == OsConstants.S_IFLNK || (isLast && mode != OsConstants.S_IFREG) || (!isLast && mode != OsConstants.S_IFDIR)) {
                            promise.reject("AIB_OFFLINE_PACKAGE_HASH_PATH_REJECTED", "AIB_OFFLINE_PACKAGE_HASH_PATH_REJECTED"); return
                        }
                    }
                    val size = Os.lstat(candidate.absolutePath).st_size
                    if (size !in 1L..(100L * 1024L * 1024L)) { promise.reject("AIB_OFFLINE_PACKAGE_HASH_SIZE_REJECTED", "AIB_OFFLINE_PACKAGE_HASH_SIZE_REJECTED"); return }
                    val digest = MessageDigest.getInstance("SHA-256")
                    FileInputStream(candidate).use { input -> val buffer = ByteArray(32768); var total = 0L; while (true) { val n = input.read(buffer); if (n < 0) break; total += n; if (total > size) throw IllegalArgumentException("offline_hash_size_changed"); digest.update(buffer, 0, n) }; if (total != size) throw IllegalArgumentException("offline_hash_size_changed") }
                    promise.resolve(digest.digest().joinToString("") { "%02x".format(java.util.Locale.ROOT, it.toInt() and 255) }); return
                }
            }
            val rawStripped = fileUri.removePrefix("file://")
            val decoded = try { java.net.URLDecoder.decode(rawStripped, "UTF-8") } catch (_: Exception) { rawStripped }
            var file = File(decoded)
            if (!file.exists()) {
                val direct = File(rawStripped)
                if (direct.exists()) file = direct
            }
            if (!file.exists() || !file.isFile || file.length() <= 0L) {
                promise.reject("FILE_NOT_FOUND", "Файл не найден или пуст")
                return
            }
            val digest = MessageDigest.getInstance("SHA-256")
            FileInputStream(file).use { input ->
                val buffer = ByteArray(1024 * 1024)
                while (true) {
                    val read = input.read(buffer)
                    if (read < 0) break
                    if (read > 0) digest.update(buffer, 0, read)
                }
            }
            promise.resolve(digest.digest().joinToString("") { "%02x".format(it) })
        } catch (e: Exception) {
            if (fileUri.contains("offline-bundle-")) promise.reject("AIB_OFFLINE_PACKAGE_HASH_FAILED", "AIB_OFFLINE_PACKAGE_HASH_FAILED")
            else promise.reject("SHA256_FAILED", e)
        }
    }

    @ReactMethod
    fun getPackageVersion(packageName: String, promise: Promise) {
        // Preserve generic version lookup while preventing Termux package discovery.
        if ((packageName == "com.termux" || packageName.startsWith("com.termux."))) {
            promise.reject("EXTERNAL_TERMUX_UNSUPPORTED", "Use the bundled private runtime")
            return
        }
        try {
            val info = reactApplicationContext.packageManager.getPackageInfo(packageName, 0)
            promise.resolve(info.versionName ?: info.longVersionCode.toString())
        } catch (e: PackageManager.NameNotFoundException) {
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("PACKAGE_VERSION_FAILED", e)
        }
    }

    @ReactMethod
    fun getRuntimeDiagnosticPaths(promise: Promise) {
        try {
            // Report AI Builder-owned path strings only. Do not resolve symlinks,
            // check filesystem existence, enumerate/read files, or inspect Termux.
            val appDataDir = reactApplicationContext.applicationInfo.dataDir
            val filesDir = reactApplicationContext.filesDir.absoluteFile
            val embeddedPrefix = File(filesDir, "usr").absolutePath
            val result = Arguments.createMap()
            result.putString("applicationId", reactApplicationContext.packageName)
            result.putString("appDataDir", appDataDir)
            result.putString("filesDir", filesDir.path)
            result.putString("embeddedTermuxPrefix", embeddedPrefix)
            promise.resolve(result)
        } catch (_: Exception) {
            promise.reject("AIB_RUNTIME_DIAGNOSTIC_PATHS_FAILED", "AIB_RUNTIME_DIAGNOSTIC_PATHS_FAILED")
        }
    }

    @ReactMethod
    fun canInstallPackages(promise: Promise) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                promise.resolve(reactApplicationContext.packageManager.canRequestPackageInstalls())
            } else {
                promise.resolve(true)
            }
        } catch (e: Exception) {
            promise.resolve(false)
        }
    }

    @ReactMethod
    fun openUnknownSourcesSettings(promise: Promise) {
        try {
            val intent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES).apply {
                    data = Uri.parse("package:" + reactApplicationContext.packageName)
                }
            } else {
                Intent(Settings.ACTION_SECURITY_SETTINGS)
            }
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            reactApplicationContext.startActivity(intent)
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("OPEN_UNKNOWN_SOURCES_FAILED", e)
        }
    }

    @ReactMethod
    fun installApk(fileUri: String, promise: Promise) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
                !reactApplicationContext.packageManager.canRequestPackageInstalls()) {
                promise.reject("INSTALL_PERMISSION_REQUIRED", "Разрешите этому приложению устанавливать неизвестные приложения.")
                return
            }
            val rawPath = fileUri.removePrefix("file://")
            val file = File(rawPath)
            if (!file.exists() || !file.isFile || file.length() <= 0L) {
                promise.reject("APK_NOT_FOUND", "APK не найден или пуст: " + rawPath)
                return
            }
            val uri = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                FileProvider.getUriForFile(
                    reactApplicationContext,
                    reactApplicationContext.packageName + ".fileprovider",
                    file
                )
            } else {
                Uri.fromFile(file)
            }
            val intent = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, "application/vnd.android.package-archive")
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
                // Без ClipData часть прошивок Android 10–14 не передаёт grant
                // installer'у и окно установки молча не открывается.
                clipData = android.content.ClipData.newRawUri("", uri)
            }
            // Явно выдаём read grant пакетному установщику, если он известен.
            try {
                val installer = "com.android.packageinstaller"
                reactApplicationContext.grantUriPermission(
                    installer, uri, Intent.FLAG_GRANT_READ_URI_PERMISSION
                )
            } catch (_: Exception) { }
            try {
                val installer = "com.google.android.packageinstaller"
                reactApplicationContext.grantUriPermission(
                    installer, uri, Intent.FLAG_GRANT_READ_URI_PERMISSION
                )
            } catch (_: Exception) { }
            reactApplicationContext.startActivity(intent)
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("APK_INSTALL_LAUNCH_FAILED", e)
        }
    }

    @ReactMethod
    fun openPackage(packageName: String, promise: Promise) {
        try {
            require(packageName != "com.termux" && !packageName.startsWith("com.termux.")) { "External Termux is not used; the AI Builder private runtime is bundled" }
            val intent = reactApplicationContext.packageManager.getLaunchIntentForPackage(packageName)
                ?: throw IllegalArgumentException("Пакет не установлен или не имеет launcher activity: " + packageName)
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            reactApplicationContext.startActivity(intent)
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("OPEN_PACKAGE_FAILED", e)
        }
    }

    private fun decodeFileUri(fileUri: String): String {
        val raw = fileUri.removePrefix("file://")
        return try { java.net.URLDecoder.decode(raw, "UTF-8") } catch (_: Exception) { raw }
    }

    @ReactMethod
    fun getContentUriSize(sourceUri: String, promise: Promise) {
        try {
            val size = if (sourceUri.startsWith("content://")) {
                val uri = Uri.parse(sourceUri)
                reactApplicationContext.contentResolver.query(
                    uri,
                    arrayOf(OpenableColumns.SIZE),
                    null,
                    null,
                    null
                )?.use { cursor ->
                    if (cursor.moveToFirst()) {
                        val index = cursor.getColumnIndex(OpenableColumns.SIZE)
                        if (index >= 0 && !cursor.isNull(index)) cursor.getLong(index) else -1L
                    } else -1L
                } ?: -1L
            } else {
                File(decodeFileUri(sourceUri)).length()
            }
            promise.resolve(size)
        } catch (e: Exception) {
            promise.reject("MODEL_SOURCE_SIZE_FAILED", e.message ?: e.toString(), e)
        }
    }

    @ReactMethod
    fun importModelFile(sourceUri: String, destinationUri: String, promise: Promise) {
        Thread {
            val destination = File(decodeFileUri(destinationUri))
            val temp = File(destination.parentFile ?: reactApplicationContext.cacheDir, destination.name + ".import.part")
            try {
                destination.parentFile?.mkdirs()
                if (temp.exists()) temp.delete()
                val resolver = reactApplicationContext.contentResolver
                val input = if (sourceUri.startsWith("content://")) {
                    resolver.openInputStream(Uri.parse(sourceUri))
                        ?: throw IllegalStateException("MODEL_IMPORT_SOURCE_OPEN_FAILED")
                } else {
                    FileInputStream(File(decodeFileUri(sourceUri)))
                }
                input.use { rawInput ->
                    BufferedInputStream(rawInput, 1024 * 1024).use { bufferedIn ->
                        FileOutputStream(temp).use { rawOutput ->
                            BufferedOutputStream(rawOutput, 1024 * 1024).use { bufferedOut ->
                                val buffer = ByteArray(1024 * 1024)
                                while (true) {
                                    val read = bufferedIn.read(buffer)
                                    if (read < 0) break
                                    if (read > 0) bufferedOut.write(buffer, 0, read)
                                }
                                bufferedOut.flush()
                            }
                        }
                    }
                }
                if (!temp.exists() || temp.length() <= 0L) {
                    throw IllegalStateException("MODEL_IMPORT_EMPTY_SOURCE")
                }
                if (destination.exists()) destination.delete()
                if (!temp.renameTo(destination)) {
                    FileInputStream(temp).use { inputStream ->
                        BufferedInputStream(inputStream, 1024 * 1024).use { bufferedIn ->
                            FileOutputStream(destination).use { outputStream ->
                                BufferedOutputStream(outputStream, 1024 * 1024).use { bufferedOut ->
                                    val buffer = ByteArray(1024 * 1024)
                                    while (true) {
                                        val read = bufferedIn.read(buffer)
                                        if (read < 0) break
                                        if (read > 0) bufferedOut.write(buffer, 0, read)
                                    }
                                    bufferedOut.flush()
                                }
                            }
                        }
                    }
                    temp.delete()
                }
                promise.resolve(true)
            } catch (e: Exception) {
                try { temp.delete() } catch (_: Exception) { }
                try { destination.delete() } catch (_: Exception) { }
                promise.reject("MODEL_IMPORT_FAILED", e.message ?: e.toString(), e)
            }
        }.start()
    }

    private fun copyModelFileToTree(sourceUri: String, fileName: String, treeUri: Uri): Uri {
        val source = File(decodeFileUri(sourceUri))
        if (!source.exists() || !source.isFile || source.length() <= 0L) {
            throw IllegalArgumentException("MODEL_EXPORT_SOURCE_NOT_FOUND: \${source.absolutePath}")
        }
        val resolver = reactApplicationContext.contentResolver
        // SAF: createDocument needs a *document* URI of the parent folder, not the raw tree URI.
        val treeDocId = DocumentsContract.getTreeDocumentId(treeUri)
        val parentDocUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, treeDocId)
        val children = DocumentsContract.buildChildDocumentsUriUsingTree(treeUri, treeDocId)
        // Replace an existing exported file instead of letting SAF silently rename to "(1)".
        resolver.query(
            children,
            arrayOf(DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME),
            null,
            null,
            null
        )?.use { cursor ->
            val idIdx = cursor.getColumnIndex(DocumentsContract.Document.COLUMN_DOCUMENT_ID)
            val nameIdx = cursor.getColumnIndex(DocumentsContract.Document.COLUMN_DISPLAY_NAME)
            while (cursor.moveToNext()) {
                if (nameIdx >= 0 && idIdx >= 0 && fileName == cursor.getString(nameIdx)) {
                    val existingId = cursor.getString(idIdx)
                    try {
                        resolver.delete(
                            DocumentsContract.buildDocumentUriUsingTree(treeUri, existingId),
                            null, null
                        )
                    } catch (_: Exception) { }
                }
            }
        }
        val target = DocumentsContract.createDocument(
            resolver,
            parentDocUri,
            "application/octet-stream",
            fileName
        ) ?: throw IllegalStateException("MODEL_EXPORT_TARGET_CREATE_FAILED: $fileName")
        try {
            val output = resolver.openOutputStream(target, "w")
                ?: throw IllegalStateException("MODEL_EXPORT_OUTPUT_OPEN_FAILED: $fileName")
            FileInputStream(source).use { input ->
                BufferedInputStream(input, 1024 * 1024).use { bufferedIn ->
                    BufferedOutputStream(output, 1024 * 1024).use { bufferedOut ->
                        val buffer = ByteArray(1024 * 1024)
                        while (true) {
                            val read = bufferedIn.read(buffer)
                            if (read < 0) break
                            if (read > 0) bufferedOut.write(buffer, 0, read)
                        }
                        bufferedOut.flush()
                    }
                }
            }
            return target
        } catch (e: Exception) {
            try { resolver.delete(target, null, null) } catch (_: Exception) { }
            throw e
        }
    }

    private fun workspaceTreeDocumentId(uri: Uri): String? {
        if (uri.scheme != "content" || uri.authority != aiBuilderWorkspaceAuthority) return null
        return try { DocumentsContract.getTreeDocumentId(uri) } catch (_: Exception) { null }
    }

    private fun hasAIBuilderAllFilesAccess(): Boolean =
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && Environment.isExternalStorageManager()

    @ReactMethod
    fun pickOfflinePackageArchive(promise: Promise) {
        if (pendingOfflineArchivePickerPromise != null) {
            promise.reject("AIB_OFFLINE_PACKAGE_PICKER_BUSY", "AIB_OFFLINE_PACKAGE_PICKER_BUSY", null)
            return
        }
        val activity = reactApplicationContext.currentActivity
        if (activity == null) {
            promise.reject("AIB_OFFLINE_PACKAGE_PICKER_NO_ACTIVITY", "AIB_OFFLINE_PACKAGE_PICKER_NO_ACTIVITY", null)
            return
        }
        pendingOfflineArchivePickerPromise = promise
        val getContentIntent = Intent(Intent.ACTION_GET_CONTENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = "*/*"
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        try {
            activity.startActivityForResult(
                Intent.createChooser(getContentIntent, "Choose an offline archive"),
                offlineArchivePickerRequestCode,
            )
        } catch (firstError: Exception) {
            val openDocumentIntent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                addCategory(Intent.CATEGORY_OPENABLE)
                type = "*/*"
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            try {
                activity.startActivityForResult(openDocumentIntent, offlineArchivePickerRequestCode)
            } catch (secondError: Exception) {
                pendingOfflineArchivePickerPromise = null
                promise.reject("AIB_OFFLINE_PACKAGE_PICKER_LAUNCH_FAILED", "AIB_OFFLINE_PACKAGE_PICKER_LAUNCH_FAILED", secondError)
            }
        }
    }

    private fun copyOfflineArchiveToPrivateCache(sourceUri: Uri): File {
        val directory = File(reactApplicationContext.cacheDir, "DocumentPicker")
        if (!directory.isDirectory && !directory.mkdirs()) {
            throw java.io.IOException("AIB_OFFLINE_PACKAGE_PICKER_CACHE_UNAVAILABLE")
        }
        val temporary = File.createTempFile("aib-offline-", ".part", directory)
        val destination = File(directory, "aib-offline-" + UUID.randomUUID().toString() + ".zip")
        try {
            var totalBytes = 0L
            val input = reactApplicationContext.contentResolver.openInputStream(sourceUri)
                ?: throw java.io.FileNotFoundException("AIB_OFFLINE_PACKAGE_PICKER_SOURCE_UNAVAILABLE")
            input.use { source ->
                java.io.FileOutputStream(temporary).use { output ->
                    val buffer = ByteArray(32768)
                    while (true) {
                        val count = source.read(buffer)
                        if (count < 0) break
                        if (count == 0) continue
                        totalBytes += count.toLong()
                        if (totalBytes > maxOfflineArchiveBytes) {
                            throw IllegalArgumentException("AIB_OFFLINE_PACKAGE_ARCHIVE_SIZE_INVALID")
                        }
                        output.write(buffer, 0, count)
                    }
                    output.fd.sync()
                }
            }
            if (totalBytes == 0L) throw java.io.IOException("AIB_OFFLINE_PACKAGE_PICKER_SOURCE_EMPTY")
            if (!temporary.renameTo(destination)) throw java.io.IOException("AIB_OFFLINE_PACKAGE_PICKER_COPY_FAILED")
            return destination
        } catch (e: Exception) {
            try { temporary.delete() } catch (_: Exception) { }
            try { destination.delete() } catch (_: Exception) { }
            throw e
        }
    }

    @ReactMethod
    fun getAIBuilderAllFilesAccessStatus(promise: Promise) {
        val supported = Build.VERSION.SDK_INT >= Build.VERSION_CODES.R
        val granted = supported && Environment.isExternalStorageManager()
        val result = Arguments.createMap()
        result.putBoolean("supported", supported)
        result.putBoolean("granted", granted)
        result.putString("reason", when {
            granted -> null
            !supported -> "AIB_ALL_FILES_ACCESS_UNSUPPORTED"
            else -> "AIB_WORKSPACE_ALL_FILES_ACCESS_REQUIRED"
        })
        promise.resolve(result)
    }

    @ReactMethod
    fun openAIBuilderAllFilesAccessSettings(promise: Promise) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
            promise.reject("AIB_ALL_FILES_ACCESS_UNSUPPORTED", "AIB_ALL_FILES_ACCESS_UNSUPPORTED", null)
            return
        }
        val activity = reactApplicationContext.currentActivity
        if (activity == null) {
            promise.reject("AIB_ALL_FILES_ACCESS_NO_ACTIVITY", "AIB_ALL_FILES_ACCESS_NO_ACTIVITY", null)
            return
        }
        try {
            val appIntent = Intent(
                Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION,
                Uri.parse("package:\${reactApplicationContext.packageName}"),
            )
            try {
                activity.startActivity(appIntent)
            } catch (_: Exception) {
                activity.startActivity(Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION))
            }
            // This reports only that Settings was opened. The UI rechecks access on return.
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("AIB_ALL_FILES_ACCESS_SETTINGS_LAUNCH_FAILED", "AIB_ALL_FILES_ACCESS_SETTINGS_LAUNCH_FAILED", e)
        }
    }

    private fun isAIBuilderWorkspaceTree(uri: Uri): Boolean =
        workspaceTreeDocumentId(uri) == aiBuilderWorkspaceTreeDocumentId

    private fun findAIBuilderWorkspaceGrantUri(): Uri? {
        return try {
            reactApplicationContext.contentResolver.persistedUriPermissions.firstOrNull {
                it.isReadPermission && isAIBuilderWorkspaceTree(it.uri)
            }?.uri
        } catch (_: Exception) { null }
    }

    private fun aiBuilderWorkspaceGrantStatus(granted: Boolean, reason: String?): com.facebook.react.bridge.WritableMap {
        val result = Arguments.createMap()
        result.putBoolean("granted", granted)
        if (reason == null) result.putNull("reason") else result.putString("reason", reason)
        return result
    }

    private fun isSafeWorkspaceChildName(name: String): Boolean =
        name.isNotEmpty() && name.length <= 255 && name != "." && name != ".." &&
            !name.contains("/") && name.indexOf(92.toChar()) < 0 && name.indexOf(0.toChar()) < 0

    private fun isDirectWorkspaceChildDocumentId(documentId: String): Boolean {
        val prefix = "$aiBuilderWorkspaceTreeDocumentId/"
        if (!documentId.startsWith(prefix)) return false
        return isSafeWorkspaceChildName(documentId.substring(prefix.length))
    }

    @ReactMethod
    fun getAIBuilderWorkspaceGrantStatus(promise: Promise) {
        val granted = findAIBuilderWorkspaceGrantUri() != null
        promise.resolve(aiBuilderWorkspaceGrantStatus(granted, if (granted) null else "AIB_WORKSPACE_GRANT_REQUIRED"))
    }

    @ReactMethod
    fun requestAIBuilderWorkspaceGrant(promise: Promise) {
        try {
            if (!hasAIBuilderAllFilesAccess()) {
                promise.reject("AIB_WORKSPACE_ALL_FILES_ACCESS_REQUIRED", "AIB_WORKSPACE_ALL_FILES_ACCESS_REQUIRED", null)
                return
            }
            if (pendingAIBuilderWorkspaceGrantPromise != null) {
                promise.reject("AIB_WORKSPACE_GRANT_BUSY", "AIB_WORKSPACE_GRANT_BUSY", null)
                return
            }
            val activity = reactApplicationContext.currentActivity
            if (activity == null) {
                promise.reject("AIB_WORKSPACE_GRANT_NO_ACTIVITY", "AIB_WORKSPACE_GRANT_NO_ACTIVITY", null)
                return
            }
            pendingAIBuilderWorkspaceGrantPromise = promise
            val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).apply {
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                addFlags(Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    putExtra(
                        DocumentsContract.EXTRA_INITIAL_URI,
                        DocumentsContract.buildDocumentUri(aiBuilderWorkspaceAuthority, aiBuilderWorkspaceTreeDocumentId),
                    )
                }
            }
            activity.startActivityForResult(intent, aiBuilderWorkspaceGrantRequestCode)
        } catch (e: Exception) {
            pendingAIBuilderWorkspaceGrantPromise = null
            promise.reject("AIB_WORKSPACE_GRANT_LAUNCH_FAILED", "AIB_WORKSPACE_GRANT_LAUNCH_FAILED", e)
        }
    }

    @ReactMethod
    fun listAIBuilderWorkspace(promise: Promise) {
        if (!hasAIBuilderAllFilesAccess()) {
            promise.reject("AIB_WORKSPACE_ALL_FILES_ACCESS_REQUIRED", "AIB_WORKSPACE_ALL_FILES_ACCESS_REQUIRED", null)
            return
        }
        val treeUri = findAIBuilderWorkspaceGrantUri()
        if (treeUri == null) {
            promise.reject("AIB_WORKSPACE_GRANT_REQUIRED", "AIB_WORKSPACE_GRANT_REQUIRED", null)
            return
        }
        Thread({
            try {
                val rootDocumentId = workspaceTreeDocumentId(treeUri)
                if (rootDocumentId != aiBuilderWorkspaceTreeDocumentId) {
                    throw SecurityException("AIB_WORKSPACE_ROOT_MISMATCH")
                }
                val childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(treeUri, rootDocumentId)
                val projection = arrayOf(
                    DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                    DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                    DocumentsContract.Document.COLUMN_MIME_TYPE,
                    DocumentsContract.Document.COLUMN_SIZE,
                    DocumentsContract.Document.COLUMN_LAST_MODIFIED,
                )
                val cursor = reactApplicationContext.contentResolver.query(childrenUri, projection, null, null, null)
                    ?: throw IllegalStateException("AIB_WORKSPACE_PROVIDER_QUERY_FAILED")
                val entries = Arguments.createArray()
                var count = 0
                var truncated = false
                cursor.use { rows ->
                    val idColumn = rows.getColumnIndexOrThrow(DocumentsContract.Document.COLUMN_DOCUMENT_ID)
                    val nameColumn = rows.getColumnIndexOrThrow(DocumentsContract.Document.COLUMN_DISPLAY_NAME)
                    val mimeColumn = rows.getColumnIndexOrThrow(DocumentsContract.Document.COLUMN_MIME_TYPE)
                    val sizeColumn = rows.getColumnIndexOrThrow(DocumentsContract.Document.COLUMN_SIZE)
                    val modifiedColumn = rows.getColumnIndexOrThrow(DocumentsContract.Document.COLUMN_LAST_MODIFIED)
                    while (rows.moveToNext()) {
                        if (count >= 200) { truncated = true; break }
                        val documentId = rows.getString(idColumn) ?: throw SecurityException("AIB_WORKSPACE_CHILD_ID_MISSING")
                        val name = rows.getString(nameColumn) ?: throw SecurityException("AIB_WORKSPACE_CHILD_NAME_MISSING")
                        if (!isDirectWorkspaceChildDocumentId(documentId) || !isSafeWorkspaceChildName(name)) {
                            throw SecurityException("AIB_WORKSPACE_CHILD_PATH_REJECTED")
                        }
                        val item = Arguments.createMap()
                        item.putString("name", name)
                        val mimeType = rows.getString(mimeColumn)
                        item.putString("kind", when {
                            mimeType == DocumentsContract.Document.MIME_TYPE_DIR -> "directory"
                            mimeType.isNullOrEmpty() -> "unknown"
                            else -> "file"
                        })
                        val size = if (rows.isNull(sizeColumn)) -1L else rows.getLong(sizeColumn)
                        if (size >= 0 && size <= 9_007_199_254_740_991L) item.putDouble("sizeBytes", size.toDouble())
                        val modified = if (rows.isNull(modifiedColumn)) -1L else rows.getLong(modifiedColumn)
                        if (modified >= 0 && modified <= 9_007_199_254_740_991L) item.putDouble("lastModifiedMs", modified.toDouble())
                        entries.pushMap(item)
                        count += 1
                    }
                }
                val result = Arguments.createMap()
                result.putString("rootPath", "/storage/emulated/0/AIBuilderTermux")
                result.putBoolean("readOnly", true)
                result.putArray("entries", entries)
                result.putBoolean("truncated", truncated)
                promise.resolve(result)
            } catch (e: SecurityException) {
                val reason = e.message?.takeIf { it.matches(Regex("^[A-Z0-9_]{8,80}$")) } ?: "AIB_WORKSPACE_ACCESS_REJECTED"
                promise.reject(reason, reason, e)
            } catch (e: Exception) {
                promise.reject("AIB_WORKSPACE_LIST_FAILED", "AIB_WORKSPACE_LIST_FAILED", e)
            }
        }, "AIB-WorkspaceMetadata").apply { isDaemon = true; start() }
    }

    private val aiBuilderWorkspaceRoot = "/storage/emulated/0/AIBuilderTermux"
    private val aiBuilderWorkspaceMaxBytes = 2 * 1024 * 1024

    private fun validateWorkspaceRelativePath(value: String): List<String> {
        if (value.isEmpty() || value.length > 1024 || value.startsWith("/") || value.indexOf(0.toChar()) >= 0 || value.indexOf(92.toChar()) >= 0)
            throw SecurityException("AIB_WORKSPACE_PATH_REJECTED")
        val parts = value.split("/")
        if (parts.any { it.isEmpty() || it == "." || it == ".." || it.length > 255 }) throw SecurityException("AIB_WORKSPACE_PATH_REJECTED")
        return parts
    }

    /** Public SDK no-follow directory open; caller owns the returned fd. */
    private fun openWorkspaceDirectory(path: String): java.io.FileDescriptor {
        val fd = Os.open(path, OsConstants.O_RDONLY or OsConstants.O_NOFOLLOW or OsConstants.O_NONBLOCK or OsConstants.O_CLOEXEC, 0)
        try {
            if ((Os.fstat(fd).st_mode and OsConstants.S_IFMT) != OsConstants.S_IFDIR) {
                throw SecurityException("AIB_WORKSPACE_NOT_DIRECTORY")
            }
            return fd
        } catch (e: Exception) {
            try { Os.close(fd) } catch (_: Exception) { }
            throw e
        }
    }

    /** Keeps parent directory handles alive; child opens resolve only through /proc/self/fd/<held-fd>. */
    private fun withWorkspaceParent(parts: List<String>, action: (ParcelFileDescriptor, String) -> Unit) {
        if (!hasAIBuilderAllFilesAccess()) throw SecurityException("AIB_WORKSPACE_ALL_FILES_ACCESS_REQUIRED")
        val handles = mutableListOf<ParcelFileDescriptor>()
        try {
            val rootPath = File(aiBuilderWorkspaceRoot)
            if ((Os.lstat(rootPath.path).st_mode and OsConstants.S_IFMT) == OsConstants.S_IFLNK) throw SecurityException("AIB_WORKSPACE_ROOT_SYMLINK")
            val rootFd = openWorkspaceDirectory(rootPath.path)
            var current = (try { ParcelFileDescriptor.dup(rootFd) } finally { Os.close(rootFd) }).also { handles.add(it) }
            for (part in parts.dropLast(1)) {
                val fd = openWorkspaceDirectory("/proc/self/fd/\${current.fd}/$part")
                current = (try { ParcelFileDescriptor.dup(fd) } finally { Os.close(fd) }).also { handles.add(it) }
            }
            action(current, parts.last())
        } finally { handles.asReversed().forEach { try { it.close() } catch (_: Exception) { } } }
    }

    @ReactMethod
    fun getAIBuilderWorkspaceFileCapabilities(promise: Promise) {
        val result = Arguments.createMap()
        val available = try {
            if (!hasAIBuilderAllFilesAccess()) false else {
                val rootFd = openWorkspaceDirectory(aiBuilderWorkspaceRoot)
                val root = try { ParcelFileDescriptor.dup(rootFd) } finally { Os.close(rootFd) }
                try {
                    val probe = openWorkspaceDirectory("/proc/self/fd/\${root.fd}/.")
                    Os.close(probe)
                    true
                } finally { root.close() }
            }
        } catch (_: Exception) { false }
        result.putString("rootPath", aiBuilderWorkspaceRoot)
        result.putString("transport", "procfd-nofollow")
        result.putBoolean("read", available); result.putBoolean("write", available)
        result.putBoolean("nested", true); result.putInt("maxBytes", aiBuilderWorkspaceMaxBytes)
        if (!available) result.putString("reason", "AIB_WORKSPACE_DESCRIPTOR_ACCESS_UNAVAILABLE")
        promise.resolve(result)
    }

    @ReactMethod
    fun readAIBuilderWorkspaceFile(relativePath: String, promise: Promise) {
        Thread({
            try {
                val parts = validateWorkspaceRelativePath(relativePath)
                var payload: ByteArray? = null
                withWorkspaceParent(parts) { parent, name ->
                    val path = "/proc/self/fd/\${parent.fd}/$name"
                    val fd = Os.open(path, OsConstants.O_RDONLY or OsConstants.O_NOFOLLOW or OsConstants.O_NONBLOCK or OsConstants.O_CLOEXEC, 0)
                    val pfd = try { ParcelFileDescriptor.dup(fd) } finally { Os.close(fd) }
                    payload = ParcelFileDescriptor.AutoCloseInputStream(pfd).use { input ->
                        val metadata = Os.fstat(input.fd)
                        if ((metadata.st_mode and OsConstants.S_IFMT) != OsConstants.S_IFREG) throw SecurityException("AIB_WORKSPACE_NOT_REGULAR_FILE")
                        val out = java.io.ByteArrayOutputStream(); val buffer = ByteArray(8192)
                        while (true) { val n = input.read(buffer); if (n < 0) break; if (out.size() + n > aiBuilderWorkspaceMaxBytes) throw IllegalStateException("AIB_WORKSPACE_FILE_TOO_LARGE"); out.write(buffer, 0, n) }
                        out.toByteArray()
                    }
                }
                val bytes = payload ?: throw IllegalStateException("AIB_WORKSPACE_READ_FAILED")
                val decoder = Charsets.UTF_8.newDecoder().onMalformedInput(java.nio.charset.CodingErrorAction.REPORT).onUnmappableCharacter(java.nio.charset.CodingErrorAction.REPORT)
                val text = decoder.decode(java.nio.ByteBuffer.wrap(bytes)).toString()
                val result = Arguments.createMap(); result.putString("rootPath", aiBuilderWorkspaceRoot); result.putString("relativePath", relativePath); result.putString("content", text); result.putInt("byteLength", bytes.size); promise.resolve(result)
            } catch (e: Exception) { promise.reject("AIB_WORKSPACE_FILE_FAILED", e.message ?: "AIB_WORKSPACE_FILE_FAILED", e) }
        }, "AIB-WorkspaceRead").apply { isDaemon = true; start() }
    }

    @ReactMethod
    fun writeAIBuilderWorkspaceFile(relativePath: String, content: String, promise: Promise) {
        if (content.length > aiBuilderWorkspaceMaxBytes || content.indexOf(0.toChar()) >= 0) { promise.reject("AIB_WORKSPACE_CONTENT_INVALID", "AIB_WORKSPACE_CONTENT_INVALID", null); return }
        val bytes = try {
            val encoded = Charsets.UTF_8.newEncoder().onMalformedInput(java.nio.charset.CodingErrorAction.REPORT).onUnmappableCharacter(java.nio.charset.CodingErrorAction.REPORT).encode(java.nio.CharBuffer.wrap(content))
            ByteArray(encoded.remaining()).also { encoded.get(it) }
        } catch (_: Exception) { promise.reject("AIB_WORKSPACE_CONTENT_INVALID", "AIB_WORKSPACE_CONTENT_INVALID", null); return }
        if (bytes.size > aiBuilderWorkspaceMaxBytes) { promise.reject("AIB_WORKSPACE_CONTENT_INVALID", "AIB_WORKSPACE_CONTENT_INVALID", null); return }
        Thread({
            try {
                val parts = validateWorkspaceRelativePath(relativePath)
                withWorkspaceParent(parts) { parent, name ->
                    val target = "/proc/self/fd/\${parent.fd}/$name"
                    try {
                        val old = Os.lstat(target)
                        if ((old.st_mode and OsConstants.S_IFMT) == OsConstants.S_IFLNK) throw SecurityException("AIB_WORKSPACE_SYMLINK_REJECTED")
                        if ((old.st_mode and OsConstants.S_IFMT) != OsConstants.S_IFREG) throw SecurityException("AIB_WORKSPACE_NOT_REGULAR_FILE")
                    } catch (e: android.system.ErrnoException) { if (e.errno != OsConstants.ENOENT) throw e }
                    val tempName = ".aib-\${UUID.randomUUID()}.tmp"
                    val temp = "/proc/self/fd/\${parent.fd}/$tempName"
                    val fd = Os.open(temp, OsConstants.O_WRONLY or OsConstants.O_CREAT or OsConstants.O_EXCL or OsConstants.O_NOFOLLOW or OsConstants.O_CLOEXEC, 384)
                    try {
                        val pfd = try { ParcelFileDescriptor.dup(fd) } finally { Os.close(fd) }
                        ParcelFileDescriptor.AutoCloseOutputStream(pfd).use { it.write(bytes); it.fd.sync() }
                        Os.rename(temp, target)
                    } finally { try { Os.remove(temp) } catch (_: Exception) { } }
                }
                val result = Arguments.createMap(); result.putString("rootPath", aiBuilderWorkspaceRoot); result.putString("relativePath", relativePath); result.putInt("byteLength", bytes.size); result.putBoolean("written", true); promise.resolve(result)
                } catch (e: Exception) { promise.reject("AIB_WORKSPACE_FILE_FAILED", e.message ?: "AIB_WORKSPACE_FILE_FAILED", e) }
        }, "AIB-WorkspaceWrite").apply { isDaemon = true; start() }
    }

    @ReactMethod
    fun exportModelToDirectory(
        llmUri: String,
        llmName: String,
        mmprojUri: String,
        mmprojName: String,
        promise: Promise
    ) {
        try {
            if (pendingModelExportPromise != null) {
                promise.reject("MODEL_EXPORT_BUSY", "Экспорт модели уже выполняется")
                return
            }
            val activity = reactApplicationContext.currentActivity
            if (activity == null) {
                promise.reject("MODEL_EXPORT_NO_ACTIVITY", "Не удалось открыть системный выбор папки")
                return
            }
            pendingModelExportPromise = promise
            pendingModelExportFiles = arrayOf(llmUri, mmprojUri)
            pendingModelExportNames = arrayOf(llmName, mmprojName)
            val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).apply {
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
                addFlags(Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
            }
            activity.startActivityForResult(intent, modelExportRequestCode)
        } catch (e: Exception) {
            pendingModelExportPromise = null
            pendingModelExportFiles = null
            pendingModelExportNames = null
            promise.reject("MODEL_EXPORT_LAUNCH_FAILED", e.message ?: e.toString(), e)
        }
    }

    @ReactMethod
    fun cancelAllCommands(promise: Promise) {
        try {
            val embeddedIds = AibEmbeddedProcessRegistry.pending.toList()
            embeddedIds.forEach { AibEmbeddedProcessRegistry.cancelRequested.add(it) }
            val active = embeddedIds.mapNotNull { id ->
                val process = AibEmbeddedProcessRegistry.active[id] ?: return@mapNotNull null
                val root = AibEmbeddedProcessRegistry.rootPids[id] ?: return@mapNotNull null
                if (aibProcStartTicks(root.pid) != root.startTicks) return@mapNotNull null
                val tracked = AibEmbeddedProcessRegistry.descendants[id] ?: return@mapNotNull null
                Triple(process, root, tracked)
            }
            if (active.isNotEmpty()) Thread({
                active.forEach { (process, root, tracked) ->
                    try { stopAibEmbeddedProcess(process, root, tracked) } catch (_: Throwable) { }
                }
            }, "AIB-EmbeddedCancelAll").apply { isDaemon = true; start() }
            val legacyCount = TermuxResultStore.cancelAll()
            val n = legacyCount + embeddedIds.size
            nativeLog("cancel-all", "info", "cancelled waiters=" + legacyCount + " embedded=" + embeddedIds.size)
            promise.resolve(n)
        } catch (e: Exception) {
            promise.reject("TERMUX_CANCEL_FAILED", e.message, e)
        }
    }

    /** Legacy JS API retained, but always executes in this app's bundled private runtime. */
    @ReactMethod
    fun runCommand(command: String, workdir: String?, timeoutMs: Double, backendLabel: String?, clientCommandId: String?, promise: Promise) {
        val requestId = clientCommandId?.takeIf { it.matches("^[A-Za-z0-9._-]{1,96}$".toRegex()) }
            ?: UUID.randomUUID().toString()
        runEmbeddedTermuxCommand(command, workdir, timeoutMs, requestId, promise)
    }


}
`;
}


function embeddedTerminalViewKotlin(pkg) {
  return `package ${pkg}

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.widget.FrameLayout
import android.widget.TextView
import com.facebook.react.uimanager.SimpleViewManager
import com.facebook.react.uimanager.ThemedReactContext
import com.facebook.react.uimanager.annotations.ReactProp
import com.termux.terminal.TerminalSession
import com.termux.terminal.TerminalSessionClient
import com.termux.view.TerminalView
import com.termux.view.TerminalViewClient
import org.json.JSONObject
import android.os.Build
import android.os.Environment
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.inputmethod.InputMethodManager

/**
 * Process-local PTY registry. Session IDs are supplied by AI Builder, never used as
 * paths or shell text. Detached sessions survive view remounts; the registry is
 * bounded to avoid unbounded background shell growth.
 */
private class AibEmbeddedSessionRecord(val key: String) {
    lateinit var session: TerminalSession
    var attachedTerminal: TerminalView? = null
    var workingDirectory: String = ""
    var projectRoot: String = ""
    var lastUsedAt: Long = android.os.SystemClock.elapsedRealtime()
}

/**
 * Native Termux TerminalView host. A PTY is created only after the bundled private
 * bootstrap is installed and the React prop explicitly enables the session. It
 * never downloads a bootstrap or falls back to the external Termux app.
 */
class AibEmbeddedTerminalView(context: Context) : FrameLayout(context) {
    companion object {
        private const val MAX_RETAINED_SESSIONS = 8
        private val sessionLock = Any()
        private val sessions = LinkedHashMap<String, AibEmbeddedSessionRecord>()
    }
    private val terminal = TerminalView(context, null)
    private val status = TextView(context)
    private var attachedRecord: AibEmbeddedSessionRecord? = null
    private var requestedSessionId: String = ""
    private var requestedFontSize: Int = 14
    private var requestedEnabled: Boolean = false
    private var requestedLanguage: String = "en"
    private var requestedWorkingDirectory: String? = null
    private var requestedProjectRoot: String? = null
    private var installRequested: Boolean = false
    private val reconcileTask = Runnable { reconcileSession() }

    private fun localized(ru: String, uk: String, en: String): String = when (requestedLanguage) {
        "ru" -> ru
        "uk" -> uk
        else -> en
    }

    init {
        setBackgroundColor(Color.BLACK)
        terminal.setTerminalViewClient(createViewClient())
        terminal.setTextSize(requestedFontSize)
        terminal.isFocusable = true
        terminal.isFocusableInTouchMode = true
        this.descendantFocusability = android.view.ViewGroup.FOCUS_AFTER_DESCENDANTS
        addView(terminal, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
        status.setTextColor(Color.LTGRAY)
        status.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
        status.typeface = Typeface.MONOSPACE
        status.gravity = Gravity.CENTER
        status.setPadding(24, 24, 24, 24)
        status.text = localized("Встроенная среда Termux будет установлена при первом запуске", "Вбудоване середовище Termux буде встановлено під час першого запуску", "The private Termux environment will be installed on first launch")
        addView(status, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
        terminal.visibility = View.GONE
    }

    fun setEnabledSession(enabled: Boolean) {
        requestedEnabled = enabled
        scheduleReconcileSession()
    }

    fun setLanguage(language: String?) {
        requestedLanguage = if (language == "ru" || language == "uk") language else "en"
        scheduleReconcileSession()
    }

    fun setSessionKey(id: String?) {
        val next = id?.takeIf { it.matches(Regex("^[A-Za-z0-9._-]{1,96}$")) } ?: ""
        if (requestedSessionId == next) return
        detachSessionView()
        requestedSessionId = next
        scheduleReconcileSession()
    }

    fun setWorkingDirectory(path: String?) {
        val next = path?.takeIf { it.isNotBlank() }
        if (requestedWorkingDirectory == next) return
        detachSessionView()
        requestedWorkingDirectory = next
        scheduleReconcileSession()
    }

    fun setProjectRoot(path: String?) {
        val next = path?.takeIf { it.isNotBlank() }
        if (requestedProjectRoot == next) return
        detachSessionView()
        requestedProjectRoot = next
        scheduleReconcileSession()
    }

    private fun scheduleReconcileSession() {
        removeCallbacks(reconcileTask)
        post(reconcileTask)
    }

    private fun terminalHasAllFilesAccess(): Boolean =
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && Environment.isExternalStorageManager()

    private fun resolveAllowedDirectory(home: java.io.File, requestedText: String): java.io.File {
        val homePath = home.canonicalPath
        val rawCwd = java.io.File(requestedText).absoluteFile
        val sharedRoot = "/storage/emulated/0/AIBuilderTermux"
        val privateAliasRoot = homePath.replaceFirst("/data/user/0/", "/data/data/")
        val lexicalPath = rawCwd.path.trimEnd(java.io.File.separatorChar).ifEmpty { java.io.File.separator }
        val lexicalHomeRoot = listOf(homePath, privateAliasRoot).firstOrNull { lexicalPath == it || lexicalPath.startsWith(it + java.io.File.separator) }
        val lexicalSharedRoot = sharedRoot.takeIf { lexicalPath == it || lexicalPath.startsWith(it + java.io.File.separator) }
        if (lexicalHomeRoot == null && lexicalSharedRoot == null) throw SecurityException("cwd_scope_violation")
        if (lexicalHomeRoot == null && !terminalHasAllFilesAccess()) throw SecurityException("cwd_all_files_access_required")
        val selectedLexicalRoot = lexicalHomeRoot ?: lexicalSharedRoot!!
        val trustedRoot = if (lexicalHomeRoot != null) java.io.File(homePath) else java.io.File(sharedRoot)
        fun lstat(path: String, root: Boolean): android.system.StructStat = try {
            android.system.Os.lstat(path)
        } catch (error: android.system.ErrnoException) {
            if (error.errno == android.system.OsConstants.ENOENT) throw SecurityException(if (root) "cwd_workspace_root_missing" else "cwd_directory_missing")
            throw error
        }
        if ((lstat(trustedRoot.path, true).st_mode and android.system.OsConstants.S_IFMT) == android.system.OsConstants.S_IFLNK) throw SecurityException("cwd_root_symlink_rejected")
        val canonicalRoot = trustedRoot.canonicalFile
        if (!canonicalRoot.isDirectory) throw SecurityException("cwd_workspace_root_missing")
        val suffix = if (lexicalPath == selectedLexicalRoot) "" else lexicalPath.removePrefix(selectedLexicalRoot).trimStart(java.io.File.separatorChar)
        val parts = if (suffix.isEmpty()) emptyList() else suffix.split(java.io.File.separatorChar)
        if (parts.any { it.isEmpty() || it == "." || it == ".." }) throw SecurityException("cwd_scope_violation")
        var component = canonicalRoot
        if ((lstat(component.absolutePath, true).st_mode and android.system.OsConstants.S_IFMT) == android.system.OsConstants.S_IFLNK) throw SecurityException("cwd_symlink_rejected")
        for (part in parts) {
            component = java.io.File(component, part)
            if ((lstat(component.absolutePath, false).st_mode and android.system.OsConstants.S_IFMT) == android.system.OsConstants.S_IFLNK) throw SecurityException("cwd_symlink_rejected")
        }
        if ((lstat(component.absolutePath, false).st_mode and android.system.OsConstants.S_IFMT) != android.system.OsConstants.S_IFDIR) throw SecurityException("cwd_not_directory")
        val cwdPath = component.canonicalPath
        val inPrivateHome = cwdPath == homePath || cwdPath.startsWith(homePath + java.io.File.separator)
        val canonicalSharedRoot = java.io.File(sharedRoot).canonicalPath
        val inSharedWorkspaceRoot = cwdPath == canonicalSharedRoot || cwdPath.startsWith(canonicalSharedRoot + java.io.File.separator)
        if (!inPrivateHome && !inSharedWorkspaceRoot) throw SecurityException("cwd_scope_violation")
        if (!inPrivateHome && !terminalHasAllFilesAccess()) throw SecurityException("cwd_all_files_access_required")
        return java.io.File(cwdPath)
    }

    fun setFontSize(size: Int) {
        requestedFontSize = size.coerceIn(8, 32)
        terminal.setTextSize(requestedFontSize)
    }

    private fun reconcileSession() {
        if (!requestedEnabled || requestedSessionId.isBlank()) {
            detachSessionView()
            status.text = localized("Терминальная сессия отключена", "Термінальну сесію вимкнено", "Terminal session is disabled")
            status.visibility = View.VISIBLE
            terminal.visibility = View.GONE
            return
        }
        if (requestedWorkingDirectory.isNullOrBlank()) {
            detachSessionView()
            status.text = localized("Ожидается проверенный путь проекта", "Очікується перевірений шлях проєкту", "Waiting for a validated project directory")
            status.visibility = View.VISIBLE
            terminal.visibility = View.GONE
            return
        }
        val canonicalFiles = try { context.filesDir.canonicalFile } catch (_: Throwable) { null }
        val files = canonicalFiles ?: context.filesDir
        val prefix = java.io.File(files, "usr")
        val home = java.io.File(files, "home")
        val shell = java.io.File(prefix, "bin/bash")
        val bootstrapManifest = java.io.File(context.filesDir, "termux-bootstrap.json")
        val privateLayoutCanonical = try {
            canonicalFiles != null && prefix.canonicalFile.path == prefix.absolutePath &&
                home.canonicalFile.path == home.absolutePath
        } catch (_: Throwable) { false }
        val manifest = try {
            if (bootstrapManifest.isFile) JSONObject(bootstrapManifest.readText(Charsets.UTF_8)) else null
        } catch (_: Throwable) { null }
        val currentAbi = Build.SUPPORTED_ABIS.firstOrNull().orEmpty()
        val manifestMatchesApp = manifest?.optString("applicationId") == context.packageName
        val manifestMatchesAbi = manifest?.optString("androidAbi") == currentAbi
        val manifestComplete = manifest?.optString("installState") == "complete"
        val manifestVersionValid = manifest?.optString("bootstrapVersion")?.matches(Regex("^[A-Za-z0-9._-]{1,80}$")) == true
        val manifestDigestValid = manifest?.optString("archiveSha256") == AibEmbeddedTermuxBootstrapInstaller.EXPECTED_ARCHIVE_SHA256
        val manifestSchemaValid = manifest?.optInt("schemaVersion", 0) == 1
        val manifestArchitectureValid = manifest?.optString("architecture") == "aarch64"
        val manifestSourceCommitValid = manifest?.optString("sourceCommit")?.matches(Regex("^[a-fA-F0-9]{40}$")) == true
        val manifestSecondStageValid = manifest?.optBoolean("secondStageCompleted", false) == true
        val manifestPathsMatch = manifest != null && manifest.optString("prefixRelativePath") == "usr" && manifest.optString("homeRelativePath") == "home"
        if (!manifestMatchesApp || !manifestMatchesAbi || !manifestComplete || !manifestVersionValid || !manifestDigestValid || !manifestSchemaValid ||
            !manifestArchitectureValid || !manifestSourceCommitValid || !manifestSecondStageValid || !manifestPathsMatch || !privateLayoutCanonical ||
            !prefix.isDirectory || !home.isDirectory || !shell.isFile || !shell.canExecute()) {
            detachSessionView()
            terminal.visibility = View.GONE
            if (context.packageName != "com.karat.aibuilder" || currentAbi != "arm64-v8a") {
                status.text = localized("Для встроенного Termux требуется приложение com.karat.aibuilder и ABI arm64-v8a", "Для вбудованого Termux потрібні застосунок com.karat.aibuilder та ABI arm64-v8a", "Embedded Termux requires com.karat.aibuilder running with the arm64-v8a ABI")
                status.visibility = View.VISIBLE
                return
            }
            if (installRequested) {
                status.text = localized("Устанавливается приватная среда Linux…", "Встановлюється приватне середовище Linux…", "Installing the private Linux environment…")
                status.visibility = View.VISIBLE
                return
            }
            installRequested = true
            status.text = localized("Подготовка приватной среды Linux… Первый запуск может занять несколько минут.", "Підготовка приватного середовища Linux… Перший запуск може тривати кілька хвилин.", "Preparing the private Linux environment… First launch may take several minutes.")
            status.visibility = View.VISIBLE
            AibEmbeddedTermuxBootstrapInstaller.installIfNeeded(context) { outcome ->
                installRequested = false
                if (!requestedEnabled) return@installIfNeeded
                if (outcome.ready) {
                    status.text = localized("Приватная среда готова", "Приватне середовище готове", "Private environment ready")
                    reconcileSession()
                } else {
                    val message = when (outcome.status) {
                        "existing_prefix_unmanaged" -> localized("Найден существующий каталог usr без подтверждённого манифеста; он оставлен без изменений.", "Знайдено наявний каталог usr без підтвердженого маніфесту; його не змінено.", "An existing usr directory has no trusted manifest and was left unchanged.")
                        "unsupported_abi" -> localized("Встроенная среда доступна только для arm64-v8a.", "Вбудоване середовище доступне лише для arm64-v8a.", "The embedded environment is available only for arm64-v8a.")
                        "insufficient_private_storage" -> localized("Недостаточно места во внутреннем хранилище для установки среды.", "Недостатньо місця у внутрішньому сховищі для встановлення середовища.", "There is not enough internal storage to install the private environment.")
                        else -> localized("Не удалось подготовить приватную среду. Повторите попытку, выключив и снова включив встроенный режим.", "Не вдалося підготувати приватне середовище. Спробуйте ще раз, вимкнувши та знову ввімкнувши вбудований режим.", "Could not prepare the private environment. Retry by turning embedded mode off and on again.")
                    }
                    status.text = message + " [" + outcome.status.take(80) + "]"
                    status.visibility = View.VISIBLE
                }
            }
            return
        }
        try {
            val requestedCwd = requestedWorkingDirectory ?: throw SecurityException("cwd_scope_violation")
            val workingDirectory = resolveAllowedDirectory(home, requestedCwd)
            val requestedRoot = requestedProjectRoot?.takeIf { it.isNotBlank() } ?: requestedCwd
            val projectRoot = resolveAllowedDirectory(home, requestedRoot)
            val cwdPath = workingDirectory.canonicalPath
            val projectRootPath = projectRoot.canonicalPath
            if (cwdPath != projectRootPath && !cwdPath.startsWith(projectRootPath + java.io.File.separator)) {
                throw SecurityException("cwd_project_root_scope_violation")
            }
            val tempDir = java.io.File(context.cacheDir, "termux-tmp")
            tempDir.mkdirs()
            val environment = AibEmbeddedTermuxBootstrapInstaller.executionEnvironment(context, prefix, home, tempDir).toMutableMap()
            environment["PWD"] = cwdPath
            environment["PROJECT_ROOT"] = projectRootPath
            environment["AI_BUILDER_PROJECT"] = projectRootPath
            val env = environment.map { (key, value) -> key + "=" + value }.toTypedArray()
            val launch = AibEmbeddedTermuxBootstrapInstaller.shellCommand(prefix, "-l")
            val record = synchronized(sessionLock) {
                val existing = sessions[requestedSessionId]
                if (existing != null && existing.workingDirectory == cwdPath && existing.projectRoot == projectRootPath) {
                    existing.lastUsedAt = android.os.SystemClock.elapsedRealtime()
                    existing
                } else {
                    if (existing != null) {
                        sessions.remove(requestedSessionId)
                        try { existing.session.finishIfRunning() } catch (_: Throwable) { }
                    }
                    val fresh = AibEmbeddedSessionRecord(requestedSessionId)
                    fresh.workingDirectory = cwdPath
                    fresh.projectRoot = projectRootPath
                    val client = createSessionClient(fresh)
                    fresh.session = TerminalSession(launch.first(), cwdPath, launch.toTypedArray(), env, 2000, client)
                    sessions[requestedSessionId] = fresh
                    trimSessionRegistryLocked()
                    fresh
                }
            }
            // A stable session ID can be rendered by only one TerminalView at a time.
            // Explicitly detach a previous host before transferring the live PTY.
            val previousTerminal = record.attachedTerminal
            if (previousTerminal != null && previousTerminal !== terminal) {
                previousTerminal.post { previousTerminal.attachSession(null) }
            }
            attachedRecord = record
            record.attachedTerminal = terminal
            record.lastUsedAt = android.os.SystemClock.elapsedRealtime()
            terminal.attachSession(record.session)
            terminal.visibility = View.VISIBLE
            status.visibility = View.GONE
            terminal.requestFocus()
        } catch (error: Throwable) {
            detachSessionView()
            status.text = localized("Не удалось запустить встроенный shell: ", "Не вдалося запустити вбудовану оболонку: ", "Could not start the embedded shell: ") + (error.javaClass.simpleName ?: "error")
            status.visibility = View.VISIBLE
            terminal.visibility = View.GONE
        }
    }

    private fun createSessionClient(record: AibEmbeddedSessionRecord): TerminalSessionClient = object : TerminalSessionClient {
        private fun invalidateAttachedTerminal() {
            val attached = record.attachedTerminal ?: return
            attached.post { record.attachedTerminal?.invalidate() }
        }
        override fun onTextChanged(changedSession: TerminalSession) { invalidateAttachedTerminal() }
        override fun onTitleChanged(changedSession: TerminalSession) { }
        override fun onSessionFinished(finishedSession: TerminalSession) {
            invalidateAttachedTerminal()
            synchronized(sessionLock) {
                if (sessions[record.key] === record) sessions.remove(record.key)
            }
        }
        override fun onCopyTextToClipboard(session: TerminalSession, text: String) {
            val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            clipboard.setPrimaryClip(ClipData.newPlainText("terminal", text))
        }
        override fun onPasteTextFromClipboard(session: TerminalSession) {
            val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            val text = clipboard.primaryClip?.getItemAt(0)?.coerceToText(context)?.toString() ?: return
            val bytes = text.toByteArray(Charsets.UTF_8)
            session.write(bytes, 0, bytes.size)
        }
        override fun onBell(session: TerminalSession) { }
        override fun onColorsChanged(session: TerminalSession) { invalidateAttachedTerminal() }
        override fun onTerminalCursorStateChange(state: Boolean) { invalidateAttachedTerminal() }
        override fun getTerminalCursorStyle(): Int = 0
        override fun logError(tag: String, message: String) { android.util.Log.e("AIB-Terminal", tag + ": " + message.take(256)) }
        override fun logWarn(tag: String, message: String) { android.util.Log.w("AIB-Terminal", tag + ": " + message.take(256)) }
        override fun logInfo(tag: String, message: String) { android.util.Log.i("AIB-Terminal", tag + ": " + message.take(256)) }
        override fun logDebug(tag: String, message: String) { }
        override fun logVerbose(tag: String, message: String) { }
        override fun logStackTraceWithMessage(tag: String, message: String, e: Exception) { android.util.Log.e("AIB-Terminal", tag + ": " + message.take(256), e) }
        override fun logStackTrace(tag: String, e: Exception) { android.util.Log.e("AIB-Terminal", tag, e) }
    }

    private fun createViewClient(): TerminalViewClient = object : TerminalViewClient {
        override fun onScale(scale: Float): Float = scale
        override fun onSingleTapUp(e: MotionEvent) {
            terminal.requestFocus()
            // TerminalView is an Editor/IME target. Explicitly request the soft keyboard
            // on tap; otherwise a native view embedded in React Native can take focus
            // without actually opening the keyboard on some Android/IME combinations.
            terminal.post {
                val imm = context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager
                imm?.showSoftInput(terminal, InputMethodManager.SHOW_IMPLICIT)
            }
        }
        override fun shouldBackButtonBeMappedToEscape() = false
        override fun shouldEnforceCharBasedInput() = true
        override fun shouldUseCtrlSpaceWorkaround() = false
        override fun isTerminalViewSelected() = true
        override fun copyModeChanged(copyMode: Boolean) { }
        override fun onKeyDown(keyCode: Int, e: KeyEvent, session: TerminalSession) = false
        override fun onKeyUp(keyCode: Int, e: KeyEvent) = false
        override fun onLongPress(event: MotionEvent) = false
        override fun readControlKey() = false
        override fun readAltKey() = false
        override fun readShiftKey() = false
        override fun readFnKey() = false
        override fun onCodePoint(codePoint: Int, ctrlDown: Boolean, session: TerminalSession) = false
        override fun onEmulatorSet() { }
        override fun logError(tag: String, message: String) { android.util.Log.e("AIB-TerminalView", tag + ": " + message.take(256)) }
        override fun logWarn(tag: String, message: String) { android.util.Log.w("AIB-TerminalView", tag + ": " + message.take(256)) }
        override fun logInfo(tag: String, message: String) { }
        override fun logDebug(tag: String, message: String) { }
        override fun logVerbose(tag: String, message: String) { }
        override fun logStackTraceWithMessage(tag: String, message: String, e: Exception) { android.util.Log.e("AIB-TerminalView", message.take(256), e) }
        override fun logStackTrace(tag: String, e: Exception) { android.util.Log.e("AIB-TerminalView", tag, e) }
    }

    fun dispose() { requestedEnabled = false; removeCallbacks(reconcileTask); detachSessionView() }

    private fun detachSessionView() {
        val old = attachedRecord
        attachedRecord = null
        if (old != null && old.attachedTerminal === terminal) old.attachedTerminal = null
        terminal.attachSession(null)
    }

    private fun trimSessionRegistryLocked() {
        while (sessions.size > MAX_RETAINED_SESSIONS) {
            val removable = sessions.values
                .filter { it.attachedTerminal == null && it.key != requestedSessionId }
                .minByOrNull { it.lastUsedAt } ?: return
            sessions.remove(removable.key)
            try { removable.session.finishIfRunning() } catch (_: Throwable) { }
        }
    }
}

class TermuxEmbeddedTerminalViewManager(context: android.content.Context) : SimpleViewManager<AibEmbeddedTerminalView>() {
    private val appContext = context
    override fun getName() = "AibEmbeddedTermuxTerminalView"
    override fun createViewInstance(reactContext: ThemedReactContext) = AibEmbeddedTerminalView(reactContext)
    @ReactProp(name = "enabled", defaultBoolean = false)
    fun setEnabled(view: AibEmbeddedTerminalView, enabled: Boolean) = view.setEnabledSession(enabled)
    @ReactProp(name = "sessionId")
    fun setSessionId(view: AibEmbeddedTerminalView, id: String?) = view.setSessionKey(id)
    @ReactProp(name = "workingDirectory")
    fun setWorkingDirectory(view: AibEmbeddedTerminalView, path: String?) = view.setWorkingDirectory(path)
    @ReactProp(name = "projectRoot")
    fun setProjectRoot(view: AibEmbeddedTerminalView, path: String?) = view.setProjectRoot(path)
    @ReactProp(name = "fontSize", defaultInt = 14)
    fun setFontSize(view: AibEmbeddedTerminalView, size: Int) = view.setFontSize(size)
    @ReactProp(name = "language")
    fun setLanguage(view: AibEmbeddedTerminalView, language: String?) = view.setLanguage(language)
    override fun onDropViewInstance(view: AibEmbeddedTerminalView) { view.dispose(); super.onDropViewInstance(view) }
}
`;
}

function packageKotlin(pkg) {
  return `package ${pkg}

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

class TermuxBridgePackage : ReactPackage {
    override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> {
        return listOf(TermuxBridgeModule(reactContext))
    }

    override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> {
        return listOf(TermuxEmbeddedTerminalViewManager(reactContext))
    }
}
`;
}

function sha256FileSync(filePath) {
  const hash = crypto.createHash("sha256");
  const buffer = Buffer.alloc(1024 * 1024);
  const fd = fs.openSync(filePath, "r");
  try {
    let bytesRead = 0;
    do {
      bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

function loadBootstrapArtifact(projectRoot, pkg) {
  if (pkg !== "com.karat.aibuilder") {
    throw new Error("[withTermuxBridge] The private bootstrap is pinned to applicationId com.karat.aibuilder.");
  }
  const root = fs.realpathSync(projectRoot);
  const sourceDirectory = path.join(projectRoot, "assets", "termux-bootstrap");
  const archiveName = "termux-bootstrap-aarch64.zip";
  const fileNames = [archiveName, `${archiveName}.sha256`, `${archiveName}.provenance.json`];
  for (const fileName of fileNames) {
    const filePath = path.join(sourceDirectory, fileName);
    const stat = fs.lstatSync(filePath);
    const realPath = fs.realpathSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || !realPath.startsWith(root + path.sep)) {
      throw new Error(`[withTermuxBridge] Bootstrap asset is not a regular project file: ${fileName}`);
    }
  }

  const archivePath = path.join(sourceDirectory, archiveName);
  const archiveSize = fs.statSync(archivePath).size;
  if (archiveSize <= 0 || archiveSize > 1_000_000_000) {
    throw new Error(`[withTermuxBridge] Implausible custom bootstrap archive size: ${archiveSize}`);
  }
  const archiveSha256 = sha256FileSync(archivePath);
  const sidecar = fs.readFileSync(`${archivePath}.sha256`, "utf8").trim().split(/\s+/)[0].toLowerCase();
  let provenance;
  try {
    provenance = JSON.parse(fs.readFileSync(`${archivePath}.provenance.json`, "utf8"));
  } catch (error) {
    throw new Error(`[withTermuxBridge] Bootstrap provenance JSON is invalid: ${error.message}`);
  }
  if (sidecar !== archiveSha256 || provenance.schemaVersion !== 1 ||
      provenance.applicationId !== pkg || provenance.architecture !== "aarch64" ||
      provenance.archiveFile !== archiveName || provenance.archiveSha256 !== archiveSha256 ||
      provenance.archiveStructureVerified !== true ||
      !/^[a-f0-9]{40}$/.test(provenance.sourceCommit || "") ||
      !/^[A-Za-z0-9._-]{1,80}$/.test(provenance.bootstrapVersion || "")) {
    throw new Error("[withTermuxBridge] Bootstrap hash, identity, architecture, or provenance validation failed.");
  }
  return {
    sourceDirectory,
    archiveSha256,
    sourceCommit: provenance.sourceCommit,
    bootstrapVersion: provenance.bootstrapVersion,
  };
}

function withTermuxBridgeFiles(config) {
  return withDangerousMod(config, [
    "android",
    async (config) => {
      const pkg = config.android?.package || "com.karat.aibuilder";
      const bootstrap = loadBootstrapArtifact(config.modRequest.projectRoot, pkg);
      const pkgPath = pkg.replace(/\./g, "/");
      const dir = path.join(
        config.modRequest.platformProjectRoot,
        "app/src/main/java",
        pkgPath
      );
      fs.mkdirSync(dir, { recursive: true });

      fs.writeFileSync(path.join(dir, "TermuxBridgeModule.kt"), moduleKotlin(pkg), "utf8");
      fs.writeFileSync(path.join(dir, "TermuxBridgePackage.kt"), packageKotlin(pkg), "utf8");
      fs.writeFileSync(path.join(dir, "TermuxEmbeddedTerminalViewManager.kt"), embeddedTerminalViewKotlin(pkg), "utf8");
      fs.writeFileSync(path.join(dir, "AibEmbeddedTermuxBootstrapInstaller.kt"), bootstrapInstallerKotlin(pkg, bootstrap), "utf8");
      fs.writeFileSync(path.join(dir, "AibCandidateFullFeed.kt"), candidateFullKotlin(pkg, config.modRequest.projectRoot), "utf8");
      stageFullCandidateAssets(config.modRequest.projectRoot, path.join(config.modRequest.platformProjectRoot, "app/src/main/assets"));
      fs.writeFileSync(path.join(dir, "AibCandidateFeedProbe.kt"), candidateProbeKotlin(pkg), "utf8");
      stageCandidateProbeAssets(config.modRequest.projectRoot, path.join(config.modRequest.platformProjectRoot, "app/src/main/assets"));

      const bootstrapAssets = path.join(config.modRequest.platformProjectRoot, "app/src/main/assets/termux");
      fs.mkdirSync(bootstrapAssets, { recursive: true });
      for (const fileName of [
        "termux-bootstrap-aarch64.zip",
        "termux-bootstrap-aarch64.zip.sha256",
        "termux-bootstrap-aarch64.zip.provenance.json",
      ]) {
        fs.copyFileSync(path.join(bootstrap.sourceDirectory, fileName), path.join(bootstrapAssets, fileName));
      }

      const resXml = path.join(config.modRequest.platformProjectRoot, "app/src/main/res/xml");
      fs.mkdirSync(resXml, { recursive: true });
      fs.writeFileSync(
        path.join(resXml, "aib_file_paths.xml"),
        '<?xml version="1.0" encoding="utf-8"?>\n' +
        '<paths xmlns:android="http://schemas.android.com/apk/res/android">\n' +
        '  <cache-path name="apk_cache" path="." />\n' +
        '  <files-path name="apk_files" path="." />\n' +
        '  <external-cache-path name="apk_ext_cache" path="." />\n' +
        '</paths>\n',
        "utf8"
      );

      return config;
    },
  ]);
}

function withTermuxBridgeManifest(config) {
  return withAndroidManifest(config, (config) => {
    const manifest = config.modResults.manifest;

    // Разрешение на выполнение команд в Termux — отдельное "опасное"
    // разрешение, которое Termux:API проверяет у вызывающего приложения.
    if (!Array.isArray(manifest["uses-permission"])) manifest["uses-permission"] = [];
    const permNames = manifest["uses-permission"].map((p) => p?.$?.["android:name"]);
    const addPermission = (name) => {
      if (!permNames.includes(name)) {
        manifest["uses-permission"].push({ $: { "android:name": name } });
        permNames.push(name);
      }
    };
    // Android 8+: the system APK installer requires the user to explicitly
    // allow this app to install unknown applications. We only request the
    // capability here; the actual permission is enabled in system settings
    // immediately before an APK installation.
    addPermission("android.permission.REQUEST_INSTALL_PACKAGES");

    // Android 11+ package visibility. ВАЖНО: только ДОПОЛНЯЕМ queries,
    // не затираем блоки expo-speech-recognition и других плагинов.
    if (!manifest.queries) manifest.queries = [{}];
    const queries = manifest.queries[0];
    if (!Array.isArray(queries.package)) queries.package = [];
    const needPackages = [
      "moe.shizuku.privileged.api",
      // Speech / микрофон в чате (иначе isRecognitionAvailable=false на Android 11+)
      "com.google.android.googlequicksearchbox",
      "com.google.android.as",
      "com.google.android.tts",
      "com.samsung.android.bixby.agent",
    ];
    for (const name of needPackages) {
      const has = queries.package.some((p) => p?.$?.["android:name"] === name);
      if (!has) queries.package.push({ $: { "android:name": name } });
    }
    if (!Array.isArray(queries.intent)) queries.intent = [];
    const hasApkView = queries.intent.some(
      (i) =>
        Array.isArray(i.action) &&
        i.action.some((a) => a?.$?.["android:name"] === "android.intent.action.VIEW") &&
        Array.isArray(i.data) &&
        i.data.some((d) => d?.$?.["android:mimeType"] === "application/vnd.android.package-archive")
    );
    if (!hasApkView) {
      queries.intent.push({
        action: [{ $: { "android:name": "android.intent.action.VIEW" } }],
        data: [{ $: { "android:mimeType": "application/vnd.android.package-archive" } }],
      });
    }
    // RecognitionService — системное STT (Google / on-device)
    const hasSpeechIntent = queries.intent.some(
      (i) =>
        Array.isArray(i.action) &&
        i.action.some((a) => a?.$?.["android:name"] === "android.speech.RecognitionService")
    );
    if (!hasSpeechIntent) {
      queries.intent.push({
        action: [{ $: { "android:name": "android.speech.RecognitionService" } }],
      });
    }

    // The application node is also used for the private result receiver and
    // FileProvider below. Initialize it BEFORE either access; keeping this
    // declaration above those blocks avoids a JavaScript TDZ failure during
    // Expo prebuild, which could otherwise leave the generated native bridge
    // out of the APK or abort config evaluation.
    if (!Array.isArray(manifest.application)) manifest.application = [{}];
    const application = manifest.application[0];

    // Keep the receiver private to this app; no external broadcast surface.
    if (!Array.isArray(application.receiver)) application.receiver = [];
    const receiverName = `${config.android?.package || "com.karat.aibuilder"}.TermuxResultReceiver`;
    const hasReceiver = application.receiver.some((r) => r?.$?.["android:name"] === receiverName || r?.$?.["android:name"] === ".TermuxResultReceiver");
    if (!hasReceiver) {
      application.receiver.push({
        $: {
          "android:name": ".TermuxResultReceiver",
          "android:exported": "false"
        }
      });
    }

    // Secure APK installation through Android's package installer. The APK
    // stays in the app cache and is exposed through FileProvider on Android 7+.
    if (!Array.isArray(application.provider)) application.provider = [];
    const authority = `${config.android?.package || "com.karat.aibuilder"}.fileprovider`;
    const hasProvider = application.provider.some((p) => p?.$?.["android:authorities"] === authority);
    if (!hasProvider) {
      application.provider.push({
        $: {
          "android:name": "androidx.core.content.FileProvider",
          "android:authorities": authority,
          "android:exported": "false",
          "android:grantUriPermissions": "true"
        },
        "meta-data": [{
          $: {
            "android:name": "android.support.FILE_PROVIDER_PATHS",
            "android:resource": "@xml/aib_file_paths"
          }
        }]
      });
    }

    return config;
  });
}

function withTermuxBridgeMainApplication(config) {
  return withMainApplication(config, (config) => {
    let contents = config.modResults.contents;
    const registrationSource = contents
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/^\s*\/\/.*$/gm, " ")
      .replace(/(\s)\/\/.*$/gm, "$1");
    if (/\badd\s*\(\s*(?:new\s+)?TermuxBridgePackage\s*\(\s*\)\s*\)/.test(registrationSource)) return config;

    const isKotlin = config.modResults.language === "kt";
    let matched = false;

    if (isKotlin) {
      const applyPattern = /PackageList\s*\(\s*this\s*\)\s*\.packages(?:\s*\.toMutableList\s*\(\s*\))?\s*\.apply\s*\{/;
      const packagesAssignment = /\bval\s+packages\s*=\s*PackageList\s*\(\s*this\s*\)\s*\.packages(?:\s*\.toMutableList\s*\(\s*\))?/;
      const packagesReturn = /\breturn\s+PackageList\s*\(\s*this\s*\)\s*\.packages(?:\s*\.toMutableList\s*\(\s*\))?\s*;?/;
      if (applyPattern.test(contents)) {
        contents = contents.replace(applyPattern, "PackageList(this).packages.toMutableList().apply {\n              add(TermuxBridgePackage())");
        matched = true;
      } else if (packagesAssignment.test(contents)) {
        contents = contents.replace(packagesAssignment, "val packages = PackageList(this).packages.toMutableList()\n            packages.add(TermuxBridgePackage())");
        matched = true;
      } else if (packagesReturn.test(contents)) {
        contents = contents.replace(packagesReturn, "val packages = PackageList(this).packages.toMutableList()\n            packages.add(TermuxBridgePackage())\n            return packages");
        matched = true;
      }
    } else {
      const javaAssignment = /\bList\s*<\s*ReactPackage\s*>\s+packages\s*=\s*new\s+PackageList\s*\(\s*this\s*\)\s*\.getPackages\s*\(\s*\)\s*;/;
      const javaReturn = /\breturn\s+new\s+PackageList\s*\(\s*this\s*\)\s*\.getPackages\s*\(\s*\)\s*;/;
      if (javaAssignment.test(contents)) {
        contents = contents.replace(javaAssignment, (match) => match + "\n      packages.add(new TermuxBridgePackage());");
        matched = true;
      } else if (javaReturn.test(contents)) {
        contents = contents.replace(javaReturn, "List<ReactPackage> packages = new PackageList(this).getPackages();\n      packages.add(new TermuxBridgePackage());\n      return packages;");
        matched = true;
      }
    }

    if (!matched) {
      // Намеренно валим сборку с понятной ошибкой вместо того, чтобы молча
      // собрать APK без зарегистрированного нативного модуля — именно так
      // раньше терялась ошибка "нативный модуль недоступен" в рантайме,
      // хотя сама сборка проходила без единой ошибки.
      throw new Error(
        "[withTermuxBridge] Не удалось найти в " +
          (isKotlin ? "MainApplication.kt" : "MainApplication.java") +
          " ожидаемое место для регистрации TermuxBridgePackage. " +
          "Содержимое файла (пришлите этот фрагмент лога, чтобы поправить плагин под вашу версию шаблона):\n" +
          contents
      );
    }

    config.modResults.contents = contents;
    return config;
  });
}

function withTermuxBridge(config) {
  config = withTermuxBridgeFiles(config);
  config = withTermuxBridgeManifest(config);
  config = withTermuxBridgeMainApplication(config);
  return config;
}

module.exports = withTermuxBridge;
module.exports.__moduleKotlinForTest = moduleKotlin;
