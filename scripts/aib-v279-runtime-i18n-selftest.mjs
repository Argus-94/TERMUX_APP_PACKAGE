#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadRuntimeTs } from "./test-helpers/load-runtime-ts.mjs";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const { runtimeText, runtimeStageLabel, runtimeProgressText, runtimeReadinessText, runtimePreparationFailureText } =
  loadRuntimeTs(path.join(root, "lib/runtime-i18n.ts"));
const { inspectProotRuntimeReadiness } = loadRuntimeTs(path.join(root, "lib/runtime-environment-check.ts"));
const { t, LANGUAGE_LABELS } = loadRuntimeTs(path.join(root, "lib/i18n.ts"));
const languages = ["ru", "uk", "en"];
assert.deepEqual(Object.keys(LANGUAGE_LABELS).sort(), [...languages].sort(), "only the three declared app languages are supported");

const deniedRootfs = {
  target: "ubuntu-proot",
  status: "error",
  phase: "rootfs-check",
  reason: "permission",
  detail: "Selected ubuntu rootfs state could not be verified because Termux RUN_COMMAND permission was denied",
};
const expectedRootfsTerms = {
  ru: ["Ubuntu", "rootfs", "запрещён"],
  uk: ["Ubuntu", "rootfs", "заборонено"],
  en: ["Ubuntu", "rootfs", "access was denied"],
};
for (const language of languages) {
  const text = runtimeReadinessText(language, deniedRootfs);
  for (const term of expectedRootfsTerms[language]) assert.ok(text.includes(term), `${language} rootfs message includes ${term}`);
  assert.doesNotMatch(text, /RUN_COMMAND permission was denied|installation is blocked until/i, `${language} does not leak the engine's English diagnostic`);
  assert.ok(!text.includes("/private/device/path"), `${language} message does not include private diagnostic paths`);
}

const hostPermission = await inspectProotRuntimeReadiness("ubuntu-proot", {
  run: async () => { throw new Error("RUN_COMMAND_PERMISSION_MISSING"); },
});
assert.equal(hostPermission.reason, "permission", "the production checker exposes a safe permission reason code");
const hostTimeout = await inspectProotRuntimeReadiness("ubuntu-proot", {
  run: async () => ({ exitCode: 124, stdout: "", stderr: "", timedOut: true }),
});
assert.equal(hostTimeout.reason, "timeout", "the production checker exposes a safe timeout reason code");
const hostTruncated = await inspectProotRuntimeReadiness("ubuntu-proot", {
  run: async () => ({ exitCode: 0, stdout: "AIB_PROOT_TOOL:AVAILABLE", stderr: "", outputTruncated: true }),
});
assert.equal(hostTruncated.reason, "truncated-output", "the production checker exposes a safe incomplete-output reason code");

const readinessCases = [
  { status: "ready", phase: "ready", reason: undefined, missingItems: [] },
  { status: "missing", phase: "host-check", reason: undefined, missingItems: ["proot-distro (Termux host)"] },
  { status: "missing", phase: "rootfs-check", reason: undefined, missingItems: ["ubuntu rootfs"] },
  { status: "missing", phase: "guest-baseline", reason: undefined, missingItems: ["curl", "git"] },
  ...["permission", "timeout", "truncated-output", "command-failed", "bridge-failure", "interrupted", "unknown-status", "list-unverified", "architecture-mismatch", "identity-unverified", "guest-check", "unknown"]
    .flatMap((reason) => ["host-check", "rootfs-check", "guest-baseline"].map((phase) => ({ status: "error", phase, reason, missingItems: [] }))),
];
for (const language of languages) {
  for (const item of readinessCases) {
    const text = runtimeReadinessText(language, { target: "ubuntu-proot", ...item });
    assert.ok(text && !text.includes("{"), `${language} ${item.status}/${item.phase}/${item.reason ?? "-"} resolves every placeholder`);
    if (language !== "en") assert.doesNotMatch(text, /could not be verified|the command timed out|environment is unverified/i, `${language} readiness uses its locale`);
  }
}
assert.match(runtimeReadinessText("ru", { target: "ubuntu-proot", status: "missing", phase: "guest-baseline", missingItems: ["curl"] }), /curl/);
assert.match(runtimeReadinessText("uk", { target: "ubuntu-proot", status: "missing", phase: "guest-baseline", missingItems: ["curl"] }), /curl/);
assert.match(runtimeReadinessText("en", { target: "ubuntu-proot", status: "missing", phase: "guest-baseline", missingItems: ["curl"] }), /curl/);

