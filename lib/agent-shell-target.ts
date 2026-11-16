import AsyncStorage from "@react-native-async-storage/async-storage";

export const AGENT_SHELL_EXECUTION_TARGET_STORAGE_KEY = "aibuilder.agentShellExecutionTarget.v1";

export type AgentShellExecutionTarget = "selected-backend" | "embedded-private";

let currentTarget: AgentShellExecutionTarget | null = null;
let loadPending: Promise<AgentShellExecutionTarget> | null = null;

export function parseAgentShellExecutionTarget(value: unknown): AgentShellExecutionTarget {
  // Legacy persisted choices must not silently re-enable external Termux.
  return "embedded-private";
}

/** Load the persisted route once before an agent task can dispatch shell work. */
export async function loadAgentShellExecutionTarget(): Promise<AgentShellExecutionTarget> {
  if (currentTarget !== null) return currentTarget;
  if (!loadPending) {
    loadPending = AsyncStorage.getItem(AGENT_SHELL_EXECUTION_TARGET_STORAGE_KEY)
      .then((stored) => {
        currentTarget = parseAgentShellExecutionTarget(stored);
        return currentTarget;
      })
      .catch(() => {
        loadPending = null;
        throw new Error("AGENT_SHELL_TARGET_LOAD_FAILED");
      });
  }
  return loadPending;
}

export function getAgentShellExecutionTarget(): AgentShellExecutionTarget {
  return currentTarget ?? "embedded-private";
}

export async function setAgentShellExecutionTarget(
  target: AgentShellExecutionTarget,
): Promise<void> {
  const next = parseAgentShellExecutionTarget(target);
  if (target !== "embedded-private") throw new Error("AGENT_SHELL_EXTERNAL_TARGET_DISABLED");
  currentTarget = next;
  try {
    await AsyncStorage.setItem(AGENT_SHELL_EXECUTION_TARGET_STORAGE_KEY, next);
  } catch {
    throw new Error("AGENT_SHELL_TARGET_SAVE_FAILED");
  }
}
