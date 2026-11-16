/**
 * ProotDistroBackend — Termux proot-distro (Debian/Ubuntu userspace).
 * Open-source, GPL proot under the hood — no proprietary proroot.
 */
import type {
  BackendExecRequest,
  BackendExecResult,
  BackendProbeResult,
  RuntimeBackend,
} from "../RuntimeBackend";
import { wrapHardenedShellBody } from "../../enhancements/isolation/HardenedProotOptions";
import { buildProxySafeEnvironment, ProotCommandError } from "../../container/ProotCommandBuilder";
import { buildProotDistroProbeCommand, parseProotDistroProbe } from "../../../lib/proot-distro-state";

export type ProotProfile = "debian" | "ubuntu";

export class ProotDistroBackend implements RuntimeBackend {
  readonly id = "proot-distro" as const;
  readonly priority = 20;
  readonly capabilities = ["shell", "rootfs", "apt", "glibc", "isolated-workspace"] as const;

  constructor(
    private readonly execFn: (command: string, opts?: { cwd?: string; timeoutMs?: number }) => Promise<{
      exitCode?: number;
      code?: number;
      stdout?: string;
      stderr?: string;
    }>,
    private profile: ProotProfile = "debian",
  ) {}

  setProfile(profile: ProotProfile): void {
    this.profile = profile;
  }

  async probe(): Promise<BackendProbeResult> {
    const started = Date.now();
    const profile = this.profile;
    try {
      const inspected = await this.inspectProfile(profile, 20_000);
      const { state } = inspected;
      if (state.healthy) {
        return {
          id: this.id,
          health: "ready",
          latencyMs: Date.now() - started,
          detail: `${profile} ready | id=${state.osReleaseId} uname=${state.uname}`,
          capabilities: this.capabilities,
          checkedAt: Date.now(),
        };
      }
      const explicitMissingTool = inspected.output.includes("AIB_PROOT_TOOL:MISSING");
      return {
        id: this.id,
        health: explicitMissingTool ? "unavailable" : "degraded",
        latencyMs: Date.now() - started,
        detail: state.installed === true
          ? `${profile} is listed as installed but login/identity validation failed; rootfs preserved.`
          : state.installed === false
            ? `${profile} is confirmed absent; guarded install is available.`
            : `${profile} state is unverified; no install/reset is allowed.`,
        capabilities: this.capabilities,
        checkedAt: Date.now(),
      };
    } catch (e) {
      return {
        id: this.id,
        health: "unavailable",
        latencyMs: Date.now() - started,
        detail: e instanceof Error ? e.message : String(e),
        capabilities: this.capabilities,
        checkedAt: Date.now(),
      };
    }
  }

  async exec(req: BackendExecRequest): Promise<BackendExecResult> {
    const started = Date.now();
    const cwd = req.cwd && req.cwd.startsWith("/") ? req.cwd : undefined;
    const env = Object.entries(buildProxySafeEnvironment(req.env ?? {}, req.credentialProxy));
    for (const [key, value] of env) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || value.includes("\0")) {
        throw new ProotCommandError("BACKEND_ENV_INVALID");
      }
    }
    const exports = env.map(([key, value]) => `export ${key}=${shellQuote(value)};`).join(" ");
    const command = `${exports}${exports ? " " : ""}${req.command}`;
    const inner = cwd
      ? `cd '${cwd.replace(/'/g, `\"'\"'`)}' && ${command}`
      : command;
    const hardened = wrapHardenedShellBody(inner, req.hardening);
    const wrapped = `proot-distro login ${this.profile} -- ${hardened}`;
    const r = await this.execFn(wrapped, { timeoutMs: req.timeoutMs ?? 120_000 });
    return {
      exitCode: r.exitCode ?? r.code ?? 1,
      stdout: r.stdout ?? "",
      stderr: r.stderr ?? "",
      durationMs: Date.now() - started,
      backendId: this.id,
    };
  }

  async warmup(): Promise<void> {
    const current = await this.inspectProfile(this.profile, 20_000);
    if (current.state.healthy) return;
    throw new Error(`PROOT_PROFILE_INSTALL_UNSUPPORTED:${this.profile}; no qualified embedded distro image/feed; existing rootfs preserved`);
  }
  private async inspectProfile(profile: ProotProfile, timeoutMs: number) {
    try {
      const raw = await this.execFn(buildProotDistroProbeCommand(profile), { timeoutMs });
      const output = `${raw.stdout ?? ""}\n${raw.stderr ?? ""}`;
      const exitCode = Number(raw.exitCode ?? raw.code ?? -1);
      return { output, state: parseProotDistroProbe(profile, output, exitCode) };
    } catch (error) {
      const output = error instanceof Error ? error.message : String(error);
      return { output, state: parseProotDistroProbe(profile, output, -1) };
    }
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}
