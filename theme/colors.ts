export type ThemeMode = "dark" | "light";

/** Shared brand Gold accents (deep Gold keeps contrast on light surfaces). */
export const GOLD = "#C9A227";
export const GOLD_LIGHT = "#E7D28A";
export const GOLD_DEEP = "#8B6914";

const goldTint = (hex: string, alpha: number): string => {
  const channels = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));
  return `rgba(${channels[0]}, ${channels[1]}, ${channels[2]}, ${alpha})`;
};

export type AppColors = {
  background: string;
  surface: string;
  surfaceRaised: string;
  ink: string;
  inkBright: string;
  muted: string;
  accent: string;
  accentDim: string;
  accentGlow: string;
  info: string;
  warning: string;
  warningDim: string;
  onWarning: string;
  danger: string;
  dangerDim: string;
  line: string;
  lineSubtle: string;
  success: string;
  inputBg: string;
  chipBg: string;
  chipText: string;
  headerBg: string;
  drawerBg: string;
  drawerActiveBg: string;
  overlay: string;
  footerMuted: string;
  /** Text/icon on filled accent buttons (Unzip --on-accent) */
  onAccent: string;
  /** Primary container (Unzip --pc) */
  primaryContainer: string;
  onPrimaryContainer: string;
  /** Text on danger fill (Unzip --on-danger) */
  onDanger: string;
};

/** UnzipGit dark palette (Material-ish cool gray + soft blue accent) */
export const darkColors: AppColors = {
  background: "#101418",
  surface: "#181C20",
  surfaceRaised: "#1F242A",
  ink: "#E2E2E6",
  inkBright: "#F0F1F3",
  muted: "#9AA3AC",
  accent: "#9FCBFF",
  accentDim: "rgba(159, 203, 255, 0.14)",
  accentGlow: "rgba(159, 203, 255, 0.26)",
  info: "#9FCBFF",
  warning: GOLD,
  warningDim: goldTint(GOLD, 0.14),
  onWarning: "#1D1710",
  danger: "#FFB4AB",
  dangerDim: "rgba(255, 180, 171, 0.14)",
  line: "#3A4148",
  lineSubtle: "#2A3036",
  success: "#8FD69A",
  inputBg: "#101418",
  chipBg: "#1F242A",
  chipText: "#E2E2E6",
  headerBg: "#181C20",
  drawerBg: "#101418",
  drawerActiveBg: "rgba(25, 74, 114, 0.55)",
  overlay: "rgba(0, 0, 0, 0.58)",
  footerMuted: "#9AA3AC",
  onAccent: "#00325A",
  primaryContainer: "#194A72",
  onPrimaryContainer: "#D1E4FF",
  onDanger: "#690005",
};

export const lightColors: AppColors = {
  background: "#F4F6F8",
  surface: "#FFFFFF",
  surfaceRaised: "#EEF1F4",
  ink: "#3A4148",
  inkBright: "#101418",
  muted: "#5C6770",
  accent: "#194A72",
  accentDim: "rgba(25, 74, 114, 0.10)",
  accentGlow: "rgba(25, 74, 114, 0.18)",
  info: "#194A72",
  warning: GOLD_DEEP,
  warningDim: goldTint(GOLD_DEEP, 0.10),
  onWarning: "#FFFFFF",
  danger: "#B3261E",
  dangerDim: "rgba(179, 38, 30, 0.10)",
  line: "#D0D5DA",
  lineSubtle: "#E4E7EA",
  success: "#2E7D46",
  inputBg: "#FFFFFF",
  chipBg: "#EEF1F4",
  chipText: "#101418",
  headerBg: "#FFFFFF",
  drawerBg: "#FFFFFF",
  drawerActiveBg: "rgba(25, 74, 114, 0.10)",
  overlay: "rgba(16, 20, 24, 0.40)",
  footerMuted: "#5C6770",
  onAccent: "#FFFFFF",
  primaryContainer: "#D1E4FF",
  onPrimaryContainer: "#00325A",
  onDanger: "#FFFFFF",
};

/** @deprecated use useTheme().colors */
export const colors = darkColors;
