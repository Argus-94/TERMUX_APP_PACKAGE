import { DevicePolicy } from "./DevicePolicy.ts";
import type { AccessibilityEngine } from "./AccessibilityEngine.ts";
import type { WirelessAdbManager } from "./WirelessAdbManager.ts";
import type { VirtualDisplay } from "./VirtualDisplay.ts";
import type { DeviceCapability } from "./types.ts";

export type DeviceBridgeRequest =
  | { type: "screen.status" }
  | { type: "screen.tree" }
  | { type: "input.clickText"; text: string }
  | { type: "input.tap"; x: number; y: number }
  | { type: "input.swipe"; x1: number; y1: number; x2: number; y2: number; durationMs?: number }
  | { type: "input.text"; text: string }
  | { type: "input.key"; key: "BACK" | "HOME" | "RECENTS" | "NOTIFICATIONS" | "QUICK_SETTINGS" }
  | { type: "adb.list" }
  | { type: "adb.connect"; hostPort: string }
  | { type: "adb.pair"; hostPort: string; pairingCode: string }
  | { type: "adb.reconnect" }
  | { type: "virtualdisplay.status" }
  | { type: "virtualdisplay.displays" }
  | { type: "virtualdisplay.tree"; displayId: number }
  | { type: "virtualdisplay.capture"; displayId?: number }
  | { type: "virtualdisplay.input"; frameId: string; x: number; y: number }
  | { type: "files.read"; item: "device-model" | "android-version" }
  | { type: "sensors.read"; sensor: "battery" };

export type DeviceBridgeResponse = Readonly<{ ok: boolean; value?: unknown; status?: "unsupported" | "permission_required"; error?: string }>;
export type LoopbackRequestEvent = Readonly<{ requestId: string; method: string; path: string; body: string }>;
export interface LoopbackTransport {
  start(): Promise<{ url: string; token: string }>;
  stop(): Promise<void>;
  subscribe?(listener: (event: LoopbackRequestEvent) => void): () => void;
  respond?(requestId: string, responseJson: string): Promise<unknown>;
}
export interface DeviceBridgeReadOnlyAdapter {
  readMetadata(item: "device-model" | "android-version"): Promise<string | null>;
  readBattery(): Promise<{ batteryPercent: number | null; pluggedIn: boolean | null; lowPowerMode: boolean | null }>;
}

/** In-process typed facade plus an authenticated loopback transport. Every device action is dispatched through DevicePolicy. */
export class DeviceBridge {
  private token: string | null = null;
  private loopbackSession: { url: string; token: string } | null = null;
  private removeRequestListener: (() => void) | null = null;

  constructor(
    private readonly policy: DevicePolicy,
    private readonly accessibility: AccessibilityEngine,
    private readonly adb: WirelessAdbManager,
    private readonly virtualDisplay: VirtualDisplay,
    private readonly makeToken: () => string = secureToken,
    private readonly loopback?: LoopbackTransport,
    private readonly readOnly?: DeviceBridgeReadOnlyAdapter,
  ) {}

  /** Create an in-process token only after the user has granted at least one device capability. */
  issueToken(): string {
    if (!this.policy.listGrants().length) throw new Error("DEVICE_BRIDGE_CAPABILITY_REQUIRED");
    const token = this.makeToken();
    if (typeof token !== "string" || token.length < 32 || token.length > 256) throw new Error("DEVICE_BRIDGE_TOKEN_SOURCE_UNAVAILABLE");
    this.token = token;
    return token;
  }

