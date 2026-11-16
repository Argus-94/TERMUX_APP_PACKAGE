/**
 * NativeAccelBackend — optional open C/JNI accelerator slot (plan.md Phase G).
 * Probe checks NativeModules.AibNativeAccel (external MIT/Apache lib).
 * No proprietary DSHA/proroot blobs.
 */
import type {
  BackendExecRequest,
  BackendExecResult,
  BackendProbeResult,
  RuntimeBackend,
} from "../RuntimeBackend";
import { getNativeAccelModule, isNativeAccelLinked } from "../native-accel-loader";

export class NativeAccelBackend implements RuntimeBackend {
  readonly id = "aib-native-accel" as const;
  /** Lower priority than Termux; this backend is selectable only with verified runtime-context support. */
  readonly priority = 5;
  readonly capabilities = ["shell", "path-accel", "optional-native"] as const;

  constructor(
    private readonly nativeAvailable: () => boolean | Promise<boolean> = () => isNativeAccelLinked(),
  ) {}

  async probe(): Promise<BackendProbeResult> {
    const started = Date.now();
    let available = false;
    try {
      available = !!(await this.nativeAvailable());
    } catch {
      available = false;
    }
    if (!available) {
      return {
        id: this.id,
        health: "unavailable",
        latencyMs: Date.now() - started,
        detail: "slot empty — link open MIT/Apache NativeModule AibNativeAccel; router uses termux-native/proot-distro",
        capabilities: this.capabilities,
        checkedAt: Date.now(),
      };
    }
    const mod = getNativeAccelModule();
    if (!mod) {
      return {
        id: this.id,
        health: "unavailable",
        latencyMs: Date.now() - started,
        detail: "native module unavailable or does not implement context-aware exec; router uses termux-native/proot-distro",
        capabilities: this.capabilities,
        checkedAt: Date.now(),
      };
    }
    let detail = "native accel linked";
    try {
      const r = await mod.probe();
      detail = r.detail || detail;
      if (!r.ok || r.supportsRuntimeContext !== true) {
        return {
          id: this.id,
          health: "unavailable",
          latencyMs: Date.now() - started,
          detail: `${detail}; runtime context contract not satisfied`,
          capabilities: this.capabilities,
          checkedAt: Date.now(),
        };
      }
    } catch (e) {
      return {
        id: this.id,
        health: "unavailable",
        latencyMs: Date.now() - started,
        detail: e instanceof Error ? e.message : String(e),
        capabilities: this.capabilities,
        checkedAt: Date.now(),
      };
    }
    return {
      id: this.id,
      health: "ready",
      latencyMs: Date.now() - started,
      detail,
      capabilities: this.capabilities,
      checkedAt: Date.now(),
    };
  }

  async exec(req: BackendExecRequest): Promise<BackendExecResult> {
    const started = Date.now();
    const mod = getNativeAccelModule();
    if (mod?.exec) {
      try {
        const probe = await mod.probe();
        if (!probe.ok || probe.supportsRuntimeContext !== true) {
          return {
            exitCode: 127,
            stdout: "",
            stderr: "aib-native-accel unavailable: runtime context contract not satisfied",
            durationMs: Date.now() - started,
            backendId: this.id,
          };
        }
        const r = await mod.exec(req);
        return {
          exitCode: r.exitCode,
          stdout: r.stdout || "",
          stderr: r.stderr || "",
          durationMs: Date.now() - started,
          backendId: this.id,
        };
      } catch (e) {
        return {
          exitCode: 1,
          stdout: "",
          stderr: e instanceof Error ? e.message : String(e),
          durationMs: Date.now() - started,
          backendId: this.id,
        };
      }
    }
    return {
      exitCode: 1,
      stdout: "",
      stderr: "aib-native-accel not available — use termux-native / proot-distro",
      durationMs: Date.now() - started,
      backendId: this.id,
    };
  }
}

export function createNativeAccelBackend(
  nativeAvailable?: () => boolean | Promise<boolean>,
): NativeAccelBackend {
  return new NativeAccelBackend(nativeAvailable);
}
