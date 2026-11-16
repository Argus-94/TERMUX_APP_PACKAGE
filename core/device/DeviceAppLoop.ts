import type { DeviceAgentBridge, DeviceCommandResult } from "./DeviceAgentBridge";

export type DeviceAppLoopOptions = {
  apkPath: string;
  packageName?: string;
  screenshot?: boolean;
  screenshotPath?: string;
  settleMs?: number;
  signal?: AbortSignal;
};

export type DeviceAppLoopResult = {
  installed: DeviceCommandResult;
  launched: DeviceCommandResult;
  screenshotBase64?: string;
  screenshotPath?: string;
  logcat?: DeviceCommandResult;
  packageName: string;
};

/** Deterministic build→install→launch→capture primitive for the Agent. */
export async function runDeviceAppLoop(bridge: DeviceAgentBridge, options: DeviceAppLoopOptions): Promise<DeviceAppLoopResult> {
  const ensureActive = () => { if (options.signal?.aborted) throw new Error("ABORTED"); };
  ensureActive();
  const available = await awaitWithSignal(Promise.resolve(bridge.isAvailable()), options.signal);
  ensureActive();
  if (!available) throw new Error("DEVICE_BRIDGE_UNAVAILABLE");
  const packageName = options.packageName?.trim() || await awaitWithSignal(detectPackageName(bridge, options.apkPath), options.signal);
  ensureActive();
  if (!packageName) throw new Error("APK_PACKAGE_NAME_NOT_DETECTED");
  // RUN_COMMAND cannot terminate an already-dispatched Termux process. Wait for
  // install/launch to settle, then honor Stop before starting another side effect.
  const installed = await bridge.install(options.apkPath);
  ensureActive();
  if (installed.exitCode !== 0) throw new Error(installed.stderr || "DEVICE_INSTALL_FAILED");
  const launched = await bridge.launch(packageName);
  ensureActive();
  if (launched.exitCode !== 0) throw new Error(launched.stderr || "DEVICE_LAUNCH_FAILED");
  if (options.settleMs && options.settleMs > 0) await delayWithSignal(Math.min(options.settleMs, 10_000), options.signal);
  const result: DeviceAppLoopResult = { installed, launched, packageName };
  if (options.screenshot) {
    result.screenshotBase64 = await awaitWithSignal(bridge.screenshotBase64(), options.signal);
    ensureActive();
    if (options.screenshotPath) result.screenshotPath = await bridge.screenshot(options.screenshotPath);
    ensureActive();
  }
  result.logcat = await awaitWithSignal(bridge.logcat(["-d", "-t", "200"]), options.signal);
  ensureActive();
  return result;
}

function delayWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  if (signal.aborted) return Promise.reject(new Error("ABORTED"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); cleanup(); reject(new Error("ABORTED")); };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}


async function detectPackageName(bridge: DeviceAgentBridge, apkPath: string): Promise<string> {
  const result = await bridge.detectPackageName(apkPath);
  if (result.exitCode !== 0) throw new Error(result.stderr || "APK_PACKAGE_NAME_DETECTION_FAILED");
  const text = result.stdout.trim();
  const match = text.match(/package:\s+name='([^']+)'/) || text.match(/^([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+)$/m);
  const value = match?.[1] || "";
  if (!/^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+$/.test(value)) throw new Error("APK_PACKAGE_NAME_INVALID");
  return value;
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
