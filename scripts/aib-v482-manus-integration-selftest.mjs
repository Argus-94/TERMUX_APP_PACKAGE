import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { loadTypeScript } from './test-helpers/load-typescript.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ts = loadTypeScript();
const require = createRequire(import.meta.url);
function loadTs(file, mocks = {}) {
  const source = fs.readFileSync(file, 'utf8');
  const js = ts.transpile(source, { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true });
  const mod = { exports: {} };
  const localRequire = (id) => {
    if (Object.hasOwn(mocks, id)) return mocks[id];
    if (id.startsWith('.')) {
      const resolved = path.resolve(path.dirname(file), id);
      for (const candidate of [resolved + '.ts', path.join(resolved, 'index.ts')])
        if (fs.existsSync(candidate)) return loadTs(candidate, mocks);
    }
    return require(require.resolve(id, { paths: [root] }));
  };
  new Function('require', 'module', 'exports', js)(localRequire, mod, mod.exports);
  return mod.exports;
}
const proxyMod = loadTs(path.join(root, 'core/enhancements/auth/CredentialProxy.ts'), {
  './AgentAuthProxyAccess': { AGENT_AUTH_PROXY_ACCESS: Symbol('test-only') },
});
const { CredentialProxy } = proxyMod;
const SYNTHETIC = 'synthetic-fixture-not-a-real-manus-key';
let resolverCalls = 0;
const authStore = { createProxyResolver() { return async () => { resolverCalls++; return SYNTHETIC; }; } };
const starts = [], stops = [], sent = [];
const nativeTransport = {
  async start(provider, credential, route) {
    starts.push({ provider, credential, route });
    return { sessionId: `session-${starts.length}`, baseUrl: `http://127.0.0.1:32145/v1/session/session-${starts.length}`, apiKey: 'dummy-aib-proxy-key' };
  },
  async stop(id) { stops.push(id); return true; },
};
const fetcher = async (url, init) => {
  sent.push({ url: new URL(url), init });
  return new Response('{"ok":true,"user_id":"fixture-user"}', { status: 200, headers: { 'content-type': 'application/json' } });
};
const proxy = new CredentialProxy(authStore, { manus: { baseUrl: 'https://api.manus.ai' } }, { nativeTransport, fetcher });
const response = await proxy.forward({ provider: 'manus', path: 'v2/task.listMessages?cursor=cursor-fixture', method: 'GET' });
assert.equal(response.status, 200);
assert.equal(starts[0].provider, 'manus');
assert.equal(starts[0].route.baseUrl, 'https://api.manus.ai');
assert.equal(starts[0].route.authHeader, 'x-manus-api-key');
assert.equal(starts[0].route.authScheme, 'raw');
assert.equal(starts[0].credential, SYNTHETIC);
assert.equal(sent[0].url.pathname, '/v1/session/session-1/v2/task.listMessages');
assert.equal(sent[0].url.searchParams.get('cursor'), 'cursor-fixture');
assert.equal(sent[0].init.headers.get('authorization'), 'Bearer dummy-aib-proxy-key');
assert.equal(sent[0].init.headers.get('x-manus-api-key'), null);
assert.equal(sent[0].init.headers.get('authorization').includes(SYNTHETIC), false);

for (const route of [
  { baseUrl: 'https://evil.example' },
  { baseUrl: 'https://api.manus.ai', authHeader: 'authorization', authScheme: 'Bearer' },
  { baseUrl: 'http://api.manus.ai' },
]) {
  const p = new CredentialProxy(authStore, { manus: route }, { nativeTransport, fetcher });
  await assert.rejects(() => p.forward({ provider: 'manus', path: 'v2/user.me', method: 'GET' }));
}
for (const request of [
  { provider: 'manus', path: 'v2/task.create', method: 'GET' },
  { provider: 'manus', path: 'v2/task.listMessages', method: 'POST' },
  { provider: 'manus', path: '../v2/user.me', method: 'GET' },
  { provider: 'manus', path: 'v2/user.me?confirmAction=true', method: 'GET' },
]) await assert.rejects(() => proxy.probeWithCredential(request, SYNTHETIC));
const beforeProbe = sent.length;
const probe = await proxy.probeWithCredential({ provider: 'manus', path: 'v2/user.me', method: 'GET' }, SYNTHETIC);
assert.equal(probe.status, 200);
assert.equal(sent.length, beforeProbe + 1);
assert.equal(sent.at(-1).url.pathname, '/v1/session/session-2/v2/user.me');
assert.equal(sent.at(-1).init.method, 'GET');
assert.equal(starts.at(-1).credential, SYNTHETIC);
assert.equal(stops.includes('session-2'), true);
assert.equal(resolverCalls, 1, 'transient probe must not resolve or persist saved credential');

// v485: the new read-only route retains native credential isolation.
assert.equal((await proxy.forward({ provider: 'manus', path: 'v2/usage.availableCredits', method: 'GET' })).status, 200);
assert.equal(sent.at(-1).url.pathname, '/v1/session/session-1/v2/usage.availableCredits');
assert.equal(sent.at(-1).init.headers.get('x-manus-api-key'), null);
await assert.rejects(() => proxy.forward({ provider: 'manus', path: 'v2/usage.availableCredits', method: 'POST' }));
await assert.rejects(() => proxy.forward({ provider: 'manus', path: 'v2/usage.teamStatistic', method: 'GET' }));

// Static supplemental checks, deliberately labeled separately from production runtime coverage.
const api = fs.readFileSync(path.join(root, 'lib/manus-api.ts'), 'utf8');
assert.match(api, /probeManusCredential\(draft/);
assert.match(api, /request\("v2\/user\.me", "GET"/);
const hook = fs.readFileSync(path.join(root, 'hooks/useManusSettings.ts'), 'utf8');
const store = fs.readFileSync(path.join(root, 'lib/manus-task-store.ts'), 'utf8');
const card = fs.readFileSync(path.join(root, 'components/ManusProviderCard.tsx'), 'utf8');
assert.match(hook, /hasProviderCredential|saveProviderCredential/);
assert.match(hook, /removeManusKey/);
assert.match(store, /SecureStore|AsyncStorage|persist|load/i);
assert.match(card, /Manus/i);
console.log('PASS runtime CredentialProxy integration: pinned route, synthetic secret isolation, task-list URL/query, blocked probe misuse, read-only user.me transient probe');
console.log('PASS static-only supplemental coverage: manus API/hook/task store/settings card source present');
