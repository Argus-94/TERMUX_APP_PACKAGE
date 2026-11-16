#!/usr/bin/env node
/**
 * Hashline file IO + LeanCTX-inspired read modes (signatures/map/density).
 * Used by fs.read / fs.hashline agent tools inside Termux project workdir.
 */
import fs from 'node:fs';
import crypto from 'node:crypto';

function hash(lineNo, text) {
  return crypto.createHash('sha256').update(`${lineNo}:${text}`).digest('hex').slice(0, 8).toUpperCase();
}
function usage() {
  console.error(
    'Usage: read <file> [start] [end] | read-mode <file> <mode> [density] | replace ... | replace-range ... | create <file> <base64> | delete <file> <SHA256>',
  );
  process.exit(2);
}
function requireParent(f) {
  return f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '.';
}
function fileSha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

const [cmd, file, ...args] = process.argv.slice(2);
if (!cmd || !file) usage();

if (cmd === 'create') {
  if (fs.existsSync(file)) {
    console.error('FILE_EXISTS');
    process.exit(4);
  }
  const data = Buffer.from(args[0] || '', 'base64');
  fs.mkdirSync(requireParent(file), { recursive: true });
  fs.writeFileSync(file, data);
  console.log(`CREATE_OK ${file}`);
  process.exit(0);
}

const rawContent = fs.readFileSync(file);
const content = rawContent.toString('utf8');
const validUtf8 = Buffer.from(content, 'utf8').equals(rawContent);
const eolTokens = content.match(/\r\n|\n|\r/g) || [];
const eolKinds = new Set(eolTokens);
const lineEnding = eolKinds.size === 1 ? eolTokens[0] : '\n';
const lines = content.split(/\r\n|\n|\r/);

function writeTextMutation() {
  if (!validUtf8) {
    console.error('HASHLINE_INVALID_UTF8');
    process.exit(5);
  }
  if (eolKinds.size > 1) {
    console.error('HASHLINE_MIXED_LINE_ENDINGS');
    process.exit(5);
  }
  fs.writeFileSync(file, lines.join(lineEnding));
}

if (cmd === 'delete') {
  const expected = (args[0] || '').toLowerCase();
  if (!expected) usage();
  const actual = fileSha256(file);
  if (actual !== expected) {
    console.error(`HASH_STALE expected=${expected} actual=${actual}`);
    process.exit(3);
  }
  fs.unlinkSync(file);
  console.log(`DELETE_OK ${file}`);
  process.exit(0);
}

if (cmd === 'read') {
  const start = Math.max(1, Number(args[0] || 1));
  const end = Math.min(lines.length, Number(args[1] || lines.length));
  for (let i = start; i <= end; i++) console.log(`${i}|${hash(i, lines[i - 1])}|${lines[i - 1]}`);
  process.exit(0);
}

if (cmd === 'read-mode') {
  const mode = (args[0] || 'full').toLowerCase();
  const density = Math.min(0.9, Math.max(0.15, Number(args[1] || 0.4)));
  if (mode === 'full') {
    for (let i = 1; i <= lines.length; i++) console.log(`${i}|${hash(i, lines[i - 1])}|${lines[i - 1]}`);
    process.exit(0);
  }
  if (mode === 'signatures') {
    const out = [];
    for (let i = 0; i < lines.length && out.length < 80; i++) {
      const t = lines[i].trim();
      if (!t || t.startsWith('//') || t.startsWith('#') || t.startsWith('*')) continue;
      if (
        /^(export\s+)?(async\s+)?(public|private|protected|internal|open|override|fun|function|class|interface|object|enum|type|const|let|var|def|fn|pub|struct|impl|package|import|from)\b/.test(
          t,
        ) ||
        t.startsWith('@')
      ) {
        out.push(`${i + 1}|${t.slice(0, 200)}`);
      }
    }
    if (!out.length) {
      for (let i = 0; i < lines.length && out.length < 40; i++) {
        const t = lines[i].trim();
        if (t) out.push(`${i + 1}|${t.slice(0, 160)}`);
      }
    }
    console.log(out.join('\n'));
    process.exit(0);
  }
  if (mode === 'map') {
    const imports = [];
    const exports = [];
    const defs = [];
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].trim();
      if (/^(import|from|package)\b/.test(t)) imports.push(t.slice(0, 120));
      if (/^export\b/.test(t) || /\bexport\s+(default\s+)?(class|function|const|async)/.test(t))
        exports.push(`${i + 1}:${t.slice(0, 100)}`);
      if (
        /^(export\s+)?(async\s+)?(function|class|interface|fun|def|fn|struct|impl)\b/.test(t) ||
        /^(public|private|protected)\s+(static\s+)?(class|interface|fun|void|int|String)/.test(t)
      ) {
        defs.push(`${i + 1}:${t.slice(0, 120)}`);
      }
    }
    console.log(`MAP ${file} (${lines.length}L)`);
    if (imports.length) console.log(`imports(${imports.length}): ${imports.slice(0, 12).join(' | ')}`);
    if (exports.length) console.log('exports:\n  ' + exports.slice(0, 20).join('\n  '));
    if (defs.length) console.log('defs:\n  ' + defs.slice(0, 30).join('\n  '));
    process.exit(0);
  }
  if (mode === 'density') {
    const scored = lines.map((line, idx) => {
      const t = line.trim();
      const unique = new Set(t).size;
      const score =
        (t.length ? unique / t.length : 0) * 2 +
        (/function|class|error|fail|TODO|FIXME|export|import|return|throw|catch|async|await|fun |def /.test(t)
          ? 0.5
          : 0) -
        (t.length < 3 || /^[\s{}\[\]();,]*$/.test(t) ? 1 : 0);
      return { idx, line, score };
    });
    scored.sort((a, b) => b.score - a.score);
    const keep = Math.max(8, Math.floor(lines.length * density));
    const selected = scored.slice(0, keep).sort((a, b) => a.idx - b.idx);
    for (const s of selected) console.log(`${s.idx + 1}|${s.line}`);
    process.exit(0);
  }
  // unknown mode → full
  for (let i = 1; i <= lines.length; i++) console.log(`${i}|${hash(i, lines[i - 1])}|${lines[i - 1]}`);
  process.exit(0);
}

if (cmd === 'replace') {
  const line = Number(args[0]);
  const expected = (args[1] || '').toUpperCase();
  const replacement = args.slice(2).join(' ');
  if (!line || !expected) usage();
  const actual = hash(line, lines[line - 1] ?? '');
  if (actual !== expected) {
    console.error(`HASHLINE_STALE expected=${expected} actual=${actual} line=${line}`);
    process.exit(3);
  }
  lines[line - 1] = replacement;
  writeTextMutation();
  console.log(`HASHLINE_OK ${file}#${line} ${actual}`);
  process.exit(0);
}

if (cmd === 'replace-range') {
  const start = Number(args[0]);
  const end = Number(args[1]);
  const hs = (args[2] || '').toUpperCase();
  const he = (args[3] || '').toUpperCase();
  const replacement = args.slice(4).join(' ');
  if (!start || !end || !hs || !he) usage();
  const as = hash(start, lines[start - 1] ?? '');
  const ae = hash(end, lines[end - 1] ?? '');
  if (as !== hs || ae !== he) {
    console.error(`HASHLINE_STALE start=${as} end=${ae}`);
    process.exit(3);
  }
  lines.splice(start - 1, end - start + 1, ...replacement.split('\\n'));
  writeTextMutation();
  console.log(`HASHLINE_OK ${file}#${start}-${end}`);
  process.exit(0);
}

usage();
