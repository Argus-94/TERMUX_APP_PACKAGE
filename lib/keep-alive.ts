import { AppState, type AppStateStatus, Platform } from "react-native";
import {
  hideSessionNotification,
  initAppNotifications,
  setStatusDismissHandler,
  showSessionNotification,
} from "./app-notifications";
import { persistentLogger } from "./persistent-logger";

/**
 * Keep-alive для офлайн-модели.
 *
 * A-03 remediation: no longer starts a foreground service.
 * Android 15+ ограничивает indefinite dataSync FGS, поэтому не поднимаем
 * отдельный native Service «навсегда». Вместо этого:
 *  1) sticky-уведомление (одно в шторке + кнопка «Выгрузить из памяти»);
 *  2) при уходе в background повторно показываем/обновляем его;
 *  3) «Выгрузить из памяти» → unload + stop keep-alive (единственный путь из шторки).
 *
 * Это заметно снижает вероятность мгновенного kill при переключении приложений
 * (особенно вместе с исключением из оптимизации батареи).
 */

let active = false;
let appStateSub: { remove: () => void } | null = null;
let unloadOnDismiss: (() => void | Promise<void>) | null = null;

function onAppState(next: AppStateStatus): void {
  if (!active || Platform.OS !== "android") return;
  if (next === "background" || next === "inactive") {
    void showSessionNotification(
      "AI Builder · модель в памяти",
      "Модель в фоне, не выгружается. «Выгрузить из памяти» — освободить RAM."
    );
  }
}

export const modelKeepAlive = {
  /** Вызывается после успешной load() офлайн-модели. */
  async start(opts?: { onDismissUnload?: () => void | Promise<void> }): Promise<void> {
    if (Platform.OS !== "android") return;
    if (active) {
      // refresh dismiss callback only
      if (opts?.onDismissUnload) unloadOnDismiss = opts.onDismissUnload;
      return;
    }
    try {
      await initAppNotifications();
      unloadOnDismiss = opts?.onDismissUnload ?? null;
      setStatusDismissHandler(async () => {
        active = false;
        if (appStateSub) {
          appStateSub.remove();
          appStateSub = null;
        }
        const cb = unloadOnDismiss;
        unloadOnDismiss = null;
        setStatusDismissHandler(null);
        if (cb) await cb();
        persistentLogger.add("info", "KeepAlive", "dismissed via notification button");
      });
      active = true;
      if (!appStateSub) {
        appStateSub = AppState.addEventListener("change", onAppState);
      }
      await showSessionNotification(
        "AI Builder · модель в памяти",
        "Модель удерживается в RAM. «Выгрузить из памяти» — снять уведомление и выгрузить."
      );
      persistentLogger.add(
        "info",
        "KeepAlive",
        "offline model pinned in memory while session notification is active",
      );
    } catch (e: unknown) {
      persistentLogger.add(
        "warn",
        "KeepAlive",
        `start failed: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  },

  /** Вызывается при unload модели или выходе. */
  async stop(): Promise<void> {
    if (Platform.OS !== "android") return;
    active = false;
    unloadOnDismiss = null;
    setStatusDismissHandler(null);
    if (appStateSub) {
      try {
        appStateSub.remove();
      } catch {
        /* ignore */
      }
      appStateSub = null;
    }
    try {
      await hideSessionNotification();
    } catch {
      /* ignore */
    }
    persistentLogger.add("info", "KeepAlive", "session sticky notification stopped");
  },

  isActive(): boolean {
    return active;
  },

  /** True while sticky session notification holds the model in RAM. */
  isPinned(): boolean {
    return active;
  },
};
