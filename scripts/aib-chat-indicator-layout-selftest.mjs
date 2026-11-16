#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadTs } from "./aib-interceptor-test-helper.mjs";
const { allocateIndicatorBodyHeights, getInterceptorIndicatorState, isInterceptorListenerLive } = loadTs("lib/chat-indicator-layout.ts");
const { buildIndicatorModel } = loadTs("lib/build-indicator-presentation.ts");
const { classifyTermuxTaskKind, createObservedAssembleStages, applyObservedBuildStageUpdate } = loadTs("lib/task-activity.ts");
const { darkColors, lightColors } = loadTs("theme/colors.ts");

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const styles = fs.readFileSync(path.join(root, "lib/ui-expanded-highlight.ts"), "utf8");
const headerStyle = styles.slice(styles.indexOf("export function indicatorHeaderStyle("));
assert.doesNotMatch(headerStyle, /201,\s*162,\s*39|EXPANDED_GOLD/, "expanded build/chat indicator headers must remain neutral, without Gold fill");
assert.match(headerStyle, /backgroundColor: colors\.surface/);
assert.match(headerStyle, /borderColor: colors\.accent/);

const live = { status: "listening", address: "127.0.0.1", port: 18181 };
assert.equal(isInterceptorListenerLive(live), true);
assert.equal(isInterceptorListenerLive({ ...live, status: "capturing" }), true);
assert.equal(isInterceptorListenerLive({ ...live, status: "stopped" }), false);
assert.equal(isInterceptorListenerLive({ ...live, status: "error" }), false);
assert.equal(isInterceptorListenerLive({ ...live, address: "0.0.0.0" }), false);
assert.equal(isInterceptorListenerLive({ ...live, port: 0 }), false);
assert.equal(isInterceptorListenerLive({ status: "listening" }), false, "a UI-only active flag without confirmed endpoint is neutral");
assert.equal(getInterceptorIndicatorState(live), "running");
assert.equal(getInterceptorIndicatorState({ status: "starting" }), "starting");
assert.equal(getInterceptorIndicatorState({ status: "stopping" }), "stopping");
assert.equal(getInterceptorIndicatorState({ status: "error" }), "error");
assert.equal(getInterceptorIndicatorState({ status: "unsupported" }), "unsupported");
assert.equal(getInterceptorIndicatorState({ status: "stopped" }), "stopped");
assert.equal(getInterceptorIndicatorState({ ...live, address: "0.0.0.0" }), "error", "claimed listening state without confirmed loopback is not rendered active");

