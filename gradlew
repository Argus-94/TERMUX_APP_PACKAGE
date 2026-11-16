#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# CBE / CI shim for Expo (managed) projects.
# Cloud Build Engine looks for ./gradlew; Expo source ZIPs do not contain the
# native android/ tree until `expo prebuild` runs. This wrapper generates it
# on the runner, then forwards all Gradle arguments to android/gradlew.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

log() { echo "[expo-gradlew] $*"; }

ensure_android() {
  if [ -x "$ROOT/android/gradlew" ]; then
    return 0
  fi

  log "android/gradlew missing — running Expo prebuild on the CI runner…"

  if ! command -v node >/dev/null 2>&1; then
    log "ERROR: node is required for expo prebuild"
    exit 1
  fi

  if [ ! -d "$ROOT/node_modules/expo" ]; then
    if ! command -v pnpm >/dev/null 2>&1; then
      log "ERROR: pnpm 9.15.0 is required; npm fallback is disabled because pnpm-lock.yaml is the canonical lockfile"
      exit 1
    fi
    log "Installing pnpm dependencies from the canonical lockfile…"
    pnpm --version
    pnpm install --frozen-lockfile
  fi

  if ! command -v pnpm >/dev/null 2>&1; then
    log "ERROR: pnpm 9.15.0 is required for the canonical lockfile"
    exit 1
  fi

  log "pnpm exec expo prebuild --platform android --no-install…"
  # Never let npx fetch an unpinned Expo package. The project lockfile is the
  # only dependency source for this CI shim. If the local dependency tree is
  # incomplete, refresh it with the canonical frozen lockfile and retry.
  if ! pnpm exec expo prebuild --platform android --no-install; then
    log "prebuild failed — refreshing the frozen pnpm dependency tree…"
    pnpm install --frozen-lockfile
    pnpm exec expo prebuild --platform android --no-install
  fi

  if [ ! -x "$ROOT/android/gradlew" ]; then
    log "ERROR: android/gradlew still missing after prebuild"
    find "$ROOT" -name "gradlew" 2>/dev/null | head -20 || true
    exit 1
  fi
  chmod +x "$ROOT/android/gradlew"
  log "prebuild OK — android/gradlew ready"
}

ensure_android

# CBE copies key.properties next to the found gradlew (project root).
# Expo signing expects it under android/.
# The build-loop may discover the SDK before prebuild. Keep the generated
# Android project in sync with the root-level local.properties used by the
# source-only CI shim.
if [ -f "$ROOT/local.properties" ]; then
  cp "$ROOT/local.properties" "$ROOT/android/local.properties"
  log "copied local.properties → android/"
fi

if [ -f "$ROOT/key.properties" ] && [ ! -f "$ROOT/android/key.properties" ]; then
  cp "$ROOT/key.properties" "$ROOT/android/key.properties"
  log "copied key.properties → android/"
fi

# Forward Gradle JVM / packaging tweaks that CBE applies on GRADLE_DIR
# (root) into android/gradle.properties as well.
if [ -f "$ROOT/gradle.properties" ] && [ -f "$ROOT/android/gradle.properties" ]; then
  while IFS= read -r line; do
    case "$line" in
      org.gradle.jvmargs=*|org.gradle.daemon=*|android.useAndroidX=*|android.enableJetifier=*)
        key="${line%%=*}"
        if ! grep -q "^${key}=" "$ROOT/android/gradle.properties" 2>/dev/null; then
          echo "$line" >> "$ROOT/android/gradle.properties"
        fi
        ;;
    esac
  done < "$ROOT/gradle.properties"
fi

cd "$ROOT/android"

# Cloud Build Engine has been observed to forward corrupted task names,
# e.g. "assemble\Release" instead of "assembleRelease" (a stray backslash
# before the capitalized suffix). This breaks task resolution:
#   Task 'assemble\Release' not found ... Some candidates are: 'assembleRelease'.
# Gradle task names never legitimately contain a backslash on this
# (Linux) runner, so strip any that slip in from non-flag arguments
# before forwarding to the real wrapper.
args=()
for a in "$@"; do
  case "$a" in
    -*)
      args+=("$a")
      ;;
    *)
      clean="${a//\\/}"
      if [ "$clean" != "$a" ]; then
        log "sanitized malformed task argument: '$a' -> '$clean'"
      fi
      args+=("$clean")
      ;;
  esac
done

exec ./gradlew "${args[@]}"
