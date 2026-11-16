import { applyAction } from "./InterceptorModifiers";
import type { InterceptorRule, RequestRecord, ResponseRecord, RuleCondition, RuleAction, InterceptorTimeline } from "./types";

export type RuleEvaluation = Readonly<{ response: ResponseRecord; matchedRuleIds: readonly string[]; modified: boolean; blocked: boolean; delayMs: number; breakpoint: boolean; errors: readonly string[] }>;
export type RuleIo = Parameters<typeof applyAction>[2];
export type RulePhase = "all" | "request" | "response";

/** Deterministic AND-condition rules; higher priority runs first, then creation time and id. */
export class InterceptorRules {
  constructor(private readonly record?: InterceptorTimeline) {}

  async evaluate(request: RequestRecord, initialResponse: ResponseRecord, rules: readonly InterceptorRule[], io?: RuleIo, phase: RulePhase = "all"): Promise<RuleEvaluation> {
    let response = initialResponse; let modified = false; let blocked = false; let delayMs = 0; let breakpoint = false;
    const matchedRuleIds: string[] = []; const errors: string[] = [];
    const sorted = rules.filter((rule) => rule.enabled).slice().sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    for (const rule of sorted) {
      if (phase === "request" && rule.conditions.some((condition) => condition.type === "statusCodeIs")) continue;
      if (!rule.conditions.every((condition) => this.matches(condition, request, response))) continue;
      const actions = rule.actions.filter((action) => actionAllowedInPhase(action, phase));
      if (actions.length === 0) continue;
      matchedRuleIds.push(rule.id);
      await this.audit(rule, "allowed");
      for (const action of actions) {
        const result = await applyAction(response, action, io);
        response = result.response; modified ||= result.modified; blocked ||= result.blocked; delayMs = Math.min(30_000, delayMs + result.delayMs); breakpoint ||= result.breakpoint;
        if (result.error) { errors.push(`${rule.id}:${result.error}`); await this.audit(rule, "failed", result.error); }
        // A block short-circuits lower-priority actions. Mock response still allows response-phase edits.
        if (result.blocked) break;
      }
      if (blocked) break;
    }
    return { response, matchedRuleIds, modified, blocked, delayMs, breakpoint, errors };
  }

  private matches(condition: RuleCondition, request: RequestRecord, response: ResponseRecord): boolean {
    switch (condition.type) {
      case "urlContains": return request.url.includes(condition.value);
      case "urlMatches": try { if (condition.value.length > 200 || /\([^)]*[+*][^)]*\)[+*{]|\\[1-9]/.test(condition.value)) return false; return new RegExp(condition.value).test(request.url); } catch { return false; }
      case "urlEquals": return request.url === condition.value;
      case "methodIs": return request.method.toUpperCase() === condition.value.toUpperCase();
      case "headerExists": return Object.keys(request.requestHeaders).some((key) => key.toLowerCase() === condition.name.toLowerCase());
      case "headerEquals": { const key = Object.keys(request.requestHeaders).find((name) => name.toLowerCase() === condition.name.toLowerCase()); return key !== undefined && request.requestHeaders[key] === condition.value; }
      case "statusCodeIs": return response.status === condition.value;
      case "bodyContains": return String(request.requestBody ?? "").includes(condition.value) || String(response.body ?? "").includes(condition.value);
    }
  }
  private async audit(rule: InterceptorRule, outcome: "allowed" | "failed", reason?: string): Promise<void> {
    try { await this.record?.({ operation: "rule-match", outcome, source: rule.source === "agent" ? "agent" : "user", ...(reason ? { reason } : {}), details: { ruleId: rule.id, name: rule.name.slice(0, 80), priority: rule.priority } }); } catch { /* telemetry cannot break request processing */ }
  }
}

function actionAllowedInPhase(action: RuleAction, phase: RulePhase): boolean {
  if (phase === "all") return true;
  if (phase === "request") return ["mockResponse", "block", "delay", "breakpoint", "mapLocal", "mapRemote"].includes(action.type);
  return ["modifyBody", "modifyHeaders", "setStatusCode"].includes(action.type);
}