function luminance(hex) {
  const channels = hex.slice(1).match(/../g).map((part) => parseInt(part, 16) / 255).map((v) => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}
function contrastRatio(a, b) { const values = [luminance(a), luminance(b)].sort((x, y) => y - x); return (values[0] + 0.05) / (values[1] + 0.05); }
for (const [name, palette] of [["dark", darkColors], ["light", lightColors]]) {
  assert.ok(contrastRatio(palette.success, palette.onAccent) >= 3, `${name} active track/thumb contrast >= 3:1`);
  assert.ok(contrastRatio(palette.line, palette.inkBright) >= 3, `${name} inactive track/thumb contrast >= 3:1`);
  assert.ok(contrastRatio(palette.accent, palette.background) >= 3, `${name} focus ring/background contrast >= 3:1`);
  assert.ok(contrastRatio(palette.warning, palette.background) >= 4.5, `${name} Gold warning text/background contrast >= 4.5:1`);
}
assert.equal(darkColors.warning.toUpperCase(), "#C9A227", "dark Gold is the shared brand token");
assert.equal(lightColors.warning.toUpperCase(), "#8B6914", "light theme uses deep Gold for text contrast");

const completedStages = [
  { id: "compile", label: "Compile", status: "done" },
  { id: "verify", label: "Verify APK", status: "done" },
];
const notYetVerified = buildIndicatorModel({ stages: completedStages });
assert.notEqual(notYetVerified.status, "verified");
assert.equal(notYetVerified.percent, 100, "all-done stages yield 100% even before verified flag");
const verified = buildIndicatorModel({ stages: completedStages, buildStatus: "verified" });
assert.equal(verified.status, "verified");
assert.equal(verified.percent, 100);
const failedVerification = buildIndicatorModel({
  stages: [{ id: "verify", label: "Verify APK", status: "error" }],
  buildStatus: "running",
});
assert.notEqual(failedVerification.status, "verified");
assert.equal(failedVerification.status, "attention");
assert.equal(failedVerification.percent, 45, "error stage counts as partial progress for the bar");
assert.equal(buildIndicatorModel({ stages: [], progressPercent: 8 }).percent, 8, "explicit backend progress is preferred");
assert.equal(buildIndicatorModel({ stages: [], progressPercent: 150 }).percent, 0, "invalid percentages fall back to 0");
assert.equal(buildIndicatorModel({ stages: [], taskStatus: "completed", progressPercent: 8 }).percent, 100, "completion forces 100%");
assert.equal(buildIndicatorModel({ stages: [], taskStatus: "completed" }).status, "completed");
assert.equal(buildIndicatorModel({ stages: [], taskStatus: "cancelled" }).status, "cancelled");
assert.equal(buildIndicatorModel({ stages: [], taskStatus: "failed" }).status, "attention");
assert.equal(buildIndicatorModel({ stages: [], step: 1, maxSteps: 4 }).percent, 8, "step counters drive playbook progress");
assert.equal(buildIndicatorModel({
  stages: [
    { id: "a", label: "A", status: "done" },
    { id: "b", label: "B", status: "active" },
    { id: "c", label: "C", status: "pending" },
  ],
}).percent, 48, "active stage contributes partial weight");

assert.equal(classifyTermuxTaskKind("Create a new Android app and APK", { createApp: true }), "create_apk");
assert.equal(classifyTermuxTaskKind("Build APK from existing source", { build: true }), "build_apk");
assert.equal(classifyTermuxTaskKind("Fix the source code error", { repair: true }), "repair_source");
assert.equal(classifyTermuxTaskKind("Decompile and analyze APK", { reverse: true }), "reverse");
assert.equal(classifyTermuxTaskKind("Explain this error without changing files"), "generic");
assert.equal(classifyTermuxTaskKind("An unknown task type"), "generic");

const observedBuildStages = createObservedAssembleStages("en");
assert.deepEqual(observedBuildStages.map((stage) => stage.id), ["setup", "compile", "apk", "align", "sign", "verify"]);
const afterCompileStarts = applyObservedBuildStageUpdate(observedBuildStages, { id: "compile", status: "active", detail: "Gradle running" });
assert.equal(afterCompileStarts[0].status, "pending", "a real compile event must not falsely complete the preceding setup stage");
assert.equal(afterCompileStarts[1].status, "active");
assert.equal(afterCompileStarts[2].status, "pending", "future build steps remain pending until emitted");
const afterFailure = applyObservedBuildStageUpdate(afterCompileStarts, { id: "compile", status: "error", detail: "Gradle failed" });
assert.equal(afterFailure[1].status, "error");
assert.equal(afterFailure[2].status, "pending");

for (const viewport of [720, 600, 360]) {
  const split = allocateIndicatorBodyHeights(viewport, {
    buildVisible: true, thinkingVisible: true, buildExpanded: true, thinkingExpanded: true,
  });
  assert.equal(split.equalShare, true);
  assert.equal(90 + split.buildBodyHeight, 48 + split.thinkingBodyHeight, "expanded upper/lower panels must have equal total height");
  assert.ok(36 + 80 + (90 + split.buildBodyHeight) + (48 + split.thinkingBodyHeight) <= viewport,
    "expanded panels must preserve readiness and message-list reserve within measured viewport");
}
const buildOnly = allocateIndicatorBodyHeights(600, {
  buildVisible: true, thinkingVisible: true, buildExpanded: true, thinkingExpanded: false,
});
assert.equal(buildOnly.equalShare, false);
assert.ok(buildOnly.buildBodyHeight > 0 && buildOnly.buildBodyHeight <= 320);
const tiny = allocateIndicatorBodyHeights(120, {
  buildVisible: true, thinkingVisible: true, buildExpanded: true, thinkingExpanded: true,
});
assert.equal(tiny.buildBodyHeight, 0);
assert.equal(tiny.thinkingBodyHeight, 0);

const chat = fs.readFileSync(path.join(root, "app/index.tsx"), "utf8");
assert.match(chat, /onLayout=\{\(event\) => setChatViewportHeight/);
assert.match(chat, /minHeight: 0, overflow: "hidden"/);
assert.match(chat, /allocateIndicatorBodyHeights\(/);
assert.match(chat, /maxBodyHeight=\{indicatorAllocation\.buildBodyHeight\}/);
assert.match(chat, /maxBodyHeight=\{indicatorAllocation\.thinkingBodyHeight\}/);
assert.match(chat, /useSafeAreaInsets\(\)/);
assert.match(chat, /useAnimatedKeyboard\(\)/);
assert.match(chat, /termuxActivity\.buildStatus !== "verified"/);
assert.match(chat, /thinkingIndicatorVisible \?/);

const layout = fs.readFileSync(path.join(root, "app/_layout.tsx"), "utf8");
assert.match(layout, /interceptorEngine\.subscribe\(/);
assert.match(layout, /isInterceptorListenerLive\(/);
assert.match(layout, /TrafficInterceptorHeaderButton/);
assert.match(layout, /getInterceptorIndicatorState\(snapshot\)/);
assert.match(layout, /state === "running" \? colors\.success/);
assert.match(layout, /state === "starting" \|\| state === "stopping" \? colors\.warning/);
assert.match(layout, /state === "error" \|\| state === "unsupported" \? colors\.danger/);
assert.match(layout, /accessibilityLabel=\{copy\.traffic\}/);
assert.match(layout, /accessibilityHint=/);
assert.match(layout, /navigation\.navigate\("interceptor"/);
assert.match(layout, /testID="header-traffic-interceptor"/);
assert.match(layout, /minWidth: 48, minHeight: 48/);

const interceptorScreen = fs.readFileSync(path.join(root, "components/interceptor/InterceptorScreen.tsx"), "utf8");
assert.match(interceptorScreen, /value=\{listenerLive\}/);
assert.match(interceptorScreen, /trackColor=\{\{ false: colors\.line, true: colors\.success \}\}/);
assert.match(interceptorScreen, /thumbColor=\{listenerLive \? colors\.onAccent : colors\.inkBright\}/);
assert.match(interceptorScreen, /ios_backgroundColor=\{colors\.line\}/);
assert.match(interceptorScreen, /hitSlop=\{8\}/);
assert.match(interceptorScreen, /accessibilityRole="switch"/);
assert.match(interceptorScreen, /accessibilityLabel=\{listenerLive \? text\.stop : text\.start\}/);
assert.match(interceptorScreen, /accessibilityState=\{\{ checked: listenerLive/);
assert.match(interceptorScreen, /snapshot\.status === "starting" \|\| snapshot\.status === "stopping"/);
assert.match(interceptorScreen, /minWidth: 58, minHeight: 48/);

for (const rel of ["components/BuildProgressPanel.tsx", "components/AgentThinkingPanel.tsx"]) {
  const component = fs.readFileSync(path.join(root, rel), "utf8");
  assert.match(component, /maxBodyHeight/);
  assert.match(component, /equalShare/);
  assert.match(component, /ScrollView/);
}
const buildPanel = fs.readFileSync(path.join(root, "components/BuildProgressPanel.tsx"), "utf8");
assert.match(buildPanel, /buildStatus: activity\?\.buildStatus/);
assert.match(buildPanel, /model\.status === "verified"/);
assert.match(buildPanel, /t\("buildStatusVerified"\)/);
assert.match(buildPanel, /taskKindTitle\(activity\.taskKind, language\)/);
assert.match(buildPanel, /model\.percent/);
assert.match(buildPanel, /opProgressBlock|trackWrap/);
assert.match(buildPanel, /redactTaskActivityText/);
assert.match(buildPanel, /setExpanded\(!expanded\)/);
assert.match(buildPanel, /maxBodyHeight/);
assert.match(buildPanel, /activity\?\.taskStatus === "failed"/);
const useLLM = fs.readFileSync(path.join(root, "hooks/useLLM.ts"), "utf8");
assert.doesNotMatch(useLLM, /inferStageIdFromCommand|advancePipelineStages|genericAgentStages/);
assert.match(useLLM, /stages: info\.stages \|\| \[\]/, "general tasks only receive backend-emitted checklist stages");
assert.match(useLLM, /finishActivityRun\(runId, lastActivity, "cancelled"/);
assert.match(useLLM, /finishActivityRun\(runId, lastActivity, "failed"/);
assert.match(useLLM, /finishActivityRun\(runId, lastActivity, "completed"/);
const activityHelpers = fs.readFileSync(path.join(root, "lib/task-activity.ts"), "utf8");
assert.match(activityHelpers, /applyObservedBuildStageUpdate/);
const agent = fs.readFileSync(path.join(root, "lib/termux-agent.ts"), "utf8");
assert.match(agent, /buildStatus: "verified"/);
assert.match(agent, /APK exists and passed on-disk verification/);

console.log("AIB_CHAT_INDICATOR_LAYOUT_SELFTEST_OK taskKinds=create,source-build,repair,reverse,generic; stages=backend-events-only; progress=explicit-only; terminal=success/failure/cancel; collapse=1 responsiveViewportAndKeyboard=1");
