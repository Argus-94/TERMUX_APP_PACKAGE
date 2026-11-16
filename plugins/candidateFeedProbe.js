'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { candidateAssetPath, assertUniqueCandidateAssetPaths, candidateAssetPathKotlin } = require('./candidateAssetPaths');

const ASSET_DIR = 'assets/termux-candidate-probe';
const PACKAGE_ID = 'com.karat.aibuilder';
// Exact final retained candidate metadata, not a production trust anchor.
const FILES = Object.freeze({
  'install-make.sh': ['6df7322f0a0c0ec24459058f3c0b99d50ba4c5be32e120cd78f89ba4b84978f4', 4851],
  'probe.sh': ['4e3c045cc330fd59009788f7b73446a60bf26c1a4343a1aca0f890e2c1339c5a', 5372],
  'dists/stable/InRelease': ['00fa1b6b2a290e79b9e6cefbd00a7e081926e747af7e6582400df3255e051f97', 1017],
  'dists/stable/Release': ['1496e15c859045534d4674a9eed5bf7d6c874596b3276c4120f5207d5df45919', 480],
  'dists/stable/Release.gpg': ['723f8567ad2f34fb0876e2e0b10fc620187aea2baa446811773681a6df32221e', 310],
  'dists/stable/main/binary-aarch64/Packages': ['45d504b11fa0be9c8987c21b890910ec2796188de47e20d58aa8ceb5d70f98cc', 40546],
  'dists/stable/main/binary-aarch64/Packages.gz': ['bed203ab1f195e0a39ec2d4c04f0a5fa30110663a46ab6630b90af92825b793c', 14258],
  'keys/aibuilder-termux-feed-keyring.gpg': ['a9ec552d8f0eb5b5d8846623e5b98ca46fce2ad4533f74301e6dbcae9cf3e3d2', 689],
  'pool/main/make/make_4.4.1-1_aarch64.deb': ['466531ed242215361f3bf18dc995d9b3358dd422b71db2c6addeedf17f2b563f', 249704],
});
function assertNoLinks(file) {
  let current = path.resolve(file);
  while (true) {
    if (fs.existsSync(current) || (() => { try { return fs.lstatSync(current).isSymbolicLink(); } catch { return false; } })()) {
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`Candidate asset symlink rejected: ${current}`);
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}
function stageCandidateProbeAssets(projectRoot, androidAssetsRoot) {
  const srcRoot = path.resolve(projectRoot, ASSET_DIR);
  const dstRoot = path.resolve(androidAssetsRoot, 'candidate-probe');
  assertUniqueCandidateAssetPaths(Object.keys(FILES));
  assertNoLinks(srcRoot);
  assertNoLinks(dstRoot);
  // Validate the entire source allowlist before touching generated output.
  const data = new Map();
  for (const [rel, [hash, size]] of Object.entries(FILES)) {
    const source = path.join(srcRoot, rel);
    assertNoLinks(source);
    const stat = fs.lstatSync(source);
    if (!stat.isFile() || stat.size !== size) throw new Error(`Candidate asset size/type mismatch: ${rel}`);
    const bytes = fs.readFileSync(source);
    if (crypto.createHash('sha256').update(bytes).digest('hex') !== hash) throw new Error(`Candidate asset SHA-256 mismatch: ${rel}`);
    data.set(rel, bytes);
  }
  const visit = (directory, prefix = '') => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const rel = prefix + entry.name;
      if (entry.isSymbolicLink()) throw new Error(`Candidate asset symlink rejected: ${rel}`);
      if (entry.isDirectory()) visit(path.join(directory, entry.name), rel + '/');
      else if (!entry.isFile() || !data.has(rel)) throw new Error(`Unlisted candidate asset: ${rel}`);
    }
  };
  visit(srcRoot);
  if (fs.existsSync(dstRoot)) fs.rmSync(dstRoot, { recursive: true });
  fs.mkdirSync(dstRoot, { recursive: true });
  for (const [rel, bytes] of data) {
    const target = path.join(dstRoot, candidateAssetPath(rel));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 });
  }
  return dstRoot;
}

