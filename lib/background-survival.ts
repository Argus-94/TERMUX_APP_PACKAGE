/**
 * Запрос исключений, чтобы Android реже убивал AI Builder во время
 * долгих задач (сборка / агент / Termux).
 *
 * 1) Игнор оптимизации батареи (REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)
 * 2) «Неограниченные данные» / снятие лимита фоновых данных
 * 3) Fallback в настройки приложения
 */

import { Linking, NativeModules, Platform } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { persistentLogger } from "./persistent-logger";
import { errorMessage } from "./error-utils";

const ASKED_KEY = "aibuilder.survival.asked.v1";

function getPackageName(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Constants = require("expo-constants") as {
      default?: { expoConfig?: { android?: { package?: string } } };
      expoConfig?: { android?: { package?: string } };
    };
    const c = (Constants as { default?: typeof Constants }).default || Constants;
    const pkg = c?.expoConfig?.android?.package;
    if (pkg) return pkg;
  } catch {
    /* optional */
  }
  return "com.karat.aibuilder";
}

/** Открыть Android Intent. canOpenURL(intent://) часто false — пробуем openURL напрямую. */
async function tryOpenIntentUrls(urls: string[]): Promise<boolean> {
  for (const url of urls) {
    try {
      await Linking.openURL(url);
      return true;
    } catch {
      /* next */
    }
  }
  return false;
}

/** Системный диалог «без ограничений батареи» для нашего пакета. */
export async function getIgnoreBatteryOptimizationsStatus(): Promise<boolean | null> {
  if (Platform.OS !== "android" || Number(Platform.Version) < 23) return null;
  try {
    const native = NativeModules.AibDeviceWatchdog as { isIgnoringBatteryOptimizations?: () => Promise<boolean> } | undefined;
    if (!native?.isIgnoringBatteryOptimizations) return null;
    const value = await native.isIgnoringBatteryOptimizations();
    return typeof value === "boolean" ? value : null;
  } catch { return null; }
}

export async function requestIgnoreBatteryOptimizations(): Promise<boolean> {
  if (Platform.OS !== "android") return true;
  if (await getIgnoreBatteryOptimizationsStatus() === true) return true;
  const pkg = getPackageName();
  try {
    const L = Linking as typeof Linking & {
      sendIntent?: (
        action: string,
        extras?: Array<{ key: string; value: string | number | boolean }>,
      ) => Promise<void>;
    };
    if (typeof L.sendIntent === "function") {
      try {
        await L.sendIntent("android.settings.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS");
        persistentLogger.add("info", "Survival", "battery sendIntent ok");
        return true;
      } catch {
        /* fall through */
      }
    }

    const ok = await tryOpenIntentUrls([
      `intent:#Intent;action=android.settings.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS;data=package:${pkg};end`,
      `intent://package/${pkg}#Intent;action=android.settings.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS;end`,
      `intent:#Intent;action=android.settings.IGNORE_BATTERY_OPTIMIZATION_SETTINGS;end`,
    ]);
    if (ok) {
      persistentLogger.add("info", "Survival", "battery intent opened");
      return true;
    }
    await Linking.openSettings();
    persistentLogger.add("info", "Survival", "opened app settings (battery fallback)");
    return true;
  } catch (e: unknown) {
    persistentLogger.add("warn", "Survival", `battery: ${errorMessage(e)}`);
    try {
      await Linking.openSettings();
    } catch {
      /* ignore */
    }
    return false;
  }
}

