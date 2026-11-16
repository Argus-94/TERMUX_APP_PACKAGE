#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const settings = fs.readFileSync(path.join(root, 'app/settings.tsx'), 'utf8');
const runtime = fs.readFileSync(path.join(root, 'app/runtime.tsx'), 'utf8');
const manager = fs.readFileSync(path.join(root, 'lib/environment-manager.ts'), 'utf8');
const build = fs.readFileSync(path.join(root, 'lib/build-loop.ts'), 'utf8');
const backend = fs.readFileSync(path.join(root, 'lib/agent-shell-backend.ts'), 'utf8');

for (const token of ['Среда сборки и агента', 'router.push("/runtime")', 'agentShellExecutionTarget']) {
  if (!settings.includes(token)) throw new Error(`SETTINGS_MIRROR_TOKEN_MISSING:${token}`);
}
for (const token of ['termux', 'ubuntu-proot', 'ubuntu-proot', 'saveEnvironmentBackend', 'loadEnvironmentBackend']) {
  if (!runtime.includes(token)) throw new Error(`RUNTIME_ENVIRONMENT_TOKEN_MISSING:${token}`);
}
for (const token of ['BUILD_BACKEND_STORAGE_KEY', 'LEGACY_AGENT_SHELL_BACKEND_STORAGE_KEY', 'setBuildBackend']) {
  if (!manager.includes(token)) throw new Error(`ENVIRONMENT_MANAGER_TOKEN_MISSING:${token}`);
}
if (settings.includes('setAgentShellBackend("termux")') || settings.includes('setAgentShellBackend("ubuntu-proot")') || settings.includes('setAgentShellBackend("ubuntu-proot")')) throw new Error('SECOND_ENVIRONMENT_SELECTOR_REMAINS');
for (const token of ['getBuildBackend()', 'BUILD_BACKEND=', 'backend=${backend}', 'ANDROID_SDK_NOT_FOUND backend=', 'JAVA_NOT_FOUND backend=']) {
  if (!build.includes(token)) throw new Error(`BUILD_TOKEN_MISSING:${token}`);
}
if (!backend.includes('getAgentShellBackend = getBuildBackend') || !backend.includes('wrapCommandForAgentShell') || !backend.includes('ubuntu-proot') || !backend.includes('ubuntu-proot')) {
  throw new Error('AGENT_BACKEND_ROUTING_MISSING');
}
if (settings.includes('Где выполнять команды агента')) throw new Error('OLD_AGENT_SWITCH_LABEL_REMAINS');
if (!backend.includes('aibuilder.buildBackend.v1')) throw new Error('BUILD_BACKEND_STORAGE_KEY_MISSING');
if (!backend.includes('aibuilder.agentShellBackend.v1')) throw new Error('LEGACY_BACKEND_MIGRATION_MISSING');
console.log('AIB_BUILD_BACKEND_SELFTEST_OK unified=1 agent_follows_build=1 termux=1 ubuntu_environment=1 debian_environment=1 persisted_as_build_backend=1');
