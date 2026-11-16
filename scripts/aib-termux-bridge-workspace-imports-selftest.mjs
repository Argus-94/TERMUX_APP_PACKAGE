import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'plugins/withTermuxBridge.js'), 'utf8');
const generatedKotlin = source.slice(source.indexOf('function moduleKotlin('), source.indexOf('\nfunction packageKotlin('));
for (const declaration of [
  'import android.os.ParcelFileDescriptor',
  'import android.system.Os',
  'import android.system.OsConstants',
]) {
  assert.ok(generatedKotlin.includes(declaration), `generated bridge must declare ${declaration}`);
}
for (const reference of ['ParcelFileDescriptor.dup(', 'Os.open(', 'Os.lstat(', 'OsConstants.O_NOFOLLOW']) {
  assert.ok(generatedKotlin.includes(reference), `workspace descriptor implementation must retain ${reference}`);
}
console.log('PASS: generated Termux bridge declares Android descriptor and system-call imports');
