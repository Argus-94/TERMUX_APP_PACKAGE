/** Runtime recovery registry with observable execution history. */
import type { TimelineEventType, TimelineLevel } from "../enhancements/timeline/EventStore";
export type RecoveryActionKind =
  | "restart_terminal" | "reinit_home" | "recreate_session" | "reconnect_bridge"
  | "reset_agent" | "container_restart" | "repair" | "other";
export type RecoveryAction = { readonly id: string; readonly kind: RecoveryActionKind; readonly description: string; readonly run: () => Promise<void> | void; };
export type RecoveryResult = { readonly actionId: string; readonly ok: boolean; readonly error?: string; readonly durationMs: number; };
export type RecoveryEvent = RecoveryResult & { readonly timestamp: number };
export type RecoveryEventSink = (event: Readonly<{ type: TimelineEventType; level: TimelineLevel; payload: Readonly<Record<string, unknown>> }>) => Promise<void> | void;

export class RecoveryManager {
  private readonly actions = new Map<string, RecoveryAction>();
  private readonly history: RecoveryEvent[] = [];
  private eventSink?: RecoveryEventSink;
  setEventSink(sink: RecoveryEventSink): void { this.eventSink = sink; }
  private async emit(type: TimelineEventType, level: TimelineLevel, payload: Readonly<Record<string, unknown>>): Promise<void> { try { await this.eventSink?.({ type, level, payload }); } catch { /* telemetry is non-fatal */ } }
  register(action: RecoveryAction): void { this.actions.set(action.id, action); }
  list(): RecoveryAction[] { return [...this.actions.values()]; }
  historySnapshot(): RecoveryEvent[] { return [...this.history]; }
  async run(actionId: string): Promise<RecoveryResult> {
    const action = this.actions.get(actionId); const started = Date.now();
    await this.emit("recovery.started", "info", { actionId, kind: action?.kind ?? "unknown" });
    if (!action) { const result = { actionId, ok: false, error: `Unknown recovery action: ${actionId}`, durationMs: 0 }; this.history.push({ ...result, timestamp: Date.now() }); await this.emit("recovery.finished", "error", { actionId, ok: false, error: "UNKNOWN_ACTION" }); return result; }
    try { await action.run(); const result = { actionId, ok: true, durationMs: Date.now() - started }; this.history.push({ ...result, timestamp: Date.now() }); await this.emit("recovery.finished", "info", { actionId, kind: action.kind, ok: true, durationMs: result.durationMs }); return result; }
    catch (e) { const result = { actionId, ok: false, error: e instanceof Error ? e.message : String(e), durationMs: Date.now() - started }; this.history.push({ ...result, timestamp: Date.now() }); await this.emit("recovery.finished", "error", { actionId, kind: action.kind, ok: false, error: result.error, durationMs: result.durationMs }); return result; }
  }
}
export function createRecoveryManager(): RecoveryManager { return new RecoveryManager(); }
