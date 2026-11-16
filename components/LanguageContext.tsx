import { createContext, useContext, ReactNode, useState, useEffect, useCallback } from "react";
import { View, NativeModules, Platform } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { AppLanguage, t as translate, TranslationKey } from "../lib/i18n";
import { persistAsyncStorageItem } from "../lib/persistence";

const LANGUAGE_STORAGE_KEY = "aibuilder.language.v1";

type LanguageContextType = {
  language: AppLanguage;
  setLanguage: (lang: AppLanguage) => void;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
};

const LanguageContext = createContext<LanguageContextType | null>(null);

/** Detect system language and map to one of the app languages (uk/ru/en). Fallback: en. */
function detectSystemLanguage(): AppLanguage {
  try {
    let locale = "";
    if (Platform.OS === "android" || Platform.OS === "ios") {
      const settings = NativeModules.SettingsManager?.settings;
      const locales = NativeModules.I18nManager?.localeIdentifier
        || settings?.AppleLocale
        || settings?.AppleLanguages?.[0]
        || (NativeModules.I18nManager as any)?.locale
        || "";
      locale = String(locales || "");
    }
    if (!locale) {
      try {
        locale = Intl.DateTimeFormat().resolvedOptions().locale || "";
      } catch {
        locale = "";
      }
    }
    const lower = locale.toLowerCase().replace("_", "-");
    if (lower.startsWith("uk") || lower.startsWith("ua")) return "uk";
    if (lower.startsWith("ru")) return "ru";
    if (lower.startsWith("en")) return "en";
    if (lower.includes("ukrain")) return "uk";
    if (lower.includes("russ")) return "ru";
  } catch {
    // ignore
  }
  return "en";
}

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState<AppLanguage>("en");
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(LANGUAGE_STORAGE_KEY);
        if (!cancelled && (raw === "uk" || raw === "ru" || raw === "en")) {
          setLanguageState(raw);
        } else if (!cancelled) {
          const sys = detectSystemLanguage();
          setLanguageState(sys);
          persistAsyncStorageItem(LANGUAGE_STORAGE_KEY, sys);
        }
      } catch {
        // keep default (en)
      } finally {
        if (!cancelled) setHydrated(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const setLanguage = useCallback((lang: AppLanguage) => {
    setLanguageState(lang);
    persistAsyncStorageItem(LANGUAGE_STORAGE_KEY, lang);
  }, []);

  const t = useCallback(
    (key: TranslationKey, params?: Record<string, string | number>) =>
      translate(language, key, params),
    [language]
  );

  if (!hydrated) {
    return (
      <View style={{ flex: 1, backgroundColor: "#101418" }} />
    );
  }

  return (
    <LanguageContext.Provider value={{ language, setLanguage, t }}>
      {children}
    </LanguageContext.Provider>
  );
}

export function useLanguage() {
  const ctx = useContext(LanguageContext);
  if (!ctx) throw new Error("useLanguage must be used within LanguageProvider");
  return ctx;
}
