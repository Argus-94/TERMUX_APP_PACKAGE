import { useState, useCallback } from "react";
import {
  Modal,
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Platform,
  ScrollView,
} from "react-native";
import * as Clipboard from "expo-clipboard";
import { useTheme } from "./ThemeContext";
import { darkColors } from "../theme/colors";
import { useSafeAreaInsets } from "react-native-safe-area-context";

export interface AppDialogButton {
  text: string;
  style?: "default" | "cancel" | "destructive";
  onPress?: () => void;
}

interface AppDialogProps {
  visible: boolean;
  title: string;
  message?: string;
  /** Separate shell commands — each shown in its own block with a copy button. */
  commands?: string[];
  /** Label for the per-command copy button (default: "Copy"). */
  copyLabel?: string;
  /** Label shown briefly after a successful copy (default: "Copied"). */
  copiedLabel?: string;
  buttons: AppDialogButton[];
  onButtonPress?: (button: AppDialogButton, index: number) => void;
  onRequestClose: () => void;
}

const MONOSPACE = Platform.select({ android: "monospace", ios: "Menlo", default: "monospace" });

function CommandRow({
  command,
  copyLabel,
  copiedLabel,
}: {
  command: string;
  copyLabel: string;
  copiedLabel: string;
}) {
  const theme = useTheme();
  const colors = theme?.colors ?? darkColors;
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    await Clipboard.setStringAsync(command);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [command]);

  return (
    <View style={[styles.commandBlock, { backgroundColor: colors.background, borderColor: colors.line }]}>
      <View style={styles.commandTextWrap}>
        <Text
          style={[
            styles.commandText,
            {
              color: colors.inkBright,
              backgroundColor: "transparent",
              fontFamily: Platform.OS === "android" ? "sans-serif-medium" : MONOSPACE,
            },
          ]}
        >
          {command}
        </Text>
      </View>
      <TouchableOpacity
        style={[styles.copyBtn, { backgroundColor: colors.accentDim }, copied && { backgroundColor: colors.accent }]}
        onPress={handleCopy}
        activeOpacity={0.7}
        accessibilityRole="button"
        accessibilityLabel={copied ? copiedLabel : copyLabel}
      >
        <Text style={[styles.copyBtnText, { color: copied ? (colors.onAccent || colors.background) : colors.accent }]}>
          {copied ? copiedLabel : copyLabel}
        </Text>
      </TouchableOpacity>
    </View>
  );
}

