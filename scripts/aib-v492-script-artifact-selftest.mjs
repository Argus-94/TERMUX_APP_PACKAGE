import fs from 'node:fs';
import vm from 'node:vm';
const src = fs.readFileSync('lib/script-templates.ts', 'utf8');
function extract(name, next) {
  const start = src.indexOf(`export function ${name}(`);
  const end = next ? src.indexOf(`export function ${next}(`, start) : src.indexOf('\n}', start) + 2;
  if (start < 0 || end < 0) throw new Error(`missing production helper ${name}`);
  return src.slice(start, end).replace('export function', 'function');
}
const blocks = [
  'const MAX_RUN_HISTORY = 20;',
  src.slice(src.indexOf('const APK_WORKSPACE_ROOT'), src.indexOf('export function tailLog'))
    .replace('export function', 'function'),
];
const js = blocks.join('\n').replace(/\(candidate: unknown\): candidate is string/g, '(candidate)').replace(/\(value: unknown\): RunHistoryEntry\[\]/g, '(value)').replace(/export function /g, 'function ').replace('(value as RunHistoryEntry[])', 'value').replace(/\(log: string\): string \| undefined/g, '(log)').replace(/\(candidate: unknown\)/g, '(candidate)').replace(/\(value: unknown\)/g, '(value)');
const ready = js + '\nthis.api={isValidApkCandidatePath,extractApkPathFromLog,sanitizeRunHistory};';
const ctx = {}; vm.runInNewContext(ready, ctx);
const {isValidApkCandidatePath: valid, extractApkPathFromLog: parse, sanitizeRunHistory: clean}=ctx.api;
const root='/storage/emulated/0/AIBuilderTermux/build/app.apk';
if (!valid(root) || valid('/storage/emulated/0/AIBuilderTermux-old/a.apk') || valid('/data/data/com.termux/files/home/a.apk') || valid('/storage/emulated/0/AIBuilderTermux/../outside.apk')) throw Error('path boundary');
if (parse(`APK_PATH=${root}`)!==root || parse('APK_PATH=/data/data/com.termux/files/home/legacy.apk')!==undefined || parse('APK=/tmp/foreign.apk')!==undefined) throw Error('parser boundary');
const rows=clean([{ok:false,apkPath:root},{ok:true,apkPath:'/data/data/com.termux/x.apk'},{ok:true,apkPath:root}]);
if (rows[0].apkPath || rows[1].apkPath || rows[2].apkPath!==root) throw Error('failed/stale history filter');
const runner=fs.readFileSync('app/script-runner.tsx','utf8');
if (!/const started = await native\.installApk\(uri\)/.test(runner) || !/Android did not start the install request/.test(runner) || !/entry\.ok && isValidApkCandidatePath/.test(runner)) throw Error('install/history production wiring');
console.log('AIB_V492_SCRIPT_ARTIFACT_SELFTEST_OK false/rejected/true install result wiring; failed/stale history filtered; candidate path boundary enforced (lexical validation only, not current-build proof)');
