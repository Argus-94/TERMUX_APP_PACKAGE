import type { InterceptorEngine } from "./InterceptorEngine";
import type { InterceptorStore } from "./InterceptorStore";
import type { InterceptorCapture } from "./InterceptorCapture";
import type { InterceptorReplay } from "./InterceptorReplay";
import type { InterceptorRule, InterceptorTimeline } from "./types";
import { createRuleId } from "./InterceptorPresets";

export type InterceptorAgentCommand = Readonly<{
  action: "command" | "enable" | "disable" | "last" | "detail" | "rule-add" | "rule-toggle" | "rule-delete" | "rules-disable" | "replay";
  text?: string; id?: string; limit?: number; enabled?: boolean; rule?: InterceptorRule;
}>;
/** Narrow capability-checked bridge; no shell, certificate or arbitrary filesystem operation is exposed to the model. */
export class InterceptorAgentBridge {
  constructor(private readonly engine: InterceptorEngine, private readonly store: InterceptorStore, private readonly capture: InterceptorCapture, private readonly replay?: InterceptorReplay, private readonly record?: InterceptorTimeline) {}

  async execute(command: InterceptorAgentCommand, hasCapability: boolean): Promise<unknown> {
    if (!hasCapability) { await this.audit(command.action, "denied", "CAPABILITY_REQUIRED"); throw new Error("CAPABILITY_REQUIRED"); }
    const authorized = await this.engine.policy.authorize(`agent-${command.action}`, "agent", hasCapability);
    if (!authorized.allowed) throw new Error(authorized.reason || "INTERCEPTOR_POLICY_DENIED");
    try {
      let result: unknown;
      switch (command.action) {
        case "command": if (!command.text) throw new Error("INTERCEPTOR_COMMAND_INVALID"); result = await this.executeNaturalLanguage(command.text, hasCapability); break;
        case "enable": result = await this.engine.handleAgentOperation("enable", hasCapability); break;
        case "disable": result = await this.engine.handleAgentOperation("disable", hasCapability); break;
        case "last": result = await this.engine.handleAgentOperation("last", hasCapability, { limit: command.limit ?? 10 }); break;
        case "detail": result = await this.engine.handleAgentOperation("detail", hasCapability, { id: command.id }); break;
        case "rule-add": {
          if (!command.rule || command.rule.actions.some((action) => action.type === "mapLocal" || action.type === "mapRemote" || action.type === "breakpoint")) throw new Error("AGENT_RULE_ACTION_NOT_ALLOWED");
          const rule: InterceptorRule = { ...command.rule, id: safeId(command.rule.id) ? command.rule.id : createRuleId(), source: "agent", updatedAt: Date.now() };
          await this.store.putRule(rule); result = { created: true, id: rule.id, name: rule.name }; break;
        }
        case "rule-toggle": {
          if (!command.id || typeof command.enabled !== "boolean") throw new Error("INTERCEPTOR_ARGUMENT_INVALID");
          const current = (await this.store.listRules()).find((rule) => rule.id === command.id);
          if (!current) throw new Error("INTERCEPTOR_RULE_NOT_FOUND");
          await this.store.putRule({ ...current, enabled: command.enabled, updatedAt: Date.now() }); result = { id: current.id, enabled: command.enabled }; break;
        }
        case "rules-disable": {
          for (const rule of await this.store.listRules()) if (rule.enabled) await this.store.putRule({ ...rule, enabled: false, updatedAt: Date.now() });
          result = { disabled: true }; break;
        }
        case "rule-delete": if (!command.id || !(await this.store.removeRule(command.id))) throw new Error("INTERCEPTOR_RULE_NOT_FOUND"); else result = { deleted: true }; break;
        case "replay": {
          if (!this.replay || !command.id) throw new Error("INTERCEPTOR_REPLAY_UNAVAILABLE");
          const item = this.capture.get(command.id); if (!item) throw new Error("INTERCEPTOR_RECORD_NOT_FOUND");
          result = await this.replay.replay(item, {}, { capability: hasCapability, source: "agent" }); break;
        }
      }
      await this.audit(command.action, "allowed"); return result;
    } catch (error) { await this.audit(command.action, "failed", error instanceof Error ? error.message : "AGENT_BRIDGE_FAILED"); throw error; }
  }

