import type { PortForwardProtocol, PortForwardRule, PortForwardTimeline, PortForwardSource } from "./types";

export const DEFAULT_PORT_FORWARD_ALLOWLIST: readonly number[] = Object.freeze([3000, 4173, 5000, 5173, 8000, 8080, 8081, 9000, 9229]);
export type PortForwardPolicyResult = Readonly<{ allowed: boolean; reason?: string }>;

/** Fail-closed policy for local userspace forwarding; never binds a public/LAN interface. */
export class PortForwardPolicy {
  private readonly allowedPorts: ReadonlySet<number>;
  constructor(private readonly record?: PortForwardTimeline, allowedPorts: readonly number[] = DEFAULT_PORT_FORWARD_ALLOWLIST) {
    if (allowedPorts.some((port) => !Number.isInteger(port) || port < 1024 || port > 65535)) throw new Error("PORT_FORWARD_ALLOWLIST_INVALID");
    this.allowedPorts = new Set(allowedPorts);
  }

  /** Check a request before persistence or process launch; capability is explicit and never inferred. */
  async check(rule: Pick<PortForwardRule, "protocol" | "hostPort" | "targetHost" | "targetPort">, capability: boolean, source: PortForwardSource): Promise<PortForwardPolicyResult> {
    let reason: string | undefined;
    if (!capability) reason = "CAPABILITY_REQUIRED";
    else if (rule.protocol !== "tcp" && rule.protocol !== "udp") reason = "PROTOCOL_DENIED";
    else if (!Number.isInteger(rule.hostPort) || rule.hostPort < 1 || rule.hostPort > 65535 || !Number.isInteger(rule.targetPort) || rule.targetPort < 1 || rule.targetPort > 65535) reason = "PORT_INVALID";
    else if (rule.hostPort <= 1023 || rule.targetPort <= 1023) reason = "PRIVILEGED_PORT_DENIED";
    else if (rule.hostPort === rule.targetPort) reason = "PORT_FORWARD_PORTS_IDENTICAL";
    else if (!this.allowedPorts.has(rule.hostPort) || !this.allowedPorts.has(rule.targetPort)) reason = "PORT_NOT_ALLOWLISTED";
    else if (rule.targetHost !== "127.0.0.1" && rule.targetHost !== "localhost") reason = "TARGET_HOST_DENIED_LOOPBACK_ONLY";
    if (reason) {
      try { await this.record?.({ operation: "add", outcome: "denied", hostPort: Number.isInteger(rule.hostPort) ? rule.hostPort : undefined, reason, source }); } catch { /* audit errors do not weaken denial */ }
      return { allowed: false, reason };
    }
    return { allowed: true };
  }

  /** Resolve canonical phone-local URLs only; LAN/public URLs are intentionally unsupported. */
  localUrl(hostPort: number, protocol: PortForwardProtocol = "tcp"): string | null {
    if (!Number.isInteger(hostPort) || !this.allowedPorts.has(hostPort) || hostPort <= 1023) return null;
    if (protocol !== "tcp") return null;
    return `http://127.0.0.1:${hostPort}`;
  }

  /** Return a frozen copy for UI/agent validation. */
  listAllowedPorts(): readonly number[] { return [...this.allowedPorts].sort((a, b) => a - b); }
}
