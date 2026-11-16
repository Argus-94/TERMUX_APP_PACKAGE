import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const packs = fs.readFileSync(path.join(root, 'lib/termux-packs.ts'), 'utf8');
const hook = fs.readFileSync(path.join(root, 'hooks/useAppSettings.ts'), 'utf8');
const settings = fs.readFileSync(path.join(root, 'app/settings.tsx'), 'utf8');
const must = [
  ["tool packs fail closed when no verified artifact is shipped", /ALL_TOOL_PACKS:\s*TermuxToolPack\[\] = \[\]/],
  ["Python installs fail closed", /PIP_DISABLED_STEP[\s\S]{0,200}package resolution is not integrity-pinned/],
  ["Termux command guide exists", /TERMUX_COMMANDS|pkg update -y/],
  ["Termux settings exposes readiness", /checkTermuxReadiness|termuxNotReady|Termux On/],
];
for (const [name, re] of must) {
  if (!re.test(packs + '\n' + hook + '\n' + settings)) throw new Error(`missing: ${name}`);
}
if (/if\s*\(isNdk\s*&&\s*dl\.sha256\)/.test(packs)) throw new Error('NDK download fallback must be removed');
console.log('AIB_TERMUX_INSTALLER_SELFTEST_OK current_architecture=verified_tool_packs_fail_closed');
