export type RuntimeBackendLiveStatus = Readonly<{ id: string; status: "up" | "down" | "degraded"; latencyMs?: number }>;
export type RuntimeContainerLiveStatus = Readonly<{ id: string; name: string; state: "running" | "sleeping" | "stopped"; memoryMb?: number }>;
export type RuntimeResourceStatus = Readonly<{ memUsedMb?: number; memTotalMb?: number; batteryLevel?: number; isCharging?: boolean }>;
export type RuntimeLiveSnapshot = Readonly<{
  timestamp: number;
  backends: readonly RuntimeBackendLiveStatus[];
  containers: readonly RuntimeContainerLiveStatus[];
  processes: Readonly<{ total: number; supervised: number; quarantined: number }>;
  resources: RuntimeResourceStatus;
  portForwards: number;
  interceptorActive?: boolean;
  lastError?: string;
  unavailable?: readonly string[];
}>;
export type RuntimeStatusSources = Readonly<{
  backends(): readonly Readonly<{ id: string; status: "up" | "down" | "degraded"; latencyMs?: number }>[];
  containers(): Promise<readonly RuntimeContainerLiveStatus[]> | readonly RuntimeContainerLiveStatus[];
  processes(): Readonly<{ total: number; supervised: number; quarantined: number }>;
  resources(): Promise<RuntimeResourceStatus> | RuntimeResourceStatus;
  portForwards(): Promise<number> | number;
  interceptorActive?(): Promise<boolean> | boolean;
  lastError?(): string | undefined;
}>;
export type RuntimeStatusListener = (snapshot: RuntimeLiveSnapshot) => void;
export type RuntimeStatusAppState = "active" | "background";
