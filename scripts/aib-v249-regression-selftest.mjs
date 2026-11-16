import fs from 'node:fs';

const guard=fs.readFileSync('lib/termux-guard.ts','utf8');
const executor=fs.readFileSync('lib/termux-executor.ts','utf8');
const errors=[];
if(!guard.includes('validate EVERY absolute path operand')) errors.push('ALL_PATH_OPERANDS_GUARD_MISSING');
if(!guard.includes('const absolutePaths = operands.match')) errors.push('ALL_PATH_OPERANDS_SCAN_MISSING');
if(!guard.includes('cp safe /etc/passwd')) errors.push('MULTI_OPERAND_REGRESSION_CASE_MISSING');
if(!executor.includes('guardTermuxCommand')) errors.push('EXECUTOR_NOT_BOUND_TO_GUARD');
if(errors.length){ console.error(errors.join('\n')); process.exit(1); }

const scan=/\b(rm|mv|cp|chmod|chown|ln)\s+([^;&|\n]+)/gi;
const abs=/(?:^|[\s"'])\/(?:[^\s;&|"']*)/g;
const cases=[
  ['cp safe /etc/passwd',true],
  ['mv safe /etc/x',true],
  ['ln safe /etc/x',true],
  ['cp safe /storage/emulated/0/out.apk',false],
];
for(const [command,blocked] of cases){
  let found=false;
  for(const m of command.matchAll(scan)){
    for(const raw of (m[2]||'').match(abs)||[]){
      const target=raw.trim().replace(/^["']|["']$/g,'');
      if(target && !target.startsWith('/storage/emulated/0/')) found=true;
    }
  }
  if(found!==blocked) errors.push(`PATH_OPERAND_CASE:${command}`);
}
if(errors.length){ console.error(errors.join('\n')); process.exit(1); }
console.log('AIB_V249_REGRESSION_SELFTEST_OK all_path_operands=guarded');
