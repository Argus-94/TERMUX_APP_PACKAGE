#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assets = path.join(root, 'assets/github-tool');
const chromium = process.env.CHROMIUM_BIN || 'chromium';
const secretA = 'ghp_' + 'A'.repeat(36);
const secretB = 'github_pat_' + 'B'.repeat(32);
const fixturePrefix = 'aib-flow-' + Math.random().toString(36).slice(2, 8);
const harnessPrelude = `
<script>
(() => {
  window.requestAnimationFrame=(cb)=>setTimeout(()=>cb(performance.now()),0);
  window.cancelAnimationFrame=(id)=>clearTimeout(id);
  const makeStorage=()=>{const data=new Map();return {get length(){return data.size;},key(i){return [...data.keys()][i]??null;},getItem(k){return data.has(String(k))?data.get(String(k)):null;},setItem(k,v){data.set(String(k),String(v));if(window.__aibMockState)window.__aibMockState.localStorageWrites.push(String(k));},removeItem(k){data.delete(String(k));},clear(){data.clear();}};};
  Object.defineProperty(window,'localStorage',{configurable:true,value:makeStorage()});
  Object.defineProperty(window,'sessionStorage',{configurable:true,value:makeStorage()});
  const tokenA = ${JSON.stringify(secretA)};
  const tokenB = ${JSON.stringify(secretB)};
  const prefix = ${JSON.stringify(fixturePrefix)};
  const b64 = (s) => btoa(unescape(encodeURIComponent(String(s))));
  const state = window.__aibMockState = {
    calls: [], secrets: new Map([['unzipgit_token', tokenA]]), secretWrites: [], localStorageWrites: [], savedFiles: [], downloads: [], uploads: [],
    refSha: 'commit-1', treeSeq: 1, commitSeq: 1, blobSeq: 2, keySeq: 40, releaseSeq: 19,
    blobs: new Map([['blob-readme', b64('Original content\\n')], ['blob-license', b64('MIT\\n')]]),
    treeEntries: [
      {path:'src',type:'tree',sha:'tree-src',mode:'040000'},
      {path:'src/readme.md',type:'blob',sha:'blob-readme',size:17,mode:'100644'},
      {path:'LICENSE.txt',type:'blob',sha:'blob-license',size:4,mode:'100644'}
    ], treeMap: new Map(), commits: new Map([['commit-1',{tree:{sha:'tree-1'}}]]),
    releases: [{id:10,tag_name:'v1.0.0',name:'Fixture release',body:'Synthetic',draft:false,prerelease:false,created_at:'2026-01-01T00:00:00Z',upload_url:'https://uploads.github.com/repos/synthetic-owner/synthetic-repo/releases/10/assets{?name,label}',assets:[{id:31,name:'existing.bin',size:4,download_count:1,url:'https://uploads.github.com/assets/31',browser_download_url:'https://github.com/fixture/release/download/existing.bin'}]}],
    sshKeys: [{id:7,title:'fixture key',key:'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFIXTURE fixture'}]
  };
  state.treeMap.set('tree-1', state.treeEntries);
  const ok = (data, status=200, headers={}) => JSON.stringify({ok:status>=200&&status<300,status,statusText:'',headers,body:status===204?'':JSON.stringify(data),isBase64:false});
  const no = (status, message='fixture not found') => ok({message},status);
  window.__aibHttp = async (raw) => {
    let req;
    try { req = JSON.parse(raw); } catch { return JSON.stringify({ok:false,status:0,error:'fixture parse'}); }
    const u = new URL(req.url);
    if (u.hostname !== 'api.github.com' && u.hostname !== 'raw.githubusercontent.com') return JSON.stringify({ok:false,status:0,error:'fixture blocked non-GitHub host'});
    const method = String(req.method || 'GET').toUpperCase();
    let body = null; try { body = req.body ? JSON.parse(req.body) : null; } catch {}
    const p = u.pathname;
    state.calls.push({method,path:p,query:u.search,body});
    if (u.hostname === 'raw.githubusercontent.com') return JSON.stringify({ok:true,status:200,statusText:'OK',headers:{},body:b64('zip bytes fixture'),isBase64:true});
    if (p === '/user' && method === 'GET') return ok({login:'synthetic-owner',name:'Fixture Owner'},200,{'X-OAuth-Scopes':'repo,read:public_key,admin:public_key'});
    if (p === '/user/keys' && method === 'GET') return ok(state.sshKeys);
    if (p === '/user/keys' && method === 'POST') { const k={id:++state.keySeq,title:body.title,key:body.key}; state.sshKeys.push(k); return ok(k,201); }
    if (/^\\/user\\/keys\\/\\d+$/.test(p) && method === 'DELETE') { const id=Number(p.split('/').pop()); state.sshKeys=state.sshKeys.filter(k=>k.id!==id); return ok(null,204); }
    const base='/repos/synthetic-owner/synthetic-repo';
    if (p === base && method === 'GET') return ok({id:1,name:'synthetic-repo',full_name:'synthetic-owner/synthetic-repo',default_branch:'main',size:2,archived:false,permissions:{push:true}});
    if (p === base + '/branches' && method === 'GET') return ok([{name:'main'}]);
    if (p === base + '/branches/main' && method === 'GET') return ok({name:'main',commit:{sha:state.refSha,commit:{tree:{sha:'tree-1'}}}});
    if (p.startsWith(base + '/branches/') && method === 'GET') return ok({name:p.split('/').pop(),commit:{sha:state.refSha,commit:{tree:{sha:'tree-1'}}}});
    if (p === base + '/releases' && method === 'GET') return ok(state.releases);
    if (p === base + '/releases' && method === 'POST') {
      const rel={id:++state.releaseSeq,tag_name:body.tag_name,name:body.name||body.tag_name,body:body.body||'',draft:!!body.draft,prerelease:!!body.prerelease,created_at:'2026-10-04T00:00:00Z',upload_url:'https://uploads.github.com/repos/synthetic-owner/synthetic-repo/releases/20/assets{?name,label}',assets:[]};
      state.releases.unshift(rel); return ok(rel,201);
    }
    const relMatch=p.match(new RegExp('^'+base.replaceAll('/','\\/')+'/releases/(\\d+)$'));
    if (relMatch && method === 'GET') { const rel=state.releases.find(x=>x.id===Number(relMatch[1])); return rel?ok(rel):no(404); }
    if (relMatch && method === 'PATCH') { const rel=state.releases.find(x=>x.id===Number(relMatch[1])); if(!rel)return no(404); Object.assign(rel,body||{}); return ok(rel); }
    if (relMatch && method === 'DELETE') { state.releases=state.releases.filter(x=>x.id!==Number(relMatch[1])); return ok(null,204); }
    if (p === base + '/git/ref/heads/main' && method === 'GET') return ok({ref:'refs/heads/main',object:{sha:state.refSha}});
    const branchRef=p.match(new RegExp('^'+base.replaceAll('/','\\/')+'/git/ref/heads/([^/]+)$'));
    if (branchRef && method === 'GET') return ok({ref:'refs/heads/'+branchRef[1],object:{sha:state.refSha}});
    if (branchRef && method === 'PATCH') { state.refSha=body.sha; return ok({object:{sha:state.refSha}}); }
    if (p === base + '/git/refs' && method === 'POST') { state.refSha=body.sha; return ok({ref:body.ref,object:{sha:state.refSha}},201); }
    const commitMatch=p.match(new RegExp('^'+base.replaceAll('/','\\/')+'/git/commits/([^/]+)$'));
    if (commitMatch && method === 'GET') return ok(state.commits.get(commitMatch[1]) || {tree:{sha:'tree-1'}});
    if (commitMatch && method === 'POST') { const sha='commit-'+(++state.commitSeq); state.commits.set(sha,{tree:{sha:body.tree},message:body.message}); return ok({sha,tree:{sha:body.tree}},201); }
    if (p === base + '/git/commits' && method === 'POST') { const sha='commit-'+(++state.commitSeq); state.commits.set(sha,{tree:{sha:body.tree},message:body.message}); return ok({sha,tree:{sha:body.tree}},201); }
    if (p === base + '/git/trees' && method === 'POST') {
      const source=(body.base_tree && state.treeMap.get(body.base_tree)) || [];
      const next=source.map(x=>({...x}));
      for (const item of (body.tree||[])) {
        const at=next.findIndex(x=>x.path===item.path);
        if(item.sha===null) { if(at>=0)next.splice(at,1); }
        else { const e={path:item.path,type:item.type||'blob',mode:item.mode||'100644',sha:item.sha,size:state.blobs.get(item.sha)?.length||0}; if(at>=0)next[at]=e;else next.push(e); }
      }
      state.treeEntries=next; const sha='tree-'+(++state.treeSeq); state.treeMap.set(sha,next); return ok({sha,tree:next},201);
    }
    const treeMatch=p.match(new RegExp('^'+base.replaceAll('/','\\/')+'/git/trees/([^/]+)$'));
    if (treeMatch && method === 'GET') return ok({sha:treeMatch[1],truncated:false,tree:state.treeMap.get(treeMatch[1])||state.treeEntries});
    if (p === base + '/git/blobs' && method === 'POST') { const sha='blob-new-'+(++state.blobSeq); state.blobs.set(sha,body.content||''); return ok({sha},201); }
    const blobMatch=p.match(new RegExp('^'+base.replaceAll('/','\\/')+'/git/blobs/([^/]+)$'));
    if (blobMatch && method === 'GET') { const content=state.blobs.get(blobMatch[1]); return content==null?no(404):ok({content,encoding:'base64',size:Math.floor(content.length*3/4)}); }
    const contentMatch=p.match(new RegExp('^'+base.replaceAll('/','\\/')+'/contents/(.+)$'));
    if (contentMatch && method === 'PUT') {
      const path=decodeURIComponent(contentMatch[1]); const sha='blob-content-'+(++state.blobSeq); state.blobs.set(sha,body.content||'');
      const at=state.treeEntries.findIndex(x=>x.path===path); const ent={path,type:'blob',mode:'100644',sha,size:Math.floor((body.content||'').length*3/4)}; if(at>=0)state.treeEntries[at]=ent;else state.treeEntries.push(ent);
      state.treeMap.set('tree-updated',state.treeEntries); return ok({content:{sha},commit:{sha:'commit-content',tree:{sha:'tree-updated'}}},201);
    }
    if (contentMatch && method === 'GET') { const path=decodeURIComponent(contentMatch[1]); const e=state.treeEntries.find(x=>x.path===path); return e?ok({sha:e.sha,path,download_url:'https://raw.githubusercontent.com/synthetic-owner/synthetic-repo/main/'+path,content:state.blobs.get(e.sha),encoding:'base64'}):no(404); }
    if (p === base + '/releases/assets/31' && method === 'DELETE') return ok(null,204);
    return no(404, 'fixture endpoint not implemented');
  };
  window.AndroidInterface = {
    secretGet(name){return state.secrets.get(name)||'';},
    secretSet(name,value){state.secrets.set(name,String(value));state.secretWrites.push({name});return Promise.resolve(true);},
    secretDelete(name){state.secrets.delete(name);return Promise.resolve(true);},
    httpRequest(payload){return window.__aibHttp(payload);},
    isOnline(){return true;}, keepScreenOn(){}, showToast(){}, showError(msg){state.shownErrors.push(String(msg));}, openUrl(){}, shareText(){}, saveFile(){},
    pickFiles(){setTimeout(()=>window.__ugPicked(JSON.stringify([{id:'fixture-upload-1',name:'artifact.bin',size:4,mime:'application/octet-stream'}])),0);},
    uploadAsset(id,url,token,name,mime){state.uploads.push({id,url,name,mime});const rel=state.releases.find(x=>/releases\\/20\\//.test(url))||state.releases[0];const asset={id:500+state.uploads.length,name,size:4,download_count:0,url:'https://uploads.github.com/assets/'+id,browser_download_url:'https://github.com/fixture/release/'+name};if(rel)rel.assets.push(asset);setTimeout(()=>window.__ugDone(id,201,JSON.stringify(asset)),0);},
    downloadAsset(id,url,token,name){state.downloads.push({name,url});setTimeout(()=>window.__ugDownloadDone(id,true,''),0);},
    cancelTransfer(){},
  };
  state.shownErrors=[];
  window.__aibSaveFile=async(name,mime,data)=>{state.savedFiles.push({name,mime,base64:data});};
  window.alert=(msg)=>{const s=String(msg);const kind=/сохран|защит/i.test(s)?'secure-save':/формат/i.test(s)?'token-format':/токен/i.test(s)?'token':/файл|архив/i.test(s)?'file':/пользовател|репозитор/i.test(s)?'repo':'other';state.alerts=(state.alerts||[]).concat([kind]);};
  window.confirm=()=>true;
  try { localStorage.setItem('unzipgit_username','synthetic-owner'); localStorage.setItem('unzipgit_repo','synthetic-repo'); localStorage.setItem('unzipgit_branch','main'); localStorage.setItem('unzipgit_onboarded_v1','1'); } catch {}
  window.__aibFinish=(status,msg)=>{if(document.getElementById('aib-e2e-result'))return;const e=document.createElement('pre');e.id='aib-e2e-result';e.textContent=status+':'+msg;document.body.appendChild(e);const t=document.getElementById('token');if(t)t.value='';};
  window.addEventListener('error',e=>{if(!document.getElementById('aib-e2e-result'))window.__aibFinish('FAIL','page-error-'+String(e.message||'unknown').replace(/[^a-zA-Z0-9_-]/g,'_').slice(0,80));});
})();
</script>`;

