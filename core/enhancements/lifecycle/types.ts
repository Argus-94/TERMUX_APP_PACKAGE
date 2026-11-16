/** Lifecycle contracts deliberately separate Android signals from portable policy. */
export type AppLifecycleState = "active" | "inactive" | "background";
export type ContainerLifecycleState = "running" | "sleeping" | "quarantined";
export type ContainerLifecycleRecord = Readonly<{ containerId: string; state: ContainerLifecycleState; lastUsedAt: number; changedAt: number; reason?: string }>;
export type LifecycleErrorCode = "UNKNOWN_CONTAINER" | "SLEEP_FAILED" | "WAKE_FAILED" | "STORE_FAILED";
export class LifecycleError extends Error { constructor(readonly code: LifecycleErrorCode, message: string) { super(message); this.name = "LifecycleError"; } }
export type LifecycleStore = Readonly<{ read(): Promise<string | null>; write(value: string): Promise<void> }>;
export type SleepWakeAdapter = Readonly<{
  stopProcesses(containerId: string): Promise<void>;
  startFromManifest(containerId: string): Promise<void>;
  waitForHealth(containerId: string, timeoutMs: number): Promise<boolean>;
}>;
export type LifecyclePolicy = Readonly<{ idleThresholdMs: number; backgroundIdleThresholdMs: number; healthTimeoutMs: number }>;
export type PressureStage = "none" | "sleep-idle" | "stop-workers" | "quarantine";
export type PressureReport = Readonly<{ availableBytes: number; stage: PressureStage; slept: number; stoppedWorkers: number; quarantined: number }>;
export type ReaperAdapter = Readonly<{ availableMemoryBytes(): Promise<number>; stopNonCriticalWorkers(): Promise<number>; quarantineNonCriticalContainers(): Promise<number> }>;
