/**
 * Named agent presets on top of AgentIntelligenceSettings.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import { persistAsyncStorageItem } from "./persistence";
import {
  DEFAULT_AGENT_INTELLIGENCE,
  type AgentIntelligenceSettings,
  saveAgentIntelligenceSettings,
} from "./agent-intelligence";
import { persistentLogger } from "./persistent-logger";

export type AgentPresetId = "coder" | "careful" | "apk_build" | "readonly" | "balanced";

export type AgentPreset = {
  id: AgentPresetId;
  title: { ru: string; uk: string; en: string };
  description: { ru: string; uk: string; en: string };
  intelligence: AgentIntelligenceSettings;
};

export const AGENT_PRESETS: AgentPreset[] = [
  {
    id: "balanced",
    title: { ru: "Сбалансированный", uk: "Збалансований", en: "Balanced" },
    description: {
      ru: "Стандарт: hashline, AST/LSP, без агрессивных авто-циклов",
      uk: "Стандарт: hashline, AST/LSP, без агресивних авто-циклів",
      en: "Default: hashline, AST/LSP, no aggressive auto loops",
    },
    intelligence: { ...DEFAULT_AGENT_INTELLIGENCE },
  },
  {
    id: "coder",
    title: { ru: "Кодер", uk: "Кодер", en: "Coder" },
    description: {
      ru: "Максимум инструментов кода, subagents, reviewer",
      uk: "Максимум інструментів коду, subagents, reviewer",
      en: "Full code tools, subagents, reviewer",
    },
    intelligence: {
      ...DEFAULT_AGENT_INTELLIGENCE,
      subagents: true,
      reviewer: true,
      ast: true,
      lsp: true,
      hashline: true,
      streamRules: true,
    },
  },
  {
    id: "careful",
    title: { ru: "Осторожный", uk: "Обережний", en: "Careful" },
    description: {
      ru: "Минимум побочных эффектов, без subagents и auto-preflight",
      uk: "Мінімум побічних ефектів, без subagents і auto-preflight",
      en: "Minimal side effects, no subagents or auto-preflight",
    },
    intelligence: {
      ...DEFAULT_AGENT_INTELLIGENCE,
      subagents: false,
      reviewer: true,
      advisor: false,
      autoPreflight: false,
      autoPostReview: false,
      github: false,
    },
  },
  {
    id: "apk_build",
    title: { ru: "Сборка APK", uk: "Збірка APK", en: "APK build" },
    description: {
      ru: "Упор на build/verify, post-review после правок",
      uk: "Упор на build/verify, post-review після правок",
      en: "Focus on build/verify, post-review after edits",
    },
    intelligence: {
      ...DEFAULT_AGENT_INTELLIGENCE,
      autoPreflight: true,
      autoPostReview: true,
      reviewer: true,
      github: false,
    },
  },
  {
    id: "readonly",
    title: { ru: "Только чтение", uk: "Лише читання", en: "Read-only" },
    description: {
      ru: "Анализ без опасных авто-действий",
      uk: "Аналіз без небезпечних авто-дій",
      en: "Analysis without risky automation",
    },
    intelligence: {
      ...DEFAULT_AGENT_INTELLIGENCE,
      hashline: true,
      subagents: false,
      autoPreflight: false,
      autoPostReview: false,
      github: false,
      streamRules: true,
    },
  },
];

const KEY = "aibuilder.agent.presets.v1";

export async function getActiveAgentPresetId(): Promise<AgentPresetId> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (!raw) return "balanced";
    const p = JSON.parse(raw) as { active?: AgentPresetId };
    return p.active && AGENT_PRESETS.some((x) => x.id === p.active) ? p.active! : "balanced";
  } catch {
    return "balanced";
  }
}

export async function applyAgentPreset(id: AgentPresetId): Promise<AgentPreset> {
  const preset = AGENT_PRESETS.find((p) => p.id === id) || AGENT_PRESETS[0];
  await saveAgentIntelligenceSettings(preset.intelligence);
  await persistAsyncStorageItem(KEY, JSON.stringify({ active: preset.id, at: Date.now() }));
  persistentLogger.add("info", "AgentPreset", `applied ${preset.id}`);
  return preset;
}

/** Reset to balanced defaults. */
export async function resetAgentPreset(): Promise<AgentPreset> {
  return applyAgentPreset("balanced");
}