const browserHelpers = `
<script>
const waitFor=async(fn,label,timeout=12000)=>{const end=Date.now()+timeout;while(Date.now()<end){try{if(fn())return;}catch{}await new Promise(r=>setTimeout(r,30));}throw new Error('timeout-'+label);};
const check=(x,label)=>{if(!x)throw new Error('assert-'+label);};
const click=(node,label)=>{if(!node)throw new Error('missing-'+label);node.click();};
const clickRowIcon=(row)=>{const i=row&&row.querySelector('.ico');if(!i)throw new Error('missing-row-icon');i.dispatchEvent(new MouseEvent('click',{bubbles:true}));};
const b64text=(s)=>decodeURIComponent(escape(atob(s)));
</script>`;

async function runBrowserPage(page, scenario) {
  const source = fs.readFileSync(path.join(assets, page), 'utf8');
  const harnessPath = path.join(assets, `.aib-e2e-${process.pid}-${Math.random().toString(36).slice(2,8)}.html`);
  const html = source
    .replace(/<head([^>]*)>/i, (_, attrs) => `<head${attrs}>${harnessPrelude}`)
    .replace(/<\/body>/i, () => `${browserHelpers}<script>window.addEventListener('load',async()=>{try{${scenario}\nwindow.__aibFinish('PASS',${JSON.stringify(page)});}catch(e){const trail=(window.__aibMockState?.calls||[]).slice(-12).map(c=>c.method+'_'+c.path.split('/').slice(-3).join('_')).join('.');window.__aibFinish('FAIL',(String(e&&e.message||e)+'_'+trail).replace(/[^a-zA-Z0-9_-]/g,'_').slice(0,320));}});</script></body>`);
  if (process.env.AIB_E2E_DEBUG) fs.writeFileSync(`/tmp/aib-github-harness-${process.pid}.html`, html, 'utf8');
  fs.writeFileSync(harnessPath, html, 'utf8');
  try {
    const res = spawnSync(chromium, ['--headless','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--disable-extensions','--disable-background-networking','--no-first-run','--no-default-browser-check','--allow-file-access-from-files','--virtual-time-budget=30000','--dump-dom',pathToFileURL(harnessPath).href], {encoding:'utf8',timeout:90000,maxBuffer:16*1024*1024,stdio:['ignore','pipe','pipe']});
    if (res.error) throw new Error(`${page}:chromium-${res.error.code||'error'}`);
    const marker = res.stdout.match(/<pre id="aib-e2e-result">([^<]*)<\/pre>/);
    if (res.status !== 0 || !marker || !marker[1].startsWith('PASS:')) {
      const result = marker?.[1] || `missing-result-exit-${res.status}`;
      if (process.env.AIB_E2E_DEBUG) {
        const dump = `/tmp/aib-github-${page.replace(/[^a-z0-9]/gi,'-')}-${process.pid}.html`;
        fs.writeFileSync(dump, res.stdout + '\n<!-- STDERR -->\n' + res.stderr, 'utf8');
        console.error(`AIB_E2E_DEBUG_DUMP ${dump}`);
      }
      throw new Error(`${page}:${result}`);
    }
  } finally { fs.rmSync(harnessPath,{force:true}); }
}

