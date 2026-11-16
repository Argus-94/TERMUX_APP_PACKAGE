/**
 * Consistent signing keystore policy (antigravity-inspired seamless upgrades).
 * Does not change compile settings — only documents and validates expected paths.
 */

export const KEYSTORE_POLICY = {
  /** Canonical private keystore under Termux home (not shared storage). */
  canonicalPath: "$HOME/.aibuilder/keys/aib-debug.keystore",
  alias: "androiddebugkey",
  /** All release APKs for com.karat.aibuilder should share the same signing identity. */
  packageName: "com.karat.aibuilder",
  rules: [
    "Use one consistent keystore across in-place APK upgrades",
    "Never generate a second debug keystore for the same install lineage",
    "Store keys under $HOME/.aibuilder/keys (private), not /storage/emulated/0",
    "After upgrade: sessions, knowledge, checkpoints must remain",
  ],
} as const;

export function formatKeystorePolicyBlock(): string {
  return [
    "[KEYSTORE_POLICY]",
    `package=${KEYSTORE_POLICY.packageName}`,
    `path=${KEYSTORE_POLICY.canonicalPath}`,
    `alias=${KEYSTORE_POLICY.alias}`,
    ...KEYSTORE_POLICY.rules.map((r, i) => `rule${i + 1}=${r}`),
  ].join("\n");
}

/** Shell snippet to verify keystore exists (host Termux). */
export function buildKeystorePresenceCheckCommand(): string {
  return `KEYS="$HOME/.aibuilder/keys"; KS="$KEYS/aib-debug.keystore"; mkdir -p "$KEYS"; if [ -s "$KS" ]; then echo "KEYSTORE_OK=$KS"; ls -la "$KS"; else echo "KEYSTORE_MISSING=$KS"; fi`;
}
