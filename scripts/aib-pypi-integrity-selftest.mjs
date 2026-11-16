import fs from 'node:fs';
import assert from 'node:assert/strict';

const src = fs.readFileSync('lib/termux-packs.ts', 'utf8');
const reverseStart = src.indexOf('export const REVERSE_PACK');
const allStart = src.indexOf('export const ALL_TOOL_PACKS');
const reverse = reverseStart >= 0 && allStart > reverseStart ? src.slice(reverseStart, allStart) : src;
const installSection = reverse.includes('installSteps:')
  ? reverse.slice(reverse.indexOf('installSteps:'), reverse.indexOf('removeSteps:') > 0 ? reverse.indexOf('removeSteps:') : reverse.length)
  : reverse;

if (/kind:\s*"pip"\s*,\s*primary:/i.test(installSection)) throw new Error('AIB_PYPI_UNPINNED_INSTALL_PRESENT');
if (/python -m pip install/i.test(installSection)) throw new Error('AIB_PYPI_DIRECT_INSTALL_PRESENT');
if (/pip install --upgrade/i.test(src)) throw new Error('AIB_PYPI_BUILD_COMMAND_PRESENT');
if (/r2pm\s+-[Ui]/i.test(installSection)) throw new Error('AIB_R2PM_UNPINNED_INSTALL_PRESENT');
// Fail-closed: either explicit PIP_DISABLED_STEP in install steps, or packs emptied with policy constant present
if (!/PIP_DISABLED_STEP/.test(src)) throw new Error('AIB_PYPI_FAIL_CLOSED_MISSING');
if (!/package resolution is not integrity-pinned/i.test(src)) throw new Error('AIB_PYPI_POLICY_TEXT_MISSING');

// The reverse-package menu is a separate Termux command path from termux-packs;
// it must enforce the same integrity contract rather than bypassing the gate.
const reverseSource = fs.readFileSync('lib/reverse-packages.ts', 'utf8');
const disabledReverseIds = ['smali', 'androguard', 'apkleaks', 'objection', 'mitmproxy'];
for (const id of disabledReverseIds) {
  const idAt = reverseSource.indexOf(`id: "${id}"`);
  assert.notEqual(idAt, -1, `reverse package missing: ${id}`);
  const end = reverseSource.indexOf('\n  },', idAt);
  assert.ok(end > idAt, `reverse package block missing for ${id}`);
  const entry = reverseSource.slice(idAt, end);
  assert.match(entry, /\bblocked:\s*true/, `${id} must remain disabled until verified artifacts are available`);
  assert.match(entry, /blockedReason:\s*"[^"]*(?:SHA-256|integrity)[^"]*"/i, `${id} must explain the integrity blocker`);
  const installLine = entry.match(/^\s*installCmd:\s*(.+)$/m)?.[1] || '';
  assert.match(installLine, /(?:SMALI|PYPI)_INSTALL_DISABLED_(?:SHA256|INTEGRITY_PIN)_REQUIRED/,
    `${id} must use an inert fail-closed install command`);
  assert.doesNotMatch(installLine, /https?:\/\/|\bpip\s+install\b|python\s+-m\s+pip\s+install|--upgrade|\bcurl\b|\bwget\b/i,
    `${id} must not retain an unverified installer command`);
}
const blockGate = reverseSource.indexOf('if (def.blocked)');
const installPath = reverseSource.indexOf('runPackageCommand(def.installCmd', blockGate);
assert.ok(blockGate >= 0 && installPath > blockGate, 'reverse installer must reject blocked entries before reaching the backend command path');

console.log('AIB_PYPI_INTEGRITY_SELFTEST_OK tool_packs=pip,r2pm:blocked reverse_tools=5:fail_closed');