function candidateProbeKotlin(pkg) {
  if (pkg !== PACKAGE_ID) throw new Error('Candidate probe is pinned to com.karat.aibuilder');
  const entries = Object.entries(FILES).map(([rel, [sha, size]]) => `        "${rel}" to Pair("${sha}", ${size}L),`).join('\n');
  return `package ${pkg}

import android.content.Context
import android.os.Build
import android.os.Process
import android.system.Os
import android.system.OsConstants
import java.io.File
import java.io.FileOutputStream
import java.security.MessageDigest
import java.util.UUID

/** Copies only immutable test evidence. Never executes a command or changes usr/APT. */
object AibCandidateFeedProbe {
${candidateAssetPathKotlin}
    private val pinned = linkedMapOf(
${entries}
    )
    private fun privateDirectory(directory: File, root: File) {
        require(directory.isDirectory && directory.canonicalFile == directory.absoluteFile) { "candidate_directory_invalid" }
        val st = Os.lstat(directory.path)
        require((st.st_mode and OsConstants.S_IFMT) == OsConstants.S_IFDIR && st.st_uid == Process.myUid()) { "candidate_directory_owner_invalid" }
        require(directory == root || directory.path.startsWith(root.path + File.separator)) { "candidate_directory_escape" }
    }
    private fun mkdir(directory: File, root: File) {
        if (!directory.exists()) require(directory.mkdir()) { "candidate_directory_create_failed" }
        privateDirectory(directory, root)
    }
    @JvmStatic @Synchronized fun stage(context: Context): String {
        require(context.packageName == "com.karat.aibuilder") { "candidate_package_invalid" }
        require(Build.SUPPORTED_ABIS.firstOrNull() == "arm64-v8a") { "candidate_arch_invalid" }
        val rawFiles = context.filesDir.absoluteFile
        val files = rawFiles.canonicalFile
        // Android's /data/data alias may resolve to /data/user/0; only Context supplies this root.
        require((Os.lstat(rawFiles.path).st_mode and OsConstants.S_IFMT) == OsConstants.S_IFDIR) { "candidate_files_symlink" }
        privateDirectory(files, files)
        privateDirectory(File(files, "usr"), files)
        privateDirectory(File(files, "home"), files)
        val parent = File(files, "candidate-probes")
        mkdir(parent, files)
        require((parent.listFiles() ?: throw IllegalStateException("candidate_evidence_unreadable")).size < 10) { "candidate_evidence_limit" }
        val root = File(parent, "probe-" + UUID.randomUUID().toString())
        require(root.mkdir()) { "candidate_root_create_failed" }
        privateDirectory(root, files)
        val feed = File(root, "feed")
        mkdir(feed, files)
        for ((rel, expected) in pinned) {
            val out = File(if (rel == "probe.sh" || rel == "install-make.sh") root else feed, rel)
            var directory = out.parentFile ?: throw IllegalStateException("candidate_parent_missing")
            val missing = mutableListOf<File>()
            while (!directory.exists()) { missing.add(directory); directory = directory.parentFile ?: throw IllegalStateException("candidate_parent_escape") }
            privateDirectory(directory, files)
            for (part in missing.asReversed()) mkdir(part, files)
            require(!out.exists()) { "candidate_output_exists" }
            context.assets.open("candidate-probe/" + assetPath(rel)).use { input ->
                FileOutputStream(out).use { output ->
                    val digest = MessageDigest.getInstance("SHA-256")
                    val buffer = ByteArray(32768)
                    var count = 0L
                    while (true) {
                        val size = input.read(buffer)
                        if (size < 0) break
                        count += size
                        require(count <= expected.second) { "candidate_asset_size_invalid" }
                        digest.update(buffer, 0, size)
                        output.write(buffer, 0, size)
                    }
                    output.fd.sync()
                    val hash = digest.digest().joinToString("") { "%02x".format(it) }
                    require(count == expected.second && hash == expected.first) { "candidate_asset_pin_invalid" }
                }
            }
            require(out.length() == expected.second && out.canonicalFile == out.absoluteFile) { "candidate_output_invalid" }
        }
        // Failed partial evidence is retained too; nothing outside this fresh child is removed.
        return root.canonicalPath
    }
}
`;
}
module.exports = { candidateProbeKotlin, stageCandidateProbeAssets };
