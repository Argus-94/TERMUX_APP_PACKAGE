/**
 * What may enter backup/profile export vs what must stay secret.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import { persistentLogger } from "./persistent-logger";

export type BackupScopeClass = "safe" | "sensitive" | "secret";

/** AsyncStorage / file keys classified for export UI. */
export const BACKUP_CLASSIFICATION: Record<string, BackupScopeClass> = {
  "aibuilder.log.persistent.v2": "sensitive",
  "aibuilder.settings.v1": "sensitive",
  "aibuilder.agentIntelligence.v2": "safe",
  "aibuilder.agent.presets.v1": "safe",
  "aibuilder.plugins.v1": "safe",
  "aibuilder.lanBridge.v1": "sensitive",
  "aibuilder.systemPrompt": "sensitive",
};

export type BackupSecretsSummary = {
  secrets: string[];
  sensitive: string[];
  safe: string[];
  note: string;
};

const BRIDGE_TOKEN_KEY = /^aib_[A-Za-z0-9_-]{8,}[0-9]{10,13}$/i;

export function describeBackupVsSecrets(lang: "ru" | "uk" | "en" = "ru"): BackupSecretsSummary {
  const secrets = [
    "SecureStore: OpenRouter / Custom / OpenCode API keys",
    "Private app files: credentials (never in public Download by default)",
  ];
  const sensitive = [
    "Settings snapshot (without raw keys when possible)",
    "Chat/log excerpts",
    "Agent intelligence & presets",
  ];
  const safe = [
    "Project trees under HOME/projects",
    "metadata / .aibuilder layout",
    "Allowlisted repair scripts state",
  ];
  const note =
    lang === "en"
      ? "Profile export packs projects + metadata. API keys stay in SecureStore and are not written into tar.gz."
      : lang === "uk"
        ? "Export профілю пакує проєкти + metadata. API-ключі лишаються в SecureStore і не потрапляють у tar.gz."
        : "Export профиля пакует проекты + metadata. API-ключи остаются в SecureStore и не попадают в tar.gz.";
  return { secrets, sensitive, safe, note };
}

export function classifyBackupStorageKey(key: string): BackupScopeClass {
  return BACKUP_CLASSIFICATION[key] || (BRIDGE_TOKEN_KEY.test(key) || key.includes("key") || key.includes("secret") ? "secret" : "sensitive");
}

export async function auditStorageForBackup(): Promise<{ key: string; class: BackupScopeClass }[]> {
  try {
    const keys = await AsyncStorage.getAllKeys();
    return keys.map((key) => ({ key, class: classifyBackupStorageKey(key) }));
  } catch (e) {
    persistentLogger.add("warn", "BackupPolicy", String(e));
    return [];
  }
}
