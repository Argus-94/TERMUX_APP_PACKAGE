import { useState, useCallback, useEffect, memo, useMemo } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Image,
  ScrollView,
  Dimensions,
  LayoutAnimation,
  Platform,
  UIManager,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as Clipboard from "expo-clipboard";
import { MessageContent } from "./MessageContent";
import { shareTextFile, formatFileSize } from "../lib/text-file";
import { useDialog } from "./DialogContext";
import { useLanguage } from "./LanguageContext";
import { useTheme } from "./ThemeContext";
import { darkColors } from "../theme/colors";
import { voicePlayback } from "../lib/voice-runtime";
import { expandedHeaderStyle } from "../lib/ui-expanded-highlight";

if (Platform.OS === "android" && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

export interface MessageAttachment {
  kind: "text-file" | "image" | "document" | "audio" | "video" | "archive" | "media";
  name: string;
  uri: string;
  size?: number;
  source?: "GALLERY" | "CAMERA" | "FILE" | "GENERATED";
  mimeType?: string;
}

interface Message {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
  attachment?: MessageAttachment;
}

interface Props {
  message: Message;
  /** Отсутствует у самого первого приветственного сообщения — тогда кнопки действий не показываем. */
  onDelete?: (id: string) => void;
}

/** Порог: длиннее — контент в ScrollView с maxHeight, кнопки всегда видны.
 *  v442: lowered threshold + hard max even when expanded so the bubble never
 *  stretches the FlatList into an infinite empty field (screenshot issue). */
const LONG_CONTENT_CHARS = 600;
const MAX_COLLAPSED_HEIGHT = Math.min(360, Math.round(Dimensions.get("window").height * 0.42));
const MAX_EXPANDED_HEIGHT = Math.min(640, Math.round(Dimensions.get("window").height * 0.62));

// memo() — вместе со стабильным renderItem в app/index.tsx не даёт FlatList
// перерисовывать каждый пузырёк при каждом нажатии клавиши.
export const ChatBubble = memo(function ChatBubble({ message, onDelete }: Props) {
  if (!message || typeof message !== "object" || !message.id) {
    return null;
  }
  const isUser = message.role === "user";
  const isSystem = message.role === "system";
  const [copied, setCopied] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const { showDialog } = useDialog();
  const { t, language } = useLanguage();
  const theme = useTheme();
  const colors = theme?.colors ?? darkColors;
  const isDark = theme?.isDark ?? true;

  const contentLen = (message.content || "").length;
  const isLong = !isUser && !isSystem && contentLen >= LONG_CONTENT_CHARS;

  useEffect(() => {
    const checkStatus = (playingId: string | null) => {
      setIsSpeaking(playingId === message.id);
    };
    const unsubscribe = voicePlayback.setStatusListener(checkStatus);
    setIsSpeaking(voicePlayback.isPlaying(message.id));
    return unsubscribe;
  }, [message.id]);

  const handleCopyAll = useCallback(async () => {
    await Clipboard.setStringAsync(message.content || "");
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [message.content]);

  const handleDelete = useCallback(() => {
    if (!onDelete) return;
    showDialog(t("deleteMessage"), t("deleteMessageConfirm"), [
      { text: t("cancel"), style: "cancel" },
      { text: t("delete"), style: "destructive", onPress: () => onDelete(message.id) },
    ]);
  }, [onDelete, message.id, showDialog, t]);

  const handleShareAttachment = useCallback(async () => {
    if (!message.attachment) return;
    try {
      await shareTextFile(message.attachment.uri, { dialogTitle: t("saveFileDialogTitle") });
    } catch {
      // ignore
    }
  }, [message.attachment, t]);

  const handleToggleSpeak = useCallback(async () => {
    if (isSpeaking) {
      await voicePlayback.stop();
      setIsSpeaking(false);
    } else {
      try {
        setIsSpeaking(true);
        await voicePlayback.speakText(message.id, message.content || "", language);
      } catch (e: unknown) {
        setIsSpeaking(false);
        showDialog(
          language === "en" ? "Speech Error" : "Ошибка озвучивания",
          String(e)
        );
      }
    }
  }, [isSpeaking, message.id, message.content, language, showDialog]);

  const toggleExpanded = useCallback(() => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setExpanded((v) => !v);
  }, []);

  const textColor = isUser ? (isDark ? "#00325A" : "#FFFFFF") : colors.inkBright;
  const att = message.attachment;

  const actionsRow = useMemo(() => {
    if (isSystem) return null;
    return (
      <View
        style={[
          styles.actionsRow,
          isUser ? styles.actionsRowUser : styles.actionsRowAssistant,
        ]}
      >
        {!isUser && (
          <TouchableOpacity style={styles.actionBtn} onPress={handleToggleSpeak}>
            <Ionicons
              name={isSpeaking ? "stop-circle" : "volume-high-outline"}
              size={14}
              color={isSpeaking ? "#FFB4AB" : "#9AA3AC"}
            />
            <Text
              style={[
                styles.actionBtnText,
                isSpeaking && { color: "#FFB4AB", fontWeight: "700" },
              ]}
            >
              {isSpeaking
                ? language === "en"
                  ? "Stop"
                  : language === "uk"
                    ? "Зупинити"
                    : "Стоп"
                : language === "en"
                  ? "Speak"
                  : language === "uk"
                    ? "Озвучити"
                    : "Озвучить"}
            </Text>
          </TouchableOpacity>
        )}

        <TouchableOpacity style={styles.actionBtn} onPress={handleCopyAll}>
          <Ionicons
            name={copied ? "checkmark" : "copy-outline"}
            size={14}
            color="#9AA3AC"
          />
          <Text style={styles.actionBtnText}>
            {copied ? t("copied") : t("copy")}
          </Text>
        </TouchableOpacity>
        {onDelete && (
          <TouchableOpacity style={styles.actionBtn} onPress={handleDelete}>
            <Ionicons name="trash-outline" size={14} color="#9AA3AC" />
            <Text style={styles.actionBtnText}>{t("delete")}</Text>
          </TouchableOpacity>
        )}
      </View>
    );
  }, [
    isSystem,
    isUser,
    isSpeaking,
    copied,
    language,
    t,
    onDelete,
    handleToggleSpeak,
    handleCopyAll,
    handleDelete,
  ]);

  const body = (
    <>
      {att && (att.kind === "image" || att.kind === "media") && (
        <View style={styles.imageContainer}>
          <Image
            source={{ uri: att.uri }}
            style={styles.attachmentImage}
            resizeMode="cover"
          />
          {att.source === "CAMERA" && (
            <View style={styles.sourceBadge}>
              <Text style={styles.sourceBadgeText}>
                📷{" "}
                {language === "en"
                  ? "Camera"
                  : language === "uk"
                    ? "Камера"
                    : "Камера"}
              </Text>
            </View>
          )}
          {att.source === "GENERATED" && (
            <View
              style={[
                styles.sourceBadge,
                { backgroundColor: "rgba(45, 212, 191, 0.85)" },
              ]}
            >
              <Text style={[styles.sourceBadgeText, { color: "#101418" }]}>
                ✨{" "}
                {language === "en"
                  ? "AI Generated"
                  : language === "uk"
                    ? "Згенеровано ШІ"
                    : "Создано ИИ"}
              </Text>
            </View>
          )}
        </View>
      )}

      {att &&
        (att.kind === "text-file" ||
          att.kind === "document" ||
          att.kind === "archive") && (
          <View style={styles.attachmentCard}>
            <Text style={styles.attachmentIcon}>
              {att.kind === "archive"
                ? "📦"
                : att.name.endsWith(".pdf")
                  ? "📑"
                  : "📄"}
            </Text>
            <View style={styles.attachmentInfo}>
              <Text style={styles.attachmentName} numberOfLines={1}>
                {att.name}
              </Text>
              <Text style={styles.attachmentSize}>
                {formatFileSize(att.size || 0, language)}
              </Text>
            </View>
            <TouchableOpacity
              style={styles.attachmentSaveBtn}
              onPress={handleShareAttachment}
            >
              <Ionicons name="download-outline" size={16} color="#9FCBFF" />
            </TouchableOpacity>
          </View>
        )}

      {att && (att.kind === "audio" || att.kind === "video") && (
        <View style={styles.attachmentCard}>
          <Text style={styles.attachmentIcon}>
            {att.kind === "video" ? "🎥" : "🎵"}
          </Text>
          <View style={styles.attachmentInfo}>
            <Text style={styles.attachmentName} numberOfLines={1}>
              {att.name}
            </Text>
            <Text style={styles.attachmentSize}>{att.kind.toUpperCase()}</Text>
          </View>
        </View>
      )}

      {/* Текст: для длинных ответов — ограниченная высота + внутренний скролл.
          Кнопки остаются снаружи и всегда доступны. */}
      {!(message.content || "").trim() && !att ? (
        <Text style={{ color: textColor, fontSize: 13, fontStyle: "italic", opacity: 0.7 }}>
          {language === "en"
            ? "(empty reply)"
            : language === "uk"
              ? "(порожня відповідь)"
              : "(пустой ответ)"}
        </Text>
      ) : isLong && !expanded ? (
        <View style={[styles.collapsedWrap, expandedHeaderStyle(false, colors), { maxHeight: MAX_COLLAPSED_HEIGHT }]}>
          <ScrollView
            nestedScrollEnabled
            showsVerticalScrollIndicator
            style={{ maxHeight: MAX_COLLAPSED_HEIGHT }}
            contentContainerStyle={{ paddingBottom: 4 }}
          >
            <MessageContent
              content={message.content || ""}
              textColor={textColor}
            />
          </ScrollView>
          <TouchableOpacity
            style={[styles.expandBtn, { backgroundColor: colors.surfaceRaised, borderColor: colors.line }]}
            onPress={toggleExpanded}
            activeOpacity={0.8}
          >
            <Text style={[styles.expandBtnText, { color: colors.accent }]}>
              {language === "en"
                ? "Show full reply"
                : language === "uk"
                  ? "Показати повністю"
                  : "Показать полностью"}
            </Text>
            <Ionicons name="chevron-down" size={14} color={colors.accent} />
          </TouchableOpacity>
        </View>
      ) : isLong && expanded ? (
        <View style={[styles.collapsedWrap, expandedHeaderStyle(false, colors), { maxHeight: MAX_EXPANDED_HEIGHT }]}>
          <ScrollView
            nestedScrollEnabled
            showsVerticalScrollIndicator
            style={{ maxHeight: MAX_EXPANDED_HEIGHT }}
            contentContainerStyle={{ paddingBottom: 4 }}
          >
            <MessageContent
              content={message.content || ""}
              textColor={textColor}
            />
          </ScrollView>
          <TouchableOpacity
            style={[styles.expandBtn, { backgroundColor: colors.surfaceRaised, borderColor: colors.line, marginTop: 8 }]}
            onPress={toggleExpanded}
            activeOpacity={0.8}
            accessibilityState={{ expanded: true }}
          >
            <Text style={[styles.expandBtnText, { color: colors.accent }]}>
              {language === "en"
                ? "Collapse"
                : language === "uk"
                  ? "Згорнути"
                  : "Свернуть"}
            </Text>
            <Ionicons name="chevron-up" size={14} color={colors.accent} />
          </TouchableOpacity>
        </View>
      ) : (
        <MessageContent
          content={message.content || ""}
          textColor={textColor}
        />
      )}
    </>
  );

  return (
    <View
      style={[
        styles.container,
        isUser ? styles.userContainer : styles.assistantContainer,
      ]}
    >
      {/* Для ответов ассистента кнопки СВЕРХУ — всегда рядом с началом длинного текста */}
      {!isUser && !isSystem && actionsRow}

      <View
        style={[
          styles.bubble,
          isUser && {
            backgroundColor: colors.accent,
            borderBottomRightRadius: 4,
          },
          isSystem && {
            backgroundColor: colors.surfaceRaised,
            borderWidth: 1,
            borderColor: colors.accentGlow,
            borderRadius: 12,
          },
          !isUser &&
            !isSystem && {
              backgroundColor: colors.surface,
              borderBottomLeftRadius: 4,
              borderWidth: 1,
              borderColor: colors.line,
            },
          // Длинный пузырь не должен раздувать весь FlatList без меры
          isLong && !expanded && { maxWidth: "92%" },
        ]}
      >
        {body}
      </View>

      {/* Пользователь — кнопки снизу.
          Ассистент: кнопки уже сверху; для длинных — ещё и снизу. */}
      {isUser && actionsRow}
      {!isUser && !isSystem && isLong && actionsRow}
    </View>
  );
});

const styles = StyleSheet.create({
  container: { width: "100%", marginVertical: 4 },
  userContainer: { alignItems: "flex-end" },
  assistantContainer: { alignItems: "flex-start" },
  bubble: {
    maxWidth: "85%",
    width: undefined,
    alignSelf: "flex-start",
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 16,
    overflow: "hidden",
    // v442: prevent unbounded growth from long markdown/code blocks
    maxHeight: undefined,
  },
  collapsedWrap: {
    position: "relative",
  },
  expandBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    marginTop: 6,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 8,
    borderWidth: 1,
  },
  expandBtnText: {
    fontSize: 12,
    fontWeight: "700",
  },
  imageContainer: {
    position: "relative",
    width: "100%",
    marginBottom: 8,
  },
  attachmentImage: {
    width: "100%",
    aspectRatio: 4 / 3,
    borderRadius: 12,
    backgroundColor: "#101418",
  },
  sourceBadge: {
    position: "absolute",
    top: 8,
    left: 8,
    backgroundColor: "rgba(0, 0, 0, 0.65)",
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 8,
  },
  sourceBadgeText: {
    color: "#FFFFFF",
    fontSize: 10,
    fontWeight: "700",
  },
  attachmentCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "rgba(10, 14, 23, 0.18)",
    borderRadius: 10,
    padding: 8,
    marginBottom: 8,
  },
  attachmentIcon: { fontSize: 20 },
  attachmentInfo: { flex: 1 },
  attachmentName: { color: "#00325A", fontSize: 12, fontWeight: "700" },
  attachmentSize: { color: "#00325A", fontSize: 11, opacity: 0.7 },
  attachmentSaveBtn: { padding: 6 },
  actionsRow: {
    flexDirection: "row",
    gap: 4,
    marginTop: 2,
    marginBottom: 2,
    paddingHorizontal: 4,
    flexWrap: "wrap",
  },
  actionsRowUser: { justifyContent: "flex-end" },
  actionsRowAssistant: { justifyContent: "flex-start" },
  actionBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  actionBtnText: { color: "#9AA3AC", fontSize: 11, fontWeight: "600" },
});
