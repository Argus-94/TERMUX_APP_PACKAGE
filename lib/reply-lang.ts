/**
 * Resolve user-facing reply language and light detection from the last user message.
 * Technical agent protocol stays English/ASCII regardless.
 */
import type { PromptLang } from "./ide-core-prompt";

export function uiLangToPromptLang(language: string | undefined | null): PromptLang {
  if (language === "en" || language === "ru") return language;
  return "uk";
}

/**
 * Prefer the language of the latest user text when it clearly differs from UI.
 * Falls back to UI language.
 */
export function detectReplyLang(userText: string, uiLang: PromptLang): PromptLang {
  const t = String(userText || "").trim();
  if (!t) return uiLang;

  // Cyrillic-heavy
  const cyr = (t.match(/[а-яА-ЯіІїЇєЄґҐёЁ]/g) || []).length;
  const lat = (t.match(/[a-zA-Z]/g) || []).length;

  if (cyr >= 4 && cyr >= lat) {
    // Ukrainian-specific letters
    if (/[іІїЇєЄґҐ]/.test(t)) return "uk";
    // Shared Cyrillic → default Russian for agent/chat reply (most models)
    // unless UI is explicitly Ukrainian and message has typical UK words
    if (
      uiLang === "uk" &&
      /(що|як|будь\s*ласка|будьласка|додаток|прошу|зроби|встанови)/i.test(t)
    ) {
      return "uk";
    }
    return "ru";
  }

  if (lat >= 4 && lat > cyr * 2) return "en";
  return uiLang;
}
