import "./runtime-polyfills";
import { persistentLogger } from "./persistent-logger";

/**
 * Раньше приложение "просто вылетало" без единой записи в Логе, потому что:
 *  1) лог хранился только в памяти (см. lib/persistent-logger.ts — уже
 *     исправлено там);
 *  2) не было ни одного глобального обработчика необработанных JS-ошибок,
 *     так что необработанное исключение приводило прямо к падению без
 *     единой строчки в лог приложения.
 *
 * ErrorUtils — стандартный, документированный глобальный объект React
 * Native (доступен без дополнительных зависимостей) для перехвата фатальных
 * и нефатальных JS-ошибок, которые не были пойманы ни одним try/catch.
 */

let installed = false;

function formatError(error: unknown): string {
  if (error instanceof Error) {
    const stack = error.stack ? `\n${error.stack}` : "";
    const msg = `${error.name}: ${error.message}${stack}`;
    return msg.length > 4000 ? msg.slice(0, 4000) + "…[truncated]" : msg;
  }
  const s = String(error);
  return s.length > 4000 ? s.slice(0, 4000) + "…[truncated]" : s;
}

export function installGlobalErrorHandlers() {
  if (installed) return;
  installed = true;

  const g = globalThis as any;

  if (g.ErrorUtils && typeof g.ErrorUtils.setGlobalHandler === "function") {
    const defaultHandler = g.ErrorUtils.getGlobalHandler?.();
    g.ErrorUtils.setGlobalHandler((error: unknown, isFatal?: boolean) => {
      try {
        persistentLogger.add(
          "error",
          "Crash",
          `${isFatal ? "[FATAL] " : "[JS ERROR] "}${formatError(error)}`
        );
      } catch {
        // логирование не должно само по себе уронить обработчик ошибок
      }
      if (typeof defaultHandler === "function") {
        defaultHandler(error, isFatal);
      }
    });
  }

  // Необработанные отказы промисов — частая причина "тихих" падений
  // (например, ошибка внутри async-обработчика кнопки). RN использует
  // полифилл Promise из пакета "promise", который поддерживает трекинг
  // необработанных rejection'ов из коробки.
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const rejectionTracking = require("promise/setimmediate/rejection-tracking");
    rejectionTracking.disable();
    rejectionTracking.enable({
      allRejections: true,
      onUnhandled: (id: number, error: unknown) => {
        persistentLogger.add("error", "Crash", `[UNHANDLED PROMISE REJECTION] ${formatError(error)}`);
      },
      onHandled: () => {},
    });
  } catch {
    // модуль недоступен в этой версии RN/Metro — не критично, JS-обработчик
    // выше всё равно перехватит большинство фатальных ошибок.
  }
}
