import fs from 'node:fs';

const agent = fs.readFileSync('lib/termux-agent.ts', 'utf8');
const build = fs.readFileSync('lib/build-loop.ts', 'utf8');
const runner = fs.readFileSync('lib/script-runner-agent.ts', 'utf8');
const sources = [agent, build, runner];

for (const src of sources) {
  if (/sed -i[^\n]*gradle\/wrapper\/gradle-wrapper\.properties|>\s*gradle\/wrapper\/gradle-wrapper\.properties|distributionUrl=.*gradle-\d/i.test(src)) {
    throw new Error('AIB_PROJECT_GRADLE_WRAPPER_MUTATION_PRESENT');
  }
}
if (!agent.includes('project_gradle_wrapper_properties=read-only') || !build.includes('gradle/wrapper/gradle-wrapper.jar')) {
  throw new Error('AIB_GRADLE_WRAPPER_READONLY_GUARD_MISSING');
}
if (!runner.includes('project wrapper properties were left untouched')) {
  throw new Error('AIB_WRAPPER_RECOVERY_PRESERVE_MISSING');
}
console.log('AIB_GRADLE_WRAPPER_INTEGRITY_SELFTEST_OK project_wrapper_preserved=true runtime_only_recovery=true');
