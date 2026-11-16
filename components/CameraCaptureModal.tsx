/**
 * Camera Capture & Preview Modal
 * Позволяет сделать снимок на камеру прямо из чата, просмотреть фото на экране,
 * переснять при необходимости или подтвердить использование как ChatAttachment(IMAGE).
 * Соответствует разделу 26 ТЗ (Voice Chat Runtime TZ with Camera).
 */

import { useState, useCallback } from "react";
import {
  Modal,
  Alert,
  View,
  Text,
  Image,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Linking,
  Platform,
} from "react-native";
import * as ImagePicker from "expo-image-picker";
import { Ionicons } from "@expo/vector-icons";
import { useLanguage } from "./LanguageContext";
import { useTheme } from "./ThemeContext";
import { useDialog } from "./DialogContext";
import type { ChatAttachment } from "../lib/multimodal-types";

interface Props {
  visible: boolean;
  onClose: () => void;
  onPhotoAccepted: (attachment: ChatAttachment) => void;
}

export function CameraCaptureModal({ visible, onClose, onPhotoAccepted }: Props) {
  const [photoUri, setPhotoUri] = useState<string | null>(null);
  const [isCapturing, setIsCapturing] = useState(false);
  const { t, language } = useLanguage();
  const { colors } = useTheme();
  const { showDialog } = useDialog();

  const handleLaunchCamera = useCallback(async () => {
    setIsCapturing(true);
    try {
      let permission = await ImagePicker.getCameraPermissionsAsync();
      if (!permission.granted) {
        const approved = await new Promise<boolean>((resolve) => {
          let settled = false;
          const finish = (value: boolean) => { if (!settled) { settled = true; resolve(value); } };
          Alert.alert(
            language === "en" ? "Camera access" : language === "uk" ? "Доступ до камери" : "Доступ к камере",
            language === "en"
              ? "AI Builder needs camera access only to capture a photo you choose to attach to this chat."
              : language === "uk"
                ? "AI Builder потрібен доступ до камери лише для знімка, який ви вирішите додати до цього чату."
                : "AI Builder нужен доступ к камере только для снимка, который вы решите прикрепить к этому чату.",
            [
              { text: language === "en" ? "Not now" : language === "uk" ? "Не зараз" : "Не сейчас", style: "cancel", onPress: () => finish(false) },
              { text: language === "en" ? "Continue" : language === "uk" ? "Продовжити" : "Продолжить", onPress: () => finish(true) },
            ],
            { cancelable: true, onDismiss: () => finish(false) },
          );
        });
        if (!approved) { onClose(); return; }
        if (permission.canAskAgain !== false) await ImagePicker.requestCameraPermissionsAsync();
        permission = await ImagePicker.getCameraPermissionsAsync();
      }
      if (!permission.granted) {
        setIsCapturing(false);
        onClose();
        const msg =
          language === "en"
            ? "Camera permission is required to take photos in chat. Please grant it in settings."
            : language === "uk"
            ? "Для зйомки фото в чаті потрібен доступ до камери. Будь ласка, дозвольте доступ у налаштуваннях."
            : "Для съёмки фото в чате нужен доступ к камере. Пожалуйста, разрешите доступ в настройках.";
        showDialog(t("camera"), msg, [
          { text: "OK" },
          {
            text: language === "en" ? "Settings" : language === "uk" ? "Налаштування" : "Настройки",
            onPress: () => Linking.openSettings().catch(() => {}),
          },
        ]);
        return;
      }

      const result = await ImagePicker.launchCameraAsync({
        mediaTypes: "images",
        allowsEditing: false,
        quality: 0.85,
        exif: true,
      });

      if (!result.canceled && result.assets && result.assets.length > 0) {
        setPhotoUri(result.assets[0].uri);
      } else {
        // Пользователь отменил съёмку
        onClose();
      }
    } catch (err: unknown) {
      onClose();
      showDialog(t("camera"), String(err));
    } finally {
      setIsCapturing(false);
    }
  }, [language, onClose, showDialog, t]);

  const handleRetake = useCallback(() => {
    setPhotoUri(null);
    handleLaunchCamera();
  }, [handleLaunchCamera]);

  const handleAccept = useCallback(() => {
    if (!photoUri) return;
    const fileName = photoUri.split("/").pop() || `camera_${Date.now()}.jpg`;
    const attachment: ChatAttachment = {
      id: `cam_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      uri: photoUri,
      displayName: fileName,
      mimeType: "image/jpeg",
      sizeBytes: 0,
      extension: "jpg",
      attachmentType: "IMAGE",
      localState: "READY",
      source: "CAMERA",
    };
    onPhotoAccepted(attachment);
    setPhotoUri(null);
    onClose();
  }, [photoUri, onPhotoAccepted, onClose]);

  const handleDismiss = useCallback(() => {
    setPhotoUri(null);
    onClose();
  }, [onClose]);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={handleDismiss}
      onShow={() => {
        if (!photoUri) {
          handleLaunchCamera();
        }
      }}
    >
      <View style={styles.overlay}>
        {photoUri ? (
          <View style={[styles.previewCard, { backgroundColor: colors.surface, borderColor: colors.line }]}>
            <View style={styles.header}>
              <Text style={[styles.headerTitle, { color: colors.inkBright }]}>
                {language === "en" ? "Camera Photo Preview" : language === "uk" ? "Попередній перегляд фото" : "Предпросмотр фото"}
              </Text>
              <TouchableOpacity onPress={handleDismiss} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Ionicons name="close" size={24} color={colors.muted} />
              </TouchableOpacity>
            </View>

            <View style={styles.imageWrapper}>
              <Image source={{ uri: photoUri }} style={styles.image} resizeMode="contain" />
            </View>

            <View style={styles.buttonRow}>
              <TouchableOpacity
                style={[styles.actionBtn, styles.retakeBtn, { borderColor: colors.line }]}
                onPress={handleRetake}
              >
                <Ionicons name="refresh" size={18} color={colors.inkBright} style={{ marginRight: 6 }} />
                <Text style={[styles.btnText, { color: colors.inkBright }]}>
                  {language === "en" ? "Retake" : language === "uk" ? "Перезняти" : "Переснять"}
                </Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.actionBtn, styles.useBtn, { backgroundColor: colors.accent }]}
                onPress={handleAccept}
              >
                <Ionicons name="checkmark" size={18} color={colors.onAccent || "#00325A"} style={{ marginRight: 6 }} />
                <Text style={[styles.btnText, { color: colors.onAccent || "#00325A", fontWeight: "700" }]}>
                  {language === "en" ? "Use Photo" : language === "uk" ? "Використати" : "Использовать"}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        ) : (
          <View style={styles.loadingBox}>
            <ActivityIndicator size="large" color={colors.accent} />
          </View>
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: "rgba(0, 0, 0, 0.75)",
    justifyContent: "center",
    alignItems: "center",
    padding: 16,
  },
  previewCard: {
    width: "100%",
    maxWidth: 420,
    maxHeight: "85%",
    borderRadius: 16,
    borderWidth: 1,
    overflow: "hidden",
    display: "flex",
    flexDirection: "column",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  headerTitle: {
    fontSize: 16,
    fontWeight: "700",
  },
  imageWrapper: {
    width: "100%",
    height: 380,
    backgroundColor: "#000",
    justifyContent: "center",
    alignItems: "center",
  },
  image: {
    width: "100%",
    height: "100%",
  },
  buttonRow: {
    flexDirection: "row",
    padding: 14,
    gap: 12,
  },
  actionBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 12,
    borderRadius: 10,
  },
  retakeBtn: {
    borderWidth: 1,
  },
  useBtn: {},
  btnText: {
    fontSize: 14,
    fontWeight: "600",
  },
  loadingBox: {
    padding: 24,
    borderRadius: 12,
    backgroundColor: "rgba(0,0,0,0.5)",
  },
});
