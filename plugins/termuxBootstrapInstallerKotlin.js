module.exports = function bootstrapInstallerKotlin(pkg, bootstrap) {
  return `package ${pkg}

import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.Process
import android.os.StatFs
import android.system.ErrnoException
import android.system.Os
import android.system.OsConstants
import android.util.Log
import org.json.JSONObject
import java.io.BufferedReader
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.io.InputStreamReader
import java.security.MessageDigest
import java.util.ArrayList
import java.util.HashSet
import java.util.concurrent.TimeUnit
import java.util.zip.ZipEntry
import java.util.zip.ZipFile

/**
 * Installs the exact, hash-pinned bootstrap into this app's private filesDir.
 * No network access, external Termux package, root access, or prefix overwrite is used.
 */
internal object AibEmbeddedTermuxBootstrapInstaller {
    internal data class Outcome(val ready: Boolean, val status: String, val detail: String = "")
    private data class Member(val entry: ZipEntry, val relativePath: String)
    private data class Symlink(val target: String, val relativePath: String)

    internal const val EXPECTED_ARCHIVE_SHA256 = "${bootstrap.archiveSha256}"
    private const val EXPECTED_PACKAGE = "${pkg}"
    private const val EXPECTED_ARCH = "aarch64"
    private const val EXPECTED_ANDROID_ABI = "arm64-v8a"
    private const val EXPECTED_SOURCE_COMMIT = "${bootstrap.sourceCommit}"
    private const val EXPECTED_BOOTSTRAP_VERSION = "${bootstrap.bootstrapVersion}"
    private const val ARCHIVE_ASSET = "termux/termux-bootstrap-aarch64.zip"
    private const val SHA256_ASSET = "termux/termux-bootstrap-aarch64.zip.sha256"
    private const val PROVENANCE_ASSET = "termux/termux-bootstrap-aarch64.zip.provenance.json"
    private const val MAX_ARCHIVE_BYTES = 1_000_000_000L
    private const val MAX_UNCOMPRESSED_BYTES = 1_500_000_000L
    private const val MAX_MEMBERS = 200_000
    private const val MAX_SYMLINK_MANIFEST_BYTES = 32L * 1024L * 1024L
    private const val INSTALL_TIMEOUT_SECONDS = 600L
    private const val PACKAGE_FEED_URL = "https://argus-94.github.io/TERMUX_APP_PACKAGE/apt/termux-main"
    private const val PACKAGE_FEED_SOURCE_RELATIVE = "etc/apt/sources.list.d/aibuilder-termux-feed.list"
    private const val PACKAGE_FEED_APT_CONF_RELATIVE = "etc/apt/apt.conf.d/99aibuilder-termux-feed.conf"

    private val lock = Any()
    private var workerActive = false
    private val waiters = ArrayList<(Outcome) -> Unit>()

    fun installIfNeeded(context: Context, callback: (Outcome) -> Unit) {
        val appContext = context.applicationContext
        val shouldStart = synchronized(lock) {
            waiters.add(callback)
            if (workerActive) false else {
                workerActive = true
                true
            }
        }
        if (!shouldStart) return
        Thread({
            val outcome = try {
                installBlocking(appContext)
            } catch (error: Throwable) {
                val reason = (error as? IOException)?.message?.takeIf { it.matches(Regex("^[a-z0-9_]{1,80}$")) } ?: "install_failed"
                Log.e("AIB-TermuxBootstrap", "Private bootstrap installation failed status=" + reason + " type=" + error.javaClass.simpleName.take(64))
                Outcome(false, reason, error.javaClass.simpleName.take(64))
            }
            val callbacks = synchronized(lock) {
                workerActive = false
                val copy = ArrayList(waiters)
                waiters.clear()
                copy
            }
            Handler(Looper.getMainLooper()).post {
                callbacks.forEach { waiter ->
                    try { waiter(outcome) } catch (error: Throwable) {
                        Log.e("AIB-TermuxBootstrap", "Bootstrap completion callback failed")
                    }
                }
            }
        }, "AIB-TermuxBootstrapInstall").start()
    }

    /** API 29+ forbids direct execve of writable app-data executables.
     * The system linker is the executable; bash and its children use the bundled
     * termux-exec linker variant. Never lower targetSdk or invoke another app.
     * This list includes argv[0], as required by both ProcessBuilder and Termux JNI.
     */
    internal fun shellCommand(prefix: File, vararg arguments: String): List<String> {
        return executableCommand(listOf(File(prefix, "bin/bash").absolutePath) + arguments)
    }

    internal fun executableCommand(argv: List<String>): List<String> {
        return if (Build.VERSION.SDK_INT >= 29) listOf("/system/bin/linker64") + argv else argv
    }

    internal fun executionEnvironment(context: Context, prefix: File, home: File, temp: File): Map<String, String> {
        val linkerMode = Build.VERSION.SDK_INT >= 29
        val preload = File(prefix, if (linkerMode) "lib/libtermux-exec-linker-ld-preload.so" else "lib/libtermux-exec-direct-ld-preload.so")
        if (!preload.isFile) throw IOException("exec_preload_missing")
        return mapOf(
            "HOME" to home.absolutePath,
            "TERMUX_ARCH" to EXPECTED_ARCH,
            "PREFIX" to prefix.absolutePath,
            "TERMUX_PREFIX" to prefix.absolutePath,
            "TERMUX__PREFIX" to prefix.absolutePath,
            "TERMUX_APP__DATA_DIR" to context.applicationInfo.dataDir,
            "TERMUX_APP__PACKAGE_NAME" to EXPECTED_PACKAGE,
            "TERMUX_APP_PACKAGE" to EXPECTED_PACKAGE,
            "TERMUX__UID" to Process.myUid().toString(),
            "TERMUX__USER_ID" to (Process.myUid() / 100000).toString(),
            "ANDROID__BUILD_VERSION_SDK" to Build.VERSION.SDK_INT.toString(),
            "TERMUX_EXEC__SYSTEM_LINKER_EXEC__MODE" to if (linkerMode) "force" else "disable",
            "LD_PRELOAD" to preload.absolutePath,
            "LD_LIBRARY_PATH" to File(prefix, "lib").absolutePath,
            "PATH" to (File(prefix, "bin").absolutePath + ":" + File(prefix, "bin/applets").absolutePath + ":/system/bin:/system/xbin"),
            "TMPDIR" to temp.absolutePath,
            "SHELL" to File(prefix, "bin/bash").absolutePath,
            "LANG" to "C.UTF-8",
            "TERM" to "xterm-256color"
        )
    }

    private fun installBlocking(context: Context): Outcome {
        val abi = Build.SUPPORTED_ABIS.firstOrNull().orEmpty()
        if (context.packageName != EXPECTED_PACKAGE) return Outcome(false, "wrong_package")
        if (abi != EXPECTED_ANDROID_ABI) return Outcome(false, "unsupported_abi", abi)

        val files = context.filesDir
        val prefix = File(files, "usr")
        val home = File(files, "home")
        val stage = File(files, "usr.installing")
        val manifest = File(files, "termux-bootstrap.json")
        val pending = File(files, ".termux-bootstrap-installing.json")
        val cachedArchive = File(context.cacheDir, "termux-bootstrap-aarch64.zip.part")

        if (isCompleteInstall(context, prefix, home, manifest)) {
            val feed = configurePackageFeed(context, prefix)
            try {
                val current = JSONObject(manifest.readText(Charsets.UTF_8))
                    .put("applicationDataDir", context.applicationInfo.dataDir)
                    .put("filesDir", files.absolutePath)
                    .put("termuxPrefix", prefix.absolutePath)
                    .put("packageFeedUrl", PACKAGE_FEED_URL)
                    .put("packageFeedStatus", feed.status)
                    .put("packageFeedEnabled", feed.enabled)
                    .put("packageFeedKeyFingerprint", feed.fingerprint)
                writeAtomic(manifest, current.toString())
            } catch (error: Throwable) {
                Log.w("AIB-TermuxBootstrap", "Could not refresh runtime/feed manifest fields", error)
            }
            deleteFileIfPresent(pending)
            return Outcome(true, "already_installed", feed.status)
        }

        recoverInterruptedInstall(context, prefix, stage, pending)
        quarantineDamagedManagedPrefix(context, prefix, manifest)
        if (prefix.exists() || isSymlink(prefix)) {
            return Outcome(false, "existing_prefix_unmanaged")
        }
        if (manifest.exists() && !manifest.delete()) {
            return Outcome(false, "invalid_manifest_unreadable")
        }
        if (home.exists() || isSymlink(home)) {
            if (isSymlink(home) || !home.isDirectory) return Outcome(false, "unsafe_home_path")
        } else if (!home.mkdirs()) {
            return Outcome(false, "home_create_failed")
        }

        writeAtomic(pending, JSONObject()
            .put("schemaVersion", 1)
            .put("applicationId", EXPECTED_PACKAGE)
            .put("archiveSha256", EXPECTED_ARCHIVE_SHA256)
            .put("installState", "pending").toString())

        var activated = false
        try {
            validatePackagedProvenance(context)
            if (cachedArchive.exists() || isSymlink(cachedArchive)) deleteTreeNoFollow(cachedArchive)
            val archiveDigest = copyAssetAndHash(context, cachedArchive)
            if (archiveDigest != EXPECTED_ARCHIVE_SHA256) throw IOException("archive_sha256_mismatch")
            extractBootstrap(cachedArchive, stage, prefix)
            verifyExtractedPrefix(stage)

            if (prefix.exists() || isSymlink(prefix)) throw IOException("prefix_appeared_during_install")
            Os.rename(stage.absolutePath, prefix.absolutePath)
            activated = true
            runSecondStage(context, prefix, home)
            verifyExtractedPrefix(prefix)
            val lockFile = File(prefix, "etc/termux/termux-bootstrap/second-stage/termux-bootstrap-second-stage.sh.lock")
            if (!isSymlink(lockFile)) throw IOException("second_stage_lock_missing")
            val feed = configurePackageFeed(context, prefix)

            val result = JSONObject()
                .put("schemaVersion", 1)
                .put("applicationId", EXPECTED_PACKAGE)
                .put("architecture", EXPECTED_ARCH)
                .put("androidAbi", EXPECTED_ANDROID_ABI)
                .put("bootstrapVersion", EXPECTED_BOOTSTRAP_VERSION)
                .put("archiveSha256", EXPECTED_ARCHIVE_SHA256)
                .put("sourceCommit", EXPECTED_SOURCE_COMMIT)
                .put("prefixRelativePath", "usr")
                .put("homeRelativePath", "home")
                .put("installState", "complete")
                .put("secondStageCompleted", true)
                .put("applicationDataDir", context.applicationInfo.dataDir)
                .put("filesDir", files.absolutePath)
                .put("termuxPrefix", prefix.absolutePath)
                .put("packageFeedUrl", PACKAGE_FEED_URL)
                .put("packageFeedStatus", feed.status)
                .put("packageFeedEnabled", feed.enabled)
                .put("packageFeedKeyFingerprint", feed.fingerprint)
                .put("installedAtEpochMillis", System.currentTimeMillis())
            writeAtomic(manifest, result.toString())
            activated = false // Committed: do not roll back a manifest-complete prefix.
            deleteFileIfPresent(pending)
            return Outcome(true, "installed")
        } catch (error: Throwable) {
            if (activated && !isCompleteInstall(context, prefix, home, manifest)) {
                try { deleteTreeNoFollow(prefix) } catch (cleanupError: Throwable) {
                    Log.e("AIB-TermuxBootstrap", "Could not roll back incomplete prefix", cleanupError)
                }
            }
            try { deleteTreeNoFollow(stage) } catch (_: Throwable) { }
            // Keep the ownership marker if cleanup failed, so a later retry can
            // safely recover the interrupted prefix instead of stranding it as unmanaged.
            if (!prefix.exists() && !isSymlink(prefix)) deleteFileIfPresent(pending)
            throw error
        } finally {
            deleteFileIfPresent(cachedArchive)
        }
    }

    private data class PackageFeedState(val enabled: Boolean, val status: String, val fingerprint: String = "")

    /** The production feed remains deliberately unprovisioned; no network source is enabled. */
    private fun configurePackageFeed(context: Context, prefix: File): PackageFeedState {
        return PackageFeedState(false, "blocked_signing_key_unprovisioned")
    }

    private fun packageFeedAptConfigBytes(): ByteArray {
        val quote = 34.toChar().toString()
        val lineBreak = 10.toChar().toString()
        return listOf(
            "APT::Get::AllowUnauthenticated " + quote + "false" + quote + ";",
            "Acquire::AllowInsecureRepositories " + quote + "false" + quote + ";",
            "Acquire::AllowDowngradeToInsecureRepositories " + quote + "false" + quote + ";"
        ).joinToString(lineBreak, postfix = lineBreak).toByteArray(Charsets.UTF_8)
    }

    private fun isSafePrivateTarget(prefix: File, target: File): Boolean {
        val root = prefix.canonicalFile
        val canonicalTarget = target.canonicalFile
        if (!canonicalTarget.path.startsWith(root.path + File.separator)) return false
        var current = target.parentFile ?: return false
        while (true) {
            if (isSymlink(current)) return false
            val canonical = current.canonicalFile
            if (canonical.path != root.path && !canonical.path.startsWith(root.path + File.separator)) return false
            if (canonical.path == root.path) return true
            current = current.parentFile ?: return false
        }
    }

    private fun writeContentIfAbsent(target: File, value: ByteArray): Boolean {
        if (target.exists() || isSymlink(target)) {
            return target.isFile && !isSymlink(target) && try { target.readBytes().contentEquals(value) } catch (_: Throwable) { false }
        }
        val parent = target.parentFile ?: return false
        if (!parent.isDirectory && !parent.mkdirs()) return false
        if (isSymlink(parent)) return false
        val temp = File(parent, target.name + ".aib.tmp")
        if (temp.exists() || isSymlink(temp)) return false
        return try {
            FileOutputStream(temp).use { output ->
                output.write(value)
                output.flush()
                output.fd.sync()
            }
            if (target.exists() || isSymlink(target)) {
                deleteFileIfPresent(temp)
                false
            } else {
                Os.rename(temp.absolutePath, target.absolutePath)
                true
            }
        } catch (_: Throwable) {
            try { deleteFileIfPresent(temp) } catch (_: Throwable) { }
            false
        }
    }

    private fun validatePackagedProvenance(context: Context) {
        val checksum = context.assets.open(SHA256_ASSET).bufferedReader(Charsets.UTF_8).use { it.readLine().orEmpty() }
            .trim().substringBefore(' ')
        if (!checksum.equals(EXPECTED_ARCHIVE_SHA256, ignoreCase = true)) throw IOException("packaged_sha256_sidecar_mismatch")
        val provenance = context.assets.open(PROVENANCE_ASSET).bufferedReader(Charsets.UTF_8).use { JSONObject(it.readText()) }
        if (provenance.optInt("schemaVersion", 0) != 1 ||
            provenance.optString("applicationId") != EXPECTED_PACKAGE ||
            provenance.optString("architecture") != EXPECTED_ARCH ||
            provenance.optString("archiveSha256").lowercase() != EXPECTED_ARCHIVE_SHA256 ||
            provenance.optString("sourceCommit") != EXPECTED_SOURCE_COMMIT ||
            provenance.optString("bootstrapVersion") != EXPECTED_BOOTSTRAP_VERSION ||
            provenance.optBoolean("archiveStructureVerified", false).not()) {
            throw IOException("packaged_provenance_mismatch")
        }
    }

    private fun copyAssetAndHash(context: Context, destination: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        var total = 0L
        destination.parentFile?.let { if (!it.isDirectory && !it.mkdirs()) throw IOException("archive_cache_create_failed") }
        context.assets.open(ARCHIVE_ASSET).use { input ->
            FileOutputStream(destination).use { output ->
                val buffer = ByteArray(65_536)
                while (true) {
                    val count = input.read(buffer)
                    if (count < 0) break
                    total += count.toLong()
                    if (total > MAX_ARCHIVE_BYTES) throw IOException("archive_size_limit_exceeded")
                    digest.update(buffer, 0, count)
                    output.write(buffer, 0, count)
                }
                output.flush()
                output.fd.sync()
            }
        }
        if (total == 0L) throw IOException("empty_archive")
        return digest.digest().joinToString("") { byte -> "%02x".format(byte) }
    }

    private fun extractBootstrap(archive: File, stage: File, finalPrefix: File) {
        if (stage.exists() || isSymlink(stage)) deleteTreeNoFollow(stage)
        if (!stage.mkdirs()) throw IOException("staging_directory_create_failed")
        val stageCanonical = stage.canonicalFile
        val finalCanonical = finalPrefix.canonicalFile
        ZipFile(archive).use { zip ->
            val members = ArrayList<Member>()
            val seenMembers = HashSet<String>()
            val enumeration = zip.entries()
            var totalUncompressed = 0L
            var symlinkManifest: ZipEntry? = null
            var memberCount = 0
            while (enumeration.hasMoreElements()) {
                val entry = enumeration.nextElement()
                memberCount++
                if (memberCount > MAX_MEMBERS) throw IOException("archive_member_limit_exceeded")
                val relative = normalizeArchivePath(entry.name)
                if (relative.isEmpty()) continue
                if (!seenMembers.add(relative)) throw IOException("duplicate_archive_member")
                if (entry.size < 0L) throw IOException("unknown_archive_member_size")
                if (entry.size > MAX_UNCOMPRESSED_BYTES - totalUncompressed) throw IOException("archive_uncompressed_size_limit_exceeded")
                totalUncompressed += entry.size
                if (relative == "SYMLINKS.txt") {
                    if (entry.isDirectory || entry.size > MAX_SYMLINK_MANIFEST_BYTES) throw IOException("invalid_symlink_manifest")
                    symlinkManifest = entry
                } else {
                    members.add(Member(entry, relative))
                }
            }
            val manifestEntry = symlinkManifest ?: throw IOException("symlink_manifest_missing")
            val links = readSymlinks(zip, manifestEntry, stageCanonical, finalCanonical)
            if (links.isEmpty()) throw IOException("symlink_manifest_empty")
            val linkPaths = HashSet<String>()
            links.forEach { link ->
                if (!linkPaths.add(link.relativePath) || seenMembers.contains(link.relativePath)) throw IOException("duplicate_symlink_path")
            }

            val availableBytes = StatFs(stageCanonical.parentFile?.absolutePath ?: stageCanonical.absolutePath).availableBytes
            if (availableBytes < totalUncompressed + 32L * 1024L * 1024L) throw IOException("insufficient_private_storage")

            members.forEach { member ->
                val destination = checkedChild(stageCanonical, member.relativePath)
                if (member.entry.isDirectory) {
                    if (destination.exists() && !destination.isDirectory) throw IOException("archive_directory_collision")
                    if (!destination.isDirectory && !destination.mkdirs()) throw IOException("archive_directory_create_failed")
                } else {
                    val parent = destination.parentFile ?: throw IOException("archive_member_parent_missing")
                    if (!parent.isDirectory && !parent.mkdirs()) throw IOException("archive_parent_create_failed")
                    if (destination.exists() || isSymlink(destination)) throw IOException("archive_member_collision")
                    var copied = 0L
                    zip.getInputStream(member.entry).use { input ->
                        FileOutputStream(destination).use { output ->
                            val buffer = ByteArray(65_536)
                            while (true) {
                                val count = input.read(buffer)
                                if (count < 0) break
                                copied += count.toLong()
                                if (copied > member.entry.size) throw IOException("archive_member_size_mismatch")
                                output.write(buffer, 0, count)
                            }
                        }
                    }
                    if (copied != member.entry.size) throw IOException("archive_member_size_mismatch")
                    if (requiresOwnerExecute(member.relativePath)) Os.chmod(destination.absolutePath, 448)
                }
            }

            links.forEach { link ->
                validateSymlinkTarget(link.target, link.relativePath, stageCanonical, finalCanonical)
                val destination = checkedChild(stageCanonical, link.relativePath)
                val parent = destination.parentFile ?: throw IOException("symlink_parent_missing")
                if (!parent.isDirectory && !parent.mkdirs()) throw IOException("symlink_parent_create_failed")
                if (destination.exists() || isSymlink(destination)) throw IOException("symlink_path_collision")
                Os.symlink(link.target, destination.absolutePath)
            }
        }
    }

    private fun readSymlinks(zip: ZipFile, entry: ZipEntry, stage: File, finalPrefix: File): List<Symlink> {
        val links = ArrayList<Symlink>()
        zip.getInputStream(entry).use { input ->
            BufferedReader(InputStreamReader(input, Charsets.UTF_8)).use { reader ->
                while (true) {
                    val raw = reader.readLine() ?: break
                    if (raw.isEmpty()) continue
                    val delimiter = raw.indexOf('←')
                    if (delimiter <= 0 || delimiter != raw.lastIndexOf('←') || delimiter == raw.lastIndex) throw IOException("malformed_symlink_manifest")
                    val originalTarget = raw.substring(0, delimiter)
                    val relative = normalizeArchivePath(raw.substring(delimiter + 1))
                    // The pinned archive uses its compile-time *own* app prefix.
                    // Convert only that exact namespace to a relative in-prefix link.
                    // This avoids Android /data/data versus /data/user/0 aliases and
                    // keeps staged links valid before the atomic activation rename.
                    val compiledPrefix = "/data/data/" + EXPECTED_PACKAGE + "/files/usr/"
                    val target = if (originalTarget.startsWith(compiledPrefix)) {
                        val suffix = normalizeArchivePath(originalTarget.removePrefix(compiledPrefix))
                        if (suffix.isEmpty()) throw IOException("invalid_symlink_target")
                        val parent = File(stage, relative).parentFile ?: throw IOException("symlink_parent_missing")
                        File(stage, suffix).relativeTo(parent).path
                    } else originalTarget
                    if (relative.isEmpty() || relative == "SYMLINKS.txt") throw IOException("invalid_symlink_path")
                    validateSymlinkTarget(target, relative, stage, finalPrefix)
                    links.add(Symlink(target, relative))
                }
            }
        }
        return links
    }

    private fun normalizeArchivePath(value: String): String {
        var name = value
        while (name.startsWith("./")) name = name.substring(2)
        if (name.isEmpty() || name == ".") return ""
        if (name.startsWith("/") || name.indexOf(92.toChar()) >= 0 || name.indexOf(0.toChar()) >= 0 ||
            name.indexOf(10.toChar()) >= 0 || name.indexOf(13.toChar()) >= 0) throw IOException("unsafe_archive_member_path")
        val trimmed = name.removeSuffix("/")
        val parts = trimmed.split('/')
        if (parts.isEmpty() || parts.any { it.isEmpty() || it == "." || it == ".." } || parts[0].contains(':')) {
            throw IOException("unsafe_archive_member_path")
        }
        return trimmed
    }

    private fun validateSymlinkTarget(target: String, relativePath: String, stage: File, finalPrefix: File) {
        if (target.isEmpty() || target.indexOf(0.toChar()) >= 0 || target.indexOf(10.toChar()) >= 0 || target.indexOf(13.toChar()) >= 0) {
            throw IOException("invalid_symlink_target")
        }
        val resolved = if (target.startsWith("/")) File(target).canonicalFile else File(File(stage, relativePath).parentFile, target).canonicalFile
        val root = if (target.startsWith("/")) finalPrefix.canonicalFile else stage.canonicalFile
        if (resolved.path != root.path && !resolved.path.startsWith(root.path + File.separator)) {
            throw IOException("symlink_target_outside_private_prefix")
        }
    }

    private fun checkedChild(root: File, relative: String): File {
        val child = File(root, relative)
        val canonical = child.canonicalFile
        if (canonical.path != root.path && !canonical.path.startsWith(root.path + File.separator)) {
            throw IOException("archive_path_escape")
        }
        return child
    }

    private fun requiresOwnerExecute(path: String): Boolean =
        path.startsWith("bin/") || path.startsWith("libexec") ||
            path.startsWith("lib/apt/apt-helper") || path.startsWith("lib/apt/methods")

    private fun verifyExtractedPrefix(prefix: File) {
        val required = listOf("bin/bash", "bin/apt", "bin/dpkg")
        required.forEach { relative ->
            val file = File(prefix, relative)
            if (!file.isFile || !file.canExecute()) throw IOException("required_executable_missing")
        }
        listOf("etc/apt/sources.list", "var/lib/dpkg/status", "etc/termux/termux-bootstrap/second-stage/termux-bootstrap-second-stage.sh")
            .forEach { relative -> if (!File(prefix, relative).isFile) throw IOException("required_bootstrap_file_missing") }
    }

    private fun runSecondStage(context: Context, prefix: File, home: File) {
        val script = File(prefix, "etc/termux/termux-bootstrap/second-stage/termux-bootstrap-second-stage.sh")
        val temp = File(context.cacheDir, "termux-tmp")
        if (!temp.isDirectory && !temp.mkdirs()) throw IOException("temporary_directory_create_failed")
        val log = File(context.cacheDir, "termux-bootstrap-second-stage.log")
        if (log.exists()) deleteFileIfPresent(log)
        val builder = ProcessBuilder(shellCommand(prefix, script.absolutePath))
            .directory(home)
            .redirectErrorStream(true)
            .redirectOutput(log)
        val environment = builder.environment()
        environment.clear()
        environment.putAll(executionEnvironment(context, prefix, home, temp))
        val process = try { builder.start() } catch (_: IOException) { throw IOException("second_stage_start_failed") }
        process.outputStream.close()
        if (!process.waitFor(INSTALL_TIMEOUT_SECONDS, TimeUnit.SECONDS)) {
            process.destroyForcibly()
            process.waitFor(10, TimeUnit.SECONDS)
            throw IOException("second_stage_timeout")
        }
        if (process.exitValue() != 0) throw IOException("second_stage_exit_" + process.exitValue())
    }

    private fun isCompleteInstall(context: Context, prefix: File, home: File, manifestFile: File): Boolean {
        if (!manifestFile.isFile || !prefix.isDirectory || !home.isDirectory || isSymlink(prefix) || isSymlink(home)) return false
        return try {
            val manifest = JSONObject(manifestFile.readText(Charsets.UTF_8))
            manifest.optInt("schemaVersion", 0) == 1 &&
                manifest.optString("applicationId") == context.packageName &&
                manifest.optString("architecture") == EXPECTED_ARCH &&
                manifest.optString("androidAbi") == Build.SUPPORTED_ABIS.firstOrNull().orEmpty() &&
                manifest.optString("installState") == "complete" &&
                manifest.optBoolean("secondStageCompleted", false) &&
                manifest.optString("prefixRelativePath") == "usr" &&
                manifest.optString("homeRelativePath") == "home" &&
                manifest.optString("archiveSha256") == EXPECTED_ARCHIVE_SHA256 &&
                manifest.optString("sourceCommit") == EXPECTED_SOURCE_COMMIT &&
                manifest.optString("bootstrapVersion") == EXPECTED_BOOTSTRAP_VERSION &&
                run { verifyExtractedPrefix(prefix); true } &&
                isSymlink(File(prefix, "etc/termux/termux-bootstrap/second-stage/termux-bootstrap-second-stage.sh.lock")) &&
                File(prefix, "lib/libtermux-exec-linker-ld-preload.so").isFile &&
                File(prefix, "lib/libtermux-exec-direct-ld-preload.so").isFile
        } catch (_: Throwable) { false }
    }

    /** Repair only a prefix bearing our exact pinned completed-install identity.
     * Preserve it in quarantine rather than deleting possible user-installed files.
     * Unknown, corrupt or foreign ownership metadata never authorizes replacement.
     */
    private fun quarantineDamagedManagedPrefix(context: Context, prefix: File, manifestFile: File) {
        if (!prefix.exists() || isSymlink(prefix) || !prefix.isDirectory || !manifestFile.isFile || isSymlink(manifestFile)) return
        val marker = try { JSONObject(manifestFile.readText(Charsets.UTF_8)) } catch (_: Throwable) { return }
        if (marker.optInt("schemaVersion", 0) != 1 || marker.optString("applicationId") != context.packageName ||
            marker.optString("archiveSha256") != EXPECTED_ARCHIVE_SHA256 || marker.optString("sourceCommit") != EXPECTED_SOURCE_COMMIT ||
            marker.optString("bootstrapVersion") != EXPECTED_BOOTSTRAP_VERSION || marker.optString("architecture") != EXPECTED_ARCH ||
            marker.optString("androidAbi") != EXPECTED_ANDROID_ABI || marker.optString("installState") != "complete" ||
            !marker.optBoolean("secondStageCompleted", false) || marker.optString("prefixRelativePath") != "usr" ||
            marker.optString("homeRelativePath") != "home") return
        val quarantine = File(context.filesDir, "usr.recovery-" + System.currentTimeMillis())
        if (quarantine.exists() || isSymlink(quarantine)) throw IOException("recovery_destination_exists")
        Os.rename(prefix.absolutePath, quarantine.absolutePath)
        Os.rename(manifestFile.absolutePath, File(quarantine, ".aib-recovered-bootstrap.json").absolutePath)
    }

    private fun recoverInterruptedInstall(context: Context, prefix: File, stage: File, pending: File) {
        if (!pending.isFile) return
        val marker = try { JSONObject(pending.readText(Charsets.UTF_8)) } catch (_: Throwable) { return }
        if (marker.optInt("schemaVersion", 0) != 1 || marker.optString("applicationId") != context.packageName ||
            marker.optString("archiveSha256") != EXPECTED_ARCHIVE_SHA256 || marker.optString("installState") != "pending") return
        if (prefix.exists() || isSymlink(prefix)) deleteTreeNoFollow(prefix)
        if (stage.exists() || isSymlink(stage)) deleteTreeNoFollow(stage)
        deleteFileIfPresent(pending)
    }

    private fun writeAtomic(target: File, value: String) {
        val parent = target.parentFile ?: throw IOException("manifest_parent_missing")
        if (!parent.isDirectory && !parent.mkdirs()) throw IOException("manifest_parent_create_failed")
        val temp = File(parent, target.name + ".tmp")
        if (temp.exists() || isSymlink(temp)) deleteTreeNoFollow(temp)
        FileOutputStream(temp).use { output ->
            output.write(value.toByteArray(Charsets.UTF_8))
            output.write(10)
            output.flush()
            output.fd.sync()
        }
        if (target.exists() || isSymlink(target)) deleteTreeNoFollow(target)
        Os.rename(temp.absolutePath, target.absolutePath)
    }

    private fun deleteFileIfPresent(file: File) {
        try {
            val stat = Os.lstat(file.absolutePath)
            if ((stat.st_mode and OsConstants.S_IFMT) == OsConstants.S_IFDIR) return
            Os.remove(file.absolutePath)
        } catch (error: ErrnoException) {
            if (error.errno != OsConstants.ENOENT) throw IOException("file_cleanup_failed", error)
        }
    }

    private fun deleteTreeNoFollow(file: File) {
        val stat = try { Os.lstat(file.absolutePath) } catch (error: ErrnoException) {
            if (error.errno == OsConstants.ENOENT) return else throw IOException("tree_lstat_failed", error)
        }
        when (stat.st_mode and OsConstants.S_IFMT) {
            OsConstants.S_IFLNK -> Os.remove(file.absolutePath)
            OsConstants.S_IFDIR -> {
                val children = file.listFiles() ?: throw IOException("tree_list_failed")
                children.forEach { child -> deleteTreeNoFollow(child) }
                Os.remove(file.absolutePath)
            }
            else -> Os.remove(file.absolutePath)
        }
    }

    private fun isSymlink(file: File): Boolean = try {
        (Os.lstat(file.absolutePath).st_mode and OsConstants.S_IFMT) == OsConstants.S_IFLNK
    } catch (error: ErrnoException) {
        if (error.errno == OsConstants.ENOENT) false else throw IOException("path_lstat_failed", error)
    }
}
`;
};
