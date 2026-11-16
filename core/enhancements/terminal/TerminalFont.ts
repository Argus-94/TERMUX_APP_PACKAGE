import type { TerminalFontFamily, TerminalFontPreferences, TerminalPreferenceStore } from "./types";
import { TerminalPreferenceError } from "./types";

export const TERMINAL_FONT_FAMILIES: readonly TerminalFontFamily[] = ["monospace", "sans-serif-monospace", "Roboto Mono", "Courier New"];
export const DEFAULT_TERMINAL_FONT: TerminalFontPreferences = Object.freeze({ family: "monospace", size: 14, lineHeight: 1.35, letterSpacing: 0 });
const STORAGE_KEY = "aib.terminal.font.v1";
const isFontFamily = (value: unknown): value is TerminalFontFamily => typeof value === "string" && TERMINAL_FONT_FAMILIES.includes(value as TerminalFontFamily);

/** Validated terminal typography preferences; bundled fonts are not assumed. */
export class TerminalFont {
  private value: TerminalFontPreferences = DEFAULT_TERMINAL_FONT;
  private loaded = false;
  private loadPromise?: Promise<void>;

  constructor(private readonly store?: TerminalPreferenceStore) {}

  /** List system/generic mono families without claiming bundled font assets. */
  listFamilies(): readonly TerminalFontFamily[] { return TERMINAL_FONT_FAMILIES; }

  /** Load saved settings, ignoring invalid or obsolete values. */
  async getPreferences(): Promise<TerminalFontPreferences> {
    if (!this.loaded) {
      this.loadPromise ??= (async () => {
        try {
          const raw = await this.store?.get(STORAGE_KEY);
          if (raw) {
            const parsed: unknown = JSON.parse(raw);
            if (parsed && typeof parsed === "object") {
              const candidate = parsed as Partial<TerminalFontPreferences>;
              this.value = {
                family: isFontFamily(candidate.family) ? candidate.family : DEFAULT_TERMINAL_FONT.family,
                size: typeof candidate.size === "number" && Number.isInteger(candidate.size) && candidate.size >= 12 && candidate.size <= 22 ? candidate.size : DEFAULT_TERMINAL_FONT.size,
                lineHeight: typeof candidate.lineHeight === "number" && candidate.lineHeight >= 1 && candidate.lineHeight <= 2 ? candidate.lineHeight : DEFAULT_TERMINAL_FONT.lineHeight,
                letterSpacing: typeof candidate.letterSpacing === "number" && candidate.letterSpacing >= -1 && candidate.letterSpacing <= 2 ? candidate.letterSpacing : DEFAULT_TERMINAL_FONT.letterSpacing,
              };
            }
          }
        } catch { /* corrupt storage falls back to defaults */ }
        finally { this.loaded = true; }
      })();
      await this.loadPromise;
    }
    return this.value;
  }

  /** Save a valid family, integer size, and optional typography metrics. */
  async setPreferences(next: Partial<TerminalFontPreferences>): Promise<TerminalFontPreferences> {
    const current = await this.getPreferences();
    if (next.family !== undefined && !isFontFamily(next.family)) throw new TerminalPreferenceError("INVALID_FONT", "Unsupported terminal font family.");
    const size = next.size ?? current.size;
    if (!Number.isInteger(size) || size < 12 || size > 22) throw new TerminalPreferenceError("INVALID_FONT_SIZE", "Terminal font size must be an integer from 12 through 22.");
    const lineHeight = next.lineHeight ?? current.lineHeight;
    const letterSpacing = next.letterSpacing ?? current.letterSpacing;
    if (!Number.isFinite(lineHeight) || lineHeight < 1 || lineHeight > 2 || !Number.isFinite(letterSpacing) || letterSpacing < -1 || letterSpacing > 2) {
      throw new TerminalPreferenceError("INVALID_FONT", "Terminal line height or letter spacing is outside the supported range.");
    }
    const updated = Object.freeze({ family: next.family ?? current.family, size, lineHeight, letterSpacing });
    try { await this.store?.set(STORAGE_KEY, JSON.stringify(updated)); }
    catch { throw new TerminalPreferenceError("STORE_FAILED", "Terminal font preferences could not be saved."); }
    this.value = updated;
    this.loaded = true;
    return this.value;
  }
}