  /** Deterministic parser for the command examples shown in Interceptor help. */
  async executeNaturalLanguage(text: string, hasCapability: boolean): Promise<unknown> {
    const value = text.trim();
    if (/^(включи перехват(?:\s+трафика)?|enable traffic interception|start intercept(?:or|ion)?)$/i.test(value)) return this.execute({ action: "enable" }, hasCapability);
    if (/^(отключи перехват(?:\s+трафика)?|выключи перехват|disable traffic interception|stop intercept(?:or|ion)?)$/i.test(value)) return this.execute({ action: "disable" }, hasCapability);
    if (/^(статус перехват|interceptor status|status intercept)/i.test(value)) return this.execute({ action: "last", limit: 1 }, hasCapability);
    if (/заблокируй (?:все )?запросы к\s+(\S+)/i.test(value)) {
      const host = value.match(/заблокируй (?:все )?запросы к\s+(\S+)/i)?.[1]?.replace(/[.,;]+$/, "") || "";
      if (host) {
        const now = Date.now();
        const rule = { id: createRuleId(now), name: `Block ${host}`, enabled: true, priority: 100, conditions: [{ type: "urlContains" as const, value: host }], actions: [{ type: "block" as const }], createdAt: now, updatedAt: now, source: "agent" as const };
        return this.execute({ action: "rule-add", rule }, hasCapability);
      }
    }
    const countMatch = /(?:покажи последние|show last)(?:\s+(\d+))?/i.exec(value);
    if (countMatch && /запрос|requests?/i.test(value)) return this.execute({ action: "last", limit: countMatch[1] ? Number(countMatch[1]) : 10 }, hasCapability);
    const detailMatch = /(?:покажи|show)\s+(?:детали|details)\s+([A-Za-z0-9._-]{1,100})/i.exec(value);
    if (detailMatch) return this.execute({ action: "detail", id: detailMatch[1] }, hasCapability);
    const replayMatch = /(?:повтори|replay)\s+([A-Za-z0-9._-]{1,100})/i.exec(value);
    if (replayMatch) return this.execute({ action: "replay", id: replayMatch[1] }, hasCapability);
    if (/^(отключи все правила и выключи перехват|disable all rules and stop interception)$/i.test(value)) { const rules = await this.execute({ action: "rules-disable" }, hasCapability); const stopped = await this.execute({ action: "disable" }, hasCapability); return { rules, stopped }; }
    if (/^(заблокируй все запросы к google-analytics|block all requests to google-analytics)$/i.test(value)) {
      const now = Date.now(); const rule: InterceptorRule = { id: createRuleId(now), name: "Block Google Analytics", enabled: true, priority: 100, conditions: [{ type: "urlContains", value: "google-analytics" }], actions: [{ type: "block" }], createdAt: now, updatedAt: now, source: "agent" };
      return this.execute({ action: "rule-add", rule }, hasCapability);
    }
    if (/подмени ответ\s+\/api\/user.*premium.*true/i.test(value) || /mock.*\/api\/user.*premium.*true/i.test(value)) {
      const now = Date.now(); const rule: InterceptorRule = { id: createRuleId(now), name: "Set premium to true", enabled: true, priority: 100, conditions: [{ type: "urlContains", value: "/api/user" }], actions: [{ type: "modifyBody", find: "", replace: "true", jsonPath: "$.premium" }], createdAt: now, updatedAt: now, source: "agent" };
      return this.execute({ action: "rule-add", rule }, hasCapability);
    }
    throw new Error("INTERCEPTOR_AGENT_COMMAND_UNSUPPORTED");
  }

  private async audit(operation: string, outcome: "allowed" | "denied" | "failed", reason?: string): Promise<void> { try { await this.record?.({ operation: `agent-${operation}`, outcome, source: "agent", ...(reason ? { reason } : {}) }); } catch { /* best effort */ } }
}
function safeId(value: string): boolean { return /^[A-Za-z0-9._-]{1,80}$/.test(value); }
