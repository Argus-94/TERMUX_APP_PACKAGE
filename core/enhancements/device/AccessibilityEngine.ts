import { DevicePolicy } from "./DevicePolicy.ts";
import type { AccessibilityNativeAdapter, AccessibilityNode, DeviceBounds, DeviceStatus } from "./types.ts";

const MAX_TEXT = 1000;
const MAX_NODES = 500;
const KEYS = new Set(["BACK", "HOME", "RECENTS", "NOTIFICATIONS", "QUICK_SETTINGS"] as const);
function validBounds(b: DeviceBounds): boolean { return [b.left,b.top,b.right,b.bottom].every(Number.isFinite) && b.left >= 0 && b.top >= 0 && b.right > b.left && b.bottom > b.top && b.right <= 100_000 && b.bottom <= 100_000; }
function cleanNodes(nodes: readonly AccessibilityNode[]): readonly AccessibilityNode[] {
  if (!Array.isArray(nodes)) throw new Error("ACCESSIBILITY_INVALID_TREE");
  return Object.freeze(nodes.slice(0, MAX_NODES).filter((n) => !!n && validBounds(n.bounds) && typeof n.clickable === "boolean").map((n) => Object.freeze({ ...(typeof n.text === "string" ? { text: n.text.slice(0, MAX_TEXT) } : {}), bounds: Object.freeze({ ...n.bounds }), clickable: n.clickable, ...(typeof n.className === "string" ? { className: n.className.slice(0, 160) } : {}) })));
}
/** Native-backed Android UI automation; no screen text or typed text is logged or persisted. */
export class AccessibilityEngine {
  private readonly policy: DevicePolicy; private readonly native: AccessibilityNativeAdapter;
  constructor(policy: DevicePolicy, native: AccessibilityNativeAdapter) { this.policy = policy; this.native = native; }
  status(): Promise<DeviceStatus> { return this.policy.run("accessibility.status", () => this.native.status()); }
  openSettings(): Promise<void> { return this.policy.run("accessibility.settings", () => this.native.openSettings()); }
  async getTree(): Promise<readonly AccessibilityNode[]> { return this.policy.run("accessibility.tree", async () => { await this.requireEnabled(); return cleanNodes(await this.native.getTree()); }); }
  async clickText(text: string): Promise<boolean> {
    const value = boundedText(text, "clickText");
    return this.policy.run("accessibility.clickText", async () => { await this.requireEnabled(); return this.native.clickText(value); });
  }
  async tap(x: number, y: number): Promise<boolean> {
    validatePoint(x, y);
    return this.policy.run("accessibility.tap", async () => { await this.requireEnabled(); const tree = cleanNodes(await this.native.getTree()); const bounds = treeBounds(tree); if (bounds && (x > bounds.right || y > bounds.bottom)) throw new Error("ACCESSIBILITY_OUT_OF_BOUNDS"); return this.native.tap(x, y); });
  }
  async swipe(x1: number, y1: number, x2: number, y2: number, durationMs = 350): Promise<boolean> {
    validatePoint(x1,y1); validatePoint(x2,y2);
    if (!Number.isInteger(durationMs) || durationMs < 50 || durationMs > 5000) throw new Error("ACCESSIBILITY_INVALID_DURATION");
    return this.policy.run("accessibility.swipe", async () => { await this.requireEnabled(); const b = treeBounds(cleanNodes(await this.native.getTree())); if (b && [x1,x2].some(x => x > b.right) || b && [y1,y2].some(y => y > b.bottom)) throw new Error("ACCESSIBILITY_OUT_OF_BOUNDS"); return this.native.swipe(x1,y1,x2,y2,durationMs); });
  }
  async inputText(text: string): Promise<boolean> {
    const value = boundedText(text, "inputText");
    if (!value.length) throw new Error("ACCESSIBILITY_EMPTY_TEXT");
    return this.policy.run("accessibility.inputText", async () => { await this.requireEnabled(); return this.native.inputText(value); });
  }
  async systemKey(key: string): Promise<boolean> {
    if (!KEYS.has(key as never)) throw new Error("ACCESSIBILITY_UNSUPPORTED_KEY");
    return this.policy.run("accessibility.systemKey", async () => { await this.requireEnabled(); return this.native.systemKey(key as "BACK" | "HOME" | "RECENTS" | "NOTIFICATIONS" | "QUICK_SETTINGS"); });
  }
  private async requireEnabled(): Promise<void> { const state = await this.native.status(); if (state.state !== "available") throw new Error(state.state === "permission_required" ? "ACCESSIBILITY_PERMISSION_REQUIRED" : "ACCESSIBILITY_SERVICE_UNAVAILABLE"); }
}
function boundedText(value: string, field: string): string { if (typeof value !== "string" || value.length > MAX_TEXT || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) throw new Error(`ACCESSIBILITY_INVALID_${field.toUpperCase()}`); return value; }
function validatePoint(x: number, y: number): void { if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > 100_000 || y > 100_000) throw new Error("ACCESSIBILITY_INVALID_COORDINATE"); }
function treeBounds(nodes: readonly AccessibilityNode[]): DeviceBounds | undefined { if (!nodes.length) return undefined; return nodes.reduce((a,n) => ({left:Math.min(a.left,n.bounds.left),top:Math.min(a.top,n.bounds.top),right:Math.max(a.right,n.bounds.right),bottom:Math.max(a.bottom,n.bounds.bottom)}), {...nodes[0].bounds}); }
