#!/usr/bin/env python3
"""Fail-closed .deb payload collision check; never extracts filesystem members."""

import argparse
import gzip
import hashlib
import io
import json
import lzma
import pathlib
import re
import sys
import tarfile
import zlib


MAX_DEB_SIZE = 512 * 1024 * 1024
MAX_TAR_SIZE = 1024 * 1024 * 1024
MAX_CONTROL_SIZE = 1024 * 1024
MAX_MEMBER_SIZE = 128 * 1024 * 1024
MAX_MEMBERS = 200_000


class Reject(Exception):
    """An input archive failed a supported-subset validation."""


def require(condition, reason):
    if not condition:
        raise Reject(reason)


def parse_ar(data):
    require(data.startswith(b'!<arch>\n'), 'NOT_AR')
    members = []
    pos = 8
    while pos < len(data):
        require(pos + 60 <= len(data), 'BAD_AR_HEADER')
        header = data[pos:pos + 60]
        require(header[58:60] == b'`\n', 'BAD_AR_HEADER')
        try:
            name = header[:16].decode('ascii').strip().rstrip('/')
            size = int(header[48:58].decode('ascii').strip())
        except (UnicodeDecodeError, ValueError) as exc:
            raise Reject('BAD_AR_MEMBER') from exc
        require(size >= 0, 'BAD_AR_MEMBER')
        body_start = pos + 60
        body_end = body_start + size
        padded_end = body_end + size % 2
        require(padded_end <= len(data), 'TRUNCATED_AR')
        if size % 2:
            require(data[body_end:body_end + 1] == b'\n', 'BAD_AR_PADDING')
        require(name in {
            'debian-binary', 'control.tar', 'control.tar.gz', 'control.tar.xz',
            'data.tar', 'data.tar.gz', 'data.tar.xz',
        }, 'UNSUPPORTED_AR_MEMBER:' + name)
        require(all(existing != name for existing, _ in members), 'DUPLICATE_AR_MEMBER:' + name)
        members.append((name, data[body_start:body_end]))
        pos = padded_end

    names = [name for name, _ in members]
    require(len(names) == 3 and names[0] == 'debian-binary', 'BAD_DEB_MEMBERS')
    control_names = [name for name in names if name.startswith('control.tar')]
    data_names = [name for name in names if name.startswith('data.tar')]
    require(len(control_names) == 1 and len(data_names) == 1, 'BAD_DEB_MEMBERS')
    require(names[1] == control_names[0] and names[2] == data_names[0], 'BAD_DEB_MEMBER_ORDER')
    require(members[0][1].strip() == b'2.0', 'BAD_DEB_MEMBERS')
    return dict(members)


def decompress_tar(blob, member_name):
    """Decode an allowed tar variant without ever materializing beyond the cap."""
    try:
        if member_name.endswith('.gz'):
            stream = gzip.GzipFile(fileobj=io.BytesIO(blob), mode='rb')
        elif member_name.endswith('.xz'):
            stream = lzma.LZMAFile(io.BytesIO(blob), mode='rb')
        else:
            stream = io.BytesIO(blob)
        output = io.BytesIO()
        total = 0
        while True:
            chunk = stream.read(1024 * 1024)
            if not chunk:
                break
            total += len(chunk)
            require(total <= MAX_TAR_SIZE, 'DECOMPRESSED_TAR_TOO_LARGE:' + member_name)
            output.write(chunk)
        stream.close()
        return output.getvalue()
    except Reject:
        raise
    except (OSError, EOFError, ValueError, lzma.LZMAError, zlib.error) as exc:
        raise Reject('BAD_COMPRESSED_TAR:' + member_name) from exc


def open_tar(blob, member_name):
    decoded = decompress_tar(blob, member_name)
    try:
        return tarfile.open(fileobj=io.BytesIO(decoded), mode='r:')
    except (tarfile.TarError, OSError, EOFError, ValueError) as exc:
        raise Reject('BAD_TAR:' + member_name) from exc


def safe_name(name):
    require(name and not name.startswith('/') and '\\' not in name and '\0' not in name,
            'UNSAFE_PATH:' + repr(name))
    # Debian tar archives conventionally prefix members with exactly one ./.
    if name.startswith('./'):
        name = name[2:]
    if name.endswith('/'):
        name = name[:-1]
    if name == '.':
        return '.'
    parts = name.split('/')
    require(all(part not in ('', '.', '..') for part in parts), 'UNSAFE_PATH:' + repr(name))
    require(not re.match(r'^[A-Za-z]:', name), 'UNSAFE_PATH:' + repr(name))
    return '/'.join(parts)


def reject_ancestor_conflicts(entries, code):
    """Reject a file ancestor regardless of member ordering or explicit dirs."""
    for name in entries:
        parts = name.split('/')
        for index in range(1, len(parts)):
            ancestor = '/'.join(parts[:index])
            require(entries.get(ancestor) != 'file', code + ':' + ancestor)


