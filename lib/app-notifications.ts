/**
 * Локальные уведомления AI Builder — одно «умное» уведомление в шторке.
 *
 * Политика:
 *  • В шторке всегда не больше ОДНОГО уведомления (фиксированный id aib-status).
 *  • sticky = сессия модели (RAM) ИЛИ активная долгая задача (сборка/агент).
 *  • Пока AppState === "active" — не дублируем финалы (кроме sticky).
 *  • Старт/прогресс задачи — одно ongoing; финал — то же id (успех/ошибка).
 *  • Кнопка «Выгрузить из памяти» только у sticky офлайн-модели (asSession).
 *  • Онлайн/агент/Termux (asTask) — кнопка «Закрыть» (только снять уведомление, модель не трогаем).
 */

import { AppState, Platform } from "react-native";
import { errorMessage } from "./error-utils";
import { persistentLogger } from "./persistent-logger";

let Notifications: typeof import("expo-notifications") | null = null;
let ready = false;
let responseSub: { remove: () => void } | null = null;

/** Единственный id — новое уведомление заменяет предыдущее. */
export const STATUS_NOTIFICATION_ID = "aib-status";

const CATEGORY_ID = "aib-status-actions";
const CATEGORY_TASK_CLOSE = "aib-task-close";
const ACTION_DISMISS = "aib-dismiss";
const ACTION_CLOSE = "aib-close";

/** Sticky: модель в RAM. */
let sessionSticky = false;
let sessionTitle = "AI Builder";
let sessionBody = "Офлайн-модель в памяти";

/** Sticky: долгая задача (сборка / агент / Termux). Не путать с model session. */
let taskSticky = false;
let taskTitle = "AI Builder";
let taskBody = "Выполняется…";
let taskDepth = 0;

type DismissHandler = () => void | Promise<void>;
let onDismissHandler: DismissHandler | null = null;

export function setStatusDismissHandler(handler: DismissHandler | null): void {
  onDismissHandler = handler;
}

async function loadModule(): Promise<typeof import("expo-notifications") | null> {
  if (Notifications) return Notifications;
  try {
    Notifications = await import("expo-notifications");
    return Notifications;
  } catch (e: unknown) {
    persistentLogger.add("warn", "Notify", `expo-notifications unavailable: ${errorMessage(e)}`);
    return null;
  }
}

function isAppInForeground(): boolean {
  return AppState.currentState === "active";
}

