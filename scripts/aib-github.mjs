#!/usr/bin/env node
const uri=process.argv[2];
if(!uri||!/^github:\/\//i.test(uri)){console.error('Usage: aib-github.mjs github://owner/repo/path@ref | github://owner/repo#pr/123 | github://owner/repo#issue/123');process.exit(2)}
const m=uri.match(/^github:\/\/([^/]+)\/([^/#]+)(?:#(pr|issue)\/(\d+)|\/([^@]*)@?(.*))?$/i);
if(!m){console.error('Invalid github URI');process.exit(2)}
const [,owner,repo,kind,num,path='',ref='HEAD']=m;
let url;
if(kind==='pr') url=`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${num}`;
else if(kind==='issue') url=`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${num}`;
else url=`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${path.split('/').filter(Boolean).map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref||'HEAD')}`;
const headers={'Accept':'application/vnd.github+json','User-Agent':'AIBuilder-Agent'};
if(process.env.GITHUB_TOKEN) headers.Authorization=`Bearer ${process.env.GITHUB_TOKEN}`;
const r=await fetch(url,{headers}); const text=await r.text(); if(!r.ok){console.error(`GITHUB_HTTP_${r.status}\n${text.slice(0,3000)}`);process.exit(1)}
try{const j=JSON.parse(text); if(j.content&&j.encoding==='base64') j.content=Buffer.from(j.content,'base64').toString('utf8'); console.log(JSON.stringify(j,null,2));}catch{console.log(text)}
