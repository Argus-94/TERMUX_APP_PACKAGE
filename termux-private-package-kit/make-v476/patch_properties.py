#!/usr/bin/env python3
"""Apply the two audited AI Builder fork values to pinned Termux properties."""
from __future__ import annotations

import argparse
import hashlib
import pathlib
import re
import sys

PINNED_PROPERTIES_SHA256 = "238a19b2f29ef5eed5806a21bee8f5a51bc5031e7db3fcc393d831292300b725"
APP_ID = "com.karat.aibuilder"
DATA_DIR_RE = re.compile(r"^/data/(?:data|user/0)/com\.karat\.aibuilder$")


def fail(code: str) -> "NoReturn":
    print(f"ERROR:{code}", file=sys.stderr)
    raise SystemExit(2)


def replace_exact(data: bytes, old: bytes, new: bytes, label: str) -> bytes:
    count = data.count(old)
    if count != 1:
        fail(f"EXPECTED_ONE_{label}_ASSIGNMENT_FOUND_{count}")
    return data.replace(old, new, 1)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("properties", type=pathlib.Path)
    parser.add_argument("--data-dir", required=True)
    parser.add_argument("--prefix", required=True)
    args = parser.parse_args()

    data_dir = args.data_dir.rstrip("/")
    prefix = args.prefix.rstrip("/")
    if not DATA_DIR_RE.fullmatch(data_dir):
        fail("APP_DATA_DIR_NOT_A_CANONICAL_AI_BUILDER_PATH")
    if prefix != f"{data_dir}/files/usr":
        fail("PREFIX_DOES_NOT_MATCH_VALIDATED_FILESDIR_LAYOUT")

    path = args.properties
    original = path.read_bytes()
    actual = hashlib.sha256(original).hexdigest()
    if actual != PINNED_PROPERTIES_SHA256:
        fail(f"UPSTREAM_PROPERTIES_HASH_MISMATCH_{actual}")

    patched = replace_exact(
        original,
        b'TERMUX_APP__PACKAGE_NAME="com.termux"',
        f'TERMUX_APP__PACKAGE_NAME="{APP_ID}"'.encode(),
        "APP_ID",
    )
    patched = replace_exact(
        patched,
        b'TERMUX_APP__DATA_DIR="/data/data/$TERMUX_APP__PACKAGE_NAME"',
        f'TERMUX_APP__DATA_DIR="{data_dir}"'.encode(),
        "APP_DATA_DIR",
    )
    path.write_bytes(patched)
    print("AIB_PROPERTIES_PATCH_OK app=com.karat.aibuilder fields=2")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
