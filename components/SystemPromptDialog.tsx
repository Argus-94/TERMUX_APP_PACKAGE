import { useState, useEffect } from "react";
import {
  Modal,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  useWindowDimensions,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "./ThemeContext";
import { useLanguage } from "./LanguageContext";

interface Props {
  visible: boolean;
  value: string;
  onSave: (next: string) => void;
  onClear: () => void;
  onRequestClose: () => void;
  /** Optional overrides — by default uses systemPrompt* i18n keys */
  titleKey?: string;
  descKey?: string;
  placeholderKey?: string;
}

/**
 * Глобальный системный промт — применяется и к офлайн-, и к онлайн-модели
 * (см. lib/local-model.ts / lib/online-model.ts, hooks/useLLM.ts).
 * "Сохранить" фиксирует текущий текст поля и закрывает окно, "Очистить"
 * мгновенно обнуляет и поле, и сохранённое значение.
 */
export function SystemPromptDialog({
  visible,
  value,
  onSave,
  onClear,
  onRequestClose,
  titleKey = "systemPromptDialogTitle",
  descKey = "systemPromptSectionDesc",
  placeholderKey = "systemPromptPlaceholder",
}: Props) {
  const { colors } = useTheme();
  const { t } = useLanguage();
  const insets = useSafeAreaInsets();
  const { width: windowWidth } = useWindowDimensions();
  const [draft, setDraft] = useState(value);

  // Явно вычисляем ширину карточки от реальных размеров окна, а не полагаемся
  // на "100%"/maxWidth в связке со statusBarTranslucent — на части
  // Android-прошивок (кастомные ROM, нестандартный DPI) это приводило к тому,
  // что карточка рендерилась шире физического экрана и текст/кнопки обрезались
  // по правому краю.
  const cardWidth = Math.min(windowWidth - 24 - insets.left - insets.right, 480);

  // Каждый раз, когда окно открывается, подтягиваем актуальное сохранённое
  // значение — если пользователь открыл окно повторно после "Очистить" в
  // прошлый раз, поле не должно показывать старый неактуальный черновик.
  useEffect(() => {
    if (visible) setDraft(value);
  }, [visible, value]);

  const handleSave = () => {
    onSave(draft);
    onRequestClose();
  };

  const handleClear = () => {
    setDraft("");
    onClear();
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onRequestClose}>
      <KeyboardAvoidingView
        style={[styles.backdrop, { backgroundColor: "rgba(2, 6, 16, 0.74)" }]}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={Platform.OS === "ios" ? 12 : 0}
      >
        <ScrollView
          contentContainerStyle={styles.container}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <View
            style={[
              styles.card,
              {
                width: cardWidth,
                backgroundColor: colors.surface,
                borderColor: colors.line,
                marginTop: insets.top + 8,
                marginBottom: insets.bottom + 8,
              },
            ]}
          >
            <View style={[styles.header, { borderBottomColor: colors.line }]}>
              <View style={styles.titleWrap}>
                <View style={[styles.titleIcon, { backgroundColor: colors.accentDim }]}>
                  <Text style={styles.titleEmoji}>📝</Text>
                </View>
                <Text
                  style={[styles.title, { color: colors.inkBright }]}
                  numberOfLines={2}
                >
                  {t(titleKey as any)}
                </Text>
              </View>
              <TouchableOpacity
                onPress={onRequestClose}
                style={styles.closeButton}
                accessibilityRole="button"
                accessibilityLabel={t("close")}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <Ionicons name="close" size={24} color={colors.muted} />
              </TouchableOpacity>
            </View>

            <View style={styles.content}>
              <Text style={[styles.desc, { color: colors.muted }]}>
                {t(descKey as any)}
              </Text>

              <View
                style={[
                  styles.textAreaContainer,
                  { borderColor: colors.line, backgroundColor: colors.inputBg },
                ]}
              >
                <TextInput
                  style={[styles.textArea, { color: colors.inkBright }]}
                  value={draft}
                  onChangeText={setDraft}
                  placeholder={t(placeholderKey as any)}
                  placeholderTextColor={colors.footerMuted}
                  multiline
                  textAlignVertical="top"
                  maxLength={4000}
                />
              </View>

              <View style={styles.charCount}>
                <Text style={[styles.charCountText, { color: colors.muted }]}>
                  {draft.length}/4000
                </Text>
              </View>
            </View>

            <View style={[styles.footer, { borderTopColor: colors.line }]}>
              <TouchableOpacity
                style={[styles.footerButton, styles.clearButton, { borderColor: colors.line }]}
                onPress={handleClear}
                activeOpacity={0.75}
              >
                <Ionicons name="trash-outline" size={18} color={colors.warning} />
                <Text
                  style={[styles.footerText, { color: colors.warning }]}
                  numberOfLines={1}
                  adjustsFontSizeToFit
                  minimumFontScale={0.85}
                >
                  {t("systemPromptClear")}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.footerButton,
                  styles.saveButton,
                  { backgroundColor: colors.accent },
                ]}
                onPress={handleSave}
                activeOpacity={0.8}
              >
                <Ionicons name="checkmark" size={18} color={colors.onAccent || "#00325A"} />
                <Text
                  style={[styles.footerText, { color: colors.onAccent || "#00325A" }]}
                  numberOfLines={1}
                  adjustsFontSizeToFit
                  minimumFontScale={0.85}
                >
                  {t("systemPromptSave")}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
  },
  container: {
    paddingHorizontal: 14,
    justifyContent: "center",
    alignItems: "center",
    minHeight: "100%",
  },
  card: {
    borderRadius: 16,
    borderWidth: 1,
    overflow: "hidden",
    alignSelf: "center",
    elevation: 18,
    shadowOpacity: 0.3,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
  },
  header: {
    minHeight: 64,
    paddingHorizontal: 18,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderBottomWidth: 1,
  },
  titleWrap: { flexDirection: "row", alignItems: "center", gap: 10, flex: 1, minWidth: 0 },
  titleIcon: {
    width: 38,
    height: 38,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  titleEmoji: { fontSize: 21 },
  title: { fontSize: 19, fontWeight: "800", flexShrink: 1 },
  closeButton: { padding: 8, marginRight: -6, flexShrink: 0 },
  content: { padding: 16, gap: 12 },
  desc: { fontSize: 13, lineHeight: 20, flexShrink: 1 },
  textAreaContainer: {
    width: "100%",
    borderRadius: 13,
    borderWidth: 1,
    padding: 12,
    minHeight: 160,
    maxHeight: 280,
  },
  textArea: {
    width: "100%",
    fontSize: 13.5,
    lineHeight: 20,
  },
  charCount: { alignItems: "flex-end" },
  charCountText: { fontSize: 12, fontWeight: "500" },
  footer: {
    borderTopWidth: 1,
    padding: 14,
    flexDirection: "row",
    gap: 10,
  },
  footerButton: {
    flex: 1,
    minWidth: 0,
    minHeight: 48,
    borderRadius: 13,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: 7,
    paddingHorizontal: 6,
  },
  clearButton: { borderWidth: 1 },
  saveButton: { borderWidth: 1, borderColor: "transparent" },
  footerText: { fontSize: 14, fontWeight: "800", flexShrink: 1 },
});
