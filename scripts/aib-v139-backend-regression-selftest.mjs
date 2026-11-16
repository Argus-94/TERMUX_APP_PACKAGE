#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const backend = read('lib/agent-shell-backend.ts');
const executor = read('lib/termux-executor.ts');
const packageBackend = read('lib/package-backend.ts');
const runtimeRouting = read('lib/runtime-command-routing.ts');
const termuxEnvironment = read('core/environment/AIBuilderTermuxEnvironment.ts');
const userspace = read('core/runtime/AibUserspaceRuntime.ts');
const prootBackend = read('core/runtime/backends/ProotDistroBackend.ts');
const facade = read('core/RuntimeFacade.ts');
const agent = read('lib/script-runner-agent.ts');
const task = read('lib/scripted-task-engine.ts');
const signing = read('lib/signing-tool.ts');
const menu = read('components/PackagesRightMenu.tsx');
const settings = read('app/settings.tsx');

if (!backend.includes('AIB_UBUNTU_ROOTFS_MISSING') || !backend.includes('AIB_DEBIAN_ROOTFS_MISSING')) throw new Error('LINUX_ROOTFS_GUARDS_MISSING');
if (!backend.includes('getAgentShellBackend = getBuildBackend')) throw new Error('AGENT_NOT_UNIFIED');
if (!executor.includes('wrapCommandForAgentShell')) throw new Error('EXECUTOR_NOT_BACKEND_WRAPPED');
if (!packageBackend.includes('adaptPackageCommand')) throw new Error('PACKAGE_ADAPTER_MISSING');
if (!packageBackend.includes('packageBackendTarget(selectedBackend, options.packageId)')) throw new Error('PACKAGE_TARGET_ROUTING_MISSING');
if (!packageBackend.includes('routeRuntimeCommand(selectedBackend, "package", options.packageId)')) throw new Error('PACKAGE_EXECUTION_ROUTE_MISSING');
if (!packageBackend.includes('hostTermux: executionBackend === "termux"')) throw new Error('HOST_BOOTSTRAP_MISSING');
if (!runtimeRouting.includes('purpose === "host" || purpose === "proot-distro"') || !runtimeRouting.includes('return "termux"')) throw new Error('PROOT_HOST_ROUTE_MISSING');
if (!termuxEnvironment.includes('hostTermux: true') || !termuxEnvironment.includes('backend: "termux"')) throw new Error('CORE_ENVIRONMENT_NOT_HOST_ROUTED');
if (!userspace.includes('prootProfileProvider') || !userspace.includes('this.prootBackend.setProfile(profile)')) throw new Error('USERSPACE_PROFILE_PROVIDER_MISSING');
if (!facade.includes('selected === "ubuntu-proot"') || !facade.includes('return "ubuntu"') || !facade.includes('selected === "ubuntu-proot"')) throw new Error('SELECTED_GUEST_PROFILE_NOT_MAPPED');
if (!prootBackend.includes('setProfile(profile: ProotProfile)')) throw new Error('PROOT_PROFILE_SETTER_MISSING');

for (const [name, src] of [['script-agent', agent], ['scripted-task', task], ['signing', signing]]) {
  if (/runShellCommand\(/.test(src)) throw new Error(`${name.toUpperCase()}_DIRECT_RUNSHELL_REMAINED`);
  if (!src.includes('executeGuardedTermuxCommand')) throw new Error(`${name.toUpperCase()}_GUARDED_EXECUTOR_MISSING`);
}
if (!agent.includes('adaptPackageCommand')) throw new Error('RECOVERY_PACKAGE_ADAPTER_MISSING');
if (!menu.includes('Проверка в выбранной среде') && !menu.includes('selected environment')) throw new Error('MENU_SELECTED_BACKEND_TEXT_MISSING');
if (!settings.includes('Единая среда сборки и агента') || !settings.includes('router.push("/runtime")')) throw new Error('SETTINGS_ENVIRONMENT_MIRROR_MISSING');
if (!settings.includes('source of truth')) throw new Error('SETTINGS_SINGLE_SOURCE_HINT_MISSING');

const compile = read('lib/compile-packages.ts');
const reverse = read('lib/reverse-packages.ts');
if (/ghfast\.top|ghproxy|mirror\.ghproxy|gh-proxy\.com|ghproxy\.net/.test(compile + reverse)) throw new Error('UNTRUSTED_PROXY_REMAINED');
if (!compile.includes('CMDLINE_SHA_MISMATCH') || !compile.includes('CMDLINE_SHA=') || !compile.includes('EXPECT_SHA')) throw new Error('CMDLINE_INTEGRITY_GUARD_MISSING');
if (!compile.includes('GRADLE_SHA_MISMATCH') || !compile.includes('GRADLE_PREREQUISITE_MISSING') || !compile.includes('EXPECT_SHA="f397b287023acdba1e9f6fc5ea72d22dd63669d59ed4a289a29b1a76eee151c6"')) throw new Error('GRADLE_INTEGRITY_GUARD_MISSING');
if (!compile.includes('NDK_SHA_MISMATCH') || !compile.includes('NDK_SHA256_TOOL_MISSING')) throw new Error('NDK_INTEGRITY_GUARD_MISSING');

console.log('AIB_V139_BACKEND_REGRESSION_SELFTEST_OK build_agent_unified=1 recovery_guarded=1 signing_guarded=1 ubuntu_rootfs_guard=1 package_adapter=1 integrity_fail_closed=1');
