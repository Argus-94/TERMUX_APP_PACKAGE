/**
 * Linux userspace runtime for Android/Termux.
 * Primary backend: proot-distro (no root required).
 * Projects remain on the AIBuilder host and are mounted at /workspace.
 */
import type { ExecutionEnvironment } from "../environment/ExecutionEnvironment";
import type { HomeLayout } from "../home/HomeLayout";
import { rootfsCandidates } from "../container/RootfsDiscovery";
import { parseInstalledProotDistroList } from "../../lib/proot-distro-state";

export type LinuxRuntimeProfile = "debian" | "ubuntu";
export type LinuxRuntimeStatus = {
  available: boolean;
  backend: "proot-distro" | "rootfs" | "unavailable";
  profile: LinuxRuntimeProfile;
  /** Whether the proot-distro command exists; this is not the same as distro readiness. */
  prootDistroInstalled: boolean | null;
  /** Installed and usable state is independent from AI Builder's own container metadata. */
  rootfsInstalled?: boolean | null;
  healthy?: boolean;
  stateSource?: "proot-distro-login" | "proot-distro-list" | "aib-rootfs" | "unknown";
  rootfsPath?: string;
  message: string;
};
export type LinuxExecResult = { exitCode: number; stdout: string; stderr: string; command: string; durationMs: number };

const ALLOWED_COMMANDS = new Set([
  "pwd", "ls", "cat", "head", "tail", "find", "grep", "sed", "awk",
  "node", "npm", "pnpm", "npx", "python", "python3", "pip", "pip3", "git", "java", "javac",
  "gradle", "./gradlew", "which", "uname", "env",
]);

function shellQuote(value: string): string {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}
function normalizeArgs(args: readonly string[]): string[] {
  return args.map((arg) => {
    if (arg.includes("\0") || arg.length > 4096) throw new Error("Invalid Linux argument");
    return arg;
  });
}
function isAllowed(command: string): boolean {
  return ALLOWED_COMMANDS.has(command.trim());
}

function isSafeCwd(cwd: string): boolean {
  if (cwd === "/tmp" || cwd === "/workspace") return true;
  if (!cwd.startsWith("/workspace/")) return false;
  const parts = cwd.slice(1).split("/");
  return parts.every((part) => part !== "" && part !== "." && part !== "..");
}

type DirectRootfsProbe =
  | { kind: "healthy"; path: string }
  | { kind: "absent" }
  | { kind: "unverified"; path?: string };

function buildDirectRootfsProbeCommand(rootfs: string, trustedRoot: string, profile: LinuxRuntimeProfile): string {
  const guest = `test -x /bin/sh || exit 80; ID=$(grep '^ID=' /etc/os-release 2>/dev/null | head -1 | cut -d= -f2 | tr -d '"'); GUEST_UID=$(id -u 2>/dev/null); UNAME=$(uname -m 2>/dev/null); printf 'AIB_DIRECT_ROOTFS_ID:%s\\n' "$ID"; printf 'AIB_DIRECT_ROOTFS_UID:%s\\n' "$GUEST_UID"; printf 'AIB_DIRECT_ROOTFS_UNAME:%s\\n' "$UNAME"; [ "$ID" = '${profile}' ] && [ -n "$GUEST_UID" ] && [ -n "$UNAME" ]`;
  return `ROOTFS_REAL=$(realpath -e -- ${shellQuote(rootfs)}) || { echo AIB_DIRECT_ROOTFS_PATH_UNVERIFIED; exit 80; }; ROOTS_REAL=$(realpath -e -- ${shellQuote(trustedRoot)}) || { echo AIB_DIRECT_ROOTFS_PATH_UNVERIFIED; exit 80; }; case "$ROOTFS_REAL" in "$ROOTS_REAL"/*) ;; *) echo AIB_DIRECT_ROOTFS_OUTSIDE_TRUSTED_ROOT; exit 81;; esac; proot -0 -r "$ROOTFS_REAL" -- /bin/sh -c ${shellQuote(guest)}`;
}

export class LinuxRuntime {
  constructor(private readonly environment: ExecutionEnvironment, private readonly home: HomeLayout) {}

  private async commandExists(command: string): Promise<boolean | null> {
    try {
      const result = await this.environment.exec(`command -v ${shellQuote(command)}`, { timeoutMs: 5000 });
      const r = result as { exitCode?: number; stdout?: string; stderr?: string; timedOut?: boolean };
      if (r.timedOut) return null;
      const exitCode = Number(r?.exitCode ?? -1);
      if (exitCode === 0 && Boolean(String(r.stdout ?? "").trim())) return true;
      if (exitCode === 1 && !String(r.stdout ?? "").trim() && !String(r.stderr ?? "").trim()) return false;
      return null;
    } catch { return null; }
  }

