import type { ExecutionEnvironment } from "../../environment/ExecutionEnvironment";
import type { PortForwardRule, PortForwardStartResult, PortForwardTransport } from "./types";

function shellQuote(value: string): string { return `'${value.replace(/'/g, `'"'"'`)}'`; }
function safeId(value: string): boolean { return /^[A-Za-z0-9._-]{1,80}$/.test(value); }

/** Uses only an already-installed socat executable through the existing guarded Termux environment. */
export class SocatPortForwardTransport implements PortForwardTransport {
  constructor(private readonly environment: ExecutionEnvironment, private readonly home: string) {
    if (!home.startsWith("/") || home.includes("\0") || home.includes("\n") || home.includes("\r")) throw new Error("PORT_FORWARD_HOME_INVALID");
  }

  async isAvailable(): Promise<boolean> {
    try {
      const result = await this.environment.exec("command -v socat", { cwd: this.home, timeoutMs: 2_000 });
      return result.exitCode === 0 && /(?:^|\/)socat\s*$/.test(result.stdout.trim());
    } catch { return false; }
  }

  async start(rule: PortForwardRule): Promise<PortForwardStartResult> {
    if (!safeId(rule.id) || !Number.isInteger(rule.hostPort) || !Number.isInteger(rule.targetPort) || rule.hostPort < 1024 || rule.targetPort < 1024 || rule.hostPort > 65535 || rule.targetPort > 65535) throw new Error("PORT_FORWARD_ARGUMENT_INVALID");
    if (rule.targetHost !== "127.0.0.1" && rule.targetHost !== "localhost") throw new Error("PORT_FORWARD_TARGET_DENIED");
    if (!(await this.isAvailable())) throw new Error("PORT_FORWARD_UNSUPPORTED_SOCAT_MISSING");
    const base = `${this.home.replace(/\/$/, "")}/.aib-port-forward-${rule.id}`;
    const pidFile = `${base}.pid`;
    const logFile = `${base}.log`;
    const source = rule.protocol === "tcp"
      ? `TCP4-LISTEN:${rule.hostPort},bind=127.0.0.1,reuseaddr,fork`
      : `UDP4-RECVFROM:${rule.hostPort},bind=127.0.0.1,reuseaddr,fork`;
    const target = rule.protocol === "tcp" ? `TCP4:127.0.0.1:${rule.targetPort}` : `UDP4-SENDTO:127.0.0.1:${rule.targetPort}`;
    const command = `set -eu; log=${shellQuote(logFile)}; pidfile=${shellQuote(pidFile)}; : > "$log"; nohup socat -d -d ${shellQuote(source)} ${shellQuote(target)} >"$log" 2>&1 </dev/null & pid=$!; printf '%s\\n%s\\n' "$pid" '${rule.hostPort}' > "$pidfile"; sleep 0.2; if kill -0 "$pid" 2>/dev/null; then printf 'PID=%s\\n' "$pid"; cat "$log"; else cat "$log"; rm -f -- "$pidfile" "$log"; exit 1; fi`;
    const result = await this.environment.exec(command, { cwd: this.home, timeoutMs: 3_000, preserveOutput: true });
    const pidMatch = /(?:^|\n)PID=([0-9]{1,12})(?:\n|$)/.exec(result.stdout);
    const endpointLogged = result.stdout.includes(`127.0.0.1:${rule.hostPort}`);
    if (result.exitCode !== 0 || !pidMatch || !endpointLogged) {
      await this.cleanupFiles(rule.id, rule.hostPort, rule.protocol).catch(() => undefined);
      throw new Error(result.stderr.trim().slice(0, 160) || "PORT_FORWARD_LISTENER_UNVERIFIED");
    }
    return { processId: pidMatch[1]!, verified: true };
  }

  async stop(ruleId: string): Promise<void> {
    if (!safeId(ruleId)) throw new Error("PORT_FORWARD_ID_INVALID");
    const pidFile = `${this.home.replace(/\/$/, "")}/.aib-port-forward-${ruleId}.pid`;
    const logFile = `${this.home.replace(/\/$/, "")}/.aib-port-forward-${ruleId}.log`;
    const command = `set -u; pidfile=${shellQuote(pidFile)}; if [ -r "$pidfile" ]; then { IFS= read -r pid; IFS= read -r port; } < "$pidfile" || true; case "$pid" in ''|*[!0-9]*) pid= ;; esac; case "$port" in ''|*[!0-9]*) pid= ;; esac; if [ -n "$pid" ] && [ -r "/proc/$pid/cmdline" ]; then cmd=$(tr '\\000' ' ' < "/proc/$pid/cmdline"); case "$cmd" in *"TCP4-LISTEN:$port,bind=127.0.0.1"*|*"UDP4-RECVFROM:$port,bind=127.0.0.1"*) kill "$pid" 2>/dev/null || true; sleep 0.1; if [ -r "/proc/$pid/cmdline" ]; then cmd=$(tr '\\000' ' ' < "/proc/$pid/cmdline"); case "$cmd" in *"TCP4-LISTEN:$port,bind=127.0.0.1"*|*"UDP4-RECVFROM:$port,bind=127.0.0.1"*) echo PORT_FORWARD_STOP_FAILED >&2; exit 1 ;; esac; fi ;; esac; fi; fi; rm -f -- "$pidfile" ${shellQuote(logFile)}`;
    const result = await this.environment.exec(command, { cwd: this.home, timeoutMs: 2_000 });
    if (result.exitCode !== 0) throw new Error("PORT_FORWARD_STOP_FAILED");
  }

  private async cleanupFiles(ruleId: string, hostPort: number, protocol: PortForwardRule["protocol"]): Promise<void> {
    if (!safeId(ruleId)) return;
    const base = `${this.home.replace(/\/$/, "")}/.aib-port-forward-${ruleId}`;
    const signature = protocol === "tcp" ? "TCP4-LISTEN" : "UDP4-RECVFROM";
    const command = `set -u; pidfile=${shellQuote(`${base}.pid`)}; if [ -r "$pidfile" ]; then IFS= read -r pid < "$pidfile" || true; case "$pid" in ''|*[!0-9]*) pid= ;; esac; if [ -n "$pid" ] && [ -r "/proc/$pid/cmdline" ]; then cmd=$(tr '\\000' ' ' < "/proc/$pid/cmdline"); case "$cmd" in *"${signature}:${hostPort},bind=127.0.0.1"*) kill "$pid" 2>/dev/null || true ;; esac; fi; fi; rm -f -- ${shellQuote(`${base}.pid`)} ${shellQuote(`${base}.log`)}`;
    await this.environment.exec(command, { cwd: this.home, timeoutMs: 2_000 });
  }
}
