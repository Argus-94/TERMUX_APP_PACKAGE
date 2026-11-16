/** Resumable, explicit first-run orchestration layered over the existing BootstrapPipeline. */
import { BootstrapPipeline } from "../../runtime/BootstrapPipeline.ts";
import type { BootstrapPipelineState, BootstrapProgressEvent, BootstrapStageStatus } from "../../runtime/BootstrapPipeline.ts";
import type { DiagnosticReport } from "./BootstrapDiagnostics.ts";
import type { SmartDefaultsRecommendation } from "./SmartDefaults.ts";

/** Ordered logical stages in the explicit first-run flow. */
export type FirstRunStage = "diagnostics" | "bootstrap" | "safe-defaults";
/** Durable lifecycle status for a logical stage. */
export type FirstRunStageStatus = "pending" | "running" | "ok" | "error";
/** Marker classification, including work resumed after interruption. */
export type FirstRunKind = "first-run" | "major-update" | "resume";
export type FirstRunCheckKind = FirstRunKind | "repair";
/** Versioned, idempotently persisted orchestration marker. */
export type FirstRunState = Readonly<{ version: 1; targetVersion: string; kind: FirstRunKind; stages: Readonly<Record<FirstRunStage, FirstRunStageStatus>>; updatedAt: number }>;
/** Durable key-value storage adapter for the first-run marker. */
export type FirstRunStore = Readonly<{ read(): Promise<string | null>; write(value: string): Promise<void>; quarantine?(value: string): Promise<void> }>;
/** Stable, machine-readable failure categories returned by orchestration. */
export type FirstRunErrorCode = "STORE_FAILED" | "LEGACY_STATE_UNAVAILABLE" | "STATE_CORRUPT" | "STATE_FUTURE_VERSION" | "DIAGNOSTICS_FAILED" | "BOOTSTRAP_FAILED" | "DEFAULTS_FAILED" | "BOOTSTRAP_UNSAFE_STATE";
export class FirstRunError extends Error {
  /** Creates a stable, machine-readable orchestration error. */
  constructor(readonly code: FirstRunErrorCode, message: string) { super(message); this.name = "FirstRunError"; }
}
export class FirstRunStoreReadError extends Error {
  constructor(readonly code: "STORE_FAILED" | "LEGACY_STATE_UNAVAILABLE", message = code) { super(message); this.name = "FirstRunStoreReadError"; }
}
/** Read-only startup status; errors do not cause bootstrap or host actions. */
export type FirstRunCheck = Readonly<{ required: boolean; kind?: FirstRunCheckKind; state?: FirstRunState; error?: FirstRunError }>;
/** Side-effect boundary for diagnosis and idempotent safe-default application. */
export type FirstRunAdapters = Readonly<{ diagnostics(): Promise<DiagnosticReport>; safeDefaults(): Promise<SmartDefaultsRecommendation> }>;
/** Aggregate progress callback payload; bootstrap events retain pipeline detail when available. */
export type FirstRunProgress = Readonly<{ stage: FirstRunStage; status: FirstRunStageStatus | BootstrapStageStatus; message: string; bootstrapEvent?: BootstrapProgressEvent }>;
/** Result includes the latest durable stage state and any safe-to-return stage results. */
export type FirstRunResult = Readonly<{ state: FirstRunState; diagnostics?: DiagnosticReport; defaults?: SmartDefaultsRecommendation; bootstrap?: BootstrapPipelineState; warning?: string; error?: FirstRunError }>;
/** Explicit invocation parameters; no run occurs until the caller calls run(). */
export type FirstRunOptions = Readonly<{ targetVersion: string; onProgress?: (event: FirstRunProgress) => void }>;

