/**
 * Runtime-only agent models and policy.
 */

export type AgentCapability =
  | "filesystem"
  | "filesystem.write"
  | "network"
  | "network.portforward"
  | "network.intercept"
  | "adb"
  | "device.accessibility"
  | "device.adb"
  | "device.virtualdisplay"
  | "android.toolchain"
  | "bridge"
  | "privilege"
  | "terminal"
  | "terminal.theme"
  | "container"
  | "checkpoint.revert"
  | "manifest.write";

export type AgentPolicy = {
  readonly allowedCapabilities: readonly AgentCapability[];
  readonly projectIsolation: boolean;
  readonly homeIsolation: boolean;
  readonly maxConcurrentTools?: number;
};

export const DEFAULT_AGENT_POLICY: AgentPolicy = {
  allowedCapabilities: ["filesystem"],
  projectIsolation: true,
  homeIsolation: true,
  maxConcurrentTools: 4,
};

export type AgentSession = {
  readonly id: string;
  readonly sessionId?: string;
  readonly projectId?: string;
  /** Optional runtime-validated active workspace root, still constrained beneath AI_BUILDER_HOME. */
  readonly projectRoot?: string;
  readonly policy: AgentPolicy;
  readonly createdAt: number;
  status: "idle" | "running" | "stopped" | "error";
};

export type AgentExecRequest = {
  readonly tool: string;
  readonly args?: Readonly<Record<string, unknown>>;
  readonly capability: AgentCapability;
};

export type AgentExecResult = {
  readonly ok: boolean;
  readonly output?: string;
  readonly error?: string;
  readonly durationMs: number;
};
