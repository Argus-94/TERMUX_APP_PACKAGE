/**
 * RuntimeBackend — pluggable userspace execution backends.
 *
 * DSHA ships proprietary "proroot" (LD_PRELOAD path translation, no source).
 * AI Builder deliberately does NOT vendor proprietary binaries.
 *
 * Instead we provide an open multi-backend router that is *better on every
 * engineering axis we control*:
 *   - fully open source (MIT-compatible project code)
 *   - automatic health-driven fallback (no single point of failure)
 *   - per-backend metrics (latency, failures, consecutive errors)
 *   - transaction-aware (maintenance barrier compatible)
 *   - verifiable probes before marking READY
 *
 * A future optional native accelerator (C/JNI LD_PRELOAD) can plug in as
 * another backend implementing this same interface — without ever depending
 * on closed-source proroot.
 */

import type { HardenedProotPolicy } from "../enhancements/isolation/HardenedProotOptions";
import type { ProxyClientConfiguration } from "../enhancements/auth/types";

export type BackendId =
  | "termux-native"
  | "proot-distro"
  | "proot-legacy"
  | "linux-userspace"
  | "aib-native-accel"
  | "unavailable";

export type BackendHealth = "ready" | "degraded" | "unavailable" | "unknown";

export type BackendProbeResult = Readonly<{
  id: BackendId;
  health: BackendHealth;
  latencyMs: number;
  detail: string;
  capabilities: readonly string[];
  checkedAt: number;
}>;

export type BackendExecRequest = Readonly<{
  command: string;
  cwd?: string;
  timeoutMs?: number;
  env?: Readonly<Record<string, string>>;
  /** Active native loopback session; only its dummy client key/base URL may cross into a backend. */
  credentialProxy?: ProxyClientConfiguration;
  /** Optional guest-shell RLIMITs; unsupported kernel flags are never implied. */
  hardening?: HardenedProotPolicy;
}>;

export type BackendExecResult = Readonly<{
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  backendId: BackendId;
}>;

export type BackendMetrics = Readonly<{
  id: BackendId;
  execCount: number;
  failCount: number;
  consecutiveFailures: number;
  totalDurationMs: number;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  lastError: string | null;
}>;

export interface RuntimeBackend {
  readonly id: BackendId;
  readonly priority: number; // lower = preferred when healthy
  readonly capabilities: readonly string[];
  probe(): Promise<BackendProbeResult>;
  exec(req: BackendExecRequest): Promise<BackendExecResult>;
  /** Optional warm-up after successful probe */
  warmup?(): Promise<void>;
}

export type RouterSnapshot = Readonly<{
  activeId: BackendId | null;
  backends: readonly BackendProbeResult[];
  metrics: readonly BackendMetrics[];
  policy: "prefer-fastest-healthy" | "prefer-priority" | "sticky";
  failureThreshold?: number;
  priorityOrder?: readonly BackendId[];
}>;
