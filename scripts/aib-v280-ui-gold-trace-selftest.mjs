#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadRuntimeTs } from "./test-helpers/load-runtime-ts.mjs";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const colorsModule = loadRuntimeTs(path.join(root, "theme/colors.ts"));
const { GOLD, GOLD_LIGHT, GOLD_DEEP, darkColors, lightColors } = colorsModule;
assert.equal(darkColors.warning, GOLD);
assert.equal(lightColors.warning, GOLD_DEEP, "light-mode warning text remains contrast-aware deep Gold");
assert.equal(GOLD, "#C9A227");
assert.equal(GOLD_LIGHT, "#E7D28A");
assert.equal(GOLD_DEEP, "#8B6914");
const luminance = (hex) => {
  const rgb = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255).map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
};
const contrast = (a, b) => { const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (high + 0.05) / (low + 0.05); };
assert.ok(contrast(darkColors.warning, darkColors.onWarning) >= 4.5, "dark Gold warning fill/foreground contrast >= 4.5:1");
assert.ok(contrast(lightColors.warning, lightColors.onWarning) >= 4.5, "light Gold warning fill/foreground contrast >= 4.5:1");

const { TerminalTheme } = loadRuntimeTs(path.join(root, "core/enhancements/terminal/TerminalTheme.ts"));
const terminalThemes = new TerminalTheme().listThemes();
assert.ok(terminalThemes.length >= 10, "all original terminal themes remain present");
for (const theme of terminalThemes) {
  const light = theme.id === "light" || theme.id === "solarized-light";
  assert.equal(theme.ansi[3], light ? GOLD_DEEP : GOLD, `${theme.id}: ANSI yellow slot is Gold`);
  if (!theme.id.startsWith("solarized-")) {
    assert.equal(theme.ansi[11], light ? GOLD_DEEP : GOLD_LIGHT, `${theme.id}: bright ANSI yellow slot is a Gold tone`);
  }
}
const highContrast = terminalThemes.find((theme) => theme.id === "ai-contrast");
assert.equal(highContrast.cursor, GOLD, "high-contrast cursor uses Gold instead of a pure-yellow literal");
const legacyGold = terminalThemes.find((theme) => theme.id === "ai-amber");
assert.equal(legacyGold.name, "AI Builder Gold", "saved theme ID stays backward-compatible while the visible label uses Gold");
assert.equal(legacyGold.cursor, GOLD_LIGHT);
const github = read("app/github.tsx");
assert.match(github, /backgroundColor: colors\.warning/);
assert.match(github, /color: colors\.onWarning/);
assert.doesNotMatch(github, /#6A4D16|#FFF4D1/);
const webGold = read("assets/github-tool/css/common.css");
assert.match(webGold, /--gold:\s*#C9A227/);
assert.match(webGold, /--gold-light:\s*#E7D28A/);
assert.match(webGold, /--gold-deep:\s*#8B6914/);
assert.match(webGold, /--warn:\s*var\(--gold\)/);
const embeddedUi = [
  webGold,
  read("assets/github-tool/css/builder-theme.css"),
  read("assets/github-tool/css/files.css"),
  read("assets/github-tool/css/releases.css"),
  read("assets/github-tool/js/app.js"),
].join("\n");
assert.match(embeddedUi, /var\(--gold\)/);
assert.doesNotMatch(embeddedUi, /#F2C879|#3A3320/i, "embedded GitHub UI no longer carries its old yellow warning/draft literals");
assert.doesNotMatch(read("core/enhancements/terminal/TerminalTheme.ts"), /#(?:FACC15|FDE68A|FFFF00|FBBF24|FFFF77|F1FA8C|FFFFA5|EBCB8B|D79921|FABD2F|F9E2AF|E0AF68|E5C07B|E6DB74|FFF27A)\b/i, "no previous yellow ANSI palette literals remain");

const runtimeUi = read("app/runtime.tsx");
assert.match(runtimeUi, /const setMessage = useCallback\([\s\S]{0,220}setMessageSource\("app"\)/, "ordinary app messages explicitly reset runtime-status provenance");
assert.match(runtimeUi, /shouldHideDuplicateRuntimeStatusBanner\(/, "banner suppression is delegated to the narrow, behavior-tested predicate");
assert.match(runtimeUi, /expectedPreparationResult = selectedCardReadinessStatus === "error"[\s\S]{0,220}rtText\(language, "prepareBlocked"/, "only the exact localized preparation wrapper for a selected card error is considered");
assert.match(runtimeUi, /message && !hideDuplicateRuntimeStatusMessage/, "independent messages are not hidden by value-only equality");
assert.doesNotMatch(runtimeUi, /message !== selectedEnvironmentStatusSummary/, "there is no unscoped summary-equality suppression");
assert.match(runtimeUi, /\{selectedEnvironmentStatusSummary\}/, "the comparison target is the summary actually rendered in the selected card");
assert.match(runtimeUi, /setRuntimeStatusMessage\(rtText\(language, "prepareBlocked", \{ distro: targetLabel, reason \}\), "preparation-result"\)/, "Prepare block banner is tagged as a preparation result");
assert.match(runtimeUi, /\{error \? \(/, "the page-level original error remains visible");
assert.match(runtimeUi, /runtimePreparationUiProgress/, "localized preparation progress remains rendered");
assert.match(runtimeUi, /setLinuxOutput\(reason\)/, "the selected runtime card retains its single localized error");
assert.match(runtimeUi, /runtimeProgressText\(language, stage, backend\)/, "progress stays localized through existing i18n helpers");

const { shouldHideDuplicateRuntimeStatusBanner } = loadRuntimeTs(path.join(root, "lib/runtime-status-banner.ts"));
const { runtimeText } = loadRuntimeTs(path.join(root, "lib/runtime-i18n.ts"));
const cardCause = "Ubuntu: состояние rootfs или вход в него не подтверждены (мост команд Termux не вернул результат). Существующие данные сохранены; установка заблокирована.";
const combinedPrepareResult = runtimeText("ru", "prepareBlocked", { distro: "Ubuntu", reason: cardCause });
assert.equal(combinedPrepareResult, `Ubuntu: подготовка безопасно остановлена. ${cardCause}`, "the test uses the actual Russian production template shown in the screenshot");
const exactDuplicate = {
  message: cardCause,
  trackedRuntimeMessage: cardCause,
  messageSource: "runtime-status",
  messagePurpose: "readiness-result",
  selectedReadinessStatus: "error",
  selectedCardCause: cardCause,
  expectedPreparationResult: null,
};
assert.equal(shouldHideDuplicateRuntimeStatusBanner(exactDuplicate), true, "exact tracked Runtime cause already visible in the selected card is hidden");
assert.equal(shouldHideDuplicateRuntimeStatusBanner({
  ...exactDuplicate,
  message: combinedPrepareResult,
  trackedRuntimeMessage: combinedPrepareResult,
  messagePurpose: "preparation-result",
  expectedPreparationResult: combinedPrepareResult,
}), true, "exact localized prepareBlocked prefix plus the selected-card cause is hidden as one banner");
assert.equal(shouldHideDuplicateRuntimeStatusBanner({
  ...exactDuplicate,
  messageSource: "app",
  messagePurpose: null,
}), false, "an independent app/other-screen message stays visible even if its text matches the card");
assert.equal(shouldHideDuplicateRuntimeStatusBanner({
  ...exactDuplicate,
  message: "GitHub: независимая ошибка входа",
  trackedRuntimeMessage: null,
  messageSource: "app",
  messagePurpose: null,
}), false, "unrelated user-facing messages remain visible");
assert.equal(shouldHideDuplicateRuntimeStatusBanner({
  ...exactDuplicate,
  message: `${combinedPrepareResult} Дополнительное сообщение для пользователя.`,
  trackedRuntimeMessage: `${combinedPrepareResult} Дополнительное сообщение для пользователя.`,
  messagePurpose: "preparation-result",
  expectedPreparationResult: combinedPrepareResult,
}), false, "a preparation banner with content beyond the card cause is not hidden by substring matching");
assert.equal(shouldHideDuplicateRuntimeStatusBanner({
  ...exactDuplicate,
  message: `Ubuntu: подготовка приостановлена. ${cardCause}`,
  trackedRuntimeMessage: `Ubuntu: подготовка приостановлена. ${cardCause}`,
  messagePurpose: "preparation-result",
  expectedPreparationResult: combinedPrepareResult,
}), false, "an unrecognized prefix containing the cause is not hidden");
assert.equal(shouldHideDuplicateRuntimeStatusBanner({
  ...exactDuplicate,
  messagePurpose: "preparation-start",
}), false, "preparation-start notices are never suppressed as error duplicates");
assert.equal(shouldHideDuplicateRuntimeStatusBanner({
  ...exactDuplicate,
  message: "Ubuntu: среда готова",
  trackedRuntimeMessage: "Ubuntu: среда готова",
  messagePurpose: "readiness-result",
  selectedReadinessStatus: "ready",
  selectedCardCause: "Ubuntu: среда готова",
}), true, "an exact tracked ready summary is still hidden because it is already rendered in the card");
assert.equal(shouldHideDuplicateRuntimeStatusBanner({
  ...exactDuplicate,
  selectedReadinessStatus: null,
}), false, "a stale tracked message is not hidden after the selected card loses a readiness result");

const traceSchema = loadRuntimeTs(path.join(root, "lib/diagnostic-trace.ts"));
const trace = traceSchema.buildDiagnosticTraceRecord({
  correlationId: "tr-runtime-check-1",
  commandId: "js-123-abc",
  nativeCommandId: "0123456789abcdef0123456789abcdef",
  action: "runtime.check",
  step: "native.result",
  status: "failed",
  backend: "termux",
  target: "ubuntu",
  screen: "runtime",
  durationMs: 17,
  timeoutMs: 90000,
  exitCode: 0,
  stdoutBytes: 0,
  stderrBytes: 0,
  resultCode: "empty",
  errorCategory: "callback-missing",
  androidRunCommand: "granted",
  termuxExternalApps: "not-observed",
});
assert.equal(trace.nativeCommandId, "0123456789abcdef0123456789abcdef");
assert.equal(trace.androidRunCommand, "granted");
assert.equal(trace.termuxExternalApps, "not-observed", "Android grant is not conflated with Termux's unobservable app setting");
assert.equal(Object.hasOwn(trace, "command"), false);
assert.equal(Object.hasOwn(trace, "stdout"), false);

const logRedaction = loadRuntimeTs(path.join(root, "lib/log-redaction.ts"));
const commandRedaction = loadRuntimeTs(path.join(root, "lib/command-log-redaction.ts"));
const privateInput = [
  "Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789",
  "github_pat_abcdefghijklmnopqrstuvwxyz0123456789",
  "sk-proj-1234567890abcdefgh",
  "api_key=private-api-key-value",
  "https://private.example.invalid/v1/repos/account/private-project?access_token=url-secret-value",
  "/storage/emulated/0/AIBuilderTermux/private/project/main.ts",
  "/home/karat/private-project/src/secret.ts",
].join(" ");
const safePrivate = logRedaction.redactBuildDiagnostics(privateInput);
for (const privateValue of [
  "abcdefghijklmnopqrstuvwxyz0123456789", "github_pat_abcdefghijklmnopqrstuvwxyz0123456789", "sk-proj-1234567890abcdefgh",
  "private-api-key-value", "private.example.invalid", "account/private-project", "url-secret-value",
  "/storage/emulated/0/AIBuilderTermux", "/home/karat/private-project", "private-project-content",
]) assert.equal(safePrivate.includes(privateValue), false, `persistent log redaction removes ${privateValue}`);
const safeCommandOutput = commandRedaction.summarizeCommandOutputForLogs("aib rootfs probe", "AIB_PROBE_BEGIN\nprivate-project-content\nsource code line\n");
assert.match(safeCommandOutput, /AIB_PROBE_BEGIN/);
assert.equal(safeCommandOutput.includes("private-project-content"), false);
assert.equal(safeCommandOutput.includes("source code line"), false);
const safePersistedCommandOutput = logRedaction.redactPersistentLogPayload("Termux:js-1:stdout", "AIB_PROBE_BEGIN\nprivate-project-content\nsource code line\n");
assert.match(safePersistedCommandOutput, /AIB_PROBE_BEGIN/);
assert.equal(safePersistedCommandOutput.includes("private-project-content"), false);
assert.equal(safePersistedCommandOutput.includes("source code line"), false);
assert.equal(logRedaction.redactPersistentLogPayload("Chat", "private-project-content"), "[CHAT_CONTENT_OMITTED chars=23]");
assert.equal(logRedaction.redactPersistentLogPayload("Console", "private-project-content"), "[CONSOLE_TEXT_OMITTED chars=23]");

const logger = read("lib/persistent-logger.ts");
assert.match(logger, /console\.capture/);
assert.match(logger, /network\.fetch/);
assert.match(logger, /fetch\.start/);
assert.match(logger, /httpStatus: response\.status/);
assert.match(logger, /errorCategory/);
assert.match(logger, /markAppEvent\(event: string/);
assert.match(logger, /endpoint=remote/);
assert.doesNotMatch(logger, /this\.add\([^\n]*JSON\.stringify\(init|this\.add\([^\n]*requestBody|this\.add\([^\n]*input\.url/);
const appLayout = read("app/_layout.tsx");
assert.match(appLayout, /markAppEvent\("SCREEN_VIEW"/);
assert.match(appLayout, /useSegments/);
const bridge = read("lib/termux-bridge.ts");
for (const stage of ["android.run-command-permission-check", "bridge.command-dispatch", "bridge.command-result"]) assert.ok(bridge.includes(stage), `bridge trace stage ${stage}`);
assert.match(bridge, /termuxExternalApps: "not-observed"/);
assert.match(bridge, /normalizeNativeCommandResult/);

console.log("OK: Gold/contrast, exact+composite Runtime duplicate suppression, app/unrelated message retention, localized progress, and privacy-safe trace metadata");
