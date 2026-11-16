#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DevicePolicy } from '../core/enhancements/device/DevicePolicy.ts';
import { VirtualDisplay, unsupportedVirtualDisplayAdapter } from '../core/enhancements/device/VirtualDisplay.ts';
import { createNativeVirtualDisplayAdapter } from '../core/enhancements/device/NativeAccessibilityAdapter.ts';

const events = [];
const policy = new DevicePolicy({ maxConcurrent: 1, timeline: (event) => events.push(event) });
const publicDisplays = [
  { displayId: 7, name: 'HDMI display', width: 1920, height: 1080 },
  { displayId: 0, name: 'Must be filtered', width: 1080, height: 2400 },
  { displayId: -2, name: 'Invalid', width: 1, height: 1 },
  { displayId: 8, name: '', width: 300, height: 400 },
];
const captureCalls = [];
const tapCalls = [];
let treeTarget = null;
const native = {
  async status() { return { state: 'available' }; },
  async listDisplays() { return { status: { state: 'available' }, displays: publicDisplays }; },
  async readDisplayTree(displayId) { treeTarget = displayId; return [{ text: 'Secondary button', bounds: { left: 0, top: 0, right: 80, bottom: 32 }, clickable: true }, { text: 'bad bounds', bounds: { left: -1, top: 0, right: 0, bottom: 0 }, clickable: true }]; },
  async capture(displayId) { captureCalls.push(displayId); return { status: { state: 'available' }, frameId: displayId === undefined ? 'primary-frame' : `secondary-${displayId}-frame`, displayId: displayId ?? 0, width: 320, height: 180, data: 'ZmFrZS1qcGVn' }; },
  async input(frameId, x, y) { tapCalls.push({ frameId, x, y }); return { ok: true }; },
};
const display = new VirtualDisplay(policy, native);
await assert.rejects(display.listDisplays(), /POLICY_BLOCKED|CAPABILITY_REQUIRED/);
policy.grantByUser('device.virtualdisplay');

const discovered = await display.listDisplays();
assert.equal(discovered.status.state, 'available');
assert.deepEqual(discovered.displays.map(({ displayId }) => displayId), [7], 'only valid live non-primary entries from the native public list are exposed');
assert.deepEqual(await display.readDisplayTree(7), [{ text: 'Secondary button', bounds: { left: 0, top: 0, right: 80, bottom: 32 }, clickable: true }]);
assert.equal(treeTarget, 7, 'tree discovery must remain bound to selected displayId');
await assert.rejects(display.readDisplayTree(8), /TARGET_PUBLIC_SECONDARY_DISPLAY_NOT_CURRENTLY_AVAILABLE/);

const selectedFrame = await display.capture(7);
assert.equal(captureCalls.at(-1), 7, 'secondary screenshot must receive exact selected displayId');
assert.equal(selectedFrame.displayId, 7);
assert.equal((await display.input(selectedFrame.frameId, 20, 30)).ok, true);
assert.deepEqual(tapCalls.at(-1), { frameId: selectedFrame.frameId, x: 20, y: 30 });
await assert.rejects(display.input(selectedFrame.frameId, 320, 40), /VIRTUAL_DISPLAY_OUT_OF_FRAME_BOUNDS/);
await assert.rejects(display.input('stale-frame', 20, 30), /VIRTUAL_DISPLAY_STALE_FRAME_ID/);

const primaryFrame = await display.capture();
assert.equal(captureCalls.at(-1), undefined);
await assert.rejects(display.input(primaryFrame.frameId, 20, 30), /VIRTUAL_DISPLAY_PRIMARY_INPUT_UNSUPPORTED/);
const callsBeforeUnavailable = captureCalls.length;
const missingTarget = await display.capture(77);
assert.equal(missingTarget.status.state, 'unavailable');
assert.equal(captureCalls.length, callsBeforeUnavailable, 'unknown/private/removed target is rejected before native capture; no display-0 fallback');
await assert.rejects(display.capture(0), /VIRTUAL_DISPLAY_INVALID_TARGET/);
assert.ok(events.some((event) => event.operation === 'virtualdisplay.displays' && event.outcome === 'authorized'));
assert.ok(events.some((event) => event.operation === 'virtualdisplay.tree' && event.outcome === 'authorized'));
assert.ok(events.some((event) => event.operation === 'virtualdisplay.capture' && event.outcome === 'authorized'));
assert.ok(events.some((event) => event.operation === 'virtualdisplay.input' && event.outcome === 'authorized'));

