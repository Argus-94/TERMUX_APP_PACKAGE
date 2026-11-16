import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Modal,
  View,
  Text,
  TextInput,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  KeyboardAvoidingView,
  Platform,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "./ThemeContext";
import { useLanguage } from "./LanguageContext";
import {
  type CustomInstallKind,
  type CustomToolDef,
  type CustomToolSection,
  buildCommandsFromKind,
  upsertCustomTool,
} from "../lib/custom-packages";

const ICONS = [
  "extension-puzzle-outline",
  "construct-outline",
  "code-slash-outline",
  "terminal-outline",
  "cube-outline",
  "hammer-outline",
  "flash-outline",
  "shield-checkmark-outline",
  "bug-outline",
  "git-branch-outline",
  "logo-python",
  "logo-nodejs",
] as const;

interface Props {
  visible: boolean;
  onClose: () => void;
  /** Called after successful save */
  onSaved: (tool: CustomToolDef) => void;
  /** Edit existing */
  initial?: CustomToolDef | null;
}

export function AddToolDialog({ visible, onClose, onSaved, initial }: Props) {
  const { colors } = useTheme();
  const { language } = useLanguage();
  const insets = useSafeAreaInsets();
  const ru = language === "ru";
  const uk = language === "uk";

  const L = useMemo(
    () => ({
      title: initial
        ? ru
          ? "Редактировать инструмент"
          : uk
            ? "Редагувати інструмент"
            : "Edit tool"
        : ru
          ? "Добавление инструментов"
          : uk
            ? "Додавання інструментів"
            : "Add tools",
      subtitle: ru
        ? "Создайте описание инструмента. Цель — только встроенный Termux этого приложения; установка доступна после проверки подписанного feed и совместимости пакетов. Сохранение описания ничего не устанавливает."
        : uk
          ? "Створіть опис інструмента. Ціль — лише вбудований Termux цієї програми; встановлення доступне після перевірки підписаного feed та сумісності пакетів. Збереження опису нічого не встановлює."
          : "Create a tool definition for this app's embedded Termux only. Installation requires a verified signed feed and compatible packages. Saving a definition installs nothing.",
      section: ru ? "Раздел меню" : uk ? "Розділ меню" : "Menu section",
      compile: ru ? "Для компиляции" : uk ? "Для компіляції" : "For compilation",
      reverse: ru ? "Реверсинженеринг" : uk ? "Реверс-інжиніринг" : "Reverse engineering",
      name: ru ? "Название" : uk ? "Назва" : "Name",
      nameEn: ru ? "Название (EN)" : uk ? "Назва (EN)" : "Name (EN)",
      desc: ru ? "Описание (необязательно)" : uk ? "Опис (необов'язково)" : "Description (optional)",
      kind: ru ? "Тип установки" : uk ? "Тип встановлення" : "Install type",
      kindPkg: "pkg (Termux)",
      kindPip: "pip (Python)",
      kindNpm: "npm -g",
      kindCustom: ru ? "Свой shell-скрипт" : uk ? "Свій shell-скрипт" : "Custom shell",
      customShellNotice: ru
        ? "Команды выполняются только после отдельного подтверждения с показом точного текста; автоматическая проверка не запускает их без вашего действия."
        : uk
          ? "Команди виконуються лише після окремого підтвердження з точним текстом; автоматична перевірка не запускає їх без вашої дії."
          : "Commands run only after a separate confirmation that shows the exact text; automatic verification will not run them without your action.",
      packages: ru ? "Имена пакетов" : uk ? "Імена пакетів" : "Package names",
      packagesHint: ru
        ? "Через пробел, например: radare2 или frida-tools"
        : uk
          ? "Через пробіл, наприклад: radare2 або frida-tools"
          : "Space-separated, e.g. radare2 or frida-tools",
      installCmd: ru ? "Команда установки" : uk ? "Команда встановлення" : "Install command",
      checkCmd: ru ? "Команда проверки (exit 0 = установлено)" : uk ? "Команда перевірки (exit 0 = встановлено)" : "Check command (exit 0 = installed)",
      removeCmd: ru ? "Команда удаления" : uk ? "Команда видалення" : "Remove command",
      estimate: ru ? "Оценка времени (сек)" : uk ? "Оцінка часу (сек)" : "Estimate (sec)",
      icon: ru ? "Иконка" : uk ? "Іконка" : "Icon",
      preview: ru ? "Превью команд" : uk ? "Прев'ю команд" : "Command preview",
      save: ru ? "Сохранить" : uk ? "Зберегти" : "Save",
      cancel: ru ? "Отмена" : uk ? "Скасувати" : "Cancel",
      needName: ru ? "Укажите название" : uk ? "Вкажіть назву" : "Enter a name",
      needPkg: ru ? "Укажите имена пакетов" : uk ? "Вкажіть імена пакетів" : "Enter package names",
      invalidPkg: ru ? "Используйте только допустимые имена пакетов без shell-операторов" : uk ? "Використовуйте допустимі назви пакетів без shell-операторів" : "Use valid package names without shell operators",
      needInstall: ru ? "Укажите команду установки" : uk ? "Вкажіть команду встановлення" : "Enter install command",
      needCheck: ru ? "Укажите настоящую команду проверки: пустая команда, true и : не подтверждают установку" : uk ? "Вкажіть справжню команду перевірки: порожня команда, true та : не підтверджують встановлення" : "Enter a real check command: an empty command, true or : cannot verify installation",
    }),
    [initial, ru, uk]
  );

  const [section, setSection] = useState<CustomToolSection>("compile");
  const [name, setName] = useState("");
  const [nameEn, setNameEn] = useState("");
  const [description, setDescription] = useState("");
  const [kind, setKind] = useState<CustomInstallKind>("pkg");
  const [packageNames, setPackageNames] = useState("");
  const [installCmd, setInstallCmd] = useState("");
  const [checkCmd, setCheckCmd] = useState("");
  const [removeCmd, setRemoveCmd] = useState("");
  const [estimateSec, setEstimateSec] = useState("60");
  const [icon, setIcon] = useState<string>("extension-puzzle-outline");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!visible) return;
    if (initial) {
      setSection(initial.section);
      setName(initial.name);
      setNameEn(initial.nameEn);
      setDescription(initial.description || "");
      setKind(initial.installKind);
      setPackageNames(initial.packageNames || "");
      setInstallCmd(initial.installCmd);
      setCheckCmd(initial.checkCmd);
      setRemoveCmd(initial.removeCmd);
      setEstimateSec(String(initial.estimateSec || 60));
      setIcon(initial.icon || "extension-puzzle-outline");
    } else {
      setSection("compile");
      setName("");
      setNameEn("");
      setDescription("");
      setKind("pkg");
      setPackageNames("");
      setInstallCmd("");
      setCheckCmd("");
      setRemoveCmd("");
      setEstimateSec("60");
      setIcon("extension-puzzle-outline");
    }
    setError("");
  }, [visible, initial]);

  // Auto-fill cmds when kind/packages change (non-custom)
  useEffect(() => {
    if (kind === "custom") return;
    if (!packageNames.trim()) {
      setInstallCmd("");
      setCheckCmd("");
      setRemoveCmd("");
      return;
    }
    try {
      const built = buildCommandsFromKind(kind, packageNames);
      setInstallCmd(built.installCmd);
      setCheckCmd(built.checkCmd);
      setRemoveCmd(built.removeCmd);
    } catch {
      setInstallCmd("");
      setCheckCmd("");
      setRemoveCmd("");
    }
  }, [kind, packageNames]);

  const handleSave = useCallback(async () => {
    if (!name.trim()) {
      setError(L.needName);
      return;
    }
    if (kind !== "custom" && !packageNames.trim()) {
      setError(L.needPkg);
      return;
    }
    if (kind === "custom" && !installCmd.trim()) {
      setError(L.needInstall);
      return;
    }
    if (kind === "custom" && (!checkCmd.trim() || ["true", ":"].includes(checkCmd.trim()) || checkCmd.includes("CUSTOM_CHECK_NOT_CONFIGURED"))) {
      setError(L.needCheck);
      return;
    }
    setSaving(true);
    setError("");
    try {
      const built =
        kind === "custom"
          ? {
              installCmd: installCmd.trim(),
              checkCmd: checkCmd.trim(),
              removeCmd: removeCmd.trim() || "true",
            }
          : buildCommandsFromKind(kind, packageNames, installCmd, checkCmd, removeCmd);

      const tool = await upsertCustomTool({
        id: initial?.id,
        section,
        name: name.trim(),
        nameEn: (nameEn.trim() || name.trim()),
        description: description.trim() || undefined,
        icon,
        installKind: kind,
        packageNames: kind === "custom" ? undefined : packageNames.trim(),
        installCmd: built.installCmd,
        checkCmd: built.checkCmd,
        removeCmd: built.removeCmd,
        estimateSec: Math.max(10, parseInt(estimateSec, 10) || 60),
      });
      onSaved(tool);
      onClose();
    } catch (e) {
      setError(e instanceof Error && e.message === "CUSTOM_PACKAGE_NAME_INVALID" ? L.invalidPkg : e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [
    L,
    name,
    nameEn,
    description,
    kind,
    packageNames,
    installCmd,
    checkCmd,
    removeCmd,
    estimateSec,
    icon,
    section,
    initial,
    onSaved,
    onClose,
  ]);

  const chip = (
    active: boolean,
    label: string,
    onPress: () => void
  ) => (
    <TouchableOpacity
      key={label}
      onPress={onPress}
      style={[
        styles.chip,
        {
          backgroundColor: active ? colors.accentDim : colors.chipBg,
          borderColor: active ? colors.accent : colors.line,
        },
      ]}
    >
      <Text style={{ color: active ? colors.accent : colors.chipText, fontWeight: active ? "700" : "500", fontSize: 12 }}>
        {label}
      </Text>
    </TouchableOpacity>
  );

  const field = (
    label: string,
    value: string,
    onChange: (v: string) => void,
    opts?: { multiline?: boolean; mono?: boolean; placeholder?: string }
  ) => (
    <View style={{ marginBottom: 12 }}>
      <Text style={[styles.label, { color: colors.muted }]}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder={opts?.placeholder}
        placeholderTextColor={colors.muted}
        multiline={opts?.multiline}
        textAlignVertical={opts?.multiline ? "top" : "center"}
        autoCapitalize="none"
        autoCorrect={false}
        style={[
          styles.input,
          {
            color: colors.inkBright,
            backgroundColor: colors.background,
            borderColor: colors.line,
            minHeight: opts?.multiline ? 88 : 42,
            fontFamily: opts?.mono
              ? Platform.OS === "ios"
                ? "Menlo"
                : "monospace"
              : undefined,
            fontSize: opts?.mono ? 11 : 14,
          },
        ]}
      />
    </View>
  );

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <KeyboardAvoidingView
        style={[styles.overlay, { backgroundColor: colors.overlay }]}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <View
          style={[
            styles.sheet,
            {
              backgroundColor: colors.surface,
              borderColor: colors.line,
              paddingBottom: Math.max(insets.bottom, 12) + 8,
              maxHeight: "92%",
            },
          ]}
        >
          <View style={styles.sheetHead}>
            <View style={[styles.iconWrap, { backgroundColor: colors.accentDim }]}>
              <Ionicons name="add-circle-outline" size={22} color={colors.accent} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[styles.title, { color: colors.inkBright }]}>{L.title}</Text>
              <Text style={[styles.sub, { color: colors.muted }]}>{L.subtitle}</Text>
            </View>
            <TouchableOpacity onPress={onClose} hitSlop={10}>
              <Ionicons name="close" size={22} color={colors.muted} />
            </TouchableOpacity>
          </View>

          <ScrollView
            style={{ flexGrow: 0 }}
            contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 8 }}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            <Text style={[styles.label, { color: colors.muted }]}>{L.section}</Text>
            <View style={styles.row}>
              {chip(section === "compile", L.compile, () => setSection("compile"))}
              {chip(section === "reverse", L.reverse, () => setSection("reverse"))}
            </View>

            {field(L.name, name, setName, { placeholder: "My Tool" })}
            {field(L.nameEn, nameEn, setNameEn, { placeholder: "My Tool" })}
            {field(L.desc, description, setDescription, {
              multiline: true,
              placeholder: ru ? "Кратко, для чего инструмент" : "Short purpose",
            })}

            <Text style={[styles.label, { color: colors.muted }]}>{L.kind}</Text>
            <View style={styles.row}>
              {chip(kind === "pkg", L.kindPkg, () => setKind("pkg"))}
              {chip(kind === "pip", L.kindPip, () => setKind("pip"))}
              {chip(kind === "npm", L.kindNpm, () => setKind("npm"))}
              {chip(kind === "custom", L.kindCustom, () => setKind("custom"))}
            </View>

            {kind !== "custom" ? (
              field(L.packages, packageNames, setPackageNames, {
                placeholder: L.packagesHint,
                mono: true,
              })
            ) : (
              <>
                {field(L.installCmd, installCmd, setInstallCmd, { multiline: true, mono: true })}
                {field(L.checkCmd, checkCmd, setCheckCmd, {
                  multiline: true,
                  mono: true,
                  placeholder: 'command -v mytool >/dev/null 2>&1',
                })}
                {field(L.removeCmd, removeCmd, setRemoveCmd, {
                  multiline: true,
                  mono: true,
                  placeholder: "pkg uninstall -y mytool",
                })}
                <Text style={{ color: colors.muted, fontSize: 12, marginTop: -2, marginBottom: 8 }}>
                  {L.customShellNotice}
                </Text>
              </>
            )}

            {field(L.estimate, estimateSec, setEstimateSec, { placeholder: "60" })}

            <Text style={[styles.label, { color: colors.muted }]}>{L.icon}</Text>
            <View style={styles.iconGrid}>
              {ICONS.map((ic) => {
                const on = icon === ic;
                return (
                  <TouchableOpacity
                    key={ic}
                    onPress={() => setIcon(ic)}
                    style={[
                      styles.iconCell,
                      {
                        borderColor: on ? colors.accent : colors.line,
                        backgroundColor: on ? colors.accentDim : colors.background,
                      },
                    ]}
                  >
                    <Ionicons name={ic as any} size={20} color={on ? colors.accent : colors.muted} />
                  </TouchableOpacity>
                );
              })}
            </View>

            {kind !== "custom" && packageNames.trim() ? (
              <View style={[styles.preview, { borderColor: colors.line, backgroundColor: colors.background }]}>
                <Text style={[styles.label, { color: colors.accent, marginBottom: 6 }]}>{L.preview}</Text>
                <Text style={[styles.previewText, { color: colors.muted }]} selectable>
                  {`install:\n${installCmd.slice(0, 400)}${installCmd.length > 400 ? "…" : ""}\n\ncheck:\n${checkCmd}\n\nremove:\n${removeCmd}`}
                </Text>
              </View>
            ) : null}

            {!!error && (
              <Text style={{ color: colors.danger, fontSize: 13, marginBottom: 8 }}>{error}</Text>
            )}
          </ScrollView>

          <View style={styles.actions}>
            <TouchableOpacity
              style={[styles.btn, { borderColor: colors.line, backgroundColor: colors.chipBg }]}
              onPress={onClose}
            >
              <Text style={{ color: colors.inkBright, fontWeight: "600" }}>{L.cancel}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.btn, styles.btnPrimary, { backgroundColor: colors.accent, opacity: saving ? 0.7 : 1 }]}
              onPress={() => void handleSave()}
              disabled={saving}
            >
              <Ionicons name="checkmark-circle" size={18} color={colors.onAccent || "#00325A"} />
              <Text style={{ color: colors.onAccent || "#00325A", fontWeight: "800" }}>{L.save}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: "flex-end" },
  sheet: {
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    borderWidth: 1,
    paddingTop: 14,
  },
  sheetHead: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 12,
    paddingHorizontal: 16,
    marginBottom: 12,
  },
  iconWrap: {
    width: 40,
    height: 40,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  title: { fontSize: 16, fontWeight: "800" },
  sub: { fontSize: 12, lineHeight: 16, marginTop: 4 },
  label: { fontSize: 11, fontWeight: "700", letterSpacing: 0.3, marginBottom: 6, textTransform: "uppercase" },
  input: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 12 },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
    borderWidth: 1,
  },
  iconGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 12 },
  iconCell: {
    width: 40,
    height: 40,
    borderRadius: 10,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  preview: {
    borderWidth: 1,
    borderRadius: 10,
    padding: 10,
    marginBottom: 10,
  },
  previewText: {
    fontSize: 10,
    lineHeight: 14,
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
  },
  actions: {
    flexDirection: "row",
    gap: 10,
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  btn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 12,
    borderRadius: 12,
    borderWidth: 1,
  },
  btnPrimary: { borderWidth: 0 },
});
