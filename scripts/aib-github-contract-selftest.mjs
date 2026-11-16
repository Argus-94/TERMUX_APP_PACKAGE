#!/usr/bin/env node
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
const tools=fs.readFileSync(`${root}/lib/github-tools.ts`,'utf8');
const agent=fs.readFileSync(`${root}/lib/agent-tools.ts`,'utf8');
const fail=(m)=>{console.error(`AIB_GITHUB_CONTRACT_FAIL ${m}`);process.exit(1)};
if(!/export async function githubReadUri/.test(tools)) fail('githubReadUri_missing');
if(!/export function normalizeGithubReadUri/.test(tools)) fail('normalizer_missing');
if(!agent.includes('github:\\/\\/') || !agent.includes('https:\\/\\/github\\.com')) fail('validator_contract_not_unified');
const cases=[
  ['github://owner/repo/src/app.ts@main','github://owner/repo/src/app.ts@main'],
  ['https://github.com/owner/repo/blob/main/src/app.ts','github://owner/repo/src/app.ts@main'],
  ['https://github.com/owner/repo/tree/main/src','github://owner/repo/src@main'],
  ['https://github.com/owner/repo/pull/42','github://owner/repo#pr/42'],
  ['https://github.com/owner/repo/issues/7','github://owner/repo#issue/7']
];
const normalize=(value)=>{
  if(/^github:\/\//i.test(value)) return value;
  if(!/^https:\/\/github\.com\//i.test(value)) throw new Error('invalid');
  const u=new URL(value);
  if(u.search||u.hash) throw new Error('query/hash');
  const parts=u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  if(parts.length<2) throw new Error('repo');
  const [owner,repo,...rest]=parts;
  if(rest.length===0) return `github://${owner}/${repo}`;
  if(rest[0]==='pull' && /^\d+$/.test(rest[1]||'') && rest.length===2) return `github://${owner}/${repo}#pr/${rest[1]}`;
  if(rest[0]==='issues' && /^\d+$/.test(rest[1]||'') && rest.length===2) return `github://${owner}/${repo}#issue/${rest[1]}`;
  if((rest[0]==='blob'||rest[0]==='tree')&&rest.length>=2) return `github://${owner}/${repo}/${rest.slice(2).join('/')}@${rest[1]}`;
  throw new Error('shape');
};
for(const [input,expected] of cases){if(normalize(input)!==expected) fail(`normalize:${input}`)}
for(const bad of ['http://github.com/o/r','https://evil.example/o/r','https://github.com/o/r?token=x','https://github.com/o/r/commit/abc']){
  try{normalize(bad);fail(`accepted:${bad}`)}catch(e){if(String(e.message).startsWith('accepted:')) throw e}
}
console.log('AIB_GITHUB_CONTRACT_SELFTEST_OK');
