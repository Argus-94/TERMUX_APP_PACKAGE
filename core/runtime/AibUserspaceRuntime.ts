/**
 * AibUserspaceRuntime — project-facing facade over RuntimeBackendRouter.
 *
 * This is the open-source answer to DSHA's proprietary proroot:
 * we do not claim kernel-bypass path translation in pure JS (that needs
 * audited C/JNI). We *do* deliver a superior control plane:
 *
 * 1. Multiple backends (termux-native, proot-distro, …)
 * 2. Probe → READY only after real command success
 * 3. Automatic failover after consecutive failures (threshold configurable)
 * 4. Metrics for agent/UI
 * 5. Optional future native accelerator plugs in as RuntimeBackend
 *
 * Native accelerator roadmap (separate optional module, not shipped here):
 *   - C/JNI LD_PRELOAD path mapper for hot paths
 *   - Must be fully open source and redistributable
 *   - Registers as backend id "aib-native-accel" with priority 5
 *   - Router falls back if probe fails — same contract as proroot→proot in DSHA,
 *     but without closed binaries
 */
import { RuntimeBackendRouter, createRuntimeBackendRouter } from "./RuntimeBackendRouter";
import { TermuxNativeBackend } from "./backends/TermuxNativeBackend";
import { ProotDistroBackend, type ProotProfile } from "./backends/ProotDistroBackend";
import { NativeAccelBackend } from "./backends/NativeAccelBackend";
import type {
  BackendExecRequest,
  BackendExecResult,
  BackendProbeResult,
  RouterSnapshot,
} from "./RuntimeBackend";
import type { RuntimeTaskGate } from "./RuntimeTaskGate";
import type { RuntimeManifest } from "../enhancements/manifest/types";
import { ManifestError } from "../enhancements/manifest/types";

export type UserspaceManifestApplier = Readonly<{ apply(manifest: RuntimeManifest, projectId: string): Promise<readonly string[]> }>;
export type AibUserspaceRuntimeOptions = Readonly<{
  prootProfile?: ProotProfile;
  prootProfileProvider?: () => ProotProfile | null;
  policy?: "prefer-fastest-healthy" | "prefer-priority" | "sticky";
  manifestApplier?: UserspaceManifestApplier;
}>;

export type UserspaceRuntimeStatus = Readonly<{
  ready: boolean;
  activeBackend: string | null;
  probes: readonly BackendProbeResult[];
  snapshot: RouterSnapshot;
}>;

export class AibUserspaceRuntime {
  private readonly router: RuntimeBackendRouter;
  private readonly prootBackend: ProotDistroBackend;
  private readonly prootProfileProvider?: () => ProotProfile | null;
  private readonly manifestApplier?: UserspaceManifestApplier;
  private initialized = false;

  constructor(
    private readonly execFn: (command: string, opts?: { cwd?: string; timeoutMs?: number }) => Promise<{
      exitCode?: number;
      code?: number;
      stdout?: string;
      stderr?: string;
    }>,
    private readonly gate?: RuntimeTaskGate,
    options?: AibUserspaceRuntimeOptions,
  ) {
    this.router = createRuntimeBackendRouter({
      policy: options?.policy ?? "prefer-priority",
      failureThreshold: 3,
    });
    this.router.register(new NativeAccelBackend()); // priority 5; unavailable until open .so linked
    this.router.register(new TermuxNativeBackend(execFn));
    this.prootBackend = new ProotDistroBackend(execFn, options?.prootProfile ?? "debian");
    this.prootProfileProvider = options?.prootProfileProvider;
    this.manifestApplier = options?.manifestApplier;
    this.router.register(this.prootBackend);
  }

  private syncProotProfile(): void {
    const profile = this.prootProfileProvider?.();
    if (profile) this.prootBackend.setProfile(profile);
  }

  /** Allow tests / future native accel to inject backends. */
  registerBackend(backend: import("./RuntimeBackend").RuntimeBackend): void {
    this.router.register(backend);
  }

  /** Set the existing router's selection policy without exposing its mutable internals. */
  setBackendPolicy(policy: import("./RuntimeBackend").RouterSnapshot["policy"]): void {
    this.router.setPolicy(policy);
  }

  setBackendFailureThreshold(value: number): void {
    this.router.setFailureThreshold(value);
  }

  setBackendPriorityOrder(ids: readonly import("./RuntimeBackend").BackendId[]): void {
    this.router.setPriorityOrder(ids);
  }

  async initialize(): Promise<UserspaceRuntimeStatus> {
    this.syncProotProfile();
    const probes = await this.router.probeAll();
    this.initialized = true;
    const active = this.router.getActiveId();
    return {
      ready: probes.some((p) => p.health === "ready"),
      activeBackend: active,
      probes,
      snapshot: this.router.snapshot(),
    };
  }

  async status(): Promise<UserspaceRuntimeStatus> {
    this.syncProotProfile();
    if (!this.initialized) return this.initialize();
    const probes = await this.router.probeAll();
    return {
      ready: probes.some((p) => p.health === "ready"),
      activeBackend: this.router.getActiveId(),
      probes,
      snapshot: this.router.snapshot(),
    };
  }

  async exec(req: BackendExecRequest): Promise<BackendExecResult> {
    this.syncProotProfile();
    if (!this.initialized) await this.initialize();
    const run = () => this.router.exec(req);
    if (this.gate) {
      return this.gate.run("normal", "userspace-exec", run);
    }
    return run();
  }

  async execMaintenance(req: BackendExecRequest): Promise<BackendExecResult> {
    this.syncProotProfile();
    if (!this.initialized) await this.initialize();
    const run = () => this.router.exec(req);
    if (this.gate) {
      return this.gate.run("maintenance", "userspace-maintenance", run);
    }
    return run();
  }

  /** Apply only after the host supplied a real process adapter; no shell/manifest behavior is fabricated. */
  async applyManifest(manifest: RuntimeManifest, projectId: string): Promise<readonly string[]> {
    if (!this.manifestApplier) throw new ManifestError("APPLY_FAILED", "No manifest process adapter is configured");
    return this.manifestApplier.apply(manifest, projectId);
  }

  snapshot(): RouterSnapshot {
    return this.router.snapshot();
  }

  resetCircuitBreakers(): void {
    this.router.resetMetrics();
  }
}

export function createAibUserspaceRuntime(
  execFn: (command: string, opts?: { cwd?: string; timeoutMs?: number }) => Promise<{
    exitCode?: number;
    code?: number;
    stdout?: string;
    stderr?: string;
  }>,
  gate?: RuntimeTaskGate,
  options?: AibUserspaceRuntimeOptions,
): AibUserspaceRuntime {
  return new AibUserspaceRuntime(execFn, gate, options);
}