export async function initAppNotifications(): Promise<void> {
  if (ready) return;
  try {
    const N = await loadModule();
    if (!N) return;

    N.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowBanner: true,
        shouldShowList: true,
        shouldPlaySound: false,
        shouldSetBadge: false,
      }),
    });

    if (Platform.OS === "android") {
      // Основной канал: важные исходы + сессия модели (одна шторка).
      await N.setNotificationChannelAsync("status", {
        name: "Статус AI Builder",
        description: "Одно уведомление: модель в памяти и итоги долгих задач",
        importance: N.AndroidImportance.LOW,
        enableVibrate: false,
        showBadge: false,
        lockscreenVisibility: N.AndroidNotificationVisibility.PUBLIC,
      });
      await N.setNotificationChannelAsync("important", {
        name: "Важные события",
        description: "Завершение задач, ошибки модели",
        importance: N.AndroidImportance.DEFAULT,
        enableVibrate: false,
        showBadge: false,
      });
      // Старые каналы — на случай уже установленных APK.
      await N.setNotificationChannelAsync("silent", {
        name: "Фон (без звука)",
        description: "Фоновые статусы",
        importance: N.AndroidImportance.LOW,
        enableVibrate: false,
        showBadge: false,
      });
    }

    // Offline session: unload model. Online/task: only close notification.
    try {
      await N.setNotificationCategoryAsync(CATEGORY_ID, [
        {
          identifier: ACTION_DISMISS,
          buttonTitle: "Выгрузить из памяти",
          options: {
            opensAppToForeground: true,
            isDestructive: true,
          },
        },
      ]);
      await N.setNotificationCategoryAsync(CATEGORY_TASK_CLOSE, [
        {
          identifier: ACTION_CLOSE,
          buttonTitle: "Закрыть",
          options: {
            opensAppToForeground: false,
            isDestructive: false,
          },
        },
      ]);
    } catch (e: unknown) {
      persistentLogger.add("warn", "Notify", `category setup: ${errorMessage(e)}`);
    }

    // Startup is read-only: optional notification access is requested only
    // from the explicit Permissions & access screen after its rationale.
    if (Platform.OS === "android" || Platform.OS === "ios") {
      try {
        const permission = await N.getPermissionsAsync();
        persistentLogger.add("info", "Notify", `permission status checked without prompting: ${permission.status}`);
      } catch (e: unknown) {
        persistentLogger.add("warn", "Notify", `permission status check failed: ${errorMessage(e)}`);
      }
    }

    // Один listener на действие «Закрыть».
    if (responseSub) {
      try {
        responseSub.remove();
      } catch {
        /* ignore */
      }
      responseSub = null;
    }
    const handleDismissAction = async (source: string) => {
      try {
        const wasSession = sessionSticky;
        sessionSticky = false;
        taskSticky = false;
        taskDepth = 0;
        await clearStatusNotification();
        if (wasSession && onDismissHandler) {
          persistentLogger.add("info", "Notify", `user requested model unload via notification (${source})`);
          await onDismissHandler();
        } else {
          persistentLogger.add("info", "Notify", `status notification dismissed (${source}, session=${wasSession})`);
        }
      } catch (e: unknown) {
        persistentLogger.add("warn", "Notify", `dismiss handler: ${errorMessage(e)}`);
      }
    };

    responseSub = N.addNotificationResponseReceivedListener((response) => {
      const action = response.actionIdentifier;
      if (action === ACTION_DISMISS) {
        void handleDismissAction("tap");
      } else if (action === ACTION_CLOSE) {
        void (async () => {
          try {
            taskSticky = false;
            taskDepth = 0;
            await clearStatusNotification();
            persistentLogger.add("info", "Notify", "task notification closed by user (model untouched)");
          } catch (e: unknown) {
            persistentLogger.add("warn", "Notify", `close: ${errorMessage(e)}`);
          }
        })();
      }
    });

    // Cold start / killed process: action may only be available after JS boots.
    try {
      const last = await N.getLastNotificationResponseAsync();
      if (last?.actionIdentifier === ACTION_DISMISS) {
        void handleDismissAction("cold-start");
        try {
          await N.clearLastNotificationResponseAsync?.();
        } catch {
          /* optional API */
        }
      }
    } catch {
      /* ignore */
    }

    ready = true;
    persistentLogger.add("info", "Notify", "Каналы уведомлений готовы (status/important, single id)");
  } catch (e: unknown) {
    persistentLogger.add("warn", "Notify", `init failed: ${errorMessage(e)}`);
  }
}

type Channel = "status" | "important" | "silent";

async function present(
  title: string,
  body: string,
  opts: {
    channel?: Channel;
    force?: boolean;
    /** ongoing: модель или задача (не авто-dismiss). */
    sticky?: boolean;
    /** Обновить текст сессии модели (не task). */
    asSession?: boolean;
    /** Обновить текст активной задачи. */
    asTask?: boolean;
    ephemeral?: boolean;
  } = {}
): Promise<void> {
  if (!opts.force && !opts.sticky && !taskSticky && !sessionSticky && isAppInForeground()) {
    persistentLogger.add("debug", "Notify", `skip (foreground): ${title}`);
    return;
  }
  try {
    if (!ready) await initAppNotifications();
    const N = await loadModule();
    if (!N) return;

    // Do not schedule and then treat a rejected notification call as a grant.
    // Re-read at use time so changes made in Android Settings are observed.
    if (Platform.OS === "android" || Platform.OS === "ios") {
      try {
        const permission = await N.getPermissionsAsync();
        if (!permission.granted && permission.status !== "granted") {
          persistentLogger.add("debug", "Notify", "skip notification: platform grant is not confirmed");
          return;
        }
      } catch (e: unknown) {
        persistentLogger.add("warn", "Notify", `skip notification: permission status unavailable (${errorMessage(e)})`);
        return;
      }
    }

    if (opts.asSession) {
      sessionSticky = true;
      sessionTitle = title;
      sessionBody = body;
    }
    if (opts.asTask) {
      taskSticky = true;
      taskTitle = title;
      taskBody = body;
    }

    const sticky = !!opts.sticky || sessionSticky || taskSticky;

    const channelId =
      Platform.OS === "android"
        ? opts.channel || (sticky ? "status" : "important")
        : undefined;

    // Offline session → unload. Online/task sticky → Close only. Ephemeral → no actions.
    const showUnloadButton = !!opts.asSession;
    const showCloseButton = !showUnloadButton && (!!opts.asTask || taskSticky);
    const categoryIdentifier = showUnloadButton
      ? CATEGORY_ID
      : showCloseButton
        ? CATEGORY_TASK_CLOSE
        : undefined;
    await N.scheduleNotificationAsync({
      identifier: STATUS_NOTIFICATION_ID,
      content: {
        title,
        body: (body || "").slice(0, 240),
        sound: false,
        ...(categoryIdentifier ? { categoryIdentifier } : {}),
        data: {
          sticky,
          task: taskSticky,
          session: sessionSticky,
          aib: true,
          unload: showUnloadButton,
          close: showCloseButton,
        },
        ...(Platform.OS === "android"
          ? {
              channelId,
              sticky: sticky,
              autoDismiss: !sticky,
              priority: sticky
                ? N.AndroidNotificationPriority.LOW
                : N.AndroidNotificationPriority.DEFAULT,
              // Android: actions come from category; omit category → no buttons.
            }
          : {}),
      },
      trigger: null,
    });
  } catch (e: unknown) {
    persistentLogger.add("warn", "Notify", `present failed: ${errorMessage(e)}`);
  }
}

