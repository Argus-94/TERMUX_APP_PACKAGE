import { Platform } from "react-native";
import { getEmbeddedTermuxRuntimeStatus, type TermuxReadiness } from "./termux-bridge";
import { persistentLogger } from "./persistent-logger";
import { buildTermuxStatusFlags, type TermuxStatusFlag } from "./termux-status-flags";
export type { TermuxStatusFlag } from "./termux-status-flags";
export type TermuxBridgeStatus = { ready: boolean; flags: TermuxStatusFlag[]; readiness: TermuxReadiness; probeDetail?: string };

/** Readiness is measured from the app-private embedded bootstrap, never external package discovery. */
export async function getTermuxBridgeStatus(_deep = true): Promise<TermuxBridgeStatus> {
  const readiness: TermuxReadiness = { ready: false, reasons: [] };
  if (Platform.OS !== "android") readiness.reasons.push("not_android");
  else {
    try {
      const runtime = await getEmbeddedTermuxRuntimeStatus();
      if (runtime) {
        readiness.ready = runtime.ready;
        if (!runtime.ready) readiness.reasons.push("termux_not_installed");
      } else readiness.reasons.push("native_module_missing");
    } catch { readiness.reasons.push("termux_install_check_failed"); }
  }
  return { ready: readiness.ready, flags: buildTermuxStatusFlags(readiness), readiness };
}

/** Native app startup owns bootstrap installation; this action only reports native status. */
export async function repairTermuxBridge(): Promise<string[]> {
  const status = await getTermuxBridgeStatus(false);
  const steps = status.ready
    ? ["Встроенная private runtime AI Builder готова ✓"]
    : ["Встроенная private runtime AI Builder не готова; внешний Termux/add-on не устанавливается.", "Штатная установка выполняется нативным bootstrap при запуске; проверьте журнал приложения."];
  persistentLogger.add(status.ready ? "info" : "warn", "EmbeddedRuntimeStatus", steps.join(" | "));
  return steps;
}
export type OnboardingStepId = "install" | "allow_external" | "packages" | "echo_ok";
export async function getOnboardingSteps(): Promise<Array<{ id: OnboardingStepId; done: boolean; title: string; actionHint: string }>> {
  const ready = (await getTermuxBridgeStatus(false)).ready;
  return [
    { id: "install", done: ready, title: "1. Встроенная среда", actionHint: "Private runtime приложения AI Builder" },
    { id: "allow_external", done: ready, title: "2. Встроенный runtime", actionHint: "Отдельный Termux не требуется и не используется" },
    { id: "packages", done: ready, title: "3. Bootstrap", actionHint: "Состояние проверено по приватному prefix" },
    { id: "echo_ok", done: ready, title: "4. Готовность", actionHint: "Нативный статус embedded runtime" },
  ];
}
