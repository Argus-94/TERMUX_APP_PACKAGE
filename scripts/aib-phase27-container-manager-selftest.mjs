#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
const root = process.cwd();
const required = [
  'core/container/ProotContainerManager.ts',
  'core/container/ContainerProfiles.ts',
  'core/RuntimeFacade.ts',
  'app/runtime.tsx',
];
for (const file of required) {
  if (!fs.existsSync(path.join(root, file))) throw new Error(`MISSING:${file}`);
}
const manager = fs.readFileSync(path.join(root, 'core/container/ProotContainerManager.ts'), 'utf8');
const facade = fs.readFileSync(path.join(root, 'core/RuntimeFacade.ts'), 'utf8');
const ui = fs.readFileSync(path.join(root, 'app/runtime.tsx'), 'utf8');
const appLayout = fs.readFileSync(path.join(root, 'app/_layout.tsx'), 'utf8');
for (const token of ['ProotContainerManager','containerCreate','containerExec','proot-distro','CONTAINER_COMMAND_NOT_ALLOWED','CONTAINER_CWD_MUST_BE_WORKSPACE','--bind','normalizedMounts','await this.normalizedMounts(inst)','resolveExistingMountPath','canonicalProjectsRoot','destination.split("/").some((segment) => segment === ".." || segment === ".")','PROOT_PROFILE_STATE_UNVERIFIED','PROOT_PROFILE_INSTALLED_LOGIN_FAILED','validateProjectName','CONTAINER_MOUNT_HOST_OUTSIDE_PROJECTS','findByProjectId']) {
  if (!manager.includes(token) && !facade.includes(token)) throw new Error(`CONTRACT:${token}`);
}
if (/["']-lc["']/.test(manager)) throw new Error('PROOT_LOGIN_SHELL_STARTUP_SIDE_EFFECTS');
if (!manager.includes('sh", "-c"')) throw new Error('PROOT_NON_LOGIN_SHELL_REQUIRED');
for (const token of ['sleepWake?.register(instanceId)', 'sleepWake?.unregister(instanceId)', 'containerRuntime.findByProjectId(projectId)', 'maintenance.wakeContainer(containerId)', 'new SleepWakeManager(', 'new ResourcePressureReaper(', 'loadNativeMemoryPressureModule()', 'getAvailableMemoryBytes()', 'primeMemoryPressureMonitoring()', 'CONTAINER_QUARANTINED', 'containerRuntime.isExecuting(containerId)']) if (!facade.includes(token)) throw new Error(`LIFECYCLE_WIRING:${token}`);
if (!appLayout.includes('"AibMemoryPressure"') || !appLayout.includes('primeMemoryPressureMonitoring')) throw new Error('ANDROID_MEMORY_PRESSURE_EVENT_NOT_WIRED');
if (!ui.includes('online=${result.defaults.models.online}') || !ui.includes('offline=${result.defaults.models.offline}')) throw new Error('FIRST_RUN_REPORT_MODEL_STATUS_MISSING');
const runtimeI18n = fs.readFileSync(path.join(root, 'lib/runtime-i18n.ts'), 'utf8');
for (const token of ['createStartDebian','containerManager']) { if (!runtimeI18n.includes(`${token}:`) || !ui.includes(`rt("${token}")`)) throw new Error(`UI:${token}`); }
if (/split\(\/\\s\+\/\)\[0\]/.test(manager)) throw new Error('COMMAND_PREFIX_ALLOWLIST_REGRESSION');
if (manager.includes('docker run') || manager.includes('podman run')) throw new Error('UNEXPECTED_NATIVE_CONTAINER_BACKEND');
console.log('AIB_PHASE27_CONTAINER_MANAGER_SELFTEST_OK');
