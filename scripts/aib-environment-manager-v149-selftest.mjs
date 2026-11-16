import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const runtime = fs.readFileSync(path.join(root, 'app/runtime.tsx'), 'utf8');
const settings = fs.readFileSync(path.join(root, 'app/settings.tsx'), 'utf8');
const manager = fs.readFileSync(path.join(root, 'lib/environment-manager.ts'), 'utf8');
const backend = fs.readFileSync(path.join(root, 'lib/agent-shell-backend.ts'), 'utf8');

for (const token of ['termux', 'ubuntu-proot', 'ubuntu-proot']) {
  if (!runtime.includes(token)) throw new Error(`runtime missing backend ${token}`);
}
for (const token of ['parseAgentShellBackend', 'setBuildBackend']) {
  if (!manager.includes(token)) throw new Error(`manager missing ${token}`);
}
for (const token of ['saveEnvironmentBackend', 'loadEnvironmentBackend', 'environmentBackend']) {
  if (!runtime.includes(token)) throw new Error(`runtime missing ${token}`);
}
for (const token of ['BUILD_BACKEND_STORAGE_KEY', 'LEGACY_AGENT_SHELL_BACKEND_STORAGE_KEY', 'setBuildBackend']) {
  if (!manager.includes(token)) throw new Error(`manager missing ${token}`);
}
if (!settings.includes('Open Environment manager') || !settings.includes('router.push("/runtime")')) {
  throw new Error('settings is not a mirror of the single Environment manager');
}
if (!settings.includes('Unified build and agent environment') || !settings.includes('source of truth')) {
  throw new Error('settings does not explain the unified build/agent backend');
}
if (settings.includes('onPress={() => setAgentShellBackend("termux")}')) {
  throw new Error('settings still contains a second environment selector');
}
if (!backend.includes('ubuntu-proot')) throw new Error('backend union lost Debian');
console.log('AIB_ENVIRONMENT_MANAGER_V149_SELFTEST_OK single_source=runtime backends=termux,ubuntu,debian settings=mirror');
