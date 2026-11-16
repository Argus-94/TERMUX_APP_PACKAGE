import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Alert, Text, TextInput, TouchableOpacity, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useTheme } from "./ThemeContext";
import { useLanguage } from "./LanguageContext";
import { ProgressBar } from "./ProgressBar";
import {
  cancelOfflinePackageBundle,
  installOfflinePackageBundle,
  onOfflineBundleProgress,
  planOfflinePackageBundle,
  type OfflinePackageBundlePackage,
} from "../lib/termux-bridge";
import { cancelOnlinePackageCatalog, fetchAndStageOnlinePackageCatalog } from "../lib/online-package-feed";

type UiState = "idle" | "fetching" | "planning" | "ready" | "installing" | "installed" | "partial" | "blocked" | "rejected" | "cancelled";
type ActiveOperation = { requestId: string; kind: "fetch" | "plan" | "install"; unsubscribe: () => void };

function createRequestId(kind: string): string {
  return `online-${kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function bytesLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function phaseLabel(phase: string, language: "ru" | "uk" | "en"): string {
  const labels: Record<string, Record<"ru" | "uk" | "en", string>> = {
    catalog: { ru: "Загрузка каталога", uk: "Завантаження каталогу", en: "Downloading catalog" },
    downloading: { ru: "Загрузка пакетов", uk: "Завантаження пакетів", en: "Downloading packages" },
    native_stage: { ru: "Проверка подписи, хэшей и локального APT", uk: "Перевірка підпису, хешів і локального APT", en: "Checking signature, hashes and local APT" },
    ready: { ru: "Каталог проверен", uk: "Каталог перевірено", en: "Catalog verified" },
    planning: { ru: "Расчёт зависимостей APT", uk: "Розрахунок залежностей APT", en: "Resolving APT dependencies" },
    apt_simulation: { ru: "Проверка плана локальным APT", uk: "Перевірка плану локальним APT", en: "Checking plan with local APT" },
    plan_ready: { ru: "План готов", uk: "План готовий", en: "Plan ready" },
    installing: { ru: "Установка выбранных пакетов", uk: "Встановлення вибраних пакетів", en: "Installing selected packages" },
  };
  return labels[phase]?.[language] ?? phase;
}

export function OnlinePackageFeedPanel({ sessionEnabled }: { sessionEnabled: boolean }) {
  const { colors } = useTheme();
  const { language } = useLanguage();
  const [state, setState] = useState<UiState>("idle");
  const [progress, setProgress] = useState(0);
  const [phase, setPhase] = useState("catalog");
  const [code, setCode] = useState<string | null>(null);
  const [packages, setPackages] = useState<OfflinePackageBundlePackage[]>([]);
  const [catalogInfo, setCatalogInfo] = useState<{ sequence: number; commit: string; expiresAtMs: number } | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [installPlan, setInstallPlan] = useState<{ planId: string; packages: OfflinePackageBundlePackage[] } | null>(null);
  const [query, setQuery] = useState("");
  const stageRef = useRef<{ stageId: string; requestId: string } | null>(null);
  const activeRef = useRef<ActiveOperation | null>(null);
  const visibleStateRef = useRef(state);
  visibleStateRef.current = state;

  const subscribeProgress = useCallback((requestId: string, kind: ActiveOperation["kind"]): ActiveOperation => {
    const subscription = onOfflineBundleProgress(event => {
      const active = activeRef.current;
      if (event.requestId !== requestId || active?.requestId !== requestId) return;
      setPhase(event.phase);
      setProgress(Math.min(99, Math.max(0, Number.isFinite(event.percent) ? event.percent : 0)));
    });
    return { requestId, kind, unsubscribe: subscription };
  }, []);

  const cleanupStage = useCallback(() => {
    const stage = stageRef.current;
    stageRef.current = null;
    setInstallPlan(null);
    if (stage) void cancelOfflinePackageBundle(stage.requestId).catch(() => undefined);
  }, []);

  const cancelActive = useCallback(() => {
    const active = activeRef.current;
    if (!active) return;
    if (active.kind === "fetch") void cancelOnlinePackageCatalog(active.requestId).catch(() => undefined);
    else void cancelOfflinePackageBundle(active.requestId).catch(() => undefined);
  }, []);

  useEffect(() => () => {
    const active = activeRef.current;
    if (active?.kind === "fetch") void cancelOnlinePackageCatalog(active.requestId).catch(() => undefined);
    else if (active) void cancelOfflinePackageBundle(active.requestId).catch(() => undefined);
    const stage = stageRef.current;
    if (stage) void cancelOfflinePackageBundle(stage.requestId).catch(() => undefined);
  }, []);

  const fetchCatalog = useCallback(async () => {
    if (!sessionEnabled || activeRef.current) return;
    cleanupStage();
    setPackages([]);
    setSelected(new Set());
    setInstallPlan(null);
    setCatalogInfo(null);
    setCode(null);
    setState("fetching");
    setProgress(0);
    setPhase("catalog");
    const requestId = createRequestId("fetch");
    const operation = subscribeProgress(requestId, "fetch");
    activeRef.current = operation;
    try {
      const result = await fetchAndStageOnlinePackageCatalog(requestId, (nextPhase, percent) => {
        if (activeRef.current?.requestId !== requestId) return;
        setPhase(nextPhase);
        setProgress(Math.min(99, Math.max(0, percent)));
      });
      if (activeRef.current?.requestId !== requestId) return;
      setCode(result.code);
      if (result.status !== "ready" || !result.stageId || !Array.isArray(result.packages) || !result.catalog) {
        setState(result.status === "blocked" ? "blocked" : "rejected");
        return;
      }
      stageRef.current = { stageId: result.stageId, requestId };
      setPackages(result.packages);
      setCatalogInfo({ sequence: result.catalog.sequence, commit: result.catalog.catalogCommit, expiresAtMs: result.catalog.expiresAtMs });
      setSelected(new Set());
      setProgress(100);
      setPhase("ready");
      setState("ready");
    } catch {
      if (activeRef.current?.requestId === requestId) {
        setCode("AIB_ONLINE_PACKAGE_FETCH_FAILED");
        setState("rejected");
      }
    } finally {
      if (activeRef.current?.requestId === requestId) {
        operation.unsubscribe();
        activeRef.current = null;
      }
    }
  }, [cleanupStage, sessionEnabled, subscribeProgress]);

  const togglePackage = useCallback((name: string) => {
    setInstallPlan(null);
    setSelected(current => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name); else next.add(name);
      return next;
    });
  }, []);

  const planSelected = useCallback(async () => {
    const stage = stageRef.current;
    const selectedNames = [...selected].sort();
    if (!stage || selectedNames.length < 1 || activeRef.current) return;
    setInstallPlan(null);
    const requestId = createRequestId("plan");
    setState("planning");
    setProgress(0);
    setPhase("planning");
    setCode(null);
    const operation = subscribeProgress(requestId, "plan");
    activeRef.current = operation;
    try {
      const result = await planOfflinePackageBundle(stage.stageId, requestId, selectedNames);
      if (activeRef.current?.requestId !== requestId) return;
      setCode(result.code);
      if (result.status !== "ready" || !result.planId || !Array.isArray(result.packages)) {
        setState(result.status === "blocked" ? "blocked" : "rejected");
        return;
      }
      setInstallPlan({ planId: result.planId, packages: result.packages });
      setProgress(100);
      setPhase("plan_ready");
      setState("ready");
    } catch {
      if (activeRef.current?.requestId === requestId) { setCode("AIB_OFFLINE_APT_PLAN_RESULT_UNAVAILABLE"); setState("blocked"); }
    } finally {
      if (activeRef.current?.requestId === requestId) {
        operation.unsubscribe();
        activeRef.current = null;
      }
    }
  }, [selected, subscribeProgress]);

  const installSelected = useCallback(() => {
    const stage = stageRef.current;
    const selectedNames = [...selected].sort();
    const confirmedPlan = installPlan;
    if (!stage || !confirmedPlan || selectedNames.length < 1 || activeRef.current) return;
    const selectedRows = selectedNames.map(name => packages.find(pkg => pkg.name === name)).filter((pkg): pkg is OfflinePackageBundlePackage => !!pkg);
    const closureRows = confirmedPlan.packages.map(pkg => `${pkg.name} ${pkg.version}${selectedNames.includes(pkg.name) ? (language === "en" ? " (selected root)" : language === "uk" ? " (вибраний корінь)" : " (выбранный корень)") : ""}`).join("\n");
    const title = language === "en" ? "Confirm selected package installation" : language === "uk" ? "Підтвердьте встановлення вибраних пакетів" : "Подтвердите установку выбранных пакетов";
    const message = language === "en"
      ? `Selected roots (${selectedRows.length}): ${selectedRows.map(pkg => pkg.name).join(", ")}\n\nExact local APT plan (${confirmedPlan.packages.length} package/version entries):\n${closureRows}\n\nThe native installer rechecks the Karat signature, catalog freshness/sequence, every file hash and package-index metadata, then installs these exact versions from the verified local feed. Downloads and removals are disabled. Cancellation may not roll back changes.`
      : language === "uk"
        ? `Вибрані кореневі пакети (${selectedRows.length}): ${selectedRows.map(pkg => pkg.name).join(", ")}\n\nТочний локальний план APT (${confirmedPlan.packages.length} пакетів/версій):\n${closureRows}\n\nНативний інсталятор повторно перевірить підпис Karat, свіжість/номер каталогу, хеші кожного файлу та метадані індексу, а потім встановить саме ці версії з перевіреного локального фіду. Завантаження й видалення вимкнені. Скасування може не відкотити зміни.`
        : `Выбранные корневые пакеты (${selectedRows.length}): ${selectedRows.map(pkg => pkg.name).join(", ")}\n\nТочный локальный план APT (${confirmedPlan.packages.length} пакетов/версий):\n${closureRows}\n\nНативный установщик повторно проверит подпись Karat, свежесть/номер каталога, хэши всех файлов и метаданные индекса, затем установит именно эти версии из проверенного локального фида. Загрузка и удаление отключены. Отмена может не откатить изменения.`;
    Alert.alert(title, message, [
      { text: language === "en" ? "Cancel" : language === "uk" ? "Скасувати" : "Отмена", style: "cancel" },
      { text: language === "en" ? "Install selected" : language === "uk" ? "Встановити вибране" : "Установить выбранное", style: "destructive", onPress: () => {
        void (async () => {
          const requestId = createRequestId("install");
          setState("installing");
          setProgress(0);
          setPhase("installing");
          setCode(null);
          const operation = subscribeProgress(requestId, "install");
          activeRef.current = operation;
          try {
            const result = await installOfflinePackageBundle(stage.stageId, requestId, selectedNames, confirmedPlan.planId);
            if (activeRef.current?.requestId !== requestId) return;
            setCode(result.code);
            if (result.status === "installed") { setState("installed"); setProgress(100); }
            else if (result.status === "partial") setState("partial");
            else if (result.code === "AIB_OFFLINE_PACKAGE_CANCELLED") setState("cancelled");
            else setState(result.status);
            stageRef.current = null;
            setInstallPlan(null);
          } catch {
            if (activeRef.current?.requestId === requestId) { setCode("AIB_OFFLINE_PACKAGE_INSTALL_RESULT_UNKNOWN"); setState("partial"); }
          } finally {
            if (activeRef.current?.requestId === requestId) {
              operation.unsubscribe();
              activeRef.current = null;
            }
          }
        })();
      } },
    ]);
  }, [installPlan, language, packages, selected, subscribeProgress]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return packages.filter(pkg => !needle || pkg.name.toLowerCase().includes(needle)).slice(0, 30);
  }, [packages, query]);
  const working = state === "fetching" || state === "planning" || state === "installing";
  const color = state === "partial" || state === "rejected" ? colors.danger : colors.accent;

  return (
    <View style={{ backgroundColor: colors.surface, borderColor: colors.line, borderWidth: 1, borderRadius: 14, padding: 12, marginBottom: 10 }}>
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 9 }}>
        <View style={{ flex: 1 }}>
          <Text style={{ color: colors.inkBright, fontSize: 15, fontWeight: "700" }}>
            {language === "en" ? "Online signed packages" : language === "uk" ? "Онлайн-пакети з підписом" : "Онлайн-пакеты с подписью"}
          </Text>
          <Text style={{ color: colors.muted, fontSize: 12, lineHeight: 17, marginTop: 4 }}>
            {language === "en"
              ? "Fetches a pinned Karat-signed catalog from the project GitHub Release, then stages verified files privately. Ordinary pkg/apt/dpkg commands remain blocked."
              : language === "uk"
                ? "Завантажує каталог із підписом Karat із закріпленого GitHub Release проєкту та перевіряє файли у приватному сховищі. Звичайні команди pkg/apt/dpkg залишаються заблокованими."
                : "Загружает каталог с подписью Karat из закреплённого GitHub Release проекта и проверяет файлы в приватном хранилище. Обычные команды pkg/apt/dpkg остаются заблокированными."}
          </Text>
        </View>
        <Ionicons name={working ? "cloud-download-outline" : "shield-checkmark-outline"} size={20} color={color} />
      </View>

      {working ? <View style={{ marginTop: 10 }}><ProgressBar progress={progress} indeterminate={false} label={phaseLabel(phase, language)} sublabel={language === "en" ? "Files are staged privately; no package changes before confirmation." : language === "uk" ? "Файли готуються у приватному сховищі; до підтвердження пакети не змінюються." : "Файлы подготавливаются в приватном хранилище; до подтверждения пакеты не меняются."} /></View> : null}
      {state === "ready" && catalogInfo ? (
        <Text style={{ color: colors.accent, fontSize: 12, marginTop: 8 }}>
          {language === "en" ? `Verified catalog #${catalogInfo.sequence}; ${packages.length} package records, ${bytesLabel(packages.reduce((sum, pkg) => sum + pkg.sizeBytes, 0))} of .deb files. Select package roots below.`
            : language === "uk" ? `Каталог №${catalogInfo.sequence} перевірено; ${packages.length} записів пакетів, ${bytesLabel(packages.reduce((sum, pkg) => sum + pkg.sizeBytes, 0))} .deb. Виберіть кореневі пакети нижче.`
              : `Каталог №${catalogInfo.sequence} проверен; ${packages.length} записей пакетов, ${bytesLabel(packages.reduce((sum, pkg) => sum + pkg.sizeBytes, 0))} .deb. Выберите корневые пакеты ниже.`}
        </Text>
      ) : null}
      {catalogInfo && state === "ready" ? (
        <Text style={{ color: colors.muted, fontSize: 10, marginTop: 3 }}>
          {`commit ${catalogInfo.commit.slice(0, 12)} · ${new Date(catalogInfo.expiresAtMs).toISOString()}`}
        </Text>
      ) : null}
      {state === "installed" ? <Text style={{ color: colors.accent, fontSize: 12, marginTop: 8 }}>{language === "en" ? "Native installer verified the selected package roots." : language === "uk" ? "Нативний інсталятор підтвердив вибрані кореневі пакети." : "Нативный установщик подтвердил выбранные корневые пакеты."}</Text> : null}
      {state === "partial" ? <Text style={{ color: colors.danger, fontSize: 12, marginTop: 8 }}>{language === "en" ? "The transaction may have made partial changes; no rollback is claimed." : language === "uk" ? "Транзакція могла частково змінити середовище; відкат не стверджується." : "Транзакция могла частично изменить среду; откат не заявляется."}</Text> : null}
      {state === "rejected" || state === "blocked" || state === "cancelled" ? <Text style={{ color: state === "rejected" ? colors.danger : colors.muted, fontSize: 12, marginTop: 8 }}>
        {code === "AIB_ONLINE_PACKAGE_FEED_NOT_PUBLISHED"
          ? (language === "en" ? "No release is available at the pinned destination yet. Nothing was installed; the feed remains closed until a qualified signed release is published." : language === "uk" ? "За закріпленою адресою ще немає релізу. Нічого не встановлено; фід залишатиметься закритим до публікації кваліфікованого підписаного релізу." : "По закреплённому адресу пока нет релиза. Ничего не установлено; фид останется закрытым до публикации квалифицированного релиза с подписью.")
          : (language === "en" ? `Online package operation blocked (${code ?? "unknown"}); no successful installation is claimed.` : language === "uk" ? `Операцію з онлайн-пакетами заблоковано (${code ?? "невідомо"}); успішне встановлення не заявляється.` : `Операция с онлайн-пакетами заблокирована (${code ?? "неизвестно"}); успешная установка не заявляется.`)}
      </Text> : null}

      {state === "ready" ? <>
        <TextInput value={query} onChangeText={setQuery} placeholder={language === "en" ? "Search packages" : language === "uk" ? "Пошук пакетів" : "Поиск пакетов"}
          placeholderTextColor={colors.muted} autoCapitalize="none" autoCorrect={false}
          style={{ color: colors.inkBright, backgroundColor: colors.surface, borderColor: colors.line, borderWidth: 1, borderRadius: 9, paddingHorizontal: 10, paddingVertical: 7, marginTop: 8, fontSize: 13 }} />
        <Text style={{ color: colors.muted, fontSize: 11, marginTop: 5 }}>
          {language === "en" ? `${selected.size} selected · showing up to 30 matches` : language === "uk" ? `Вибрано: ${selected.size} · показано до 30 збігів` : `Выбрано: ${selected.size} · показано до 30 совпадений`}
        </Text>
        <View style={{ marginTop: 4 }}>
          {filtered.map(pkg => {
            const checked = selected.has(pkg.name);
            return <TouchableOpacity key={`${pkg.name}@${pkg.version}`} onPress={() => togglePackage(pkg.name)} activeOpacity={0.75}
              style={{ flexDirection: "row", alignItems: "center", paddingVertical: 7, borderBottomColor: colors.line, borderBottomWidth: 0.5 }}>
              <Ionicons name={checked ? "checkbox" : "square-outline"} size={18} color={checked ? colors.accent : colors.muted} />
              <View style={{ flex: 1, marginLeft: 8 }}>
                <Text style={{ color: colors.inkBright, fontSize: 12, fontWeight: "600" }}>{pkg.name}</Text>
                <Text style={{ color: colors.muted, fontSize: 10 }}>{`${pkg.version} · ${pkg.architecture} · ${bytesLabel(pkg.sizeBytes)}`}</Text>
              </View>
            </TouchableOpacity>;
          })}
        </View>
        {installPlan ? <View style={{ marginTop: 10, padding: 9, borderColor: colors.accent, borderWidth: 1, borderRadius: 9 }}>
          <Text style={{ color: colors.accent, fontSize: 12, fontWeight: "700" }}>
            {language === "en" ? `Local APT plan · ${installPlan.packages.length} exact package versions` : language === "uk" ? `План локального APT · ${installPlan.packages.length} точних версій пакетів` : `План локального APT · ${installPlan.packages.length} точных версий пакетов`}
          </Text>
          {installPlan.packages.map(pkg => <Text key={`${pkg.name}@${pkg.version}`} style={{ color: colors.inkBright, fontSize: 11, marginTop: 3 }}>
            {`${pkg.name} ${pkg.version}${selected.has(pkg.name) ? (language === "en" ? " · root" : language === "uk" ? " · корінь" : " · корень") : ""}`}
          </Text>)}
          <Text style={{ color: colors.muted, fontSize: 10, lineHeight: 14, marginTop: 6 }}>
            {language === "en" ? "Calculated by the embedded APT against the signed local index. Any dpkg status change or expired plan blocks installation." : language === "uk" ? "Розраховано вбудованим APT за підписаним локальним індексом. Зміна статусу dpkg або завершення строку плану заблокує встановлення." : "Рассчитано встроенным APT по подписанному локальному индексу. Изменение статуса dpkg или истечение срока плана заблокирует установку."}
          </Text>
        </View> : null}
      </> : null}

      <View style={{ flexDirection: "row", gap: 8, marginTop: 10 }}>
        {!working ? <TouchableOpacity onPress={() => void fetchCatalog()} disabled={!sessionEnabled} activeOpacity={0.75}
          style={{ flex: 1, borderColor: colors.accent, borderWidth: 1, borderRadius: 10, paddingVertical: 9, paddingHorizontal: 8, flexDirection: "row", alignItems: "center", justifyContent: "center", opacity: sessionEnabled ? 1 : 0.5 }}>
          <Ionicons name="cloud-download-outline" size={16} color={colors.accent} />
          <Text style={{ color: colors.accent, fontSize: 12, fontWeight: "700", marginLeft: 6 }}>{language === "en" ? "Fetch & verify" : language === "uk" ? "Завантажити й перевірити" : "Загрузить и проверить"}</Text>
        </TouchableOpacity> : null}
        {state === "ready" && !installPlan ? <TouchableOpacity onPress={() => void planSelected()} disabled={selected.size === 0} activeOpacity={0.75}
          style={{ flex: 1, borderColor: colors.accent, backgroundColor: colors.surface, borderWidth: 1, borderRadius: 10, paddingVertical: 9, paddingHorizontal: 8, flexDirection: "row", alignItems: "center", justifyContent: "center", opacity: selected.size ? 1 : 0.5 }}>
          <Ionicons name="list-outline" size={16} color={colors.accent} />
          <Text style={{ color: colors.accent, fontSize: 12, fontWeight: "700", marginLeft: 6 }}>{language === "en" ? "Review dependency plan" : language === "uk" ? "Переглянути план залежностей" : "Рассчитать зависимости"}</Text>
        </TouchableOpacity> : null}
        {state === "ready" && installPlan ? <TouchableOpacity onPress={installSelected} disabled={selected.size === 0} activeOpacity={0.75}
          style={{ flex: 1, borderColor: colors.danger, backgroundColor: colors.dangerDim, borderWidth: 1, borderRadius: 10, paddingVertical: 9, paddingHorizontal: 8, flexDirection: "row", alignItems: "center", justifyContent: "center", opacity: selected.size ? 1 : 0.5 }}>
          <Ionicons name="download-outline" size={16} color={colors.danger} />
          <Text style={{ color: colors.danger, fontSize: 12, fontWeight: "700", marginLeft: 6 }}>{language === "en" ? "Install planned packages" : language === "uk" ? "Встановити пакети з плану" : "Установить пакеты из плана"}</Text>
        </TouchableOpacity> : null}
        {working ? <TouchableOpacity onPress={cancelActive} activeOpacity={0.75}
          style={{ flex: 1, borderColor: colors.danger, backgroundColor: colors.dangerDim, borderWidth: 1, borderRadius: 10, paddingVertical: 9, paddingHorizontal: 8, flexDirection: "row", alignItems: "center", justifyContent: "center" }}>
          <Ionicons name="close-circle-outline" size={16} color={colors.danger} />
          <Text style={{ color: colors.danger, fontSize: 12, fontWeight: "700", marginLeft: 6 }}>{language === "en" ? "Cancel" : language === "uk" ? "Скасувати" : "Отмена"}</Text>
        </TouchableOpacity> : null}
        {working ? <ActivityIndicator size="small" color={colors.accent} /> : null}
      </View>
    </View>
  );
}
