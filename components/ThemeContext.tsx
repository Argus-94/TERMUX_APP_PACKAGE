import { createContext, useContext, ReactNode, useMemo } from "react";
import { darkColors, type AppColors, type ThemeMode } from "../theme/colors";

type ThemeContextType = {
  preference: "dark";
  mode: ThemeMode;
  colors: AppColors;
  isDark: boolean;
  setPreference: (p: "dark") => void;
  toggle: () => void;
};

const ThemeContext = createContext<ThemeContextType | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const value = useMemo(
    () => ({
      preference: "dark" as const,
      mode: "dark" as ThemeMode,
      colors: darkColors,
      isDark: true,
      setPreference: (_p: "dark") => {},
      toggle: () => {},
    }),
    []
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}
