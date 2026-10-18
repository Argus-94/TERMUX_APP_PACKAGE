# TERMUX_APP_PACKAGE

Candidate package pipelines for the private AI Builder Android runtime (`com.karat.aibuilder`, `aarch64`), not stock Termux.

## Production remains blocked

The repository contains a legacy pool of 133 `.deb` files without complete verified build provenance. It is **not** a trusted installation source. Do not use legacy packages, stock `com.termux` feeds/packages, PocketForge artifacts, `trusted=yes`, or unauthenticated/insecure APT options. GitHub Pages is not enabled; no production feed URL is available.

Separate candidate pipelines have passed hosted source builds, static package/ELF audits, and ephemeral-signed APT download/simulation checks for Make, gh, Git, curl, wget, pkg-config, Python, Node.js/npm, OpenJDK 17, and CMake/Ninja. Exact package versions and inputs are pinned in the corresponding `*candidate-package-set.json` files. These are separate closures, not an approved combined feed.

- OpenJDK `17.0.20`: 36 required runtime packages / 46 source dependency alternatives; [successful hosted run](https://github.com/Argus-94/TERMUX_APP_PACKAGE/actions/runs/39080124869).
- CMake `4.4.4` + Ninja `1.13.2`: 22 required runtime packages / 34 source dependency alternatives; [successful hosted run](https://github.com/Argus-94/TERMUX_APP_PACKAGE/actions/runs/39086630210).
- Make handoff integrity hardening, merged in PR #10: [successful merge-commit policy run](https://github.com/Argus-94/TERMUX_APP_PACKAGE/actions/runs/39088931746). This checks synthetic fixtures and temporary signatures, not Android installation.

**Android install, runtime, project build, upgrade, and rollback are all NOT RUN.** CI models the private prefix; it does not observe an installed APK. The old, narrowly authorized Make device-test artifact expired on October 16, 2026. Ordinary candidate runs upload no package artifacts and clean up temporary packages, feeds, and signing material.

Production signing/feed publication, Pages deployment, and Builder `pkg.ensure` must remain disabled until the exact Android qualification evidence is independently reviewed and publication is separately authorized. No evidence validator, passing CI, or manual report automatically promotes a candidate.

See the [Android qualification and production gate](docs/PRODUCTION_GATE_RU.md), [signed evidence bundle checks](docs/ANDROID_EVIDENCE_RU.md), and [feed signing notes](docs/FEED_SIGNING_RU.md).

## Local policy checks

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s scripts/tests -v
bash scripts/test-candidate-feed-policy.sh
bash scripts/test-candidate-dependency-closure.sh
bash scripts/test-pinned-termux-recipe-closure.sh
bash scripts/test-device-test-artifact-staging.sh
bash scripts/test-signed-feed-smoke.sh
bash termux-private-package-kit/make-v476/verify-kit.sh
```

Tests use synthetic fixtures where indicated; they install no Android packages and provide no device proof. See each package kit for its additional candidate-specific regression tests.
