import { PortForwardPolicy } from "./PortForwardPolicy";
import type { PortForwardProtocol, PortForwardRule, PortForwardSource, PortForwardStoreAdapter } from "./types";

const STORAGE_VERSION = 1;
const MAX_RULES = 32;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}$/;
export type NewPortForwardRule = Readonly<{ name: string; protocol: PortForwardProtocol; hostPort: number; targetHost: string; targetPort: number; source: PortForwardSource }>;

/** Persist only policy-valid, loopback-only rules; serializes concurrent writes. */
export class PortForwardStore {
  private rules: PortForwardRule[] = [];
  private loaded: Promise<void> | null = null;
  private queue: Promise<void> = Promise.resolve();
  constructor(private readonly storage: PortForwardStoreAdapter, private readonly policy: PortForwardPolicy, private readonly now: () => number = Date.now, private readonly makeId: () => string = () => `pf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`) {}

  private async ensureLoaded(): Promise<void> {
    if (!this.loaded) this.loaded = (async () => {
      try {
        const raw = await this.storage.read();
        if (!raw) return;
        const parsed: unknown = JSON.parse(raw);
        const entries: unknown[] = Array.isArray(parsed) ? parsed : parsed && typeof parsed === "object" && (parsed as { version?: unknown }).version === STORAGE_VERSION && Array.isArray((parsed as { rules?: unknown }).rules) ? (parsed as { rules: unknown[] }).rules : [];
        for (const item of entries.slice(-MAX_RULES)) {
          if (!item || typeof item !== "object") continue;
          const candidate = item as Partial<PortForwardRule>;
          if (typeof candidate.id !== "string" || typeof candidate.name !== "string" || (candidate.protocol !== "tcp" && candidate.protocol !== "udp") || typeof candidate.hostPort !== "number" || typeof candidate.targetPort !== "number" || typeof candidate.targetHost !== "string" || typeof candidate.createdAt !== "number" || (candidate.source !== "user" && candidate.source !== "agent" && candidate.source !== "restore")) continue;
          const check = await this.policy.check(candidate as Pick<PortForwardRule, "protocol" | "hostPort" | "targetHost" | "targetPort">, true, candidate.source);
          if (!check.allowed || this.rules.some((rule) => rule.hostPort === candidate.hostPort)) continue;
          this.rules.push(Object.freeze({ id: candidate.id.slice(0, 80), name: NAME_RE.test(candidate.name) ? candidate.name : "Forward", protocol: candidate.protocol, hostPort: candidate.hostPort, targetHost: candidate.targetHost, targetPort: candidate.targetPort, createdAt: candidate.createdAt, source: candidate.source }));
        }
      } catch { this.rules = []; }
    })();
    await this.loaded;
  }

  private async persist(): Promise<void> {
    const serialized = JSON.stringify({ version: STORAGE_VERSION, rules: this.rules.slice(-MAX_RULES) });
    const run = this.queue.catch(() => undefined).then(() => this.storage.write(serialized));
    this.queue = run.catch(() => undefined);
    await run;
  }

  /** List stored rules in creation order. */
  async list(): Promise<readonly PortForwardRule[]> { await this.ensureLoaded(); return [...this.rules]; }
  /** Add a rule only after capability and allowlist checks. */
  async add(input: NewPortForwardRule, capability = false): Promise<PortForwardRule> {
    await this.ensureLoaded();
    if (!NAME_RE.test(input.name)) throw new Error("PORT_FORWARD_NAME_INVALID");
    const checked = await this.policy.check(input, capability, input.source);
    if (!checked.allowed) throw new Error(checked.reason || "PORT_FORWARD_DENIED");
    if (this.rules.length >= MAX_RULES) throw new Error("PORT_FORWARD_RULE_LIMIT");
    if (this.rules.some((rule) => rule.hostPort === input.hostPort)) throw new Error("PORT_FORWARD_CONFLICT");
    const rule: PortForwardRule = Object.freeze({ ...input, id: this.makeId(), createdAt: this.now() });
    this.rules.push(rule);
    try { await this.persist(); } catch (error) { this.rules = this.rules.filter((item) => item.id !== rule.id); throw error; }
    return rule;
  }
  /** Remove by stable rule ID. */
  async remove(id: string): Promise<PortForwardRule | undefined> {
    await this.ensureLoaded();
    const index = this.rules.findIndex((rule) => rule.id === id);
    if (index < 0) return undefined;
    const [removed] = this.rules.splice(index, 1);
    try { await this.persist(); } catch (error) { this.rules.splice(index, 0, removed!); throw error; }
    return removed;
  }
  /** Remove every persisted rule. */
  async clear(): Promise<readonly PortForwardRule[]> {
    await this.ensureLoaded();
    const previous = [...this.rules]; this.rules = [];
    try { await this.persist(); } catch (error) { this.rules = previous; throw error; }
    return previous;
  }
  /** Find an existing rule by host-side port. */
  async getByPort(port: number): Promise<PortForwardRule | undefined> { await this.ensureLoaded(); return this.rules.find((rule) => rule.hostPort === port); }
  /** Find one existing rule by stable ID without modifying persistence. */
  async getById(id: string): Promise<PortForwardRule | undefined> { await this.ensureLoaded(); return this.rules.find((rule) => rule.id === id); }
}
