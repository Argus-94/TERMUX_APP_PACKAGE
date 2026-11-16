import type { TerminalQuickAction, TerminalQuickActionId, TerminalQuickActionResult } from "./types";

const ACTIONS: readonly TerminalQuickAction[] = [
  { id: "ctrl", label: "Ctrl", kind: "key" }, { id: "alt", label: "Alt", kind: "key" },
  { id: "escape", label: "Esc", kind: "key" }, { id: "tab", label: "Tab", kind: "key" },
  { id: "arrow-up", label: "↑", kind: "key" }, { id: "arrow-down", label: "↓", kind: "key" },
  { id: "arrow-left", label: "←", kind: "key" }, { id: "arrow-right", label: "→", kind: "key" },
  { id: "home", label: "Home", kind: "key" }, { id: "end", label: "End", kind: "key" },
  { id: "page-up", label: "PgUp", kind: "key" }, { id: "page-down", label: "PgDn", kind: "key" },
  { id: "clear", label: "Clear", kind: "command" }, { id: "copy-all", label: "Copy All", kind: "command" },
  { id: "paste", label: "Paste", kind: "command" }, { id: "new-session", label: "New Session", kind: "command" },
  { id: "kill-process", label: "Kill Process", kind: "command" },
];

export type TerminalQuickActionHandler = (action: TerminalQuickActionId) => Promise<TerminalQuickActionResult> | TerminalQuickActionResult;

/** Allowlisted quick-action dispatcher; key injection is never assumed from a one-shot shell. */
export class TerminalQuickActions {
  private visible = new Set<TerminalQuickActionId>(ACTIONS.map((action) => action.id));

  constructor(private readonly handler: TerminalQuickActionHandler) {}

  /** List only known actions currently enabled by the user. */
  list(): readonly TerminalQuickAction[] { return ACTIONS.filter((action) => this.visible.has(action.id)); }
  /** Return all documented actions, including currently hidden choices. */
  all(): readonly TerminalQuickAction[] { return ACTIONS; }

  /** Customize visibility; unknown action IDs are rejected rather than executed. */
  setVisible(ids: readonly string[]): readonly TerminalQuickActionId[] {
    const allowed = new Set(ACTIONS.map((action) => action.id));
    if (ids.some((id) => !allowed.has(id as TerminalQuickActionId))) throw new Error("TERMINAL_ACTION_NOT_ALLOWLISTED");
    this.visible = new Set(ids as TerminalQuickActionId[]);
    return [...this.visible];
  }

  /** Dispatch one visible allowlisted action through the injected UI/session adapter. */
  async execute(id: string): Promise<TerminalQuickActionResult> {
    if (!ACTIONS.some((action) => action.id === id) || !this.visible.has(id as TerminalQuickActionId)) {
      return { ok: false, supported: false, reason: "Action is not allowlisted or currently visible." };
    }
    return this.handler(id as TerminalQuickActionId);
  }
}