const fileScenario = `
await waitFor(()=>document.querySelector('#plist0 .row[data-path="src"]'),'file-tree');
const src=document.querySelector('#plist0 .row[data-path="src"]');src.dispatchEvent(new MouseEvent('click',{bubbles:true}));
await waitFor(()=>document.querySelector('#plist0 .row[data-path="src/readme.md"]'),'browse-folder');
const readme=document.querySelector('#plist0 .row[data-path="src/readme.md"]');readme.dispatchEvent(new MouseEvent('click',{bubbles:true}));
await waitFor(()=>document.getElementById('edTa').value.includes('Original content'),'open-editor');
const ta=document.getElementById('edTa');ta.value='Edited from production UI\\n';ta.dispatchEvent(new Event('input',{bubbles:true}));
await waitFor(()=>!document.getElementById('edSave').disabled,'save-enabled');
click(document.getElementById('edSave'),'save-file');
await waitFor(()=>window.__aibMockState.calls.some(c=>c.method==='PUT'&&c.path.endsWith('/contents/src/readme.md')),'edit-commit');
check(window.__aibMockState.savedFiles.length===0,'edit-not-download');
click(document.getElementById('edBack'),'close-editor');
await waitFor(()=>document.getElementById('editor').classList.contains('hidden'),'editor-closed');
const rootCrumb=document.querySelector('#crumbs0 .crumb');rootCrumb.dispatchEvent(new MouseEvent('click',{bubbles:true}));
await waitFor(()=>document.querySelector('#plist0 .row[data-path="LICENSE.txt"]'),'back-root');
const license=document.querySelector('#plist0 .row[data-path="LICENSE.txt"]');clickRowIcon(license);click(document.getElementById('bbDownload'),'download-file');
await waitFor(()=>window.__aibMockState.savedFiles.some(f=>f.name==='LICENSE.txt'),'saved-download');
check(b64text(window.__aibMockState.savedFiles.find(f=>f.name==='LICENSE.txt').base64)==='MIT\\n','download-content');
clickRowIcon(license);
const srcRoot=document.querySelector('#plist0 .row[data-path="src"]');clickRowIcon(srcRoot);click(document.getElementById('bbMore'),'more-actions');
await waitFor(()=>!document.getElementById('sheetWrap').classList.contains('hidden'),'more-sheet');
const zipChoice=[...document.querySelectorAll('#sheetWrap button')].find(b=>b.textContent.includes('Упаковать в ZIP'));click(zipChoice,'zip-choice');
await waitFor(()=>window.__aibMockState.calls.some(c=>c.method==='POST'&&c.path.endsWith('/git/trees'))&&window.__aibMockState.treeEntries.some(e=>e.path.endsWith('.zip')),'create-zip');
const licenseAfter=document.querySelector('#plist0 .row[data-path="LICENSE.txt"]');clickRowIcon(licenseAfter);click(document.getElementById('bbDelete'),'delete-file');
await waitFor(()=>!document.getElementById('modalWrap').classList.contains('hidden'),'delete-confirm');
const deleteConfirm=[...document.querySelectorAll('#modalWrap button')].at(-1);click(deleteConfirm,'confirm-delete');
await waitFor(()=>window.__aibMockState.calls.filter(c=>c.method==='PATCH'&&c.path.includes('/git/refs/heads/main')).length>=2,'delete-commit');
check(window.__aibMockState.calls.some(c=>c.method==='PUT'&&c.path.endsWith('/contents/src/readme.md')),'edit-api');
check(window.__aibMockState.calls.some(c=>c.method==='POST'&&c.path.endsWith('/git/trees')&&c.body.tree.some(e=>e.path.endsWith('.zip'))),'zip-api');
check(window.__aibMockState.calls.some(c=>c.method==='POST'&&c.path.endsWith('/git/trees')&&c.body.tree.some(e=>e.sha===null)),'delete-tombstone');
`;

