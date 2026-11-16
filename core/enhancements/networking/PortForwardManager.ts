import { PortForwardPolicy } from "./PortForwardPolicy";
import { PortForwardStore, type NewPortForwardRule } from "./PortForwardStore";
import type { PortForwardRule, PortForwardSource, PortForwardStatus, PortForwardTimeline, PortForwardTransport } from "./types";

export type PortForwardRequest = Omit<NewPortForwardRule, "source"> & Readonly<{ source?: PortForwardSource }>;

/** Policy-first forwarding lifecycle; an absent host transport is reported as unsupported, never simulated. */
export class PortForwardManager {
  private active = new Map<string, string>();
  private messages = new Map<string, string>();
  private queue: Promise<void> = Promise.resolve();

  constructor(readonly store: PortForwardStore, readonly policy: PortForwardPolicy, private readonly transport?: PortForwardTransport, private readonly record?: PortForwardTimeline) {}

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.queue.catch(() => undefined).then(operation);
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }
  private async audit(event: Parameters<PortForwardTimeline>[0]): Promise<void> { try { await this.record?.(event); } catch { /* audit failure does not change transport outcome */ } }
  private async start(rule: PortForwardRule, operation: "add" | "restore" = "add"): Promise<PortForwardStatus> {
    if (!this.transport) { this.messages.set(rule.id, "No verified forwarding host adapter is configured."); return { rule, state: "unsupported", message: this.messages.get(rule.id) }; }
    try {
      const result = await this.transport.start(rule);
      if (!result.verified || !/^[0-9]{1,12}$/.test(result.processId)) throw new Error("PORT_FORWARD_PROCESS_UNVERIFIED");
      this.active.set(rule.id, result.processId); this.messages.delete(rule.id);
      await this.audit({ operation, outcome: "allowed", ruleId: rule.id, hostPort: rule.hostPort, source: rule.source });
      return { rule, state: "listening" };
    } catch (error) {
      const reason = error instanceof Error ? error.message.slice(0, 180) : "PORT_FORWARD_START_FAILED";
      this.messages.set(rule.id, reason);
      await this.audit({ operation, outcome: "failed", ruleId: rule.id, hostPort: rule.hostPort, reason, source: rule.source });
      return { rule, state: "error", message: reason };
    }
  }

  /** Create a real forwarding process only after explicit capability and strict policy checks. */
  add(request: PortForwardRequest, capability = false): Promise<PortForwardStatus> {
    return this.serial(async () => {
      const source = request.source ?? "user";
      const checked = await this.policy.check(request, capability, source);
      if (!checked.allowed) { await this.audit({ operation: "add", outcome: "denied", hostPort: Number.isInteger(request.hostPort) ? request.hostPort : undefined, reason: checked.reason, source }); throw new Error(checked.reason || "PORT_FORWARD_DENIED"); }
      const collision = await this.store.getByPort(request.hostPort);
      if (collision) { await this.audit({ operation: "add", outcome: "denied", hostPort: request.hostPort, reason: "PORT_FORWARD_CONFLICT", source }); throw new Error("PORT_FORWARD_CONFLICT"); }
      if (!this.transport) { await this.audit({ operation: "add", outcome: "failed", hostPort: request.hostPort, reason: "PORT_FORWARD_UNSUPPORTED", source }); throw new Error("PORT_FORWARD_UNSUPPORTED"); }
      const rule = await this.store.add({ ...request, source }, true);
      const result = await this.start(rule);
      if (result.state !== "listening") {
        await this.store.remove(rule.id);
        throw new Error(result.message || "PORT_FORWARD_START_FAILED");
      }
      return result;
    });
  }

  /** Stop one active listener and remove its persisted rule. */
  remove(id: string, capability = false, source: PortForwardSource = "user"): Promise<boolean> {
    return this.serial(async () => {
      const rule = await this.store.getById(id);
      if (!rule) return false;
      const checked = await this.policy.check(rule, capability, source);
      if (!checked.allowed) { await this.audit({ operation: "remove", outcome: "denied", ruleId: id, hostPort: rule.hostPort, reason: checked.reason, source }); throw new Error(checked.reason || "PORT_FORWARD_DENIED"); }
      try { if (this.active.has(id)) await this.transport?.stop(id); }
      catch (error) { this.messages.set(id, error instanceof Error ? error.message.slice(0, 180) : "PORT_FORWARD_STOP_FAILED"); await this.audit({ operation: "remove", outcome: "failed", ruleId: id, hostPort: rule.hostPort, reason: "stop-failed", source }); throw new Error("PORT_FORWARD_STOP_FAILED"); }
      this.active.delete(id);
      const removed = await this.store.remove(id);
      if (!removed) throw new Error("PORT_FORWARD_RULE_DISAPPEARED");
      this.messages.delete(id);
      await this.audit({ operation: "remove", outcome: "allowed", ruleId: id, hostPort: rule.hostPort, source });
      return true;
    });
  }

  /** Stop all active listeners and clear saved rules. */
  clear(capability = false, source: PortForwardSource = "user"): Promise<void> {
    return this.serial(async () => {
      const rules = await this.store.list();
      if (!capability && rules.length > 0) {
        await this.audit({ operation: "clear", outcome: "denied", reason: "CAPABILITY_REQUIRED", source });
        throw new Error("CAPABILITY_REQUIRED");
      }
      const failures: string[] = [];
      for (const rule of rules) {
        const checked = await this.policy.check(rule, capability, source);
        if (!checked.allowed) { failures.push(rule.id); await this.audit({ operation: "clear", outcome: "denied", ruleId: rule.id, hostPort: rule.hostPort, reason: checked.reason, source }); continue; }
        try { if (this.active.has(rule.id)) await this.transport?.stop(rule.id); this.active.delete(rule.id); this.messages.delete(rule.id); }
        catch (error) { failures.push(rule.id); await this.audit({ operation: "stop", outcome: "failed", ruleId: rule.id, hostPort: rule.hostPort, reason: error instanceof Error ? error.message.slice(0, 180) : "PORT_FORWARD_STOP_FAILED", source: "lifecycle" }); }
      }
      if (failures.length) throw new Error(`PORT_FORWARD_CLEANUP_FAILED:${failures.length}`);
      await this.store.clear();
      for (const rule of rules) await this.audit({ operation: "clear", outcome: "allowed", ruleId: rule.id, hostPort: rule.hostPort, source });
    });
  }

  /** Stop active listeners at sleep/background boundaries while retaining rules for explicit restore. */
  stopActive(reason = "runtime-paused"): Promise<void> {
    return this.serial(async () => {
      for (const rule of await this.store.list()) {
        if (!this.active.has(rule.id)) continue;
        try {
          await this.transport?.stop(rule.id); this.active.delete(rule.id); this.messages.set(rule.id, reason);
          await this.audit({ operation: "stop", outcome: "allowed", ruleId: rule.id, hostPort: rule.hostPort, reason, source: "lifecycle" });
        } catch (error) {
          const detail = error instanceof Error ? error.message.slice(0, 180) : "PORT_FORWARD_STOP_FAILED";
          this.messages.set(rule.id, "PORT_FORWARD_STOP_FAILED");
          await this.audit({ operation: "stop", outcome: "failed", ruleId: rule.id, hostPort: rule.hostPort, reason: detail, source: "lifecycle" });
        }
      }
    });
  }

  /** Restart persisted rules at runtime start, returning per-rule real status. */
  applyAll(): Promise<readonly PortForwardStatus[]> {
    return this.serial(async () => {
      const rules = await this.store.list();
      if (!this.transport) {
        const results: PortForwardStatus[] = [];
        for (const rule of rules) {
          const message = "No verified forwarding host adapter is configured.";
          this.messages.set(rule.id, message);
          await this.audit({ operation: "restore", outcome: "failed", ruleId: rule.id, hostPort: rule.hostPort, reason: "PORT_FORWARD_UNSUPPORTED", source: "restore" });
          results.push({ rule, state: "unsupported", message });
        }
        return results;
      }
      const available = await this.transport.isAvailable().catch(() => false);
      if (!available) {
        const results: PortForwardStatus[] = [];
        for (const rule of rules) {
          const message = "socat is not available in the existing userspace environment.";
          this.messages.set(rule.id, message);
          await this.audit({ operation: "restore", outcome: "failed", ruleId: rule.id, hostPort: rule.hostPort, reason: "PORT_FORWARD_UNSUPPORTED_SOCAT_MISSING", source: "restore" });
          results.push({ rule, state: "unsupported", message });
        }
        return results;
      }
      const results: PortForwardStatus[] = [];
      for (const rule of rules) {
        if (this.active.has(rule.id)) results.push({ rule, state: "listening" });
        else results.push(await this.start({ ...rule, source: "restore" }, "restore"));
      }
      return results;
    });
  }

  /** Current status derives from confirmed process handles, not stored intent alone. */
  async list(): Promise<readonly PortForwardStatus[]> {
    const rules = await this.store.list();
    return rules.map((rule) => {
      const message = this.messages.get(rule.id);
      const state = this.active.has(rule.id) ? "listening" : message?.includes("UNSUPPORTED") ? "unsupported" : message?.includes("FAILED") ? "error" : "stopped";
      return { rule, state, ...(message ? { message } : {}) };
    });
  }

  /** Return a loopback URL only for a supported allowlisted TCP port. */
  localUrl(port: number): string | null { return this.policy.localUrl(port, "tcp"); }
  /** Number of listeners confirmed active by the host adapter. */
  get activeCount(): number { return this.active.size; }
}
