/**
 * Mini-plugins / skills for AI Builder — manifest + allowlisted hooks.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import { persistAsyncStorageItem } from "./persistence";
import { evaluateCommandPolicy } from "./security-policy";
import { persistentLogger } from "./persistent-logger";

export type PluginHook = "repair_recipe" | "agent_skill" | "ui_action";

export type AibPluginManifest = {
  id: string;
  name: string;
  version: string;
  description?: string;
  hooks: PluginHook[];
  /** Optional shell snippet — must pass policy */
  command?: string;
  enabled: boolean;
  builtin?: boolean;
};

const KEY = "aibuilder.plugins.v1";
const SAFE_KEY = "aibuilder.plugins.safeMode.v1";

const BUILTIN: AibPluginManifest[] = [
  {
    id: "skill-home-layout",
    name: "Ensure HOME layout",
    version: "1.0.0",
    description: "mkdir .aibuilder / projects",
    hooks: ["repair_recipe"],
    command: 'mkdir -p "$HOME/.aibuilder" "$HOME/projects" && echo REPAIR_OK:home',
    enabled: true,
    builtin: true,
  },
  {
    id: "skill-java-version",
    name: "Probe Java",
    version: "1.0.0",
    hooks: ["agent_skill"],
    command: "command -v java && java -version 2>&1 | head -1",
    enabled: true,
    builtin: true,
  },
];

export type PluginState = {
  safeMode: boolean;
  plugins: AibPluginManifest[];
};

export async function loadPluginState(): Promise<PluginState> {
  let safeMode = true;
  try {
    const s = await AsyncStorage.getItem(SAFE_KEY);
    if (s === "0") safeMode = false;
    if (s === "1") safeMode = true;
  } catch { /* default safe */ }
  let extra: AibPluginManifest[] = [];
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (raw) extra = JSON.parse(raw) as AibPluginManifest[];
  } catch { /* ignore */ }
  const byId = new Map<string, AibPluginManifest>();
  for (const p of BUILTIN) byId.set(p.id, p);
  for (const p of extra) if (!p.builtin) byId.set(p.id, p);
  return { safeMode, plugins: [...byId.values()] };
}

export async function setPluginSafeMode(on: boolean): Promise<void> {
  await persistAsyncStorageItem(SAFE_KEY, on ? "1" : "0");
  persistentLogger.add("info", "Plugins", `safeMode=${on}`);
}

export async function registerPlugin(manifest: AibPluginManifest): Promise<{ ok: boolean; message: string }> {
  if (!manifest.id || !manifest.name) return { ok: false, message: "invalid manifest" };
  if (manifest.command) {
    const v = evaluateCommandPolicy(manifest.command, "plugin");
    if (!v.ok) return { ok: false, message: v.reason || "policy deny" };
  }
  const st = await loadPluginState();
  const plugins = st.plugins.filter((p) => p.id !== manifest.id || p.builtin);
  if (!manifest.builtin) plugins.push({ ...manifest, enabled: manifest.enabled !== false });
  await persistAsyncStorageItem(
    KEY,
    JSON.stringify(plugins.filter((p) => !p.builtin)),
  );
  persistentLogger.add("info", "Plugins", `registered ${manifest.id}`);
  return { ok: true, message: "ok" };
}

export async function setPluginEnabled(id: string, enabled: boolean): Promise<void> {
  const st = await loadPluginState();
  const next = st.plugins.map((p) => (p.id === id ? { ...p, enabled } : p));
  await persistAsyncStorageItem(KEY, JSON.stringify(next.filter((p) => !p.builtin)));
  persistentLogger.add("info", "Plugins", `${id} enabled=${enabled}`);
}

/** List hooks available to agent when safe mode is off or plugin enabled. */
export async function listActivePluginSkills(): Promise<AibPluginManifest[]> {
  const st = await loadPluginState();
  if (st.safeMode) return st.plugins.filter((p) => p.builtin && p.enabled);
  return st.plugins.filter((p) => p.enabled);
}
