import { createContext, useContext, useState, useCallback, useEffect, useRef, ReactNode } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  checkTermuxReadiness,
  type TermuxReadiness,
} from "../lib/termux-bridge";
import { useLanguage } from "./LanguageContext";
import { persistAsyncStorageItem } from "../lib/persistence";
import { useDialog } from "./DialogContext";
import { useLoggerContext } from "./LoggerContext";

const STORAGE_KEY = "aibuilder.termux.enabled.v1";

export type BuildStageStatus = "pending" | "active" | "done" | "error" | "skipped";
export type TermuxTaskKind = "create_apk" | "build_apk" | "repair_source" | "reverse" | "generic";
export type TermuxTaskStatus = "running" | "completed" | "failed" | "cancelled";

export interface BuildStage {
  id: string;
  label: string;
  status: BuildStageStatus;
  detail?: string;
}

export interface ReverseToolStatus {
  id: string;
  label: string;
  status: "installed" | "missing" | "optional";
  kind?: "pkg" | "pip" | "jar" | "runtime";
}

export interface TermuxActivity {
  command: string;
  step: number;
  maxSteps: number;
  taskKind?: TermuxTaskKind;
  taskStatus?: TermuxTaskStatus;
  /** Valid only when explicitly reported by the task backend. */
  progressPercent?: number;
  errorMessage?: string;
  title?: string;
  detail?: string;
  stage?: string;
  stageIndex?: number;
  stageCount?: number;
  stages?: BuildStage[];
  isBuild?: boolean;
  buildStatus?: "running" | "recovering" | "verified";
  recovery?: number;
  maxRecovery?: number;
  diagnosis?: string;
  action?: string;
  result?: string;
  isReverse?: boolean;
  reverseTools?: ReverseToolStatus[];
}

interface TermuxContextType {
  /** Termux-сессия включена и прошла проверку готовности. */
  enabled: boolean;
  /** Идёт проверка готовности (после нажатия "включить"). */
  checking: boolean;
  /** Пользователь включает/выключает через кнопки в боковом меню. true = готово. */
  setEnabled: (value: boolean) => Promise<boolean>;
  /** Текущая команда агента (для панели активности). */
  activity: TermuxActivity | null;
  setActivity: (a: TermuxActivity | null) => void;
}

const TermuxContext = createContext<TermuxContextType | null>(null);

export function TermuxProvider({ children }: { children: ReactNode }) {
  const { t, language } = useLanguage();
  const { showDialog } = useDialog();
  const { logInfo, logWarn } = useLoggerContext();
  const [enabled, setEnabledState] = useState(false);
  const [checking, setChecking] = useState(false);
  const [activity, setActivity] = useState<TermuxActivity | null>(null);
  const hydrated = useRef(false);

  useEffect(() => {
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(STORAGE_KEY);
        // Stored value is a user preference, not proof that Termux is still
        // installed/permissioned after a restart. Re-check readiness before
        // exposing an effective enabled=true state.
        if (raw === "1") {
          setChecking(true);
          const readiness = await checkTermuxReadiness({ deep: true, refreshPermission: true });
          setEnabledState(readiness.ready);
          if (!readiness.ready) {
            logWarn("Termux", t("termuxNotReadyLog", { reasons: readiness.reasons.join(", ") }));
          }
        }
      } catch {
        // остаёмся выключенными по умолчанию
        setEnabledState(false);
      } finally {
        setChecking(false);
        hydrated.current = true;
      }
    })();
  }, [logWarn, t]);

  const persist = useCallback((value: boolean) => {
    persistAsyncStorageItem(STORAGE_KEY, value ? "1" : "0");
  }, []);

  const setEnabled = useCallback(
    async (value: boolean): Promise<boolean> => {
      if (!value) {
        setEnabledState(false);
        persist(false);
        logInfo("Termux", t("termuxSessionStoppedLog"));
        return false;
      }

      setChecking(true);
      try {
        const readiness = await checkTermuxReadiness({ deep: true, refreshPermission: true });
        if (!readiness.ready) {
          logWarn("Termux", t("termuxNotReadyLog", { reasons: readiness.reasons.join(", ") }));
          const title = language === "en" ? "Embedded runtime is not ready" : language === "uk" ? "Вбудоване середовище не готове" : "Встроенная среда не готова";
          const body = language === "en"
            ? "Commands remain in the embedded private runtime. Open Runtime to review current diagnostics; no external app or command dispatch is needed."
            : language === "uk"
              ? "Команди залишаються у вбудованому приватному середовищі. Відкрийте Runtime для актуальної діагностики; зовнішній застосунок або передавання команд не потрібні."
              : "Команды выполняются во встроенной приватной среде. Откройте Runtime для актуальной диагностики; внешнее приложение и передача команд не требуются.";
          showDialog(title, `${body}${readiness.probeDetail ? `\n\n${readiness.probeDetail}` : ""}`, [{ text: t("cancel"), style: "cancel" as const }]);
          setEnabledState(false);
          persist(false);
          return false;
        }

        setEnabledState(true);
        persist(true);
        logInfo("Termux", t("termuxSessionStartedLog"));
        return true;
      } finally {
        setChecking(false);
      }
    },
    [persist, showDialog, t, language, logInfo, logWarn]
  );


  return (
    <TermuxContext.Provider value={{ enabled, checking, setEnabled, activity, setActivity }}>
      {children}
    </TermuxContext.Provider>
  );
}

export function useTermuxContext() {
  const ctx = useContext(TermuxContext);
  if (!ctx) throw new Error("useTermuxContext must be used within TermuxProvider");
  return ctx;
}
