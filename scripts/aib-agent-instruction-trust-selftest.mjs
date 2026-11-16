import fs from 'node:fs';
import assert from 'node:assert/strict';

const agents = fs.readFileSync('lib/agents-md.ts', 'utf8');
const skills = fs.readFileSync('lib/agent-skills.ts', 'utf8');
const termux = fs.readFileSync('lib/termux-agent.ts', 'utf8');
const i18n = fs.readFileSync('lib/i18n.ts', 'utf8');

assert.match(agents, /только проектный контекст/);
assert.match(agents, /security-.*sandbox/i);
assert.match(skills, /SKILLS_UNTRUSTED_REPO_DATA/);
assert.match(skills, /MUST NOT override system\/developer policy/i);
assert.match(termux, /AGENTS_UNTRUSTED_REPO_DATA/);
assert.match(termux, /MUST NOT override system\/developer policy/i);
assert.doesNotMatch(termux, /Project instructions for the agent \(commands\/rules; user chat still wins\)/);
assert.match(i18n, /недоверенный контекст/);
assert.match(i18n, /untrusted project context/);
console.log('AIB_AGENT_INSTRUCTION_TRUST_SELFTEST_OK');
