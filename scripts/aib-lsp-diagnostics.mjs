#!/usr/bin/env node
import { spawnSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.argv[2] || process.cwd());
const bin = process.env.AIB_TS_LSP || 'typescript-language-server';
if (spawnSync(bin, ['--version'], {stdio:'ignore'}).status !== 0) process.exit(2);
const files = [];
function walk(d, depth=0){ if(depth>6) return; for(const e of fs.readdirSync(d,{withFileTypes:true})){ if(['node_modules','.git','android','ios'].includes(e.name)) continue; const p=path.join(d,e.name); if(e.isDirectory()) walk(p,depth+1); else if(/\.(ts|tsx)$/.test(e.name)) files.push(p); if(files.length>=80) return; }}
walk(root);
const child = spawn(bin,['--stdio'],{cwd:root,stdio:['pipe','pipe','pipe']});
let buf=Buffer.alloc(0), diagnostics=[];
function send(method,params,id){ const body=JSON.stringify({jsonrpc:'2.0',id,method,params}); child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`); }
child.stdout.on('data',chunk=>{buf=Buffer.concat([buf,chunk]); while(true){const sep=buf.indexOf('\r\n\r\n'); if(sep<0) break; const header=buf.slice(0,sep).toString(); const m=header.match(/Content-Length:\s*(\d+)/i); if(!m){buf=buf.slice(sep+4); continue;} const n=Number(m[1]); if(buf.length<sep+4+n) break; const body=buf.slice(sep+4,sep+4+n).toString(); buf=buf.slice(sep+4+n); try{const msg=JSON.parse(body); if(msg.method==='textDocument/publishDiagnostics' && msg.params?.diagnostics?.length) diagnostics.push({uri:msg.params.uri,items:msg.params.diagnostics});}catch{}}});
send('initialize',{processId:process.pid,rootUri:`file://${root}`,capabilities:{textDocument:{publishDiagnostics:{}}},workspaceFolders:[{uri:`file://${root}`,name:path.basename(root)}]},1);
setTimeout(()=>{
 child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'initialized',params:{}}));
 for(const f of files){const uri=`file://${f}`; const text=fs.readFileSync(f,'utf8'); send('textDocument/didOpen',{textDocument:{uri,languageId:f.endsWith('.tsx')?'typescriptreact':'typescript',version:1,text}},null);}
},500);
setTimeout(()=>{console.log(JSON.stringify({available:true,files:files.length,diagnostics},null,2)); try{send('shutdown',{},2); child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'exit',params:null}));}catch{} child.kill();},7000);
