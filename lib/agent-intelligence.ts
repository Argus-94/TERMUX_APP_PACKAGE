/** Optional agent intelligence features. All features are local, dependency-free,
 * and fail open so they cannot affect the Android build pipeline. */
import AsyncStorage from "@react-native-async-storage/async-storage";
import { persistAsyncStorageItem } from "./persistence";

export interface AgentIntelligenceSettings {
  memory: boolean;
  hashline: boolean;
  subagents: boolean;
  reviewer: boolean;
  advisor: boolean;
  ast: boolean;
  lsp: boolean;
  github: boolean;
  strictTools: boolean;
  streamRules: boolean;
  autoPreflight: boolean;
  autoPostReview: boolean;
  advisorInterval: number;
}

/**
 * Defaults for a strong autonomous agent without burning free-model quotas:
 * OFF: subagents, advisor, preflight, post-review, reviewer (extra LLM rounds);
 *      hashline off so the agent can write new project files via TERMUX_RUN (create-app).
 * ON: memory, streamRules; AST/LSP/GitHub tools available on demand.
 */
export const DEFAULT_AGENT_INTELLIGENCE: AgentIntelligenceSettings = {
  memory: true,
  hashline: false,
  subagents: false,
  reviewer: false,
  advisor: false,
  ast: true,
  lsp: true,
  github: true,
  /** When true, agent retries harder if model replies without tools. */
  strictTools: true,
  streamRules: true,
  autoPreflight: false,
  autoPostReview: false,
  advisorInterval: 4,
};

/** v2 resets stored prefs so new defaults apply once (old v1 ignored). */
const KEY = "aibuilder.agentIntelligence.v2";

export async function loadAgentIntelligenceSettings(): Promise<AgentIntelligenceSettings> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (!raw) return DEFAULT_AGENT_INTELLIGENCE;
    const parsed = JSON.parse(raw) as Partial<AgentIntelligenceSettings>;
    const merged = { ...DEFAULT_AGENT_INTELLIGENCE, ...parsed };
    if (typeof merged.strictTools !== "boolean") merged.strictTools = true;
    merged.advisorInterval = Math.min(12, Math.max(1, Number(merged.advisorInterval) || 4));
    return merged;
  } catch { return DEFAULT_AGENT_INTELLIGENCE; }
}

export async function saveAgentIntelligenceSettings(value: AgentIntelligenceSettings): Promise<void> {
  persistAsyncStorageItem(KEY, JSON.stringify(value));
}

export function buildIntelligencePrompt(s: AgentIntelligenceSettings): string {
  const enabled = Object.entries(s)
    .filter(([, v]) => typeof v === "boolean" && v)
    .map(([k]) => k)
    .join(", ");
  const disabledTools: string[] = [];
  if (!s.github) disabledTools.push("github.*");
  if (!s.ast) disabledTools.push("ast.*");
  if (!s.lsp) disabledTools.push("lsp.*");
  if (!s.memory) disabledTools.push("memory.*");
  const toolHint =
    "Prefer AIB_TOOL: build.run, fs.read/create/delete/replace/replaceRange" +
    (s.hashline ? "/hashline" : "") +
    (s.ast ? ", ast.*" : "") +
    (s.lsp ? ", lsp.*" : "") +
    (s.github ? ", github.*" : "") +
    ", skills.*" +
    (s.memory ? ", memory.*" : "") +
    ". ";
  return (
    `[AGENT_INTELLIGENCE] Enabled: ${enabled || "none"}. ` +
    (disabledTools.length ? `DISABLED_TOOLS=${disabledTools.join(",")} (do not call them). ` : "") +
    "You are the sole executor: finish the user task end-to-end (tools → work → verify). " +
    "Never claim success without a real exit code and artifact from [TERMUX_RESULT] / tool results. " +
    toolHint +
    (s.hashline
      ? "Hashline ON: project source edits only via fs.hashline/AST; shared storage /storage|/sdcard still OK via shell; builds via build.run. "
      : "Hashline OFF: careful shell edits allowed under path whitelist. ") +
    "Install missing Termux packages for device arch yourself; on dead download URLs retry only the pinned allowlisted source or verified APK build tool-pack (pinned SHA-256), never an unverified mirror. " +
    "Smallest safe change; re-verify after every edit. No invented BUILD SUCCESSFUL / fake paths."
  );
}