export function AppDialog({
  visible,
  title,
  message,
  commands,
  copyLabel = "Copy",
  copiedLabel = "Copied",
  buttons,
  onButtonPress,
  onRequestClose,
}: AppDialogProps) {
  const theme = useTheme();
  const colors = theme?.colors ?? darkColors;
  const insets = useSafeAreaInsets();
  const hasCommands = Array.isArray(commands) && commands.length > 0;
  // С 3+ кнопками вертикальный столбец читается лучше, чем перенос в ряд.
  const stackButtons = buttons.length >= 3;

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onRequestClose} statusBarTranslucent>
      <View style={[styles.backdrop, { backgroundColor: "rgba(0,0,0,0.62)", paddingBottom: insets.bottom + 8, paddingTop: insets.top + 8 }]}>
        <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.line }]}>
          <ScrollView
            style={styles.cardScroll}
            contentContainerStyle={[styles.cardScrollContent, { backgroundColor: "transparent" }]}
            showsVerticalScrollIndicator={false}
            bounces={false}
            keyboardShouldPersistTaps="handled"
          >
            <Text style={[styles.title, { color: colors.inkBright }]}>{title}</Text>

            {message ? (
              <View style={styles.messageWrap}>
                <Text style={[styles.messageText, { color: colors.muted }]}>
                  {message}
                </Text>
              </View>
            ) : null}

            {hasCommands ? (
              <View style={styles.commandsWrap}>
                {commands!.map((cmd, i) => (
                  <CommandRow
                    key={`${i}-${cmd}`}
                    command={cmd}
                    copyLabel={copyLabel}
                    copiedLabel={copiedLabel}
                  />
                ))}
              </View>
            ) : null}

            <View style={[styles.buttonRow, stackButtons && styles.buttonCol]}>
              {buttons.map((btn, i) => (
                <TouchableOpacity
                  key={i}
                  style={[
                    styles.button,
                    stackButtons && styles.buttonFull,
                    { backgroundColor: colors.accentDim },
                    btn.style === "destructive" && { backgroundColor: colors.dangerDim },
                    btn.style === "cancel" && { backgroundColor: "transparent" },
                  ]}
                  onPress={() => {
                    if (onButtonPress) {
                      onButtonPress(btn, i);
                    } else {
                      onRequestClose();
                      btn.onPress?.();
                    }
                  }}
                  accessibilityRole="button"
                  accessibilityLabel={btn.text}
                  accessibilityState={{ disabled: false }}
                >
                  <Text
                    style={[
                      styles.buttonText,
                      { color: colors.accent },
                      btn.style === "destructive" && { color: colors.danger },
                      btn.style === "cancel" && { color: colors.muted },
                    ]}
                  >
                    {btn.text}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.62)",
    justifyContent: "center",
    alignItems: "center",
    padding: 24,
  },
  card: {
    width: "100%",
    maxWidth: 360,
    maxHeight: "86%",
    backgroundColor: "#181C20",
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "#3A4148",
    padding: 20,
  },
  title: {
    color: "#F0F1F3",
    fontSize: 17,
    fontWeight: "700",
  },
  cardScroll: {
    flexGrow: 0,
  },
  cardScrollContent: {
    paddingBottom: 2,
  },
  messageWrap: {
    marginTop: 10,
    marginBottom: 14,
    backgroundColor: "transparent",
  },
  messageText: {
    fontSize: 14,
    lineHeight: 21,
    color: "#9AA3AC",
    backgroundColor: "transparent",
  },
  message: {
    fontSize: 14,
    lineHeight: 21,
    marginTop: 10,
    marginBottom: 14,
    backgroundColor: "transparent",
  },
  commandsWrap: {
    marginTop: 14,
    gap: 10,
  },
  commandBlock: {
    borderRadius: 12,
    borderWidth: 1,
    padding: 12,
    marginBottom: 12,
    gap: 10,
  },
  commandTextWrap: {
    backgroundColor: "transparent",
  },
  commandText: {
    fontSize: 13,
    lineHeight: 20,
    letterSpacing: 0,
    includeFontPadding: false,
    backgroundColor: "transparent",
  },
  copyBtn: {
    alignSelf: "stretch",
    alignItems: "center",
    paddingVertical: 10,
    borderRadius: 10,
  },
  copyBtnDone: {
    backgroundColor: "rgba(159, 203, 255, 0.22)",
  },
  copyBtnText: {
    fontSize: 13,
    fontWeight: "700",
  },
  copyBtnTextDone: {
    color: "#9FCBFF",
  },
  buttonRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "flex-end",
    gap: 8,
    marginTop: 20,
  },
  buttonCol: {
    flexDirection: "column-reverse",
    alignItems: "stretch",
  },
  button: {
    minHeight: 44,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 12,
    backgroundColor: "rgba(159, 203, 255, 0.12)",
    alignItems: "center",
    justifyContent: "center",
  },
  buttonFull: {
    width: "100%",
  },
  buttonCancel: {
    backgroundColor: "transparent",
  },
  buttonDestructive: {
    backgroundColor: "rgba(255, 180, 171, 0.14)",
  },
  buttonText: {
    color: "#9FCBFF",
    fontSize: 14,
    fontWeight: "700",
  },
  buttonTextCancel: {
    color: "#9AA3AC",
    fontWeight: "600",
  },
  buttonTextDestructive: {
    color: "#FFB4AB",
  },
});
