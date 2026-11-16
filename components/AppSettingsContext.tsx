import { createContext, useContext, ReactNode } from "react";
import { useAppSettings } from "../hooks/useAppSettings";

type AppSettingsContextType = ReturnType<typeof useAppSettings>;

const AppSettingsContext = createContext<AppSettingsContextType | null>(null);

// Раньше useAppSettings() вызывался напрямую внутри SettingsScreen — состояние
// (режим local/online, скачанность модели, API-ключ и т.д.) существовало
// только там и терялось при переходе на другой экран. Экран чата отдельно
// подглядывал за singleton'ом localModelEngine, но не знал ни про режим
// online, ни про ручные параметры модели. Провайдер держит одно общее
// состояние настроек на всё приложение — так же, как LLMProvider делает
// это для чатов (см. components/LLMContext.tsx).
export function AppSettingsProvider({ children }: { children: ReactNode }) {
  const settings = useAppSettings();
  return <AppSettingsContext.Provider value={settings}>{children}</AppSettingsContext.Provider>;
}

export function useAppSettingsContext() {
  const ctx = useContext(AppSettingsContext);
  if (!ctx) throw new Error("useAppSettingsContext must be used within AppSettingsProvider");
  return ctx;
}
