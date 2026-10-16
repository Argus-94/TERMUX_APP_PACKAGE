#!/usr/bin/env python3
"""Validate the exact temporary wget candidate feed against its build and audit records."""
from __future__ import annotations
import argparse
import email.parser
import hashlib
import json
import pathlib
import re
import subprocess
import sys

PIN = "505e06ef0c8dbd7611abfb90e9eb60826dcd01d7"
EXPECTED_COUNT = 11


def require(ok: bool, code: str) -> None:
    if not ok:
        raise ValueError(code)


def package_records(path: pathlib.Path) -> list[dict[str, str]]:
    return package_records_from_text(path.read_text(encoding="utf-8", errors="strict"))


def package_records_from_text(text: str) -> list[dict[str, str]]:
    records = []
    current: dict[str, str] = {}
    previous = None
    for line in text.splitlines() + [""]:
        if not line:
            if current:
                records.append(current)
                current = {}
                previous = None
            continue
        if line[:1] in (" ", "\t"):
            require(previous is not None, "INDEX_ORPHAN_CONTINUATION")
            current[previous] += " " + line.strip()
            continue
        key, sep, value = line.partition(":")
        require(bool(sep) and key not in current, "INDEX_FIELD_INVALID")
        current[key] = value.strip()
        previous = key
    return records


def validate(package_set: pathlib.Path, feed_root: pathlib.Path, build_path: pathlib.Path, audit_path: pathlib.Path) -> None:
    manifest = json.loads(package_set.read_text(encoding="utf-8"))
    build = json.loads(build_path.read_text(encoding="utf-8"))
    audit = json.loads(audit_path.read_text(encoding="utf-8"))
    require(manifest.get("channel") == "candidate-only", "CHANNEL_NOT_CANDIDATE_ONLY")
    require(manifest["source"]["commit"] == PIN, "SOURCE_PIN_MISMATCH")
    require(build.get("baseLicenseProviderEvidence") == manifest.get("baseLicenseProviderEvidence"), "BUILD_BOOTSTRAP_LICENSE_EVIDENCE_MISMATCH")
    require(audit.get("baseLicenseProviderEvidence") == manifest.get("baseLicenseProviderEvidence"), "AUDIT_BOOTSTRAP_LICENSE_EVIDENCE_MISMATCH")
    require(audit.get("baseLicenseProviderStatus") == "v476 embedded bootstrap archive and license payload hashes verified; actual device state not observed", "AUDIT_BOOTSTRAP_LICENSE_STATUS_MISMATCH")
    require(manifest["sourceClosure"]["profile"] == "wget-candidate" and manifest["sourceClosure"]["rootPackages"] == ["wget"], "ROOT_PACKAGE_MISMATCH")
    require(len(manifest["packages"]) == EXPECTED_COUNT, "PACKAGE_SET_COUNT_MISMATCH")
    require(build.get("status") == "audit-passed; device-runtime-test-not-run", "BUILD_NOT_AUDIT_PASSED")
    require(build.get("sourceCommit") == PIN and build.get("installed") is False and build.get("deviceSmokeTest") == "NOT RUN" and build.get("rollback") == "NOT RUN", "BUILD_GATE_STATE_MISMATCH")
    require(build.get("sourceClosure", {}).get("profile") == "wget-candidate" and build["sourceClosure"].get("packageCount") == EXPECTED_COUNT and build["sourceClosure"].get("dependencyAlternativeCount") == 15, "BUILD_CLOSURE_MISMATCH")
    require(audit.get("ok") is True and audit.get("sourceCommit") == PIN and audit.get("deviceInstall") == "NOT RUN" and audit.get("rollback") == "NOT RUN", "AUDIT_GATE_STATE_MISMATCH")
    require(audit.get("candidatePackageCount") == EXPECTED_COUNT and audit.get("sourceClosurePackageCount") == EXPECTED_COUNT and audit.get("sourceClosureDependencyAlternativeCount") == 15, "AUDIT_CLOSURE_MISMATCH")

    specs = {item["name"]: item for item in manifest["packages"]}
    reports = {item["name"]: item for item in audit["packages"]}
    built = {item["name"]: item for item in build["packages"]}
    require(set(specs) == set(reports) == set(built), "PACKAGE_REPORT_SET_MISMATCH")
    debs = sorted(feed_root.glob("pool/main/*/*.deb"))
    require(len(debs) == EXPECTED_COUNT, "FEED_DEB_COUNT_MISMATCH")
    feed_by_name = {}
    for deb in debs:
        control = subprocess.run(["dpkg-deb", "-f", str(deb)], check=True, capture_output=True, text=True).stdout
        fields = email.parser.Parser().parsestr(control)
        name = fields.get("Package", "")
        require(name not in feed_by_name, "FEED_DUPLICATE_PACKAGE")
        require(name in specs, "FEED_EXTRA_PACKAGE")
        require(fields.get("Version") == specs[name]["version"] and fields.get("Architecture") == specs[name]["architecture"], "FEED_PACKAGE_IDENTITY_MISMATCH")
        digest = hashlib.sha256(deb.read_bytes()).hexdigest()
        require(digest == reports[name].get("sha256") == built[name].get("sha256"), "FEED_PACKAGE_HASH_MISMATCH")
        feed_by_name[name] = deb
    require(set(feed_by_name) == set(specs), "FEED_PACKAGE_SET_MISMATCH")

    index = feed_root / "dists/stable/main/binary-aarch64/Packages"
    records = package_records(index)
    require(len(records) == EXPECTED_COUNT, "INDEX_RECORD_COUNT_MISMATCH")
    index_by_name = {record.get("Package"): record for record in records}
    require(set(index_by_name) == set(specs), "INDEX_PACKAGE_SET_MISMATCH")
    for name, record in index_by_name.items():
        require(record.get("Version") == specs[name]["version"] and record.get("Architecture") == specs[name]["architecture"], "INDEX_PACKAGE_IDENTITY_MISMATCH")
    wget = index_by_name["wget"]
    require(wget.get("Depends") == ", ".join(manifest["runtimeDependencies"]["wgetRequires"]), "WGET_DEPENDS_NOT_EXACT")
    print("PINNED_WGET_TEMP_FEED_VALIDATED packages=11 dependency_groups=15 install=NOT_PERFORMED device_install=NOT_RUN")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--package-set", type=pathlib.Path, required=True)
    parser.add_argument("--feed-root", type=pathlib.Path, required=True)
    parser.add_argument("--build-result", type=pathlib.Path, required=True)
    parser.add_argument("--audit-report", type=pathlib.Path, required=True)
    args = parser.parse_args()
    try:
        validate(args.package_set, args.feed_root, args.build_result, args.audit_report)
        return 0
    except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError, subprocess.SubprocessError) as exc:
        print("WGET_CANDIDATE_FEED_REJECTED:" + (str(exc) if isinstance(exc, ValueError) else "INPUT_INVALID"), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