const releaseScenario = `
window.UG.sheet=async()=>null;window.UG.form=async()=>null;window.UG.confirmBox=async()=>true;
await waitFor(()=>document.getElementById('list').textContent.includes('Fixture release'),'release-list');
const expand=[...document.querySelectorAll('#list button')].find(b=>b.textContent.includes('Файлы: 1'));click(expand,'expand-assets');
await waitFor(()=>document.querySelector('#list [title="Скачать"]'),'asset-download-button');
click(document.querySelector('#list [title="Скачать"]'),'asset-download');
await waitFor(()=>window.__aibMockState.downloads.length===1,'asset-downloaded');
click(document.getElementById('fab'),'new-release');
await waitFor(()=>!document.getElementById('composer').classList.contains('hidden'),'composer-open');
document.getElementById('cName').value='Synthetic release';document.getElementById('cBody').value='Synthetic fixture body';
click(document.getElementById('cPick'),'pick-release-asset');
await waitFor(()=>document.getElementById('cFiles').textContent.includes('artifact.bin'),'picked-release-asset');
click(document.getElementById('cSubmit'),'submit-release');
await waitFor(()=>window.__aibMockState.uploads.length===1,'asset-uploaded');
await waitFor(()=>!document.getElementById('uplClose').classList.contains('hidden'),'upload-finished');
click(document.getElementById('uplClose'),'close-upload');
await waitFor(()=>window.__aibMockState.calls.some(c=>c.method==='POST'&&c.path.endsWith('/releases'))&&window.__aibMockState.calls.some(c=>c.method==='PATCH'&&c.path.endsWith('/releases/20')&&c.body.draft===false),'release-published');
check(window.__aibMockState.uploads[0].name==='artifact.bin','native-upload-payload');
`;

