export type DeviceCapability = "device.accessibility" | "device.adb" | "device.virtualdisplay" | "device.bridge.listen" | "device.metadata.read" | "device.sensors.read";
export type DeviceOperation =
  | "accessibility.status" | "accessibility.settings" | "accessibility.tree" | "accessibility.clickText" | "accessibility.tap" | "accessibility.swipe" | "accessibility.inputText" | "accessibility.systemKey"
  | "adb.pair" | "adb.connect" | "adb.list" | "adb.reconnect"
  | "virtualdisplay.status" | "virtualdisplay.displays" | "virtualdisplay.tree" | "virtualdisplay.capture" | "virtualdisplay.input"
  | "bridge.listen"
  | "bridge.files.read" | "bridge.sensors.read"
  | "adb.device.isAvailable" | "adb.device.screenshot" | "adb.device.screenshotBase64" | "adb.device.install" | "adb.device.launch" | "adb.device.logcat" | "adb.device.tap" | "adb.device.swipe" | "adb.device.inputText" | "adb.device.uiHierarchy" | "adb.device.detectPackageName" | "adb.device.screenSize";
export type DeviceBounds = Readonly<{ left: number; top: number; right: number; bottom: number }>;
export type AccessibilityNode = Readonly<{ text?: string; bounds: DeviceBounds; clickable: boolean; className?: string }>;
export type DeviceStatus = Readonly<{ state: "available" | "permission_required" | "unsupported" | "unavailable"; reason?: string }>;
/** A live, currently enumerated, non-private logical display other than Android's primary display. */
export type PublicSecondaryDisplay = Readonly<{ displayId: number; name: string; width: number; height: number }>;
export type PublicSecondaryDisplayDiscovery = Readonly<{ status: DeviceStatus; displays: readonly PublicSecondaryDisplay[] }>;
export type DevicePolicyEvent = Readonly<{ operation: DeviceOperation | "unknown"; capability?: DeviceCapability; outcome: "started" | "authorized" | "blocked" | "failed"; durationMs: number }>;
export type DeviceTimelineSink = (event: DevicePolicyEvent) => void | Promise<void>;
export interface AccessibilityNativeAdapter {
  status(): Promise<DeviceStatus>;
  openSettings(): Promise<void>;
  getTree(): Promise<readonly AccessibilityNode[]>;
  clickText(text: string): Promise<boolean>;
  tap(x: number, y: number): Promise<boolean>;
  swipe(x1: number, y1: number, x2: number, y2: number, durationMs: number): Promise<boolean>;
  inputText(text: string): Promise<boolean>;
  systemKey(key: "BACK" | "HOME" | "RECENTS" | "NOTIFICATIONS" | "QUICK_SETTINGS"): Promise<boolean>;
}
export interface AdbPairingAdapter {
  pair(hostPort: string, code: string): Promise<{ ok: boolean; message: string }>;
  connect(hostPort: string): Promise<{ ok: boolean; message: string }>;
  list(): Promise<{ ok: boolean; devices: readonly { serial: string; state: string }[] }>;
  loadLastHost?(): Promise<string>;
}
export interface VirtualDisplayAdapter {
  status(): Promise<DeviceStatus>;
  listDisplays?(): Promise<PublicSecondaryDisplayDiscovery>;
  readDisplayTree?(displayId: number): Promise<readonly AccessibilityNode[]>;
  capture(displayId?: number): Promise<{ status: DeviceStatus; frameId?: string; displayId?: number; width?: number; height?: number; data?: string }>;
  input(frameId: string, x: number, y: number): Promise<{ ok: boolean }>;
}
export type DevicePolicyOptions = Readonly<{ timeline?: DeviceTimelineSink; maxConcurrent?: number; now?: () => number }>;
export class DevicePolicyError extends Error {
  readonly code: "POLICY_BLOCKED" | "CAPABILITY_REQUIRED" | "DEVICE_BUSY" | "INVALID_DEVICE_INPUT" | "AUDIT_UNAVAILABLE";
  readonly operation: string;
  constructor(code: DevicePolicyError["code"], operation: string, message = `[POLICY_BLOCKED] ${operation}`) {
    super(message); this.name = "DevicePolicyError"; this.code = code; this.operation = operation;
  }
}
export type DeviceOperationResult<T> = Readonly<{ ok: true; value: T }>;
