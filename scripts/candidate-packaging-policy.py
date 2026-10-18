#!/usr/bin/env python3
"""Canonicalize and measure one Termux package payload before archive creation."""
import argparse
import os
import stat
import sys
from pathlib import Path

ALLOWED_PREFIXES = ("data/user/0/com.karat.aibuilder/files/usr", "data/data/com.karat.aibuilder/files/usr")


def policy_description(repo, source_root):
    """Return a stable, source-only description; this function never mutates."""
    # Import lazily so this standalone CLI remains usable when copied to a source tree.
    import importlib.util
    ap = Path(__file__).with_name("apply-candidate-packaging-policy.py")
    spec = importlib.util.spec_from_file_location("candidate_policy_applier", ap)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.policy_description(repo, source_root)


def fail(message):
    raise ValueError(message)


def checked_path(stage, prefix, create=False):
    stage = Path(os.path.abspath(stage))
    prefix = prefix.lstrip("/")
    if prefix not in ALLOWED_PREFIXES:
        fail("foreign or unsupported package prefix")
    if not stage.is_dir() or stage.is_symlink():
        fail("stage must be a real directory")
    cur = stage
    for part in Path(prefix).parts:
        cur = cur / part
        if cur.is_symlink():
            fail("symlink in stage/prefix ancestor: " + str(cur))
    target = stage / prefix
    if not target.exists() and create:
        target.mkdir(parents=True, mode=0o700)
    if not target.exists() or not target.is_dir() or target.is_symlink():
        fail("package prefix directory is missing or not a real directory")
    # Validate the entire staging tree without following symlinks. Outside-prefix
    # directories may be scaffolding, but payload objects may not be there.
    for base, dirs, files in os.walk(stage, followlinks=False):
        bp = Path(base)
        for name in dirs + files:
            p = bp / name
            rel = p.relative_to(stage).as_posix()
            inside = rel == prefix or rel.startswith(prefix + "/")
            st = p.lstat()
            if stat.S_ISLNK(st.st_mode):
                if inside:
                    # Links are retained verbatim; reject targets escaping staging.
                    raw = os.readlink(p)
                    try:
                        resolved = (stage / raw.lstrip("/")).resolve(strict=False) if os.path.isabs(raw) else (p.parent / raw).resolve(strict=False)
                        resolved.relative_to(target)
                    except (ValueError, RuntimeError):
                        fail("payload symlink escapes stage: " + rel)
                elif not inside:
                    # Ancestor links are caught above; arbitrary links outside payload are invalid.
                    fail("unexpected object outside package prefix: " + rel)
            elif not inside and not (stat.S_ISDIR(st.st_mode) and prefix.startswith(rel + "/")):
                fail("unexpected payload object outside package prefix: " + rel)
            elif inside and not (stat.S_ISDIR(st.st_mode) or stat.S_ISREG(st.st_mode) or stat.S_ISLNK(st.st_mode)):
                fail("special payload object is not supported: " + rel)
    return stage, target


def apply(stage, prefix):
    stage, target = checked_path(stage, prefix, create=True)
    # Private policy is confined strictly to usr and its descendants.
    for base, dirs, _ in os.walk(target, topdown=True, followlinks=False):
        for name in dirs:
            p = Path(base) / name
            if not p.is_symlink():
                p.chmod(0o700)
        Path(base).chmod(0o700)
    target.chmod(0o700)
    return stage, target


def installed_size(target):
    total = 1024  # Prefix directory itself is serialized into data.tar.
    seen = set()
    for base, dirs, files in os.walk(target, followlinks=False):
        for name in dirs + files:
            p = Path(base) / name
            st = p.lstat()
            if stat.S_ISREG(st.st_mode):
                # GNU tar -H gnu preserves hard links; count each inode once,
                # consistently with its single stored data body.
                key = (st.st_dev, st.st_ino)
                if key not in seen:
                    total += ((st.st_size + 1023) // 1024) * 1024
                    seen.add(key)
            elif stat.S_ISLNK(st.st_mode):
                total += ((len(os.fsencode(os.readlink(p))) + 1023) // 1024) * 1024
            elif stat.S_ISDIR(st.st_mode):
                total += 1024
            else:
                fail("special payload object: " + str(p))
    return max(1, (total + 1023) // 1024)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--stage", required=True)
    parser.add_argument("--prefix", required=True)
    parser.add_argument("--normalize", action="store_true")
    args = parser.parse_args()
    _, target = apply(args.stage, args.prefix) if args.normalize else checked_path(args.stage, args.prefix)
    print(installed_size(target))

if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError) as exc:
        print(f"candidate packaging policy: {exc}", file=sys.stderr)
        sys.exit(2)
