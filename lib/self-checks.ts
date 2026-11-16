/**
 * Лёгкие самопроверки (guard + gradle parser + layout).
 * Отчёт для пользователя — понятный текст; detail остаётся для лога.
 */

import type { TranslationKey } from "./i18n";

import { guardTermuxCommand } from "./termux-guard";
import { parseGradleErrors } from "./build-loop";
import { parseAndroidLayoutXml } from "./layout-preview";
import {
  runStructuralGates,
  gatesPassed,
  evaluateFailToPassContract,
  clusterFailure,
} from "./agent-trace";
import { safePath } from "./agent-tools/common";

export type SelfCheckId =
  | "guard_rm_root"
  | "guard_ls_home"
  | "gradle_parse"
  | "layout_parse"
  | "agent_gates"
  | "agent_fail_to_pass"
  | "path_safe"
  | "cluster_lock";

export interface CheckResult {
  id: SelfCheckId;
  /** Короткое техническое имя (для лога) */
  name: string;
  ok: boolean;
  /** Техническая деталь (JSON / reason) — в лог, не в «простой» диалог */
  detail: string;
}

export function runSelfChecks(): CheckResult[] {
  const out: CheckResult[] = [];

  const g1 = guardTermuxCommand("rm -rf /");
  out.push({
    id: "guard_rm_root",
    name: "guard blocks rm -rf /",
    ok: !g1.ok,
    detail: g1.ok ? "should block" : "reason" in g1 ? g1.reason : "blocked",
  });

  const g2 = guardTermuxCommand("ls -la ~/");
  out.push({
    id: "guard_ls_home",
    name: "guard allows ls ~",
    ok: g2.ok,
    detail: g2.ok ? "ok" : "reason" in g2 ? g2.reason : "fail",
  });

  const log = `e: file:///data/data/com.karat.aibuilder/files/home/p/Main.kt:12:5 Cannot find name 'Foo'\nBUILD FAILED`;
  const errs = parseGradleErrors(log);
  out.push({
    id: "gradle_parse",
    name: "parseGradleErrors finds file:line",
    ok: errs.some((e) => e.file?.includes("Main.kt") && e.line === 12),
    detail: JSON.stringify(errs.slice(0, 2)),
  });

  const xml = `<LinearLayout xmlns:android="http://schemas.android.com/apk/res/android">
  <TextView android:id="@+id/title" android:text="Hello"/>
</LinearLayout>`;
  const tree = parseAndroidLayoutXml(xml);
  out.push({
    id: "layout_parse",
    name: "layout parse LinearLayout+TextView",
    ok: !!tree && tree.tag === "LinearLayout" && tree.children[0]?.tag === "TextView",
    detail: tree ? tree.tag + "/" + (tree.children[0]?.tag || "") : "null",
  });

  const passDone =
    "APK: /storage/emulated/0/AIBuilderTermux/HelloWorld/app/build/outputs/apk/debug/app-debug.apk";
  const failDone = "Сборка успешна. Проверьте app/build/outputs/apk/.";
  const gPass = runStructuralGates("Создай Hello World", passDone, { requireApk: true });
  const gFail = runStructuralGates("Создай Hello World", failDone, { requireApk: true });
  out.push({
    id: "agent_gates",
    name: "structural gates reject relative APK success",
    ok: gatesPassed(gPass) && !gatesPassed(gFail),
    detail: `pass=${gatesPassed(gPass)} failRejected=${!gatesPassed(gFail)}`,
  });

  const ftp = evaluateFailToPassContract(
    "Создай Hello World",
    failDone,
    passDone,
    true,
  );
  out.push({
    id: "agent_fail_to_pass",
    name: "fail-to-pass contract",
    ok: ftp.ok,
    detail: ftp.report,
  });

  // Project-relative path guard
  let pathOk = false;
  try {
    safePath("app/src/main/AndroidManifest.xml");
    pathOk = true;
  } catch {
    pathOk = false;
  }
  let pathAbsBlocked = false;
  try {
    safePath("/etc/passwd");
  } catch {
    pathAbsBlocked = true;
  }
  out.push({
    id: "path_safe",
    name: "safePath allows relative, blocks absolute",
    ok: pathOk && pathAbsBlocked,
    detail: `rel=${pathOk} absBlocked=${pathAbsBlocked}`,
  });

  const cl = clusterFailure("BUILD_LOCK_TIMEOUT: another build holds lock");
  out.push({
    id: "cluster_lock",
    name: "clusterFailure maps BUILD_LOCK",
    ok: cl.cluster === "concurrent_build_lock" && cl.recipeId === "build-lock",
    detail: JSON.stringify(cl),
  });

  return out;
}

export type SelfCheckI18n = {
  (key: TranslationKey, params?: Record<string, string | number>): string;
};

/**
 * Понятный отчёт для диалога (без JSON и технических имён).
 */
