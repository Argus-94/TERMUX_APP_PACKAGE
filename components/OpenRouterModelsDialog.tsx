import { useState } from "react";
import {
  Modal,
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
  TextInput,
  KeyboardAvoidingView,
  Platform,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "./ThemeContext";
import { useLanguage } from "./LanguageContext";
import { NumberField } from "./NumberField";
import { FREE_OPENROUTER_MODELS } from "../lib/online-model";
import type { OnlineGenerationParams, OpenRouterModelStatus } from "../lib/online-model";
import type { AppColors } from "../theme/colors";

interface Props {
  visible: boolean;
  selectedId: string;
  onSelect: (id: string) => void;
  /** Пользовательские id/имена поверх каталога FREE_OPENROUTER_MODELS. */
  modelOverrides: Record<string, { id: string; name: string }>;
  onSaveModelOverride: (baseId: string, customId: string, customName: string) => void;
  genParams: OnlineGenerationParams;
  onChangeGenParams: (next: Partial<OnlineGenerationParams>) => void;
  onRequestClose: () => void;
  /** Статусы моделей из последней проверки (см. hooks/useAppSettings.ts →
   *  checkOpenRouterModelsNow). Отсутствующий id трактуется как "unknown". */
  modelStatus: Record<string, OpenRouterModelStatus>;
  /** true, пока идёт проверка (кнопка "Проверить модели" уже нажата). */
  checking: boolean;
  /** Время последней завершённой проверки (Date.now()) или null, если её ещё не было. */
  lastCheckedAt: number | null;
  onCheckModels: () => void;
}

/**
 * Настройки → "Модели OpenRouter": выбор одной из бесплатных моделей
 * OpenRouter (см. FREE_OPENROUTER_MODELS в lib/online-model.ts) для
 * онлайн-режима, плюс параметры генерации для неё же. Выбор и параметры
 * применяются сразу (как и остальные NumberField в Настройках) — отдельной
 * кнопки "Сохранить" не нужно, окно просто закрывается по крестику.
 */
function StatusBadge({
  status,
  t,
  colors,
}: {
  status: OpenRouterModelStatus | undefined;
  t: (key: any) => string;
  colors: AppColors;
}) {
  if (status === "working") {
    return (
      <View style={[styles.statusBadge, { backgroundColor: colors.accentDim }]}>
        <Ionicons name="checkmark-circle" size={12} color={colors.accent} />
        <Text style={[styles.statusBadgeText, { color: colors.accent }]}>{t("openRouterModelStatusWorking")}</Text>
      </View>
    );
  }
  if (status === "broken") {
    return (
      <View style={[styles.statusBadge, { backgroundColor: colors.dangerDim }]}>
        <Ionicons name="close-circle" size={12} color={colors.danger} />
        <Text style={[styles.statusBadgeText, { color: colors.danger }]}>{t("openRouterModelStatusBroken")}</Text>
      </View>
    );
  }
  if (status === "unavailable") {
    return (
      <View style={[styles.statusBadge, { backgroundColor: colors.dangerDim }]}>
        <Ionicons name="alert-circle-outline" size={12} color={colors.danger} />
        <Text style={[styles.statusBadgeText, { color: colors.danger }]}>{t("openRouterModelStatusUnavailable")}</Text>
      </View>
    );
  }
  if (status === "auth_error") {
    return (
      <View style={[styles.statusBadge, { backgroundColor: colors.dangerDim }]}> 
        <Ionicons name="key-outline" size={12} color={colors.danger} />
        <Text style={[styles.statusBadgeText, { color: colors.danger }]}>{t("openRouterModelStatusAuthError")}</Text>
      </View>
    );
  }
  if (status === "access_denied") {
    return (
      <View style={[styles.statusBadge, { backgroundColor: "rgba(251, 191, 36, 0.14)" }]}> 
        <Ionicons name="lock-closed-outline" size={12} color={colors.warning} />
        <Text style={[styles.statusBadgeText, { color: colors.warning }]}>{t("openRouterModelStatusAccessDenied")}</Text>
      </View>
    );
  }
  if (status === "limited") {
    // Дневной лимит бесплатных запросов OpenRouter (общий на весь
    // аккаунт) — НЕ то же самое, что "модель сломана", поэтому отдельный
    // цвет/иконка вместо красного "Не работает" (см. lib/online-model.ts).
    return (
      <View style={[styles.statusBadge, { backgroundColor: "rgba(251, 191, 36, 0.14)" }]}>
        <Ionicons name="time-outline" size={12} color={colors.warning} />
        <Text style={[styles.statusBadgeText, { color: colors.warning }]}>{t("openRouterModelStatusLimited")}</Text>
      </View>
    );
  }
  if (status === "rate_limited" || status === "upstream_error" || status === "network_error" || status === "timeout") {
    const labelKey = status === "rate_limited" ? "openRouterModelStatusRateLimited"
      : status === "upstream_error" ? "openRouterModelStatusUpstreamError"
        : status === "timeout" ? "openRouterModelStatusTimeout" : "openRouterModelStatusNetworkError";
    return (
      <View style={[styles.statusBadge, { backgroundColor: "rgba(251, 191, 36, 0.14)" }]}>
        <Ionicons name={status === "timeout" ? "time-outline" : "warning-outline"} size={12} color={colors.warning} />
        <Text style={[styles.statusBadgeText, { color: colors.warning }]}>{t(labelKey)}</Text>
      </View>
    );
  }
  if (status === "checking") {
    return <ActivityIndicator size="small" color={colors.muted} style={{ marginLeft: 2 }} />;
  }
  return null;
}

export function OpenRouterModelsDialog({
  visible, selectedId, onSelect, modelOverrides, onSaveModelOverride,
  genParams, onChangeGenParams, onRequestClose,
  modelStatus, checking, lastCheckedAt, onCheckModels,
}: Props) {
  const { colors } = useTheme();
  const { t, language } = useLanguage();
  const insets = useSafeAreaInsets();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editIdDraft, setEditIdDraft] = useState("");
  const [editNameDraft, setEditNameDraft] = useState("");

  const lastCheckedLabel = lastCheckedAt
    ? t("openRouterModelsLastChecked", {
        date: new Date(lastCheckedAt).toLocaleTimeString(
          language === "en" ? "en-US" : language === "ru" ? "ru-RU" : "uk-UA",
          { hour: "2-digit", minute: "2-digit" }
        ),
      })
    : t("openRouterModelsNeverChecked");

  // Если хоть одна модель в этом раунде получила статус "limited" —
  // показываем пояснительный баннер над списком, чтобы пользователь не
  // подумал, что модели сломаны (см. StatusBadge выше и лог/скриншот,
  // из-за которых появилась эта правка).
  const anyDailyLimit = Object.values(modelStatus).some((s) => s === "limited");

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onRequestClose} statusBarTranslucent>
      <KeyboardAvoidingView
        style={[styles.backdrop, { backgroundColor: "rgba(2, 6, 16, 0.74)" }]}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={Platform.OS === "ios" ? 12 : 0}
      >
        <View
          style={[
            styles.card,
            {
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
                <Text style={styles.titleEmoji}>🚀</Text>
              </View>
              <Text style={[styles.title, { color: colors.inkBright }]}>
                {t("openRouterModelsDialogTitle")}
              </Text>
            </View>
            <TouchableOpacity onPress={onRequestClose} accessibilityLabel={t("close")}>
              <Ionicons name="close" size={24} color={colors.muted} />
            </TouchableOpacity>
          </View>

          <Text style={[styles.desc, { color: colors.muted }]}>{t("openRouterModelsSectionDesc")}</Text>

          <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
            <View style={styles.listHeaderRow}>
              <Text style={[styles.sectionLabel, { color: colors.muted }]}>{t("openRouterModelsListLabel")}</Text>
              <TouchableOpacity
                style={[
                  styles.checkButton,
                  { backgroundColor: colors.accentDim, borderColor: colors.accent },
                  checking && styles.checkButtonDisabled,
                ]}
                onPress={onCheckModels}
                disabled={checking}
                activeOpacity={0.7}
              >
                {checking ? (
                  <ActivityIndicator size="small" color={colors.accent} />
                ) : (
                  <Ionicons name="refresh" size={13} color={colors.accent} />
                )}
                <Text style={[styles.checkButtonText, { color: colors.accent }]}>
                  {checking ? t("openRouterModelsChecking") : t("openRouterModelsCheckButton")}
                </Text>
              </TouchableOpacity>
            </View>
            <Text style={[styles.lastCheckedLabel, { color: colors.muted }]}>{lastCheckedLabel}</Text>
            {anyDailyLimit && (
              <View
                style={[
                  styles.dailyLimitBanner,
                  { backgroundColor: "rgba(251, 191, 36, 0.1)", borderColor: colors.warning },
                ]}
              >
                <Ionicons name="information-circle-outline" size={14} color={colors.warning} />
                <Text style={[styles.dailyLimitBannerText, { color: colors.warning }]}>
                  {t("openRouterModelsDailyLimitNotice")}
                </Text>
              </View>
            )}

            <Text style={[styles.categorySectionLabel, { color: colors.accent, marginTop: 4, marginBottom: 8 }]}>
              {t("openRouterModelsSuitableLabel")}
            </Text>

            {FREE_OPENROUTER_MODELS.filter((m) => m.suitableForChat !== false).map((model) => {
              const override = modelOverrides[model.id];
              const displayId = override?.id || model.id;
              const displayName = override?.name || model.name;
              const active = selectedId === model.id || selectedId === displayId;
              const status = modelStatus[model.id] || modelStatus[displayId];
              const isEditing = editingId === model.id;
              return (
                <View
                  key={model.id}
                  style={[
                    styles.modelRow,
                    { backgroundColor: colors.surfaceRaised, borderColor: colors.line },
                    active && { borderColor: colors.accent, backgroundColor: colors.accentDim },
                  ]}
                >
                  <View style={styles.modelRowTop}>
                    <TouchableOpacity
                      style={styles.modelRowMain}
                      onPress={() => onSelect(override?.id || model.id)}
                      activeOpacity={0.7}
                    >
                      <View style={[styles.modelRadio, { borderColor: active ? colors.accent : colors.muted }]}>
                        {active && <View style={[styles.modelRadioDot, { backgroundColor: colors.accent }]} />}
                      </View>
                      <View style={styles.modelInfo}>
                        <View style={styles.modelNameRow}>
                          <Text style={[styles.modelName, { color: colors.inkBright }]} numberOfLines={1}>
                            {displayName}
                          </Text>
                          {model.agentRecommended ? (
                            <View
                              style={[
                                styles.agentStarBadge,
                                { backgroundColor: colors.accentDim, borderColor: colors.accent },
                              ]}
                            >
                              <Text style={[styles.agentStarText, { color: colors.accent }]}>
                                ★ {t("openRouterModelAgentBadge")}
                              </Text>
                            </View>
                          ) : null}
                        </View>
                        <Text style={[styles.modelMeta, { color: colors.muted }]} numberOfLines={1}>
                          {displayId}
                          {model.vision ? ` · ${t("openRouterModelVisionBadge")}` : ""}
                        </Text>
                      </View>
                    </TouchableOpacity>
                    <View style={styles.modelRowActions}>
                      <StatusBadge status={checking && !status ? "checking" : status} t={t} colors={colors} />
                      <TouchableOpacity
                        style={[styles.editBtn, { backgroundColor: colors.accentDim }]}
                        onPress={() => {
                          if (isEditing) {
                            setEditingId(null);
                          } else {
                            setEditingId(model.id);
                            setEditIdDraft(displayId);
                            setEditNameDraft(displayName);
                          }
                        }}
                        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                      >
                        <Text style={[styles.editBtnText, { color: colors.accent }]}>{t("modelEdit")}</Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                  {isEditing && (
                    <View style={[styles.editPanel, { borderTopColor: colors.line }]}>
                      <Text style={[styles.editLabel, { color: colors.muted }]}>{t("modelEditIdLabel")}</Text>
                      <TextInput
                        style={[
                          styles.editInput,
                          { backgroundColor: colors.inputBg, borderColor: colors.line, color: colors.inkBright },
                        ]}
                        value={editIdDraft}
                        onChangeText={setEditIdDraft}
                        autoCapitalize="none"
                        autoCorrect={false}
                        placeholder={model.id}
                        placeholderTextColor={colors.footerMuted}
                      />
                      <Text style={[styles.editLabel, { color: colors.muted }]}>{t("modelEditNameLabel")}</Text>
                      <TextInput
                        style={[
                          styles.editInput,
                          { backgroundColor: colors.inputBg, borderColor: colors.line, color: colors.inkBright },
                        ]}
                        value={editNameDraft}
                        onChangeText={setEditNameDraft}
                        placeholder={model.name}
                        placeholderTextColor={colors.footerMuted}
                      />
                      <TouchableOpacity
                        style={[styles.saveBtn, { backgroundColor: colors.accent }]}
                        onPress={() => {
                          onSaveModelOverride(model.id, editIdDraft, editNameDraft);
                          setEditingId(null);
                        }}
                      >
                        <Text style={[styles.saveBtnText, { color: colors.onAccent }]}>
                          {t("modelEditSave")}
                        </Text>
                      </TouchableOpacity>
                    </View>
                  )}
                </View>
              );
            })}

            {FREE_OPENROUTER_MODELS.some((m) => m.suitableForChat === false) && (
              <View style={[styles.unsuitableSectionWrap, { borderTopColor: colors.line }]}>
                <View style={styles.unsuitableSectionHeader}>
                  <Ionicons name="warning-outline" size={15} color={colors.warning} />
                  <Text style={[styles.unsuitableSectionLabel, { color: colors.warning }]}>
                    {t("openRouterModelsUnsuitableLabel")}
                  </Text>
                </View>
                <Text style={[styles.unsuitableSectionDesc, { color: colors.muted }]}>
                  {t("openRouterModelsUnsuitableDesc")}
                </Text>
                {FREE_OPENROUTER_MODELS.filter((m) => m.suitableForChat === false).map((model) => {
                  const override = modelOverrides[model.id];
                  const displayId = override?.id || model.id;
                  const displayName = override?.name || model.name;
                  const active = selectedId === model.id || selectedId === displayId;
                  const status = modelStatus[model.id] || modelStatus[displayId];
                  const isEditing = editingId === model.id;
                  const lang = language === "en" ? "en" : language === "uk" ? "uk" : "ru";
                  const reason = model.unsuitableReason?.[lang] || model.unsuitableReason?.ru || "";
                  return (
                    <View
                      key={model.id}
                      style={[
                        styles.modelRow,
                        styles.unsuitableModelRow,
                        { backgroundColor: colors.surfaceRaised, borderColor: colors.line },
                        active && { borderColor: colors.warning, backgroundColor: "rgba(251, 191, 36, 0.08)" },
                      ]}
                    >
                      <View style={styles.modelRowTop}>
                        <TouchableOpacity
                          style={styles.modelRowMain}
                          onPress={() => onSelect(override?.id || model.id)}
                          activeOpacity={0.7}
                        >
                          <View style={[styles.modelRadio, { borderColor: active ? colors.warning : colors.muted }]}>
                            {active && <View style={[styles.modelRadioDot, { backgroundColor: colors.warning }]} />}
                          </View>
                          <View style={styles.modelInfo}>
                            <View style={styles.modelNameRow}>
                              <Text style={[styles.modelName, { color: colors.inkBright }]} numberOfLines={1}>
                                {displayName}
                              </Text>
                              <View
                                style={[
                                  styles.unsuitableBadge,
                                  { backgroundColor: "rgba(251, 191, 36, 0.14)", borderColor: colors.warning },
                                ]}
                              >
                                <Text style={[styles.unsuitableBadgeText, { color: colors.warning }]}>
                                  ⚠️ {t("openRouterModelUnsuitableBadge")}
                                </Text>
                              </View>
                            </View>
                            <Text style={[styles.modelMeta, { color: colors.muted }]} numberOfLines={1}>
                              {displayId}
                              {model.vision ? ` · ${t("openRouterModelVisionBadge")}` : ""}
                            </Text>
                            {reason ? (
                              <Text style={[styles.unsuitableReasonText, { color: colors.warning }]}>
                                {reason}
                              </Text>
                            ) : null}
                          </View>
                        </TouchableOpacity>
                        <View style={styles.modelRowActions}>
                          <StatusBadge status={checking && !status ? "checking" : status} t={t} colors={colors} />
                          <TouchableOpacity
                            style={[styles.editBtn, { backgroundColor: colors.accentDim }]}
                            onPress={() => {
                              if (isEditing) {
                                setEditingId(null);
                              } else {
                                setEditingId(model.id);
                                setEditIdDraft(displayId);
                                setEditNameDraft(displayName);
                              }
                            }}
                            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                          >
                            <Text style={[styles.editBtnText, { color: colors.accent }]}>{t("modelEdit")}</Text>
                          </TouchableOpacity>
                        </View>
                      </View>
                      {isEditing && (
                        <View style={[styles.editPanel, { borderTopColor: colors.line }]}>
                          <Text style={[styles.editLabel, { color: colors.muted }]}>{t("modelEditIdLabel")}</Text>
                          <TextInput
                            style={[
                              styles.editInput,
                              { backgroundColor: colors.inputBg, borderColor: colors.line, color: colors.inkBright },
                            ]}
                            value={editIdDraft}
                            onChangeText={setEditIdDraft}
                            autoCapitalize="none"
                            autoCorrect={false}
                            placeholder={model.id}
                            placeholderTextColor={colors.footerMuted}
                          />
                          <Text style={[styles.editLabel, { color: colors.muted }]}>{t("modelEditNameLabel")}</Text>
                          <TextInput
                            style={[
                              styles.editInput,
                              { backgroundColor: colors.inputBg, borderColor: colors.line, color: colors.inkBright },
                            ]}
                            value={editNameDraft}
                            onChangeText={setEditNameDraft}
                            placeholder={model.name}
                            placeholderTextColor={colors.footerMuted}
                          />
                          <TouchableOpacity
                            style={[styles.saveBtn, { backgroundColor: colors.accent }]}
                            onPress={() => {
                              onSaveModelOverride(model.id, editIdDraft, editNameDraft);
                              setEditingId(null);
                            }}
                          >
                            <Text style={[styles.saveBtnText, { color: colors.onAccent }]}>
                              {t("modelEditSave")}
                            </Text>
                          </TouchableOpacity>
                        </View>
                      )}
                    </View>
                  );
                })}
              </View>
            )}


            <View style={[styles.divider, { backgroundColor: colors.line }]} />
            <Text style={[styles.sectionLabel, { color: colors.muted }]}>{t("openRouterModelsGenParamsLabel")}</Text>
            <NumberField
              label={t("temperature")}
              value={genParams.temperature}
              step={0.1}
              min={0}
              max={1.5}
              format={(v) => v.toFixed(1)}
              onChange={(v) => onChangeGenParams({ temperature: v })}
            />
            <NumberField
              label={t("maxTokens")}
              value={genParams.maxTokens}
              step={128}
              min={128}
              max={4096}
              onChange={(v) => onChangeGenParams({ maxTokens: v })}
            />
            <NumberField
              label={t("topP")}
              value={genParams.topP}
              step={0.05}
              min={0.1}
              max={1}
              format={(v) => v.toFixed(2)}
              onChange={(v) => onChangeGenParams({ topP: v })}
            />
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 14,
  },
  card: {
    width: "100%",
    maxWidth: 520,
    maxHeight: "88%",
    borderRadius: 16,
    borderWidth: 1,
    overflow: "hidden",
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
  titleWrap: { flexDirection: "row", alignItems: "center", gap: 10, flex: 1 },
  titleIcon: {
    width: 38,
    height: 38,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  titleEmoji: { fontSize: 21 },
  title: { fontSize: 19, fontWeight: "800" },
  desc: { fontSize: 13, lineHeight: 20, marginLeft: 20, marginRight: 20, marginTop: 12 },
  scroll: { marginTop: 0 },
  scrollContent: { paddingHorizontal: 20, paddingVertical: 12, paddingBottom: 4, gap: 12 },
  sectionLabel: { fontSize: 12, fontWeight: "700" },
  listHeaderRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  checkButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    borderRadius: 10,
    borderWidth: 1,
    paddingHorizontal: 9,
    paddingVertical: 4,
  },
  checkButtonDisabled: { opacity: 0.6 },
  checkButtonText: { fontSize: 11, fontWeight: "700" },
  lastCheckedLabel: { fontSize: 10.5, marginBottom: 6 },
  statusBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    paddingHorizontal: 6,
    paddingVertical: 3,
    borderRadius: 8,
  },
  statusBadgeText: { fontSize: 10, fontWeight: "700" },
  dailyLimitBanner: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 6,
    borderRadius: 10,
    borderWidth: 1,
    padding: 9,
    marginBottom: 8,
  },
  dailyLimitBannerText: { fontSize: 11, lineHeight: 15, flex: 1 },
  modelRow: {
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  modelRowTop: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  modelRowMain: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    minWidth: 0,
  },
  modelRowActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    flexShrink: 0,
  },
  modelRadio: {
    width: 18, height: 18, borderRadius: 9,
    borderWidth: 1.5,
    alignItems: "center", justifyContent: "center",
    flexShrink: 0,
  },
  modelRadioDot: { width: 9, height: 9, borderRadius: 5 },
  modelInfo: { flex: 1, minWidth: 0 },
  modelNameRow: { flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" },
  modelName: { fontSize: 13.5, fontWeight: "600", flexShrink: 1 },
  agentStarBadge: {
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 1,
  },
  agentStarText: { fontSize: 10, fontWeight: "700" },
  modelMeta: { fontSize: 11, marginTop: 2 },
  editBtn: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
  },
  editBtnText: { fontSize: 11, fontWeight: "700" },
  editPanel: {
    marginTop: 10,
    paddingTop: 10,
    borderTopWidth: 1,
    gap: 6,
  },
  editLabel: { fontSize: 11, fontWeight: "600" },
  editInput: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 13,
  },
  saveBtn: {
    marginTop: 4,
    alignSelf: "flex-end",
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 10,
  },
  saveBtnText: { fontSize: 13, fontWeight: "700" },
  divider: { height: 1, marginVertical: 10 },
  categorySectionLabel: {
    fontSize: 12,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  unsuitableSectionWrap: {
    marginTop: 16,
    paddingTop: 12,
    borderTopWidth: 1,
    gap: 8,
  },
  unsuitableSectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  unsuitableSectionLabel: {
    fontSize: 12,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  unsuitableSectionDesc: {
    fontSize: 11,
    lineHeight: 15,
    marginBottom: 4,
  },
  unsuitableModelRow: {
    borderStyle: "dashed",
  },
  unsuitableBadge: {
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 1,
  },
  unsuitableBadgeText: {
    fontSize: 10,
    fontWeight: "700",
  },
  unsuitableReasonText: {
    fontSize: 10.5,
    marginTop: 3,
    lineHeight: 14,
    fontStyle: "italic",
  },
});
