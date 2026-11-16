/**
 * Phase 33: Real Android/Termux device integration smoke harness.
 *
 * This is intentionally fail-closed: a missing/unauthorized device is never
 * represented as a successful test. It exercises the same DeviceAgentBridge
 * used by the agentic build loop and records concrete transport evidence.
 */
import type { DeviceAgentBridge } from "./DeviceAgentBridge";

export type RealDeviceIntegrationRequest = {
  readonly apkPath?: string;
  readonly packageName?: string;
  readonly launch?: boolean;
  readonly screenshotPath?: string;
};

export type RealDeviceIntegrationResult = {
  readonly ok: boolean;
  readonly available: boolean;
  readonly installed: boolean;
  readonly launched: boolean;
  readonly processRunning: boolean;
  readonly uiHierarchy: boolean;
  readonly screenshot: boolean;
  readonly logcat: boolean;
  readonly screenSize?: string;
  readonly packageEvidence?: string;
  readonly errors: readonly string[];
};

export async function runRealDeviceIntegration(
  bridge: DeviceAgentBridge,
  request: RealDeviceIntegrationRequest = {},
): Promise<RealDeviceIntegrationResult> {
  const errors: string[] = [];
  let available = false;
  let installed = !request.apkPath;
  let launched = !request.launch;
  let processRunning = false;
  let uiHierarchy = false;
  let screenshot = false;
  let logcat = false;
  let screenSize: string | undefined;
  let packageEvidence: string | undefined;

  try {
    available = Boolean(await bridge.isAvailable());
  } catch (e) {
    errors.push(`DEVICE_AVAILABILITY_ERROR:${message(e)}`);
  }
  if (!available) {
    errors.push("DEVICE_NOT_AVAILABLE");
    return { ok: false, available, installed, launched, processRunning, uiHierarchy, screenshot, logcat, errors };
  }

  try {
    const r = await bridge.screenSize?.();
    if (r && r.exitCode === 0) screenSize = r.stdout.trim();
    else errors.push("SCREEN_SIZE_FAILED");
  } catch (e) { errors.push(`SCREEN_SIZE_ERROR:${message(e)}`); }

  if (request.apkPath) {
    try {
      const detected = await bridge.detectPackageName?.(request.apkPath);
      if (detected && detected.exitCode === 0) packageEvidence = detected.stdout.slice(0, 2048);
      else errors.push("APK_PACKAGE_DETECTION_FAILED");
    } catch (e) { errors.push(`APK_PACKAGE_DETECTION_ERROR:${message(e)}`); }
    try {
      const r = await bridge.install(request.apkPath);
      installed = r.exitCode === 0;
      if (!installed) errors.push(`APK_INSTALL_FAILED:${trim(r.stderr || r.stdout)}`);
    } catch (e) { errors.push(`APK_INSTALL_ERROR:${message(e)}`); }
  }

  if (request.launch && request.packageName && installed) {
    try {
      const r = await bridge.launch(request.packageName);
      launched = r.exitCode === 0;
      if (!launched) errors.push(`APP_LAUNCH_FAILED:${trim(r.stderr || r.stdout)}`);
    } catch (e) { errors.push(`APP_LAUNCH_ERROR:${message(e)}`); }
    if (launched) {
      try {
        const r = await bridge.shell(`pidof ${shellQuote(request.packageName)}`);
        processRunning = r.exitCode === 0 && Boolean(r.stdout.trim());
        if (!processRunning) errors.push("APP_PROCESS_NOT_RUNNING");
      } catch (e) { errors.push(`APP_PROCESS_CHECK_ERROR:${message(e)}`); }
    }
  }

  try {
    const r = await bridge.uiHierarchy?.();
    uiHierarchy = Boolean(r && r.exitCode === 0 && /<hierarchy\b/i.test(r.stdout));
    if (!uiHierarchy) errors.push("UI_HIERARCHY_FAILED");
  } catch (e) { errors.push(`UI_HIERARCHY_ERROR:${message(e)}`); }

  try {
    const target = request.screenshotPath || "./aib-phase33-device.png";
    await bridge.screenshot(target);
    screenshot = true;
  } catch (e) { errors.push(`SCREENSHOT_ERROR:${message(e)}`); }

  try {
    const r = await bridge.logcat(["-d", "-t", "80"]);
    logcat = r.exitCode === 0;
    if (!logcat) errors.push("LOGCAT_FAILED");
  } catch (e) { errors.push(`LOGCAT_ERROR:${message(e)}`); }

  const required = request.launch ? available && installed && launched && processRunning : available && installed;
  const ok = required && uiHierarchy && screenshot && logcat && errors.length === 0;
  return { ok, available, installed, launched, processRunning, uiHierarchy, screenshot, logcat, screenSize, packageEvidence, errors };
}

function message(e: unknown): string { return e instanceof Error ? e.message : String(e); }
function trim(value: string): string { return value.replace(/\s+/g, " ").trim().slice(0, 300); }
function shellQuote(value: string): string { return `'${String(value).replace(/'/g, `\\'`)}'`; }
