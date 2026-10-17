# Node.js 26.4.0 + npm 11.20.0 private candidate

Candidate-only build for the modeled AI Builder app-private Android/Bionic AArch64 prefix. This kit does not install packages, publish a feed, upload artifacts, enable Pages, or enable Builder `pkg.ensure`. Android install, runtime and rollback remain **NOT RUN**.

## Exact source and provider lock

The Termux source is pinned to `505e06ef0c8dbd7611abfb90e9eb60826dcd01d7`, and the official builder is digest-pinned. `nodejs-npm-candidate-package-set.json` locks 11 runtime packages and 14 dependency alternatives. Both `nodejs` and `npm` are explicit roots; npm is architecture `all`.

The original npm dependency relation remains exactly `nodejs | nodejs-lts`, but the candidate closure contains only the explicitly selected `nodejs` provider. LTS, current, undeclared dependencies, changed source relations and provider drift are rejected. Recommendation expansion and binary dependency downloads are disabled.

## Source and license provenance

`nodejs-npm-source-provenance.patch` is hash-locked and restricted to three recipes. It replaces npm's mutable git-tag download with checksum-verified archive of npm CLI commit `d12b9434dd010b5fb7044c3cc149cdda317813f8`, preserves ICU's LICENSE from its checksum-verified archive instead of an unverified network replacement, and installs Node/npm bundled LICENSE files.

`verified-source-licenses.json` records source archive and license payload SHA-256 values. All three archives were streamed, their complete hashes matched the recipes/patch, and their top-level LICENSE bytes were hashed without saving large archives. Candidate audits require these exact regular LICENSE payloads for Node.js, npm and ICU. Shared generic licenses are backed by embedded v476 bootstrap archive evidence, including NCSA verified byte-for-byte against the pinned termux-licenses source; this is not observed Android state.

## Gates

The driver verifies the clean source commit, exact manifest, recipe closure, build-script and AppArmor hashes, changed-file scope and modeled private-prefix properties before building. Static audits cover payload paths and links, foreign Android paths, license evidence, AArch64 ELF, interpreter/RPATH, library providers, and hashes.

Hosted CI creates an ephemeral signed feed, verifies package/index hashes and required dependency closure, and simulates installing npm with recommendations disabled. The simulated package-name/version set must equal all 11 candidate packages. npm's `all` metadata is checked explicitly while APT targets AArch64. The CI runner deletes only its own temporary source, packages, feed, logs and signing material after the run.

The local environment has no Docker and insufficient free space for a binary build; local syntax/unit checks are not build or device evidence. Hosted build/audit/signing/APT gates must pass before calling this candidate verified.

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s termux-private-package-kit/nodejs-npm/tests -v
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s scripts/tests -v
```

Entry point: `build-nodejs-npm-private-aarch64.sh <clean-pinned-source> <package-set.json> <new-empty-output>`, with the same modeled-prefix and digest-pinned builder environment variables as the workflow. The driver never pulls an image itself.
