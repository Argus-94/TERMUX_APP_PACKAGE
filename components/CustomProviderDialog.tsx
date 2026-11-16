import { useCallback, useRef, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "./ThemeContext";
import { useLanguage } from "./LanguageContext";
import { classifyProviderProbeError, providerProbeMessageKey, providerProbeRetryAfterMs, providerProbeTone, type ProviderProbeStatus } from "../lib/provider-probe-status";
import {
  fetchCustomProviderModels,
  probeCustomProviderModels,
  probeCustomProviderChat,
  groupProviderModels,
  filterChatModels,
  type FetchedModel,
  type GroupedProviderModels,
} from "../lib/custom-provider";

export interface CustomProviderConfig {
  name: string;
  baseUrl: string;
  modelId: string;
  apiKey: string;
  extraHeadersJson: string;
  /** Override chat endpoint path, default /chat/completions */
  chatPath?: string;
}

interface CustomProviderDialogProps {
  visible: boolean;
  onClose: () => void;
  config: CustomProviderConfig;
  onConfigChange: (config: Partial<CustomProviderConfig>) => void;
  onSave: (config: CustomProviderConfig) => void | boolean | Promise<void | boolean>;
  isLoading?: boolean;
  providerId: string;
  hasApiKey: boolean;
}

export function CustomProviderDialog({
  visible,
  onClose,
  config,
  onConfigChange,
  onSave,
  isLoading = false,
  providerId,
  hasApiKey,
}: CustomProviderDialogProps) {
  const { colors } = useTheme();
  const { t, language } = useLanguage();
  const insets = useSafeAreaInsets();
  const operationLock = useRef(false);
  const [showKey, setShowKey] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [savingSecure, setSavingSecure] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [fetchedModels, setFetchedModels] = useState<FetchedModel[]>([]);
  const [groupedModels, setGroupedModels] = useState<GroupedProviderModels>({
    free: [],
    paid: [],
    unsuitable: [],
  });
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<string>("");
  const [checkingKey, setCheckingKey] = useState(false);
  const [keyCheckResult, setKeyCheckResult] = useState<{ status: ProviderProbeStatus; message: string } | null>(null);

  const handleCheckKey = useCallback(async () => {
    // Check key needs only Base URL + API key. Model list is loaded on success;
    // Model ID is optional (auto-selected from list). Chat probe runs only if modelId already set.
    if (!config.apiKey.trim() && !hasApiKey) {
      setErrors((e) => ({ ...e, apiKey: t("customProviderKeyRequired") }));
      setKeyCheckResult({ status: "empty_key", message: t("apiKeyEmpty") });
      return;
    }
    if (!config.baseUrl.trim()) {
      setErrors((e) => ({ ...e, baseUrl: t("customProviderUrlRequired") }));
      setKeyCheckResult({ status: "request_error", message: t("customProviderUrlRequired") });
      return;
    }
    if (operationLock.current || isLoading || savingSecure || modelsLoading) return;
    operationLock.current = true;
    setCheckingKey(true);
    setKeyCheckResult(null);
    setModelsError("");
    try {
      const draftKey = config.apiKey.trim();
      // 1) Validate key via /models and fill the model list (same as «Получить список моделей»)
      let models: FetchedModel[] = [];
      try {
        const modelConfig = { baseUrl: config.baseUrl, providerId, extraHeadersJson: config.extraHeadersJson };
        models = draftKey
          ? await probeCustomProviderModels({ ...modelConfig, credential: draftKey })
          : await fetchCustomProviderModels(modelConfig);
      } catch (e) {
        const status = classifyProviderProbeError(e, "endpoint");
        const retryAfterMs = providerProbeRetryAfterMs(e);
        setKeyCheckResult({ status, message: retryAfterMs ? `${t(providerProbeMessageKey(status))} · ${Math.ceil(retryAfterMs / 1000)}s` : t(providerProbeMessageKey(status)) });
        setFetchedModels([]);
        setGroupedModels({ free: [], paid: [], unsuitable: [] });
        return;
      }
      const chatModels = filterChatModels(models);
      const grouped = groupProviderModels(models);
      setGroupedModels(grouped);
      setFetchedModels(chatModels);
      setKeyCheckResult({ status: "key_valid", message: t("providerCheckCredentialAccepted") });
      setModelsError(chatModels.length === 0 ? t("providerCheckNoChatModels") : "");

      // Auto-pick first free/chat model if Model ID empty or not in list
      let selectedId = config.modelId.trim();
      if (chatModels.length > 0) {
        if (!selectedId || !chatModels.some((m) => m.id === selectedId)) {
          const firstFree = chatModels.find((m) => grouped.free.some((f) => f.id === m.id)) || chatModels[0];
          selectedId = firstFree.id;
          onConfigChange({ modelId: selectedId });
        }
        setErrors((e) => ({ ...e, modelId: "" }));
      }

      // 2) Optional real /chat/completions probe when we have a model id
      if (selectedId && !draftKey) {
        try {
          const probe = await probeCustomProviderChat({
            baseUrl: config.baseUrl,
            providerId,
            modelId: selectedId,
            chatPath: config.chatPath,
            extraHeadersJson: config.extraHeadersJson,
          });
          if (probe.ok) setModelsError("");
          else setModelsError(probe.retryAfterMs ? `${t(providerProbeMessageKey(probe.status))} · ${Math.ceil(probe.retryAfterMs / 1000)}s` : t(providerProbeMessageKey(probe.status)));
        } catch (e) {
          const status = classifyProviderProbeError(e, "model");
          setModelsError(t(providerProbeMessageKey(status)));
        }
      }
    } catch (e) {
      const status = classifyProviderProbeError(e, "endpoint");
      setKeyCheckResult({ status, message: t(providerProbeMessageKey(status)) });
    } finally {
      setCheckingKey(false);
      operationLock.current = false;
    }
  }, [config.baseUrl, config.apiKey, config.modelId, config.chatPath, config.extraHeadersJson, providerId, hasApiKey, onConfigChange, t, isLoading, savingSecure, modelsLoading]);

  const handleFetchModels = useCallback(async () => {
    if (!config.baseUrl.trim()) {
      setErrors((e) => ({ ...e, baseUrl: t("customProviderUrlRequired") }));
      return;
    }
    if (operationLock.current || isLoading || savingSecure || checkingKey) return;
    operationLock.current = true;
    setModelsLoading(true);
    setModelsError("");
    try {
      const draftKey = config.apiKey.trim();
      if (!draftKey && !hasApiKey) {
        setModelsError(t("customProviderKeyRequired"));
        return;
      }
      const modelConfig = { baseUrl: config.baseUrl, providerId, extraHeadersJson: config.extraHeadersJson };
      const models = draftKey
        ? await probeCustomProviderModels({ ...modelConfig, credential: draftKey })
        : await fetchCustomProviderModels(modelConfig);
      const chatModels = filterChatModels(models);
      const grouped = groupProviderModels(models);
      setGroupedModels(grouped);
      // В «рабочий» список — только chat (free + paid); unsuitable показываем отдельно.
      setFetchedModels(chatModels);
      if (chatModels.length === 0) {
        setModelsError(
          t("providerCheckNoChatModels")
        );
      } else if (!chatModels.some((m) => m.id === config.modelId)) {
        const firstFree = chatModels.find((m) => grouped.free.some((f) => f.id === m.id)) || chatModels[0];
        onConfigChange({ modelId: firstFree.id });
        if (errors.modelId) setErrors({ ...errors, modelId: "" });
      }
    } catch (e) {
      setFetchedModels([]);
      setGroupedModels({ free: [], paid: [], unsuitable: [] });
      const status = classifyProviderProbeError(e, "endpoint");
      const retryAfterMs = providerProbeRetryAfterMs(e);
      setModelsError(retryAfterMs ? `${t(providerProbeMessageKey(status))} · ${Math.ceil(retryAfterMs / 1000)}s` : t(providerProbeMessageKey(status)));
    } finally {
      setModelsLoading(false);
      operationLock.current = false;
    }
  }, [config.baseUrl, config.apiKey, config.modelId, config.extraHeadersJson, providerId, hasApiKey, t, isLoading, savingSecure, checkingKey]);

  const validateConfig = useCallback((): boolean => {
    const newErrors: Record<string, string> = {};
    if (!config.name.trim()) newErrors.name = t("customProviderNameRequired");
    if (!config.baseUrl.trim()) newErrors.baseUrl = t("customProviderUrlRequired");
    if (!config.modelId.trim()) newErrors.modelId = t("customProviderModelRequired");
    if (!config.apiKey.trim() && !hasApiKey) newErrors.apiKey = t("customProviderKeyRequired");
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  }, [config, hasApiKey, t]);

  const handleSave = useCallback(async () => {
    if (!validateConfig()) return;
    if (operationLock.current || isLoading) return;
    operationLock.current = true;
    setSavingSecure(true);
    setSaveError("");
    try {
      const saved = await onSave(config);
      if (saved === false) { setSaveError(t("secureKeySaveFailed")); return; }
      onClose();
    } catch {
      setSaveError(t("secureKeySaveFailed"));
    } finally {
      setSavingSecure(false);
      operationLock.current = false;
    }
  }, [config, isLoading, onClose, onSave, t, validateConfig]);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      statusBarTranslucent
      onRequestClose={() => { if (!operationLock.current && !isLoading) onClose(); }}
    >
      <KeyboardAvoidingView
        style={styles.overlay}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={Platform.OS === "ios" ? 12 : 0}
      >
        <View
          style={[
            styles.dialog,
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
                <Text style={styles.titleEmoji}>⚙️</Text>
              </View>
              <Text style={[styles.title, { color: colors.inkBright }]}>
                {t("customProviderTitle")}
              </Text>
            </View>
            <TouchableOpacity
              onPress={onClose}
              disabled={isLoading || savingSecure || checkingKey || modelsLoading}
              style={styles.closeButton}
              accessibilityRole="button"
              accessibilityLabel={t("close")}
            >
              <Ionicons name="close" size={24} color={colors.muted} />
            </TouchableOpacity>
          </View>

          <ScrollView
            style={styles.content}
            contentContainerStyle={styles.contentContainer}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
            bounces={false}
          >
            <View
              style={[
                styles.infoCard,
                { backgroundColor: colors.surfaceRaised, borderColor: colors.line },
              ]}
            >
              <Text style={[styles.infoTitle, { color: colors.inkBright }]}>
                {t("customProviderInfo")}
              </Text>
              <Text style={[styles.infoText, { color: colors.ink }]}>
                {t("customProviderDescription")}
              </Text>
              <View style={styles.specs}>
                <Text style={[styles.spec, { color: colors.muted }]}>
                  ✓ {t("customProviderAnyApi")}
                </Text>
                <Text style={[styles.spec, { color: colors.muted }]}>
                  ✓ {t("customProviderCustomHeaders")}
                </Text>
                <Text style={[styles.spec, { color: colors.muted }]}>
                  ✓ {t("customProviderFlexible")}
                </Text>
              </View>
            </View>

            {/* Provider Name */}
            <View style={styles.section}>
              <Text style={[styles.label, { color: colors.inkBright }]}>
                {t("customProviderName")} *
              </Text>
              <View
                style={[
                  styles.inputContainer,
                  { borderColor: errors.name ? colors.warning : colors.line, backgroundColor: colors.inputBg },
                ]}
              >
                <TextInput
                  style={[styles.input, { color: colors.inkBright }]}
                  placeholder={t("customProviderNamePlaceholder")}
                  placeholderTextColor={colors.footerMuted}
                  value={config.name}
                  onChangeText={(value) => {
                    onConfigChange({ name: value });
                    if (errors.name) setErrors({ ...errors, name: "" });
                  }}
                  editable={!isLoading && !checkingKey && !modelsLoading && !savingSecure}
                  autoCapitalize="words"
                />
              </View>
              {errors.name && <Text style={[styles.errorText, { color: colors.warning }]}>{errors.name}</Text>}
            </View>

            {/* Base URL */}
            <View style={styles.section}>
              <Text style={[styles.label, { color: colors.inkBright }]}>
                {t("customProviderBaseUrl")} *
              </Text>
              <View
                style={[
                  styles.inputContainer,
                  { borderColor: errors.baseUrl ? colors.warning : colors.line, backgroundColor: colors.inputBg },
                ]}
              >
                <TextInput
                  style={[styles.input, { color: colors.inkBright }]}
                  placeholder="https://api.example.com/v1"
                  placeholderTextColor={colors.footerMuted}
                  value={config.baseUrl}
                  onChangeText={(value) => {
                    onConfigChange({ baseUrl: value });
                    if (errors.baseUrl) setErrors({ ...errors, baseUrl: "" });
                  }}
                  editable={!isLoading && !checkingKey && !modelsLoading && !savingSecure}
                  autoCapitalize="none"
                  autoCorrect={false}
                  autoComplete="off"
                />
              </View>
              {errors.baseUrl && (
                <Text style={[styles.errorText, { color: colors.warning }]}>{errors.baseUrl}</Text>
              )}
            </View>

            {/* Chat path override */}
            <View style={styles.section}>
              <Text style={[styles.label, { color: colors.inkBright }]}>
                {t("customProviderChatPath")}
              </Text>
              <View
                style={[
                  styles.inputContainer,
                  { borderColor: colors.line, backgroundColor: colors.inputBg },
                ]}
              >
                <TextInput
                  style={[styles.input, { color: colors.inkBright }]}
                  placeholder="/chat/completions"
                  placeholderTextColor={colors.footerMuted}
                  value={config.chatPath || "/chat/completions"}
                  onChangeText={(value) => {
                    onConfigChange({ chatPath: value.trim() || "/chat/completions" });
                  }}
                  editable={!isLoading && !checkingKey && !modelsLoading && !savingSecure}
                  autoCapitalize="none"
                  autoCorrect={false}
                  autoComplete="off"
                />
              </View>
              <Text style={[styles.helperText, { color: colors.muted }]}>
                {t("customProviderChatPathHint")}
              </Text>
            </View>

            {/* Model ID */}
            <View style={styles.section}>
              <Text style={[styles.label, { color: colors.inkBright }]}>
                {t("customProviderModelId")} *
              </Text>
              <View
                style={[
                  styles.inputContainer,
                  { borderColor: errors.modelId ? colors.warning : colors.line, backgroundColor: colors.inputBg },
                ]}
              >
                <TextInput
                  style={[styles.input, { color: colors.inkBright }]}
                  placeholder="model-id"
                  placeholderTextColor={colors.footerMuted}
                  value={config.modelId}
                  onChangeText={(value) => {
                    onConfigChange({ modelId: value });
                    if (errors.modelId) setErrors({ ...errors, modelId: "" });
                  }}
                  editable={!isLoading && !checkingKey && !modelsLoading && !savingSecure}
                  autoCapitalize="none"
                  autoCorrect={false}
                />
              </View>
              {errors.modelId && (
                <Text style={[styles.errorText, { color: colors.warning }]}>{errors.modelId}</Text>
              )}
            </View>

            {/* Fetch models */}
            <View style={styles.section}>
              <TouchableOpacity
                style={[
                  styles.fetchButton,
                  { borderColor: colors.accent, backgroundColor: colors.accentDim, opacity: modelsLoading ? 0.7 : 1 },
                ]}
                onPress={handleFetchModels}
                disabled={modelsLoading || checkingKey || savingSecure || isLoading}
                activeOpacity={0.8}
              >
                {modelsLoading ? (
                  <ActivityIndicator color={colors.accent} size="small" />
                ) : (
                  <Ionicons name="refresh" size={16} color={colors.accent} />
                )}
                <Text style={[styles.fetchButtonText, { color: colors.accent }]}>
                  {modelsLoading ? t("customProviderFetchingModels") : t("customProviderFetchModels")}
                </Text>
              </TouchableOpacity>
              <Text style={[styles.helperText, { color: colors.muted }]}>
                {t("customProviderModelsHint")}
              </Text>
              {!!modelsError && (
                <Text style={[styles.errorText, { color: colors.warning }]}>{modelsError}</Text>
              )}
              {(groupedModels.free.length > 0 ||
                groupedModels.paid.length > 0 ||
                groupedModels.unsuitable.length > 0) && (
                <>
                  <Text style={[styles.helperText, { color: colors.muted }]}>
                    {t("customProviderModelsListTitle")}
                  </Text>

                  {groupedModels.free.length > 0 && (
                    <View style={{ marginTop: 8 }}>
                      <Text style={[styles.groupLabel, { color: colors.accent }]}>
                        {language === "en"
                          ? `Free (${groupedModels.free.length})`
                          : language === "uk"
                            ? `Безкоштовні (${groupedModels.free.length})`
                            : `Бесплатные (${groupedModels.free.length})`}
                      </Text>
                      <View style={styles.modelChips}>
                        {groupedModels.free.map((m) => {
                          const selected = config.modelId === m.id;
                          return (
                            <TouchableOpacity
                              key={m.id}
                              style={[
                                styles.modelChip,
                                {
                                  borderColor: selected ? colors.accent : colors.line,
                                  backgroundColor: selected ? colors.accentDim : colors.inputBg,
                                },
                              ]}
                              onPress={() => {
                                onConfigChange({ modelId: m.id });
                                if (errors.modelId) setErrors({ ...errors, modelId: "" });
                              }}
                              activeOpacity={0.75}
                            >
                              <Text
                                style={[styles.modelChipText, { color: selected ? colors.accent : colors.ink }]}
                                numberOfLines={1}
                              >
                                {m.name || m.id}
                              </Text>
                            </TouchableOpacity>
                          );
                        })}
                      </View>
                    </View>
                  )}

                  {groupedModels.paid.length > 0 && (
                    <View style={{ marginTop: 10 }}>
                      <Text style={[styles.groupLabel, { color: colors.inkBright }]}>
                        {language === "en"
                          ? `Paid (${groupedModels.paid.length})`
                          : language === "uk"
                            ? `Платні (${groupedModels.paid.length})`
                            : `Платные (${groupedModels.paid.length})`}
                      </Text>
                      <View style={styles.modelChips}>
                        {groupedModels.paid.map((m) => {
                          const selected = config.modelId === m.id;
                          return (
                            <TouchableOpacity
                              key={m.id}
                              style={[
                                styles.modelChip,
                                {
                                  borderColor: selected ? colors.accent : colors.line,
                                  backgroundColor: selected ? colors.accentDim : colors.inputBg,
                                },
                              ]}
                              onPress={() => {
                                onConfigChange({ modelId: m.id });
                                if (errors.modelId) setErrors({ ...errors, modelId: "" });
                              }}
                              activeOpacity={0.75}
                            >
                              <Text
                                style={[styles.modelChipText, { color: selected ? colors.accent : colors.ink }]}
                                numberOfLines={1}
                              >
                                {m.name || m.id}
                              </Text>
                            </TouchableOpacity>
                          );
                        })}
                      </View>
                    </View>
                  )}

                  {groupedModels.unsuitable.length > 0 && (
                    <View style={{ marginTop: 10 }}>
                      <Text style={[styles.groupLabel, { color: colors.warning }]}>
                        {language === "en"
                          ? `Not for Termux / chat (${groupedModels.unsuitable.length})`
                          : language === "uk"
                            ? `Не для Termux / чату (${groupedModels.unsuitable.length})`
                            : `Не для Termux / чата (${groupedModels.unsuitable.length})`}
                      </Text>
                      <Text style={[styles.helperText, { color: colors.muted, marginBottom: 4 }]}>
                        {language === "en"
                          ? "Image, embeddings, audio — not suitable for chat or Termux agent."
                          : language === "uk"
                            ? "Image, embeddings, audio — не підходять для чату та Termux-агента."
                            : "Image, embeddings, audio — не подходят для чата и Termux-агента."}
                      </Text>
                      <View style={styles.modelChips}>
                        {groupedModels.unsuitable.map((m) => (
                          <View
                            key={m.id}
                            style={[
                              styles.modelChip,
                              {
                                borderColor: colors.line,
                                backgroundColor: colors.inputBg,
                                opacity: 0.55,
                              },
                            ]}
                          >
                            <Text
                              style={[styles.modelChipText, { color: colors.muted }]}
                              numberOfLines={1}
                            >
                              {m.name || m.id}
                            </Text>
                          </View>
                        ))}
                      </View>
                    </View>
                  )}
                </>
              )}
            </View>

            {/* API Key */}
            <View style={styles.section}>
              <Text style={[styles.label, { color: colors.inkBright }]}>
                {t("customProviderApiKey")}{hasApiKey ? "" : " *"}
              </Text>
              <View
                style={[
                  styles.inputContainer,
                  { borderColor: errors.apiKey ? colors.warning : colors.line, backgroundColor: colors.inputBg },
                ]}
              >
                <TextInput
                  style={[styles.input, { color: colors.inkBright }]}
                  placeholder={hasApiKey ? "Saved securely · enter to replace" : "sk-..."}
                  placeholderTextColor={colors.footerMuted}
                  value={config.apiKey}
                  onChangeText={(value) => {
                    onConfigChange({ apiKey: value });
                    if (errors.apiKey) setErrors({ ...errors, apiKey: "" });
                    setKeyCheckResult(null);
                  }}
                  secureTextEntry={!showKey}
                  editable={!isLoading && !checkingKey && !modelsLoading && !savingSecure}
                  autoCapitalize="none"
                  autoCorrect={false}
                  autoComplete="off"
                  spellCheck={false}
                />
                <TouchableOpacity
                  onPress={() => setShowKey((v) => !v)}
                  style={styles.eyeButton}
                  disabled={isLoading}
                  accessibilityRole="button"
                  accessibilityLabel={showKey ? t("hide") : t("show")}
                >
                  <Ionicons name={showKey ? "eye" : "eye-off"} size={21} color={colors.muted} />
                </TouchableOpacity>
              </View>
              {errors.apiKey && (
                <Text style={[styles.errorText, { color: colors.warning }]}>{errors.apiKey}</Text>
              )}
              <TouchableOpacity
                style={[
                  styles.fetchButton,
                  { borderColor: colors.accent, backgroundColor: colors.accentDim, opacity: checkingKey ? 0.7 : 1, marginTop: 8 },
                ]}
                onPress={handleCheckKey}
                disabled={checkingKey || modelsLoading || savingSecure || isLoading}
                activeOpacity={0.8}
              >
                {checkingKey ? (
                  <ActivityIndicator color={colors.accent} size="small" />
                ) : (
                  <Ionicons name="checkmark-circle-outline" size={16} color={colors.accent} />
                )}
                <Text style={[styles.fetchButtonText, { color: colors.accent }]}>
                  {checkingKey ? t("checkingApiKey") : t("checkApiKey")}
                </Text>
              </TouchableOpacity>
              {keyCheckResult && (
                <Text style={[styles.helperText, { color: providerProbeTone(keyCheckResult.status) === "success" ? colors.success : providerProbeTone(keyCheckResult.status) === "danger" ? colors.danger : colors.warning }]}>
                  {keyCheckResult.message}
                </Text>
              )}
            </View>

            {/* Custom Headers */}
            <View style={styles.section}>
              <Text style={[styles.label, { color: colors.inkBright }]}>
                {t("customProviderHeaders")}
              </Text>
              <Text style={[styles.helperText, { color: colors.muted }]}>
                {t("customProviderHeadersHelper")}
              </Text>
              <View
                style={[
                  styles.textAreaContainer,
                  { borderColor: colors.line, backgroundColor: colors.inputBg },
                ]}
              >
                <TextInput
                  style={[styles.textArea, { color: colors.inkBright }]}
                  placeholder={t("customProviderHeadersPlaceholder")}
                  placeholderTextColor={colors.footerMuted}
                  value={config.extraHeadersJson}
                  onChangeText={(value) => onConfigChange({ extraHeadersJson: value })}
                  editable={!isLoading && !checkingKey && !modelsLoading && !savingSecure}
                  multiline
                  textAlignVertical="top"
                  autoCapitalize="none"
                  autoCorrect={false}
                />
              </View>
            </View>

            <View
              style={[
                styles.warningCard,
                {
                  backgroundColor: colors.surfaceRaised,
                  borderColor: colors.line,
                  borderLeftColor: colors.warning,
                },
              ]}
            >
              <View style={[styles.warningIcon, { backgroundColor: colors.accentDim }]}>
                <Ionicons name="information" size={17} color={colors.accent} />
              </View>
              <View style={styles.warningBody}>
                <Text style={[styles.warningTitle, { color: colors.warning }]}>
                  {t("customProviderWarningTitle")}
                </Text>
                <Text style={[styles.warningText, { color: colors.muted }]}>
                  {t("customProviderWarningText")}
                </Text>
              </View>
            </View>
          </ScrollView>

          {saveError ? <Text style={[styles.saveError, { color: colors.danger }]}>{saveError}</Text> : null}
          <View style={[styles.footer, { borderTopColor: colors.line }]}>
            <TouchableOpacity
              style={[styles.footerButton, styles.cancelButton, { borderColor: colors.line }]}
              onPress={onClose}
              disabled={isLoading || savingSecure || checkingKey || modelsLoading}
              activeOpacity={0.75}
            >
              <Text style={[styles.footerText, { color: colors.muted }]}>{t("cancel")}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[
                styles.footerButton,
                styles.saveButton,
                { backgroundColor: colors.accent, opacity: isLoading || savingSecure || checkingKey || modelsLoading ? 0.55 : 1 },
              ]}
              onPress={handleSave}
              disabled={isLoading || savingSecure || checkingKey || modelsLoading}
              activeOpacity={0.8}
            >
              {isLoading || savingSecure ? (
                <ActivityIndicator color={colors.onAccent || "#00325A"} size="small" />
              ) : (
                <Ionicons name="checkmark" size={18} color={colors.onAccent || "#00325A"} />
              )}
              <Text style={[styles.footerText, { color: colors.onAccent || "#00325A" }]}>{t("customProviderSaveKey")}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 14,
    backgroundColor: "rgba(2, 6, 16, 0.74)",
  },
  dialog: {
    width: "100%",
    maxWidth: 520,
    maxHeight: "90%",
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
  closeButton: { padding: 8, marginRight: -6 },
  content: { flexGrow: 0 },
  contentContainer: { padding: 16, paddingBottom: 18, gap: 14 },
  infoCard: { borderRadius: 15, borderWidth: 1, padding: 14 },
  infoTitle: { fontSize: 17, fontWeight: "800", marginBottom: 7 },
  infoText: { fontSize: 13, lineHeight: 20, marginBottom: 11 },
  specs: { gap: 5 },
  spec: { fontSize: 12.5, lineHeight: 18 },
  section: { gap: 7 },
  label: { fontSize: 14, fontWeight: "700" },
  inputContainer: {
    minHeight: 50,
    borderRadius: 13,
    borderWidth: 1,
    flexDirection: "row",
    alignItems: "center",
    paddingLeft: 14,
    paddingRight: 7,
  },
  input: { flex: 1, minHeight: 48, fontSize: 14 },
  textAreaContainer: {
    borderRadius: 13,
    borderWidth: 1,
    padding: 12,
    minHeight: 100,
  },
  textArea: { fontSize: 13, lineHeight: 18 },
  eyeButton: { padding: 9 },
  errorText: { fontSize: 12, lineHeight: 16, marginTop: 2 },
  helperText: { fontSize: 12, lineHeight: 18, marginBottom: 6 },
  fetchButton: {
    minHeight: 44,
    borderRadius: 12,
    borderWidth: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  fetchButtonText: { fontSize: 13.5, fontWeight: "700" },
  groupLabel: { fontSize: 12, fontWeight: "700", marginBottom: 4, letterSpacing: 0.2 },
  modelChips: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 4 },
  modelChip: {
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 7,
    paddingHorizontal: 11,
    maxWidth: "100%",
  },
  modelChipText: { fontSize: 12.5, fontWeight: "600" },
  warningCard: {
    borderRadius: 14,
    borderWidth: 1,
    borderLeftWidth: 4,
    padding: 12,
    flexDirection: "row",
    gap: 10,
  },
  warningIcon: {
    width: 30,
    height: 30,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  warningBody: { flex: 1 },
  warningTitle: { fontSize: 13, fontWeight: "800", marginBottom: 4 },
  warningText: { fontSize: 12, lineHeight: 18 },
  footer: {
    borderTopWidth: 1,
    padding: 14,
    flexDirection: "row",
    gap: 10,
  },
  footerButton: {
    flex: 1,
    minHeight: 48,
    borderRadius: 13,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: 7,
  },
  cancelButton: { borderWidth: 1 },
  saveButton: { borderWidth: 1, borderColor: "transparent" },
  saveError: { fontSize: 12, lineHeight: 17, marginHorizontal: 16, marginTop: 8, textAlign: "center" },
  footerText: { fontSize: 14, fontWeight: "800" },
});
