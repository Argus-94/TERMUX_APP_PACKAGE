#!/usr/bin/env node
import assert from 'node:assert/strict';
import { classifyBuildRepairTarget, buildRepairTargetInstruction } from '../lib/build-repair-target.ts';
assert.equal(classifyBuildRepairTarget('bash: line 17: syntax error near unexpected token `fi`'), 'script');
assert.equal(classifyBuildRepairTarget('Could not find Android SDK. ANDROID_HOME not set'), 'environment');
assert.equal(classifyBuildRepairTarget("Execution failed for task ':app:compileDebugKotlin'\ne: file:///app/src/Main.kt:12: unresolved reference"), 'project');
assert.equal(classifyBuildRepairTarget('No space left on device\nExecution failed for task :app:compileDebugKotlin'), 'mixed');
assert.equal(classifyBuildRepairTarget(''), 'unknown');
assert.match(buildRepairTargetInstruction('script', '/tmp/build-apk-demo.sh'), /bash -n/);
assert.match(buildRepairTargetInstruction('project'), /Keep the generated runner unchanged/);
console.log('AIB_BUILD_REPAIR_TARGET_SELFTEST_OK script/project/environment/mixed/unknown');
