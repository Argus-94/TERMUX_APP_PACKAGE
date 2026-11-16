/** Compatibility export: embedded execution has no Android package-scoped permission. */
export const RUN_COMMAND_PERMISSION_NAME = "embedded-runtime-capability";
export const RUN_COMMAND_PERMISSION_SETUP_HINT = "AI Builder → Runtime → bundled bootstrap status";
export function isAndroidRunCommandPermissionDenied(raw: unknown): boolean {
  return /AIB_PRIVATE_RUNTIME_REQUIRED|AIB_EMBEDDED_RUNTIME_UNAVAILABLE|EMBEDDED_TERMUX_UNAVAILABLE/i.test(String(raw ?? ""));
}
export function runCommandPermissionStatus(_raw?: unknown): string {
  return "AIB_EMBEDDED_RUNTIME_UNAVAILABLE: verify the bundled bootstrap and native bridge; no external runtime is used.";
}
/** Single-flight cache retained for private-capability callers, not Android grants. */
export class RunCommandPermissionGate {
  private cached: { value: boolean; checkedAt: number } | null = null;
  private pending: Promise<boolean> | null = null;
  private readonly allowedTtlMs: number;
  private readonly deniedTtlMs: number;

  constructor(allowedTtlMs = 5_000, deniedTtlMs = 30_000) {
    this.allowedTtlMs = allowedTtlMs;
    this.deniedTtlMs = deniedTtlMs;
  }

  remember(value: boolean): void {
    this.cached = { value, checkedAt: Date.now() };
  }

  invalidate(): void {
    this.cached = null;
  }

  async check(readPermission: () => Promise<boolean>, forceRefresh = false): Promise<boolean> {
    if (forceRefresh) this.invalidate();
    const now = Date.now();
    if (this.cached) {
      const ttl = this.cached.value ? this.allowedTtlMs : this.deniedTtlMs;
      if (now - this.cached.checkedAt < ttl) return this.cached.value;
    }
    if (this.pending) return this.pending;
    const pending = Promise.resolve().then(readPermission).then((value) => {
      this.remember(value === true);
      return value === true;
    }, (error: unknown) => {
      this.remember(false);
      throw error;
    });
    this.pending = pending;
    try {
      return await pending;
    } finally {
      if (this.pending === pending) this.pending = null;
    }
  }
}