const unavailable = new VirtualDisplay(policy, unsupportedVirtualDisplayAdapter);
assert.equal((await unavailable.listDisplays()).status.state, 'unsupported');
const adapterCalls = [];
const nativeModule = {
  async status() { return { state: 'available' }; }, async openSettings() {}, async getTree() { return []; },
  async clickText() { return false; }, async tap() { return false; }, async swipe() { return false; }, async inputText() { return false; }, async systemKey() { return false; },
  async startLoopback() { return { url: '', token: '' }; }, async stopLoopback() {}, async respondLoopbackRequest() { return false; },
  async virtualDisplayStatus() { return { state: 'available' }; },
  async listPublicSecondaryDisplays() { adapterCalls.push(['list']); return { status: { state: 'available' }, displays: [{ displayId: 12, name: 'Projected screen', width: 1280, height: 720 }] }; },
  async getPublicSecondaryDisplayTree(id) { adapterCalls.push(['tree', id]); return []; },
  async captureCurrentDisplay() { adapterCalls.push(['primary']); return { status: { state: 'available' }, frameId: 'primary-frame', displayId: 0, width: 320, height: 180, data: 'ZmFrZS1qcGVn' }; },
  async captureSecondaryDisplay(id) { adapterCalls.push(['secondary', id]); return { status: { state: 'available' }, frameId: 'secondary-frame', displayId: id, width: 320, height: 180, data: 'ZmFrZS1qcGVn' }; },
  async tapCapturedSecondaryFrame(id, x, y) { adapterCalls.push(['tap', id, x, y]); return true; },
};
const adapter = createNativeVirtualDisplayAdapter(nativeModule);
await adapter.listDisplays();
await adapter.capture(12);
await adapter.input('secondary-frame', 4, 5);
assert.deepEqual(adapterCalls, [['list'], ['secondary', 12], ['tap', 'secondary-frame', 4, 5]], 'native adapter routes exact target and never substitutes primary');

const service = fs.readFileSync('plugins/android/AibAccessibilityService.kt', 'utf8');
const module = fs.readFileSync('plugins/android/AibAccessibilityModule.kt', 'utf8');
const xml = fs.readFileSync('plugins/android/aib_accessibility_service.xml', 'utf8');
const plugin = fs.readFileSync('plugins/withAibAccessibility.js', 'utf8');
const runtime = fs.readFileSync('core/RuntimeFacade.ts', 'utf8');
const ui = fs.readFileSync('app/runtime.tsx', 'utf8');
const devicePolicy = fs.readFileSync('core/enhancements/device/DevicePolicy.ts', 'utf8');
const bridge = fs.readFileSync('core/enhancements/device/DeviceBridge.ts', 'utf8');
assert.match(service, /fun listPublicSecondaryDisplays\(\)[\s\S]*?manager\.displays/);
assert.match(service, /displayId != Display\.DEFAULT_DISPLAY[\s\S]*?Display\.FLAG_PRIVATE/);
assert.match(service, /takeScreenshot\(displayId, screenshotExecutor/);
assert.match(service, /fun captureSecondaryDisplay\(displayId: Int[\s\S]*?captureDisplayInternal\(displayId, true/);
assert.match(service, /fun tapCapturedSecondaryFrame\([\s\S]*?target\.frameId != frameId[\s\S]*?MAX_FRAME_AGE_MS[\s\S]*?findPublicSecondaryDisplay\(target\.displayId\)/);
assert.match(service, /\.setDisplayId\(target\.displayId\)/);
assert.match(service, /target\.frameWidth[\s\S]*?target\.frameHeight/);
assert.match(service, /return synchronized\(captureGuard\)[\s\S]*?\.setDisplayId\(target\.displayId\)[\s\S]*?dispatchGesture\(gesture, null, null\)[\s\S]*?if \(accepted\) lastCapturedFrame = null/);
assert.match(service, /if \(event != null\) synchronized\(captureGuard\)[\s\S]*?lastCapturedFrame = null/);
assert.match(service, /AccessibilityRecord\.displayId here: that API was added only in API 33/);
assert.match(service, /windows\.asSequence\(\)\.filter \{ it\.displayId == displayId \}/);
assert.match(module, /fun listPublicSecondaryDisplays\(promise: Promise\)/);
assert.match(module, /fun captureSecondaryDisplay\(displayId: Int/);
assert.match(module, /fun tapCapturedSecondaryFrame\(frameId: String/);
assert.match(module, /fun getPublicSecondaryDisplayTree\(displayId: Int/);
assert.match(xml, /canPerformGestures="true"/);
assert.match(xml, /canRetrieveWindowContent="true"/);
assert.match(plugin, /AibAccessibilityService\.kt/);
assert.match(plugin, /AibAccessibilityModule\.kt/);
assert.match(runtime, /createNativeVirtualDisplayAdapter\(nativeA11y\)/);
assert.match(runtime, /"device\.virtualdisplay\.displays"/);
assert.match(devicePolicy, /"virtualdisplay\.tree": "device\.virtualdisplay"/);
assert.match(bridge, /POST \/v1\/virtualdisplay\/capture/);
assert.match(bridge, /POST \/v1\/virtualdisplay\/input/);
assert.match(ui, /Discover live public secondary displays/);
assert.match(ui, /Tap this frame coordinate/);
console.log('PASS API-30 native source contract, public-display-only discovery, exact displayId screenshot, frame-bound tap/tree, no fallback, DevicePolicy, RN plugin and UI wiring');
