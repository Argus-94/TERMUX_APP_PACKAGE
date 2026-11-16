import type { AccessibilityNativeAdapter, AccessibilityNode, DeviceStatus, PublicSecondaryDisplayDiscovery, VirtualDisplayAdapter } from "./types.ts";
import type { LoopbackRequestEvent, LoopbackTransport } from "./DeviceBridge.ts";

export interface NativeAccessibilityModule {
  status(): Promise<DeviceStatus>;
  openSettings(): Promise<void>;
  getTree(): Promise<readonly AccessibilityNode[]>;
  clickText(text: string): Promise<boolean>;
  tap(x: number, y: number): Promise<boolean>;
  swipe(x1: number, y1: number, x2: number, y2: number, durationMs: number): Promise<boolean>;
  inputText(text: string): Promise<boolean>;
  systemKey(key: string): Promise<boolean>;
  startLoopback(): Promise<{ url: string; token: string }>;
  stopLoopback(): Promise<void>;
  respondLoopbackRequest(requestId: string, responseJson: string): Promise<boolean>;
  virtualDisplayStatus?(): Promise<DeviceStatus>;
  listPublicSecondaryDisplays?(): Promise<PublicSecondaryDisplayDiscovery>;
  getPublicSecondaryDisplayTree?(displayId: number): Promise<readonly AccessibilityNode[]>;
  captureCurrentDisplay?(): Promise<{ status: DeviceStatus; frameId?: string; displayId?: number; width?: number; height?: number; data?: string }>;
  captureSecondaryDisplay?(displayId: number): Promise<{ status: DeviceStatus; frameId?: string; displayId?: number; width?: number; height?: number; data?: string }>;
  tapCapturedSecondaryFrame?(frameId: string, x: number, y: number): Promise<boolean>;
  addListener(eventName: string): void;
  removeListeners(count: number): void;
}

export interface NativeMemoryPressureModule {
  getAvailableMemoryBytes(): Promise<number>;
  getDevicePowerState(): Promise<{ batteryPercent: number | null; pluggedIn: boolean | null; lowPowerMode: boolean | null }>;
  addListener(eventName: string): void;
  removeListeners(count: number): void;
}

export function createNativeAccessibilityAdapter(module: NativeAccessibilityModule): AccessibilityNativeAdapter {
  return Object.freeze({
    status: () => module.status(),
    openSettings: () => module.openSettings(),
    getTree: () => module.getTree(),
    clickText: (text: string) => module.clickText(text),
    tap: (x: number, y: number) => module.tap(x, y),
    swipe: (x1: number, y1: number, x2: number, y2: number, duration: number) => module.swipe(x1, y1, x2, y2, duration),
    inputText: (text: string) => module.inputText(text),
    systemKey: (key: "BACK" | "HOME" | "RECENTS" | "NOTIFICATIONS" | "QUICK_SETTINGS") => module.systemKey(key),
  });
}

/** Uses native DisplayManager discovery and API-30 AccessibilityService screenshot/gesture calls; never targets an unlisted/private display. */
export function createNativeVirtualDisplayAdapter(module: NativeAccessibilityModule): VirtualDisplayAdapter {
  return Object.freeze({
    status: () => module.virtualDisplayStatus
      ? module.virtualDisplayStatus()
      : Promise.resolve({ state: "unsupported" as const, reason: "Native screenshot methods are absent from this build." }),
    listDisplays: () => module.listPublicSecondaryDisplays
      ? module.listPublicSecondaryDisplays()
      : Promise.resolve({ status: { state: "unsupported" as const, reason: "Native display discovery is absent from this build." }, displays: [] }),
    readDisplayTree: (displayId: number) => module.getPublicSecondaryDisplayTree
      ? module.getPublicSecondaryDisplayTree(displayId)
      : Promise.reject(new Error("VIRTUAL_DISPLAY_TREE_UNSUPPORTED")),
    capture: (displayId?: number) => displayId === undefined
      ? module.captureCurrentDisplay
        ? module.captureCurrentDisplay()
        : Promise.resolve({ status: { state: "unsupported" as const, reason: "Native screenshot methods are absent from this build." } })
      : module.captureSecondaryDisplay
        ? module.captureSecondaryDisplay(displayId)
        : Promise.resolve({ status: { state: "unsupported" as const, reason: "Native secondary-display screenshot is absent from this build." } }),
    input: async (frameId: string, x: number, y: number) => module.tapCapturedSecondaryFrame
      ? { ok: await module.tapCapturedSecondaryFrame(frameId, x, y) }
      : { ok: false },
  });
}

export function createNativeLoopbackTransport(module: NativeAccessibilityModule): LoopbackTransport {
  return {
    start: () => module.startLoopback(),
    stop: () => module.stopLoopback(),
    subscribe(listener) {
      const reactNative = require("react-native") as {
        NativeEventEmitter?: new (nativeModule: unknown) => {
          addListener(eventName: string, callback: (event: unknown) => void): { remove(): void };
        };
      };
      if (!reactNative.NativeEventEmitter) throw new Error("DEVICE_BRIDGE_EVENT_EMITTER_UNAVAILABLE");
      const emitter = new reactNative.NativeEventEmitter(module);
      const subscription = emitter.addListener("AibDeviceBridgeRequest", (event) => {
        if (isLoopbackRequestEvent(event)) listener(event);
      });
      return () => subscription.remove();
    },
    respond: (requestId, responseJson) => module.respondLoopbackRequest(requestId, responseJson),
  };
}

/** Resolve only the known native module; non-Android/unbuilt clients degrade explicitly. */
export function loadNativeAccessibilityModule(): NativeAccessibilityModule | null {
  try {
    const reactNative = require("react-native") as { Platform?: { OS?: string }; NativeModules?: { AibAccessibility?: NativeAccessibilityModule } };
    if (reactNative.Platform?.OS !== "android") return null;
    return reactNative.NativeModules?.AibAccessibility ?? null;
  } catch {
    return null;
  }
}

/** Resolve only the Android memory-pressure telemetry package; no non-Android fallback is fabricated. */
export function loadNativeMemoryPressureModule(): NativeMemoryPressureModule | null {
  try {
    const reactNative = require("react-native") as { Platform?: { OS?: string }; NativeModules?: { AibMemoryPressure?: NativeMemoryPressureModule } };
    if (reactNative.Platform?.OS !== "android") return null;
    return reactNative.NativeModules?.AibMemoryPressure ?? null;
  } catch {
    return null;
  }
}

function isLoopbackRequestEvent(value: unknown): value is LoopbackRequestEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Record<string, unknown>;
  return typeof event.requestId === "string" && event.requestId.length <= 64 &&
    typeof event.method === "string" && event.method.length <= 8 &&
    typeof event.path === "string" && event.path.length <= 128 &&
    typeof event.body === "string" && event.body.length <= 16_384;
}

declare const require: (name: string) => unknown;
