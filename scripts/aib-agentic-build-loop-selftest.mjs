import fs from 'node:fs';
const required = [
  ['core/workspace/AgenticBuildLoop.ts', ['runAgenticBuildLoop','AgenticBuildLoopRequest','MAX_CODING_ITERATIONS']],
  ['core/RuntimeFacade.ts', ['runAgenticBuildLoop','agentic-build-loop']],
  ['lib/autonomous-device-loop.ts', ['runAutonomousDeviceDevelopmentLoop']],
  ['core/workspace/AICodingAgent.ts', ['AICodingAgent']],
  ['core/workspace/LLMCodingBrain.ts', ['LLMCodingBrain']],
];
for (const [file, tokens] of required) {
  const text=fs.readFileSync(file,'utf8');
  for (const token of tokens) if (!text.includes(token)) throw new Error(`missing ${token} in ${file}`);
}
const text=fs.readFileSync('core/workspace/AgenticBuildLoop.ts','utf8');
if (!text.includes('maxIterations: 1') || !text.includes('maxBuildAttempts') || !text.includes('maxDeviceSteps')) throw new Error('bounded controls missing');
console.log('AIB_PHASE32_AGENTIC_BUILD_LOOP_SELFTEST_OK');