const tokenScenario = `
const U=window.UG;const queue=[${JSON.stringify({name:'Synthetic secondary',value:secretB,act:true})},{title:'synthetic-key',key:'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAISYNTHETIC fixture-key'},{name:'Synthetic API key',prefix:'test_',size:'16',fmt:'hex'}];
U.sheet=async(title)=>title==='Добавить токен'?'paste':null;
U.form=async(title)=>{if(title==='Новый токен')return queue[0];if(title==='Добавить SSH-ключ')return queue[1];if(title==='Новый ключ API')return queue[2];return null;};U.confirmBox=async()=>true;
await waitFor(()=>document.getElementById('fab').onclick,'token-init');
click(document.getElementById('fab'),'add-token');
await waitFor(()=>window.__aibMockState.secrets.get('unzipgit_token')===${JSON.stringify(secretB)},'active-secure-token');
check(window.__aibMockState.secretWrites.some(x=>x.name==='unzipgit_tokens')&&window.__aibMockState.secretWrites.some(x=>x.name==='unzipgit_token'),'secure-token-list-and-active');
const sshTab=[...document.querySelectorAll('#tabs button')].find(b=>b.textContent.includes('SSH-ключи'));click(sshTab,'ssh-tab');
await waitFor(()=>document.getElementById('note').textContent.includes('read:public_key')&&document.getElementById('list').textContent.includes('fixture key'),'ssh-permissions-and-list');
click(document.getElementById('fab'),'add-ssh');
await waitFor(()=>window.__aibMockState.calls.some(c=>c.method==='POST'&&c.path==='/user/keys'),'ssh-added');
await waitFor(()=>document.getElementById('list').textContent.includes('synthetic-key'),'ssh-rerendered');
const del=[...document.querySelectorAll('#list button')].find(b=>b.textContent.includes('Удалить'));click(del,'delete-ssh');
await waitFor(()=>window.__aibMockState.calls.some(c=>c.method==='DELETE'&&c.path==='/user/keys/7'),'ssh-deleted');
const apiTab=[...document.querySelectorAll('#tabs button')].find(b=>b.textContent.includes('Ключи API'));click(apiTab,'api-tab');click(document.getElementById('fab'),'create-api-key');
await waitFor(()=>window.__aibMockState.secrets.has('unzipgit_apikeys')&&JSON.parse(window.__aibMockState.secrets.get('unzipgit_apikeys')).length>0,'api-key-secure-save');
`;

