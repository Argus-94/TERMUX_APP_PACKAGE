import assert from 'node:assert/strict';
import { DevicePolicy } from '../core/enhancements/device/DevicePolicy.ts';
import { WirelessAdbManager, validateAdbHostPort } from '../core/enhancements/device/WirelessAdbManager.ts';

const policy = new DevicePolicy({ timeline: () => {} });
let receivedCode = '';
const connectedHosts = [];
const manager = new WirelessAdbManager(policy, {
  pair: async (host, code) => { receivedCode = code; return { ok: true, message: `secret=${code}:${host}` }; },
  connect: async (host) => { connectedHosts.push(host); return { ok: true, message: '' }; },
  list: async () => ({ ok: true, devices: [{ serial: '192.168.1.10:5555', state: 'device' }] }),
  loadLastHost: async () => '192.168.1.10:5555',
});

await assert.rejects(manager.pair('127.0.0.1:1234', '123456'), /POLICY_BLOCKED/);
await assert.rejects(manager.reconnect(), /POLICY_BLOCKED/);
policy.grantByUser('device.adb');
const paired = await manager.pair('127.0.0.1:1234', '123456');
assert.equal(receivedCode, '123456');
assert.equal(paired.message.includes('123456'), false);
assert.equal(paired.message.includes('secret'), false);
assert.equal((await manager.list()).devices.length, 1);
const reconnect = await manager.reconnect();
assert.equal(reconnect.ok, true);
assert.deepEqual(connectedHosts, ['192.168.1.10:5555']);
assert.throws(() => validateAdbHostPort('user@host:22'));
assert.throws(() => validateAdbHostPort('999.1.1.1:2'));

// A successful connect response is not enough: only the exact target in `device` state is online.
for (const state of ['unauthorized', 'offline', 'unknown']) {
  const falseSuccess = new WirelessAdbManager(policy, {
    pair: async () => ({ ok: true, message: '' }),
    connect: async () => ({ ok: true, message: 'connected' }),
    list: async () => ({ ok: true, devices: [{ serial: '192.168.1.20:5555', state }] }),
  });
  const result = await falseSuccess.connect('192.168.1.20:5555');
  assert.equal(result.ok, false, `state=${state} cannot be called connected`);
  assert.match(result.message, /not authorized and online/);
}
const disconnected = new WirelessAdbManager(policy, {
  pair: async () => ({ ok: true, message: '' }),
  connect: async () => ({ ok: true, message: 'connected' }),
  list: async () => ({ ok: false, devices: [] }),
});
assert.equal((await disconnected.connect('192.168.1.21:5555')).ok, false);
const timeout = new WirelessAdbManager(policy, {
  pair: async () => ({ ok: true, message: '' }),
  connect: async () => { throw new Error('timeout'); },
  list: async () => ({ ok: true, devices: [{ serial: '192.168.1.22:5555', state: 'device' }] }),
});
assert.equal((await timeout.connect('192.168.1.22:5555')).ok, false);

const noSavedManager = new WirelessAdbManager(policy, {
  pair: async () => ({ ok: false, message: '' }),
  connect: async () => ({ ok: false, message: '' }),
  list: async () => ({ ok: false, devices: [] }),
  loadLastHost: async () => '',
});
assert.equal((await noSavedManager.reconnect()).ok, false);
console.log('PASS ADB input validation, secret handling, policy gate, authorized online-state verification, timeout/disconnect false-success rejection');