  private async findRootfs(profile: LinuxRuntimeProfile): Promise<DirectRootfsProbe> {
    const candidates = profile === "ubuntu"
      ? rootfsCandidates(this.home, "ubuntu")
      : [
          `${this.home.containers}/debian/images/base/rootfs`,
          `${this.home.containers}/debian/images/base`,
          `${this.home.containers}/images/debian/rootfs`,
          `${this.home.containers}/images/debian`,
        ];
    let candidateSeen = false;
    for (const candidate of candidates) {
      let exists: boolean;
      try { exists = await this.environment.exists(candidate); }
      catch { return { kind: "unverified", path: candidate }; }
      if (!exists) continue;
      candidateSeen = true;
      if (await this.commandExists("proot") !== true) return { kind: "unverified", path: candidate };
      try {
        const result = await this.runHostCommandLine(buildDirectRootfsProbeCommand(candidate, this.home.containers, profile), 20_000);
        const output = `${result.stdout}\n${result.stderr}`;
        const id = output.match(/^AIB_DIRECT_ROOTFS_ID:([A-Za-z0-9._-]{1,64})$/m)?.[1]?.toLowerCase();
        const uid = output.match(/^AIB_DIRECT_ROOTFS_UID:([0-9]{1,12})$/m)?.[1];
        const uname = output.match(/^AIB_DIRECT_ROOTFS_UNAME:([A-Za-z0-9._-]{1,64})$/m)?.[1];
        if (result.exitCode === 0 && id === profile && uid && uname) return { kind: "healthy", path: candidate };
      } catch { /* permission, timeout, corrupt rootfs, or proot failure all remain unverified */ }
    }
    return candidateSeen ? { kind: "unverified" } : { kind: "absent" };
  }

  async status(profile: LinuxRuntimeProfile = "debian"): Promise<LinuxRuntimeStatus> {
    const prootDistroInstalled = await this.commandExists("proot-distro");
    const directRootfs = await this.findRootfs(profile);
    const directHealthy = directRootfs.kind === "healthy";
    const directUnknown = directRootfs.kind === "unverified";
    if (prootDistroInstalled) {
      const guestProbe = `ID=$(grep '^ID=' /etc/os-release 2>/dev/null | head -1 | cut -d= -f2 | tr -d '"'); printf 'AIB_PROBE_ID:%s\\n' "$ID"; printf 'AIB_PROBE_UID:%s\\n' "$(id -u 2>/dev/null)"; printf 'AIB_PROBE_UNAME:%s\\n' "$(uname -m 2>/dev/null)"`;
      let probe: LinuxExecResult | undefined;
      try {
        probe = await this.runHostCommand("proot-distro", ["login", profile, "--", "sh", "-c", guestProbe], 45_000);
      } catch { /* reported as unknown below */ }
      const probeOutput = `${probe?.stdout ?? ""}\n${probe?.stderr ?? ""}`;
      const id = probeOutput.match(/^AIB_PROBE_ID:([A-Za-z0-9._-]{1,64})$/m)?.[1]?.toLowerCase();
      const uid = probeOutput.match(/^AIB_PROBE_UID:([0-9]{1,12})$/m)?.[1];
      const uname = probeOutput.match(/^AIB_PROBE_UNAME:([A-Za-z0-9._-]{1,64})$/m)?.[1];
      if (probe?.exitCode === 0 && id === profile && uid && uname) {
        return { available: true, backend: "proot-distro", profile, prootDistroInstalled: true, rootfsInstalled: true, healthy: true, stateSource: "proot-distro-login", message: `${profile} is installed and passed proot-distro login smoke; AI Builder metadata is not required.` };
      }

      let listing: LinuxExecResult | undefined;
      try { listing = await this.runHostCommand("proot-distro", ["list"], 15_000); } catch { /* preserve unknown */ }
      const listed = listing?.exitCode === 0
        ? parseInstalledProotDistroList(`${listing.stdout ?? ""}\n${listing.stderr ?? ""}`)
        : { known: false, aliases: [] as LinuxRuntimeProfile[] };
      if (listed.known && listed.aliases.includes(profile)) {
        if (directHealthy) return { available: true, backend: "rootfs", profile, prootDistroInstalled: true, rootfsInstalled: true, healthy: true, stateSource: "aib-rootfs", rootfsPath: directRootfs.path, message: `The proot-distro ${profile} alias is listed but its login failed; a separate AI Builder rootfs passed a real proot identity check.` };
        return { available: false, backend: "proot-distro", profile, prootDistroInstalled: true, rootfsInstalled: true, healthy: false, stateSource: "proot-distro-list", message: `${profile} is listed as installed but login validation failed. Its rootfs was left untouched; use explicit repair after reviewing the Termux error.` };
      }
      if (!listed.known) {
        if (directHealthy) return { available: true, backend: "rootfs", profile, prootDistroInstalled: true, rootfsInstalled: true, healthy: true, stateSource: "aib-rootfs", rootfsPath: directRootfs.path, message: "proot-distro state is unverified; a separate AI Builder rootfs passed a real proot identity check." };
        return { available: false, backend: "proot-distro", profile, prootDistroInstalled: true, rootfsInstalled: null, healthy: false, stateSource: "unknown", message: `${profile} could not be verified; proot-distro list/login returned an unrecognized state. No install or reset was attempted.` };
      }
      if (directHealthy) return { available: true, backend: "rootfs", profile, prootDistroInstalled: true, rootfsInstalled: true, healthy: true, stateSource: "aib-rootfs", rootfsPath: directRootfs.path, message: `proot-distro confirms ${profile} is absent; a separate AI Builder rootfs passed a real proot identity check.` };
      return { available: false, backend: "proot-distro", profile, prootDistroInstalled: true, rootfsInstalled: directUnknown ? null : false, healthy: false, stateSource: directUnknown ? "unknown" : "proot-distro-list", message: directUnknown ? `${profile} state remains unknown because an AI Builder rootfs path exists but could not be validated. No install or reset was attempted.` : `${profile} is confirmed absent and no validated direct rootfs exists. Use the guarded Termux bootstrap; manual roots are preserved.` };
    }
    if (directHealthy) return { available: true, backend: "rootfs", profile, prootDistroInstalled, rootfsInstalled: true, healthy: true, stateSource: "aib-rootfs", rootfsPath: directRootfs.path, message: "A separate AI Builder rootfs passed a real proot identity check; direct proot execution is available." };
    return { available: false, backend: "unavailable", profile, prootDistroInstalled, rootfsInstalled: null, healthy: false, stateSource: "unknown", message: directUnknown ? "An AI Builder rootfs directory exists but could not be validated; the selected distro remains unknown and no install/reset was attempted." : prootDistroInstalled === null ? "The Termux command result could not be trusted, so proot-distro availability and rootfs state remain unknown. No install/reset was attempted." : "The proot-distro command is unavailable, so absence of its aliases cannot be verified. No validated direct rootfs exists; state remains unknown." };
  }

