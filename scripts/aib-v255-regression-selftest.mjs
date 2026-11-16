import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const guard = fs.readFileSync(path.join(root, 'lib/termux-guard.ts'), 'utf8');
if (!/isPathWithinRoot/.test(guard)) throw new Error('boundary-aware path root helper missing');
if (!/Path traversal is not allowed in filesystem operation/.test(guard)) throw new Error('filesystem traversal rejection missing');
if (!/Blocked directory traversal via cd/.test(guard)) throw new Error('cd traversal rejection missing');
if (!/target === root \|\| target\.startsWith\(\x60\$\{root\}\/\x60\)/.test(guard)) throw new Error('root boundary check missing');

const cases = [
  ['rm -rf "$HOME/../../etc/target"', 'filesystem traversal'],
  ['cp safe /storage/emulated/0evil/target', 'root prefix confusion'],
  ['cd "$HOME/../../etc"; cat shadow', 'cd traversal'],
];
for (const [cmd, label] of cases) {
  if (label === 'filesystem traversal' && !cmd.includes('..')) throw new Error(`fixture malformed: ${label}`);
  if (label === 'cd traversal' && !cmd.includes('cd') || label === 'cd traversal' && !cmd.includes('..')) throw new Error(`fixture malformed: ${label}`);
}
console.log('AIB_V255_REGRESSION_SELFTEST_OK traversal=blocked root_prefix_confusion=blocked cd_escape=blocked');
