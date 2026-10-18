#!/usr/bin/env python3
"""Exercise multi-root exact APT simulation against an ephemeral signed local feed."""
import os
import pathlib
import shutil
import subprocess
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
HELPER = ROOT / "scripts/test-apt-candidate.sh"


class AggregateAptRootsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        required = ("gpg", "gpgv", "dpkg-deb", "dpkg-scanpackages", "apt-get", "apt-cache", "gzip", "sha256sum")
        missing = [tool for tool in required if shutil.which(tool) is None]
        if missing:
            raise unittest.SkipTest("required tools unavailable: " + ", ".join(missing))
        cls.temp = tempfile.TemporaryDirectory(prefix="aggregate-apt-roots-")
        cls.base = pathlib.Path(cls.temp.name)
        cls.config = cls.base / "config"
        cls.feed = cls.base / "feed"
        cls.env = os.environ.copy()
        cls.env["AIB_TERMUX_FEED_SIGNING_CONFIG_ROOT"] = str(cls.config)
        cls.env["GNUPGHOME"] = str(cls.config / "gnupg")
        cls.env["AIB_APT_EXPECT_EXACT_SOURCE_CLOSURE"] = "1"
        subprocess.run([str(ROOT / "scripts/create-ephemeral-feed-signing-key.sh"), str(cls.config)],
                       check=True, cwd=ROOT, env=cls.env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        packages = {
            "aggregate-root-a": "Depends: aggregate-shared (= 1.0)\n",
            "aggregate-root-c": "Depends: aggregate-shared (= 1.0)\n",
            "aggregate-root-d": "Depends: aggregate-shared (= 1.0)\n",
            "aggregate-shared": "",
        }
        for name, dependency in packages.items():
            package_root = cls.base / ("pkg-" + name)
            control_dir = package_root / "DEBIAN"
            control_dir.mkdir(parents=True)
            architecture = "all" if name == "aggregate-root-c" else "amd64"
            (control_dir / "control").write_text(
                f"Package: {name}\nVersion: 1.0\nArchitecture: {architecture}\n"
                "Maintainer: Test <test@example.invalid>\n"
                f"{dependency}Description: disposable aggregate-root fixture\n",
                encoding="utf-8")
            pooldir = cls.feed / "pool/main/aggregate-test"
            pooldir.mkdir(parents=True, exist_ok=True)
            subprocess.run(["dpkg-deb", "--build", "--root-owner-group", str(package_root),
                            str(pooldir / f"{name}_1.0_{architecture}.deb")], check=True,
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        index_dir = cls.feed / "dists/stable/main/binary-amd64"
        index_dir.mkdir(parents=True)
        with (index_dir / "Packages").open("w", encoding="utf-8") as index:
            subprocess.run(["dpkg-scanpackages", "-m", "pool", "/dev/null"], cwd=cls.feed,
                           check=True, stdout=index, stderr=subprocess.PIPE, text=True)
        with (index_dir / "Packages").open("rb") as source, (index_dir / "Packages.gz").open("wb") as compressed:
            subprocess.run(["gzip", "-n", "-9c"], stdin=source, stdout=compressed, check=True)
        subprocess.run([str(ROOT / "scripts/create-signed-feed-release.sh"), str(cls.feed), "amd64"],
                       check=True, cwd=ROOT, env=cls.env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)

    @classmethod
    def tearDownClass(cls):
        if hasattr(cls, "temp"):
            cls.temp.cleanup()

    def invoke(self, *args):
        return subprocess.run(["bash", str(HELPER), str(self.feed), "amd64", "aggregate-root-a", "1.0",
                               "4", "amd64", *args], cwd=ROOT, env=self.env,
                              text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=90)

    def test_three_pinned_roots_and_shared_dependency_are_simulated_only(self):
        result = self.invoke("aggregate-root-c=1.0", "aggregate-root-d=1.0")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("APT_SIMULATED_EXACT_SOURCE_CLOSURE_OK packages=4", result.stdout)
        self.assertIn("roots=3", result.stdout)
        for package in ("aggregate-root-a", "aggregate-root-c", "aggregate-root-d", "aggregate-shared"):
            query = subprocess.run(["dpkg-query", "-W", "-f=${db:Status-Status}", package],
                                   text=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
            self.assertNotEqual(query.returncode, 0, package + " unexpectedly installed")

    def test_all_primary_root_requires_explicit_all_architecture(self):
        result = subprocess.run(["bash", str(HELPER), str(self.feed), "amd64", "aggregate-root-c", "1.0",
                                 "4", "all", "aggregate-root-a=1.0", "aggregate-root-d=1.0"],
                                cwd=ROOT, env=self.env, text=True, capture_output=True, timeout=90)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("roots=3", result.stdout)

    def test_wrong_explicit_primary_architecture_still_rejected(self):
        result = subprocess.run(["bash", str(HELPER), str(self.feed), "amd64", "aggregate-root-c", "1.0",
                                 "4", "amd64", "aggregate-root-a=1.0", "aggregate-root-d=1.0"],
                                cwd=ROOT, env=self.env, text=True, capture_output=True, timeout=90)
        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
        self.assertIn("APT_PACKAGE_ARCHITECTURE_MISMATCH", result.stderr)

    def test_duplicate_additional_root_rejected_before_apt(self):
        result = self.invoke("aggregate-root-c=1.0", "aggregate-root-c=1.0")
        self.assertEqual(result.returncode, 2)
        self.assertIn("ADDITIONAL_ROOT_DUPLICATE_NAME", result.stderr)
        self.assertNotIn("APT_UPDATE_REJECTED", result.stderr)

    def test_invalid_additional_specs_rejected(self):
        for spec in ("aggregate-root-a=1.0", "aggregate-unversioned", "--allow-unauthenticated",
                     "", "aggregate-root-c=", "aggregate-root-c>=1.0"):
            with self.subTest(spec=spec):
                result = self.invoke(spec)
                expected = "ADDITIONAL_ROOT_DUPLICATES_PRIMARY" if spec.startswith("aggregate-root-a=") else "ADDITIONAL_ROOT_SPEC_INVALID"
                self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
                self.assertIn(expected, result.stderr)

    def test_missing_dependency_is_rejected(self):
        deb = self.feed / "pool/main/aggregate-test/aggregate-shared_1.0_amd64.deb"
        deb.unlink()
        index_dir = self.feed / "dists/stable/main/binary-amd64"
        with (index_dir / "Packages").open("w", encoding="utf-8") as index:
            subprocess.run(["dpkg-scanpackages", "-m", "pool", "/dev/null"], cwd=self.feed,
                           check=True, stdout=index, stderr=subprocess.PIPE, text=True)
        with (index_dir / "Packages").open("rb") as source, (index_dir / "Packages.gz").open("wb") as compressed:
            subprocess.run(["gzip", "-n", "-9c"], stdin=source, stdout=compressed, check=True)
        subprocess.run([str(ROOT / "scripts/create-signed-feed-release.sh"), str(self.feed), "amd64"],
                       check=True, cwd=ROOT, env=self.env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        result = self.invoke("aggregate-root-c=1.0", "aggregate-root-d=1.0")
        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
        self.assertIn("APT_SIMULATED_INSTALL_REJECTED", result.stderr)
        package_root = self.base / "pkg-aggregate-shared"
        deb.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(["dpkg-deb", "--build", "--root-owner-group", str(package_root), str(deb)],
                       check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        with (index_dir / "Packages").open("w", encoding="utf-8") as index:
            subprocess.run(["dpkg-scanpackages", "-m", "pool", "/dev/null"], cwd=self.feed,
                           check=True, stdout=index, stderr=subprocess.PIPE, text=True)
        with (index_dir / "Packages").open("rb") as source, (index_dir / "Packages.gz").open("wb") as compressed:
            subprocess.run(["gzip", "-n", "-9c"], stdin=source, stdout=compressed, check=True)
        subprocess.run([str(ROOT / "scripts/create-signed-feed-release.sh"), str(self.feed), "amd64"],
                       check=True, cwd=ROOT, env=self.env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)


if __name__ == "__main__":
    unittest.main()
