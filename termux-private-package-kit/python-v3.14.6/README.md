# Private Python 3.14.6 candidate kit

This kit builds the pinned Termux `python` root package for the modeled Builder-private AArch64 prefix. It is a **candidate-only** pipeline: source hashes, recipe/dependency locks, licenses, payload paths, ELF architecture/library providers and package identity are checked before a temporary signed APT feed is simulated.

- Source commit: `505e06ef0c8dbd7611abfb90e9eb60826dcd01d7`
- Required runtime closure: 17 packages / 25 dependency alternatives
- `tk` is a pinned-source build-only dependency; `tcl`, `tk`, and `python-tkinter` are not in the candidate feed.
- `python-pip` and `python-ensurepip-wheels` are recommendations and are excluded from the required closure and simulated installation.
- Candidate build changes are limited to app-private prefix properties plus the doc-only ncurses split-license patch.
- Build outputs, signing key, feed and APT state are temporary; the workflow uploads no packages and publishes no repository or Pages site.
- `apt-get --simulate` does not install the packages. Android device install, runtime tests and rollback proof remain **NOT RUN**; production publication stays blocked.

Run `tests/test_audit_python_closure.py` for metadata and policy tests. The actual build/audit/feed simulation is performed by `.github/workflows/python-package-candidate.yml` only on the candidate branch.
