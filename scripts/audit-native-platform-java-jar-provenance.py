#!/usr/bin/env python3
"""Build and provenance-audit native-platform's Java API JAR (isolated CI only).

This script never invokes the upstream wrapper and never creates a package/feed.
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import html
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.parse
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path
from typing import Any

UPSTREAM_REPO = "https://github.com/gradle/native-platform.git"
UPSTREAM_TAG = "0.22-milestone-29"
UPSTREAM_COMMIT = "e999afaf8692fb66e9016e0a3b0519a05981753e"
UPSTREAM_TREE = "5995e83b24d7dab4e712be7a1586e131e57bc301"
UPSTREAM_LICENSE = "Apache-2.0"
WRAPPER_GRADLE_URL = "https://services.gradle.org/distributions/gradle-8.14.3-bin.zip"
GRADLE_URL = WRAPPER_GRADLE_URL
GRADLE_VERSION = "8.14.3"
GRADLE_SHA256 = "bd71102213493060956ec229d946beee57158dbd89d0e62b91bca0fa2c5f3531"
GRADLE_SHA256_URL = GRADLE_URL + ".sha256"
GRADLE_DIST_SOURCE = "https://services.gradle.org/distributions/gradle-9.8.2-bin.zip"
GRADLE_DIST_SHA256 = "9928e360dc0832a3ddc39d705ff1728bc75667c846fda5660d448ac85cb91814"
GRADLE_DIST_BYTES = 151_620_051
MAVEN_BASE = "https://repo.gradle.org/gradle/libs-releases/net/rubygrapefruit/native-platform/0.22-milestone-29"
JAR_NAME = "native-platform-0.22-milestone-29.jar"
PUBLISHED_JAR_SHA256 = "e276d15c665280391f17720031680e16c42e0ae2ec1b57b1e89cca5ced10d12b"
GRADLE_SIGNING_KEY_FINGERPRINT = "1BD97A6A154E7810EE0BC832E2F38302C8075E3D"
GRADLE_SIGNING_KEY_ID = "E2F38302C8075E3D"
GRADLE_SIGNING_KEY_URL = (
    "https://keyserver.ubuntu.com/pks/lookup?op=get&search=0x"
    + GRADLE_SIGNING_KEY_FINGERPRINT
)
GRADLE_KEYS_REFERENCE = "https://gradle.org/keys/"
GRADLE_KEY_RETIRED_DATE = "2026-08-08"
GRADLE_KEY_ACTIVE_FROM = "2022-12-29"
EXPECTED_DIST_JAR_PATH = "gradle-9.8.2/lib/" + JAR_NAME


class AuditError(RuntimeError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def atomic_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    temp.replace(path)


def parse_checksum_sidecar(path: Path) -> str:
    text = path.read_text(encoding="ascii", errors="strict")
    matches = re.findall(r"(?i)(?<![0-9a-f])[0-9a-f]{64}(?![0-9a-f])", text)
    if len(matches) != 1:
        raise AuditError("CHECKSUM_SIDECAR_UNPARSEABLE", f"Expected one SHA-256 digest in {path.name}; found {len(matches)}")
    return matches[0].lower()


def jar_entry_map(path: Path) -> dict[str, dict[str, Any]]:
    try:
        with zipfile.ZipFile(path) as archive:
            infos = archive.infolist()
            names = [info.filename for info in infos if not info.is_dir()]
            if len(names) != len(set(names)):
                raise AuditError("JAR_DUPLICATE_ENTRIES", f"Duplicate entry names in {path.name}")
            bad = archive.testzip()
            if bad is not None:
                raise AuditError("JAR_CRC_FAILURE", f"CRC failure in {path.name}:{bad}")
            result: dict[str, dict[str, Any]] = {}
            for info in infos:
                if info.is_dir():
                    continue
                data = archive.read(info.filename)
                result[info.filename] = {
                    "sha256": hashlib.sha256(data).hexdigest(),
                    "sizeBytes": len(data),
                    "compressedSizeBytes": info.compress_size,
                    "compression": info.compress_type,
                    "timestamp": list(info.date_time),
                    "externalAttributes": info.external_attr,
                }
            return result
    except zipfile.BadZipFile as exc:
        raise AuditError("JAR_NOT_VALID_ZIP", f"{path.name} is not a valid ZIP/JAR: {exc}") from exc


def compare_jars(left: Path, right: Path) -> dict[str, Any]:
    left_entries = jar_entry_map(left)
    right_entries = jar_entry_map(right)
    left_names, right_names = set(left_entries), set(right_entries)
    differing = sorted(
        name for name in (left_names & right_names)
        if left_entries[name]["sha256"] != right_entries[name]["sha256"]
    )
    left_only = sorted(left_names - right_names)
    right_only = sorted(right_names - left_names)
    metadata_only = sorted(
        name for name in (left_names & right_names)
        if left_entries[name]["sha256"] == right_entries[name]["sha256"]
        and any(
            left_entries[name][field] != right_entries[name][field]
            for field in ("timestamp", "compression", "externalAttributes")
        )
    )
    same_tree = not differing and not left_only and not right_only
    return {
        "left": left.name,
        "right": right.name,
        "byteIdentical": sha256(left) == sha256(right),
        "normalizedEntryContentIdentical": same_tree,
        "leftEntryCount": len(left_entries),
        "rightEntryCount": len(right_entries),
        "leftOnlyEntries": left_only,
        "rightOnlyEntries": right_only,
        "contentDifferingEntries": differing,
        "metadataDifferingEntries": metadata_only,
        "metadataOnlyContainerDifference": same_tree and sha256(left) != sha256(right),
        "leftSha256": sha256(left),
        "rightSha256": sha256(right),
    }


class Audit:
    def __init__(self, output: Path, work: Path):
        self.output = output.resolve()
        self.work = work.resolve()
        if self.output.exists():
            shutil.rmtree(self.output)
        if self.work.exists():
            shutil.rmtree(self.work)
        self.output.mkdir(parents=True)
        self.work.mkdir(parents=True)
        self.logs = self.output / "logs"
        self.logs.mkdir()
        self.status = "RUNNING"
        self.data: dict[str, Any] = {
            "schemaVersion": 1,
            "experiment": "native-platform-java-api-jar-source-provenance-audit",
            "classification": "ISOLATED_CI_EXPERIMENT_ONLY",
            "outcome": "RUNNING",
            "source": {
                "repository": UPSTREAM_REPO,
                "tag": UPSTREAM_TAG,
                "expectedCommit": UPSTREAM_COMMIT,
                "expectedTree": UPSTREAM_TREE,
                "actualCommit": None,
                "actualTree": None,
                "cleanCheckoutBeforeBuild": False,
                "license": UPSTREAM_LICENSE,
            },
            "wrapper": {
                "propertiesPath": "gradle/wrapper/gradle-wrapper.properties",
                "distributionUrlExpected": WRAPPER_GRADLE_URL,
                "distributionSha256SumDeclared": None,
                "wrapperPropertiesSha256": None,
                "wrapperExecuted": False,
            },
            "bootstrap": {
                "distributionUrl": GRADLE_URL,
                "expectedVersion": GRADLE_VERSION,
                "expectedSha256": GRADLE_SHA256,
                "sidecarUrl": GRADLE_SHA256_URL,
                "actualSha256": None,
                "sidecarSha256": None,
                "verified": False,
                "explicitBinaryUsed": False,
                "versionOutput": None,
            },
            "build": {
                "javaExpectedMajor": 8,
                "javaVersionOutput": None,
                "command": None,
                "exitCode": None,
                "dependencyVerificationMode": "strict",
                "dependencyVerificationEnabled": True,
                "dependencyVerificationMetadataUsed": True,
                "jarPath": None,
                "jarSha256": None,
                "jarSizeBytes": None,
            },
            "verificationMetadata": {},
            "publishedArtifact": {
                "coordinate": "net.rubygrapefruit:native-platform:0.22-milestone-29",
                "repository": MAVEN_BASE,
                "jarSha256ExpectedFromOfficialSidecarAndPinnedSignature": PUBLISHED_JAR_SHA256,
                "jarSha256Actual": None,
                "jarSignature": {},
                "pomSha256": None,
            },
            "gradleDistributionInput": {
                "filename": "gradle-9.8.2-bin.zip",
                "url": GRADLE_DIST_SOURCE,
                "expectedSha256": GRADLE_DIST_SHA256,
                "expectedSizeBytes": GRADLE_DIST_BYTES,
                "actualSha256": None,
                "actualSizeBytes": None,
                "internalNativePlatformJarPath": EXPECTED_DIST_JAR_PATH,
                "internalNativePlatformJarSha256": None,
            },
            "comparison": {},
            "licenseAudit": {},
            "gates": {
                "packageCreated": False,
                "feedCreated": False,
                "candidateEligibilityChanged": False,
                "androidBionicRuntimeVerified": False,
                "deviceTestsRun": False,
                "productionAllowed": False,
            },
            "scopeDisclosure": [
                "This workflow builds and audits only the upstream Java API JAR; it does not create a .deb, feed, app APK, or package candidate.",
                "The explicit Gradle binary is used only after its official SHA-256 sidecar and pinned digest are checked; the upstream wrapper is inspected but never executed.",
                "Strict Gradle dependency verification is requested; the exact upstream verification metadata policy and coverage are recorded without weakening it.",
                "The Gradle distribution JAR comparison is against an independently SHA-256-verified host distribution, not Android/Bionic runtime proof.",
                "No Android/Bionic device test, package install, APT simulation, feed publication, or production qualification is performed.",
            ],
            "phases": {},
            "commands": [],
            "artifactFiles": {},
            "blocker": None,
        }
        self.write_evidence()

    def write_evidence(self) -> None:
        atomic_json(self.output / "evidence.json", self.data)

    def phase(self, name: str, status: str, **details: Any) -> None:
        self.data["phases"][name] = {"status": status, **details}
        self.write_evidence()
        print(f"[{status}] {name}", flush=True)

    def run(
        self,
        name: str,
        argv: list[str],
        cwd: Path | None = None,
        env: dict[str, str] | None = None,
        timeout: int = 900,
        check: bool = True,
    ) -> tuple[int, Path]:
        log_path = self.logs / f"{name}.log"
        record: dict[str, Any] = {
            "id": name,
            "argv": argv,
            "cwd": str(cwd) if cwd else None,
            "log": f"logs/{log_path.name}",
            "exitCode": None,
            "timeoutSeconds": timeout,
        }
        print(f"Running {name} (full output: {log_path.name})", flush=True)
        start = time.monotonic()
        try:
            with log_path.open("wb") as log_stream:
                process = subprocess.Popen(
                    argv,
                    cwd=str(cwd) if cwd else None,
                    env=env,
                    stdout=log_stream,
                    stderr=subprocess.STDOUT,
                )
                while True:
                    try:
                        rc = process.wait(timeout=min(60, max(1, timeout - int(time.monotonic() - start))))
                        break
                    except subprocess.TimeoutExpired:
                        elapsed = int(time.monotonic() - start)
                        if elapsed >= timeout:
                            process.kill()
                            process.wait()
                            raise TimeoutError(f"command exceeded {timeout}s")
                        print(f"[progress] {name} still running ({elapsed}s)", flush=True)
            record["exitCode"] = rc
            record["elapsedSeconds"] = round(time.monotonic() - start, 2)
        except Exception as exc:
            record["exception"] = f"{type(exc).__name__}: {exc}"
            record["elapsedSeconds"] = round(time.monotonic() - start, 2)
            self.data["commands"].append(record)
            self.write_evidence()
            if check:
                raise
            return 1, log_path
        self.data["commands"].append(record)
        self.write_evidence()
        if check and record["exitCode"] != 0:
            tail = "\n".join(log_path.read_text(encoding="utf-8", errors="replace").splitlines()[-60:])
            raise AuditError("COMMAND_FAILED", f"{name} exited {record['exitCode']}; see {log_path.name}\n{tail}")
        return int(record["exitCode"]), log_path

    def download(self, name: str, url: str, destination: Path, optional: bool = False) -> bool:
        destination.parent.mkdir(parents=True, exist_ok=True)
        rc, _ = self.run(
            name,
            ["curl", "--fail", "--location", "--silent", "--show-error", "--retry", "2",
             "--retry-all-errors", "--connect-timeout", "20", "--max-time", "900",
             "--output", str(destination), url],
            timeout=960,
            check=not optional,
        )
        if rc != 0:
            destination.unlink(missing_ok=True)
            return False
        return True

    def verify_source_and_wrapper(self) -> tuple[Path, Path]:
        source = self.work / "native-platform"
        self.run("clone_exact_tag", ["git", "clone", "--depth", "1", "--branch", UPSTREAM_TAG, UPSTREAM_REPO, str(source)], timeout=300)
        commit, _ = self.run("read_source_commit", ["git", "rev-parse", "HEAD"], cwd=source, timeout=30)
        tree, _ = self.run("read_source_tree", ["git", "rev-parse", "HEAD^{tree}"], cwd=source, timeout=30)
        actual_commit = (self.logs / "read_source_commit.log").read_text(encoding="utf-8").strip()
        actual_tree = (self.logs / "read_source_tree.log").read_text(encoding="utf-8").strip()
        status_rc, _ = self.run("verify_source_clean_checkout", ["git", "status", "--porcelain=v1"], cwd=source, timeout=30)
        status_text = (self.logs / "verify_source_clean_checkout.log").read_text(encoding="utf-8").strip()
        if status_rc != 0 or status_text:
            raise AuditError("SOURCE_CHECKOUT_NOT_CLEAN", "Pinned upstream checkout was not clean before build")
        self.data["source"].update({
            "actualCommit": actual_commit,
            "actualTree": actual_tree,
            "cleanCheckoutBeforeBuild": True,
            "gitStatusBeforeBuild": status_text,
        })
        if actual_commit != UPSTREAM_COMMIT or actual_tree != UPSTREAM_TREE:
            raise AuditError("UPSTREAM_REVISION_MISMATCH", f"Expected {UPSTREAM_COMMIT}/{UPSTREAM_TREE}, got {actual_commit}/{actual_tree}")
        wrapper_path = source / "gradle/wrapper/gradle-wrapper.properties"
        raw = wrapper_path.read_text(encoding="utf-8")
        props: dict[str, str] = {}
        for line in raw.splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            props[key.strip()] = value.strip().replace(r"\:", ":").replace(r"\=", "=")
        wrapper_url = props.get("distributionUrl")
        if wrapper_url != WRAPPER_GRADLE_URL:
            raise AuditError("WRAPPER_URL_UNEXPECTED", f"Pinned source wrapper URL is {wrapper_url!r}, expected {WRAPPER_GRADLE_URL}")
        self.data["wrapper"].update({
            "wrapperPropertiesSha256": sha256(wrapper_path),
            "distributionUrlActual": wrapper_url,
            "distributionSha256SumDeclared": props.get("distributionSha256Sum"),
            "wrapperInspectedBeforeAnyGradleExecution": True,
            "inspectionOrder": "after exact source commit/tree verification and before downloading/running explicit Gradle binary",
        })
        self.data["verificationMetadata"] = self.inspect_verification_metadata(source)
        self.phase("source_and_wrapper_pin", "PASS", commit=actual_commit, tree=actual_tree,
                   wrapperUrl=wrapper_url, wrapperHasSha256="distributionSha256Sum" in props)
        return source, wrapper_path

    @staticmethod
    def inspect_verification_metadata(source: Path) -> dict[str, Any]:
        path = source / "gradle/verification-metadata.xml"
        root = ET.parse(path).getroot()
        ns = {"v": "https://schema.gradle.org/dependency-verification"}
        config = root.find("v:configuration", ns)
        comps = root.findall("v:components/v:component", ns)
        artifacts = root.findall("v:components/v:component/v:artifact", ns)
        trusts = []
        if config is not None:
            for trust in config.findall("v:trusted-artifacts/v:trust", ns):
                trusts.append({"group": trust.get("group"), "name": trust.get("name"), "file": trust.get("file"), "regex": trust.get("regex")})
        native_components = [
            {"group": node.get("group"), "name": node.get("name"), "version": node.get("version")}
            for node in comps if node.get("group") == "net.rubygrapefruit"
        ]
        return {
            "path": "gradle/verification-metadata.xml",
            "sha256": sha256(path),
            "componentCount": len(comps),
            "verifiedArtifactCount": len(artifacts),
            "verifyMetadata": config.findtext("v:verify-metadata", default=None, namespaces=ns) if config is not None else None,
            "verifySignatures": config.findtext("v:verify-signatures", default=None, namespaces=ns) if config is not None else None,
            "keyServersEnabled": config.find("v:key-servers", ns).get("enabled") if config is not None and config.find("v:key-servers", ns) is not None else None,
            "trustedArtifactRules": trusts,
            "trustedNetRubygrapefruitGroupRule": any(x.get("group") == "net.rubygrapefruit" for x in trusts),
            "netRubygrapefruitComponentEntries": native_components,
            "nativePlatformExactComponentEntryPresent": any(x.get("group") == "net.rubygrapefruit" and x.get("name") == "native-platform" and x.get("version") == "0.22-milestone-29" for x in native_components),
            "policyDisclosure": "Strict verification remains enabled during the source build. Upstream metadata sets verify-metadata=false, verify-signatures=true, and explicitly trusts all net.rubygrapefruit artifacts; these upstream policies are recorded, not overridden. The exact published JAR is separately checked against a pinned SHA-256 and verified by its Gradle PGP signature.",
        }

    def fetch_tools_and_publication(self) -> tuple[Path, Path, Path, Path, Path]:
        gradle_zip = self.work / "gradle-8.14.3-bin.zip"
        gradle_sidecar = self.work / "gradle-8.14.3-bin.zip.sha256"
        self.download("download_explicit_gradle_distribution", GRADLE_URL, gradle_zip)
        self.download("download_explicit_gradle_sidecar", GRADLE_SHA256_URL, gradle_sidecar)
        sidecar_hash = parse_checksum_sidecar(gradle_sidecar)
        actual_hash = sha256(gradle_zip)
        if sidecar_hash != GRADLE_SHA256 or actual_hash != GRADLE_SHA256:
            raise AuditError("GRADLE_BOOTSTRAP_CHECKSUM_MISMATCH", f"Expected {GRADLE_SHA256}; sidecar={sidecar_hash}; actual={actual_hash}")
        if not zipfile.is_zipfile(gradle_zip):
            raise AuditError("GRADLE_BOOTSTRAP_NOT_ZIP", "Verified Gradle bootstrap is not a ZIP")
        gradle_root = self.work / "gradle-extract"
        gradle_root.mkdir()
        with zipfile.ZipFile(gradle_zip) as archive:
            bad = archive.testzip()
            if bad is not None:
                raise AuditError("GRADLE_BOOTSTRAP_CRC_FAILURE", f"Gradle bootstrap ZIP CRC failure at {bad}")
            launcher_entries = [info for info in archive.infolist() if info.filename == "gradle-8.14.3/bin/gradle"]
            if len(launcher_entries) != 1:
                raise AuditError("GRADLE_EXECUTABLE_MISSING", f"Expected exactly one Gradle launcher in the verified ZIP; found {len(launcher_entries)}")
            launcher_mode = (launcher_entries[0].external_attr >> 16) & 0o777
            if not (launcher_mode & 0o111):
                raise AuditError("GRADLE_LAUNCHER_MODE_MISSING", f"Verified archive launcher lacks executable bits: mode={oct(launcher_mode)}")
            archive.extractall(gradle_root)
        gradle = gradle_root / "gradle-8.14.3/bin/gradle"
        os.chmod(gradle, launcher_mode)
        if not gradle.is_file() or not os.access(gradle, os.X_OK):
            raise AuditError("GRADLE_EXECUTABLE_MISSING", "Explicit verified Gradle executable is absent after restoring the archive mode")
        self.data["bootstrap"].update({
            "actualSha256": actual_hash,
            "sidecarSha256": sidecar_hash,
            "sizeBytes": gradle_zip.stat().st_size,
            "verified": True,
            "explicitBinaryUsed": True,
            "launcherArchiveMode": oct(launcher_mode),
            "launcherExecutableBitRestoredAfterPythonZipExtraction": True,
            "extractorNote": "Python zipfile.extractall does not preserve Unix executable permissions; mode was restored from the already SHA-256-verified archive entry.",
        })
        self.run("explicit_gradle_version", [str(gradle), "--version"], timeout=120)
        version_text = (self.logs / "explicit_gradle_version.log").read_text(encoding="utf-8", errors="replace")
        if f"Gradle {GRADLE_VERSION}" not in version_text:
            raise AuditError("GRADLE_BOOTSTRAP_VERSION_MISMATCH", f"Explicit Gradle did not report {GRADLE_VERSION}")
        self.data["bootstrap"]["versionOutput"] = version_text.strip()

        pub_jar = self.work / JAR_NAME
        pub_sidecar = self.work / (JAR_NAME + ".sha256")
        pub_sig = self.work / (JAR_NAME + ".asc")
        pom = self.work / "native-platform-0.22-milestone-29.pom"
        self.download("download_published_native_platform_jar", MAVEN_BASE + "/" + JAR_NAME, pub_jar)
        self.download("download_published_jar_sha256_sidecar", MAVEN_BASE + "/" + JAR_NAME + ".sha256", pub_sidecar)
        self.download("download_published_jar_signature", MAVEN_BASE + "/" + JAR_NAME + ".asc", pub_sig)
        self.download("download_published_pom", MAVEN_BASE + "/native-platform-0.22-milestone-29.pom", pom)
        sidecar_hash = parse_checksum_sidecar(pub_sidecar)
        actual_hash = sha256(pub_jar)
        if sidecar_hash != PUBLISHED_JAR_SHA256 or actual_hash != PUBLISHED_JAR_SHA256:
            raise AuditError("PUBLISHED_JAR_CHECKSUM_MISMATCH", f"Expected {PUBLISHED_JAR_SHA256}; sidecar={sidecar_hash}; actual={actual_hash}")
        self.data["publishedArtifact"].update({
            "jarSha256Actual": actual_hash,
            "jarSha256Sidecar": sidecar_hash,
            "jarSizeBytes": pub_jar.stat().st_size,
            "pomSha256": sha256(pom),
            "pomSizeBytes": pom.stat().st_size,
        })
        if not zipfile.is_zipfile(pub_jar):
            raise AuditError("PUBLISHED_JAR_NOT_ZIP", "Published native-platform JAR is not a valid ZIP")

        keys_page = self.work / "gradle-keys.html"
        self.download("download_official_gradle_keys_reference", GRADLE_KEYS_REFERENCE, keys_page)
        keys_page_text = " ".join(html.unescape(re.sub(r"<[^>]+>", " ", keys_page.read_text(encoding="utf-8", errors="replace"))).split()).lower()
        required_key_page_facts = [
            GRADLE_SIGNING_KEY_ID.lower(), GRADLE_SIGNING_KEY_FINGERPRINT.lower(),
            GRADLE_KEY_ACTIVE_FROM, GRADLE_KEY_RETIRED_DATE, "superseded", "remain valid",
        ]
        missing_key_facts = [fact for fact in required_key_page_facts if fact not in keys_page_text]
        if missing_key_facts:
            raise AuditError("OFFICIAL_GRADLE_KEY_REFERENCE_CHANGED", f"Gradle signing-key reference lacks expected facts: {missing_key_facts}")
        self.data["publishedArtifact"]["jarSignature"]["officialKeyReferenceAudit"] = {
            "url": GRADLE_KEYS_REFERENCE,
            "sha256": sha256(keys_page),
            "containsExpectedKeyIdFingerprintAndDates": True,
            "confirmsSupersededKeySignaturesRemainValid": True,
        }
        key_file = self.work / "gradle-signing-key.asc"
        self.download("download_official_gradle_signing_key", GRADLE_SIGNING_KEY_URL, key_file)
        key_details = subprocess.run(
            ["gpg", "--batch", "--show-keys", "--with-colons", str(key_file)],
            check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        ).stdout
        primary_fingerprints = [line.split(":")[9].upper() for line in key_details.splitlines() if line.startswith("fpr:")]
        if not primary_fingerprints or primary_fingerprints[0] != GRADLE_SIGNING_KEY_FINGERPRINT:
            raise AuditError("SIGNING_KEY_FINGERPRINT_MISMATCH", f"Expected {GRADLE_SIGNING_KEY_FINGERPRINT}; got {primary_fingerprints[:1]}")
        gpg_home = self.work / "gnupg"
        gpg_home.mkdir(mode=0o700)
        os.chmod(gpg_home, 0o700)
        self.run("import_pinned_gradle_signing_key", ["gpg", "--batch", "--homedir", str(gpg_home), "--import", str(key_file)], timeout=60)
        self.data["publishedArtifact"]["jarSignature"].update({
            "signaturePath": JAR_NAME + ".asc",
            "keyIdExpected": GRADLE_SIGNING_KEY_ID,
            "primaryFingerprintExpected": GRADLE_SIGNING_KEY_FINGERPRINT,
            "primaryFingerprintActual": primary_fingerprints[0],
            "keySource": GRADLE_SIGNING_KEY_URL,
            "officialKeyReference": GRADLE_KEYS_REFERENCE,
            "keyActiveFrom": GRADLE_KEY_ACTIVE_FROM,
            "keyRetiredDate": GRADLE_KEY_RETIRED_DATE,
            "officialRetirementMeaning": "Gradle describes this revocation as superseded, not compromised, and states signatures created while the key was active remain valid.",
        })
        return gradle, pub_jar, pub_sig, pom, key_file

    def verify_signature_with_pinned_key(self, gpg_home: Path, signature: Path, artifact: Path) -> dict[str, Any]:
        rc, _ = self.run(
            "verify_published_jar_signature",
            ["gpg", "--batch", "--homedir", str(gpg_home), "--status-fd", "1", "--verify", str(signature), str(artifact)],
            timeout=60,
            check=False,
        )
        status = (self.logs / "verify_published_jar_signature.log").read_text(encoding="utf-8", errors="replace")
        valid_fingerprints: list[str] = []
        sig_epochs: list[int] = []
        for line in status.splitlines():
            if "[GNUPG:] VALIDSIG " in line:
                fields = line.split()
                if len(fields) > 3:
                    valid_fingerprints.append(fields[2].upper())
                if len(fields) > 4 and fields[4].isdigit():
                    sig_epochs.append(int(fields[4]))
        if rc != 0 or not valid_fingerprints or valid_fingerprints[-1] != GRADLE_SIGNING_KEY_FINGERPRINT:
            raise AuditError("PUBLISHED_JAR_SIGNATURE_INVALID", f"GPG did not validate the signature with the pinned official key (exit={rc})")
        if not sig_epochs:
            raise AuditError("PUBLISHED_JAR_SIGNATURE_TIMESTAMP_MISSING", "GPG did not return a signature timestamp")
        signed_at = dt.datetime.fromtimestamp(sig_epochs[-1], tz=dt.timezone.utc)
        retired_at = dt.datetime.fromisoformat(GRADLE_KEY_RETIRED_DATE).replace(tzinfo=dt.timezone.utc)
        if signed_at >= retired_at:
            raise AuditError("PUBLISHED_JAR_SIGNED_AFTER_KEY_RETIREMENT", f"Signature time {signed_at.isoformat()} is not before retirement {retired_at.isoformat()}")
        return {
            "verification": "VALID_SIGNATURE_PINNED_OFFICIAL_KEY",
            "gpgExitCode": rc,
            "validPrimaryFingerprint": valid_fingerprints[-1],
            "signatureCreatedUtc": signed_at.isoformat(),
            "signaturePredatesOfficialRetirement": True,
            "gpgReportsRevokedKey": "[GNUPG:] REVKEYSIG" in status or "[GNUPG:] KEYREVOKED" in status,
            "statusLog": "logs/verify_published_jar_signature.log",
        }

    def run_source_build(self, source: Path, gradle: Path) -> Path:
        java_bin = Path(os.environ["JAVA_HOME"]) / "bin/java" if os.environ.get("JAVA_HOME") else Path("java")
        rc, java_log = self.run("host_java_version", [str(java_bin), "-version"], timeout=30, check=False)
        java_text = java_log.read_text(encoding="utf-8", errors="replace")
        self.data["build"]["javaVersionOutput"] = java_text.strip()
        if rc != 0 or not re.search(r'version "1\.8(?:[._"]|$)', java_text):
            raise AuditError("JAVA_8_REQUIRED_BY_PINNED_RELEASE_BUILD", f"Upstream release/milestone build requires Java 8; got: {java_text.strip()}")
        env = os.environ.copy()
        env["GRADLE_USER_HOME"] = str(self.work / "gradle-user-home")
        env["JAVA_TOOL_OPTIONS"] = "-Dfile.encoding=UTF-8"
        Path(env["GRADLE_USER_HOME"]).mkdir(parents=True, exist_ok=True)
        command = [
            str(gradle), "--no-daemon", "--no-parallel", "--max-workers=2", "--stacktrace",
            "--dependency-verification", "strict",
            "-Dorg.gradle.dependency.verification.console=verbose",
            "-Pmilestone", "-PnextMilestone=29", ":native-platform:jar",
        ]
        self.data["build"].update({
            "command": command,
            "workingDirectory": "exact pinned upstream source checkout",
            "explicitGradleBinaryPath": str(gradle),
            "wrapperExecuted": False,
            "versionSelection": "Pinned source build logic with -Pmilestone -PnextMilestone=29; root gradle.properties alone says nextMilestone=14.",
        })
        self.phase("source_build", "RUNNING", dependencyVerification="strict", task=":native-platform:jar", javaMajor=8)
        rc, _ = self.run("source_build_native_platform_jar", command, cwd=source, env=env, timeout=3600, check=False)
        self.data["build"]["exitCode"] = rc
        self.data["build"]["wrapperExecuted"] = False
        if rc != 0:
            log = self.logs / "source_build_native_platform_jar.log"
            text = log.read_text(encoding="utf-8", errors="replace")
            if "Dependency verification failed" in text or "verification failed" in text.lower():
                self.data["build"]["dependencyVerificationBehavior"] = "STRICT_MODE_BLOCKED_UNVERIFIED_OR_MISMATCHED_DEPENDENCY"
                raise AuditError("STRICT_DEPENDENCY_VERIFICATION_BLOCKED", "The pinned upstream source build failed under strict dependency verification; no verification checks were disabled or bypassed.")
            raise AuditError("SOURCE_BUILD_FAILED", f"Pinned source JAR build failed with exit {rc}; see logs/source_build_native_platform_jar.log")
        jar = source / "native-platform/build/libs" / JAR_NAME
        if not jar.is_file():
            matches = sorted((source / "native-platform/build/libs").glob("*.jar"))
            raise AuditError("EXPECTED_SOURCE_JAR_MISSING", f"Expected {jar.relative_to(source)}; found {[p.name for p in matches]}")
        self.data["build"].update({
            "dependencyVerificationBehavior": "BUILD_EXIT_ZERO_WITH_STRICT_MODE; no verification failures were logged",
            "jarPath": str(jar.relative_to(source)),
            "jarSha256": sha256(jar),
            "jarSizeBytes": jar.stat().st_size,
        })
        self.phase("source_build", "PASS", exitCode=rc, jarSha256=self.data["build"]["jarSha256"])
        return jar

    def audit_gradle_distribution_jar(self, archive: Path) -> Path:
        self.download("download_verified_gradle_9_8_2_distribution", GRADLE_DIST_SOURCE, archive)
        size = archive.stat().st_size
        actual = sha256(archive)
        if size != GRADLE_DIST_BYTES or actual != GRADLE_DIST_SHA256:
            raise AuditError("GRADLE_9_8_2_DISTRIBUTION_HASH_MISMATCH", f"Expected {GRADLE_DIST_BYTES} bytes/{GRADLE_DIST_SHA256}; got {size}/{actual}")
        gradle_lib = self.work / "gradle-9.8.2-lib"
        gradle_lib.mkdir()
        with zipfile.ZipFile(archive) as zf:
            bad = zf.testzip()
            if bad is not None:
                raise AuditError("GRADLE_9_8_2_ZIP_CRC_FAILURE", f"Distribution ZIP CRC failure at {bad}")
            matches = [info for info in zf.infolist() if info.filename == EXPECTED_DIST_JAR_PATH]
            if len(matches) != 1:
                raise AuditError("GRADLE_DISTRIBUTION_JAR_PATH_NOT_UNIQUE", f"Expected one {EXPECTED_DIST_JAR_PATH}, got {len(matches)}")
            jar_path = gradle_lib / JAR_NAME
            jar_path.write_bytes(zf.read(matches[0]))
        self.data["gradleDistributionInput"].update({
            "actualSha256": actual,
            "actualSizeBytes": size,
            "inputZipFullSha256VerifiedBeforeJarExtraction": True,
            "internalNativePlatformJarSha256": sha256(jar_path),
            "internalNativePlatformJarSizeBytes": jar_path.stat().st_size,
        })
        self.phase("gradle_distribution_input", "PASS", zipSha256=actual,
                   embeddedJarSha256=sha256(jar_path))
        return jar_path

    def audit_license_and_comparisons(self, source: Path, built: Path | None, published: Path, distribution_jar: Path) -> None:
        license_path = source / "LICENSE"
        if not license_path.is_file():
            raise AuditError("UPSTREAM_LICENSE_MISSING", "Pinned upstream LICENSE file is missing")
        license_copy = self.output / "UPSTREAM-LICENSE-Apache-2.0.txt"
        shutil.copyfile(license_path, license_copy)
        jar_maps = {"published": jar_entry_map(published), "gradleDistribution": jar_entry_map(distribution_jar)}
        if built is not None:
            jar_maps["sourceBuilt"] = jar_entry_map(built)
        license_names = {}
        for label, entries in jar_maps.items():
            license_names[label] = sorted(name for name in entries if re.search(r"(^|/)(LICENSE|NOTICE)([._-]|$)", name, re.I))
        self.data["licenseAudit"] = {
            "upstreamRootLicensePresent": True,
            "spdx": UPSTREAM_LICENSE,
            "licenseSha256": sha256(license_path),
            "licenseCopiedSeparatelyToArtifact": license_copy.name,
            "jarLicenseOrNoticeEntries": license_names,
            "packageLicenseFileRequiredForAnyFuturePackaging": not any(license_names.values()),
            "noticeFilePresentAtSourceRoot": (source / "NOTICE").is_file(),
        }
        comparisons = {"publishedVsGradleDistribution": compare_jars(published, distribution_jar)}
        if built is not None:
            comparisons["sourceBuiltVsPublished"] = compare_jars(built, published)
            comparisons["sourceBuiltVsGradleDistribution"] = compare_jars(built, distribution_jar)
        self.data["comparison"] = comparisons
        self.phase("jar_and_license_comparison", "PASS" if all(v["normalizedEntryContentIdentical"] for v in comparisons.values()) else "DIFFERENCES_RECORDED",
                   sourceBuiltSha256=sha256(built) if built else None,
                   publishedSha256=sha256(published), distributionSha256=sha256(distribution_jar))

    def finalize_artifact_files(self, built: Path | None, published: Path | None, distribution_jar: Path | None, pom: Path | None, key_file: Path | None) -> None:
        files: dict[str, Any] = {}
        candidates = {
            "sourceBuiltJar": built,
            "publishedJar": published,
            "gradleDistributionNativePlatformJar": distribution_jar,
            "publishedPom": pom,
            "officialGradleSigningKey": key_file,
            "upstreamLicense": self.output / "UPSTREAM-LICENSE-Apache-2.0.txt",
            "publishedJarSignature": self.work / (JAR_NAME + ".asc"),
            "publishedJarSha256Sidecar": self.work / (JAR_NAME + ".sha256"),
        }
        for name, path in candidates.items():
            if path is not None and path.is_file():
                target = self.output / "inputs" / name
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(path, target)
                files[name] = {"path": str(target.relative_to(self.output)), "sha256": sha256(target), "sizeBytes": target.stat().st_size}
        for path in sorted(self.logs.glob("*.log")):
            files[f"log:{path.stem}"] = {"path": str(path.relative_to(self.output)), "sha256": sha256(path), "sizeBytes": path.stat().st_size}
        self.data["artifactFiles"] = files
        self.write_evidence()

    def execute(self) -> None:
        source: Path | None = None
        built: Path | None = None
        published: Path | None = None
        distribution_jar: Path | None = None
        pom: Path | None = None
        key_file: Path | None = None
        try:
            source, _ = self.verify_source_and_wrapper()
            gradle, published, published_sig, pom, key_file = self.fetch_tools_and_publication()
            gpg_home = self.work / "gnupg"
            signature_evidence = self.verify_signature_with_pinned_key(gpg_home, published_sig, published)
            self.data["publishedArtifact"]["jarSignature"].update(signature_evidence)
            self.phase("published_jar_authentication", "PASS", sha256=self.data["publishedArtifact"]["jarSha256Actual"],
                       signature=signature_evidence["verification"], signatureCreated=signature_evidence["signatureCreatedUtc"])
            dist_archive = self.work / "gradle-9.8.2-bin.zip"
            distribution_jar = self.audit_gradle_distribution_jar(dist_archive)
            self.audit_license_and_comparisons(source, None, published, distribution_jar)
            built = self.run_source_build(source, gradle)
            self.audit_license_and_comparisons(source, built, published, distribution_jar)
            source_pub = self.data["comparison"]["sourceBuiltVsPublished"]
            source_dist = self.data["comparison"]["sourceBuiltVsGradleDistribution"]
            if source_pub["byteIdentical"] and source_dist["byteIdentical"]:
                self.status = "PASS_SOURCE_BUILT_PUBLISHED_AND_DISTRIBUTION_JARS_BYTE_IDENTICAL"
            elif source_pub["normalizedEntryContentIdentical"] and source_dist["normalizedEntryContentIdentical"]:
                self.status = "PASS_NORMALIZED_JAR_CONTENT_IDENTICAL_CONTAINER_METADATA_DIFFERS"
            else:
                self.status = "JAR_CONTENT_DIFFERENCES_RECORDED_SOURCE_PROVENANCE_CAVEAT"
            self.data["outcome"] = self.status
            self.phase("final", self.status)
        except AuditError as exc:
            self.status = exc.code
            self.data["outcome"] = exc.code
            self.data["blocker"] = {"code": exc.code, "message": exc.message}
            self.phase("final", "BLOCKED", blockerCode=exc.code)
        except Exception as exc:
            self.status = "UNEXPECTED_AUDIT_ERROR"
            self.data["outcome"] = self.status
            self.data["blocker"] = {"code": self.status, "message": f"{type(exc).__name__}: {exc}"}
            self.phase("final", "BLOCKED", blockerCode=self.status)
        finally:
            self.finalize_artifact_files(built, published, distribution_jar, pom, key_file)
            self.write_evidence()
            print(f"Final outcome: {self.status}", flush=True)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--work", required=True, type=Path)
    args = parser.parse_args()
    audit = Audit(args.output, args.work)
    audit.execute()
    return 0 if audit.status.startswith("PASS_") else 1


if __name__ == "__main__":
    raise SystemExit(main())
