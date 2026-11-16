import type { DeviceAgentBridge } from "./DeviceAgentBridge";
import { DeviceAgentTools } from "./DeviceAgentTools";
import { runDeviceAppLoop } from "./DeviceAppLoop";
import { parseUiHierarchy } from "./AccessibilityTree";
import { generateDeviceTestPlan, type DeviceTestPlan } from "./DeviceTestPlan";
import { evaluateDeviceTestPlan, type DeviceTestResult } from "./DeviceTestAssertions";

export type VisionAnalyzer = (imageDataUrl: string, prompt: string) => Promise<string>;
export type DeviceAutomationAction =
  | { type: "tap"; x: number; y: number }
  | { type: "swipe"; x1: number; y1: number; x2: number; y2: number; durationMs?: number }
  | { type: "shell"; command: string }
  | { type: "stop" };

export type DeviceAutomationOptions = {
  apkPath: string;
  packageName?: string;
  goal: string;
  maxSteps?: number;
  settleMs?: number;
  screenshotPath?: string;
  vision: VisionAnalyzer;
  testPlan?: DeviceTestPlan;
  assertUi?: boolean;
  signal?: AbortSignal;
};

export type DeviceAutomationStep = {
  step: number;
  observation: string;
  action?: DeviceAutomationAction;
  toolResult?: unknown;
  screenshotBase64?: string;
  logcat?: string;
  uiHierarchy?: string;
  assertionResult?: DeviceTestResult;
};

export type DeviceAutomationResult = {
  ok: boolean;
  completed: boolean;
  reason: string;
  steps: DeviceAutomationStep[];
};

/**
 * Guarded UI automation loop. Vision proposes actions; the deterministic
 * DeviceAgentTools layer validates and executes them. The model never gets
 * direct shell access outside the explicit shell action capability.
 */
export class DeviceAutomationAgent {
  private readonly tools: DeviceAgentTools;

  constructor(private readonly bridge: DeviceAgentBridge) {
    this.tools = new DeviceAgentTools(bridge);
  }

  async run(options: DeviceAutomationOptions): Promise<DeviceAutomationResult> {
    const ensureActive = () => { if (options.signal?.aborted) throw new Error("ABORTED"); };
    const maxSteps = Math.max(1, Math.min(20, Math.floor(options.maxSteps ?? 8)));
    const steps: DeviceAutomationStep[] = [];
    ensureActive();
    const boot = await runDeviceAppLoop(this.bridge, {
      apkPath: options.apkPath,
      packageName: options.packageName,
      screenshot: true,
      screenshotPath: options.screenshotPath,
      settleMs: options.settleMs ?? 800,
      signal: options.signal,
    });
    ensureActive();
    let image = boot.screenshotBase64;
    let currentUi = await this.readUiHierarchy(options.signal);
    ensureActive();
    const packageName = boot.packageName;
    const plan = options.testPlan ?? generateDeviceTestPlan(options.goal, packageName, currentUi);
    if (!image) return { ok: false, completed: false, reason: "SCREENSHOT_UNAVAILABLE", steps };

    for (let i = 1; i <= maxSteps; i++) {
      const observation = await awaitWithSignal(options.vision(
        `data:image/png;base64,${image}`,
        [
          "You are a deterministic Android UI test observer.",
          `Goal: ${options.goal}`,
          `Package: ${packageName}`,
          "Inspect the screenshot and the accessibility/UI tree below. Prefer semantic UI elements over blind coordinates.",
          `Accessibility tree:\n${summarizeUi(currentUi).slice(0, 12000)}`,
          `Test plan:\n${JSON.stringify(plan)}`,
          "Return ONLY JSON:",
          '{"completed":boolean,"reason":string,"action":null|{"type":"tap","x":number,"y":number}|{"type":"swipe","x1":number,"y1":number,"x2":number,"y2":number,"durationMs":number}',
          "Coordinates must be within the screenshot. Do not invent shell commands.",
        ].join("\n"),
      ), options.signal);
      ensureActive();
      const parsed = parseDecision(observation);
      const record: DeviceAutomationStep = { step: i, observation };
      steps.push(record);
      if (parsed.completed) {
        if (options.assertUi !== false) {
          record.assertionResult = evaluateDeviceTestPlan(plan, currentUi);
          if (!record.assertionResult.passed) {
            const failures = record.assertionResult.stepResults
              .flatMap((stepResult) => stepResult.assertions.filter((item) => !item.passed).map((item) => item.message));
            return { ok: false, completed: false, reason: `ASSERTION_FAILED:${failures.join("|")}`.slice(0, 500), steps };
          }
        }
        return { ok: true, completed: true, reason: parsed.reason || "GOAL_COMPLETED", steps };
      }
      if (!parsed.action) return { ok: false, completed: false, reason: parsed.reason || "NO_ACTION_PROPOSED", steps };

      record.action = parsed.action;
      if (parsed.action.type === "stop") return { ok: false, completed: false, reason: parsed.reason || "STOPPED", steps };
      ensureActive();
      // The Termux RUN_COMMAND API cannot cancel a command already dispatched to
      // ADB. Await the current action, then prevent any subsequent device action.
      const result = await executeAction(this.tools, parsed.action, options.signal);
      ensureActive();
      record.toolResult = result;
      if (!result || result.ok === false) return { ok: false, completed: false, reason: "DEVICE_ACTION_FAILED", steps };
      await delayWithSignal(350, options.signal);
      image = await awaitWithSignal(this.bridge.screenshotBase64(), options.signal);
      ensureActive();
      record.screenshotBase64 = image;
      const log = await awaitWithSignal(this.bridge.logcat(["-d", "-t", "80"]), options.signal);
      ensureActive();
      record.logcat = log.stdout || log.stderr;
      currentUi = await this.readUiHierarchy(options.signal);
      ensureActive();
      record.uiHierarchy = currentUi.rawXml;
      if (options.assertUi !== false) {
        record.assertionResult = evaluateDeviceTestPlan(plan, currentUi);
        if (record.assertionResult.passed) return { ok: true, completed: true, reason: "ASSERTIONS_PASSED", steps };
      }
    }
    return { ok: false, completed: false, reason: "MAX_STEPS_REACHED", steps };
  }

