import type { AnsiPalette, TerminalPreferenceStore, TerminalThemeDefinition } from "./types";
import { TerminalPreferenceError } from "./types";
import { GOLD, GOLD_DEEP, GOLD_LIGHT } from "../../../theme/colors";

const palette = (colors: readonly string[]): AnsiPalette => {
  if (colors.length !== 16) throw new Error("TERMINAL_ANSI_PALETTE_INVALID");
  return colors as unknown as AnsiPalette;
};

/** Original palettes; ANSI ordering is standard 0–7 followed by bright 8–15. */
const THEMES: readonly TerminalThemeDefinition[] = [
  { id: "dark", name: "Dark", background: "#111318", foreground: "#E6E8EF", cursor: "#7DD3FC", selection: "#334155", ansi: palette(["#20232B", "#F87171", "#4ADE80", GOLD, "#60A5FA", "#C084FC", "#22D3EE", "#E5E7EB", "#64748B", "#FCA5A5", "#86EFAC", GOLD_LIGHT, "#93C5FD", "#D8B4FE", "#67E8F9", "#FFFFFF"]) },
  { id: "light", name: "Light", background: "#FAFAF9", foreground: "#1C1917", cursor: "#2563EB", selection: "#BFDBFE", ansi: palette(["#44403C", "#B91C1C", "#15803D", GOLD_DEEP, "#1D4ED8", "#7E22CE", "#0E7490", "#E7E5E4", "#78716C", "#DC2626", "#16A34A", GOLD_DEEP, "#2563EB", "#9333EA", "#0891B2", "#FFFFFF"]) },
  { id: "dracula", name: "Dracula", background: "#282A36", foreground: "#F8F8F2", cursor: "#F8F8F2", selection: "#44475A", ansi: palette(["#21222C", "#FF5555", "#50FA7B", GOLD, "#BD93F9", "#FF79C6", "#8BE9FD", "#F8F8F2", "#6272A4", "#FF6E6E", "#69FF94", GOLD_LIGHT, "#D6ACFF", "#FF92DF", "#A4FFFF", "#FFFFFF"]) },
  { id: "nord", name: "Nord", background: "#2E3440", foreground: "#D8DEE9", cursor: "#88C0D0", selection: "#434C5E", ansi: palette(["#3B4252", "#BF616A", "#A3BE8C", GOLD, "#81A1C1", "#B48EAD", "#88C0D0", "#E5E9F0", "#4C566A", "#BF616A", "#A3BE8C", GOLD_LIGHT, "#81A1C1", "#B48EAD", "#8FBCBB", "#ECEFF4"]) },
  { id: "solarized-dark", name: "Solarized Dark", background: "#002B36", foreground: "#839496", cursor: "#93A1A1", selection: "#073642", ansi: palette(["#073642", "#DC322F", "#859900", GOLD, "#268BD2", "#D33682", "#2AA198", "#EEE8D5", "#002B36", "#CB4B16", "#586E75", "#657B83", "#839496", "#6C71C4", "#93A1A1", "#FDF6E3"]) },
  { id: "solarized-light", name: "Solarized Light", background: "#FDF6E3", foreground: "#586E75", cursor: "#657B83", selection: "#EEE8D5", ansi: palette(["#073642", "#DC322F", "#859900", GOLD_DEEP, "#268BD2", "#D33682", "#2AA198", "#EEE8D5", "#002B36", "#CB4B16", "#586E75", "#657B83", "#839496", "#6C71C4", "#93A1A1", "#FDF6E3"]) },
  { id: "gruvbox-dark", name: "Gruvbox Dark", background: "#282828", foreground: "#EBDBB2", cursor: "#FE8019", selection: "#504945", ansi: palette(["#3C3836", "#CC241D", "#98971A", GOLD, "#458588", "#B16286", "#689D6A", "#A89984", "#928374", "#FB4934", "#B8BB26", GOLD_LIGHT, "#83A598", "#D3869B", "#8EC07C", "#EBDBB2"]) },
  { id: "catppuccin-mocha", name: "Catppuccin Mocha", background: "#1E1E2E", foreground: "#CDD6F4", cursor: "#F5E0DC", selection: "#45475A", ansi: palette(["#45475A", "#F38BA8", "#A6E3A1", GOLD, "#89B4FA", "#F5C2E7", "#94E2D5", "#BAC2DE", "#585B70", "#F38BA8", "#A6E3A1", GOLD_LIGHT, "#89B4FA", "#F5C2E7", "#94E2D5", "#A6ADC8"]) },
  { id: "tokyo-night", name: "Tokyo Night", background: "#1A1B26", foreground: "#C0CAF5", cursor: "#7AA2F7", selection: "#292E42", ansi: palette(["#32344A", "#F7768E", "#9ECE6A", GOLD, "#7AA2F7", "#BB9AF7", "#7DCFFF", "#A9B1D6", "#444B6A", "#F7768E", "#9ECE6A", GOLD_LIGHT, "#7AA2F7", "#BB9AF7", "#7DCFFF", "#C0CAF5"]) },
  { id: "one-dark", name: "One Dark", background: "#282C34", foreground: "#ABB2BF", cursor: "#528BFF", selection: "#3E4451", ansi: palette(["#5C6370", "#E06C75", "#98C379", GOLD, "#61AFEF", "#C678DD", "#56B6C2", "#ABB2BF", "#4B5263", "#E06C75", "#98C379", GOLD_LIGHT, "#61AFEF", "#C678DD", "#56B6C2", "#FFFFFF"]) },
  { id: "monokai", name: "Monokai", background: "#272822", foreground: "#F8F8F2", cursor: "#F92672", selection: "#49483E", ansi: palette(["#3E3D32", "#F92672", "#A6E22E", GOLD, "#66D9EF", "#AE81FF", "#A1EFE4", "#F8F8F2", "#75715E", "#FF669D", "#BEED5F", GOLD_LIGHT, "#66D9EF", "#B294FF", "#A1EFE4", "#F9F8F5"]) },
  { id: "ai-midnight", name: "AI Builder Midnight", background: "#101827", foreground: "#DCE8F5", cursor: "#38BDF8", selection: "#203B58", ansi: palette(["#253247", "#FB7185", "#34D399", GOLD, "#38BDF8", "#A78BFA", "#2DD4BF", "#DCE8F5", "#52647B", "#FDA4AF", "#6EE7B7", GOLD_LIGHT, "#7DD3FC", "#C4B5FD", "#5EEAD4", "#FFFFFF"]) },
  { id: "ai-forest", name: "AI Builder Forest", background: "#101A17", foreground: "#D7E8DC", cursor: "#86EFAC", selection: "#254236", ansi: palette(["#26372D", "#F87171", "#4ADE80", GOLD, "#60A5FA", "#C084FC", "#2DD4BF", "#D7E8DC", "#64766A", "#FCA5A5", "#86EFAC", GOLD_LIGHT, "#93C5FD", "#D8B4FE", "#5EEAD4", "#FFFFFF"]) },
  { id: "ai-amber", name: "AI Builder Gold", background: "#1D1710", foreground: "#F5E6CF", cursor: GOLD_LIGHT, selection: "#49331F", ansi: palette(["#3A2B1C", "#F87171", "#A3E635", GOLD, "#7DD3FC", "#D8B4FE", "#5EEAD4", "#F5E6CF", "#75624C", "#FCA5A5", "#BEF264", GOLD_LIGHT, "#BAE6FD", "#E9D5FF", "#99F6E4", "#FFFFFF"]) },
  { id: "ai-contrast", name: "AI Builder High Contrast", background: "#000000", foreground: "#FFFFFF", cursor: GOLD, selection: "#363636", ansi: palette(["#111111", "#FF3333", "#00FF66", GOLD, "#3399FF", "#FF55FF", "#00FFFF", "#EEEEEE", "#777777", "#FF7777", "#77FF99", GOLD_LIGHT, "#77BBFF", "#FF99FF", "#77FFFF", "#FFFFFF"]) },
];