  /** Start actual native loopback HTTP only with explicit Accessibility and listener grants. */
  async startLoopback(): Promise<{ url: string; token: string }> {
    if (!this.loopback) throw new Error("DEVICE_BRIDGE_LOOPBACK_UNAVAILABLE");
    if (!this.policy.isGranted("device.accessibility")) throw new Error("[POLICY_BLOCKED] device.bridge.listen requires device.accessibility grant");
    return this.policy.run("bridge.listen", async () => {
      const state = await this.accessibility.status();
      if (state.state !== "available") throw new Error(state.state === "permission_required" ? "ACCESSIBILITY_PERMISSION_REQUIRED" : "ACCESSIBILITY_SERVICE_UNAVAILABLE");
      const session = await this.loopback!.start();
      if (!session.url.startsWith("http://127.0.0.1:") || !session.token || session.token.length < 64) {
        await this.loopback!.stop();
        throw new Error("DEVICE_BRIDGE_INVALID_NATIVE_SESSION");
      }
      try {
        this.removeRequestListener = this.loopback!.subscribe?.((event) => { void this.handleLoopbackRequest(event, session.token); }) ?? null;
        this.loopbackSession = session;
        this.token = session.token;
        return Object.freeze({ ...session });
      } catch (error) {
        await this.loopback!.stop();
        throw error;
      }
    });
  }

  /** Revoke one explicit grant; revoke of Accessibility/listener also closes the native socket and clears tokens. */
  async revokeByUser(capability: DeviceCapability): Promise<void> {
    this.policy.revokeByUser(capability);
    if (capability === "device.bridge.listen" || capability === "device.accessibility") await this.stopLoopback();
    if (capability === "device.accessibility") this.revokeToken();
    if (capability === "device.virtualdisplay") this.virtualDisplay.invalidateFrame();
  }

  async stopLoopback(): Promise<void> {
    const wasActive = this.loopbackSession !== null;
    this.loopbackSession = null;
    this.removeRequestListener?.();
    this.removeRequestListener = null;
    this.token = null;
    if (this.loopback && wasActive) await this.loopback.stop();
  }

  revokeToken(): void {
    this.token = null;
    this.virtualDisplay.invalidateFrame();
  }

  /** Execute one typed request. The target manager must authorize each concrete operation. */
  async request(token: string, request: DeviceBridgeRequest): Promise<DeviceBridgeResponse> {
    if (!this.token || !constantTimeEqual(token, this.token)) return { ok: false, error: "DEVICE_BRIDGE_TOKEN_REJECTED" };
    try {
      switch (request.type) {
        case "screen.status": return { ok: true, value: await this.accessibility.status() };
        case "screen.tree": return { ok: true, value: await this.accessibility.getTree() };
        case "input.clickText": return { ok: true, value: await this.accessibility.clickText(request.text) };
        case "input.tap": return { ok: true, value: await this.accessibility.tap(request.x, request.y) };
        case "input.swipe": return { ok: true, value: await this.accessibility.swipe(request.x1, request.y1, request.x2, request.y2, request.durationMs) };
        case "input.text": return { ok: true, value: await this.accessibility.inputText(request.text) };
        case "input.key": return isSystemKey(request.key) ? { ok: true, value: await this.accessibility.systemKey(request.key) } : { ok: false, status: "unsupported", error: "System key is not allowlisted." };
        case "adb.list": return { ok: true, value: await this.adb.list() };
        case "adb.connect": return { ok: true, value: await this.adb.connect(request.hostPort) };
        case "adb.pair": return { ok: true, value: await this.adb.pair(request.hostPort, request.pairingCode) };
        case "adb.reconnect": return { ok: true, value: await this.adb.reconnect() };
        case "virtualdisplay.status": return { ok: true, value: await this.virtualDisplay.status() };
        case "virtualdisplay.displays": return { ok: true, value: await this.virtualDisplay.listDisplays() };
        case "virtualdisplay.tree": return { ok: true, value: await this.virtualDisplay.readDisplayTree(request.displayId) };
        case "virtualdisplay.capture": return { ok: true, value: await this.virtualDisplay.capture(request.displayId) };
        case "virtualdisplay.input": return { ok: true, value: await this.virtualDisplay.input(request.frameId, request.x, request.y) };
        case "files.read":
          if (!this.readOnly) return await this.policy.run("bridge.files.read", async () => ({ ok: false, status: "unsupported", error: "No safe metadata adapter is configured." }));
          if (request.item !== "device-model" && request.item !== "android-version") return { ok: false, status: "unsupported", error: "Only allowlisted device metadata items are supported." };
          return await this.policy.run("bridge.files.read", async () => {
            const value = await this.readOnly!.readMetadata(request.item);
            return typeof value === "string" && value.length <= 200 ? { ok: true, value } : { ok: false, status: "unsupported", error: "Metadata value unavailable." };
          });
        case "sensors.read":
          if (!this.readOnly) return await this.policy.run("bridge.sensors.read", async () => ({ ok: false, status: "unsupported", error: "No safe battery adapter is configured." }));
          if (request.sensor !== "battery") return { ok: false, status: "unsupported", error: "Only the battery sensor is supported." };
          return await this.policy.run("bridge.sensors.read", async () => {
            const reading = await this.readOnly!.readBattery();
            const batteryPercent = typeof reading.batteryPercent === "number" && Number.isFinite(reading.batteryPercent) && reading.batteryPercent >= 0 && reading.batteryPercent <= 100 ? reading.batteryPercent : null;
            const pluggedIn = typeof reading.pluggedIn === "boolean" ? reading.pluggedIn : null;
            const lowPowerMode = typeof reading.lowPowerMode === "boolean" ? reading.lowPowerMode : null;
            return { ok: true, value: { batteryPercent, pluggedIn, lowPowerMode } };
          });
        default: return await this.rejectUnknownOperation();
      }
    } catch (error) {
      return { ok: false, ...(error instanceof Error ? { error: safeError(error) } : { error: "DEVICE_BRIDGE_OPERATION_FAILED" }) };
    }
  }

