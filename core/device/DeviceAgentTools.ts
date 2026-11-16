import type { DeviceAgentBridge } from "./DeviceAgentBridge";

export type DeviceToolName =
  | "device.status"
  | "device.shell"
  | "device.screenshot"
  | "device.screenshot.base64"
  | "device.app_loop"
  | "device.install"
  | "device.launch"
  | "device.logcat"
  | "device.tap"
  | "device.swipe"
  | "device.input_text"
  | "device.test_suite"
  | "device.test_report"
  | "device.ui_hierarchy"
  | "device.detect_package"
  | "device.screen_size"
  | "device.test_plan"
  | "device.test_assertions"
  | "device.automation_loop";

export class DeviceAgentTools {
  constructor(private readonly bridge: DeviceAgentBridge) {}

  async execute(name: DeviceToolName, args: Record<string, unknown> = {}, signal?: AbortSignal) {
    const ensureActive = () => { if (signal?.aborted) throw new Error("ABORTED"); };
    ensureActive();
    if (name !== "device.status" && !(await awaitWithSignal(Promise.resolve(this.bridge.isAvailable()), signal))) {
      return { ok: false, error: "DEVICE_BRIDGE_UNAVAILABLE" };
    }
    // The availability probe is asynchronous. Re-check after it so Stop during
    // that probe cannot dispatch a tap/swipe/shell command afterwards.
    ensureActive();
    switch (name) {
      case "device.status":
        return { ok: true, available: await awaitWithSignal(Promise.resolve(this.bridge.isAvailable()), signal) };
      case "device.shell":
        return result(await this.bridge.shell(requiredString(args, "command")));
      case "device.screenshot":
        return { ok: true, output: await this.bridge.screenshot(requiredString(args, "path")) };
      case "device.screenshot.base64":
        return { ok: true, base64: await this.bridge.screenshotBase64() };
      case "device.app_loop":
        return await this.appLoop(args, signal);
      case "device.install":
        return result(await this.bridge.install(requiredString(args, "apkPath")));
      case "device.launch":
        return result(await this.bridge.launch(requiredString(args, "packageName")));
      case "device.logcat":
        return result(await this.bridge.logcat(Array.isArray(args.args) ? args.args.map(String) : undefined));
      case "device.tap":
        ensureActive();
        return result(await this.bridge.tap(requiredNumber(args, "x"), requiredNumber(args, "y")));
      case "device.swipe":
        ensureActive();
        return result(await this.bridge.swipe(requiredNumber(args, "x1"), requiredNumber(args, "y1"), requiredNumber(args, "x2"), requiredNumber(args, "y2"), args.durationMs == null ? undefined : requiredNumber(args, "durationMs")));
      case "device.input_text":
        return result(await this.bridge.inputText(requiredString(args, "text")));
      case "device.test_suite":
        return { ok: false, error: "DEVICE_TEST_SUITE_REQUIRES_RUNTIME_HOST" };
      case "device.test_report":
        return { ok: false, error: "DEVICE_TEST_REPORT_REQUIRES_RUNTIME_HOST" };
      case "device.ui_hierarchy":
        return result(await this.bridge.uiHierarchy());
      case "device.detect_package":
        return result(await this.bridge.detectPackageName(requiredString(args, "apkPath")));
      case "device.screen_size":
        return result(await this.bridge.screenSize());
      case "device.test_plan": {
        const { generateDeviceTestPlan } = await import("./DeviceTestPlan");
        return { ok: true, plan: generateDeviceTestPlan(requiredString(args, "goal"), typeof args.packageName === "string" ? args.packageName : undefined) };
      }
      case "device.test_assertions": {
        const { parseUiHierarchy } = await import("./AccessibilityTree");
        const { evaluateDeviceTestPlan } = await import("./DeviceTestAssertions");
        const plan = args.plan as any;
        const xml = requiredString(args, "xml");
        return { ok: true, result: evaluateDeviceTestPlan(plan, parseUiHierarchy(xml)) };
      }
      case "device.automation_loop":
        return { ok: false, error: "DEVICE_AUTOMATION_REQUIRES_VISION_HOST" };
    }
  }

  private async appLoop(args: Record<string, unknown>, signal?: AbortSignal) {
    const { runDeviceAppLoop } = await import("./DeviceAppLoop");
    try {
      const result = await runDeviceAppLoop(this.bridge, {
        apkPath: requiredString(args, "apkPath"),
        packageName: requiredString(args, "packageName"),
        screenshot: args.screenshot !== false,
        screenshotPath: typeof args.screenshotPath === "string" ? args.screenshotPath : undefined,
        settleMs: args.settleMs == null ? 800 : requiredNumber(args, "settleMs"),
        signal,
      });
      return { ok: true, ...result };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
}

function requiredString(args: Record<string, unknown>, key: string): string {
  if (typeof args[key] !== "string" || !args[key]) throw new Error(`INVALID_${key.toUpperCase()}`);
  return args[key] as string;
}
function requiredNumber(args: Record<string, unknown>, key: string): number {
  const n = Number(args[key]);
  if (!Number.isFinite(n)) throw new Error(`INVALID_${key.toUpperCase()}`);
  return n;
}
function result(r: { exitCode: number; stdout: string; stderr: string }) {
  return { ok: r.exitCode === 0, output: r.stdout, error: r.stderr, exitCode: r.exitCode };
}

function awaitWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new Error("ABORTED"));
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => { cleanup(); reject(new Error("ABORTED")); };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then((value) => {
      cleanup();
      if (signal.aborted) reject(new Error("ABORTED"));
      else resolve(value);
    }, (error) => { cleanup(); reject(error); });
  });
}
