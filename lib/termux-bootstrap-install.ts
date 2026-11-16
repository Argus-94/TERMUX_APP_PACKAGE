/**
 * Shell builders for Termux bootstrap package installs.
 * They use the user's configured `pkg` sources as-is and never rewrite mirrors.
 */
import { buildProotDistroInstallCommand, buildProotDistroProbeCommand, buildProotInstalledAliasGuardShell, PROOT_ARCH_NORMALIZER_SHELL } from "./proot-distro-state.ts";
import { wrapTermuxAptInstallWithUpdate } from "./termux-apt-install.ts";

export function buildTermuxToolsBaseInstallCommand(): string {
  return wrapTermuxAptInstallWithUpdate(
    "apt-get install -y openjdk-17 unzip git wget curl",
    true,
  );
}

export function buildTermuxProotDistroInstallCommand(): string {
  return wrapTermuxAptInstallWithUpdate(
    "apt-get install -y proot-distro",
    true,
  );
}

/** Verify the selected guest through an exact proot-distro login and identity probe; the list is advisory, not absence authority. */
export function buildProotDistroRootfsCheckCommand(distro: "debian" | "ubuntu"): string {
  const marker = distro.toUpperCase();
  const probe = buildProotDistroProbeCommand(distro);
  return `set +e
PROBE_OUTPUT=$(
${probe}
)
# Harmless proot noise (duplicate storage binds) must not affect envelope counts.
PROBE_OUTPUT=$(printf '%s\n' "$PROBE_OUTPUT" | grep -v -E "binding '--bind=.+' overlaps with an existing one" || true)
${PROOT_ARCH_NORMALIZER_SHELL}
PROBE_BEGIN_COUNT=$(printf '%s\\n' "$PROBE_OUTPUT" | grep -c '^AIB_PROBE_BEGIN$')
PROBE_END_COUNT=$(printf '%s\\n' "$PROBE_OUTPUT" | grep -c '^AIB_PROBE_END$')
TOOL_AVAILABLE_COUNT=$(printf '%s\\n' "$PROBE_OUTPUT" | grep -c '^AIB_PROOT_TOOL:AVAILABLE$')
LOGIN_BEGIN_COUNT=$(printf '%s\\n' "$PROBE_OUTPUT" | grep -c '^AIB_LOGIN_BEGIN$')
LOGIN_END_COUNT=$(printf '%s\\n' "$PROBE_OUTPUT" | grep -c '^AIB_LOGIN_END$')
LOGIN_EXIT_COUNT=$(printf '%s\\n' "$PROBE_OUTPUT" | grep -Ec '^AIB_LOGIN_EXIT:-?[0-9]+$')
LOGIN_EXIT_CODE=$(printf '%s\\n' "$PROBE_OUTPUT" | sed -n 's/^AIB_LOGIN_EXIT://p')
HOST_UNAME_COUNT=$(printf '%s\\n' "$PROBE_OUTPUT" | grep -c '^AIB_HOST_UNAME:[A-Za-z0-9._-][A-Za-z0-9._-]*$')
HOST_UNAME_MARKER_COUNT=$(printf '%s\\n' "$PROBE_OUTPUT" | grep -c '^AIB_HOST_UNAME:')
GUEST_UNAME_COUNT=$(printf '%s\\n' "$PROBE_OUTPUT" | grep -c '^AIB_PROBE_UNAME:[A-Za-z0-9._-][A-Za-z0-9._-]*$')
GUEST_UNAME_MARKER_COUNT=$(printf '%s\\n' "$PROBE_OUTPUT" | grep -c '^AIB_PROBE_UNAME:')
ID_COUNT=$(printf '%s\\n' "$PROBE_OUTPUT" | grep -c '^AIB_PROBE_ID:${distro}$')
ID_MARKER_COUNT=$(printf '%s\\n' "$PROBE_OUTPUT" | grep -c '^AIB_PROBE_ID:')
UID_COUNT=$(printf '%s\\n' "$PROBE_OUTPUT" | grep -c '^AIB_PROBE_UID:[0-9][0-9]*$')
UID_MARKER_COUNT=$(printf '%s\\n' "$PROBE_OUTPUT" | grep -c '^AIB_PROBE_UID:')
HOST_UNAME=$(printf '%s\\n' "$PROBE_OUTPUT" | sed -n 's/^AIB_HOST_UNAME://p')
GUEST_UNAME=$(printf '%s\\n' "$PROBE_OUTPUT" | sed -n 's/^AIB_PROBE_UNAME://p')
HOST_ARCH=$(aib_normalize_arch "$HOST_UNAME")
GUEST_ARCH=$(aib_normalize_arch "$GUEST_UNAME")
LIST_OUTPUT=$(printf '%s\\n' "$PROBE_OUTPUT" | awk '/^AIB_LIST_BEGIN$/ { inside=1; next } /^AIB_LIST_END$/ { inside=0 } inside { print }')
LIST_EXIT_CODE=$(printf '%s\\n' "$PROBE_OUTPUT" | sed -n 's/^AIB_LIST_EXIT://p')
${buildProotInstalledAliasGuardShell(distro)}
LOGIN_OUTPUT=$(printf '%s\\n' "$PROBE_OUTPUT" | awk '/^AIB_LOGIN_BEGIN$/ { inside=1; next } /^AIB_LOGIN_END$/ { inside=0 } inside { print }')
LOGIN_NOT_INSTALLED_COUNT=$(printf '%s\\n' "$LOGIN_OUTPUT" | grep -Fxc "Error: container '${distro}' is not installed.")
if [ "$PROBE_BEGIN_COUNT" = 1 ] && [ "$PROBE_END_COUNT" = 1 ] && [ "$TOOL_AVAILABLE_COUNT" = 1 ] && [ "$LOGIN_BEGIN_COUNT" = 1 ] && [ "$LOGIN_END_COUNT" = 1 ] && [ "$LOGIN_EXIT_COUNT" = 1 ] && [ "$LOGIN_EXIT_CODE" = 0 ] && [ "$HOST_UNAME_COUNT" = 1 ] && [ "$HOST_UNAME_MARKER_COUNT" = 1 ] && [ "$GUEST_UNAME_COUNT" = 1 ] && [ "$GUEST_UNAME_MARKER_COUNT" = 1 ] && [ "$ID_COUNT" = 1 ] && [ "$ID_MARKER_COUNT" = 1 ] && [ "$UID_COUNT" = 1 ] && [ "$UID_MARKER_COUNT" = 1 ] && [ -n "$HOST_ARCH" ] && [ "$HOST_ARCH" != invalid ] && [ "$HOST_ARCH" = "$GUEST_ARCH" ]; then
  echo AIB_${marker}_ROOTFS_OK
  echo ${marker}_ROOTFS_OK
  exit 0
fi
# Partial callback (device bridge may drop AIB_*_END / UID): accept exact ID + arch match.
if [ "$ID_COUNT" = 1 ] && [ "$ID_MARKER_COUNT" = 1 ] && [ "$GUEST_UNAME_COUNT" = 1 ] && [ "$GUEST_UNAME_MARKER_COUNT" = 1 ]; then
  PARTIAL_HOST=$(uname -m 2>/dev/null)
  PARTIAL_HOST_ARCH=$(aib_normalize_arch "$PARTIAL_HOST")
  if [ -n "$PARTIAL_HOST_ARCH" ] && [ "$PARTIAL_HOST_ARCH" != invalid ] && [ -n "$GUEST_ARCH" ] && [ "$GUEST_ARCH" != invalid ] && [ "$PARTIAL_HOST_ARCH" = "$GUEST_ARCH" ]; then
    echo AIB_${marker}_ROOTFS_OK
    echo ${marker}_ROOTFS_OK
    exit 0
  fi
fi
if [ "$PROBE_BEGIN_COUNT" = 1 ] && [ "$PROBE_END_COUNT" = 1 ] && [ "$TOOL_AVAILABLE_COUNT" = 1 ] && [ "$LOGIN_BEGIN_COUNT" = 1 ] && [ "$LOGIN_END_COUNT" = 1 ] && [ "$LOGIN_EXIT_COUNT" = 1 ] && [ "$LOGIN_EXIT_CODE" = 1 ] && [ "$LOGIN_NOT_INSTALLED_COUNT" = 1 ]; then
  if [ "$LIST_ALIAS_VERIFIED" = 1 ]; then
    echo AIB_${marker}_ROOTFS_STATE_UNVERIFIED
    echo ${marker}_ROOTFS_STATE_UNVERIFIED
    exit 78
  fi
  echo AIB_${marker}_ROOTFS_MISSING
  echo ${marker}_ROOTFS_MISSING
  exit 1
fi
if [ "$LIST_ALIAS_VERIFIED" = 1 ]; then
  echo AIB_${marker}_ROOTFS_INSTALLED_LOGIN_FAILED
  echo ${marker}_ROOTFS_INSTALLED_LOGIN_FAILED
  echo "AIB_ROOTFS_DIAG: listVerified=1 loginExit=$LOGIN_EXIT_CODE idCount=$ID_COUNT uidCount=$UID_COUNT guestUnameCount=$GUEST_UNAME_COUNT"
  exit 78
fi
echo AIB_${marker}_ROOTFS_STATE_UNVERIFIED
echo ${marker}_ROOTFS_STATE_UNVERIFIED
echo "AIB_ROOTFS_DIAG: begin=$PROBE_BEGIN_COUNT end=$PROBE_END_COUNT tool=$TOOL_AVAILABLE_COUNT loginBegin=$LOGIN_BEGIN_COUNT loginEnd=$LOGIN_END_COUNT loginExit=$LOGIN_EXIT_CODE listVerified=$LIST_ALIAS_VERIFIED idCount=$ID_COUNT uidCount=$UID_COUNT hostArch=$HOST_ARCH guestArch=$GUEST_ARCH"
exit 78`;
}

export function buildProotDistroRootfsInstallCommand(distro: "debian" | "ubuntu"): string {
  const install = buildProotDistroInstallCommand(distro);
  const check = buildProotDistroRootfsCheckCommand(distro);
  return `set +e
INSTALL_OUTPUT=$(
${install}
)
INSTALL_EC=$?
printf '%s\\n' "$INSTALL_OUTPUT"
if [ "$INSTALL_EC" -ne 0 ]; then exit "$INSTALL_EC"; fi
CHECK_OUTPUT=$(
${check}
)
CHECK_EC=$?
printf '%s\\n' "$CHECK_OUTPUT"
if [ "$CHECK_EC" -ne 0 ]; then exit "$CHECK_EC"; fi
echo ${distro.toUpperCase()}_INSTALL_OK
exit 0`;
}