export function formatSelfCheckReport(
  results: CheckResult[],
  t?: SelfCheckI18n,
): string {
  const okCount = results.filter((r) => r.ok).length;
  const total = results.length;
  const allOk = okCount === total;

  const tr = (key: string, fallback: string, params?: Record<string, string | number>) => {
    if (!t) {
      let s = fallback;
      if (params) {
        for (const [k, v] of Object.entries(params)) {
          s = s.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
        }
      }
      return s;
    }
    try {
      return t(key as TranslationKey, params);
    } catch {
      return fallback;
    }
  };

  const header = allOk
    ? tr(
        "selfCheckSummaryAllOk",
        "Всё в порядке: {ok} из {total} проверок пройдены.\nБазовые защиты приложения работают.",
        { ok: okCount, total },
      )
    : tr(
        "selfCheckSummaryPartial",
        "Пройдено {ok} из {total} проверок.\nНиже — что это значит простыми словами.",
        { ok: okCount, total },
      );

  const itemMeta: Record<
    SelfCheckId,
    { titleKey: TranslationKey; titleFb: string; okKey: TranslationKey; okFb: string; failKey: TranslationKey; failFb: string }
  > = {
    guard_rm_root: {
      titleKey: "selfCheckGuardRmTitle",
      titleFb: "Защита от опасных команд",
      okKey: "selfCheckGuardRmOk",
      okFb: "Опасное удаление системных файлов блокируется.",
      failKey: "selfCheckGuardRmFail",
      failFb: "Внимание: опасная команда не была заблокирована.",
    },
    guard_ls_home: {
      titleKey: "selfCheckGuardLsTitle",
      titleFb: "Обычные команды разрешены",
      okKey: "selfCheckGuardLsOk",
      okFb: "Безопасные команды (просмотр папок) выполняются нормально.",
      failKey: "selfCheckGuardLsFail",
      failFb: "Безопасная команда неожиданно запрещена.",
    },
    gradle_parse: {
      titleKey: "selfCheckGradleTitle",
      titleFb: "Разбор ошибок сборки",
      okKey: "selfCheckGradleOk",
      okFb: "Приложение понимает, в каком файле и строке упала сборка.",
      failKey: "selfCheckGradleFail",
      failFb: "Не удалось разобрать пример ошибки сборки.",
    },
    layout_parse: {
      titleKey: "selfCheckLayoutTitle",
      titleFb: "Разбор экранов Android",
      okKey: "selfCheckLayoutOk",
      okFb: "Разметка экрана (кнопки, текст) читается корректно.",
      failKey: "selfCheckLayoutFail",
      failFb: "Не удалось разобрать пример разметки экрана.",
    },
    agent_gates: {
      titleKey: "selfCheckSummaryPartial",
      titleFb: "Проверка честности сборки APK",
      okKey: "selfCheckSummaryAllOk",
      okFb: "Ложный «успех» без пути к APK отклоняется.",
      failKey: "selfCheckSummaryPartial",
      failFb: "Структурные проверки APK работают некорректно.",
    },
    agent_fail_to_pass: {
      titleKey: "selfCheckSummaryPartial",
      titleFb: "Контракт fail-to-pass",
      okKey: "selfCheckSummaryAllOk",
      okFb: "Плохой DONE отклоняется, хороший — принимается.",
      failKey: "selfCheckSummaryPartial",
      failFb: "Контракт fail-to-pass нарушен.",
    },
    path_safe: {
      titleKey: "selfCheckGuardRmTitle",
      titleFb: "Проверка путей",
      okKey: "selfCheckGuardRmOk",
      okFb: "Относительные пути разрешены, абсолютные блокируются.",
      failKey: "selfCheckGuardRmFail",
      failFb: "Ограничение путей работает неверно.",
    },
    cluster_lock: {
      titleKey: "selfCheckGuardRmTitle",
      titleFb: "Кластер lock",
      okKey: "selfCheckGuardRmOk",
      okFb: "BUILD_LOCK распознаётся и мапится на repair.",
      failKey: "selfCheckGuardRmFail",
      failFb: "Кластеризация BUILD_LOCK не сработала.",
    },
  };

  const lines = results.map((r) => {
    const m = itemMeta[r.id] || {
      titleKey: "selfCheckSummaryPartial",
      titleFb: r.name,
      okKey: "selfCheckSummaryPartial",
      okFb: r.detail,
      failKey: "selfCheckSummaryPartial",
      failFb: r.detail,
    };
    const title = tr(m.titleKey, m.titleFb);
    const body = r.ok ? tr(m.okKey, m.okFb) : tr(m.failKey, m.failFb);
    return `${r.ok ? "✓" : "✗"} ${title}\n   ${body}`;
  });

  const footer = tr(
    "selfCheckFooter",
    "Это внутренняя проверка AI Builder, а не отчёт о вашей сборке APK. Подробности для разработчика пишутся в лог.",
  );

  return [header, "", ...lines, "", footer].join("\n");
}

/** Компактная строка только для persistentLogger (техническая). */
export function formatSelfCheckLogLine(results: CheckResult[]): string {
  const ok = results.filter((r) => r.ok).length;
  return (
    `Self-checks: ${ok}/${results.length} passed | ` +
    results.map((r) => `${r.ok ? "OK" : "FAIL"}:${r.id}`).join(" ")
  );
}
