#!/usr/bin/env python3
"""Handoff metadata unit tests only: no package installation or device claims."""
import datetime
import email.utils
import gzip
import hashlib
import importlib.util
import pathlib
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("device_handoff", ROOT / "scripts/stage-device-test-artifact.py")
HANDOFF = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(HANDOFF)


class ReleaseBindingTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.feed = pathlib.Path(self.tmp.name)
        self.dist = self.feed / "dists/stable"
        index = self.dist / "main/binary-aarch64/Packages"
        index.parent.mkdir(parents=True)
        index.write_bytes(b"unit-test-index-not-an-installable-feed\n")
        index.with_suffix(".gz").write_bytes(gzip.compress(index.read_bytes(), mtime=0))
        now = datetime.datetime.now(datetime.timezone.utc)
        self.fields = {
            "Origin": "AI Builder Termux", "Label": "termux-main", "Suite": "stable",
            "Codename": "stable", "Architectures": "aarch64", "Components": "main",
            "Date": email.utils.format_datetime(now - datetime.timedelta(minutes=1)),
            "Valid-Until": email.utils.format_datetime(now + datetime.timedelta(days=1)),
        }
        self.rows = []
        for rel in ("main/binary-aarch64/Packages", "main/binary-aarch64/Packages.gz"):
            data = (self.dist / rel).read_bytes()
            self.rows.append(f" {hashlib.sha256(data).hexdigest()} {len(data)} {rel}")
        self.write_release()

    def write_release(self):
        text = "".join(f"{k}: {v}\n" for k, v in self.fields.items())
        text += "SHA256:\n" + "\n".join(self.rows) + "\n"
        for path in (self.feed / "Release", self.dist / "Release"):
            path.write_text(text, encoding="utf-8")

    def check(self):
        HANDOFF.verify_release_indices(self.feed, self.dist)

    def rejects(self, code):
        with self.assertRaisesRegex(HANDOFF.StageError, "^" + code + "$"):
            self.check()

    def test_exact_indices_accept(self):
        self.check()

    def test_uncompressed_tampering(self):
        with (self.dist / "main/binary-aarch64/Packages").open("ab") as out:
            out.write(b"modified\n")
        self.rejects("SIGNED_INDEX_HASH_MISMATCH")

    def test_gzip_tampering_even_same_plaintext(self):
        path = self.dist / "main/binary-aarch64/Packages.gz"
        path.write_bytes(gzip.compress(gzip.decompress(path.read_bytes()), mtime=1))
        self.rejects("SIGNED_INDEX_HASH_MISMATCH")

    def test_size_mismatch(self):
        parts = self.rows[0].split()
        parts[1] = str(int(parts[1]) + 1)
        self.rows[0] = " " + " ".join(parts)
        self.write_release()
        self.rejects("SIGNED_INDEX_HASH_MISMATCH")

    def test_root_release_mismatch(self):
        (self.feed / "Release").write_bytes(b"different release\n")
        self.rejects("ROOT_RELEASE_MISMATCH")

    def test_duplicate_index(self):
        self.rows.append(self.rows[0])
        self.write_release()
        self.rejects("RELEASE_DUPLICATE_INDEX")

    def test_missing_index(self):
        self.rows.pop()
        self.write_release()
        self.rejects("RELEASE_INDEX_ALLOWLIST_MISMATCH")

    def test_extra_and_traversal_indices(self):
        for name in ("extra", "../Packages", "/tmp/Packages", "main/binary-amd64/Packages"):
            with self.subTest(name=name):
                original = self.rows[:]
                self.rows.append(" " + "0" * 64 + " 1 " + name)
                self.write_release()
                self.rejects("RELEASE_INDEX_ALLOWLIST_MISMATCH")
                self.rows = original

    def test_malformed_hash_and_size(self):
        for row in (" bad 1 main/binary-aarch64/Packages", " " + "0" * 64 + " -1 x", " invalid"):
            with self.subTest(row=row):
                self.rows = [row]
                self.write_release()
                self.rejects("RELEASE_SHA256_ENTRY_INVALID")

    def test_identity_mismatches(self):
        for field in ("Origin", "Label", "Suite", "Codename", "Architectures", "Components"):
            with self.subTest(field=field):
                original = self.fields[field]
                self.fields[field] = "untrusted"
                self.write_release()
                self.rejects("RELEASE_IDENTITY_MISMATCH")
                self.fields[field] = original

    def test_expired_release(self):
        now = datetime.datetime.now(datetime.timezone.utc)
        self.fields["Date"] = email.utils.format_datetime(now - datetime.timedelta(days=2))
        self.fields["Valid-Until"] = email.utils.format_datetime(now - datetime.timedelta(days=1))
        self.write_release()
        self.rejects("RELEASE_EXPIRED_OR_FUTURE_DATED")

    def test_future_release(self):
        now = datetime.datetime.now(datetime.timezone.utc)
        self.fields["Date"] = email.utils.format_datetime(now + datetime.timedelta(hours=1))
        self.write_release()
        self.rejects("RELEASE_EXPIRED_OR_FUTURE_DATED")

    def test_expiry_before_date(self):
        self.fields["Valid-Until"] = self.fields["Date"]
        self.write_release()
        self.rejects("RELEASE_EXPIRED_OR_FUTURE_DATED")

    def test_dates_must_be_parseable_and_timezone_aware(self):
        for value, code in (("not a date", "RELEASE_DATE_INVALID"),
                            ("Sun, 18 Oct 2026 00:00:00", "RELEASE_DATE_TIMEZONE_REQUIRED")):
            with self.subTest(value=value):
                self.fields["Date"] = value
                self.write_release()
                self.rejects(code)

    def test_duplicate_sha256_section(self):
        for path in (self.feed / "Release", self.dist / "Release"):
            with path.open("a") as out:
                out.write("SHA256:\n" + self.rows[0] + "\n")
        self.rejects("INDEX_MALFORMED_OR_DUPLICATE_FIELD")


if __name__ == "__main__":
    unittest.main()
