import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import { typescript as ts } from './load-typescript.mjs';
export function loadBalanceDiagnostic() {
  const load = name => {
    const filename = path.resolve('lib', name + '.ts');
    const mod = new Module(filename); mod.filename = filename;
    mod.require = dependency => {
      if (dependency === './manus-credits') return load('manus-credits');
      throw new Error('Unexpected diagnostic dependency');
    };
    mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, filename);
    return mod.exports;
  };
  return load('manus-balance-diagnostic');
}
