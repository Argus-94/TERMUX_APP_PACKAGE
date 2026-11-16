/**
 * Universal Attachment Menu Modal
 * Позволяет пользователю выбрать тип вложения:
 * Камера (фото), Фото из галереи, Видео, Аудио или Документ/Любой файл.
 * Соответствует разделам 41-43 ТЗ Multimodal и разделу 26 ТЗ Voice.
 */

import { Modal, View, Text, TouchableOpacity, StyleSheet, Pressable } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useLanguage } from "./LanguageContext";
import { useTheme } from "./ThemeContext";
import { useSafeAreaInsets } from "react-native-safe-area-context";

interface Props {
  visible: boolean;
  onClose: () => void;
  onSelectCamera: () => void;
  onSelectGallery: () => void;
  onSelectVideo: () => void;
  onSelectAudio: () => void;
  onSelectDocument: () => void;
}

export function UniversalAttachmentMenu({
  visible,
  onClose,
  onSelectCamera,
  onSelectGallery,
  onSelectVideo,
  onSelectAudio,
  onSelectDocument,
}: Props) {
  const { t, language } = useLanguage();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();

  const menuItems = [
    {
      id: "camera",
      icon: "camera-outline" as const,
      label: language === "en" ? "Camera (Take photo)" : language === "uk" ? "Камера (Зробити фото)" : "Камера (Сделать фото)",
      onPress: () => {
        onClose();
        onSelectCamera();
      },
    },
    {
      id: "gallery",
      icon: "images-outline" as const,
      label: language === "en" ? "Photo from gallery" : language === "uk" ? "Фото з галереї" : "Фото из галереи",
      onPress: () => {
        onClose();
        onSelectGallery();
      },
    },
    {
      id: "video",
      icon: "videocam-outline" as const,
      label: language === "en" ? "Video" : language === "uk" ? "Відео" : "Видео",
      onPress: () => {
        onClose();
        onSelectVideo();
      },
    },
    {
      id: "audio",
      icon: "musical-notes-outline" as const,
      label: language === "en" ? "Audio recording / file" : language === "uk" ? "Аудіозапис / файл" : "Аудиозапись / файл",
      onPress: () => {
        onClose();
        onSelectAudio();
      },
    },
    {
      id: "document",
      icon: "document-text-outline" as const,
      label: language === "en" ? "Document / Any file (PDF, Code, APK)" : language === "uk" ? "Документ / Будь-який файл (PDF, Код, APK)" : "Документ / Любой файл (PDF, Код, APK)",
      onPress: () => {
        onClose();
        onSelectDocument();
      },
    },
  ];

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable
          style={[styles.sheet, { backgroundColor: colors.surface, borderTopColor: colors.line, paddingBottom: Math.max(insets.bottom, 12) + 16 }]}
          onPress={(e) => e.stopPropagation()}
        >
          <View style={styles.dragHandleWrap}>
            <View style={[styles.dragHandle, { backgroundColor: colors.line }]} />
          </View>

          <Text style={[styles.sheetTitle, { color: colors.inkBright }]}>
            {language === "en" ? "Attach to message" : language === "uk" ? "Прикріпити до повідомлення" : "Прикрепить к сообщению"}
          </Text>

          <View style={styles.itemsList}>
            {menuItems.map((item) => (
              <TouchableOpacity
                key={item.id}
                style={[styles.menuItem, { borderBottomColor: colors.line }]}
                onPress={item.onPress}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityLabel={item.label}
              >
                <View style={[styles.iconBox, { backgroundColor: colors.surfaceRaised }]}>
                  <Ionicons name={item.icon} size={22} color={colors.accent} />
                </View>
                <Text style={[styles.itemText, { color: colors.inkBright }]}>{item.label}</Text>
                <Ionicons name="chevron-forward" size={18} color={colors.muted} />
              </TouchableOpacity>
            ))}
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0, 0, 0, 0.5)",
    justifyContent: "flex-end",
  },
  sheet: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderTopWidth: 1,
    paddingHorizontal: 16,
    paddingBottom: 32,
  },
  dragHandleWrap: {
    alignItems: "center",
    paddingVertical: 10,
  },
  dragHandle: {
    width: 36,
    height: 4,
    borderRadius: 2,
  },
  sheetTitle: {
    fontSize: 16,
    fontWeight: "700",
    marginBottom: 12,
    paddingHorizontal: 4,
  },
  itemsList: {
    display: "flex",
    flexDirection: "column",
  },
  menuItem: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: 64,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  iconBox: {
    width: 40,
    height: 40,
    borderRadius: 10,
    justifyContent: "center",
    alignItems: "center",
    marginRight: 12,
  },
  itemText: {
    flex: 1,
    fontSize: 15,
    fontWeight: "500",
  },
});