const archiveScenario = `
await waitFor(()=>window.UG&&document.getElementById('unzipBtn').onclick!==undefined,'archive-page');
check(window.AndroidInterface.secretGet('unzipgit_token').length>20,'native-vault-fixture');
check(window.UG.token().length>20,'common-token-helper');
check(document.getElementById('token').value.length>20,'active-token-prefill');
check(window.UG.tokenFormatError(window.UG.normalizeToken(document.getElementById('token').value))==='','synthetic-token-format');
const originalLs=window.UG.ls;window.__aibMockState.appTokenSaveCalls=0;window.__aibMockState.appTokenSaveResults=[];window.UG.ls=function(k,v){const r=originalLs.apply(this,arguments);if(k==='unzipgit_token'&&arguments.length>1){window.__aibMockState.appTokenSaveCalls++;if(r&&typeof r.then==='function')return r.then(ok=>{window.__aibMockState.appTokenSaveResults.push(!!ok);return ok;});window.__aibMockState.appTokenSaveResults.push(r===true);}return r;};
const zip=new JSZip();zip.file('docs/new-file.txt','fixture archive payload');zip.file('__MACOSX/._hidden','skip');const blob=await zip.generateAsync({type:'blob'});const file=new File([blob],'synthetic-archive.zip',{type:'application/zip'});
const fi=document.getElementById('fileInput');Object.defineProperty(fi,'files',{configurable:true,value:[file]});fi.dispatchEvent(new Event('change',{bubbles:true}));
document.getElementById('singleCommitCheck').checked=true;document.getElementById('dryRunCheck').checked=false;document.getElementById('username').value='synthetic-owner';document.getElementById('repo').value='synthetic-repo';
click(document.getElementById('unzipBtn'),'unzip-archive');
await waitFor(()=>window.__aibMockState.calls.length>0||(window.__aibMockState.alerts||[]).length>0||document.getElementById('log').textContent.includes('Начинаю распаковку'),'archive-run-start');
if((window.__aibMockState.alerts||[]).length)throw new Error('archive-alert-'+window.__aibMockState.alerts[0]+'-inputlen-'+document.getElementById('token').value.length+'-writes-'+window.__aibMockState.secretWrites.filter(x=>x.name==='unzipgit_token').length+'-ls-'+window.__aibMockState.localStorageWrites.slice(-5).join('.')+'-ucalls-'+window.__aibMockState.appTokenSaveCalls+'-uok-'+window.__aibMockState.appTokenSaveResults.join('.'));
check(window.__aibMockState.appTokenSaveCalls===1&&window.__aibMockState.appTokenSaveResults[0]===true,'app-secure-save');
await waitFor(()=>document.getElementById('stats').textContent.includes('Успешно: 1'),'archive-upload-stats',20000);
check(window.__aibMockState.calls.some(c=>c.method==='POST'&&c.path.endsWith('/git/blobs')),'archive-blob-write');
check(window.__aibMockState.calls.some(c=>c.method==='POST'&&c.path.endsWith('/git/trees')&&c.body.tree.some(e=>e.path==='docs/new-file.txt')),'archive-tree-write');
check(window.__aibMockState.calls.some(c=>c.method==='POST'&&c.path.endsWith('/git/commits')),'archive-single-commit');
check(window.__aibMockState.calls.some(c=>c.method==='PATCH'&&c.path.endsWith('/git/refs/heads/main')),'archive-ref-update');
`;