const stageNames: readonly FirstRunStage[] = ["diagnostics", "bootstrap", "safe-defaults"];
const ERROR_MESSAGES: Readonly<Record<FirstRunErrorCode, string>> = {
  STORE_FAILED: "First-run state could not be read or saved; check app storage and retry.",
  LEGACY_STATE_UNAVAILABLE: "The previous setup marker could not be checked because the embedded runtime bridge is unavailable. No setup was started and no marker was changed. Check the embedded runtime status and retry; a separate Termux app or RUN_COMMAND permission is not used.",
  STATE_CORRUPT: "The first-run marker is malformed. Recovery will preserve the original marker before writing a replacement.",
  STATE_FUTURE_VERSION: "The first-run marker was written by a newer app version. It was left unchanged; update the app before attempting recovery.",
  DIAGNOSTICS_FAILED: "Host diagnostics did not pass; bootstrap was not started.",
  BOOTSTRAP_FAILED: "Bootstrap did not complete; retry is safe and completed stages are retained.",
  DEFAULTS_FAILED: "Safe defaults could not be applied; retry the setup.",
  BOOTSTRAP_UNSAFE_STATE: "A completed bootstrap stage has no fingerprint; refusing to rerun completed work.",
};
function newState(targetVersion: string, kind: FirstRunKind): FirstRunState {
  return { version: 1, targetVersion, kind, stages: { diagnostics: "pending", bootstrap: "pending", "safe-defaults": "pending" }, updatedAt: Date.now() };
}
function majorVersion(value: string): number | undefined {
  const match = /^(?:v)?(\d+)(?:\.|$)/i.exec(value);
  return match ? Number(match[1]) : undefined;
}
function validState(value: unknown): value is FirstRunState {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<FirstRunState>;
  return state.version === 1
    && typeof state.targetVersion === "string" && state.targetVersion.length > 0 && state.targetVersion.length <= 64
    && (state.kind === "first-run" || state.kind === "major-update" || state.kind === "resume")
    && Number.isFinite(state.updatedAt)
    && !!state.stages && stageNames.every((name) => ["pending", "running", "ok", "error"].includes(state.stages?.[name] || ""));
}
function isFutureVersion(value: unknown): boolean {
  return !!value && typeof value === "object" && Number.isInteger((value as { version?: unknown }).version)
    && Number((value as { version: number }).version) > 1;
}
function storeReadError(error: unknown): FirstRunError {
  const code = error instanceof FirstRunStoreReadError ? error.code : "STORE_FAILED";
  return new FirstRunError(code, ERROR_MESSAGES[code]);
}
function isMajorUpdate(previousVersion: string, currentVersion: string): boolean {
  const previousMajor = majorVersion(previousVersion);
  const currentMajor = majorVersion(currentVersion);
  return previousMajor !== undefined && currentMajor !== undefined
    ? previousMajor !== currentMajor
    : previousVersion !== currentVersion;
}

/** Runs only when explicitly called; completed orchestration and pipeline stages are not repeated. */
export class FirstRunOrchestrator {
  private activeRun: Promise<FirstRunResult> | null = null;
  /** Binds a durable marker, existing BootstrapPipeline, and host-supplied adapters. */
  constructor(private readonly store: FirstRunStore, private readonly pipeline: BootstrapPipeline, private readonly adapters: FirstRunAdapters) {}

  /** Read-only: tell the app whether to surface first-run setup without starting bootstrap. */
  async inspect(targetVersion: string): Promise<FirstRunCheck> {
    let raw: string | null;
    try { raw = await this.store.read(); }
    catch (error) { return { required: true, kind: "repair", error: storeReadError(error) }; }
    if (!raw) return { required: true, kind: "first-run" };
    let parsed: unknown;
    try { parsed = JSON.parse(raw); }
    catch { return { required: true, kind: "repair", error: new FirstRunError("STATE_CORRUPT", ERROR_MESSAGES.STATE_CORRUPT) }; }
    if (isFutureVersion(parsed)) return { required: true, kind: "repair", error: new FirstRunError("STATE_FUTURE_VERSION", ERROR_MESSAGES.STATE_FUTURE_VERSION) };
    if (!validState(parsed)) return { required: true, kind: "repair", error: new FirstRunError("STATE_CORRUPT", ERROR_MESSAGES.STATE_CORRUPT) };
    if (isMajorUpdate(parsed.targetVersion, targetVersion)) return { required: true, kind: "major-update", state: parsed };
    const done = stageNames.every((stage) => parsed.stages[stage] === "ok");
    return done ? { required: false, state: parsed } : { required: true, kind: "resume", state: parsed };
  }

  /** Coalesce simultaneous startup/retry requests into one side-effecting run. */
  run(options: FirstRunOptions): Promise<FirstRunResult> {
    if (this.activeRun) return this.activeRun;
    const execution = this.runStages(options);
    const shared = execution.finally(() => { if (this.activeRun === shared) this.activeRun = null; });
    this.activeRun = shared;
    return shared;
  }

