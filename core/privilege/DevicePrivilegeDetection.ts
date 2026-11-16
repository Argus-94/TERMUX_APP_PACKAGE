/**
 * Device-side privilege detection using Termux + Shizuku bridge.
 * Safe on non-Android / node selftests (returns none).
 */

import type { CapabilityDetection, PrivilegeLevel } from "./PrivilegeProvider";

export async function detectDevicePrivileges(): Promise<CapabilityDetection> {
  let shizuku = false;
  let root = false;
  let adb = false;

  try {
    const { probeShizukuBridge } = await import("../../lib/shizuku-bridge");
    const st = await probeShizukuBridge();
    // package OR rish counts as "shizuku path available"
    shizuku = st.packagePresent || st.rishPresent || st.ready;
  } catch {
    try {
      const { getAddonStatus } = await import("../../lib/termux-addon-installer");
      const status = await getAddonStatus("shizuku");
      shizuku = !!status?.installed;
    } catch {
      /* ignore */
    }
  }

  try {
    const { runShellCommand, isNativeModuleAvailable } = await import("../../lib/termux-bridge");
    if (isNativeModuleAvailable()) {
      const r = await runShellCommand("id -u", { timeoutMs: 8000 });
      if (r && typeof r === "object" && "stdout" in r) {
        root = String((r as { stdout?: string }).stdout ?? "").trim() === "0";
      }
      const adbProbe = await runShellCommand(
        "command -v adb >/dev/null 2>&1; echo $?",
        { timeoutMs: 8000 },
      );
      if (adbProbe && typeof adbProbe === "object" && "stdout" in adbProbe) {
        adb = String((adbProbe as { stdout?: string }).stdout ?? "").trim() === "0";
      }
    }
  } catch {
    /* ignore */
  }

  let active: PrivilegeLevel = "none";
  if (root) active = "root";
  else if (shizuku) active = "shizuku";
  else if (adb) active = "adb";

  return {
    none: true,
    shizuku,
    root,
    adb,
    active,
  };
}