  async bootstrap(profile: LinuxRuntimeProfile = "debian"): Promise<LinuxExecResult> {
    void profile;
    throw new Error("LINUX_BOOTSTRAP_UNSUPPORTED: no qualified embedded distro image/feed; existing rootfs preserved");
  }
  async exec(command: string, args: readonly string[] = [], options: { profile?: LinuxRuntimeProfile; cwd?: string; timeoutMs?: number } = {}): Promise<LinuxExecResult> {
    if (!isAllowed(command)) throw new Error(`Linux command not allowed: ${command}`);
    const safeArgs = normalizeArgs(args);
    const profile = options.profile ?? "debian";
    const status = await this.status(profile);
    if (!status.available) throw new Error(status.message);
    const inner = `${command} ${safeArgs.map(shellQuote).join(" ")}`.trim();
    const cwd = options.cwd ?? "/workspace";
    if (!isSafeCwd(cwd)) throw new Error("Linux cwd must stay inside /workspace or /tmp");
    await this.environment.mkdir(this.home.workspace);
    if (status.backend === "proot-distro") {
      return this.runHostCommand("proot-distro", ["login", profile, "--bind", `${this.home.workspace}:/workspace`, "--", "sh", "-lc", `cd ${shellQuote(cwd)} && exec ${inner}`], options.timeoutMs ?? 120_000);
    }
    const commandLine = ["proot", "-0", "-r", shellQuote(status.rootfsPath!), "-b", `${shellQuote(this.home.workspace)}:/workspace`, "-w", shellQuote(cwd), "--", "sh", "-lc", shellQuote(inner)].join(" ");
    return this.runHostCommandLine(commandLine, options.timeoutMs ?? 120_000);
  }

  private async runHostCommand(command: string, args: readonly string[], timeoutMs: number): Promise<LinuxExecResult> {
    return this.runHostCommandLine([command, ...args.map(shellQuote)].join(" "), timeoutMs);
  }
  private async runHostCommandLine(commandLine: string, timeoutMs: number): Promise<LinuxExecResult> {
    const started = Date.now();
    // AI_BUILDER_HOME is app-owned shared storage. Do not replace Termux's host HOME
    // for proot-distro management commands; its package/data paths belong to Termux.
    const result = await this.environment.exec(commandLine, { cwd: this.home.root, env: { AI_BUILDER_HOME: this.home.root }, timeoutMs });
    const r = result as { exitCode?: number; stdout?: string; stderr?: string };
    return { exitCode: Number.isFinite(Number(r?.exitCode)) ? Number(r?.exitCode) : -1, stdout: String(r?.stdout ?? ""), stderr: String(r?.stderr ?? ""), command: commandLine, durationMs: Date.now() - started };
  }
}
