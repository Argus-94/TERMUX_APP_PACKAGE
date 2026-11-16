/**
 * Opt-in LAN status bridge — snapshot only (no open HTTP server in JS without native).
 * When enabled, status is written for Termux `aib-lan-status` consumers / future native bind.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import { persistAsyncStorageItem } from "./persistence";
import { persistentLogger } from "./persistent-logger";
import { getSecurityPolicySummary } from "./security-policy";

const KEY = "aibuilder.lanBridge.v1";

export type LanBridgeConfig = {
  enabled: boolean;
  /** Token required by any future HTTP adapter */
  token: string;
  updatedAt: number;
};

export type LanStatusSnapshot = {
  app: "AI Builder";
  version?: string;
  at: number;
  policy: ReturnType<typeof getSecurityPolicySummary>;
  note: string;
};

export async function loadLanBridgeConfig(): Promise<LanBridgeConfig> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (raw) return JSON.parse(raw) as LanBridgeConfig;
  } catch { /* ignore */ }
  return { enabled: false, token: "", updatedAt: 0 };
}

export async function setLanBridgeEnabled(enabled: boolean, token?: string): Promise<LanBridgeConfig> {
  const prev = await loadLanBridgeConfig();
  const cfg: LanBridgeConfig = {
    enabled,
    token: token ?? prev.token ?? randomToken(),
    updatedAt: Date.now(),
  };
  if (!cfg.token) cfg.token = randomToken();
  await persistAsyncStorageItem(KEY, JSON.stringify(cfg));
  persistentLogger.add("info", "LanBridge", `enabled=${enabled}`);
  return cfg;
}

function randomToken(): string {
  return `aib_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

export function buildLanStatusSnapshot(version?: string): LanStatusSnapshot {
  return {
    app: "AI Builder",
    version,
    at: Date.now(),
    policy: getSecurityPolicySummary(),
    note: "LAN HTTP bind is opt-in via Termux helper; JS layer only publishes snapshot + token config.",
  };
}
