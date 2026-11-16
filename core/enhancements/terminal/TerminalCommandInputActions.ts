import type { TerminalQuickActionId } from "./types";

export type TerminalInputSelection = Readonly<{ start: number; end: number }>;
export type TerminalCommandInputState = Readonly<{
  value: string;
  selection: TerminalInputSelection;
  /** -1 means the user is editing a fresh draft; zero is the newest history entry. */
  historyIndex: number;
  draftBeforeHistory: string;
}>;
export type TerminalCommandInputActionResult = Readonly<{
  supported: boolean;
  state: TerminalCommandInputState;
  reason?: string;
  effect?: "page-up" | "page-down";
}>;

function clampSelection(selection: TerminalInputSelection, valueLength: number): TerminalInputSelection {
  const start = Math.max(0, Math.min(valueLength, Math.floor(selection.start)));
  const end = Math.max(0, Math.min(valueLength, Math.floor(selection.end)));
  return { start: Math.min(start, end), end: Math.max(start, end) };
}

function withValue(state: TerminalCommandInputState, value: string, cursor: number, historyIndex = -1, draftBeforeHistory = value): TerminalCommandInputState {
  const bounded = Math.max(0, Math.min(value.length, cursor));
  return { value, selection: { start: bounded, end: bounded }, historyIndex, draftBeforeHistory };
}

/** Insert plain text at the current command-input selection; this never sends terminal control bytes. */
export function insertTerminalCommandText(state: TerminalCommandInputState, insertedText: string): TerminalCommandInputState {
  const selection = clampSelection(state.selection, state.value.length);
  const value = `${state.value.slice(0, selection.start)}${insertedText}${state.value.slice(selection.end)}`;
  return withValue(state, value, selection.start + insertedText.length);
}

/**
 * Apply safe command-composer actions. Arrow/history and paging actions operate on the app's input/scrollback,
 * not on a shell process. Ctrl, Alt and Kill Process remain unavailable without an interactive host adapter.
 */
export function applyTerminalCommandInputAction(
  action: TerminalQuickActionId,
  state: TerminalCommandInputState,
  history: readonly string[],
): TerminalCommandInputActionResult {
  const selection = clampSelection(state.selection, state.value.length);
  const normalized = { ...state, selection };
  const unsupported = (reason: string): TerminalCommandInputActionResult => ({ supported: false, state: normalized, reason });

  if (action === "ctrl") return unsupported("Ctrl cannot be sent: this command UI has no interactive PTY.");
  if (action === "alt") return unsupported("Alt cannot be sent: this command UI has no interactive PTY.");
  if (action === "kill-process") return unsupported("The one-shot adapter exposes no cancellable process handle; no process was killed.");
  if (action === "page-up") return { supported: true, state: normalized, effect: "page-up" };
  if (action === "page-down") return { supported: true, state: normalized, effect: "page-down" };

  if (action === "escape") return { supported: true, state: withValue(normalized, "", 0) };
  if (action === "tab") return { supported: true, state: insertTerminalCommandText(normalized, "\t") };

  if (action === "arrow-left") {
    const cursor = selection.start === selection.end ? selection.start - 1 : selection.start;
    return { supported: true, state: withValue(normalized, normalized.value, cursor, normalized.historyIndex, normalized.draftBeforeHistory) };
  }
  if (action === "arrow-right") {
    const cursor = selection.start === selection.end ? selection.end + 1 : selection.end;
    return { supported: true, state: withValue(normalized, normalized.value, cursor, normalized.historyIndex, normalized.draftBeforeHistory) };
  }
  if (action === "home") {
    const lineStart = selection.start === 0 ? 0 : normalized.value.lastIndexOf("\n", selection.start - 1) + 1;
    return { supported: true, state: withValue(normalized, normalized.value, lineStart, normalized.historyIndex, normalized.draftBeforeHistory) };
  }
  if (action === "end") {
    const lineEnd = normalized.value.indexOf("\n", selection.end);
    return { supported: true, state: withValue(normalized, normalized.value, lineEnd < 0 ? normalized.value.length : lineEnd, normalized.historyIndex, normalized.draftBeforeHistory) };
  }
  if (action === "arrow-up") {
    if (history.length === 0) return { supported: true, state: normalized };
    const nextIndex = Math.min(normalized.historyIndex + 1, history.length - 1);
    const draft = normalized.historyIndex < 0 ? normalized.value : normalized.draftBeforeHistory;
    return { supported: true, state: withValue(normalized, history[nextIndex] ?? "", (history[nextIndex] ?? "").length, nextIndex, draft) };
  }
  if (action === "arrow-down") {
    if (normalized.historyIndex < 0) return { supported: true, state: normalized };
    if (normalized.historyIndex === 0) return { supported: true, state: withValue(normalized, normalized.draftBeforeHistory, normalized.draftBeforeHistory.length) };
    const nextIndex = normalized.historyIndex - 1;
    const value = history[nextIndex] ?? "";
    return { supported: true, state: withValue(normalized, value, value.length, nextIndex, normalized.draftBeforeHistory) };
  }

  return unsupported("This action is handled by the terminal screen or is unavailable in command mode.");
}

/** Create a clean initial command-input state. */
export function createTerminalCommandInputState(value = ""): TerminalCommandInputState {
  return { value, selection: { start: value.length, end: value.length }, historyIndex: -1, draftBeforeHistory: value };
}
