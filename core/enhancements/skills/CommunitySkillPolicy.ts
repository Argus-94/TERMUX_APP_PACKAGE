import type { AgentCapability } from "../../agent/AgentTypes";
import type { PolicyVerdict } from "../../../lib/security-policy";

export type SkillSource = "builtin" | "project" | "community";
export type SkillPolicyDecision = Readonly<{
  allowed: boolean;
  reason?: "disabled" | "safe_mode" | "community_approval_required" | "command_policy_denied";
  /** A skill can never add permissions; this is always an intersection with the agent's policy. */
  effectiveCapabilities: readonly AgentCapability[];
  strippedCapabilities: readonly string[];
}>;

export type PluginCommandPolicy = (command: string) => PolicyVerdict;

/**
 * Resolve a skill's permission surface independently from its prompt content.
 * Requested skill capabilities are advisory metadata only and are never granted.
 */
export function evaluateSkillPolicy(input: Readonly<{
  source: SkillSource;
  enabled: boolean;
  safeMode: boolean;
  agentCapabilities: readonly AgentCapability[];
  requestedCapabilities?: readonly string[];
}>): SkillPolicyDecision {
  const effectiveCapabilities = [...new Set(input.agentCapabilities)];
  const denied = [...new Set(input.requestedCapabilities ?? [])].filter((capability) => !effectiveCapabilities.includes(capability as AgentCapability));
  if (!input.enabled) return { allowed: false, reason: "disabled", effectiveCapabilities, strippedCapabilities: denied };
  // Built-in and repository Markdown skills are inert context. Safe mode blocks community entries only.
  if (input.safeMode && input.source === "community") return { allowed: false, reason: "safe_mode", effectiveCapabilities, strippedCapabilities: denied };
  return { allowed: true, effectiveCapabilities, strippedCapabilities: denied };
}

/** Community plugin commands are not executable merely because their manifest is registered/enabled. */
export function authorizePluginCommand(input: Readonly<{
  source: SkillSource;
  enabled: boolean;
  safeMode: boolean;
  userApproved: boolean;
  command?: string;
  evaluateCommand: PluginCommandPolicy;
}>): Readonly<{ allowed: boolean; reason?: string }> {
  if (!input.enabled) return { allowed: false, reason: "PLUGIN_DISABLED" };
  if (input.safeMode && input.source !== "builtin") return { allowed: false, reason: "SAFE_MODE" };
  if (!input.command?.trim()) return { allowed: false, reason: "PLUGIN_COMMAND_MISSING" };
  if (input.source !== "builtin" && !input.userApproved) return { allowed: false, reason: "PLUGIN_COMMAND_REQUIRES_USER_APPROVAL" };
  const verdict = input.evaluateCommand(input.command);
  if (!verdict.ok) return { allowed: false, reason: "PLUGIN_COMMAND_POLICY_DENIED" };
  return { allowed: true };
}

/** Mark project skill material as untrusted prompt data; never interpret it as executable code. */
export function escapeUntrustedSkillText(value: string, maxChars = 12_000): string {
  return String(value).slice(0, Math.max(0, Math.min(maxChars, 24_000)))
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
