import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DevicePolicy } from '../core/enhancements/device/DevicePolicy.ts';
import { AccessibilityEngine } from '../core/enhancements/device/AccessibilityEngine.ts';
import { WirelessAdbManager } from '../core/enhancements/device/WirelessAdbManager.ts';
import { VirtualDisplay } from '../core/enhancements/device/VirtualDisplay.ts';
import { DeviceBridge } from '../core/enhancements/device/DeviceBridge.ts';

const timeline = [];
const policy = new DevicePolicy({ timeline: (event) => timeline.push(event) });
let stopped = 0;
let removed = 0;
let onNativeRequest;
const nativeResponses = new Map();
const responseWaiters = new Map();
const awaitResponse = (requestId) => {
  if (nativeResponses.has(requestId)) return Promise.resolve(nativeResponses.get(requestId));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { responseWaiters.delete(requestId); reject(new Error(`NO_NATIVE_RESPONSE:${requestId}`)); }, 1000);
    responseWaiters.set(requestId, (value) => { clearTimeout(timer); resolve(value); });
  });
};
const native = {
  status: async () => ({ state: 'available' }),
  openSettings: async () => {},
  getTree: async () => [{ text: 'Continue', bounds: { left: 0, top: 0, right: 100, bottom: 50 }, clickable: true }],
  clickText: async () => true,
  tap: async () => true,
  swipe: async () => true,
  inputText: async () => true,
  systemKey: async () => true,
};
const accessibility = new AccessibilityEngine(policy, native);
const adb = new WirelessAdbManager(policy, {
  pair: async () => ({ ok: false, message: '' }),
  connect: async () => ({ ok: false, message: '' }),
  list: async () => ({ ok: true, devices: [] }),
  loadLastHost: async () => '127.0.0.1:5555',
});
const fakeFrame = { status: { state: 'available', reason: 'current display only' }, frameId: 'frame-bridge-1', width: 320, height: 640, data: 'ZmFrZS1qcGVn' };
const virtualDisplay = new VirtualDisplay(policy, {
  status: async () => ({ state: 'available', reason: 'public secondary display API available' }),
  listDisplays: async () => ({ status: { state: 'available' }, displays: [{ displayId: 9, name: 'External', width: 1280, height: 720 }] }),
  readDisplayTree: async () => [{ text: 'external window', bounds: { left: 0, top: 0, right: 100, bottom: 80 }, clickable: true }],
  capture: async (displayId) => displayId === undefined ? fakeFrame : { ...fakeFrame, frameId: `frame-${displayId}`, displayId },
  input: async () => ({ ok: true }),
});
const bridge = new DeviceBridge(policy, accessibility, adb, virtualDisplay, () => 'a'.repeat(64), {
  start: async () => ({ url: 'http://127.0.0.1:9999', token: 'b'.repeat(64) }),
  stop: async () => { stopped += 1; },
  subscribe: (listener) => { onNativeRequest = listener; return () => { removed += 1; onNativeRequest = undefined; }; },
  respond: async (requestId, responseJson) => {
    const result = { requestId, response: JSON.parse(responseJson) };
    nativeResponses.set(requestId, result);
    responseWaiters.get(requestId)?.(result);
    responseWaiters.delete(requestId);
  },
}, {
  readMetadata: async (item) => item === 'device-model' ? 'test-device' : 'Android 14',
  readBattery: async () => ({ batteryPercent: 73, pluggedIn: true, lowPowerMode: false }),
});

