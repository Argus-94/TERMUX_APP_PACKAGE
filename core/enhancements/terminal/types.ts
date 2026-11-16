/** Strict contracts for terminal presentation, preferences, sessions, and quick actions. */
export type AnsiPalette = readonly [string, string, string, string, string, string, string, string, string, string, string, string, string, string, string, string];

export type TerminalThemeDefinition = Readonly<{
  id: string;
  name: string;
  background: string;
  foreground: string;
  cursor: string;
  selection: string;
  ansi: AnsiPalette;
}>;

export type TerminalPreferenceStore = Readonly<{
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}>;

export type TerminalFontFamily = "monospace" | "sans-serif-monospace" | "Roboto Mono" | "Courier New";
export type TerminalFontPreferences = Readonly<{
  family: TerminalFontFamily;
  size: number;
  lineHeight: number;
  letterSpacing: number;
}>;

export type TerminalSessionState = "attached" | "saved" | "unavailable";
export type TerminalSessionSnapshot = Readonly<{
  id: string;
  projectId: string;
  projectRoot?: string;
  cwd: string;
  env: Readonly<Record<string, string>>;
  scrollback: string;
  state: TerminalSessionState;
  updatedAt: number;
}>;

export type TerminalSessionHandle = Readonly<{
  id: string;
  cwd: string;
  env?: Readonly<Record<string, string>>;
}>;

export type TerminalQuickActionId =
  | "ctrl" | "alt" | "escape" | "tab" | "arrow-up" | "arrow-down" | "arrow-left" | "arrow-right"
  | "home" | "end" | "page-up" | "page-down" | "clear" | "copy-all" | "paste" | "new-session" | "kill-process";

export type TerminalQuickAction = Readonly<{ id: TerminalQuickActionId; label: string; kind: "key" | "command" }>;
export type TerminalQuickActionResult = Readonly<{ ok: boolean; supported: boolean; reason?: string }>;

export class TerminalPreferenceError extends Error {
  constructor(readonly code: "INVALID_THEME" | "INVALID_FONT" | "INVALID_FONT_SIZE" | "STORE_FAILED", message: string) {
    super(message);
    this.name = "TerminalPreferenceError";
  }
}
