import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let ts = null;
try {
  ts = require('typescript');
} catch {
  try {
    const isWin = process.platform === 'win32';
    const tscPath = isWin
      ? execFileSync('where.exe', ['tsc'], { encoding: 'utf8' }).split(/\r?\n/)[0].trim()
      : execFileSync('bash', ['-lc', 'command -v tsc'], { encoding: 'utf8' }).trim();
    if (tscPath) {
      ts = require(path.join(path.dirname(tscPath), '..', 'lib', 'typescript.js'));
    }
  } catch {
    ts = null;
  }
}

const root = process.cwd();
const skip = new Set(['node_modules', '.git']);
const files = [];

function walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else files.push(full);
  }
}
walk(root);

const failures = [];
const tsFiles = files.filter((f) => /\.(ts|tsx)$/.test(f));
if (ts) {
  for (const file of tsFiles) {
    const source = fs.readFileSync(file, 'utf8');
    const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
    for (const diagnostic of sf.parseDiagnostics ?? []) {
      const pos = diagnostic.start ?? 0;
      const lc = ts.getLineAndCharacterOfPosition(sf, pos);
      failures.push(`${path.relative(root, file)}:${lc.line + 1}:${lc.character + 1} TS${diagnostic.code} ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`);
    }
  }
}

for (const file of files.filter((f) => /\.(js|jsx|mjs|cjs)$/.test(f))) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (error) {
    const detail = error?.stderr?.toString()?.trim() || error?.stdout?.toString()?.trim() || String(error);
    failures.push(`${path.relative(root, file)}: node --check failed: ${detail}`);
  }
}

for (const file of files.filter((f) => f.endsWith('.json'))) {
  try {
    JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    failures.push(`${path.relative(root, file)}: invalid JSON: ${error.message}`);
  }
}

const shellFiles = files.filter((f) => f.endsWith('.sh'));
const bashCmd = process.platform === 'win32'
  ? (fs.existsSync('C:\\Program Files\\Git\\bin\\bash.exe') ? 'C:\\Program Files\\Git\\bin\\bash.exe' : null)
  : 'bash';

if (bashCmd) {
  for (const file of shellFiles) {
    try {
      execFileSync(bashCmd, ['-n', file], { stdio: 'pipe' });
    } catch (error) {
      const detail = error?.stderr?.toString()?.trim() || error?.stdout?.toString()?.trim() || String(error);
      failures.push(`${path.relative(root, file)}: bash -n failed: ${detail}`);
    }
  }
}


// Always-on anti-pattern check (no typescript dependency) — CBE Metro SyntaxError class
for (const file of tsFiles) {
  const source = fs.readFileSync(file, 'utf8');
  const rel = path.relative(root, file);
  const lines = source.split(/\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*'/.test(line) && /require\('\$[A-Za-z_]/.test(line)) {
      failures.push(`${rel}:${i + 1}: nested require('$VAR) in single-quoted shell fragment (Metro SyntaxError)`);
    }
    if (/^\s*'/.test(line) && /catch\s*\(\s*e\s*\)\s*\{\s*''\s*\}/.test(line)) {
      failures.push(`${rel}:${i + 1}: catch(e){''} in single-quoted shell fragment (Metro SyntaxError)`);
    }
  }
}

if (failures.length) {
  console.error('AIB_FULL_SOURCE_SYNTAX_SELFTEST_FAIL');
  for (const failure of failures) console.error(failure);
  process.exit(1);
}

console.log(`AIB_FULL_SOURCE_SYNTAX_SELFTEST_OK ts=${tsFiles.length} js=${files.filter((f) => /\.(js|jsx|mjs|cjs)$/.test(f)).length} json=${files.filter((f) => f.endsWith('.json')).length} sh=${shellFiles.length}`);