const STORAGE_KEY = "aib.terminal.theme.v1";

/** Offline-first theme catalog with validated, best-effort persistence. */
export class TerminalTheme {
  private activeId = "dark";
  private loaded = false;

  constructor(private readonly store?: TerminalPreferenceStore) {}

  /** Return the immutable built-in theme catalog. */
  listThemes(): readonly TerminalThemeDefinition[] { return THEMES; }

  /** Return a known theme, or undefined for an unknown ID. */
  getTheme(id: string): TerminalThemeDefinition | undefined { return THEMES.find((theme) => theme.id === id); }

  /** Persist an active theme; invalid IDs fail closed. */
  async setActiveTheme(id: string): Promise<TerminalThemeDefinition> {
    const theme = this.getTheme(id);
    if (!theme) throw new TerminalPreferenceError("INVALID_THEME", "Unknown terminal theme.");
    try { await this.store?.set(STORAGE_KEY, id); }
    catch { throw new TerminalPreferenceError("STORE_FAILED", "Terminal theme could not be saved."); }
    this.activeId = id;
    this.loaded = true;
    return theme;
  }

  /** Read the persisted theme once; invalid/corrupt values safely fall back to Dark. */
  async getActiveTheme(): Promise<TerminalThemeDefinition> {
    if (!this.loaded) {
      this.loaded = true;
      try {
        const saved = await this.store?.get(STORAGE_KEY);
        if (saved && this.getTheme(saved)) this.activeId = saved;
      } catch { /* visual preferences are optional; retain deterministic default */ }
    }
    return this.getTheme(this.activeId) ?? THEMES[0]!;
  }
}
