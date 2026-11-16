import fs from 'node:fs';
import vm from 'node:vm';

const src = fs.readFileSync('lib/termux-agent.ts', 'utf8');
if (!src.includes('function apkEnvPrefix')) throw new Error('apkEnvPrefix missing');
if (!src.includes("isLinuxProotBackend()")) throw new Error('backend branch missing');
if (!src.includes("/usr/lib/jvm/default-java")) throw new Error('linux java candidate missing');
if (!src.includes("$HOME/Android/Sdk")) throw new Error('linux sdk candidate missing');
if (!src.includes('APK_BUILD_BACKEND=')) throw new Error('backend marker missing');
if (!src.includes('APK_BUILD_JAVA_HOME=')) throw new Error('java marker missing');
if (!src.includes('APK_BUILD_SDK=')) throw new Error('sdk marker missing');
if (!src.includes('APK_BUILD_NDK=')) throw new Error('ndk marker missing');

const agent = fs.readFileSync('lib/agent-engine.ts', 'utf8');
if (!agent.includes('opts?.forceFresh && requestedRoot')) throw new Error('fresh root selection is missing');
if (!agent.includes('AI_BUILDER_SHARED_ROOT') || !agent.includes('/projects/${safe}-${unique}')) throw new Error('create path is not dynamically namespaced under the shared projects root');
if (!agent.includes('isWithinSharedAppRoot(requestedRoot)')) throw new Error('requested create path is not checked against the shared app root');
if (!agent.includes('ROOT_CANON=$(realpath -m -- "$ROOT")') || !agent.includes('PROJECT_PATH_OUTSIDE_SHARED_ROOT')) throw new Error('resolved project path is not checked against the canonical shared root');

console.log('AIB_BACKEND_BUILD_ENV_SELFTEST_OK linux_sdk_java_ndk=dynamic create_root=dynamic');