  private async readUiHierarchy(signal?: AbortSignal) {
    try {
      const result = await awaitWithSignal(this.bridge.uiHierarchy(), signal);
      return parseUiHierarchy(result.stdout || "");
    } catch {
      if (signal?.aborted) throw new Error("ABORTED");
      return parseUiHierarchy("");
    }
  }
}

function summarizeUi(snapshot: ReturnType<typeof parseUiHierarchy>): string {
  if (!snapshot.ok || !snapshot.root) return "UI hierarchy unavailable";
  const out: string[] = [];
  const walk = (n: any) => {
    for (const c of n.children || []) {
      const attrs = [c.className, c.text && `text=${JSON.stringify(c.text)}`, c.resourceId && `id=${c.resourceId}`, c.contentDescription && `desc=${JSON.stringify(c.contentDescription)}`, c.bounds && `bounds=${JSON.stringify(c.bounds)}`].filter(Boolean);
      if (attrs.length) out.push(`- ${attrs.join(" ")}`);
      walk(c);
    }
  };
  walk(snapshot.root);
  return out.join("\n");
}

async function executeAction(tools: DeviceAgentTools, action: DeviceAutomationAction, signal?: AbortSignal): Promise<any> {
  if (action.type === "tap") return tools.execute("device.tap", action, signal);
  if (action.type === "swipe") return tools.execute("device.swipe", action, signal);
  if (action.type === "shell") return tools.execute("device.shell", { command: action.command }, signal);
  return { ok: true };
}

function awaitWithSignal<T>(value: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return value;
  if (signal.aborted) return Promise.reject(new Error("ABORTED"));
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => { cleanup(); reject(new Error("ABORTED")); };
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(value).then(
      (result) => {
        cleanup();
        if (signal.aborted) reject(new Error("ABORTED"));
        else resolve(result);
      },
      (error) => { cleanup(); reject(error); },
    );
  });
}

function delayWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  return awaitWithSignal(new Promise<void>((resolve) => setTimeout(resolve, ms)), signal);
}

function parseDecision(raw: string): { completed: boolean; reason: string; action?: DeviceAutomationAction } {
  const text = String(raw || "").trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  let value: any;
  try { value = JSON.parse(text); } catch { const m = text.match(/\{[\s\S]*\}/); if (m) { try { value = JSON.parse(m[0]); } catch {} } }
  if (!value || typeof value !== "object") return { completed: false, reason: "INVALID_VISION_JSON" };
  if (value.completed === true) return { completed: true, reason: String(value.reason || "GOAL_COMPLETED") };
  const a = value.action;
  if (!a || typeof a !== "object") return { completed: false, reason: String(value.reason || "NO_ACTION") };
  if (a.type === "tap" && finite(a.x) && finite(a.y)) return { completed: false, reason: String(value.reason || ""), action: { type: "tap", x: clamp(a.x, 0, 10000), y: clamp(a.y, 0, 10000) } };
  if (a.type === "swipe" && [a.x1,a.y1,a.x2,a.y2].every(finite)) return { completed: false, reason: String(value.reason || ""), action: { type: "swipe", x1: clamp(a.x1,0,10000), y1: clamp(a.y1,0,10000), x2: clamp(a.x2,0,10000), y2: clamp(a.y2,0,10000), durationMs: finite(a.durationMs) ? clamp(a.durationMs, 50, 5000) : 300 } };
  return { completed: false, reason: "INVALID_ACTION" };
}
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));
