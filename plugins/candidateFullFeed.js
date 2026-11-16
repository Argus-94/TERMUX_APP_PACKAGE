'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { candidateAssetPath, assertUniqueCandidateAssetPaths, candidateAssetPathKotlin } = require('./candidateAssetPaths');

const ASSET_DIR = 'termux-candidate-full';
const CACHE_NAME = 'candidate-feed-45ae9894c036';
const MANIFEST_SHA256 = '45ae9894c036b48978e63219dbe4cfe22e1d15bd560863c3155b07bdfd4c3556';
const INVENTORY_SHA256 = '77fb565ce17fd99aa3f1e350c5affe4e09c40adc5be6771a808d2e9ecee2554c';
const KEY_SHA256 = '4071d14f1a4a1ab263c892fbdb3d061c6e38bd9ea40a6085026aacf23f823136';
const FINGERPRINT = 'D2B7B46268D4CFC6FB24F18B4A43721D99DF1343';
const EXPECTED_LOCAL_PINS_SHA256 = '3adf645ca7a95eccb3331880f10f5ffc44cf93d85532b6b975c0ac5be8c7df93';
const SCRIPT_PATHS = ['candidate-command.sh', 'packages.tsv', 'payloads.tsv', 'bootstrap-baseline.tsv'];

function digest(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function safeRelative(rel) {
  return typeof rel === 'string' && rel.length > 0 && !rel.startsWith('/') && !rel.split('/').some(x => !x || x === '.' || x === '..' || x.includes('\\'));
}
function loadPinContract(projectRoot) {
  const root = path.resolve(projectRoot);
  const assetRoot = path.join(root, 'assets', ASSET_DIR);
  const manifestPath = path.join(root, 'docs/coherent-candidate/aggregate-manifest.json');
  const inventoryPath = path.join(root, 'docs/coherent-candidate/aggregate-archive-inventory.json');
  const pinsPath = path.join(assetRoot, 'local-pins.json');
  const manifestBytes = fs.readFileSync(manifestPath);
  const inventoryBytes = fs.readFileSync(inventoryPath);
  if (digest(manifestBytes) !== MANIFEST_SHA256 || digest(inventoryBytes) !== INVENTORY_SHA256) throw new Error('candidate_full_pinned_documents_mismatch');
  // The main agent finalizes this constant after writing local-pins.json and the four scripts.
  if (EXPECTED_LOCAL_PINS_SHA256 === '__FINALIZE_BY_MAIN__') throw new Error('candidate_full_local_pins_not_finalized');
  const pinsBytes = fs.readFileSync(pinsPath);
  if (digest(pinsBytes) !== EXPECTED_LOCAL_PINS_SHA256) throw new Error('candidate_full_local_pins_hash_mismatch');
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  const inventory = JSON.parse(inventoryBytes.toString('utf8'));
  const localPins = JSON.parse(pinsBytes.toString('utf8'));
  if (!localPins || typeof localPins !== 'object' || Array.isArray(localPins)) throw new Error('candidate_full_local_pins_invalid');
  const records = new Map();
  const add = (rel, pin) => {
    if (!safeRelative(rel) || !pin || !Number.isSafeInteger(pin.size) || pin.size < 0 || !/^[0-9a-f]{64}$/.test(pin.sha256) || records.has(rel)) throw new Error('candidate_full_pin_invalid:' + rel);
    records.set(rel, { size: pin.size, sha256: pin.sha256 });
  };
  for (const rel of ['dists/stable/Release', 'dists/stable/Release.gpg', 'dists/stable/InRelease', 'dists/stable/main/binary-aarch64/Packages', 'dists/stable/main/binary-aarch64/Packages.gz', 'keys/aibuilder-termux-feed-keyring.gpg']) {
    const entry = inventory.files['aggregate/candidate-feed/' + rel];
    if (!entry) throw new Error('candidate_full_inventory_entry_missing:' + rel);
    add(rel, entry);
  }
  if (inventory.files['aggregate/candidate-feed/keys/aibuilder-termux-feed-keyring.gpg'].sha256 !== KEY_SHA256) throw new Error('candidate_full_key_pin_mismatch');
  const packages = manifest.packages;
  if (!Array.isArray(packages) || packages.length !== 82) throw new Error('candidate_full_expected_82_packages');
  for (const pkg of packages) {
    const rel = 'pool/main/' + pkg.name[0].toLowerCase() + '/' + pkg.filename;
    // The inventory, not a filename-derived directory convention, is authoritative.
    const matching = Object.entries(inventory.files).filter(([k]) => k.startsWith('aggregate/candidate-feed/pool/') && k.endsWith('/' + pkg.filename));
    if (matching.length !== 1 || matching[0][1].sha256 !== pkg.sha256) throw new Error('candidate_full_package_inventory_mismatch:' + pkg.filename);
    add(matching[0][0].slice('aggregate/candidate-feed/'.length), matching[0][1]);
  }
  if (records.size !== packages.length + 6) throw new Error('candidate_full_expected_exact_source_files');
  if (!localPins || localPins.version !== 1 || !localPins.files || Object.keys(localPins.files).length !== SCRIPT_PATHS.length) throw new Error('candidate_full_local_pins_shape_invalid');
  for (const rel of SCRIPT_PATHS) {
    const p = localPins.files[rel];
    if (!p || !Number.isSafeInteger(p.size) || p.size < 0 || !/^[0-9a-f]{64}$/.test(p.sha256)) throw new Error('candidate_full_local_script_pin_invalid:' + rel);
    add(rel, p);
  }
  for (const [rel, pin] of records) {
    const file = path.join(assetRoot, rel);
    const bytes = fs.readFileSync(file);
    if (bytes.length !== pin.size || digest(bytes) !== pin.sha256) throw new Error('candidate_full_asset_mismatch:' + rel);
  }
  const actual = [];
  const walk = dir => { for (const ent of fs.readdirSync(dir, { withFileTypes: true })) { const full = path.join(dir, ent.name); const rel = path.relative(assetRoot, full).split(path.sep).join('/'); if (ent.isSymbolicLink()) throw new Error('candidate_full_asset_symlink:' + rel); if (ent.isDirectory()) walk(full); else if (ent.isFile() && rel !== 'local-pins.json') actual.push(rel); else if (!ent.isFile()) throw new Error('candidate_full_asset_special:' + rel); } };
  walk(assetRoot);
  const expected = [...records.keys()].sort();
  actual.sort();
  if (actual.length !== expected.length || actual.some((x, i) => x !== expected[i])) throw new Error('candidate_full_asset_file_set_mismatch');
  return { assetRoot, files: [...records.entries()].map(([rel, pin]) => ({ rel, size: pin.size, sha256: pin.sha256 })).sort((a, b) => a.rel.localeCompare(b.rel)) };
}

function candidateFullKotlin(packageName, projectRoot = path.resolve(__dirname, '..')) {
  if (packageName !== 'com.karat.aibuilder') throw new Error('candidate_full_package_name_invalid');
  const contract = loadPinContract(projectRoot);
  const encoded = JSON.stringify(contract.files);
  const lines = [];
  for (let i = 0; i < encoded.length; i += 8000) lines.push('        "' + encoded.slice(i, i + 8000).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"');
  return `package ${packageName}

import android.content.Context
import android.system.Os
import android.system.OsConstants
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.security.MessageDigest
import java.util.UUID

object AibCandidateFullFeed {
    const val CACHE_NAME = "${CACHE_NAME}"
    private const val ASSET_PREFIX = "candidate-full/"
${candidateAssetPathKotlin}
    private val entriesJson = (${lines.join(" +\n")})
    private val entries: List<Entry> by lazy {
        org.json.JSONArray(entriesJson).let { array -> (0 until array.length()).map { i ->
            val o = array.getJSONObject(i); Entry(o.getString("rel"), o.getLong("size"), o.getString("sha256"))
        } }
    }
    private data class Entry(val rel: String, val size: Long, val sha256: String)
    private val lock = Any()

    @JvmStatic fun stage(context: Context): String = synchronized(lock) {
        if (context.packageName != "com.karat.aibuilder") throw IllegalStateException("candidate_full_package_invalid")
        if (android.os.Build.SUPPORTED_ABIS.firstOrNull() != "arm64-v8a") throw IllegalStateException("candidate_full_arch_invalid")
        val files = context.filesDir
        checkDir(files, android.os.Process.myUid())
        val approvedFilesRoots = setOf("/data/user/0/com.karat.aibuilder/files", "/data/data/com.karat.aibuilder/files")
        val absoluteFilesPath = files.absolutePath
        val canonicalFilesPath = files.canonicalPath
        if (absoluteFilesPath !in approvedFilesRoots || canonicalFilesPath !in approvedFilesRoots ||
            absoluteFilesPath != canonicalFilesPath && !(absoluteFilesPath == "/data/data/com.karat.aibuilder/files" && canonicalFilesPath == "/data/user/0/com.karat.aibuilder/files") &&
            !(absoluteFilesPath == "/data/user/0/com.karat.aibuilder/files" && canonicalFilesPath == "/data/data/com.karat.aibuilder/files")) {
            throw IllegalStateException("candidate_full_filesdir_noncanonical")
        }
        val usr = File(files, "usr")
        val home = File(files, "home")
        checkDir(usr, android.os.Process.myUid())
        checkDir(home, android.os.Process.myUid())
        if (usr.canonicalPath != File(canonicalFilesPath, "usr").path || home.canonicalPath != File(canonicalFilesPath, "home").path) {
            throw IllegalStateException("candidate_full_usrhome_noncanonical")
        }
        val cache = File(files, CACHE_NAME)
        if (cache.exists() || cache.isDirectory || isLstatPresent(cache)) {
            validateTree(cache, android.os.Process.myUid())
            return@synchronized cache.canonicalPath
        }
        val partials = files.listFiles()?.count { it.name.startsWith(".candidate-feed-stage-") } ?: throw IllegalStateException("candidate_full_filesdir_unreadable")
        if (partials >= 3) throw IllegalStateException("candidate_full_partial_stage_limit")
        val temp = File(files, ".candidate-feed-stage-" + UUID.randomUUID().toString())
        if (!temp.mkdir()) throw IllegalStateException("candidate_full_stage_create_failed")
        try {
            for (entry in entries) copyPinned(context, temp, entry)
            syncDirectory(temp)
            if (!temp.renameTo(cache)) throw IllegalStateException("candidate_full_stage_commit_failed")
            syncDirectory(files)
            validateTree(cache, android.os.Process.myUid())
            cache.canonicalPath
        } catch (t: Throwable) {
            // Deliberately retain partial UUID directories for bounded diagnosis; never touch an existing cache.
            throw t
        }
    }

    private fun copyPinned(context: Context, root: File, entry: Entry) {
        val target = File(root, entry.rel)
        val parent = target.parentFile ?: throw IllegalStateException("candidate_full_target_invalid")
        ensureParents(root, parent)
        val digest = MessageDigest.getInstance("SHA-256")
        var count = 0L
        context.assets.open(ASSET_PREFIX + assetPath(entry.rel)).use { input ->
            FileOutputStream(target).use { output ->
                val buffer = ByteArray(65536)
                while (true) {
                    val n = input.read(buffer)
                    if (n < 0) break
                    count += n
                    if (count > entry.size) throw IllegalStateException("candidate_full_asset_oversize:" + entry.rel)
                    digest.update(buffer, 0, n); output.write(buffer, 0, n)
                }
                output.fd.sync()
            }
        }
        if (count != entry.size || hex(digest.digest()) != entry.sha256) throw IllegalStateException("candidate_full_asset_hash_mismatch:" + entry.rel)
    }

    private fun validateTree(root: File, uid: Int) {
        checkDir(root, uid)
        val expected = entries.associateBy { it.rel }
        val found = HashSet<String>()
        fun visit(dir: File, prefix: String) {
            val children = dir.listFiles() ?: throw IllegalStateException("candidate_full_cache_unreadable")
            for (child in children) {
                val rel = if (prefix.isEmpty()) child.name else "$prefix/\${child.name}"
                val st = Os.lstat(child.absolutePath)
                if (st.st_uid != uid) throw IllegalStateException("candidate_full_cache_owner_invalid")
                if ((st.st_mode and OsConstants.S_IFMT) == OsConstants.S_IFDIR) {
                    if (!expected.keys.any { it.startsWith(rel + "/") }) throw IllegalStateException("candidate_full_cache_extra_directory")
                    visit(child, rel)
                }
                else if ((st.st_mode and OsConstants.S_IFMT) == OsConstants.S_IFREG) {
                    val entry = expected[rel] ?: throw IllegalStateException("candidate_full_cache_extra_file:" + rel)
                    verifyFile(child, entry); found.add(rel)
                } else throw IllegalStateException("candidate_full_cache_object_invalid:" + rel)
            }
        }
        visit(root, "")
        if (found != expected.keys) throw IllegalStateException("candidate_full_cache_file_set_invalid")
    }

    private fun verifyFile(file: File, entry: Entry) {
        val digest = MessageDigest.getInstance("SHA-256"); var count = 0L
        FileInputStream(file).use { input -> val buffer = ByteArray(65536); while (true) { val n=input.read(buffer); if(n<0) break; count += n; if(count > entry.size) throw IllegalStateException("candidate_full_cache_size_invalid:" + entry.rel); digest.update(buffer,0,n) } }
        if (count != entry.size || hex(digest.digest()) != entry.sha256) throw IllegalStateException("candidate_full_cache_hash_invalid:" + entry.rel)
    }

    private fun ensureParents(root: File, parent: File) {
        val relative = parent.relativeTo(root).path
        var current = root
        if (relative.isNotEmpty()) for (part in relative.split(File.separatorChar)) {
            current = File(current, part)
            if (!current.exists() && !current.mkdir()) throw IllegalStateException("candidate_full_parent_create_failed")
            checkDir(current, android.os.Process.myUid())
        }
    }
    private fun checkDir(file: File, uid: Int) {
        val st = Os.lstat(file.absolutePath)
        if ((st.st_mode and OsConstants.S_IFMT) != OsConstants.S_IFDIR || st.st_uid != uid) throw IllegalStateException("candidate_full_directory_invalid")
    }
    private fun syncDirectory(dir: File) { val fd = Os.open(dir.absolutePath, OsConstants.O_RDONLY, 0); try { Os.fsync(fd) } finally { Os.close(fd) } }
    private fun isLstatPresent(file: File): Boolean { return try { Os.lstat(file.absolutePath); true } catch (_: android.system.ErrnoException) { false } }
    private fun hex(bytes: ByteArray): String = bytes.joinToString("") { "%02x".format(it) }
}
`;
}

function stageFullCandidateAssets(projectRoot, androidAssetsRoot) {
  const contract = loadPinContract(projectRoot);
  const target = path.join(androidAssetsRoot, 'candidate-full');
  assertUniqueCandidateAssetPaths(contract.files.map(file => file.rel));
  if (fs.existsSync(target)) {
    const expected = new Map(contract.files.map(file => [candidateAssetPath(file.rel), file]));
    const seen = new Set();
    const visit = (dir) => {
      if (!fs.lstatSync(dir).isDirectory() || fs.lstatSync(dir).isSymbolicLink()) throw new Error('candidate_full_android_asset_directory_invalid');
      for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, item.name);
        const rel = path.relative(target, file).split(path.sep).join('/');
        if (item.isSymbolicLink()) throw new Error('candidate_full_android_asset_symlink');
        if (item.isDirectory()) {
          if (![...expected.keys()].some(asset => asset.startsWith(rel + '/'))) throw new Error('candidate_full_android_asset_extra_directory');
          visit(file);
        } else {
          const pin = expected.get(rel);
          if (!item.isFile() || !pin) throw new Error('candidate_full_android_asset_extra_file');
          const bytes = fs.readFileSync(file);
          if (bytes.length !== pin.size || digest(bytes) !== pin.sha256) throw new Error('candidate_full_android_asset_hash_mismatch');
          seen.add(rel);
        }
      }
    };
    visit(target);
    if (seen.size !== expected.size) throw new Error('candidate_full_android_asset_incomplete');
    return target;
  }
  fs.mkdirSync(target, { recursive: true });
  for (const file of contract.files) {
    const dest = path.join(target, candidateAssetPath(file.rel));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(contract.assetRoot, file.rel), dest, fs.constants.COPYFILE_EXCL);
  }
  return target;
}

module.exports = { stageFullCandidateAssets, candidateFullKotlin, ASSET_DIR, CACHE_NAME };