/** «Неограниченный интернет» / снятие ограничений фоновых данных. */
export async function requestUnrestrictedData(): Promise<boolean> {
  if (Platform.OS !== "android") return true;
  const pkg = getPackageName();
  try {
    const ok = await tryOpenIntentUrls([
      `intent:#Intent;action=android.settings.IGNORE_BACKGROUND_DATA_RESTRICTIONS_SETTINGS;data=package:${pkg};end`,
      `intent:#Intent;action=android.settings.VIEW_IGNORE_BACKGROUND_DATA_RESTRICTIONS_SETTINGS;data=package:${pkg};end`,
      `intent:#Intent;action=android.settings.APPLICATION_DETAILS_SETTINGS;data=package:${pkg};end`,
    ]);
    if (ok) {
      persistentLogger.add("info", "Survival", "unrestricted data / app details opened");
      return true;
    }
    await Linking.openSettings();
    return true;
  } catch (e: unknown) {
    persistentLogger.add("warn", "Survival", `data: ${errorMessage(e)}`);
    return false;
  }
}

/** Explicitly opens the optional battery flow at most once; never opens on cold start or chains a second settings screen. */
export async function ensureBackgroundSurvival(opts?: { force?: boolean }): Promise<void> {
  if (Platform.OS !== "android") return;
  try {
    if (!opts?.force) {
      const asked = await AsyncStorage.getItem(ASKED_KEY);
      if (asked === "1") return;
    }
    await AsyncStorage.setItem(ASKED_KEY, "1");
    await requestIgnoreBatteryOptimizations();
    persistentLogger.add("info", "Survival", "battery settings action completed; background-data settings were not opened automatically");
  } catch (e: unknown) {
    persistentLogger.add("warn", "Survival", errorMessage(e));
  }
}

export async function openAppDetailsSettings(): Promise<void> {
  if (Platform.OS !== "android") {
    await Linking.openSettings();
    return;
  }
  const pkg = getPackageName();
  const ok = await tryOpenIntentUrls([
    `intent:#Intent;action=android.settings.APPLICATION_DETAILS_SETTINGS;data=package:${pkg};end`,
  ]);
  if (!ok) await Linking.openSettings();
}

/** A4: count OEM-ish build kills; soft reminder only (never auto-open settings). */
const KILL_COUNT_KEY = "aibuilder.survival.buildKillCount.v1";
const REMIND_SHOWN_KEY = "aibuilder.survival.remindShown.v1";

export async function notePossibleBuildKill(reason?: string): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(KILL_COUNT_KEY);
    const n = Math.min(99, (Number(raw) || 0) + 1);
    await AsyncStorage.setItem(KILL_COUNT_KEY, String(n));
    persistentLogger.add("info", "Survival", `buildKillCount=${n}${reason ? ` (${reason})` : ""}`);
  } catch {
    /* ignore */
  }
}

/**
 * After ≥2 recorded kills, return a one-time soft reminder string.
 * Does NOT open battery settings (plan: no cold-start / no auto redirect).
 */
export async function maybeSurvivalReminder(
  language: "ru" | "uk" | "en" = "ru",
): Promise<string | null> {
  try {
    const n = Number((await AsyncStorage.getItem(KILL_COUNT_KEY)) || 0);
    if (n < 2) return null;
    const shown = await AsyncStorage.getItem(REMIND_SHOWN_KEY);
    if (shown === "1") return null;
    await AsyncStorage.setItem(REMIND_SHOWN_KEY, "1");
    const msg = {
      ru: "Сборка/агент, похоже, убивались системой ≥2 раз. Откройте Настройки → «Фон и батарея» → выживание (вручную).",
      uk: "Збірка/агент, схоже, вбивалися системою ≥2 рази. Відкрийте Налаштування → «Фон і батарея» вручну.",
      en: "Build/agent appears killed by the system (≥2 times). Open Settings → Background & battery (manual).",
    }[language];
    persistentLogger.add("info", "Survival", "soft reminder issued (no auto settings)");
    return msg;
  } catch {
    return null;
  }
}

/** Test/helper: read kill count */
export async function getBuildKillCount(): Promise<number> {
  try {
    return Number((await AsyncStorage.getItem(KILL_COUNT_KEY)) || 0);
  } catch {
    return 0;
  }
}