  /** Trusted in-process host path for AgentManager; token transport is not relevant here, but DevicePolicy still gates and audits every operation. */
  async requestFromTrustedHost(request: DeviceBridgeRequest): Promise<DeviceBridgeResponse> {
    const hadSessionToken = this.token !== null;
    let token = this.token;
    try {
      if (!token) {
        token = this.makeToken();
        if (typeof token !== "string" || token.length < 32 || token.length > 256) throw new Error("DEVICE_BRIDGE_TOKEN_SOURCE_UNAVAILABLE");
        this.token = token;
      }
      return await this.request(token, request);
    } finally {
      if (!hadSessionToken && !this.loopbackSession) this.token = null;
    }
  }

  /** Invalidate the virtual-display frame and stop request delivery if the app revokes its listener grant. */
  getLoopbackStatus(): "listening" | "stopped" { return this.loopbackSession ? "listening" : "stopped"; }

  private async handleLoopbackRequest(event: LoopbackRequestEvent, sessionToken: string): Promise<void> {
    const transport = this.loopback;
    if (!transport?.respond || !isValidEvent(event)) return;
    const request = mapHttpRequest(event);
    const response = request
      ? await this.request(sessionToken, request)
      : await this.rejectUnknownOperation();
    try { await transport.respond(event.requestId, JSON.stringify(response)); } catch { /* native request times out closed if JS delivery fails */ }
  }

  private async rejectUnknownOperation(): Promise<DeviceBridgeResponse> {
    try { await this.policy.run("unknown", async () => undefined); }
    catch (error) { return { ok: false, error: error instanceof Error ? safeError(error) : "[POLICY_BLOCKED] Unknown device operation." }; }
    return { ok: false, error: "[POLICY_BLOCKED] Unknown device operation." };
  }
}

