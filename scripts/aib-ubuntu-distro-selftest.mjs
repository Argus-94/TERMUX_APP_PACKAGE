import fs from 'node:fs';
import path from 'node:path';
import { buildProotDistroRootfsCheckCommand } from '../lib/termux-bootstrap-install.ts';

const root = process.cwd();
const file = path.join(root, 'lib', 'ubuntu-distro.ts');
const ui = path.join(root, 'app', 'runtime.tsx');
const src = fs.readFileSync(file, 'utf8');
const screen = fs.readFileSync(ui, 'utf8');
const projection = fs.readFileSync(path.join(root, 'lib', 'runtime-environment-projection.ts'), 'utf8');
const preparationAction = fs.readFileSync(path.join(root, 'lib', 'runtime-environment-action.ts'), 'utf8');
const ubuntuCheckCommand = buildProotDistroRootfsCheckCommand('ubuntu');

const must = [
  'export async function exportUbuntu(',
  'export async function importUbuntu(',
  'export function defaultUbuntuExportPath(',
  'proot-distro backup ${PROFILE}',
  'buildProotDistroRestoreCommand(PROFILE, sourcePath)',
  'before.installed !== false',
  'shellQuoteData(safeDest)',
  'inspectTermuxProotDistro("ubuntu")',
];
for (const x of must) if (!src.includes(x)) throw new Error(`missing Ubuntu distro contract: ${x}`);
if (!ubuntuCheckCommand.includes('AIB_UBUNTU_ROOTFS_INSTALLED_LOGIN_FAILED')) throw new Error('missing Ubuntu installed-but-unhealthy state contract');
if (/rootfsPathExpr|tar -czf|rm -rf "\$TARGET"|proot-distro reset|proot-distro remove/.test(src)) throw new Error('Ubuntu distro flow still assumes or overwrites a guessed rootfs path');
for (const x of [
  'exportUbuntu, importUbuntu, defaultUbuntuExportPath',
  'onUbuntuExport', 'onUbuntuImport',
  'Экспорт / импорт Ubuntu', 'Импорт Ubuntu', 'Экспорт Ubuntu',
]) if (!screen.includes(x)) throw new Error(`missing Ubuntu UI contract: ${x}`);

if (!/environmentBackend === "ubuntu-proot"/.test(screen)) throw new Error('Ubuntu actions are not tied to active environment');
if (!projection.includes('check.status === "missing"')) throw new Error('Ubuntu install must remain limited to an explicit missing readiness result');
if (!screen.includes('canOfferRuntimePreparationAction(environmentBackend, selectedReadiness)')) throw new Error('Ubuntu Prepare action must remain available for unknown states so click-time preflight can give the safe diagnostic');
if (!preparationAction.includes('if (readiness.status !== "missing")')) throw new Error('Ubuntu preparation must block mutation unless its fresh read-only preflight confirms missing state');
if (!projection.includes('if (installed === true) return "login-unverified";')) throw new Error('Ubuntu installed-but-unhealthy must remain distinct from ready and unknown');
if (/onDebianExport\(\)/.test(screen) && !/environmentBackend === "ubuntu-proot" \? onUbuntuExport\(\) : onDebianExport\(\)/.test(screen)) {
  throw new Error('export action is not environment-aware');
}
console.log('AIB_UBUNTU_DISTRO_SELFTEST_OK export=1 import=guarded_restore ui=three_state environment_aware=1 tar_fallback=0');