def inspect(path):
    require(path.is_file() and path.stat().st_size <= MAX_DEB_SIZE,
            'INPUT_NOT_FILE_OR_TOO_LARGE:' + str(path))
    raw = path.read_bytes()
    digest = hashlib.sha256(raw).hexdigest()
    archive = parse_ar(raw)
    control_name = next(name for name in archive if name.startswith('control.tar'))
    control_tar = open_tar(archive[control_name], control_name)
    control = None
    try:
        for index, member in enumerate(control_tar):
            require(index < MAX_MEMBERS, 'TOO_MANY_CONTROL_MEMBERS')
            if safe_name(member.name) == 'control':
                require(control is None, 'DUPLICATE_CONTROL_MEMBER')
                require(member.isfile() and member.size <= MAX_CONTROL_SIZE, 'BAD_CONTROL')
                stream = control_tar.extractfile(member)
                control = stream.read(MAX_CONTROL_SIZE + 1) if stream else None
                require(control is not None and len(control) <= MAX_CONTROL_SIZE, 'BAD_CONTROL')
    finally:
        control_tar.close()
    require(control is not None, 'CONTROL_MISSING')

    try:
        fields = {}
        for line in control.decode('utf-8').splitlines():
            if ':' not in line or line[:1].isspace():
                continue
            key, value = line.split(':', 1)
            key = key.lower()
            if key in ('package', 'version', 'architecture'):
                require(key not in fields, 'CONTROL_DUPLICATE_FIELD:' + key)
                fields[key] = value.strip()
    except UnicodeDecodeError as exc:
        raise Reject('CONTROL_ENCODING') from exc
    identity = tuple(fields.get(key, '') for key in ('package', 'version', 'architecture'))
    require(all(identity), 'CONTROL_IDENTITY_MISSING')

    data_name = next(name for name in archive if name.startswith('data.tar'))
    payload_tar = open_tar(archive[data_name], data_name)
    entries = {}
    total = 0
    try:
        for index, member in enumerate(payload_tar):
            require(index < MAX_MEMBERS, 'TOO_MANY_MEMBERS')
            name = safe_name(member.name)
            if name == '.':
                require(member.isdir(), 'UNSAFE_PATH:' + repr(member.name))
                continue
            require(member.isdir() or member.isfile(), 'LINK_OR_SPECIAL_REJECTED:' + name)
            require(not member.mode & 0o6000, 'SETID_MODE:' + name)
            kind = 'dir' if member.isdir() else 'file'
            require(member.size <= MAX_MEMBER_SIZE, 'MEMBER_TOO_LARGE:' + name)
            if member.isfile():
                total += member.size
                require(total <= MAX_TAR_SIZE, 'PAYLOAD_TOO_LARGE')
                stream = payload_tar.extractfile(member)
                require(stream is not None, 'UNREADABLE:' + name)
                remaining = member.size
                while remaining:
                    chunk = stream.read(min(1024 * 1024, remaining))
                    require(chunk, 'SIZE_MISMATCH:' + name)
                    remaining -= len(chunk)
                require(not stream.read(1), 'SIZE_MISMATCH:' + name)
            previous = entries.get(name)
            require(previous is None or previous == kind == 'dir', 'INTRA_PACKAGE_COLLISION:' + name)
            entries[name] = kind
    finally:
        payload_tar.close()
    reject_ancestor_conflicts(entries, 'INTRA_PACKAGE_COLLISION')
    return identity, digest, entries


def audit(paths):
    packages = {}
    owners = {}
    for path in paths:
        identity, digest, entries = inspect(path)
        if identity in packages:
            require(packages[identity] == digest,
                    'DUPLICATE_PACKAGE_DIFFERENT_HASH:' + ':'.join(identity))
            continue
        packages[identity] = digest
        for name, kind in entries.items():
            previous = owners.get(name)
            require(previous is None or previous[0] == kind == 'dir',
                    'CROSS_PACKAGE_COLLISION:' + name)
            owners[name] = (kind, ':'.join(identity))
    # The completed map makes ancestor checks independent of archive/package order.
    reject_ancestor_conflicts({name: value[0] for name, value in owners.items()},
                              'CROSS_PACKAGE_COLLISION')
    require(packages, 'NO_PACKAGES')
    return {
        'audit': 'payload-path-collisions-only',
        'qualified': False,
        'provenanceValidated': False,
        'packageCount': len(packages),
        'packages': [{'identity': ':'.join(key), 'sha256': value}
                     for key, value in sorted(packages.items())],
        'result': 'no-collisions',
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('debs', nargs='+', type=pathlib.Path)
    args = parser.parse_args()
    try:
        print(json.dumps(audit(args.debs), indent=2, sort_keys=True))
        return 0
    except (Reject, OSError, tarfile.TarError, EOFError, gzip.BadGzipFile,
            lzma.LZMAError, zlib.error, ValueError) as exc:
        reason = str(exc) or type(exc).__name__
        print('REJECTED: ' + reason, file=sys.stderr)
        return 2


if __name__ == '__main__':
    sys.exit(main())
