import fs from 'node:fs';
import path from 'node:path';
const root = process.cwd();
const source = fs.readFileSync(path.join(root, 'core/workspace/AICodingAgent.ts'), 'utf8');
const facade = fs.readFileSync(path.join(root, 'core/RuntimeFacade.ts'), 'utf8');
for (const token of ['AICodingAgent', 'maxIterations', 'validatePlan', 'CODING_EDIT_LIMIT_EXCEEDED', '/workspace/', 'CODING_AGENT_MAX_ITERATIONS_EXCEEDED']) {
  if (!source.includes(token)) throw new Error(`PHASE30_MISSING:${token}`);
}
for (const token of ['runAICodingAgent', 'codingAgent']) {
  if (!facade.includes(token)) throw new Error(`PHASE30_FACADE_MISSING:${token}`);
}
console.log('AIB_PHASE30_AI_CODING_AGENT_SELFTEST_OK');
