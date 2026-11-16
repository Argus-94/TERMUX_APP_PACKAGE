import fs from 'node:fs';
const src=fs.readFileSync('lib/termux-packs.ts','utf8');
const blocks=[...src.matchAll(/download:\s*\{([\s\S]*?)\},\s*primary:/g)].map(m=>m[1]);
const errors=[];
for(const b of blocks){
  const urls=[...b.matchAll(/https?:[^"']+/g)].map(m=>m[0]);
  if(!urls.length) continue;
  const sha=(b.match(/sha256:\s*"([0-9a-f]{64})"/i)||[])[1];
  const sha1=(b.match(/sha1:\s*"([0-9a-f]{40})"/i)||[])[1];
  if(!sha && !sha1) errors.push(`UNPINNED_DOWNLOAD:${urls[0]}`);
}
if(errors.length){console.error(errors.join('\n')); process.exit(1)}
console.log(`AIB_TOOLCHAIN_DOWNLOAD_CONTRACT_SELFTEST_OK pinned=${blocks.length}`);
