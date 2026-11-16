import { View, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useTheme } from "./ThemeContext";
import type { AgentShellBackend } from "../lib/agent-shell-backend";
import { useAppSettingsContext } from "./AppSettingsContext";

const MODES: ReadonlyArray<{
  id: AgentShellBackend;
  icon: keyof typeof Ionicons.glyphMap;
  a11y: string;
}> = [
  { id: "termux", icon: "terminal-outline", a11y: "Termux" },
  { id: "ubuntu-proot", icon: "planet-outline", a11y: "Ubuntu" },
];

/**
 * Termux / Ubuntu indicators in the chat header.
 * DISPLAY ONLY: they show the active environment (AppSettings.agentShellBackend)
 * and never change it. The environment is switched on the Runtime screen.
 */
export function EnvironmentHeaderBadges() {
  const { colors } = useTheme();
  const { agentShellBackend } = useAppSettingsContext();
  const active: AgentShellBackend =
    agentShellBackend === "ubuntu-proot" ? "ubuntu-proot" : "termux";

  return (
    <View style={styles.row} accessibilityRole="summary" pointerEvents="none">
      {MODES.map((m) => {
        const on = active === m.id;
        return (
          <View
            key={m.id}
            accessible
            accessibilityRole="text"
            accessibilityLabel={`${m.a11y}${on ? " — active" : ""}`}
            style={[
              styles.chip,
              {
                backgroundColor: on ? colors.accent : "transparent",
                borderColor: on ? colors.accent : colors.line,
              },
            ]}
          >
            <Ionicons
              name={m.icon}
              size={16}
              color={on ? "#FFFFFF" : colors.muted}
            />
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 6, marginLeft: 6 },
  chip: {
    width: 30,
    height: 30,
    borderRadius: 8,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
});
