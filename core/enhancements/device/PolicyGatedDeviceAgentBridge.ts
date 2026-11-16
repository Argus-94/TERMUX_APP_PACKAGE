import type { DeviceAgentBridge, DeviceCommandResult } from "../../device/DeviceAgentBridge.ts";
import { DevicePolicy } from "./DevicePolicy.ts";

/** All legacy UI/agent/automation calls share the same explicit device.adb gate. Arbitrary shell is denied. */
export class PolicyGatedDeviceAgentBridge implements DeviceAgentBridge {
  constructor(private readonly policy: DevicePolicy, private readonly inner: DeviceAgentBridge) {}

  isAvailable(): Promise<boolean> {
    return this.run("isAvailable", async () => !!(await this.inner.isAvailable()));
  }

  shell(_command: string): Promise<DeviceCommandResult> {
    return Promise.resolve({ exitCode: 126, stdout: "", stderr: "[POLICY_BLOCKED] generic device shell is not allowlisted" });
  }

  private run<T>(operation: string, action: () => Promise<T>): Promise<T> {
    return this.policy.run(`adb.device.${operation}`, action);
  }

  screenshot(path: string): Promise<string> { return this.run("screenshot", () => this.inner.screenshot(path)); }
  screenshotBase64(): Promise<string> { return this.run("screenshotBase64", () => this.inner.screenshotBase64()); }
  install(path: string): Promise<DeviceCommandResult> { return this.run("install", () => this.inner.install(path)); }
  launch(packageName: string): Promise<DeviceCommandResult> { return this.run("launch", () => this.inner.launch(packageName)); }
  logcat(args?: string[]): Promise<DeviceCommandResult> { return this.run("logcat", () => this.inner.logcat(args)); }
  tap(x: number, y: number): Promise<DeviceCommandResult> { return this.run("tap", () => this.inner.tap(x, y)); }
  swipe(x1: number, y1: number, x2: number, y2: number, durationMs?: number): Promise<DeviceCommandResult> { return this.run("swipe", () => this.inner.swipe(x1, y1, x2, y2, durationMs)); }
  inputText(text: string): Promise<DeviceCommandResult> { return this.run("inputText", () => this.inner.inputText(text)); }
  uiHierarchy(): Promise<DeviceCommandResult> { return this.run("uiHierarchy", () => this.inner.uiHierarchy()); }
  detectPackageName(apkPath: string): Promise<DeviceCommandResult> { return this.run("detectPackageName", () => this.inner.detectPackageName(apkPath)); }
  screenSize(): Promise<DeviceCommandResult> { return this.run("screenSize", () => this.inner.screenSize()); }
}
