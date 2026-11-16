import { DevicePolicy } from "./DevicePolicy.ts";
import type { AccessibilityNode, DeviceStatus, PublicSecondaryDisplay, PublicSecondaryDisplayDiscovery, VirtualDisplayAdapter } from "./types.ts";

/** Uses only live, native-enumerated public secondary displays; private displays and primary-screen fallback are rejected. */
export class VirtualDisplay {
  private lastFrame: Readonly<{ frameId: string; displayId: number | null; width: number; height: number }> | null = null;
  private readonly policy: DevicePolicy;
  private readonly native: VirtualDisplayAdapter;
  constructor(policy: DevicePolicy, native: VirtualDisplayAdapter) { this.policy = policy; this.native = native; }
  status(): Promise<DeviceStatus> { return this.policy.run("virtualdisplay.status", () => this.native.status()); }
  async listDisplays(): Promise<PublicSecondaryDisplayDiscovery> {
    return this.policy.run("virtualdisplay.displays", () => this.discoverDisplaysUnrestricted());
  }
  async readDisplayTree(displayId: number): Promise<readonly AccessibilityNode[]> {
    return this.policy.run("virtualdisplay.tree", async () => {
      if (!Number.isSafeInteger(displayId) || displayId <= 0) throw new Error("VIRTUAL_DISPLAY_INVALID_TARGET");
      const discovery = await this.discoverDisplaysUnrestricted();
      if (discovery.status.state !== "available" || !discovery.displays.some((display) => display.displayId === displayId)) throw new Error("TARGET_PUBLIC_SECONDARY_DISPLAY_NOT_CURRENTLY_AVAILABLE");
      if (!this.native.readDisplayTree) throw new Error("VIRTUAL_DISPLAY_TREE_UNSUPPORTED");
      const nodes = await this.native.readDisplayTree(displayId);
      if (!Array.isArray(nodes)) throw new Error("VIRTUAL_DISPLAY_INVALID_TREE");
      return Object.freeze(nodes.slice(0, 500).filter(isSafeNode).map((node) => Object.freeze({
        ...(typeof node.text === "string" ? { text: node.text.slice(0, 1000) } : {}),
        bounds: Object.freeze({ ...node.bounds }), clickable: node.clickable,
        ...(typeof node.className === "string" ? { className: node.className.slice(0, 160) } : {}),
      })));
    });
  }
  async capture(displayId?: number): Promise<{ status: DeviceStatus; frameId?: string; displayId?: number; width?: number; height?: number; data?: string }> {
    return this.policy.run("virtualdisplay.capture", async () => {
      if (displayId !== undefined) {
        if (!Number.isSafeInteger(displayId) || displayId <= 0) throw new Error("VIRTUAL_DISPLAY_INVALID_TARGET");
        const discovery = await this.discoverDisplaysUnrestricted();
        if (discovery.status.state !== "available" || !discovery.displays.some((display) => display.displayId === displayId)) {
          this.lastFrame = null;
          return { status: { state: "unavailable", reason: "TARGET_PUBLIC_SECONDARY_DISPLAY_NOT_CURRENTLY_AVAILABLE; primary-screen fallback is disabled." } };
        }
      }
      const result = await this.native.capture(displayId);
      const validFrameId = typeof result.frameId === "string" && result.frameId.length > 0 && result.frameId.length <= 128;
      const validDimensions = Number.isInteger(result.width) && Number.isInteger(result.height) && result.width! > 0 && result.height! > 0 && result.width! <= 1280 && result.height! <= 1280;
      const validData = typeof result.data === "string" && result.data.length > 0 && result.data.length <= 2_000_000 && /^[A-Za-z0-9+/]+={0,2}$/.test(result.data);
      const targetMatches = displayId === undefined ? result.displayId === undefined || result.displayId === 0 : result.displayId === displayId;
      if (result.status.state !== "available" || !validFrameId || !validDimensions || !validData || !targetMatches) {
        this.lastFrame = null;
        return { status: result.status.state === "available" ? { state: "unavailable", reason: "NATIVE_FRAME_TARGET_OR_CONTENT_INVALID; no fallback was used." } : result.status };
      }
      const capturedDisplayId = displayId === undefined ? null : displayId;
      this.lastFrame = { frameId: result.frameId!, displayId: capturedDisplayId, width: result.width!, height: result.height! };
      return { status: result.status, frameId: result.frameId, ...(result.displayId === undefined ? {} : { displayId: result.displayId }), width: result.width, height: result.height, data: result.data };
    });
  }
  async input(frameId: string, x: number, y: number): Promise<{ ok: boolean }> {
    if (typeof frameId !== "string" || !frameId || frameId.length > 128) throw new Error("VIRTUAL_DISPLAY_INVALID_FRAME_ID");
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > 100_000 || y > 100_000) throw new Error("VIRTUAL_DISPLAY_INVALID_COORDINATE");
    return this.policy.run("virtualdisplay.input", async () => {
      const frame = this.lastFrame;
      if (!frame || frameId !== frame.frameId) throw new Error("VIRTUAL_DISPLAY_STALE_FRAME_ID");
      if (frame.displayId === null) throw new Error("VIRTUAL_DISPLAY_PRIMARY_INPUT_UNSUPPORTED");
      if (x >= frame.width || y >= frame.height) throw new Error("VIRTUAL_DISPLAY_OUT_OF_FRAME_BOUNDS");
      const result = await this.native.input(frameId, x, y);
      if (!result.ok) throw new Error("VIRTUAL_DISPLAY_INPUT_UNSUPPORTED");
      return result;
    });
  }
  invalidateFrame(): void { this.lastFrame = null; }
  private async discoverDisplaysUnrestricted(): Promise<PublicSecondaryDisplayDiscovery> {
    if (!this.native.listDisplays) return { status: { state: "unsupported", reason: "Native public-secondary display discovery is unavailable; no display is guessed." }, displays: [] };
    const result = await this.native.listDisplays();
    if (result.status.state !== "available" || !Array.isArray(result.displays)) return { status: result.status, displays: [] };
    const displays = result.displays.filter(isValidSecondaryDisplay).slice(0, 16).map((display) => Object.freeze({
      displayId: display.displayId, name: display.name.slice(0, 80), width: display.width, height: display.height,
    }));
    return { status: result.status, displays: Object.freeze(displays) };
  }
}
function isValidSecondaryDisplay(display: PublicSecondaryDisplay): boolean {
  return !!display && Number.isSafeInteger(display.displayId) && display.displayId > 0 && typeof display.name === "string" &&
    display.name.length > 0 && Number.isInteger(display.width) && Number.isInteger(display.height) &&
    display.width > 0 && display.height > 0 && display.width <= 16_384 && display.height <= 16_384;
}
function isSafeNode(node: AccessibilityNode): boolean {
  const bounds = node?.bounds;
  return !!node && typeof node.clickable === "boolean" && !!bounds &&
    [bounds.left, bounds.top, bounds.right, bounds.bottom].every(Number.isFinite) &&
    bounds.left >= 0 && bounds.top >= 0 && bounds.right > bounds.left && bounds.bottom > bounds.top &&
    bounds.right <= 100_000 && bounds.bottom <= 100_000 &&
    (node.text === undefined || (typeof node.text === "string" && node.text.length <= 1000)) &&
    (node.className === undefined || (typeof node.className === "string" && node.className.length <= 160));
}
export const unsupportedVirtualDisplayAdapter: VirtualDisplayAdapter = Object.freeze({
  async status(): Promise<DeviceStatus> { return { state: "unsupported", reason: "The Android Accessibility native module is unavailable. No frame or input is simulated." }; },
  async listDisplays(): Promise<PublicSecondaryDisplayDiscovery> { return { status: { state: "unsupported", reason: "Native display discovery is unavailable." }, displays: [] }; },
  async capture() { return { status: { state: "unsupported" as const, reason: "Native screenshot capture is unavailable; no frame was captured." } }; },
  async input() { return { ok: false }; },
});