const expectedStages = {
  ru: "Проверка rootfs",
  uk: "Перевірка rootfs",
  en: "Rootfs check",
};
for (const language of languages) {
  assert.equal(runtimeStageLabel(language, "rootfs-check"), expectedStages[language]);
  const progress = runtimeProgressText(language, "rootfs-check", "ubuntu-proot");
  assert.ok(progress.includes("Debian"), `${language} progress names the selected distro`);
  if (language !== "en") assert.doesNotMatch(progress, /Checking the|selected debian/i, `${language} progress uses the selected app language`);
}

const rawFailure = "ROOTFS_INSTALL_TIMEOUT after 2700000ms; /data/user/0/com.example/private-path";
const expectedFailureTerms = {
  ru: ["Debian", "подготовка остановлена", "время ожидания"],
  uk: ["Debian", "підготовку зупинено", "час очікування"],
  en: ["Debian", "preparation stopped", "timed out"],
};
for (const language of languages) {
  const text = runtimePreparationFailureText(language, "ubuntu-proot", "rootfs", rawFailure);
  for (const term of expectedFailureTerms[language]) assert.ok(text.includes(term), `${language} preparation error includes ${term}`);
  assert.doesNotMatch(text, /2700000|private-path|ROOTFS_INSTALL_TIMEOUT/, `${language} preparation error suppresses raw internals`);
}

const exportKeys = [
  "saveLogDialogTitle",
  "logExportSuccess",
  "logExportError",
  "logExportPermissionDenied",
  "logExportWrongDirectory",
  "logExportStorageUnavailable",
  "logExportWriteFailed",
  "logExportTooLarge",
  "logExportSaving",
  "logExportFolderHint",
];
for (const language of languages) {
  for (const key of exportKeys) {
    const text = t(language, key);
    assert.ok(text && text !== key && !text.includes("{"), `${language}.${key} resolves from the active app locale`);
  }
}
assert.match(t("ru", "logExportError"), /Не удалось сохранить лог/);
assert.match(t("uk", "logExportError"), /Не вдалося зберегти лог/);
assert.equal(t("en", "logExportError"), "Failed to save log.");
assert.match(t("ru", "logExportSaving"), /Сохранение/);
assert.match(t("uk", "logExportSaving"), /Збереження/);
assert.equal(t("en", "logExportSaving"), "Saving…");

const screen = fs.readFileSync(path.join(root, "app/log-screen.tsx"), "utf8");
assert.match(screen, /exportLogsToFile\(t\("saveLogDialogTitle"\)\)/, "the system share dialog receives the active app-language title");
assert.match(screen, /showDialog\(t\("modelError"\), t\(messageKey\)\)/, "export failures are selected from the active locale catalog");
assert.match(screen, /t\("logExportSaving"\)/, "export progress uses the active locale catalog");

const runtimeScreen = fs.readFileSync(path.join(root, "app/runtime.tsx"), "utf8");
assert.match(runtimeScreen, /runtimeReadinessText\(language, selectedReadiness\)/, "the selected runtime summary is localized at presentation time");
assert.match(runtimeScreen, /runtimeProgressText\(language, runtimePreparationUiProgress/, "runtime preparation progress is localized at presentation time");
assert.doesNotMatch(runtimeScreen, /setLinuxOutput\(result\.detail\)|setLinuxOutput\(result\.error\)/, "raw runtime diagnostics are not sent directly to output UI");
assert.doesNotMatch(runtimeScreen, /Ubuntu launch requires the selected Ubuntu environment|Selected .*rootfs state could not be verified/, "runtime feedback is not hard-coded in English");

console.log("AIB_V279_RUNTIME_I18N_SELFTEST_OK locales=ru,uk,en runtime=readiness/progress/preparation export=localized");
