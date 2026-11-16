import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  BUILD_BACKEND_STORAGE_KEY,
  LEGACY_AGENT_SHELL_BACKEND_STORAGE_KEY,
  getBuildBackend,
  parseAgentShellBackend,
  setBuildBackend,
  type AgentShellBackend,
} from "./agent-shell-backend";
import { loadNativePriorityMode } from "./native-priority";

export async function loadEnvironmentBackend(): Promise<AgentShellBackend> {
  // Keep Native Priority in sync whenever the environment is loaded (startup / settings).
  try {
    await loadNativePriorityMode();
  } catch {
    // non-fatal
  }
  const raw = await AsyncStorage.getItem(BUILD_BACKEND_STORAGE_KEY);
  if (raw != null) {
    const backend = parseAgentShellBackend(raw);
    setBuildBackend(backend);
    return backend;
  }
  const legacy = await AsyncStorage.getItem(LEGACY_AGENT_SHELL_BACKEND_STORAGE_KEY);
  const backend = parseAgentShellBackend(legacy);
  setBuildBackend(backend);
  if (legacy != null) await AsyncStorage.setItem(BUILD_BACKEND_STORAGE_KEY, backend);
  return backend;
}

export async function saveEnvironmentBackend(backend: AgentShellBackend): Promise<AgentShellBackend> {
  setBuildBackend(backend);
  await AsyncStorage.setItem(BUILD_BACKEND_STORAGE_KEY, backend);
  return backend;
}

export function getEnvironmentBackend(): AgentShellBackend {
  return getBuildBackend();
}
