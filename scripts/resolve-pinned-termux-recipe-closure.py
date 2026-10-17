#!/usr/bin/env python3
"""Inventory a pinned Termux source dependency closure without executing recipes.

This is source metadata only: it does not build, stage, sign, or authorize packages.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import pathlib
import re
import subprocess
import sys
from typing import Any


class GateError(Exception):
    pass


def require(ok: bool, code: str) -> None:
    if not ok:
        raise GateError(code)


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
    r"(?:\s+\((?P<operator><<|<=|=|>=|>>|<|>)\s+(?P<version>[^()]+)\))?$"
)


def parse_dependency_groups(value: str, code: str) -> list[list[dict[str, str | None]]]:
    if not value.strip():
        return []
    groups: list[list[dict[str, str | None]]] = []
    for group in split_top_level(value, ","):
        alternatives: list[dict[str, str | None]] = []
        for alternative in split_top_level(group, "|"):
            match = RELATION_RE.fullmatch(alternative.strip())
            require(match is not None, code)
            alternatives.append({
                "name": match.group("name"),
                "qualifier": match.group("qualifier"),
                "operator": match.group("operator"),
                "version": match.group("version").strip() if match.group("version") else None,
                "sourceRelation": alternative.strip(),
            })
        groups.append(alternatives)
    return groups


def find_unescaped_quote(value: str, quote: str) -> int | None:
    escaped = False
    for index, char in enumerate(value):
        if escaped:
            escaped = False
        elif char == "\\":
            escaped = True
        elif char == quote:
            return index
    return None


def shell_assignment(path: pathlib.Path, variable: str, *, required: bool = False) -> str | None:
    """Read one simple top-level shell assignment without evaluating shell code."""
    try:
        lines = path.read_text(encoding="utf-8", errors="strict").splitlines()
    except (OSError, UnicodeError) as exc:
        raise GateError("SOURCE_RECIPE_UNREADABLE") from exc
    pattern = re.compile(r"^\s*" + re.escape(variable) + r"\s*(\+?=)\s*(.*)$")
    found: list[tuple[str, str]] = []
    index = 0
    while index < len(lines):
        match = pattern.match(lines[index])
        if not match or lines[index].lstrip().startswith("#"):
            index += 1
            continue
        operator, rhs = match.groups()
        if operator != "=":
            raise GateError("SOURCE_METADATA_APPEND_UNSUPPORTED_" + variable)
        rhs = rhs.strip()
        if rhs.startswith(("'", '"')):
            quote = rhs[0]
            content_parts: list[str] = []
            remainder = rhs[1:]
            while True:
                close = find_unescaped_quote(remainder, quote)
                if close is not None:
                    content_parts.append(remainder[:close])
                    trailing = remainder[close + 1:].strip()
                    require(not trailing or trailing.startswith("#"), "SOURCE_METADATA_TRAILING_SHELL_" + variable)
                    break
                content_parts.append(remainder)
                index += 1
                require(index < len(lines), "SOURCE_METADATA_UNTERMINATED_QUOTE_" + variable)
                remainder = lines[index]
            value = "\n".join(content_parts)
        else:
            value = rhs.split("#", 1)[0].strip()
        found.append((operator, value))
        index += 1
    require(len(found) <= 1, "SOURCE_METADATA_MULTIPLE_ASSIGNMENTS_" + variable)
    if not found:
        require(not required, "SOURCE_METADATA_MISSING_" + variable)
        return None
    return found[0][1]


def is_literal(value: str | None) -> bool:
    return value is not None and not any(marker in value for marker in ("$", "`", "\\", ";"))


def file_sha256(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    try:
        with path.open("rb") as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(block)
    except OSError as exc:
        raise GateError("SOURCE_RECIPE_UNREADABLE") from exc
    return digest.hexdigest()


def load_scope(path: pathlib.Path) -> dict[str, Any]:
    try:
        scope = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise GateError("SOURCE_SCOPE_UNREADABLE") from exc
    require(isinstance(scope, dict), "SOURCE_SCOPE_ROOT_NOT_OBJECT")
    require(scope.get("schemaVersion") == 1, "SOURCE_SCOPE_SCHEMA_UNSUPPORTED")
    require(scope.get("inventoryOnly") is True, "SOURCE_SCOPE_MUST_BE_INVENTORY_ONLY")
    require(scope.get("candidateInstallable") is False, "SOURCE_SCOPE_MUST_NOT_AUTHORIZE_INSTALL")
    require(isinstance(scope.get("sourceCommit"), str) and re.fullmatch(r"[0-9a-f]{40}", scope["sourceCommit"]) is not None,
            "SOURCE_SCOPE_COMMIT_INVALID")
    profiles = scope.get("profiles")
    require(isinstance(profiles, dict) and profiles, "SOURCE_SCOPE_PROFILES_INVALID")
    for profile, roots in profiles.items():
        require(isinstance(profile, str) and re.fullmatch(r"[a-z0-9][a-z0-9-]*", profile) is not None,
                "SOURCE_SCOPE_PROFILE_NAME_INVALID")
        require(isinstance(roots, list) and roots, "SOURCE_SCOPE_ROOTS_INVALID")
        require(all(isinstance(root, str) and re.fullmatch(r"[a-z0-9][a-z0-9+.-]*", root) for root in roots),
                "SOURCE_SCOPE_ROOT_NAME_INVALID")
        require(len(set(roots)) == len(roots), "SOURCE_SCOPE_ROOT_DUPLICATE")
    choices_by_profile = scope.get("dependencyChoices", {})
    require(isinstance(choices_by_profile, dict), "SOURCE_SCOPE_DEPENDENCY_CHOICES_INVALID")
    for profile, choices in choices_by_profile.items():
        require(profile in profiles, "SOURCE_SCOPE_DEPENDENCY_CHOICE_PROFILE_UNKNOWN")
        require(isinstance(choices, list), "SOURCE_SCOPE_DEPENDENCY_CHOICE_LIST_INVALID")
        seen: set[tuple[str, int]] = set()
        for choice in choices:
            require(isinstance(choice, dict), "SOURCE_SCOPE_DEPENDENCY_CHOICE_INVALID")
            require(set(choice) == {"package", "dependencyGroupIndex", "alternatives", "selected"},
                    "SOURCE_SCOPE_DEPENDENCY_CHOICE_FIELDS_INVALID")
            package, group_index = choice.get("package"), choice.get("dependencyGroupIndex")
            alternatives, selected = choice.get("alternatives"), choice.get("selected")
            require(isinstance(package, str) and re.fullmatch(r"[a-z0-9][a-z0-9+.-]*", package) is not None,
                    "SOURCE_SCOPE_DEPENDENCY_CHOICE_PACKAGE_INVALID")
            require(type(group_index) is int and group_index >= 0,
                    "SOURCE_SCOPE_DEPENDENCY_CHOICE_INDEX_INVALID")
            require(isinstance(alternatives, list) and len(alternatives) >= 2
                    and all(isinstance(name, str) and re.fullmatch(r"[a-z0-9][a-z0-9+.-]*", name) is not None
                            for name in alternatives),
                    "SOURCE_SCOPE_DEPENDENCY_CHOICE_ALTERNATIVES_INVALID")
            require(len(set(alternatives)) == len(alternatives), "SOURCE_SCOPE_DEPENDENCY_CHOICE_DUPLICATE_ALTERNATIVE")
            require(isinstance(selected, str) and selected in alternatives,
                    "SOURCE_SCOPE_DEPENDENCY_CHOICE_SELECTION_INVALID")
            key = (package, group_index)
            require(key not in seen, "SOURCE_SCOPE_DEPENDENCY_CHOICE_DUPLICATE_GROUP")
            seen.add(key)
    return scope


def git_source_state(source_root: pathlib.Path) -> tuple[str, str]:
    try:
        revision = subprocess.run(
            ["git", "-C", str(source_root), "rev-parse", "HEAD"],
            check=True, capture_output=True, text=True, timeout=15,
        ).stdout.strip()
        status = subprocess.run(
            ["git", "-C", str(source_root), "status", "--porcelain=v1"],
            check=True, capture_output=True, text=True, timeout=15,
        ).stdout
    except (OSError, subprocess.SubprocessError) as exc:
        raise GateError("SOURCE_GIT_STATE_UNAVAILABLE") from exc
    require(re.fullmatch(r"[0-9a-f]{40}", revision) is not None, "SOURCE_GIT_REVISION_INVALID")
    require(not status.strip(), "SOURCE_WORKTREE_NOT_CLEAN")
    return revision, status


class Resolver:
    def __init__(self, source_root: pathlib.Path, dependency_choices: list[dict[str, Any]] | None = None):
        self.source_root = source_root.resolve()
        self.packages_root = self.source_root / "packages"
        require(self.packages_root.is_dir(), "SOURCE_PACKAGES_DIRECTORY_MISSING")
        self.recipe_by_package: dict[str, pathlib.Path] = {}
        self.subpackage_by_name: dict[str, pathlib.Path] = {}
        try:
            for package_dir in sorted(self.packages_root.iterdir()):
                if not package_dir.is_dir():
                    continue
                recipe = package_dir / "build.sh"
                if recipe.is_file():
                    self.recipe_by_package[package_dir.name] = recipe
                for subpackage in sorted(package_dir.glob("*.subpackage.sh")):
                    name = subpackage.name.removesuffix(".subpackage.sh")
                    require(name not in self.subpackage_by_name, "SOURCE_SUBPACKAGE_NAME_AMBIGUOUS_" + name)
                    self.subpackage_by_name[name] = subpackage
        except OSError as exc:
            raise GateError("SOURCE_PACKAGES_DIRECTORY_UNREADABLE") from exc
        self.nodes: dict[str, dict[str, Any]] = {}
        self.edges = 0
        self.dependency_choices = {
            (choice["package"], choice["dependencyGroupIndex"]): choice
            for choice in (dependency_choices or [])
        }
        self.applied_dependency_choices: set[tuple[str, int]] = set()
        self.selected_dependency_alternatives: list[dict[str, Any]] = []

    def locate(self, package: str) -> tuple[pathlib.Path, pathlib.Path | None]:
        direct = self.recipe_by_package.get(package)
        if direct is not None:
            return direct, None
        subpackage = self.subpackage_by_name.get(package)
        require(subpackage is not None, "SOURCE_RECIPE_NOT_FOUND_" + package)
        parent_recipe = subpackage.parent / "build.sh"
        require(parent_recipe.is_file(), "SOURCE_SUBPACKAGE_PARENT_RECIPE_MISSING_" + package)
        return parent_recipe, subpackage

    def package_metadata(self, package: str) -> dict[str, Any]:
        recipe, subpackage = self.locate(package)
        recipe_relative = recipe.relative_to(self.source_root).as_posix()
        version = shell_assignment(recipe, "TERMUX_PKG_VERSION", required=True)
        revision = shell_assignment(recipe, "TERMUX_PKG_REVISION")
        parent_depends = shell_assignment(recipe, "TERMUX_PKG_DEPENDS") or ""
        own_depends = parse_dependency_groups(parent_depends, "SOURCE_DEPENDENCY_SYNTAX_UNSUPPORTED")
        recommendations_raw = shell_assignment(recipe, "TERMUX_PKG_RECOMMENDS") or ""
        recommendations = parse_dependency_groups(recommendations_raw, "SOURCE_RECOMMENDS_SYNTAX_UNSUPPORTED")
        dependency_groups = own_depends
        package_type = "recipe"
        subpackage_relative: str | None = None
        subpackage_hash: str | None = None
        parent_package: str | None = None
        parent_dependency_rule: str | None = None
        if subpackage is not None:
            package_type = "subpackage"
            parent_package = recipe.parent.name
            subpackage_relative = subpackage.relative_to(self.source_root).as_posix()
            subpackage_hash = file_sha256(subpackage)
            subpkg_raw = shell_assignment(subpackage, "TERMUX_SUBPKG_DEPENDS") or ""
            dependency_groups = parse_dependency_groups(subpkg_raw, "SOURCE_SUBPACKAGE_DEPENDENCY_SYNTAX_UNSUPPORTED")
            depend_on_parent = shell_assignment(subpackage, "TERMUX_SUBPKG_DEPEND_ON_PARENT")
            parent_dependency_names = {
                alternative["name"]
                for group in own_depends
                for alternative in group
            }
            if depend_on_parent is None and package not in parent_dependency_names:
                depend_on_parent = "true"
            if depend_on_parent in {"true", "unversioned"}:
                relation = parent_package if depend_on_parent == "unversioned" else f"{parent_package} (= parent-build-version)"
                dependency_groups = dependency_groups + [[{
                    "name": parent_package,
                    "qualifier": None,
                    "operator": "=" if depend_on_parent == "true" else None,
                    "version": "parent-build-version" if depend_on_parent == "true" else None,
                    "sourceRelation": relation,
                }]]
                parent_dependency_rule = depend_on_parent
            elif depend_on_parent == "deps":
                dependency_groups = dependency_groups + own_depends
                parent_dependency_rule = "deps"
            elif depend_on_parent in {None, "", "false"}:
                parent_dependency_rule = "none"
            else:
                raise GateError("SOURCE_SUBPACKAGE_PARENT_RULE_UNSUPPORTED_" + package)
        for group in dependency_groups:
            for alternative in group:
                require(alternative["name"] is not None, "SOURCE_DEPENDENCY_NAME_MISSING")
                self.edges += 1
        return {
            "name": package,
            "packageType": package_type,
            "parentPackage": parent_package,
            "parentDependencyRule": parent_dependency_rule,
            "recipePath": recipe_relative,
            "recipeSha256": file_sha256(recipe),
            "subpackagePath": subpackage_relative,
            "subpackageSha256": subpackage_hash,
            "sourceVersionExpression": version,
            "versionExpressionIsLiteral": is_literal(version),
            "sourceRevisionExpression": revision,
            "revisionExpressionIsLiteral": revision is None or is_literal(revision),
            "dependencyGroups": dependency_groups,
            "recommendationGroupsNotIncludedInRequiredClosure": recommendations,
        }

    def resolve(self, roots: list[str]) -> dict[str, Any]:
        pending = list(roots)
        while pending:
            package = pending.pop(0)
            if package in self.nodes:
                continue
            metadata = self.package_metadata(package)
            self.nodes[package] = metadata
            for group_index, group in enumerate(metadata["dependencyGroups"]):
                alternatives = [str(alternative["name"]) for alternative in group]
                choice_key = (package, group_index)
                choice = self.dependency_choices.get(choice_key)
                if choice is None:
                    dependencies = alternatives
                else:
                    require(alternatives == choice["alternatives"], "SOURCE_DEPENDENCY_CHOICE_NOT_APPLIED")
                    selected = str(choice["selected"])
                    require(selected in alternatives, "SOURCE_DEPENDENCY_CHOICE_PROVIDER_NOT_FOUND")
                    self.applied_dependency_choices.add(choice_key)
                    self.selected_dependency_alternatives.append({
                        "package": package,
                        "dependencyGroupIndex": group_index,
                        "alternatives": alternatives,
                        "selected": selected,
                    })
                    dependencies = [selected]
                for dependency in dependencies:
                    if dependency not in self.nodes:
                        pending.append(dependency)
        require(self.applied_dependency_choices == set(self.dependency_choices),
                "SOURCE_DEPENDENCY_CHOICE_NOT_APPLIED")
        result = {
            "rootPackages": roots,
            "packageCount": len(self.nodes),
            "dependencyAlternativeCount": sum(
                len(group)
                for node in self.nodes.values()
                for group in node["dependencyGroups"]
            ),
            "packages": [self.nodes[name] for name in sorted(self.nodes)],
        }
        if self.selected_dependency_alternatives:
            result["selectedDependencyAlternatives"] = self.selected_dependency_alternatives
        return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-root", type=pathlib.Path, required=True)
    parser.add_argument("--scope", type=pathlib.Path, required=True)
    parser.add_argument("--profile", required=True)
    args = parser.parse_args()
    try:
        scope = load_scope(args.scope)
        require(args.profile in scope["profiles"], "SOURCE_SCOPE_PROFILE_NOT_FOUND")
        source_root = args.source_root.resolve()
        revision, _ = git_source_state(source_root)
        require(revision == scope["sourceCommit"], "SOURCE_COMMIT_MISMATCH")
        roots = scope["profiles"][args.profile]
        resolver = Resolver(source_root, scope.get("dependencyChoices", {}).get(args.profile, []))
        result = resolver.resolve(roots)
        output = {
            "schemaVersion": 1,
            "verification": "pinned-source-recipe-inventory-only; no packages built, installed, staged, signed, or authorized",
            "sourceRepository": scope.get("sourceRepository"),
            "sourceCommit": revision,
            "profile": args.profile,
            **result,
        }
        print(json.dumps(output, sort_keys=True, indent=2))
        return 0
    except (GateError, OSError, ValueError, KeyError, subprocess.SubprocessError) as exc:
        code = str(exc) if isinstance(exc, GateError) else "SOURCE_SCOPE_INPUT_INVALID"
        print(f"TERMUX_SOURCE_SCOPE_REJECTED:{code}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
