#!/usr/bin/env python3
"""Synthetic metadata/signature tests only; these fixtures are not Android observations."""
import hashlib
import importlib.util
import json
import pathlib
import shutil
import subprocess
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("android_qualification", ROOT / "scripts/validate-android-qualification.py")
V = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(V)

@unittest.skipUnless(shutil.which("gpg") and shutil.which("gpgv"), "GnuPG unavailable")
class QualificationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = pathlib.Path(self.tmp.name)
        self.root = self.base / "artifacts"; self.root.mkdir()
        self.evidence = self.base / "evidence.json"
        self.manifest = self.base / "manifest.json"
        self.manifest.write_bytes((ROOT / "candidate-package-set.json").read_bytes())
        self.home = self.base / "gnupg"; self.home.mkdir(mode=0o700)
        subprocess.run(["gpg", "--batch", "--homedir", str(self.home), "--passphrase", "", "--quick-generate-key", "Evidence Unit Test <evidence@example.invalid>", "ed25519", "sign", "0"], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.keyring = self.base / "trusted.gpg"
        with self.keyring.open("wb") as key_out:
            subprocess.run(["gpg", "--batch", "--homedir", str(self.home), "--export", "Evidence Unit Test"], check=True, stdout=key_out)
        out = subprocess.run(["gpg", "--batch", "--homedir", str(self.home), "--with-colons", "--fingerprint", "Evidence Unit Test"], check=True, capture_output=True, text=True).stdout
        self.fingerprint = next(line.split(":")[9] for line in out.splitlines() if line.startswith("fpr:"))
        subprocess.run(["gpg", "--batch", "--homedir", str(self.home), "--passphrase", "", "--quick-generate-key", "Feed Unit Test <feed@example.invalid>", "ed25519", "sign", "0"], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        out = subprocess.run(["gpg", "--batch", "--homedir", str(self.home), "--with-colons", "--fingerprint", "Feed Unit Test"], check=True, capture_output=True, text=True).stdout
        self.feed_fingerprint = next(line.split(":")[9] for line in out.splitlines() if line.startswith("fpr:"))
        self.feed_key = subprocess.run(["gpg", "--batch", "--homedir", str(self.home), "--export", "Feed Unit Test"], check=True, capture_output=True).stdout
        self.e = self.fixture()
        self.write_signed()

    def put(self, name, data):
        p = self.root / name; p.parent.mkdir(parents=True, exist_ok=True); p.write_bytes(data)
        return {"path": name, "sha256": hashlib.sha256(data).hexdigest()}

    def fixture(self):
        dummy = self.put("apk.bin", b"synthetic APK bytes, not installable")
        kr = self.put("feed/keyring", self.feed_key)
        release = self.put("feed/Release", b"Release fixture")
        inrel = self.put("feed/InRelease", b"InRelease fixture")
        log = self.put("logs/test.log", b"synthetic command record")
        snap0 = self.put("snapshots/source", b"source tree snapshot")
        base = self.put("snapshots/base", b"package baseline")
        snap1 = self.put("snapshots/upgrade", b"snapshot upgraded")
        snap2 = self.put("snapshots/rollback", b"snapshot rolled back")
        def check(stamp=__import__("datetime").datetime.now(__import__("datetime").timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"), before=None, after=None):
            x = {"status": "PASS", "timestamp": stamp, "commands": [{"command": "synthetic placeholder", "exitCode": 0, "log": log}]}
            if before: x.update(beforeSnapshot=before, afterSnapshot=after)
            return x
        return {"schemaVersion": 1, "applicationId": "com.karat.aibuilder",
                "candidateManifestSha256": hashlib.sha256(self.manifest.read_bytes()).hexdigest(),
                "apk": {"artifact": dummy, "signingCertificateSha256": "a"*64, "versionName": "1.0"},
                "device": {"apiLevel": 34, "abi": "aarch64", "buildFingerprint": "synthetic/build/fingerprint", "observedDataDir": "/data/user/10/com.karat.aibuilder", "observedPrefix": "/data/user/10/com.karat.aibuilder/files/usr"},
                "feed": {"url": "https://example.invalid/termux", "keyFingerprint": self.feed_fingerprint, "keyring": kr, "release": release, "inRelease": inrel},
                "projectSourceSnapshot": snap0,
                "checks": {"install": check(), "runtime": check(), "projectBuild": check(), "upgrade": check(before=base, after=snap1), "rollback": check(before=snap1, after=base)}}

    def write_signed(self):
        self.evidence.write_text(json.dumps(self.e, separators=(",", ":")) + "\n")
        self.signature = self.base / "evidence.sig"
        self.signature.unlink(missing_ok=True)
        subprocess.run(["gpg", "--batch", "--homedir", str(self.home), "--local-user", self.fingerprint, "--detach-sign", "--output", str(self.signature), str(self.evidence)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    def validate(self):
        args = type("Args", (), {"evidence": self.evidence, "artifact_root": self.root, "candidate_manifest": self.manifest, "trusted_keyring": self.keyring, "expected_fingerprint": self.fingerprint, "signature": self.signature})
        V.validate(args)

    def test_consistent_bundle_accepted_but_is_only_claim(self):
        self.validate()  # Signature authenticates a claim; this synthetic test is not device proof.

    def reject(self, code):
        with self.assertRaisesRegex(V.EvidenceError, "^" + code + "$`?"):
            self.validate()

    def test_duplicate_json_key_rejected(self):
        self.evidence.write_text('{"schemaVersion":1,"schemaVersion":1}')
        with self.assertRaisesRegex(V.EvidenceError, "JSON_DUPLICATE_KEY"):
            V.load(self.evidence)

    def test_unsigned_or_modified_evidence_rejected(self):
        self.evidence.write_text(self.evidence.read_text() + " ")
        self.reject("SIGNATURE_VERIFICATION_FAILED")

    def test_unexpected_top_level_key_rejected(self):
        self.e["publicKey"] = "untrusted"
        self.write_signed(); self.reject("EVIDENCE_KEYS_INVALID")

    def test_feed_url_credentials_rejected(self):
        self.e["feed"]["url"] = "https://u:p@example.invalid/feed"
        self.write_signed(); self.reject("FEED_URL_INVALID")

    def test_log_hash_mismatch_rejected(self):
        self.e["checks"]["runtime"]["commands"][0]["log"]["sha256"] = "0"*64
        self.write_signed(); self.reject("ARTIFACT_HASH_MISMATCH")

    def test_symlink_artifact_rejected(self):
        (self.root / "linked").symlink_to(self.root / "apk.bin")
        self.e["apk"]["artifact"]["path"] = "linked"
        self.e["apk"]["artifact"]["sha256"] = hashlib.sha256((self.root / "apk.bin").read_bytes()).hexdigest()
        self.write_signed(); self.reject("ARTIFACT_SYMLINK_REJECTED")

    def test_wrong_expected_primary_fingerprint_rejected(self):
        args = type("Args", (), {"evidence": self.evidence, "artifact_root": self.root, "candidate_manifest": self.manifest, "trusted_keyring": self.keyring, "expected_fingerprint": "0"*40, "signature": self.signature})
        with self.assertRaisesRegex(V.EvidenceError, "SIGNER_FINGERPRINT_MISMATCH"): V.validate(args)

    def test_each_required_check_missing_rejected(self):
        for name in ("install", "runtime", "projectBuild", "upgrade", "rollback"):
            with self.subTest(check=name):
                original = self.e["checks"].pop(name)
                self.write_signed(); self.reject("CHECK_SET_INVALID")
                self.e["checks"][name] = original

    def test_nonzero_exit_rejected(self):
        self.e["checks"]["runtime"]["commands"][0]["exitCode"] = 1
        self.write_signed(); self.reject("COMMAND_FAILED")

    def test_not_run_rejected(self):
        self.e["checks"]["install"]["status"] = "NOT_RUN"
        self.write_signed(); self.reject("CHECK_NOT_PASS")

    def test_wrong_candidate_hash_rejected(self):
        self.e["candidateManifestSha256"] = "0"*64
        self.write_signed(); self.reject("CANDIDATE_MANIFEST_HASH_MISMATCH")

    def test_wrong_candidate_target_rejected(self):
        m=json.loads(self.manifest.read_text()); m["target"]["architecture"]="x86_64"
        self.manifest.write_text(json.dumps(m)+"\n"); self.e["candidateManifestSha256"]=hashlib.sha256(self.manifest.read_bytes()).hexdigest()
        self.write_signed(); self.reject("CANDIDATE_TARGET_INVALID")

    def test_manifest_boolean_schema_rejected(self):
        m=json.loads(self.manifest.read_text()); m["schemaVersion"]=True
        self.manifest.write_text(json.dumps(m)+"\n"); self.e["candidateManifestSha256"]=hashlib.sha256(self.manifest.read_bytes()).hexdigest()
        self.write_signed(); self.reject("CANDIDATE_MANIFEST_INVALID")

    def test_source_artifact_hash_enforced(self):
        self.e["projectSourceSnapshot"]["sha256"]="0"*64
        self.write_signed(); self.reject("ARTIFACT_HASH_MISMATCH")

    def test_path_traversal_rejected(self):
        self.e["apk"]["artifact"]["path"]="../outside"
        self.write_signed(); self.reject("ARTIFACT_PATH_INVALID")

    def test_parent_symlink_rejected(self):
        (self.root/"linked-dir").symlink_to(self.root/"snapshots",target_is_directory=True)
        self.e["apk"]["artifact"]={"path":"linked-dir/base","sha256":"0"*64}
        self.write_signed(); self.reject("ARTIFACT_SYMLINK_REJECTED")

    def test_invalid_and_future_timestamps_rejected(self):
        self.e["checks"]["install"]["timestamp"]="2026-02-30T00:00:00Z"
        self.write_signed(); self.reject("CHECK_TIMESTAMP_INVALID")
        self.e["checks"]["install"]["timestamp"]="2999-01-01T00:00:00Z"
        self.write_signed(); self.reject("CHECK_TIMESTAMP_FUTURE")

    def test_identical_snapshots_rejected(self):
        self.e["checks"]["upgrade"]["afterSnapshot"]=self.e["checks"]["upgrade"]["beforeSnapshot"]
        self.write_signed(); self.reject("SNAPSHOTS_NOT_DISTINCT")

    def test_rollback_must_follow_upgrade_not_source(self):
        self.e["checks"]["rollback"]["beforeSnapshot"]=self.e["projectSourceSnapshot"]
        self.write_signed(); self.reject("ROLLBACK_BASELINE_MISMATCH")

    def test_bad_snapshot_relation_rejected(self):
        self.e["checks"]["rollback"]["beforeSnapshot"] = self.e["checks"]["install"]["commands"][0]["log"]
        self.write_signed(); self.reject("ROLLBACK_BASELINE_MISMATCH")

    def test_rollback_must_restore_original_baseline(self):
        self.e["checks"]["rollback"]["afterSnapshot"] = self.e["projectSourceSnapshot"]
        self.write_signed(); self.reject("ROLLBACK_RESTORE_MISMATCH")

    def test_feed_fingerprint_must_match_keyring(self):
        self.e["feed"]["keyFingerprint"] = "0" * 40
        self.write_signed(); self.reject("FEED_KEYRING_FINGERPRINT_MISMATCH")

if __name__ == "__main__":
    unittest.main()