  /** Diagnoses, runs bootstrap, then applies safe defaults; returns typed failures instead of throwing. */
  private async runStages(options: FirstRunOptions): Promise<FirstRunResult> {
    let state: FirstRunState;
    let warning: string | undefined;
    let raw: string | null;
    try { raw = await this.store.read(); }
    catch (error) { return this.fail(newState(options.targetVersion, "first-run"), storeReadError(error).code, undefined, undefined, options); }
    if (!raw) state = newState(options.targetVersion, "first-run");
    else {
      let parsed: unknown;
      try { parsed = JSON.parse(raw); }
      catch { parsed = null; }
      if (isFutureVersion(parsed)) return this.fail(newState(options.targetVersion, "first-run"), "STATE_FUTURE_VERSION", undefined, undefined, options);
      if (!validState(parsed)) {
        if (this.store.quarantine) {
          try { await this.store.quarantine(raw); }
          catch { return this.fail(newState(options.targetVersion, "first-run"), "STORE_FAILED", undefined, undefined, options); }
        }
        state = newState(options.targetVersion, "first-run");
        warning = "The invalid first-run marker was preserved in recovery storage before replacing it; existing bootstrap fingerprints remain authoritative.";
      } else if (isMajorUpdate(parsed.targetVersion, options.targetVersion)) {
        state = newState(options.targetVersion, "major-update");
      } else {
        state = { ...parsed, targetVersion: options.targetVersion, kind: "resume" };
      }
    }
    if (warning) {
      try { await this.persist(state); }
      catch { return this.fail(state, "STORE_FAILED", undefined, undefined, options); }
      try { options.onProgress?.({ stage: "diagnostics", status: "running", message: warning }); } catch { /* progress listener is best-effort */ }
    }
    const report = (stage: FirstRunStage, status: FirstRunStageStatus, message: string): void => { try { options.onProgress?.({ stage, status, message }); } catch { /* best-effort UI */ } };
    let diagnostic: DiagnosticReport | undefined;
    let bootstrap: BootstrapPipelineState | undefined;
    let defaults: SmartDefaultsRecommendation | undefined;
    for (const stage of stageNames) {
      if (state.stages[stage] === "ok") continue;
      state = this.withStage(state, stage, "running");
      try { await this.persist(state); } catch { return this.fail(state, "STORE_FAILED", undefined, { diagnostic, bootstrap, defaults, warning }, options); }
      report(stage, "running", `Running ${stage}.`);
      try {
        if (stage === "diagnostics") {
          diagnostic = await this.adapters.diagnostics();
          if (diagnostic.overall === "blocked") throw new FirstRunError("DIAGNOSTICS_FAILED", ERROR_MESSAGES.DIAGNOSTICS_FAILED);
        } else if (stage === "bootstrap") {
          const loaded = await this.pipeline.load();
          const unsafeDone = loaded.stages.some((item) => (item.status === "ok" || item.status === "skipped") && !item.fingerprint);
          if (unsafeDone) throw new FirstRunError("BOOTSTRAP_UNSAFE_STATE", ERROR_MESSAGES.BOOTSTRAP_UNSAFE_STATE);
          bootstrap = await this.pipeline.run({ onProgress: (event) => { try { options.onProgress?.({ stage: "bootstrap", status: event.status, message: event.message, bootstrapEvent: event }); } catch { /* best-effort UI */ } } });
          if (bootstrap.stages.some((item) => item.status === "error" || item.status === "running" || ((item.status === "ok" || item.status === "skipped") && !item.fingerprint))) throw new FirstRunError("BOOTSTRAP_FAILED", ERROR_MESSAGES.BOOTSTRAP_FAILED);
        } else {
          defaults = await this.adapters.safeDefaults();
        }
        state = this.withStage(state, stage, "ok");
        await this.persist(state);
        report(stage, "ok", `${stage} completed.`);
      } catch (error) {
        const code: FirstRunErrorCode = error instanceof FirstRunError ? error.code : stage === "diagnostics" ? "DIAGNOSTICS_FAILED" : stage === "bootstrap" ? "BOOTSTRAP_FAILED" : "DEFAULTS_FAILED";
        state = this.withStage(state, stage, "error");
        try { await this.persist(state); } catch { return this.fail(state, "STORE_FAILED", undefined, { diagnostic, bootstrap, defaults, warning }, options); }
        const typed = error instanceof FirstRunError ? error : new FirstRunError(code, ERROR_MESSAGES[code]);
        report(stage, "error", typed.message);
        return { state, diagnostics: diagnostic, defaults, bootstrap, ...(warning ? { warning } : {}), error: typed };
      }
    }
    return { state, diagnostics: diagnostic, defaults, bootstrap, ...(warning ? { warning } : {}) };
  }

  private withStage(state: FirstRunState, stage: FirstRunStage, status: FirstRunStageStatus): FirstRunState {
    return { ...state, stages: { ...state.stages, [stage]: status }, updatedAt: Date.now() };
  }
  private async persist(state: FirstRunState): Promise<void> {
    const value = JSON.stringify({ ...state, updatedAt: Date.now() });
    await this.store.write(value);
    const readBack = await this.store.read();
    if (readBack !== value) throw new Error("FIRST_RUN_STATE_READBACK_MISMATCH");
  }
  private fail(state: FirstRunState, code: FirstRunErrorCode, _cause: unknown, values: Readonly<{ diagnostic?: DiagnosticReport; bootstrap?: BootstrapPipelineState; defaults?: SmartDefaultsRecommendation; warning?: string }> | undefined, options: FirstRunOptions): FirstRunResult {
    const error = new FirstRunError(code, ERROR_MESSAGES[code]);
    try { options.onProgress?.({ stage: "diagnostics", status: "error", message: error.message }); } catch { /* best-effort UI */ }
    return { state, ...(values ?? {}), error };
  }
}