/** Снять единственное уведомление из шторки. */
export async function clearStatusNotification(): Promise<void> {
  try {
    if (!ready) await initAppNotifications();
    const N = await loadModule();
    if (!N) return;
    await N.dismissNotificationAsync(STATUS_NOTIFICATION_ID);
    try {
      await N.cancelScheduledNotificationAsync(STATUS_NOTIFICATION_ID);
    } catch {
      /* ignore */
    }
  } catch (e: unknown) {
    persistentLogger.add("warn", "Notify", `clear failed: ${errorMessage(e)}`);
  }
}

/**
 * Sticky-сессия: модель в памяти — одно постоянное уведомление с «Закрыть».
 * Помогает Android не убивать процесс сразу при уходе в фон.
 */
export async function showSessionNotification(
  title = "AI Builder · модель в памяти",
  body = "Модель удерживается в RAM. Кнопка «Выгрузить из памяти» — снять уведомление и выгрузить."
): Promise<void> {
  await present(title, body, { sticky: true, force: true, channel: "status", asSession: true });
}

/** Обновить текст sticky сессии модели без второго уведомления. */
export async function updateSessionNotification(title: string, body: string): Promise<void> {
  if (!sessionSticky) return;
  await present(title, body, { sticky: true, force: true, channel: "status", asSession: true });
}

/** Убрать sticky модели; если задача ещё идёт — вернуть task-уведомление. */
export async function hideSessionNotification(): Promise<void> {
  sessionSticky = false;
  if (taskSticky) {
    await present(taskTitle, taskBody, { sticky: true, force: true, channel: "status", asTask: true });
  } else {
    await clearStatusNotification();
  }
}

export function isSessionSticky(): boolean {
  return sessionSticky;
}

// ─── Публичный API: только исходы долгих работ (все → один id) ───────────

function endTaskSticky(): void {
  taskDepth = Math.max(0, taskDepth - 1);
  if (taskDepth === 0) taskSticky = false;
}

export function notifyAgentDone(summary: string): void {
  const short = (summary || "Готово").replace(/\s+/g, " ").trim().slice(0, 160);
  endTaskSticky();
  void (async () => {
    if (sessionSticky) {
      await present(sessionTitle, `✅ ${short}`, {
        sticky: true,
        force: true,
        channel: "status",
        asSession: true,
      });
    } else {
      // снять ongoing task, затем одно итоговое (тот же id)
      taskSticky = false;
      taskDepth = 0;
      await clearStatusNotification();
      await present("✅ Задача выполнена", short, { force: true, channel: "important" });
    }
  })();
}

export function notifyAgentFailed(reason: string): void {
  const short = (reason || "Ошибка").replace(/\s+/g, " ").trim().slice(0, 160);
  endTaskSticky();
  void (async () => {
    if (sessionSticky) {
      await present(sessionTitle, `❌ ${short}`, {
        sticky: true,
        force: true,
        channel: "status",
        asSession: true,
      });
    } else {
      taskSticky = false;
      taskDepth = 0;
      await clearStatusNotification();
      await present("❌ Задача не выполнена", short, { force: true, channel: "important" });
    }
  })();
}