assert.equal((await virtualDisplay.status().catch((error) => ({ state: error.code }))).state, 'CAPABILITY_REQUIRED');
policy.grantByUser('device.accessibility');
policy.grantByUser('device.bridge.listen');
policy.grantByUser('device.virtualdisplay');
assert.equal((await virtualDisplay.status()).state, 'available');
const localToken = bridge.issueToken();
assert.match((await bridge.request(localToken, { type: 'files.read', item: 'device-model' })).error, /device\.metadata\.read/);
assert.match((await bridge.request(localToken, { type: 'sensors.read', sensor: 'battery' })).error, /device\.sensors\.read/);
policy.grantByUser('device.metadata.read');
policy.grantByUser('device.sensors.read');
assert.equal((await bridge.request(localToken, { type: 'files.read', item: 'device-model' })).value, 'test-device');
assert.equal((await bridge.request(localToken, { type: 'files.read', item: 'android-version' })).value, 'Android 14');
assert.deepEqual((await bridge.request(localToken, { type: 'sensors.read', sensor: 'battery' })).value, { batteryPercent: 73, pluggedIn: true, lowPowerMode: false });
assert.ok(timeline.some((event) => event.operation === 'bridge.files.read' && event.outcome === 'authorized'));
assert.ok(timeline.some((event) => event.operation === 'bridge.sensors.read' && event.outcome === 'authorized'));
const agentDenied = await bridge.requestFromTrustedHost({ type: 'adb.list' });
assert.match(agentDenied.error, /device\.adb/);
assert.ok(timeline.some((event) => event.operation === 'adb.list' && event.outcome === 'blocked'), 'trusted AgentManager entry must still deny and audit missing grants');
policy.grantByUser('device.adb');
const directCapture = await bridge.request(localToken, { type: 'virtualdisplay.capture' });
assert.equal(directCapture.value.frameId, fakeFrame.frameId);
assert.equal(directCapture.value.data, fakeFrame.data);
assert.deepEqual((await bridge.request(localToken, { type: 'virtualdisplay.displays' })).value.displays.map((item) => item.displayId), [9]);
assert.equal((await bridge.request(localToken, { type: 'virtualdisplay.tree', displayId: 9 })).value[0].text, 'external window');
assert.equal((await bridge.request(localToken, { type: 'virtualdisplay.capture', displayId: 9 })).value.displayId, 9);
assert.equal((await bridge.request(localToken, { type: 'virtualdisplay.input', frameId: 'frame-9', x: 10, y: 20 })).value.ok, true);
assert.equal((await bridge.request(localToken, { type: 'virtualdisplay.status' })).value.state, 'available');
assert.equal((await bridge.request(localToken, { type: 'adb.reconnect' })).value.ok, false);
assert.ok(timeline.some((event) => event.operation === 'virtualdisplay.capture' && event.outcome === 'authorized'));
assert.ok(timeline.some((event) => event.operation === 'adb.reconnect' && event.outcome === 'authorized'));
assert.equal((await bridge.request('bad', { type: 'screen.tree' })).error, 'DEVICE_BRIDGE_TOKEN_REJECTED');

const session = await bridge.startLoopback();
assert.equal(session.url.startsWith('http://127.0.0.1:'), true);
assert.equal(typeof onNativeRequest, 'function');
let responsePromise = awaitResponse('req-screen-1');
onNativeRequest({ requestId: 'req-screen-1', method: 'GET', path: '/v1/screen/tree', body: '' });
assert.deepEqual(await responsePromise, { requestId: 'req-screen-1', response: { ok: true, value: await native.getTree() } });
assert.ok(timeline.some((event) => event.operation === 'accessibility.tree' && event.outcome === 'authorized'), 'loopback screen action must be audited by DevicePolicy');
responsePromise = awaitResponse('req-tap-2');
onNativeRequest({ requestId: 'req-tap-2', method: 'POST', path: '/v1/input/tap', body: JSON.stringify({ x: 10, y: 20 }) });
assert.equal((await responsePromise).response.value, true);
assert.ok(timeline.some((event) => event.operation === 'accessibility.tap' && event.outcome === 'authorized'), 'loopback tap must be audited by DevicePolicy');
responsePromise = awaitResponse('req-virtual-capture');
onNativeRequest({ requestId: 'req-virtual-capture', method: 'GET', path: '/v1/virtualdisplay/capture', body: '' });
const captureResponse = (await responsePromise).response;
assert.equal(captureResponse.value.frameId, fakeFrame.frameId);
assert.equal(captureResponse.value.data, fakeFrame.data);
assert.ok(timeline.some((event) => event.operation === 'virtualdisplay.capture' && event.outcome === 'authorized'), 'loopback capture must be audited by DevicePolicy');
responsePromise = awaitResponse('req-secondary-displays');
onNativeRequest({ requestId: 'req-secondary-displays', method: 'GET', path: '/v1/virtualdisplay/displays', body: '' });
assert.deepEqual((await responsePromise).response.value.displays.map((item) => item.displayId), [9]);
responsePromise = awaitResponse('req-secondary-tree');
onNativeRequest({ requestId: 'req-secondary-tree', method: 'POST', path: '/v1/virtualdisplay/tree', body: JSON.stringify({ displayId: 9 }) });
assert.equal((await responsePromise).response.value[0].text, 'external window');
responsePromise = awaitResponse('req-secondary-capture');
onNativeRequest({ requestId: 'req-secondary-capture', method: 'POST', path: '/v1/virtualdisplay/capture', body: JSON.stringify({ displayId: 9 }) });
assert.equal((await responsePromise).response.value.displayId, 9);
responsePromise = awaitResponse('req-secondary-input');
onNativeRequest({ requestId: 'req-secondary-input', method: 'POST', path: '/v1/virtualdisplay/input', body: JSON.stringify({ frameId: 'frame-9', x: 10, y: 20 }) });
assert.equal((await responsePromise).response.value.ok, true);
responsePromise = awaitResponse('req-device-model');
onNativeRequest({ requestId: 'req-device-model', method: 'POST', path: '/v1/files/read', body: JSON.stringify({ item: 'device-model' }) });
assert.equal((await responsePromise).response.value, 'test-device');
responsePromise = awaitResponse('req-battery');
onNativeRequest({ requestId: 'req-battery', method: 'POST', path: '/v1/sensors/read', body: JSON.stringify({ sensor: 'battery' }) });
assert.deepEqual((await responsePromise).response.value, { batteryPercent: 73, pluggedIn: true, lowPowerMode: false });
responsePromise = awaitResponse('req-virtualdisplay-status');
onNativeRequest({ requestId: 'req-virtualdisplay-status', method: 'GET', path: '/v1/virtualdisplay/status', body: '' });
assert.equal((await responsePromise).response.value.state, 'available');
responsePromise = awaitResponse('req-virtualdisplay-input-post');
onNativeRequest({ requestId: 'req-virtualdisplay-input-post', method: 'POST', path: '/v1/virtualdisplay/input', body: JSON.stringify({ frameId: 'frame-10', x: 11, y: 21 }) });
assert.match((await responsePromise).response.error, /VIRTUAL_DISPLAY_STALE_FRAME_ID/);
responsePromise = awaitResponse('req-adb-reconnect');
onNativeRequest({ requestId: 'req-adb-reconnect', method: 'GET', path: '/v1/adb/reconnect', body: '' });
assert.equal((await responsePromise).response.value.ok, false);
responsePromise = awaitResponse('req-unknown-3');
onNativeRequest({ requestId: 'req-unknown-3', method: 'POST', path: '/v1/arbitrary', body: '{}' });
assert.match((await responsePromise).response.error, /POLICY_BLOCKED/);
assert.ok(timeline.some((event) => event.operation === 'unknown' && event.outcome === 'blocked'));
await bridge.revokeByUser('device.virtualdisplay');
assert.match((await bridge.request(session.token, { type: 'virtualdisplay.capture' })).error, /POLICY_BLOCKED/);
await bridge.revokeByUser('device.sensors.read');
assert.match((await bridge.request(session.token, { type: 'sensors.read', sensor: 'battery' })).error, /device\.sensors\.read/);
await bridge.revokeByUser('device.bridge.listen');
assert.equal(stopped, 1);
assert.equal(removed, 1);
assert.equal(bridge.getLoopbackStatus(), 'stopped');
assert.equal(typeof onNativeRequest, 'undefined');
assert.equal((await bridge.request(session.token, { type: 'screen.tree' })).error, 'DEVICE_BRIDGE_TOKEN_REJECTED');

