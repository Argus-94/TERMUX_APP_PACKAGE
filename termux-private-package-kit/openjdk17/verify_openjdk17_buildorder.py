#!/usr/bin/env python3
"""Check the controlled source-only audio build order before any compilation."""
from __future__ import annotations
import argparse
import os
import pathlib
import subprocess
import sys

EXPECTED_BUILD_DEPENDENCY_COUNT = 120

def validate_order(names: list[str]) -> None:
    if len(names) != EXPECTED_BUILD_DEPENDENCY_COUNT or len(set(names)) != len(names):
        raise ValueError('BUILDORDER_PACKAGE_SET_COUNT_OR_DUPLICATE')
    if 'mpg123' in names:
        raise ValueError('OPTIONAL_CONSOLE_REINTRODUCES_AUDIO_CYCLE')
    if not {'libmpg123','libsndfile','pulseaudio'} <= set(names):
        raise ValueError('AUDIO_BUILDORDER_PACKAGE_MISSING')
    if not names.index('libmpg123') < names.index('libsndfile') < names.index('pulseaudio'):
        raise ValueError('AUDIO_SOURCE_BUILD_CYCLE_NOT_REMOVED')

def verify(source_root: pathlib.Path) -> None:
    root = source_root.resolve()
    env = {**os.environ, 'TERMUX_ARCH':'aarch64', 'TERMUX_PKG_LIBRARY':'bionic'}
    result = subprocess.run([sys.executable, str(root/'scripts/buildorder.py'), str(root/'packages/openjdk-17')],
                            cwd=root, env=env, check=True, text=True, capture_output=True, timeout=120)
    names = [line.split()[0] for line in result.stdout.splitlines() if line.strip()]
    validate_order(names)
    print('OPENJDK17_CONTROLLED_SOURCE_BUILDORDER_OK dependencies=120 decoder_before_sndfile_before_pulseaudio=1 optional_console=excluded')

if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-root',type=pathlib.Path,required=True)
    args=parser.parse_args()
    try:
        verify(args.source_root)
    except (OSError,ValueError,subprocess.SubprocessError) as exc:
        print('OPENJDK17_BUILDORDER_REJECTED:'+str(exc),file=sys.stderr)
        raise SystemExit(2)
