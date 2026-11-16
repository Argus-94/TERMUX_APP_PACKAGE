/** Honest hardening envelope for proot/userspace: only shell RLIMITs are attempted. */
export type HardenedProotPolicy = Readonly<{ nofile?: number; nproc?: number; memorySoftKb?: number; memoryHardKb?: number }>;
export type HardenedProotErrorCode = "HARDENED_PROOT_NOFILE_INVALID" | "HARDENED_PROOT_NPROC_INVALID" | "HARDENED_PROOT_MEMORY_SOFT_KB_INVALID" | "HARDENED_PROOT_MEMORY_HARD_KB_INVALID" | "HARDENED_PROOT_COMMAND_INVALID" | "HARDENED_PROOT_MEMORY_ORDER_INVALID";
export class HardenedProotError extends Error { constructor(readonly code: HardenedProotErrorCode) { super(code); this.name = "HardenedProotError"; } }
export type HardenedProotOptions = Readonly<{
  shellCommand: string;
  requestedLimits: Readonly<{ nofile: number; nproc: number; memorySoftKb?: number; memoryHardKb?: number }>;
  enforcedBy: "guest-shell-rlimit-best-effort";
  unsupported: readonly string[];
  fallback: "legacy-command-if-limit-setup-fails";
}>;

const DEFAULT_POLICY: Required<Pick<HardenedProotPolicy, "nofile" | "nproc">> = { nofile: 256, nproc: 128 };
const UNSUPPORTED = Object.freeze([
  "cap-drop: PRoot does not remove host Linux capabilities",
  "no-new-privileges: PRoot cannot set the kernel prctl flag",
  "read-only-rootfs: PRoot path emulation does not enforce mount-level read-only semantics",
  "tmpfs: PRoot does not create kernel tmpfs mounts for /tmp, /var/tmp or /run",
  "cgroup-pids-limit: PRoot cannot create a PID-cgroup limit; ulimit -u is only per-user RLIMIT_NPROC",
  "workspace-only-write: guest rootfs remains a host directory and is not kernel write-isolated from other mounted paths",
]);

function shellQuote(value: string): string { return `'${value.replace(/'/g, `'\\''`)}'`; }
function validLimit(value: number | undefined, fallback: number, name: string, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new HardenedProotError(`HARDENED_PROOT_${name.toUpperCase()}_INVALID` as HardenedProotErrorCode);
  return value;
}

/** Construct an in-guest wrapper; unsupported kernel/container flags are never fabricated. */
export function buildHardenedProotOptions(command: string, policy: HardenedProotPolicy = {}): HardenedProotOptions {
  if (!command || command.includes("\0")) throw new HardenedProotError("HARDENED_PROOT_COMMAND_INVALID");
  const nofile = validLimit(policy.nofile, DEFAULT_POLICY.nofile, "nofile", 65_536);
  const nproc = validLimit(policy.nproc, DEFAULT_POLICY.nproc, "nproc", 1_000_000);
  const memorySoftKb = policy.memorySoftKb === undefined ? undefined : validLimit(policy.memorySoftKb, 0, "memory_soft_kb", 1_073_741_824);
  const memoryHardKb = policy.memoryHardKb === undefined ? undefined : validLimit(policy.memoryHardKb, 0, "memory_hard_kb", 1_073_741_824);
  if (memorySoftKb !== undefined && memoryHardKb !== undefined && memorySoftKb > memoryHardKb) throw new HardenedProotError("HARDENED_PROOT_MEMORY_ORDER_INVALID");
  const limits = [`ulimit -n ${nofile}`, `ulimit -u ${nproc}`];
  if (memoryHardKb !== undefined) limits.push(`ulimit -H -v ${memoryHardKb}`);
  if (memorySoftKb !== undefined) limits.push(`ulimit -S -v ${memorySoftKb}`);
  const setup = limits.map((line) => `${line} 2>/dev/null`).join(" && ");
  // Try shell RLIMIT setup, then execute the supplied shell program exactly once
  // whether setup succeeds or not. Do not prefix a compound body with `exec`:
  // a leading builtin such as `export` would be treated as an external binary.
  const body = `if ${setup}; then :; fi\n${command}`;
  return {
    shellCommand: `sh -c ${shellQuote(body)}`,
    requestedLimits: { nofile, nproc, ...(memorySoftKb === undefined ? {} : { memorySoftKb }), ...(memoryHardKb === undefined ? {} : { memoryHardKb }) },
    enforcedBy: "guest-shell-rlimit-best-effort",
    unsupported: UNSUPPORTED,
    fallback: "legacy-command-if-limit-setup-fails",
  };
}

/** Adapter for backends that already invoke an inner login shell (for example proot-distro). */
export function wrapHardenedShellBody(command: string, policy: HardenedProotPolicy = {}): string {
  const guarded = buildHardenedProotOptions(command, policy).shellCommand;
  return guarded;
}