const xml = fs.readFileSync('plugins/android/aib_accessibility_service.xml', 'utf8');
const kt = fs.readFileSync('plugins/android/AibLoopbackServer.kt', 'utf8');
const module = fs.readFileSync('plugins/android/AibAccessibilityModule.kt', 'utf8');
const plugin = fs.readFileSync('app.config.ts', 'utf8');
const configPlugin = fs.readFileSync('plugins/withAibAccessibility.js', 'utf8');
const runtimeSource = fs.readFileSync('core/RuntimeFacade.ts', 'utf8');
const service = fs.readFileSync('plugins/android/AibAccessibilityService.kt', 'utf8');
assert.match(xml, /canPerformGestures="true"/);
assert.match(kt, /getByName\("127\.0\.0\.1"\)/);
assert.match(kt, /SecureRandom\(\)\.nextBytes/);
assert.match(kt, /dispatch\(method, path, String\(body, Charsets\.UTF_8\)\)/);
assert.doesNotMatch(kt, /service\.uiTree\(\)|service\.gesture\(/, 'native HTTP server must not bypass JS DevicePolicy');
assert.match(module, /AibDeviceBridgeRequest/);
assert.match(module, /respondLoopbackRequest/);
assert.match(module, /invalidate\(\)[\s\S]*loopback\.stop\(\)/);
assert.match(service, /AibLoopbackLifecycle\.stop/);
assert.match(service, /captureCurrentDisplay\(callback:[\s\S]*?captureDisplayInternal\(Display\.DEFAULT_DISPLAY, false/);
assert.match(service, /takeScreenshot\(displayId, screenshotExecutor/);
assert.match(service, /captureDisplayInternal\(displayId, true/);
assert.match(module, /captureCurrentDisplay/);
assert.match(plugin, /withAibAccessibility/);
assert.match(configPlugin, /GET \/v1\/adb\/reconnect/);
assert.match(configPlugin, /POST \/v1\/virtualdisplay\/tree/);
assert.match(kt, /"POST \/v1\/sensors\/read"/);
const runDeviceToolHook = runtimeSource.match(/runDeviceTool: async \(tool, args\) => \{([\s\S]*?)\n      \},\n      wakeForTask:/)?.[1] ?? '';
assert.match(runDeviceToolHook, /requestFromTrustedHost/);
assert.doesNotMatch(runDeviceToolHook, /this\.(?:accessibility|wirelessAdb|virtualDisplay)\./, 'agent device actions must use the unified DeviceBridge route');
assert.match(runtimeSource, /allowedCapabilities: \["filesystem", "terminal", "adb", "device\.accessibility", "device\.adb", "device\.virtualdisplay"\]/);
  console.log('PASS bridge token rejection, per-action policy audit, narrow metadata/battery reads, revocation, listener cleanup, current-display capture and native static checks');
