/** Device capability boundary. Native/ADB/Shizuku implementations plug in here. */
export type DeviceCommandResult = Readonly<{ exitCode: number; stdout: string; stderr: string }>;
export interface DeviceAgentBridge {
  isAvailable(): Promise<boolean> | boolean;
  shell(command: string): Promise<DeviceCommandResult>;
  screenshot(targetPath: string): Promise<string>;
  screenshotBase64(): Promise<string>;
  install(apkPath: string): Promise<DeviceCommandResult>;
  launch(packageName: string): Promise<DeviceCommandResult>;
  logcat(args?: string[]): Promise<DeviceCommandResult>;
  tap(x: number, y: number): Promise<DeviceCommandResult>;
  swipe(x1: number, y1: number, x2: number, y2: number, durationMs?: number): Promise<DeviceCommandResult>;
  inputText(text: string): Promise<DeviceCommandResult>;
  uiHierarchy(): Promise<DeviceCommandResult>;
  detectPackageName(apkPath: string): Promise<DeviceCommandResult>;
  screenSize(): Promise<DeviceCommandResult>;
}

export class UnavailableDeviceAgentBridge implements DeviceAgentBridge {
  private unavailable(): never { throw new Error("DEVICE_BRIDGE_UNAVAILABLE"); }
  private fail(op: string): DeviceCommandResult {
    return { exitCode: 1, stdout: "", stderr: `DEVICE_BRIDGE_UNAVAILABLE:${op}` };
  }
  isAvailable() { return false; }
  // Command-result methods resolve with exitCode=1 (callers check exitCode); path/string methods still reject
  shell(_command: string): Promise<DeviceCommandResult> { return Promise.resolve(this.fail("shell")); }
  screenshot(_targetPath: string): Promise<string> { return Promise.reject(this.unavailable()); }
  screenshotBase64(): Promise<string> { return Promise.reject(this.unavailable()); }
  install(_apkPath: string): Promise<DeviceCommandResult> { return Promise.resolve(this.fail("install")); }
  launch(_packageName: string): Promise<DeviceCommandResult> { return Promise.resolve(this.fail("launch")); }
  logcat(_args?: string[]): Promise<DeviceCommandResult> { return Promise.resolve(this.fail("logcat")); }
  tap(_x: number, _y: number): Promise<DeviceCommandResult> { return Promise.resolve(this.fail("tap")); }
  swipe(_x1: number, _y1: number, _x2: number, _y2: number, _durationMs?: number): Promise<DeviceCommandResult> { return Promise.resolve(this.fail("swipe")); }
  inputText(_text: string): Promise<DeviceCommandResult> { return Promise.resolve(this.fail("inputText")); }
  uiHierarchy(): Promise<DeviceCommandResult> { return Promise.resolve(this.fail("uiHierarchy")); }
  detectPackageName(_apkPath: string): Promise<DeviceCommandResult> { return Promise.resolve(this.fail("detectPackageName")); }
  screenSize(): Promise<DeviceCommandResult> { return Promise.resolve(this.fail("screenSize")); }
}
