import { View, Text, TouchableOpacity, StyleSheet } from "react-native";
import { useTheme } from "./ThemeContext";
import { useLanguage } from "./LanguageContext";

interface Props {
  label: string;
  value: number;
  step: number;
  min: number;
  max: number;
  onChange: (next: number) => void;
  /**
   * Форматування відображаного значення.
   * Приклад: (v) => v.toFixed(1) буде показувати одне десяткове місце.
   */
  format?: (v: number) => string;
}

/**
 * NumberField — керуючий компонент для числових значень.
 * Дозволяє користувачеві інкрементувати/декрементувати число з кроком,
 * з обмеженнями min/max. Потрібне тематизування розроблено через useTheme().
 */
export function NumberField({ label, value, step, min, max, onChange, format }: Props) {
  const { colors } = useTheme();
  const { t } = useLanguage();
  const displayValue = format ? format(value) : String(value);

  const handleDecrement = () => {
    const newValue = value - step;
    const clamped = Math.max(min, Math.round(newValue * 100) / 100);
    onChange(clamped);
  };

  const handleIncrement = () => {
    const newValue = value + step;
    const clamped = Math.min(max, Math.round(newValue * 100) / 100);
    onChange(clamped);
  };

  return (
    <View style={styles.container}>
      <Text style={[styles.label, { color: colors.ink }]}>{label}</Text>
      <View style={styles.stepper}>
        <TouchableOpacity
          style={[
            styles.btn,
            {
              backgroundColor: colors.chipBg,
              borderColor: colors.line,
            },
          ]}
          onPress={handleDecrement}
          accessibilityLabel={t("decrement")}
          accessibilityRole="button"
        >
          <Text style={[styles.btnText, { color: colors.accent }]}>−</Text>
        </TouchableOpacity>
        <Text style={[styles.value, { color: colors.inkBright }]}>{displayValue}</Text>
        <TouchableOpacity
          style={[
            styles.btn,
            {
              backgroundColor: colors.chipBg,
              borderColor: colors.line,
            },
          ]}
          onPress={handleIncrement}
          accessibilityLabel={t("increment")}
          accessibilityRole="button"
        >
          <Text style={[styles.btnText, { color: colors.accent }]}>+</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 6,
  },
  label: {
    fontSize: 12.5,
    flex: 1,
  },
  stepper: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  btn: {
    width: 26,
    height: 26,
    borderRadius: 13,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  btnText: {
    fontSize: 15,
    fontWeight: "700",
    marginTop: -1,
  },
  value: {
    fontSize: 13,
    fontWeight: "600",
    minWidth: 44,
    textAlign: "center",
  },
});
