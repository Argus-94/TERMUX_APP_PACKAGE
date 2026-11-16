import { executeGuardedTermuxCommand } from "./termux-executor";
import { utf8ToBase64 } from "./base64";

export async function runTypeScriptDiagnostics(projectPath?: string | null) {
  const cwd = projectPath || undefined;
  const lsp = await executeGuardedTermuxCommand("if command -v typescript-language-server >/dev/null 2>&1; then node scripts/aib-lsp-diagnostics.mjs \"$PWD\"; else echo LSP_UNAVAILABLE; fi", { workdir: cwd, timeoutMs: 30000, trustedInternal: true });
  if (!/LSP_UNAVAILABLE/.test(lsp.stdout || "") && lsp.exitCode === 0) {
    return { available: true, exitCode: 0, output: lsp.stdout || lsp.stderr || "" };
  }
  const result = await executeGuardedTermuxCommand("if command -v tsc >/dev/null 2>&1; then tsc --noEmit --pretty false; elif [ -x node_modules/.bin/tsc ]; then node_modules/.bin/tsc --noEmit --pretty false; else echo LSP_UNAVAILABLE; fi", { workdir: cwd, timeoutMs: 120000, trustedInternal: true });
  return { available: !/LSP_UNAVAILABLE/.test(result.stdout || ""), exitCode: result.exitCode, output: `${result.stdout || ""}\n${result.stderr || ""}`.trim() };
}


/** Generic LSP JSON-RPC request for definition/references/hover/completion/rename and other methods. */
export async function runLspRequest(projectPath: string|null|undefined, method: string, params: any) {
  const cwd=projectPath||undefined;
  const safeMethod=String(method||"");
  if(!/^textDocument\/(definition|references|hover|completion|rename)|workspace\/symbol$/.test(safeMethod)) throw new Error("LSP_METHOD_NOT_ALLOWED");
  // Delegate to the standalone JSON-RPC helper so the React Native side stays dependency-free.
  const payload=utf8ToBase64(JSON.stringify({method:safeMethod,params:params||{}}));
  return executeGuardedTermuxCommand(`if command -v typescript-language-server >/dev/null 2>&1; then node scripts/aib-lsp-request.mjs "$PWD" ${JSON.stringify(payload)}; else echo LSP_UNAVAILABLE; exit 127; fi`,{workdir:cwd,timeoutMs:45000});
}


export type LspPosition = {line:number; character:number};
export async function lspDefinition(projectPath:string|null|undefined,path:string,position:LspPosition){ return runLspRequest(projectPath,"textDocument/definition",{textDocument:{uri:toFileUri(projectPath,path)},position}); }
export async function lspReferences(projectPath:string|null|undefined,path:string,position:LspPosition){ return runLspRequest(projectPath,"textDocument/references",{textDocument:{uri:toFileUri(projectPath,path)},position,context:{includeDeclaration:true}}); }
export async function lspHover(projectPath:string|null|undefined,path:string,position:LspPosition){ return runLspRequest(projectPath,"textDocument/hover",{textDocument:{uri:toFileUri(projectPath,path)},position}); }
export async function lspCompletion(projectPath:string|null|undefined,path:string,position:LspPosition){ return runLspRequest(projectPath,"textDocument/completion",{textDocument:{uri:toFileUri(projectPath,path)},position}); }
export async function lspRename(projectPath:string|null|undefined,path:string,position:LspPosition,newName:string){ return runLspRequest(projectPath,"textDocument/rename",{textDocument:{uri:toFileUri(projectPath,path)},position,newName}); }
function toFileUri(projectPath:string|null|undefined,p:string){ const base=(projectPath||"").replace(/\\/g,"/").replace(/\/$/,""); const rel=String(p||"").replace(/^\/+/,""); return `file://${encodeURI(`${base}/${rel}`)}`; }