/** Старт долгой задачи — одно ongoing-уведомление (тот же id). */
export function notifyAgentStarted(task?: string): void {
  taskDepth += 1;
  const short = (task || "Выполняется…").replace(/\s+/g, " ").trim().slice(0, 160);
  void present("AI Builder · выполняется", short, {
    sticky: true,
    force: true,
    channel: "status",
    asTask: true,
  });
}

export function notifyPackDone(packLabel: string, ok: boolean): void {
  const name = packLabel || "пакет";
  if (ok) {
    void present("✅ Инструменты готовы", `${name} установлен`, {
      channel: sessionSticky ? "status" : "important",
      sticky: sessionSticky,
      force: sessionSticky,
    });
  } else {
    void present("⚠️ Установка не завершена", `${name}: проверьте лог / Termux`, {
      channel: sessionSticky ? "status" : "important",
      sticky: sessionSticky,
      force: sessionSticky,
    });
  }
}

export function notifyModelDownloaded(modelName: string, sizeGb: number): void {
  void present(
    "⬇️ Модель скачана",
    `${modelName}${sizeGb > 0 ? ` (${sizeGb.toFixed(1)} ГБ)` : ""} — можно загружать в память`,
    { channel: "important" }
  );
}

export function notifyModelFailed(modelName: string, reason: string): void {
  void present(
    "❌ Ошибка модели",
    `${modelName}: ${(reason || "").slice(0, 120)}`,
    { channel: "important", force: true }
  );
}

// ─── Прогресс / фоновые статусы (тот же id, без размножения) ───────────

export function notifyBuildProgress(detail?: string): void {
  const short = (detail || "Сборка…").replace(/\s+/g, " ").trim().slice(0, 160);
  if (taskDepth <= 0) taskDepth = 1;
  void present("AI Builder · сборка", short, {
    sticky: true,
    force: true,
    channel: "status",
    asTask: true,
  });
}

/** Sticky for bootstrap / backup / generic long work (plan A1). */
export async function notifyLongTask(title: string, body: string): Promise<void> {
  if (taskDepth <= 0) taskDepth = 1;
  taskSticky = true;
  taskTitle = title.slice(0, 80);
  taskBody = (body || "Выполняется…").replace(/\s+/g, " ").trim().slice(0, 160);
  await present(taskTitle, taskBody, {
    sticky: true,
    force: true,
    channel: "status",
    asTask: true,
  });
}

/** Bootstrap stage progress (plan C3). */
export async function notifyBootstrapProgress(stageId: string, percent: number, message: string): Promise<void> {
  await present(
    `AI Builder · bootstrap ${Math.max(0, Math.min(100, Math.round(percent)))}%`,
    `${stageId}: ${message}`.slice(0, 180),
    { sticky: true, force: true, channel: "status", asTask: true },
  );
  if (taskDepth <= 0) taskDepth = 1;
}

export async function clearTaskSticky(): Promise<void> {
  taskDepth = 0;
  taskSticky = false;
  if (!sessionSticky) {
    await clearStatusNotification();
  }
}

export function notifyModelLoaded(modelName?: string): void {
  void showSessionNotification(
    "AI Builder · модель в памяти",
    modelName ? `${modelName} загружена` : "Офлайн-модель в памяти",
  );
}

export function notifyOnlineRequest(modelName?: string): void {
  void present(
    "AI Builder · запрос",
    modelName ? `Онлайн: ${modelName}` : "Отправка запроса…",
    { sticky: true, force: true, channel: "status", asTask: true },
  );
  if (taskDepth <= 0) taskDepth = 1;
}

export function notifyLocalProcessing(): void {
  void present("AI Builder · локально", "Обработка на устройстве…", {
    sticky: true,
    force: true,
    channel: "status",
    asTask: true,
  });
  if (taskDepth <= 0) taskDepth = 1;
}

export function notifyTermuxActive(): void {
  void present("AI Builder · Termux", "Идёт команда в Termux…", {
    sticky: true,
    force: true,
    channel: "status",
    asTask: true,
  });
  if (taskDepth <= 0) taskDepth = 1;
}

export function notifyBatteryExemption(): void {
  // Settings navigation is a user action; a notification/background callback
  // must never launch a battery exemption screen on its own.
  persistentLogger.add("info", "Notify", "battery exemption remains optional; settings require an explicit user action");
}

export function notifyCheckpointSaved(name?: string): void {
  void present("💾 Чекпоинт", name || "Сохранено", { force: true, channel: "important" });
}

export function notifyCheckpointRestored(name?: string): void {
  void present("↩️ Чекпоинт", name || "Восстановлено", { force: true, channel: "important" });
}
