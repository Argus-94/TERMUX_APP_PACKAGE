import { useCallback, useMemo, useState } from "react";
import { ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View, ActivityIndicator } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter, useFocusEffect } from "expo-router";
import * as DocumentPicker from "expo-document-picker";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "../components/ThemeContext";
import { useDialog } from "../components/DialogContext";
import { useLanguage } from "../components/LanguageContext";
import { useLoggerContext } from "../components/LoggerContext";
import { checkTermuxReadiness } from "../lib/termux-bridge";
import { createSigningKeystore, inspectSigningKeystore, signApk, verifyApkSignature, listSigningKeystores, deleteSigningKeystore, importSigningKeystore, copyLegacySigningKeystores, SIGNING_ROOT, SIGNED_APK_ROOT, LEGACY_SIGNING_ROOT, materializeUriForTermux } from "../lib/signing-tool";

export default function SigningKeysScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const { showDialog } = useDialog();
  const { language } = useLanguage();
  const { logInfo, logError } = useLoggerContext();
  const ru = language === "ru";
  const uk = language === "uk";

  const [fileName, setFileName] = useState("release-key.keystore");
  const [alias, setAlias] = useState("release");
  const [storePassword, setStorePassword] = useState("");
  const [keyPassword, setKeyPassword] = useState("");
  const [commonName, setCommonName] = useState("AI Builder Release");
  const [validity, setValidity] = useState("10000");
  const [showPasswords, setShowPasswords] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState("");

  const [inspectPath, setInspectPath] = useState(`${SIGNING_ROOT}/release-key.keystore`);
  const [inspectPassword, setInspectPassword] = useState("");
  const [inspectAlias, setInspectAlias] = useState("release");

  const [apkPath, setApkPath] = useState("");
  const [outputPath, setOutputPath] = useState("");
  const [signKeyPath, setSignKeyPath] = useState(`${SIGNING_ROOT}/release-key.keystore`);
  const [signAlias, setSignAlias] = useState("release");
  const [signStorePassword, setSignStorePassword] = useState("");
  const [signKeyPassword, setSignKeyPassword] = useState("");
  const [keys, setKeys] = useState<Array<{ name: string; path: string; size: string; legacy: boolean }>>([]);
  const [legacyKeysPresent, setLegacyKeysPresent] = useState(false);

  const labels = useMemo(() => ({
    title: ru ? "Ключи подписи" : uk ? "Ключі підпису" : "Signing Keys",
    subtitle: ru ? "Профессиональный инструмент для Android-подписи: создавайте keystore, проверяйте сертификаты и подписывайте APK через Termux." : uk ? "Професійний інструмент для Android-підпису: створюйте keystore, перевіряйте сертифікати та підписуйте APK через Termux." : "Professional Android signing utility: create keystores, inspect certificates, and sign APKs through Termux.",
    create: ru ? "Создать ключ подписи" : uk ? "Створити ключ підпису" : "Create signing key",
    inspect: ru ? "Проверить сертификат" : uk ? "Перевірити сертифікат" : "Inspect certificate",
    sign: ru ? "Подписать APK" : uk ? "Підписати APK" : "Sign APK",
    name: ru ? "Файл keystore" : uk ? "Файл keystore" : "Keystore file",
    alias: ru ? "Alias" : "Alias",
    password: ru ? "Пароль keystore" : uk ? "Пароль keystore" : "Keystore password",
    keyPassword: ru ? "Пароль ключа" : uk ? "Пароль ключа" : "Key password",
    commonName: ru ? "Имя сертификата" : uk ? "Ім'я сертифіката" : "Certificate name",
    validity: ru ? "Срок действия (дни)" : uk ? "Строк дії (дні)" : "Validity (days)",
    path: ru ? "Путь" : uk ? "Шлях" : "Path",
    inputApk: ru ? "Входной APK" : uk ? "Вхідний APK" : "Input APK",
    outputApk: ru ? "Результат" : uk ? "Результат" : "Output APK",
    security: ru ? "Новые и импортированные ключи хранятся в закрытом каталоге Termux ~/.aibuilder/keys; APK остаются в общей папке AIBuilderTermux." : uk ? "Нові та імпортовані ключі зберігаються у приватному каталозі Termux ~/.aibuilder/keys; APK залишаються у спільній папці AIBuilderTermux." : "New and imported keys are stored in Termux-private ~/.aibuilder/keys; APKs remain in shared AIBuilderTermux storage.",
    hint: ru ? "Для подписи используйте APK, доступный Termux. Рекомендуемый результат — новый файл, исходник не изменяется." : uk ? "Для підпису використовуйте APK, доступний Termux. Рекомендований результат — новий файл, оригінал не змінюється." : "Use an APK accessible to Termux. The recommended output is a new file; the source APK is not modified.",
    keys: ru ? "Сохранённые ключи" : uk ? "Збережені ключі" : "Saved keys",
    refresh: ru ? "Обновить" : uk ? "Оновити" : "Refresh",
    importKey: ru ? "Импортировать keystore" : uk ? "Імпортувати keystore" : "Import keystore",
    chooseApk: ru ? "Выбрать APK" : uk ? "Вибрати APK" : "Choose APK",
    verify: ru ? "Проверить подпись APK" : uk ? "Перевірити підпис APK" : "Verify APK signature",
    delete: ru ? "Удалить" : uk ? "Видалити" : "Delete",
    emptyKeys: ru ? "Ключи ещё не созданы" : uk ? "Ключі ще не створені" : "No signing keys yet",
    securityTitle: ru ? "Защита ключей" : uk ? "Захист ключів" : "Key protection",
    securityBody: ru ? "Пароли не сохраняются в настройках. Новые ключи хранятся в домашнем каталоге Termux. Старые ключи в общей папке остаются на месте; их можно отдельно скопировать в закрытый каталог с побайтной проверкой." : uk ? "Паролі не зберігаються в налаштуваннях. Нові ключі зберігаються в домашньому каталозі Termux. Старі ключі у спільній папці залишаються на місці; їх можна окремо скопіювати до приватного каталогу з побайтовою перевіркою." : "Passwords are not stored in settings. New keys live in Termux home. Legacy keys remain in shared storage; you can explicitly copy them to the private directory with byte-level verification.",
    migrateLegacy: ru ? "Скопировать старые ключи в закрытый каталог Termux" : uk ? "Скопіювати старі ключі до приватного каталогу Termux" : "Copy legacy keys to Termux-private storage",
    migrateTitle: ru ? "Копирование старых ключей" : uk ? "Копіювання старих ключів" : "Copy legacy keys",
    migrateBody: ru ? "Будет создана и побайтно проверена копия в ~/.aibuilder/keys. Исходные файлы в общей папке никогда не удаляются и не изменяются. Если имя занято другим содержимым, оба файла останутся нетронутыми." : uk ? "Буде створено та побайтово перевірено копію у ~/.aibuilder/keys. Початкові файли у спільній папці ніколи не видаляються та не змінюються. Якщо ім'я зайняте іншим вмістом, обидва файли залишаться без змін." : "A copy will be created under ~/.aibuilder/keys and byte-verified. Original shared files are never deleted or modified. If a name collides with different contents, both files remain untouched.",
    migrateConfirm: ru ? "Скопировать ключи" : uk ? "Скопіювати ключі" : "Copy keys",
  }), [ru, uk]);

  const run = useCallback(async (fn: () => Promise<{ stdout: string; stderr: string; exitCode: number }>) => {
    setBusy(true); setResult("");
    try {
      const readiness = await checkTermuxReadiness({ deep: true, refreshPermission: true });
      if (!readiness.ready) throw new Error(readiness.probeDetail || "The embedded private runtime is not ready. Use the Runtime bootstrap/check controls.");
      const r = await fn();
      const text = `${r.stdout || ""}${r.stderr ? `\n${r.stderr}` : ""}`.trim();
      setResult(text || `exit=${r.exitCode}`);
      if (r.exitCode !== 0) throw new Error(text || `exit=${r.exitCode}`);
      return r;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setResult(message);
      logError("SigningKeys", message);
      showDialog(labels.title, message);
      throw e;
    } finally { setBusy(false); }
  }, [labels.title, logError]);

  const create = async () => {
    if (!storePassword || !keyPassword || storePassword.length < 6 || keyPassword.length < 6) {
      showDialog(labels.title, ru ? "Пароли должны содержать минимум 6 символов." : uk ? "Паролі мають містити щонайменше 6 символів." : "Passwords must be at least 6 characters long.");
      return;
    }
    const r = await run(() => createSigningKeystore({ fileName, alias, storePassword, keyPassword, validityDays: Number(validity) || 10000, commonName }));
    if (r.exitCode === 0) {
      const keyFile = /\.(?:keystore|jks)$/i.test(fileName) ? fileName : `${fileName}.keystore`;
      setInspectPath(`${SIGNING_ROOT}/${keyFile}`);
      setSignKeyPath(`${SIGNING_ROOT}/${keyFile}`);
      setInspectPassword(storePassword); setSignStorePassword(storePassword); setSignKeyPassword(keyPassword); setInspectAlias(alias);
      logInfo("SigningKeys", "Keystore created");
      await refreshKeys();
    }
  };

  const inspect = () => {
    if (!inspectPath.trim()) {
      showDialog(labels.title, ru ? "Укажите путь к keystore." : uk ? "Вкажіть шлях до keystore." : "Provide the keystore path.");
      return;
    }
    if (!inspectPassword || inspectPassword.length < 6) {
      showDialog(labels.title, ru ? "Пароль keystore: минимум 6 символов." : uk ? "Пароль keystore: щонайменше 6 символів." : "Keystore password must be at least 6 characters.");
      return;
    }
    return run(() => inspectSigningKeystore({ path: inspectPath.trim(), password: inspectPassword, alias: inspectAlias.trim() || undefined }));
  };
  const sign = () => {
    if (!apkPath.trim() || !outputPath.trim() || !signKeyPath.trim() || !signAlias.trim()) {
      showDialog(labels.title, ru ? "Заполните пути APK, результата, keystore и alias." : uk ? "Заповніть шляхи APK, результату, keystore та alias." : "Fill in the APK, output, keystore and alias fields.");
      return;
    }
    if (!signStorePassword || signStorePassword.length < 6 || !signKeyPassword || signKeyPassword.length < 6) {
      showDialog(labels.title, ru ? "Пароли keystore/ключа: минимум 6 символов." : uk ? "Паролі keystore/ключа: щонайменше 6 символів." : "Keystore and key passwords must be at least 6 characters.");
      return;
    }
    return run(() => signApk({ inputApk: apkPath.trim(), outputApk: outputPath.trim(), keystorePath: signKeyPath.trim(), alias: signAlias.trim(), storePassword: signStorePassword, keyPassword: signKeyPassword }));
  };

  const refreshKeys = useCallback(async () => {
    try {
      const r = await listSigningKeystores();
      const lines = (r.stdout || "").split("\n").map(line => line.trim()).filter(Boolean);
      setLegacyKeysPresent(lines.includes("LEGACY_KEYS_PRESENT"));
      const parsed = lines.filter(line => line.startsWith("PRIVATE\t") || line.startsWith("LEGACY\t")).map(line => {
        const [kind, name, size = ""] = line.split("\t");
        const legacy = kind === "LEGACY";
        return { name, size, path: `${legacy ? LEGACY_SIGNING_ROOT : SIGNING_ROOT}/${name}`, legacy };
      }).filter(k => /\.(keystore|jks)$/i.test(k.name));
      setKeys(parsed);
    } catch { setKeys([]); }
  }, []);

  useFocusEffect(useCallback(() => { refreshKeys(); }, [refreshKeys]));

  const pickApk = async () => {
    const picked = await DocumentPicker.getDocumentAsync({ type: "application/vnd.android.package-archive", copyToCacheDirectory: true });
    if (!picked.canceled && picked.assets?.[0]) {
      const asset = picked.assets[0];
      try {
        const real = await materializeUriForTermux(asset.uri, asset.name || "picked.apk");
        setApkPath(real);
        if (!outputPath) setOutputPath(`${SIGNED_APK_ROOT}/${(asset.name || "picked").replace(/\.apk$/i, "")}-signed.apk`);
      } catch (e) {
        showDialog(labels.title, e instanceof Error ? e.message : String(e));
      }
    }
  };

  const importKey = async () => {
    try {
      const picked = await DocumentPicker.getDocumentAsync({ type: ["application/octet-stream", "application/x-java-keystore", "application/zip"], copyToCacheDirectory: true });
      const asset = picked.canceled ? null : picked.assets?.[0];
      if (!asset) return;
      const safe = (asset.name || "imported-key.keystore").replace(/[^A-Za-z0-9._-]+/g, "-");
      const finalName = /\.(keystore|jks)$/i.test(safe) ? safe : `${safe}.keystore`;
      let staged: string;
      try {
        staged = await materializeUriForTermux(asset.uri, asset.name || finalName);
      } catch (e) {
        showDialog(labels.title, e instanceof Error ? e.message : String(e));
        return;
      }
      let imported: { exitCode: number };
      try {
        imported = await run(() => importSigningKeystore(staged, finalName));
      } catch { return; }
      if (imported.exitCode !== 0) return;
      await refreshKeys();
      setInspectPath(`${SIGNING_ROOT}/${finalName}`); setSignKeyPath(`${SIGNING_ROOT}/${finalName}`);
      showDialog(labels.title, ru ? `Ключ импортирован: ${finalName}` : uk ? `Ключ імпортовано: ${finalName}` : `Key imported: ${finalName}`);
    } catch (e) {
      showDialog(labels.title, e instanceof Error ? e.message : String(e));
    }
  };

  const removeKey = (key: { name: string; path: string }) => {
    showDialog(labels.delete, key.name, [
      { text: ru ? "Отмена" : uk ? "Скасувати" : "Cancel", style: "cancel" },
      { text: labels.delete, style: "destructive", onPress: async () => { try { await deleteSigningKeystore(key.path); await refreshKeys(); } catch (e) { showDialog(labels.title, e instanceof Error ? e.message : String(e)); } } },
    ]);
  };

  const copyLegacyKeys = () => showDialog(labels.migrateTitle, labels.migrateBody, [
    { text: ru ? "Отмена" : uk ? "Скасувати" : "Cancel", style: "cancel" },
    { text: labels.migrateConfirm, onPress: async () => {
      try {
        await run(() => copyLegacySigningKeystores());
        await refreshKeys();
      } catch { /* run() presents the verified command result/error */ }
    } },
  ]);

  const Field = ({ label, value, onChangeText, secure = false, placeholder = "" }: { label: string; value: string; onChangeText: (v: string) => void; secure?: boolean; placeholder?: string }) => (
    <View style={styles.fieldWrap}>
      <Text style={[styles.label, { color: colors.muted }]}>{label}</Text>
      <TextInput value={value} onChangeText={onChangeText} placeholder={placeholder} placeholderTextColor={colors.muted} secureTextEntry={secure && !showPasswords} autoCapitalize="none" style={[styles.input, { color: colors.inkBright, backgroundColor: colors.background, borderColor: colors.line }]} />
    </View>
  );

  return (
    <View style={[styles.container, { backgroundColor: colors.background, paddingTop: insets.top }]}> 
      <View style={[styles.header, { borderBottomColor: colors.line, backgroundColor: colors.surface }]}> 
        <TouchableOpacity onPress={() => router.back()} style={styles.iconButton}><Ionicons name="arrow-back" size={23} color={colors.inkBright} /></TouchableOpacity>
        <View style={{ flex: 1 }}><Text style={[styles.title, { color: colors.inkBright }]}>{labels.title}</Text><Text style={[styles.subtitle, { color: colors.muted }]}>{labels.subtitle}</Text></View>
        <Ionicons name="shield-checkmark-outline" size={24} color={colors.accent} />
      </View>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={[styles.hero, { backgroundColor: colors.surface, borderColor: colors.line }]}>
          <View style={[styles.heroIcon, { backgroundColor: colors.accentDim }]}><Ionicons name="key" size={28} color={colors.accent} /></View>
          <Text style={[styles.heroTitle, { color: colors.inkBright }]}>{ru ? "Android Signing Studio" : uk ? "Android Signing Studio" : "Android Signing Studio"}</Text>
          <Text style={[styles.heroText, { color: colors.muted }]}>{labels.security}</Text>
        </View>

        <Text style={[styles.section, { color: colors.muted }]}>{labels.create}</Text>
        <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.line }]}>
          <Field label={labels.name} value={fileName} onChangeText={setFileName} />
          <Field label={labels.alias} value={alias} onChangeText={setAlias} />
          <Field label={labels.password} value={storePassword} onChangeText={setStorePassword} secure />
          <Field label={labels.keyPassword} value={keyPassword} onChangeText={setKeyPassword} secure />
          <View style={styles.row}><View style={{ flex: 1 }}><Field label={labels.commonName} value={commonName} onChangeText={setCommonName} /></View><View style={{ width: 120 }}><Field label={labels.validity} value={validity} onChangeText={setValidity} /></View></View>
          <TouchableOpacity onPress={() => setShowPasswords(v => !v)} style={styles.textButton}><Ionicons name={showPasswords ? "eye-off-outline" : "eye-outline"} size={18} color={colors.accent} /><Text style={[styles.textButtonText, { color: colors.accent }]}>{showPasswords ? (ru ? "Скрыть пароли" : uk ? "Сховати паролі" : "Hide passwords") : (ru ? "Показать пароли" : uk ? "Показати паролі" : "Show passwords")}</Text></TouchableOpacity>
          <TouchableOpacity disabled={busy} onPress={create} style={[styles.primary, { backgroundColor: colors.accent, opacity: busy ? 0.6 : 1 }]}>{busy ? <ActivityIndicator color={colors.onAccent || "#00325A"} /> : <><Ionicons name="key-outline" size={18} color={colors.onAccent || "#00325A"} /><Text style={[styles.primaryText, { color: colors.onAccent || "#00325A" }]}>{labels.create}</Text></>}</TouchableOpacity>
        </View>

        <Text style={[styles.section, { color: colors.muted }]}>{labels.inspect}</Text>
        <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.line }]}>
          <Field label={labels.path} value={inspectPath} onChangeText={setInspectPath} />
          <Field label={labels.alias} value={inspectAlias} onChangeText={setInspectAlias} />
          <Field label={labels.password} value={inspectPassword} onChangeText={setInspectPassword} secure />
          <TouchableOpacity disabled={busy} onPress={inspect} style={[styles.secondary, { borderColor: colors.accent, opacity: busy ? 0.6 : 1 }]}><Ionicons name="finger-print-outline" size={18} color={colors.accent} /><Text style={[styles.secondaryText, { color: colors.accent }]}>{labels.inspect}</Text></TouchableOpacity>
        </View>

        <Text style={[styles.section, { color: colors.muted }]}>{labels.sign}</Text>
        <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.line }]}>
          <Text style={[styles.hint, { color: colors.muted }]}>{labels.hint}</Text>
          <View style={styles.actionRow}><View style={{ flex: 1 }}><Field label={labels.inputApk} value={apkPath} onChangeText={setApkPath} placeholder="/storage/emulated/0/AIBuilderTermux/.../app.apk" /></View><TouchableOpacity onPress={pickApk} style={[styles.squareButton, { borderColor: colors.accent, backgroundColor: colors.accentDim }]}><Ionicons name="folder-open-outline" size={20} color={colors.accent} /></TouchableOpacity></View>
          <Field label={labels.outputApk} value={outputPath} onChangeText={setOutputPath} placeholder="/storage/emulated/0/AIBuilderTermux/.../app-signed.apk" />
          <Field label={labels.path} value={signKeyPath} onChangeText={setSignKeyPath} />
          <Field label={labels.alias} value={signAlias} onChangeText={setSignAlias} />
          <Field label={labels.password} value={signStorePassword} onChangeText={setSignStorePassword} secure />
          <Field label={labels.keyPassword} value={signKeyPassword} onChangeText={setSignKeyPassword} secure />
          <TouchableOpacity disabled={busy} onPress={sign} style={[styles.primary, { backgroundColor: colors.accent, opacity: busy ? 0.6 : 1 }]}>{busy ? <ActivityIndicator color={colors.onAccent || "#00325A"} /> : <><Ionicons name="shield-checkmark-outline" size={18} color={colors.onAccent || "#00325A"} /><Text style={[styles.primaryText, { color: colors.onAccent || "#00325A" }]}>{labels.sign}</Text></>}</TouchableOpacity>
          <TouchableOpacity disabled={busy || !outputPath.trim()} onPress={() => run(() => verifyApkSignature(outputPath.trim()))} style={[styles.secondary, { borderColor: colors.accent, opacity: busy || !outputPath.trim() ? 0.5 : 1 }]}><Ionicons name="checkmark-done-outline" size={18} color={colors.accent} /><Text style={[styles.secondaryText, { color: colors.accent }]}>{labels.verify}</Text></TouchableOpacity>
        </View>

        <Text style={[styles.section, { color: colors.muted }]}>{labels.keys}</Text>
        <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.line }]}>
          <View style={styles.actionRow}>
            <TouchableOpacity onPress={importKey} style={[styles.secondary, styles.flexButton, { borderColor: colors.accent }]}><Ionicons name="download-outline" size={18} color={colors.accent} /><Text style={[styles.secondaryText, { color: colors.accent }]}>{labels.importKey}</Text></TouchableOpacity>
            <TouchableOpacity onPress={refreshKeys} style={[styles.squareButton, { borderColor: colors.line, backgroundColor: colors.background }]}><Ionicons name="refresh-outline" size={19} color={colors.accent} /></TouchableOpacity>
          </View>
          {legacyKeysPresent && <View style={[styles.securityBox, { backgroundColor: colors.accentDim, borderColor: colors.line }]}><Ionicons name="information-circle-outline" size={18} color={colors.accent} /><View style={{ flex: 1, gap: 8 }}><Text style={[styles.hint, { color: colors.muted }]}>{labels.migrateBody}</Text><TouchableOpacity disabled={busy} onPress={copyLegacyKeys} style={[styles.secondary, { borderColor: colors.accent, opacity: busy ? 0.6 : 1 }]}><Ionicons name="copy-outline" size={18} color={colors.accent} /><Text style={[styles.secondaryText, { color: colors.accent }]}>{labels.migrateLegacy}</Text></TouchableOpacity></View></View>}
          {keys.length === 0 ? <Text style={[styles.hint, { color: colors.muted }]}>{labels.emptyKeys}</Text> : keys.map(key => (
            <View key={key.path} style={[styles.keyRow, { borderColor: colors.line }]}>
              <View style={[styles.keyIcon, { backgroundColor: colors.accentDim }]}><Ionicons name="key-outline" size={18} color={colors.accent} /></View>
              <View style={{ flex: 1 }}><Text numberOfLines={1} style={[styles.keyName, { color: colors.inkBright }]}>{key.name}</Text><Text style={[styles.keyMeta, { color: colors.muted }]}>{key.legacy ? (ru ? "Общая папка (исходник сохранён)" : uk ? "Спільна папка (оригінал збережено)" : "Shared folder (original preserved)") : "~/.aibuilder/keys"}{key.size ? ` · ${key.size} B` : ""}</Text></View>
              <TouchableOpacity onPress={() => { setInspectPath(key.path); setSignKeyPath(key.path); }} style={styles.smallIcon}><Ionicons name="checkmark-circle-outline" size={20} color={colors.accent} /></TouchableOpacity>
              {!key.legacy && <TouchableOpacity onPress={() => removeKey(key)} style={styles.smallIcon}><Ionicons name="trash-outline" size={19} color={colors.muted} /></TouchableOpacity>}
            </View>
          ))}
          <View style={[styles.securityBox, { backgroundColor: colors.accentDim, borderColor: colors.line }]}><Ionicons name="shield-checkmark-outline" size={18} color={colors.accent} /><View style={{ flex: 1 }}><Text style={[styles.securityTitle, { color: colors.inkBright }]}>{labels.securityTitle}</Text><Text style={[styles.hint, { color: colors.muted }]}>{labels.securityBody}</Text></View></View>
        </View>

        {!!result && <View style={[styles.result, { backgroundColor: colors.surface, borderColor: colors.line }]}><Text style={[styles.resultTitle, { color: colors.inkBright }]}>{ru ? "Результат Termux" : uk ? "Результат Termux" : "Termux result"}</Text><Text selectable style={[styles.resultText, { color: colors.muted }]}>{result}</Text></View>}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 }, header: { minHeight: 68, flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 14, paddingVertical: 10, borderBottomWidth: 1 }, iconButton: { padding: 7 }, title: { fontSize: 17, fontWeight: "800" }, subtitle: { fontSize: 11, lineHeight: 15, marginTop: 2 }, content: { padding: 16, gap: 10, paddingBottom: 36 }, hero: { borderRadius: 18, borderWidth: 1, padding: 16, gap: 8 }, heroIcon: { width: 50, height: 50, borderRadius: 15, alignItems: "center", justifyContent: "center" }, heroTitle: { fontSize: 18, fontWeight: "800" }, heroText: { fontSize: 12, lineHeight: 18 }, section: { fontSize: 13, fontWeight: "700", marginTop: 8 }, card: { borderRadius: 16, borderWidth: 1, padding: 14, gap: 10 }, fieldWrap: { gap: 5 }, label: { fontSize: 11.5, fontWeight: "600" }, input: { minHeight: 42, borderRadius: 11, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 9, fontSize: 13 }, row: { flexDirection: "row", gap: 10 }, actionRow: { flexDirection: "row", alignItems: "flex-end", gap: 8 }, flexButton: { flex: 1 }, squareButton: { width: 44, height: 42, borderRadius: 11, borderWidth: 1, alignItems: "center", justifyContent: "center" }, keyRow: { flexDirection: "row", alignItems: "center", gap: 10, borderWidth: 1, borderRadius: 12, padding: 10 }, keyIcon: { width: 36, height: 36, borderRadius: 10, alignItems: "center", justifyContent: "center" }, keyName: { fontSize: 12.5, fontWeight: "800" }, keyMeta: { fontSize: 10.5, marginTop: 2 }, smallIcon: { padding: 5 }, securityBox: { flexDirection: "row", gap: 9, borderWidth: 1, borderRadius: 12, padding: 11, alignItems: "flex-start" }, securityTitle: { fontSize: 12, fontWeight: "800", marginBottom: 2 }, primary: { minHeight: 44, borderRadius: 11, alignItems: "center", justifyContent: "center", flexDirection: "row", gap: 8, marginTop: 3 }, primaryText: { fontSize: 13, fontWeight: "800" }, secondary: { minHeight: 42, borderRadius: 11, borderWidth: 1, alignItems: "center", justifyContent: "center", flexDirection: "row", gap: 8 }, secondaryText: { fontSize: 13, fontWeight: "700" }, textButton: { flexDirection: "row", alignItems: "center", gap: 7, alignSelf: "flex-start", paddingVertical: 3 }, textButtonText: { fontSize: 12, fontWeight: "700" }, hint: { fontSize: 11.5, lineHeight: 17 }, result: { borderRadius: 16, borderWidth: 1, padding: 14, gap: 7 }, resultTitle: { fontSize: 13, fontWeight: "800" }, resultText: { fontFamily: "monospace", fontSize: 11, lineHeight: 16 },
});
