import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const required = [
  'core/linux/LinuxRuntime.ts',
  'core/RuntimeFacade.ts',
  'app/runtime.tsx',
];
for (const rel of required) {
  if (!fs.existsSync(path.join(root, rel))) throw new Error(`missing:${rel}`);
}
const source = fs.readFileSync(path.join(root, 'core/linux/LinuxRuntime.ts'), 'utf8');
for (const token of [
  'proot-distro', 'ALLOWED_COMMANDS', 'async status(', 'async bootstrap(', 'async exec(',
  '/workspace', 'timeoutMs', 'shellQuote', 'return ALLOWED_COMMANDS.has(command.trim())', 'home.workspace', '--bind',
]) {
  if (!source.includes(token)) throw new Error(`linux-runtime-contract:${token}`);
}
const facade = fs.readFileSync(path.join(root, 'core/RuntimeFacade.ts'), 'utf8');
for (const token of ['readonly linux: LinuxRuntime', 'linuxStatus(', 'linuxExec(', 'linuxBootstrap(']) {
  if (!facade.includes(token)) throw new Error(`facade-contract:${token}`);
}
const ui = fs.readFileSync(path.join(root, 'app/runtime.tsx'), 'utf8');
const runtimeI18n = fs.readFileSync(path.join(root, 'lib/runtime-i18n.ts'), 'utf8');
for (const token of ['linuxTermux', 'checkLinux', 'unameTest', 'bootstrapDebian']) {
  if (!runtimeI18n.includes(`${token}:`)) throw new Error(`runtime-i18n-contract:${token}`);
  if (!ui.includes(`rt("${token}")`)) throw new Error(`ui-contract:${token}`);
}
console.log('AIB_PHASE26_LINUX_RUNTIME_SELFTEST_OK');