for (const [page, scenario] of [['files.html',fileScenario],['releases.html',releaseScenario],['tokens.html',tokenScenario],['index.html',archiveScenario]]) {
  if (process.env.AIB_E2E_PAGE && process.env.AIB_E2E_PAGE !== page) continue;
  await runBrowserPage(page, scenario);
}

// Execute the actual agent-facing TypeScript module with mocked React Native and keystore modules.
const source=fs.readFileSync(path.join(root,'lib/github-tools.ts'),'utf8');
const transpiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const agentCalls=[];let agentRef='agent-commit-1';
const agentNative={secretGet:async()=>secretA,httpRequest:async(raw)=>{
  const req=JSON.parse(raw),u=new URL(req.url),method=req.method.toUpperCase(),p=u.pathname;
  let body=null;try{body=req.body?JSON.parse(req.body):null}catch{}
  agentCalls.push({method,path:p,body,auth:req.headers?.Authorization||''});
  const response=(data,status=200)=>JSON.stringify({ok:status>=200&&status<300,status,body:status===204?'':JSON.stringify(data)});
  const base='/repos/synthetic-owner/synthetic-repo';
  if(p===base&&method==='GET')return response({default_branch:'main',archived:false,permissions:{push:true},size:10});
  if(p===base+'/contents/src/readme.md'&&method==='GET')return response({path:'src/readme.md',sha:'blob-a',content:'SGk=',encoding:'base64'});
  if(p===base+'/git/trees/main'&&method==='GET')return response({tree:[{path:'src/readme.md',type:'blob'}]});
  if(p===base+'/git/ref/heads/feature'&&method==='GET')return response({object:{sha:agentRef}});
  if(p===base+'/git/ref/heads/main'&&method==='GET')return response({object:{sha:'main-sha'}});
  if(p===base+'/git/commits/'+agentRef&&method==='GET')return response({tree:{sha:'base-tree'}});
  if(p===base+'/git/commits/main-sha'&&method==='GET')return response({tree:{sha:'base-tree'}});
  if(p===base+'/git/blobs'&&method==='POST')return response({sha:'blob-created'},201);
  if(p===base+'/git/trees'&&method==='POST')return response({sha:'tree-created'},201);
  if(p===base+'/git/commits'&&method==='POST')return response({sha:'commit-created',html_url:'https://github.com/synthetic-owner/synthetic-repo/commit/commit-created'},201);
  if(p===base+'/git/refs/heads/feature'&&method==='PATCH'){agentRef=body.sha;return response({object:{sha:agentRef}});}
  if(p===base+'/git/refs'&&method==='POST')return response({ref:body.ref,object:{sha:body.sha}},201);
  if(p===base+'/pulls'&&method==='POST')return response({number:42,title:body.title,head:body.head,base:body.base},201);
  if(p===base+'/issues/7'&&method==='GET')return response({number:7,title:'fixture issue'});
  return response({message:'not found '+method+' '+p},404);
}};
const module={exports:{}};
const requireMock=(id)=>id==='react-native'?{NativeModules:{AibGithubTool:agentNative}}:id.endsWith('termux-executor')?{executeGuardedTermuxCommand:async()=>{throw new Error('termux fallback not expected');}}:(()=>{throw new Error('unexpected import '+id)})();
new Function('require','module','exports',transpiled)(requireMock,module,module.exports);
const agent=module.exports;
assert.equal((await agent.githubRepoInfo('synthetic-owner','synthetic-repo')).default_branch,'main');
assert.equal((await agent.githubRepoContents('synthetic-owner','synthetic-repo','src/readme.md','main')).path,'src/readme.md');
assert.deepEqual((await agent.githubRepoTree('synthetic-owner','synthetic-repo','main')).tree,[{path:'src/readme.md',type:'blob'}]);
assert.equal((await agent.githubIssueOrPr('synthetic-owner','synthetic-repo',7)).number,7);
assert.equal((await agent.githubReadUri('https://github.com/synthetic-owner/synthetic-repo/issues/7')).number,7);
const applied=await agent.githubApplyFiles('synthetic-owner','synthetic-repo','feature','fixture commit',[{path:'src/readme.md',content:'edited by agent'},{path:'obsolete.txt',delete:true}]);
assert.equal(applied.verified,true);
assert.ok(agentCalls.some(c=>c.method==='POST'&&c.path.endsWith('/git/trees')&&c.body.tree.some(e=>e.path==='obsolete.txt'&&e.sha===null)),'agent delete is represented in the git tree');
assert.ok(agentCalls.some(c=>c.method==='PATCH'&&c.path.endsWith('/git/refs/heads/feature')),'agent apply updates the requested branch');
const pr=await agent.githubCreatePullRequest('synthetic-owner','synthetic-repo','fixture PR','feature');assert.equal(pr.number,42);
assert.ok(agentCalls.every(c=>c.auth==='Bearer '+secretA),'agent calls resolve auth only from native secret storage');
assert.ok(agentCalls.every(c=>!JSON.stringify(c).includes('github_pat_')),'agent diagnostic fixture does not leak its token into recorded request metadata');
await assert.rejects(()=>agent.githubApi('../secrets'),/Only GitHub API resource paths are allowed/);

console.log('AIB_GITHUB_UI_FLOW_SELFTEST_OK host=real-html-js-dom-mocks repos=connect-e2e files=browse-edit-delete-zip-download releases=create-upload-download tokens-secure-activate-ssh-permissions-api-key archive=extract-single-commit agent=read-branch-apply-delete-pr fixture-only=no-live-github');
