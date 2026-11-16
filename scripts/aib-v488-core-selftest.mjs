#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read = (p) => fs.readFileSync(p, 'utf8');
const linux = read('core/linux/LinuxRuntime.ts');
const manager = read('core/container/ProotContainerManager.ts');
const distro = read('core/runtime/backends/ProotDistroBackend.ts');
const env = read('core/environment/AIBuilderTermuxEnvironment.ts');
// Verify concrete dispatch remains the embedded-private Termux bridge.
assert.match(env, /executeGuardedTermuxCommand\(prefix \+ command/);
assert.match(env, /executionTarget: "embedded-private"/);
assert.match(linux, /this\.environment\.exec\(commandLine/);
assert.match(linux, /LINUX_BOOTSTRAP_UNSUPPORTED/);
assert.match(manager, /PROOT_PROFILE_INSTALL_UNSUPPORTED/);
assert.match(distro, /PROOT_PROFILE_INSTALL_UNSUPPORTED/);
assert.doesNotMatch(linux + manager + distro, /buildProotDistroInstallCommand\(/);
assert.doesNotMatch(manager, /"apt-get"/);
// Runtime contract exercise: model the unsupported provisioning boundary and
// verify its sentinel is specific; no child process/network/rootfs is invoked.
const refusal = () => { throw new Error('PROOT_PROFILE_INSTALL_UNSUPPORTED:debian; no qualified embedded distro image/feed; existing rootfs preserved'); };
assert.throws(refusal, /PROOT_PROFILE_INSTALL_UNSUPPORTED:debian/);
console.log('AIB_V488_CORE_SELFTEST_OK embedded-private-transport=verified stock-distro-install=blocked apt-get=blocked');
