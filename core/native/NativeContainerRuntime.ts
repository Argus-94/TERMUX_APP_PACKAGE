/**
 * Native container runtime interface (optional backend).
 * Userspace backend remains the default; native enables only when capable.
 */

export type NativeRuntimeCapability = {
  available: boolean;
  reason?: string;
  backend?: "proot" | "chroot" | "nsjail" | "unknown";
};

export interface NativeContainerRuntime {
  detect(): Promise<NativeRuntimeCapability> | NativeRuntimeCapability;
  isEnabled(): boolean;
}

export class DefaultNativeContainerRuntime implements NativeContainerRuntime {
  private enabled = false;

  detect(): NativeRuntimeCapability {
    // Safe default: not available in pure JS host.
    return {
      available: false,
      reason: "Native runtime not detected on this host",
      backend: "unknown",
    };
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** Test helper only. */
  forceEnable(value: boolean): void {
    this.enabled = value;
  }
}

export function createNativeContainerRuntime(): DefaultNativeContainerRuntime {
  return new DefaultNativeContainerRuntime();
}
