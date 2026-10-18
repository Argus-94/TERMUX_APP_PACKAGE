#!/usr/bin/env python3
"""Apply a hash-pinned, source-only policy before candidate archive creation."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import sys

BASE = "505e06ef0c8dbd7611abfb90e9eb60826dcd01d7"
FILES = {
    "scripts/build/termux_step_create_debian_package.sh": "aa61120c840465e016b51da103fd3540079febf1cfed0d636810296dd73e90ff",
    "scripts/build/termux_create_debian_subpackages.sh": "76ec32cb5f3d161bcb012637a6c5b89d39d63444de046f80dd41af4ee6388490",
}
HELPER_NAME = ".aib-candidate-packaging-policy.py"

def sha(data):
    return hashlib.sha256(data).hexdigest()

def regular(root, rel):
    root = Path(root).absolute()
    current = Path(root.anchor)
    for part in (*root.parts[1:], *Path(rel).parts):
        current = current / part
        if current.is_symlink():
            raise ValueError(f"symlink in source/input path: {current}")
    if not current.is_file():
        raise ValueError(f"regular input missing: {current}")
    return current

def anchors(name):
    main = name.endswith("termux_step_create_debian_package.sh")
    var = "TERMUX_PKG_INSTALLSIZE" if main else "SUB_PKG_INSTALLSIZE"
    indent = "\t" if main else "\t\t"
    old_tar = ('-cJf "$TERMUX_PKG_PACKAGEDIR/data.tar.xz" -H gnu .' if main
               else '-cJf "$SUB_PKG_PACKAGE_DIR/data.tar.xz" .')
    new_tar = old_tar[:-1] + '"./${TERMUX_PREFIX#/}"'
    old_block = indent + "local " + var + "\n" + indent + var + "=$(du -sk . | cut -f 1)\n"
    new_block = (indent + "local " + var + "\n" + indent + var +
                 '=$(python3 "${BASH_SOURCE[0]%/*}/' + HELPER_NAME +
                 '" --stage . --prefix "$TERMUX_PREFIX" --normalize)\n')
    restore_marker = ("\n" + indent + '# From here on TERMUX_ARCH' if main
                      else indent + '# Clean up DEBIAN metadata directory')
    return old_tar, new_tar, old_block, new_block, restore_marker, indent

def patched(data, name):
    text = data.decode("utf-8")
    old_tar, new_tar, old_block, new_block, _, indent = anchors(name)
    if text.count(old_tar) != 1 or text.count(old_block) != 1 or new_block in text:
        raise ValueError(f"exact pinned transformation anchors absent/non-unique: {name}")
    text = text.replace(old_block, "", 1).replace(old_tar, new_tar, 1)
    start = text.rfind("\n" + indent + "XZ_OPT=", 0, text.index(new_tar))
    if start < 0:
        raise ValueError(f"data tar command start missing: {name}")
    # Insert before the whole continued shell command, never between tar flags.
    return (text[:start + 1] + new_block + text[start + 1:]).encode("utf-8")

def unpatched(data, name):
    text = data.decode("utf-8")
    old_tar, new_tar, old_block, new_block, restore_marker, _ = anchors(name)
    if text.count(new_block) != 1 or text.count(new_tar) != 1 or text.count(restore_marker) != 1:
        raise ValueError(f"source hash drift: {name}")
    text = text.replace(new_block, "", 1).replace(new_tar, old_tar, 1)
    position = text.index(restore_marker)
    original = (text[:position] + old_block + text[position:]).encode("utf-8")
    if sha(original) != FILES[name] or patched(original, name) != data:
        raise ValueError(f"source hash drift: {name}")
    return original

def policy_description(repo, source_root):
    root = Path(source_root)
    before, after = {}, {}
    for rel, expected in FILES.items():
        data = regular(root, rel).read_bytes()
        original = data if sha(data) == expected else unpatched(data, rel)
        before[rel] = expected
        after[rel] = sha(patched(original, rel))
    repo = Path(repo)
    helper = regular(repo, "scripts/candidate-packaging-policy.py")
    applier = regular(repo, "scripts/apply-candidate-packaging-policy.py")
    return {"baseCommit": BASE, "baseInputs": before, "patchedInputs": after,
            "helperSha256": sha(helper.read_bytes()), "applierSha256": sha(applier.read_bytes()),
            "directoryMode": "0700", "ancestorPayloadOmitted": True,
            "sizePolicy": "sum each regular-file and symlink-target length rounded up individually to 1 KiB; hardlink inode counted once; 1 KiB per directory including prefix root; minimum 1 KiB",
            "reference": "https://www.debian.org/doc/debian-policy/ch-controlfields.html#installed-size",
            "sourceOnly": True}

def apply(root):
    root = Path(root)
    repo = Path(__file__).absolute().parents[1]
    description = policy_description(repo, root)  # Verify both before any writes.
    helper_src = regular(repo, "scripts/candidate-packaging-policy.py")
    dest = root / "scripts/build" / HELPER_NAME
    if dest.is_symlink() or (dest.exists() and (not dest.is_file() or dest.read_bytes() != helper_src.read_bytes())):
        raise ValueError("existing source helper differs or is not regular")
    outputs = {}
    for rel, expected in FILES.items():
        path = regular(root, rel)
        data = path.read_bytes()
        outputs[path] = patched(data, rel) if sha(data) == expected else data
    for path, data in outputs.items():
        if path.read_bytes() != data:
            path.write_bytes(data)
    if not dest.exists():
        shutil.copyfile(helper_src, dest)
    if policy_description(repo, root) != description:
        raise ValueError("post-application policy mismatch")
    return description

def verify(root):
    root = Path(root)
    repo = Path(__file__).absolute().parents[1]
    description = policy_description(repo, root)
    for rel, expected in description["patchedInputs"].items():
        if sha(regular(root, rel).read_bytes()) != expected:
            raise ValueError("source packaging policy not applied: " + rel)
    helper = regular(root, "scripts/build/" + HELPER_NAME)
    if sha(helper.read_bytes()) != description["helperSha256"]:
        raise ValueError("installed source packaging helper hash mismatch")
    return description

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-root", required=True)
    parser.add_argument("--verify-only", action="store_true")
    args = parser.parse_args()
    result = verify(args.source_root) if args.verify_only else apply(args.source_root)
    print(json.dumps(result, sort_keys=True))

if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError) as exc:
        print(f"candidate packaging policy applier: {exc}", file=sys.stderr)
        sys.exit(2)
