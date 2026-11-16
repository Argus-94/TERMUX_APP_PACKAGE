#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const runtime = fs.readFileSync(path.join(root, 'app/runtime.tsx'), 'utf8');
const menu = fs.readFileSync(path.join(root, 'components/PackagesRightMenu.tsx'), 'utf8');

// Pin the production callback's ordering/guards (source-only; no production edits).
const checkStart = runtime.indexOf('const runReadOnlyEnvironmentCheck = useCallback');
const checkEnd = runtime.indexOf('\n  const runEnvironmentAction', checkStart);
assert.ok(checkStart >= 0 && checkEnd > checkStart, 'readiness callback boundaries');
const check = runtime.slice(checkStart, checkEnd);
assert.match(check, /const generation = \+\+environmentStatusGenerationRef\.current/);
assert.match(check, /if \(generation !== environmentStatusGenerationRef\.current\) return;[\s\S]{0,150}if \(backend === "termux"\)/);
assert.match(check, /if \(generation !== environmentStatusGenerationRef\.current\) return;\s*setTermuxReady\(ready\.ready\)/);
assert.match(check, /if \(generation !== environmentStatusGenerationRef\.current\) return;\s*setRuntimeReadiness\(result\)/);
assert.match(check, /finally \{[\s\S]*?runtimeEnvironmentActionRef\.current = false;[\s\S]*?if \(generation === environmentStatusGenerationRef\.current\) \{\s*setLinuxBusy\(false\)/);
assert.match(runtime, /const selectEnvironment = useCallback\(async \(backend: AgentShellBackend\) => \{[\s\S]*?await runEnvironmentAction\(backend, true\)/);
assert.match(runtime, /if \(persistSelection\) \{\s*await runReadOnlyEnvironmentCheck\(backend, true\)/);

// Controlled deferred-reply harness: exercises the guarded state-commit protocol
// represented by the exact callback locks above (not a device/native readiness test).
let generation = 0;
let state = { backend: 'ubuntu-proot', readiness: null, termuxReady: null, busy: false };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function checkEnvironment(backend, reply) {
  const mine = ++generation;
  state = { ...state, backend, busy: true, readiness: null, ...(backend === 'termux' ? { termuxReady: null } : {}) };
  const value = await reply;
  if (mine !== generation) return;
  if (backend === 'termux') state = { ...state, termuxReady: value.ready, busy: false };
  else state = { ...state, readiness: value, busy: false };
}
const oldUbuntu = deferred();
const newTermux = deferred();
const oldRun = checkEnvironment('ubuntu-proot', oldUbuntu.promise);
const newRun = checkEnvironment('termux', newTermux.promise);
newTermux.resolve({ ready: true });
await newRun;
assert.deepEqual(state, { backend: 'termux', readiness: null, termuxReady: true, busy: false }, 'Ubuntu missing -> Termux ready is selected and committed');
oldUbuntu.resolve({ status: 'missing', ready: false });
await oldRun;
assert.deepEqual(state, { backend: 'termux', readiness: null, termuxReady: true, busy: false }, 'late Ubuntu response cannot overwrite current Termux state');

// Sidebar scan locks, expansion/collapse and target identity evidence.
assert.match(menu, /const selectedBackend = RIGHT_PACKAGE_MENU_BACKEND/);
assert.match(menu, /const isCurrentTarget = \(\) => visibleRef\.current\s*&& scanGenerationRef\.current === scanGeneration\s*&& expandedRef\.current\[section\]\s*&& sectionExpansionGenerationRef\.current\[section\] === sectionGeneration/);
assert.match(menu, /if \(!isCurrentTarget\(\)\) return;\s*activeScanGenerationRef\.current = scanGeneration/);
assert.match(menu, /if \(!isCurrentTarget\(\)\) return;\s*if \(check\.status === "error"\)/);
assert.match(menu, /const opening = !expandedRef\.current\[section\][\s\S]*?sectionExpansionGenerationRef\.current\[section\] \+= 1/);
assert.match(menu, /if \(!opening\) \{\s*setScanningSection[\s\S]*?return;/);
assert.match(menu, /if \(section !== "custom" \|\| customToolsReadyRef\.current\) \{\s*void verifySection\(section\)/);

// Dynamic stale-scan simulation uses same dimensions guarded by the source predicate.
let scan = { visible: true, menuGeneration: 3, expanded: true, sectionGeneration: 8, states: {} };
const captured = { menuGeneration: scan.menuGeneration, sectionGeneration: scan.sectionGeneration };
const currentScanTarget = () => scan.visible && scan.menuGeneration === captured.menuGeneration && scan.expanded && scan.sectionGeneration === captured.sectionGeneration;
const scanReply = deferred();
const scanRun = (async () => { const result = await scanReply.promise; if (currentScanTarget()) scan.states.pkg = result; })();
scan.expanded = false; scan.sectionGeneration++;
scanReply.resolve({ status: 'installed' });
await scanRun;
assert.deepEqual(scan.states, {}, 'collapsed section rejects a delayed scan result');
console.log('AIB_V495_RUNTIME_SELECTION_SELFTEST_OK deferred_readiness=2 stale_ubuntu=blocked sidebar_collapse=blocked source_guards=verified (harness is modeled, not a mounted React/device test)');
