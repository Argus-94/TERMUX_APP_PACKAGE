import { PermissionExplainer } from "./PermissionExplainer";
import type { PermissionGrantStatus, PermissionId, PermissionOnboardingState, PermissionStatusAdapter } from "./types";

const ALL_IDS: readonly PermissionId[] = ["notifications", "storage", "accessibility", "battery-optimization", "install-packages"];
const STATUS_KEY = "aib.permissions.onboarding.status.v1";
const DEFERRED_KEY = "aib.permissions.onboarding.deferred.v1";
const EMPTY: Readonly<Record<PermissionId, PermissionGrantStatus>> = Object.freeze({ notifications: "unavailable", storage: "unavailable", accessibility: "unavailable", "battery-optimization": "unavailable", "termux-run-command": "unavailable", "install-packages": "unavailable" });

export type PermissionOnboardingStore = Readonly<{ get(key: string): Promise<string | null>; set(key: string, value: string): Promise<void> }>;
export type PermissionAuditEvent = Readonly<{ action: "check" | "request" | "settings" | "defer"; permissionId?: PermissionId; status?: PermissionGrantStatus }>;
export type PermissionAudit = (event: PermissionAuditEvent) => Promise<void> | void;

/** Explicit, non-blocking permission guidance; does not run or open settings by itself. */
export class PermissionsOnboarding {
  private readonly explainer: PermissionExplainer;
  private statuses: Readonly<Record<PermissionId, PermissionGrantStatus>> = EMPTY;
  private dismissed = false;
  constructor(private readonly adapter: PermissionStatusAdapter, private readonly store: PermissionOnboardingStore, explainer = new PermissionExplainer(), private readonly audit?: PermissionAudit) { this.explainer = explainer; }

  /** Query only current statuses exposed by existing platform bridges. */
  async refresh(): Promise<PermissionOnboardingState> {
    const prior = await this.loadPriorStatuses();
    const pairs = await Promise.all(this.explainer.list().map(async ({ id }) => [id, await this.adapter.check(id).catch(() => "unavailable" as const)] as const));
    const next = { ...EMPTY, ...Object.fromEntries(pairs) } as Record<PermissionId, PermissionGrantStatus>;
    this.statuses = Object.freeze(next);
    const revoked = this.explainer.list().map((item) => item.id).filter((id) => prior[id] === "granted" && next[id] !== "granted");
    await this.persistStatuses(next);
    for (const [id, status] of pairs) { try { await this.audit?.({ action: "check", permissionId: id, status }); } catch { /* audit must not block permission review */ } }
    const applicable = this.explainer.list().map((item) => item.id);
    const granted = applicable.filter((id) => next[id] === "granted" || next[id] === "not-applicable").length;
    return Object.freeze({ statuses: this.statuses, granted, total: applicable.length, dismissed: this.dismissed, revoked: Object.freeze(revoked) });
  }

  /** Explicitly invoke an existing request adapter, if one exists for this permission. */
  async request(id: PermissionId): Promise<PermissionGrantStatus> {
    if (!this.explainer.get(id)) throw new Error("PERMISSION_NOT_USED");
    if (!this.adapter.request) return this.adapter.check(id);
    const requested = await this.adapter.request(id);
    // A dialog result is not itself proof of access. Persist only a fresh status
    // read from the platform adapter after the request has completed.
    const result = requested === "not-applicable"
      ? requested
      : await this.adapter.check(id).catch(() => "unavailable" as const);
    this.statuses = Object.freeze({ ...this.statuses, [id]: result });
    await this.persistStatuses(this.statuses);
    try { await this.audit?.({ action: "request", permissionId: id, status: result }); } catch { /* best effort audit */ }
    return result;
  }

  /** Open only an already-existing settings path after explicit user action. */
  async openSettings(id: PermissionId): Promise<boolean> {
    const description = this.explainer.get(id);
    if (!description) throw new Error("PERMISSION_NOT_USED");
    try { await this.audit?.({ action: "settings", permissionId: id, status: this.statuses[id] }); } catch { /* best effort audit */ }
    return this.adapter.openSettings ? this.adapter.openSettings(description.openSettingsAction) : false;
  }

  /** Record a deferral so first-run integration can avoid repeated prompts. */
  async later(): Promise<void> { this.dismissed = true; await this.store.set(DEFERRED_KEY, String(Date.now())); try { await this.audit?.({ action: "defer" }); } catch { /* best effort audit */ } }
  /** Whether the user previously chose to defer; no automatic nag should be shown. */
  async wasDeferred(): Promise<boolean> { return (await this.store.get(DEFERRED_KEY)) !== null; }
  /** Return current in-memory state or a safe empty state. */
  getState(): PermissionOnboardingState { const ids = this.explainer.list().map((item) => item.id); return { statuses: this.statuses, granted: ids.filter((id) => this.statuses[id] === "granted" || this.statuses[id] === "not-applicable").length, total: ids.length, dismissed: this.dismissed, revoked: [] }; }

  private async loadPriorStatuses(): Promise<Readonly<Record<PermissionId, PermissionGrantStatus>>> {
    try {
      const raw = await this.store.get(STATUS_KEY);
      if (!raw) return EMPTY;
      const value: unknown = JSON.parse(raw);
      if (!value || typeof value !== "object") return EMPTY;
      const entries = value as Partial<Record<PermissionId, PermissionGrantStatus>>;
      const safe = { ...EMPTY } as Record<PermissionId, PermissionGrantStatus>;
      for (const id of ALL_IDS) if (["granted", "denied", "manual-required", "unavailable", "not-applicable"].includes(String(entries[id]))) safe[id] = entries[id]!;
      return safe;
    } catch { return EMPTY; }
  }
  private async persistStatuses(value: Readonly<Record<PermissionId, PermissionGrantStatus>>): Promise<void> { try { await this.store.set(STATUS_KEY, JSON.stringify(value)); } catch { /* onboarding state is optional; current UI remains usable */ } }
}
