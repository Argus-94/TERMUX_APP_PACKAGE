#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const pluginSource = read('plugins/withTermuxBridge.js');
const githubPluginSource = read('plugins/withGithubTool.js');
const configSource = read('app.config.ts');
const bridge = read('lib/termux-bridge.ts');
const settings = read('app/settings.tsx');
const context = read('components/TermuxContext.tsx');
const chat = read('app/index.tsx');
const policy = read('docs/A04_STORAGE_POLICY.md');

const forbiddenManifest = [
  'android.permission.READ_EXTERNAL_STORAGE',
  'android.permission.WRITE_EXTERNAL_STORAGE',
];
const unusedOverlayPermission = 'android.permission.SYSTEM_ALERT_WINDOW';
for (const token of forbiddenManifest) {
  if (pluginSource.includes(`addPermission("${token}")`)) {
    throw new Error(`FORBIDDEN_PERMISSION_DECLARED ${token}`);
  }
  if (configSource.includes(`"${token}"`)) {
    throw new Error(`FORBIDDEN_PERMISSION_CONFIGURED ${token}`);
  }
}
if (githubPluginSource.includes(`addPermission("${unusedOverlayPermission}")`) || configSource.includes(`"${unusedOverlayPermission}"`)) {
  throw new Error('UNUSED_OVERLAY_PERMISSION_CONFIGURED');
}
const configuredPermissions = configSource.match(/(?:^|\n)\s*permissions:\s*\[([\s\S]*?)\]/)?.[1] || '';
const blockedPermissions = configSource.match(/(?:^|\n)\s*blockedPermissions:\s*\[([\s\S]*?)\]/)?.[1] || '';
if (!configuredPermissions.includes('"android.permission.MANAGE_EXTERNAL_STORAGE"')) {
  throw new Error('V471_MANAGE_EXTERNAL_STORAGE_SPECIAL_ACCESS_MISSING');
}
for (const token of ['Environment.isExternalStorageManager()', 'Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION', 'AIB_WORKSPACE_ALL_FILES_ACCESS_REQUIRED']) {
  if (!pluginSource.includes(token)) throw new Error(`MISSING_EXPLICIT_ALL_FILES_ACCESS_FLOW ${token}`);
}
for (const token of ['android.permission.READ_MEDIA_IMAGES', 'android.permission.READ_MEDIA_VIDEO', 'android.permission.READ_MEDIA_AUDIO']) {
  if (configuredPermissions.includes(`"${token}"`)) throw new Error(`BROAD_MEDIA_PERMISSION_CONFIGURED ${token}`);
  if (!blockedPermissions.includes(`"${token}"`)) throw new Error(`MISSING_TRANSITIVE_MEDIA_PERMISSION_BLOCK ${token}`);
}
if (configuredPermissions.includes('android.permission.READ_MEDIA_VISUAL_USER_SELECTED')) {
  throw new Error('UNNEEDED_SELECTED_MEDIA_PERMISSION_CONFIGURED');
}
for (const token of ['android.permission.CAMERA', 'android.permission.RECORD_AUDIO', 'android.permission.POST_NOTIFICATIONS']) {
  if (!configuredPermissions.includes(`"${token}"`)) throw new Error(`MISSING_USED_RUNTIME_PERMISSION ${token}`);
}

// Invoke the actual Expo config-plugin callback with a library-merged manifest
// fixture: static app.config.ts checks alone cannot see permissions declared by
// dependency AndroidManifest.xml files.
const require = createRequire(import.meta.url);
const Module = require('node:module');
const originalLoad = Module._load;
const manifestMods = [];
const pluginMocks = {
  withDangerousMod(config) { return config; },
  withMainApplication(config) { return config; },
  withAndroidManifest(config, action) { manifestMods.push(action); return config; },
};
try {
  Module._load = function (request, parent, isMain) {
    if (request === '@expo/config-plugins') return pluginMocks;
    return originalLoad.call(this, request, parent, isMain);
  };
  require(path.join(root, 'plugins/withGithubTool.js'))({
    android: { package: 'com.karat.aibuilder' },
    modRequest: { projectRoot: root, platformProjectRoot: path.join(root, 'android') },
  });
} finally {
  Module._load = originalLoad;
}
assert.equal(manifestMods.length, 2, 'GitHub plugin should register its activity and permission manifest mods');
let manifestConfig = { modResults: { manifest: {
  $: { 'xmlns:android': 'http://schemas.android.com/apk/res/android' },
  application: [{}],
  // Both pinned expo-image-picker and expo-file-system library manifests
  // contribute the legacy read/write declarations to manifest merge.
  'uses-permission': [
    { $: { 'android:name': 'android.permission.READ_EXTERNAL_STORAGE' } },
    { $: { 'android:name': 'android.permission.READ_EXTERNAL_STORAGE' } },
    { $: { 'android:name': 'android.permission.WRITE_EXTERNAL_STORAGE' } },
    { $: { 'android:name': 'android.permission.WRITE_EXTERNAL_STORAGE' } },
    { $: { 'android:name': 'android.permission.SYSTEM_ALERT_WINDOW' } },
    { $: { 'android:name': 'android.permission.CAMERA' } },
  ],
} } };
for (const mod of manifestMods) manifestConfig = mod(manifestConfig);
const manifest = manifestConfig.modResults.manifest;
for (const name of forbiddenManifest.slice(1)) {
  const entries = manifest['uses-permission'].filter((permission) => permission.$?.['android:name'] === name);
  assert.equal(entries.length, 2, `expected both duplicate dependency declarations for ${name}`);
  assert.ok(entries.every((permission) => permission.$['tools:node'] === 'remove'), `all legacy dependency permissions must be removed: ${name}`);
}
const overlayEntries = manifest['uses-permission'].filter((permission) => permission.$?.['android:name'] === unusedOverlayPermission);
assert.equal(overlayEntries.length, 1, 'expected Expo template overlay declaration');
assert.equal(overlayEntries[0].$['tools:node'], 'remove', 'unused overlay special permission must be removed');
assert.equal(manifest.$['xmlns:tools'], 'http://schemas.android.com/tools');
assert.ok(manifest['uses-permission'].some((permission) => permission.$?.['android:name'] === 'android.permission.CAMERA' && !permission.$?.['tools:node']), 'camera runtime permission must be preserved');

