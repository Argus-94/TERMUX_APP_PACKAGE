/**
 * Privilege awareness summary for agent prompts (antigravity-inspired).
 * Describes standard user vs Shizuku vs root without requiring those privileges.
 */

export type PrivilegeLevel = "user" | "shizuku" | "root" | "unknown";

export type PrivilegeSnapshot = {
  level: PrivilegeLevel;
  shizukuAvailable: boolean;
  rootAvailable: boolean;
  notes: string[];
};

let lastSnapshot: PrivilegeSnapshot = {
  level: "user",
  shizukuAvailable: false,
  rootAvailable: false,
  notes: ["Default: standard app user. Elevate only when required."],
};

export function getPrivilegeSnapshot(): PrivilegeSnapshot {
  return { ...lastSnapshot, notes: [...lastSnapshot.notes] };
}

export function setPrivilegeSnapshot(partial: Partial<PrivilegeSnapshot>): PrivilegeSnapshot {
  lastSnapshot = {
    level: partial.level ?? lastSnapshot.level,
    shizukuAvailable: partial.shizukuAvailable ?? lastSnapshot.shizukuAvailable,
    rootAvailable: partial.rootAvailable ?? lastSnapshot.rootAvailable,
    notes: partial.notes ?? lastSnapshot.notes,
  };
  return getPrivilegeSnapshot();
}

/**
 * Format a compact privilege block for system prompts.
 * Detection of Shizuku/root is left to native/bridge layers; this module only formats.
 */
export function formatPrivilegeBlock(snapshot: PrivilegeSnapshot = getPrivilegeSnapshot()): string {
  return [
    "[PRIVILEGE]",
    `level=${snapshot.level}`,
    `shizuku=${snapshot.shizukuAvailable ? "available" : "unknown_or_unavailable"}`,
    `root=${snapshot.rootAvailable ? "available" : "not_assumed"}`,
    "policy=never assume root; use Shizuku only for ADB-shell class ops (pm, logs, shared storage) when granted; otherwise stay in app/Termux user context",
    snapshot.notes.length ? `notes=${snapshot.notes.join(" | ")}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

export function privilegeOneLiner(snapshot: PrivilegeSnapshot = getPrivilegeSnapshot()): string {
  return `privilege=${snapshot.level}; shizuku=${snapshot.shizukuAvailable}; root=${snapshot.rootAvailable}; no root assumption`;
}


/** Best-effort shell probe (host Termux). Does not require Shizuku APK. */
export function buildShizukuProbeCommand(): string {
  return [
    'echo "=== PRIVILEGE_PROBE ==="',
    'id',
    'command -v rish >/dev/null 2>&1 && echo SHIZUKU_RISH=yes || echo SHIZUKU_RISH=no',
    'pm path moe.shizuku.privileged.api 2>/dev/null | head -1 || echo SHIZUKU_PKG=unknown',
    '[ "$(id -u)" = "0" ] && echo ROOT=yes || echo ROOT=no',
  ].join("; ");
}

export function interpretPrivilegeProbeOutput(output: string): PrivilegeSnapshot {
  const out = String(output || "");
  const shizuku = /SHIZUKU_RISH=yes/i.test(out) || /moe\.shizuku/i.test(out);
  const root = /ROOT=yes/i.test(out) || /\buid=0\(root\)/i.test(out);
  let level: PrivilegeLevel = "user";
  if (root) level = "root";
  else if (shizuku) level = "shizuku";
  return setPrivilegeSnapshot({
    level,
    shizukuAvailable: shizuku,
    rootAvailable: root,
    notes: [
      shizuku ? "Shizuku markers detected" : "Shizuku not detected",
      root ? "root uid observed" : "running as non-root",
    ],
  });
}
