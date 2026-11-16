/**
 * Runtime-only lock manager for sessions / projects / containers.
 * In-memory cooperative locks only. No file locks on project trees by default.
 */

export type LockScope = "session" | "project" | "container" | "toolchain" | "global";

export type LockHandle = {
  readonly id: string;
  readonly scope: LockScope;
  readonly resourceId: string;
  readonly owner: string;
  readonly acquiredAt: number;
};

export class LockManager {
  private readonly locks = new Map<string, LockHandle>();

  private key(scope: LockScope, resourceId: string): string {
    return `${scope}:${resourceId}`;
  }

  tryAcquire(
    scope: LockScope,
    resourceId: string,
    owner: string,
  ): LockHandle | null {
    const k = this.key(scope, resourceId);
    if (this.locks.has(k)) {
      return null;
    }
    const handle: LockHandle = {
      id: `lock-${k}-${Date.now()}`,
      scope,
      resourceId,
      owner,
      acquiredAt: Date.now(),
    };
    this.locks.set(k, handle);
    return handle;
  }

  release(scope: LockScope, resourceId: string, owner?: string): boolean {
    const k = this.key(scope, resourceId);
    const existing = this.locks.get(k);
    if (!existing) return false;
    if (owner && existing.owner !== owner) return false;
    this.locks.delete(k);
    return true;
  }

  isLocked(scope: LockScope, resourceId: string): boolean {
    return this.locks.has(this.key(scope, resourceId));
  }

  get(scope: LockScope, resourceId: string): LockHandle | undefined {
    return this.locks.get(this.key(scope, resourceId));
  }

  list(): LockHandle[] {
    return [...this.locks.values()];
  }

  releaseAllForOwner(owner: string): number {
    let n = 0;
    for (const [k, h] of this.locks) {
      if (h.owner === owner) {
        this.locks.delete(k);
        n++;
      }
    }
    return n;
  }
}

export function createLockManager(): LockManager {
  return new LockManager();
}
