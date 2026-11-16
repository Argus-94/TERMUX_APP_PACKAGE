/**
 * Appearance preferences (antigravity-inspired Desktop / Mobile viewport mode).
 * Desktop mode is intended for tablets, physical keyboards, and Samsung DeX.
 */

import AsyncStorage from "@react-native-async-storage/async-storage";
import type { ViewStyle } from "react-native";

const STORAGE_KEY = "aibuilder.appearance.desktopMode.v1";

let desktopMode = false;

export function isDesktopMode(): boolean {
  return desktopMode;
}

export function setDesktopMode(enabled: boolean): void {
  desktopMode = !!enabled;
}

export async function loadDesktopMode(): Promise<boolean> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    desktopMode = raw === "1" || raw === "true";
    return desktopMode;
  } catch {
    return desktopMode;
  }
}

export async function saveDesktopMode(enabled: boolean): Promise<boolean> {
  desktopMode = !!enabled;
  try {
    await AsyncStorage.setItem(STORAGE_KEY, desktopMode ? "1" : "0");
  } catch {
    // non-fatal
  }
  return desktopMode;
}

export const DESKTOP_MODE_STORAGE_KEY = STORAGE_KEY;

export function desktopModeLabel(enabled: boolean, language: "ru" | "uk" | "en" = "en"): string {
  if (enabled) {
    return { ru: "Desktop Mode", uk: "Desktop Mode", en: "Desktop Mode" }[language];
  }
  return { ru: "Mobile Mode", uk: "Mobile Mode", en: "Mobile Mode" }[language];
}

/** Optional User-Agent hint when desktop mode is on (for embedded WebViews). */
export function desktopUserAgentSuffix(): string {
  return desktopMode
    ? " AIBuilderDesktop/1.0 (Tablet; DeX; wide-viewport)"
    : " AIBuilderMobile/1.0 (Touch)";
}

/** Max content width in desktop mode (readable wide layout). */
export const DESKTOP_CONTENT_MAX_WIDTH = 920;

/**
 * Content container style for ScrollViews / screens.
 * Mobile: normal padding. Desktop: centered column with max width.
 */
export function getDesktopContentStyle(
  extra?: ViewStyle,
  options?: { padding?: number; paddingBottom?: number; gap?: number },
): ViewStyle {
  const padding = options?.padding ?? 16;
  const gap = options?.gap;
  const base: ViewStyle = {
    padding,
    ...(options?.paddingBottom != null ? { paddingBottom: options.paddingBottom } : {}),
    ...(gap != null ? { gap } : {}),
    ...extra,
  };
  if (!desktopMode) return base;
  return {
    ...base,
    maxWidth: DESKTOP_CONTENT_MAX_WIDTH,
    width: "100%",
    alignSelf: "center",
    paddingHorizontal: Math.max(padding, 24),
  };
}

/** Card/grid helpers for two-column-ish desktop feel without hard grid dependency. */
export function getDesktopCardStyle(extra?: ViewStyle): ViewStyle {
  if (!desktopMode) return { ...extra };
  return {
    ...extra,
    // Slightly tighter radius and more horizontal breathing room feel
    borderRadius: 14,
  };
}