// Embedded-only runtime: no external Termux package visibility, RUN_COMMAND permission, or callback machinery.
for (const token of ['com.termux.permission.RUN_COMMAND', 'QUERY_ALL_PACKAGES']) {
  assert.ok(!pluginSource.includes(token) && !configSource.includes(token), `external runtime integration must be absent: ${token}`);
}
assert.match(bridge, /runEmbeddedTermuxCommand/);
assert.match(bridge, /EMBEDDED_EXEC_UNAVAILABLE/);
assert.match(read('lib/private-workspace-policy.ts'), /AI_BUILDER_WORKSPACE_ROOT/);
assert.match(read('plugins/withTermuxBridge.js'), /AIBuilderTermux/);
for (const token of ['Intent.ACTION_OPEN_DOCUMENT_TREE', 'takePersistableUriPermission', 'FileProvider.getUriForFile']) {
  if (!pluginSource.includes(token)) throw new Error(`MISSING_SCOPED_FILE_FLOW ${token}`);
}
for (const token of ['Intent.ACTION_OPEN_DOCUMENT', 'Intent.ACTION_CREATE_DOCUMENT', 'takePersistableUriPermission', 'contentResolver.openOutputStream']) {
  if (!githubPluginSource.includes(token)) throw new Error(`MISSING_GITHUB_SAF_FLOW ${token}`);
}
if (!pluginSource.includes('"android:exported": "false"') || !pluginSource.includes('"android:grantUriPermissions": "true"')) {
  throw new Error('UNSAFE_FILE_PROVIDER_FLAGS');
}

for (const token of ['hasAllFilesAccess', 'openAllFilesAccessSettings', 'all_files_access_missing']) {
  if (bridge.includes(token) || context.includes(token)) {
    throw new Error(`LEGACY_ALL_FILES_FLOW ${token}`);
  }
}
if (/PermissionsAndroid\.request\([\s\S]{0,120}com\.termux\.permission\.RUN_COMMAND/.test(bridge)) {
  throw new Error('RESTRICTED_RUN_COMMAND_MUST_NOT_USE_RUNTIME_PERMISSION_REQUEST');
}
assert.match(bridge, /export async function openRunCommandPermissionSettings\(\): Promise<boolean> \{[\s\S]*?return false;\s*\}/, 'there is no external permission/settings flow in embedded mode');

if (/ensureStoragePermission|WRITE_EXTERNAL_STORAGE/.test(settings)) {
  throw new Error('LEGACY_STORAGE_PERMISSION_FLOW_IN_SETTINGS');
}
if (/requestMediaLibraryPermissionsAsync|getMediaLibraryPermissionsAsync/.test(chat)) {
  throw new Error('DIRECT_MEDIA_LIBRARY_PERMISSION_REQUEST');
}

for (const token of ['MANAGE_EXTERNAL_STORAGE`: **declared for the experimental test/sideload flow; user enablement required**', 'broad shared-storage access; it is not a path sandbox', 'Google Play restricts this permission', 'READ_MEDIA_IMAGES/VIDEO/AUDIO` and `READ_MEDIA_VISUAL_USER_SELECTED`: **not requested**', 'ACTION_OPEN_DOCUMENT_TREE', 'PendingIntent', 'REQUEST_INSTALL_PACKAGES', 'termux-setup-storage', 'SYSTEM_ALERT_WINDOW']) {
  if (!policy.includes(token)) throw new Error(`POLICY_DOC_MISSING ${token}`);
}
if (/READ_MEDIA_IMAGES\/VIDEO\/AUDIO: retained/i.test(policy)) throw new Error('STALE_MEDIA_PERMISSION_POLICY');
const normalizedPolicy = policy.toLowerCase();
if (!normalizedPolicy.includes('the pinned `expo-image-picker` and `expo-file-system` android library manifests both declare these legacy permissions') || !normalizedPolicy.includes('tools:node="remove"')) {
  throw new Error('POLICY_DOC_MISSING_LEGACY_IMAGE_PICKER_REMOVAL');
}

console.log('AIB_STORAGE_PERMISSION_SELFTEST_OK mergedLegacyPermissions=removed duplicates=2 scopedPickers=verified private_workspace=verified no_external_permission_or_query=1 noUnusedOverlay=1');
