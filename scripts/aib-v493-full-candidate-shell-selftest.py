#!/usr/bin/env python3
"""Compatibility entrypoint: exercise the current full transaction template with isolated host mocks."""
from pathlib import Path
import runpy

if __name__ == '__main__':
    runpy.run_path(str(Path(__file__).with_name('aib-v493-coherent-install-selftest.py')), run_name='__main__')
