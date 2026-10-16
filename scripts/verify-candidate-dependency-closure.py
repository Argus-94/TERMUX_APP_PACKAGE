#!/usr/bin/env python3
"""Fail-closed check that every candidate Depends/Pre-Depends is in the feed allowlist."""
from __future__ import annotations

import argparse
import json
import pathlib
import re
import subprocess
import sys


class GateError(Exception):
    pass


def require(ok: bool, code: str) -> None:
    if not ok:
        raise GateError(code)


def load_package_set(path: pathlib.Path) -> dict[str, dict[str, str]]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise GateError("PACKAGE_SET_UNREADABLE") from exc
    require(isinstance(value, dict), "PACKAGE_SET_ROOT_NOT_OBJECT")
    require(value.get("schemaVersion") == 1, "PACKAGE_SET_SCHEMA_UNSUPPORTED")
    require(value.get("channel") == "candidate-only", "CHANNEL_NOT_CANDIDATE_ONLY")
    packages = value.get("packages")
    require(isinstance(packages, list) and packages, "PACKAGE_ALLOWLIST_EMPTY_OR_INVALID")
    expected: dict[str, dict[str, str]] = {}
    for item in packages:
        require(isinstance(item, dict), "PACKAGE_SPEC_INVALID")
        name, version, architecture = item.get("name"), item.get("version"), item.get("architecture")
        require(isinstance(name, str) and re.fullmatch(r"[a-z0-9][a-z0-9+.-]*", name) is not None,
                "PACKAGE_NAME_INVALID")
        require(isinstance(version, str) and bool(version.strip()), "PACKAGE_VERSION_INVALID")
        require(isinstance(architecture, str) and architecture in {"aarch64", "all"},
                "PACKAGE_ARCHITECTURE_INVALID")
        require(name not in expected, "PACKAGE_ALLOWLIST_DUPLICATE_NAME")
        expected[name] = {"version": version, "architecture": architecture}
    return expected


def parse_index(path: pathlib.Path) -> list[dict[str, str]]:
    try:
        text = path.read_text(encoding="utf-8", errors="strict")
    except (OSError, UnicodeError) as exc:
        raise GateError("PACKAGES_INDEX_UNREADABLE") from exc
    records: list[dict[str, str]] = []
    current: dict[str, str] = {}
    previous: str | None = None
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
        require(bool(sep) and key not in current, "INDEX_MALFORMED_OR_DUPLICATE_FIELD")
        current[key] = value.strip()
        previous = key
    require(bool(records), "PACKAGES_INDEX_EMPTY")
    return records


def split_top_level(value: str, separator: str) -> list[str]:
    parts: list[str] = []
    depth = 0
    start = 0
    for index, char in enumerate(value):
        if char == "(":
            depth += 1
        elif char == ")":
            depth -= 1
            require(depth >= 0, "DEPENDENCY_RELATION_UNBALANCED")
        elif char == separator and depth == 0:
            parts.append(value[start:index].strip())
            start = index + 1
    require(depth == 0, "DEPENDENCY_RELATION_UNBALANCED")
    parts.append(value[start:].strip())
    require(all(parts), "DEPENDENCY_RELATION_EMPTY_ALTERNATIVE")
    return parts


RELATION_RE = re.compile(
    r"^(?P<name>[a-z0-9][a-z0-9+.-]*)"
    r"(?::(?P<qualifier>[a-z0-9-]+))?"
    r"(?:\s+\((?P<operator><<|<=|=|>=|>>)\s+(?P<version>[^()]+)\))?$"
)


def parse_alternative(value: str) -> tuple[str, str | None, str | None, str | None]:
    match = RELATION_RE.fullmatch(value.strip())
    require(match is not None, "DEPENDENCY_RELATION_SYNTAX_UNSUPPORTED")
    qualifier = match.group("qualifier")
    require(qualifier is None or qualifier in {"aarch64", "native"},
            "DEPENDENCY_ARCH_QUALIFIER_UNSUPPORTED")
    return (
        match.group("name"),
        qualifier,
        match.group("operator"),
        match.group("version").strip() if match.group("version") else None,
    )


def version_matches(actual: str, operator: str | None, wanted: str | None) -> bool:
    if operator is None:
        return True
    require(wanted is not None and bool(wanted), "DEPENDENCY_VERSION_EMPTY")
    dpkg_operator = {"<<": "lt", "<=": "le", "=": "eq", ">=": "ge", ">>": "gt"}[operator]
    try:
        result = subprocess.run(
            ["dpkg", "--compare-versions", actual, dpkg_operator, wanted],
            check=False, capture_output=True, timeout=10,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        raise GateError("DPKG_VERSION_COMPARATOR_UNAVAILABLE") from exc
    require(result.returncode in {0, 1}, "DEPENDENCY_VERSION_INVALID")
    return result.returncode == 0


def candidate_satisfies(
    relation: tuple[str, str | None, str | None, str | None],
    available: dict[str, dict[str, str]],
) -> bool:
    name, qualifier, operator, wanted = relation
    provider = available.get(name)
    if provider is None:
        return False
    architecture = provider["architecture"]
    if qualifier == "aarch64" and architecture != "aarch64":
        return False
    return version_matches(provider["version"], operator, wanted)


def validate(package_set: pathlib.Path, index_path: pathlib.Path) -> int:
    expected = load_package_set(package_set)
    records = parse_index(index_path)
    available: dict[str, dict[str, str]] = {}
    for record in records:
        name, version, architecture = record.get("Package"), record.get("Version"), record.get("Architecture")
        require(isinstance(name, str) and name not in available, "INDEX_DUPLICATE_OR_INVALID_PACKAGE")
        require(name in expected, "INDEX_CONTAINS_UNALLOWLISTED_PACKAGE")
        spec = expected[name]
        require(version == spec["version"], "INDEX_PACKAGE_VERSION_MISMATCH")
        require(architecture == spec["architecture"], "INDEX_PACKAGE_ARCHITECTURE_MISMATCH")
        available[name] = {"version": version, "architecture": architecture}
    require(set(available) == set(expected), "INDEX_PACKAGE_SET_MISMATCH")

    checked = 0
    for record in records:
        package = record["Package"]
        for field in ("Pre-Depends", "Depends"):
            relations = record.get(field, "")
            if not relations:
                continue
            for group in split_top_level(relations, ","):
                alternatives = [parse_alternative(value) for value in split_top_level(group, "|")]
                checked += 1
                require(any(candidate_satisfies(item, available) for item in alternatives),
                        "DEPENDENCY_CLOSURE_INCOMPLETE_" + package + "_" + field.upper().replace("-", "_"))
    print(f"CANDIDATE_DEPENDENCY_CLOSURE_OK packages={len(available)} relations={checked} external_base_assumptions=0")
    return checked


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--package-set", type=pathlib.Path, required=True)
    parser.add_argument("--packages-index", type=pathlib.Path, required=True)
    args = parser.parse_args()
    try:
        validate(args.package_set, args.packages_index)
        return 0
    except (GateError, OSError, ValueError, KeyError, subprocess.SubprocessError) as exc:
        code = str(exc) if isinstance(exc, GateError) else "VALIDATION_INPUT_INVALID"
        print(f"CANDIDATE_DEPENDENCY_CLOSURE_REJECTED:{code}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
