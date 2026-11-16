import type { DeviceAgentBridge, DeviceCommandResult } from "./DeviceAgentBridge";
import { getTermuxNative } from "../../lib/termux-bridge";

/**
 * ADB transport executed only through AI Builder's embedded private bridge.
 * This intentionally does not bundle adb or bypass Android security controls.
 * The user must have a working Termux installation and an adb-capable device
 * connection (USB or wireless debugging) inside Termux.
 */
export class TermuxAdbDeviceBridge implements DeviceAgentBridge {
  constructor(private readonly timeoutMs = 120_000) {}

  private native() {
    const n = getTermuxNative();
    if (!n) throw new Error("TERMUX_NATIVE_MODULE_MISSING");
    return n;
  }

  private async run(command: string, timeoutMs = this.timeoutMs): Promise<DeviceCommandResult> {
    const r = await this.native().runCommand(command, null, timeoutMs);
    return { exitCode: r.exitCode, stdout: r.stdout || "", stderr: r.stderr || "" };
  }

  async isAvailable(): Promise<boolean> {
    try {
      const r = await this.run("command -v adb >/dev/null 2>&1 && adb start-server >/dev/null 2>&1 && adb devices", 15_000);
      if (r.exitCode !== 0) return false;
      return /^\S+\s+(device|unauthorized|offline)$/m.test(r.stdout);
    } catch {
      return false;
    }
  }

  shell(command: string): Promise<DeviceCommandResult> {
    // adb shell receives one shell string; quote it as a single host argument.
    return this.run(`adb shell sh -lc ${shQuote(command)}`);
  }

  async screenshot(targetPath: string): Promise<string> {
    // Important: screencap bytes never pass through JS/JSON. adb writes the
    // PNG directly into the Termux-visible filesystem, avoiding corruption.
    const r = await this.run(`mkdir -p ${shQuote(dirname(targetPath))} && adb exec-out screencap -p > ${shQuote(targetPath)} && test -s ${shQuote(targetPath)}`, 30_000);
    if (r.exitCode !== 0) throw new Error(r.stderr || "ADB_SCREENSHOT_FAILED");
    return targetPath;
  }

  async screenshotBase64(): Promise<string> {
    // Binary-safe bridge for the Agent/Vision loop. base64 is textual and
    // therefore serialized safely over the embedded command JSON transport.
    const r = await this.run(`adb exec-out screencap -p | base64 | tr -d '\\n'`, 30_000);
    if (r.exitCode !== 0 || !r.stdout.trim()) throw new Error(r.stderr || "ADB_SCREENSHOT_FAILED");
    return r.stdout.trim();
  }

  install(apkPath: string): Promise<DeviceCommandResult> {
    return this.run(`adb install -r ${shQuote(apkPath)}`, 600_000);
  }

  launch(packageName: string): Promise<DeviceCommandResult> {
    if (!/^[A-Za-z0-9_.]+$/.test(packageName)) return Promise.reject(new Error("INVALID_PACKAGE_NAME"));
    return this.run(`adb shell monkey -p ${shQuote(packageName)} -c android.intent.category.LAUNCHER 1`, 30_000);
  }

  logcat(args: string[] = ["-d", "-t", "300"]): Promise<DeviceCommandResult> {
    if (args.some((a) => !/^[A-Za-z0-9_./:=+@,-]+$/.test(a))) return Promise.reject(new Error("INVALID_LOGCAT_ARGUMENT"));
    return this.run(`adb logcat ${args.map(shQuote).join(" ")}`, 30_000);
  }

  tap(x: number, y: number): Promise<DeviceCommandResult> {
    assertCoordinate(x, "x"); assertCoordinate(y, "y");
    return this.run(`adb shell input tap ${Math.round(x)} ${Math.round(y)}`, 15_000);
  }

  async uiHierarchy(): Promise<DeviceCommandResult> {
    return this.run("tmp=$(mktemp) && adb shell uiautomator dump /sdcard/window_ai_builder.xml >/dev/null 2>&1 && adb shell cat /sdcard/window_ai_builder.xml; code=$?; adb shell rm -f /sdcard/window_ai_builder.xml >/dev/null 2>&1; rm -f \"$tmp\"; exit $code", 30_000);
  }

  async detectPackageName(apkPath: string): Promise<DeviceCommandResult> {
    const path = shQuote(apkPath);
    return this.run(`if command -v aapt >/dev/null 2>&1; then aapt dump badging ${path}; elif command -v aapt2 >/dev/null 2>&1; then aapt2 dump badging ${path}; elif command -v apkanalyzer >/dev/null 2>&1; then apkanalyzer manifest application-id ${path}; else exit 127; fi`, 30_000);
  }

  async screenSize(): Promise<DeviceCommandResult> {
    return this.run("adb shell wm size", 15_000);
  }

  inputText(text: string): Promise<DeviceCommandResult> {
    const value = String(text);
    if (!value || value.length > 500) return Promise.reject(new Error("INVALID_INPUT_TEXT"));
    return this.run(`adb shell input text ${shQuote(value)}`, 15_000);
  }

  swipe(x1: number, y1: number, x2: number, y2: number, durationMs = 300): Promise<DeviceCommandResult> {
    for (const [v, n] of [[x1, "x1"], [y1, "y1"], [x2, "x2"], [y2, "y2"], [durationMs, "durationMs"]] as const) assertCoordinate(v, n);
    return this.run(`adb shell input swipe ${Math.round(x1)} ${Math.round(y1)} ${Math.round(x2)} ${Math.round(y2)} ${Math.round(durationMs)}`, 15_000);
  }
}

function assertCoordinate(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 100_000) throw new Error(`INVALID_${name.toUpperCase()}`);
}

function dirname(value: string): string {
  const normalized = String(value).replace(/\\/g, "/");
  const i = normalized.lastIndexOf("/");
  return i <= 0 ? "." : normalized.slice(0, i);
}

function shQuote(value: string): string {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}
