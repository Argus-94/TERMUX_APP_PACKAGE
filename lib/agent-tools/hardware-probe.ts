/**
 * Optional hardware / storage probe (antigravity-inspired diagnostics).
 * Provides command builders only; execution goes through existing Termux runner.
 */

export type HardwareProbeKind = "storage-quick" | "cpu-quick" | "uname";

export function buildHardwareProbeCommand(kind: HardwareProbeKind = "storage-quick"): string {
  switch (kind) {
    case "uname":
      return `uname -a; echo "---"; getprop ro.product.model 2>/dev/null; getprop ro.build.version.release 2>/dev/null; nproc 2>/dev/null || echo cores_unknown`;
    case "cpu-quick":
      return `echo "=== CPU ==="; nproc 2>/dev/null; cat /proc/cpuinfo 2>/dev/null | head -40; echo "=== MEM ==="; cat /proc/meminfo 2>/dev/null | head -8`;
    case "storage-quick":
    default:
      return [
        `echo "=== STORAGE (df) ==="`,
        `df -h /data /storage/emulated/0 2>/dev/null || df -h`,
        `echo "=== QUICK WRITE TEST ==="`,
        `TDIR=/storage/emulated/0/AIBuilderTermux/.probe; mkdir -p "$TDIR" 2>/dev/null;`,
        `DD=$(dd if=/dev/zero of="$TDIR/probe.bin" bs=1M count=32 conv=fsync 2>&1); echo "$DD";`,
        `rm -f "$TDIR/probe.bin" 2>/dev/null;`,
        `echo "=== DONE ==="`,
      ].join(" ");
  }
}

export function hardwareProbeDescription(kind: HardwareProbeKind): string {
  switch (kind) {
    case "uname":
      return "Kernel, model, Android version, CPU count";
    case "cpu-quick":
      return "CPU and memory snapshot from /proc";
    case "storage-quick":
    default:
      return "df + small sequential write probe under AIBuilderTermux";
  }
}