function mapHttpRequest(event: LoopbackRequestEvent): DeviceBridgeRequest | null {
  const route = `${event.method} ${event.path}`;
  if (route === "GET /v1/status") return { type: "screen.status" };
  if (route === "GET /v1/screen/tree") return { type: "screen.tree" };
  if (route === "GET /v1/adb/list") return { type: "adb.list" };
  if (route === "GET /v1/adb/reconnect") return { type: "adb.reconnect" };
  if (route === "GET /v1/virtualdisplay/status") return { type: "virtualdisplay.status" };
  if (route === "GET /v1/virtualdisplay/capture") return { type: "virtualdisplay.capture" };
  if (route === "GET /v1/virtualdisplay/displays") return { type: "virtualdisplay.displays" };
  const body = parseObject(event.body);
  if (!body) return null;
  if (route === "POST /v1/virtualdisplay/tree" && Number.isSafeInteger(body.displayId) && Number(body.displayId) > 0) return { type: "virtualdisplay.tree", displayId: Number(body.displayId) };
  if (route === "POST /v1/virtualdisplay/capture" && Number.isSafeInteger(body.displayId) && Number(body.displayId) > 0) return { type: "virtualdisplay.capture", displayId: Number(body.displayId) };
  if (route === "POST /v1/virtualdisplay/input" && typeof body.frameId === "string" && body.frameId.length <= 128 && isFiniteNumber(body.x) && isFiniteNumber(body.y)) return { type: "virtualdisplay.input", frameId: body.frameId, x: body.x, y: body.y };
  if (route === "POST /v1/input/tap" && isFiniteNumber(body.x) && isFiniteNumber(body.y)) return { type: "input.tap", x: body.x, y: body.y };
  if (route === "POST /v1/input/swipe" && isFiniteNumber(body.x1) && isFiniteNumber(body.y1) && isFiniteNumber(body.x2) && isFiniteNumber(body.y2)) return { type: "input.swipe", x1: body.x1, y1: body.y1, x2: body.x2, y2: body.y2, durationMs: body.durationMs === undefined ? undefined : isFiniteNumber(body.durationMs) ? body.durationMs : NaN };
  if (route === "POST /v1/input/text" && typeof body.text === "string") return { type: "input.text", text: body.text };
  if (route === "POST /v1/input/click-text" && typeof body.text === "string") return { type: "input.clickText", text: body.text };
  if (route === "POST /v1/input/key" && isSystemKey(body.key)) return { type: "input.key", key: body.key };
  if (route === "POST /v1/adb/connect" && typeof body.hostPort === "string") return { type: "adb.connect", hostPort: body.hostPort };
  if (route === "POST /v1/adb/pair" && typeof body.hostPort === "string" && typeof body.pairingCode === "string") return { type: "adb.pair", hostPort: body.hostPort, pairingCode: body.pairingCode };
  if (route === "POST /v1/files/read" && (body.item === "device-model" || body.item === "android-version")) return { type: "files.read", item: body.item };
  if (route === "POST /v1/sensors/read" && body.sensor === "battery") return { type: "sensors.read", sensor: "battery" };
  return null;
}

function parseObject(raw: string): Record<string, unknown> | null {
  try { const value: unknown = JSON.parse(raw); return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
  catch { return null; }
}
function isValidEvent(event: LoopbackRequestEvent): boolean { return !!event && typeof event.requestId === "string" && /^[A-Za-z0-9-]{1,64}$/.test(event.requestId) && typeof event.method === "string" && typeof event.path === "string" && typeof event.body === "string" && event.body.length <= 16_384; }
function isFiniteNumber(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value); }
function isSystemKey(value: unknown): value is "BACK" | "HOME" | "RECENTS" | "NOTIFICATIONS" | "QUICK_SETTINGS" { return value === "BACK" || value === "HOME" || value === "RECENTS" || value === "NOTIFICATIONS" || value === "QUICK_SETTINGS"; }
function safeError(error: Error): string { const message = error.message.slice(0, 200); return /\[POLICY_BLOCKED\]|CAPABILITY_REQUIRED|DEVICE_BUSY|ACCESSIBILITY_|ADB_|VIRTUAL_DISPLAY_|DEVICE_BRIDGE_/.test(message) ? message : "DEVICE_BRIDGE_OPERATION_FAILED"; }
function secureToken(): string {
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi?.getRandomValues) throw new Error("DEVICE_BRIDGE_TOKEN_SOURCE_UNAVAILABLE");
  const bytes = new Uint8Array(32);
  cryptoApi.getRandomValues(bytes);
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}
function constantTimeEqual(a: string, b: string): boolean {
  if (typeof a !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
export function grantDeviceCapability(policy: DevicePolicy, capability: DeviceCapability): void { policy.grantByUser(capability); }
