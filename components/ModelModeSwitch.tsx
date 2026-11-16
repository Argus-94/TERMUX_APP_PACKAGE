import { View, Text, TouchableOpacity, StyleSheet } from "react-native";
import { useLanguage } from "./LanguageContext";
import { useTheme } from "./ThemeContext";

interface Props {
  enabled: boolean;
  checking: boolean;
  onSetEnabled: (value: boolean) => void;
}

export function ModelModeSwitch({ enabled, checking, onSetEnabled }: Props) {
  const { t, language } = useLanguage();
  const { colors } = useTheme();

  // The chat controls Termux session state here. Model mode selection remains
  // in Settings; these buttons must never change the active AI provider.
  const onLabel =
    language === "en" ? "Termux ON" :
    language === "uk" ? "Termux ON" :
    "Termux ON";
  const offLabel =
    language === "en" ? "Termux OFF" :
    language === "uk" ? "Termux OFF" :
    "Termux OFF";

  return (
    <View style={[styles.container, { backgroundColor: colors.surfaceRaised, borderColor: colors.line }]}>
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityState={{ selected: enabled, disabled: checking }}
        disabled={checking}
        style={[
          styles.segment,
          enabled && { backgroundColor: "#2F4F4F" },
        ]}
        onPress={() => onSetEnabled(true)}
      >
        <View style={[styles.dot, { backgroundColor: enabled ? "#2F4F4F" : colors.muted }]} />
        <Text
          style={[
            styles.segmentText,
            { color: enabled ? "#FFFFFF" : colors.muted },
            enabled && { fontWeight: "700" },
          ]}
        >
          {onLabel}
        </Text>
      </TouchableOpacity>

      <TouchableOpacity
        accessibilityRole="button"
        accessibilityState={{ selected: !enabled, disabled: checking }}
        disabled={checking}
        style={[
          styles.segment,
          !enabled && { backgroundColor: "#2F4F4F" },
        ]}
        onPress={() => onSetEnabled(false)}
      >
        <View style={[styles.dot, { backgroundColor: !enabled ? "#2F4F4F" : colors.muted }]} />
        <Text
          style={[
            styles.segmentText,
            { color: !enabled ? "#FFFFFF" : colors.muted },
            !enabled && { fontWeight: "700" },
          ]}
        >
          {offLabel}
        </Text>
      </TouchableOpacity>

      {checking && (
        <Text style={{ color: colors.warning, fontSize: 10, marginLeft: 4 }}>
          {t("checking")}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 4,
    paddingVertical: 4,
    borderRadius: 16,
    borderWidth: 1,
  },
  segment: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 12,
  },
  segmentText: { fontSize: 12, fontWeight: "600" },
  dot: { width: 7, height: 7, borderRadius: 4 },
});
