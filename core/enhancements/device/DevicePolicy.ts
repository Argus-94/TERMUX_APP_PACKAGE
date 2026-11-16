import { DevicePolicyError, type DeviceCapability, type DeviceOperation, type DevicePolicyOptions, type DevicePolicyEvent } from "./types.ts";

const REQUIRED: Readonly<Record<DeviceOperation, DeviceCapability>> = Object.freeze({
  "accessibility.status": "device.accessibility", "accessibility.settings": "device.accessibility", "accessibility.tree": "device.accessibility", "accessibility.clickText": "device.accessibility", "accessibility.tap": "device.accessibility", "accessibility.swipe": "device.accessibility", "accessibility.inputText": "device.accessibility", "accessibility.systemKey": "device.accessibility",
  "adb.pair": "device.adb", "adb.connect": "device.adb", "adb.list": "device.adb", "adb.reconnect": "device.adb",
  "virtualdisplay.status": "device.virtualdisplay", "virtualdisplay.displays": "device.virtualdisplay", "virtualdisplay.tree": "device.virtualdisplay", "virtualdisplay.capture": "device.virtualdisplay", "virtualdisplay.input": "device.virtualdisplay",
  "bridge.listen": "device.bridge.listen",
  "bridge.files.read": "device.metadata.read", "bridge.sensors.read": "device.sensors.read",
  "adb.device.isAvailable": "device.adb", "adb.device.screenshot": "device.adb", "adb.device.screenshotBase64": "device.adb", "adb.device.install": "device.adb", "adb.device.launch": "device.adb", "adb.device.logcat": "device.adb", "adb.device.tap": "device.adb", "adb.device.swipe": "device.adb", "adb.device.inputText": "device.adb", "adb.device.uiHierarchy": "device.adb", "adb.device.detectPackageName": "device.adb", "adb.device.screenSize": "device.adb",
});
const SAFE = new Set<string>(Object.keys(REQUIRED));

/** Single capability boundary. Grants only change through explicit user-facing grant/revoke calls. */
export class DevicePolicy {
  private readonly grants = new Set<DeviceCapability>();
  private active = 0;
  private readonly maxConcurrent: number;
  private readonly now: () => number;
  private readonly options: DevicePolicyOptions;
  constructor(options: DevicePolicyOptions = {}) {
    this.options = options;
    this.maxConcurrent = Math.max(1, Math.min(8, Math.floor(options.maxConcurrent ?? 2)));
    this.now = options.now ?? Date.now;
  }
  grantByUser(capability: DeviceCapability): void {
    if (!isCapability(capability)) throw new DevicePolicyError("POLICY_BLOCKED", String(capability));
    this.grants.add(capability);
  }
  revokeByUser(capability: DeviceCapability): void { this.grants.delete(capability); }
  isGranted(capability: DeviceCapability): boolean { return this.grants.has(capability); }
  listGrants(): readonly DeviceCapability[] { return Object.freeze([...this.grants]); }
  /** Executes exactly one allowlisted operation after re-checking explicit grant. */
  async run<T>(operation: string, action: () => Promise<T> | T): Promise<T> {
    const started = this.now();
    const valid = SAFE.has(operation);
    const required = valid ? REQUIRED[operation as DeviceOperation] : undefined;
    const emit = async (outcome: DevicePolicyEvent["outcome"], requiredAudit = false) => {
      if (!this.options.timeline) {
        if (requiredAudit) throw new DevicePolicyError("AUDIT_UNAVAILABLE", operation, `[POLICY_BLOCKED] ${operation}: durable audit is unavailable`);
        return;
      }
      try {
        await this.options.timeline({ operation: (valid ? operation : "unknown") as DeviceOperation | "unknown", ...(required ? { capability: required } : {}), outcome, durationMs: Math.max(0, this.now() - started) });
      } catch {
        if (requiredAudit) throw new DevicePolicyError("AUDIT_UNAVAILABLE", operation, `[POLICY_BLOCKED] ${operation}: durable audit is unavailable`);
      }
    };
    if (!valid || !required) { await emit("blocked"); throw new DevicePolicyError("POLICY_BLOCKED", operation); }
    if (!this.grants.has(required)) { await emit("blocked"); throw new DevicePolicyError("CAPABILITY_REQUIRED", operation, `[POLICY_BLOCKED] ${operation}: explicit user grant required (${required})`); }
    if (this.active >= this.maxConcurrent) { await emit("blocked"); throw new DevicePolicyError("DEVICE_BUSY", operation, `[POLICY_BLOCKED] ${operation}: concurrency limit reached`); }
    this.active++;
    let outcome: DevicePolicyEvent["outcome"] = "failed";
    try {
      // Re-check after acquiring the slot in case a revoke raced with this call.
      if (!this.grants.has(required)) throw new DevicePolicyError("CAPABILITY_REQUIRED", operation, `[POLICY_BLOCKED] ${operation}: explicit user grant required (${required})`);
      await emit("started", true);
      const result = await action();
      outcome = "authorized";
      return result;
    } catch (error) {
      if (error instanceof DevicePolicyError) throw error;
      throw error;
    } finally {
      this.active--;
      await emit(outcome);
    }
  }
}
function isCapability(value: string): value is DeviceCapability { return value === "device.accessibility" || value === "device.adb" || value === "device.virtualdisplay" || value === "device.bridge.listen" || value === "device.metadata.read" || value === "device.sensors.read"; }
export function requiredDeviceCapability(operation: string): DeviceCapability | undefined { return SAFE.has(operation) ? REQUIRED[operation as DeviceOperation] : undefined; }
