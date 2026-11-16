/**
 * BootstrapPipeline — staged, resumable environment setup (plan.md Phase C).
 * Stages are deterministic; fingerprints detect "already done".
 * Does not vendor proprietary proroot; uses Termux + proot-distro only.
 */
import type { JournalStore } from "./RuntimeJournal";

export type BootstrapStageId =
  | "termux-ready"
  | "tools-base"
  | "proot-distro"
  | "environment-image"
  | "workspace"
  | "verify";

export type BootstrapStageStatus = "pending" | "running" | "ok" | "skipped" | "error";

export type BootstrapStageState = Readonly<{
  id: BootstrapStageId;
  status: BootstrapStageStatus;
  fingerprint?: string;
  message?: string;
  updatedAt: number;
}>;

export type BootstrapPipelineState = Readonly<{
  version: 1;
  stages: BootstrapStageState[];
  current?: BootstrapStageId;
  lastError?: string;
  updatedAt: number;
}>;

export type BootstrapProgressEvent = Readonly<{
  stageId: BootstrapStageId;
  status: BootstrapStageStatus;
  percent: number; // 0..100 overall
  message: string;
}>;

export type StageRunner = (
  stageId: BootstrapStageId,
  report: (message: string) => void,
) => Promise<{ ok: boolean; fingerprint?: string; message?: string; skipped?: boolean }>;

const STAGE_ORDER: BootstrapStageId[] = [
  "termux-ready",
  "tools-base",
  "proot-distro",
  "environment-image",
  "workspace",
  "verify",
];

const STAGE_WEIGHT = 100 / STAGE_ORDER.length;

function emptyState(): BootstrapPipelineState {
  const now = Date.now();
  return {
    version: 1,
    stages: STAGE_ORDER.map((id) => ({
      id,
      status: "pending" as const,
      updatedAt: now,
    })),
    updatedAt: now,
  };
}

export class BootstrapPipeline {
  constructor(
    private readonly store: JournalStore,
    private readonly runner: StageRunner,
    private readonly expectedFingerprintForStage?: (stageId: BootstrapStageId) => string | undefined,
  ) {}

  async load(): Promise<BootstrapPipelineState> {
    const raw = await this.store.read();
    if (!raw) return emptyState();
    try {
      const parsed = JSON.parse(raw) as BootstrapPipelineState;
      if (parsed?.version !== 1 || !Array.isArray(parsed.stages)) return emptyState();
      // Ensure all stages present
      const byId = new Map(parsed.stages.map((s) => [s.id, s]));
      const stages = STAGE_ORDER.map(
        (id) =>
          byId.get(id) || {
            id,
            status: "pending" as const,
            updatedAt: Date.now(),
          },
      );
      return { ...parsed, stages, version: 1 };
    } catch {
      return emptyState();
    }
  }

  async save(state: BootstrapPipelineState): Promise<void> {
    await this.store.write(JSON.stringify({ ...state, updatedAt: Date.now() }, null, 0));
  }

  /** Reset all stages to pending (user-requested full re-run). */
  async reset(): Promise<BootstrapPipelineState> {
    const s = emptyState();
    await this.save(s);
    return s;
  }

  /**
   * Continue from first non-ok stage.
   * Skips stages already ok with fingerprint unless force.
   */
  async run(options?: {
    force?: boolean;
    onProgress?: (e: BootstrapProgressEvent) => void;
  }): Promise<BootstrapPipelineState> {
    let state = await this.load();
    const force = options?.force === true;

    for (let i = 0; i < STAGE_ORDER.length; i++) {
      const id = STAGE_ORDER[i];
      const prev = state.stages.find((s) => s.id === id)!;
      const expectedFingerprint = this.expectedFingerprintForStage?.(id);
      const fingerprintMatches = expectedFingerprint === undefined || prev.fingerprint === expectedFingerprint;
      if (!force && fingerprintMatches && (prev.status === "ok" || prev.status === "skipped") && prev.fingerprint) {
        options?.onProgress?.({
          stageId: id,
          status: prev.status,
          percent: Math.round((i + 1) * STAGE_WEIGHT),
          message: prev.message || `Skip ${id} (fingerprint)`,
        });
        continue;
      }

      state = {
        ...state,
        current: id,
        stages: state.stages.map((s) =>
          s.id === id
            ? { ...s, status: "running", updatedAt: Date.now(), message: "running…" }
            : s,
        ),
      };
      await this.save(state);
      options?.onProgress?.({
        stageId: id,
        status: "running",
        percent: Math.round(i * STAGE_WEIGHT + STAGE_WEIGHT * 0.2),
        message: `Running ${id}…`,
      });

      try {
        const result = await this.runner(id, (message) => {
          options?.onProgress?.({
            stageId: id,
            status: "running",
            percent: Math.round(i * STAGE_WEIGHT + STAGE_WEIGHT * 0.5),
            message,
          });
        });
        const status: BootstrapStageStatus = result.skipped
          ? "skipped"
          : result.ok
            ? "ok"
            : "error";
        state = {
          ...state,
          lastError: result.ok ? undefined : result.message,
          stages: state.stages.map((s) =>
            s.id === id
              ? {
                  id,
                  status,
                  fingerprint: result.fingerprint || prev.fingerprint,
                  message: result.message,
                  updatedAt: Date.now(),
                }
              : s,
          ),
        };
        await this.save(state);
        options?.onProgress?.({
          stageId: id,
          status,
          percent: Math.round((i + 1) * STAGE_WEIGHT),
          message: result.message || status,
        });
        if (!result.ok && !result.skipped) {
          return state;
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        state = {
          ...state,
          lastError: message,
          stages: state.stages.map((s) =>
            s.id === id
              ? { id, status: "error", message, updatedAt: Date.now() }
              : s,
          ),
        };
        await this.save(state);
        options?.onProgress?.({
          stageId: id,
          status: "error",
          percent: Math.round(i * STAGE_WEIGHT),
          message,
        });
        return state;
      }
    }

    state = { ...state, current: undefined, lastError: undefined };
    await this.save(state);
    return state;
  }
}

export function createBootstrapPipeline(
  store: JournalStore,
  runner: StageRunner,
  expectedFingerprintForStage?: (stageId: BootstrapStageId) => string | undefined,
): BootstrapPipeline {
  return new BootstrapPipeline(store, runner, expectedFingerprintForStage);
}

export { STAGE_ORDER };
