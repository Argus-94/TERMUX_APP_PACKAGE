/**
 * TermuxNativeBackend — execute directly in Termux environment (no proot).
 * Fastest practical path when tools live in $PREFIX; zero container overhead.
 */
import type {
  BackendExecRequest,
  BackendExecResult,
  BackendProbeResult,
  RuntimeBackend,
} from "../RuntimeBackend";
import { buildProxySafeEnvironment, ProotCommandError } from "../../container/ProotCommandBuilder";

export type TermuxExecFn = (command: string, opts?: { cwd?: string; timeoutMs?: number }) => Promise<{
  exitCode?: number;
  code?: number;
  stdout?: string;
  stderr?: string;
}>;

function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\"'\"'") + "'";
}

function envPrefix(env?: Readonly<Record<string, string>>): string {
  if (!env) return "";
  const entries = Object.entries(env);
  for (const [key, value] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || value.includes("\0")) {
      throw new ProotCommandError("BACKEND_ENV_INVALID");
    }
  }
  return entries.map(([key, value]) => `export ${key}=${shellQuote(value)};`).join(" ") + (entries.length ? " " : "");
}

export class TermuxNativeBackend implements RuntimeBackend {
  readonly id = "termux-native" as const;
  readonly priority = 10;
  readonly capabilities = ["shell", "pkg", "android-tools", "no-rootfs"] as const;

  constructor(private readonly execFn: TermuxExecFn) {}

  async probe(): Promise<BackendProbeResult> {
    const started = Date.now();
    try {
      const r = await this.execFn("echo AIB_TERMUX_OK && uname -m && command -v sh", { timeoutMs: 8000 });
      const code = r.exitCode ?? r.code ?? 1;
      const out = (r.stdout ?? "").trim();
      if (code === 0 && out.includes("AIB_TERMUX_OK")) {
        return {
          id: this.id,
          health: "ready",
          latencyMs: Date.now() - started,
          detail: out.split("\n").slice(0, 3).join(" | "),
          capabilities: this.capabilities,
          checkedAt: Date.now(),
        };
      }
      return {
        id: this.id,
        health: "unavailable",
        latencyMs: Date.now() - started,
        detail: r.stderr || `exit=${code}`,
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
    const safeEnv = buildProxySafeEnvironment(req.env ?? {}, req.credentialProxy);
    const command = envPrefix(safeEnv) + req.command;
    const r = await this.execFn(command, { cwd: req.cwd, timeoutMs: req.timeoutMs ?? 60_000 });
    return {
      exitCode: r.exitCode ?? r.code ?? 1,
      stdout: r.stdout ?? "",
      stderr: r.stderr ?? "",
      durationMs: Date.now() - started,
      backendId: this.id,
    };
  }
}
