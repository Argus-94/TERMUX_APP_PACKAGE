---
name: android-build-recovery
version: 1.0.0
platforms: [android, termux]
---

# Android Build Recovery

Use this procedural skill when an APK build fails.

1. Capture the real command, exit code and first meaningful error.
2. Classify the failure: prepare, Gradle/source, dependencies, Android toolchain, network, signing, or verification.
3. Inspect the actual project and environment before editing.
4. Apply the smallest safe root-cause fix.
5. Verify that fix with a targeted command.
6. Re-run the real build.
7. If the same failure fingerprint returns, do not repeat the same repair. Change strategy or inspect a different layer.
8. Accept success only when the APK exists and V1+V2+V3 signing is verified.

Never pipe a live Gradle build to `head` or `tail`, never install desktop x86_64/amd64 artifacts on Termux aarch64, and never claim success from model text alone.
