import { TouchableOpacity, View, Text, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useTheme } from "./ThemeContext";

interface Props {
  checked: boolean;
  onPress: () => void;
  label: string;
  /** Plain-language explanation under the title */
  description?: string;
  disabled?: boolean;
  accessibilityHint?: string;
}

export function Checkbox({ checked, onPress, label, description, disabled, accessibilityHint }: Props) {
  const { colors, isDark } = useTheme();
  return (
    <TouchableOpacity
      style={[styles.row, disabled && styles.rowDisabled]}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="checkbox"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint ?? description}
      accessibilityState={{ checked, disabled: !!disabled }}
      activeOpacity={0.7}
    >
      <View
        style={[
          styles.box,
          { borderColor: colors.muted },
          checked && { backgroundColor: colors.accent, borderColor: colors.accent },
        ]}
      >
        {checked && (
          <Ionicons name="checkmark" size={13} color={isDark ? "#00325A" : "#FFFFFF"} />
        )}
      </View>
      <View style={styles.textCol}>
        <Text style={[styles.label, { color: colors.inkBright }]}>{label}</Text>
        {!!description && (
          <Text style={[styles.desc, { color: colors.muted }]}>{description}</Text>
        )}
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "flex-start", gap: 10, paddingVertical: 8 },
  rowDisabled: { opacity: 0.5 },
  box: {
    width: 20,
    height: 20,
    borderRadius: 5,
    borderWidth: 1.5,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 1,
  },
  textCol: { flex: 1, gap: 3 },
  label: { fontSize: 13, fontWeight: "600", lineHeight: 18 },
  desc: { fontSize: 12, fontWeight: "400", lineHeight: 16 },
});
