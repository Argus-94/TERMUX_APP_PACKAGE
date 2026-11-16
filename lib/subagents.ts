import { errorMessage } from "./error-utils";
import { executeReadOnlyTermuxCommand } from "./termux-executor";
import { executeAgentTool, type AgentToolName } from "./agent-tools";
export type SubagentRole = "architecture" | "security" | "build" | "ui";
export interface SubagentResult { role: SubagentRole; status: "pending"|"done"|"error"; summary: string; commands?: string[]; }

/** Optional provider hook. When supplied, each worker gets its own model instance;
 * otherwise workers safely fall back to the shared model callback. */
export interface SubagentModel {
  askModel(history: Array<{ role: "user" | "assistant"; content: string }>): Promise<string>;
}
export type SubagentModelFactory = (role: SubagentRole) => Promise<SubagentModel> | SubagentModel;
export const SUBAGENT_PROMPTS: Record<SubagentRole,string> = {
  architecture: "Review architecture, state boundaries, persistence and regressions. Read relevant files with shell tools. Do not modify files. Return P0-P3 findings with concrete paths and remediation.",
  security: "Review secrets, permissions, shell execution, path traversal and unsafe filesystem operations. Read relevant files. Do not modify files. Return P0-P3 findings with evidence and remediation.",
  build: "Review Expo/Android/Gradle/toolchain risks. Inspect package.json, app.config and plugins. Do not modify native build configuration. Return P0-P3 findings with evidence.",
  ui: "Review UI consistency, accessibility, icons and interaction states. Inspect relevant app files. Do not modify files. Return concise P0-P3 findings.",
};
export function makeSubagentTasks(): Array<{role:SubagentRole; prompt:string}> { return Object.entries(SUBAGENT_PROMPTS).map(([role,prompt]) => ({role: role as SubagentRole,prompt})); }

const RUN="TERMUX_RUN:", DONE="TERMUX_DONE:";
function clip(s:string,n=2800){return (s||"").slice(-n)}
async function runReadOnlySubagent(task:string, role:SubagentRole, prompt:string, projectPath:string|null|undefined, model:SubagentModel):Promise<SubagentResult>{
  const history: Array<{role:"user"|"assistant";content:string}>=[{role:"user",content:`[SUBAGENT ${role}] You are an independent read-only coding subagent. ${prompt}\nTASK: ${task}\nYou may use AIB_TOOL for read-only fs/ast/lsp/github inspection, or TERMUX_RUN for read-only inspection only. Never edit, install, delete or build. End with TERMUX_DONE.`}];
  const commands:string[]=[];
  for(let i=0;i<4;i++){
    const reply=await model.askModel(history);
    const tool=reply.match(/AIB_TOOL:\s*([\s\S]*?)(?=\n(?:TERMUX_RUN|TERMUX_DONE|AIB_TOOL):|$)/i);
    const run=reply.match(/TERMUX_RUN:\s*([\s\S]*?)(?=\nTERMUX_DONE:|$)/i);
    const done=reply.match(/TERMUX_DONE:\s*([\s\S]*)/i);
    if(done && !run && !tool) return {role,status:"done",summary:clip(done[1]),commands};
    if(tool){
      try{
        const spec=JSON.parse(tool[1].trim());
        const allowed=["fs.read","fs.hashline","ast.search","ast.preview","lsp.diagnostics","lsp.request","lsp.definition","lsp.references","lsp.hover","lsp.completion","github.read","github.tree","github.list","github.search","github.searchIssues"];
        if(!allowed.includes(String(spec.tool))) throw new Error("SUBAGENT_TOOL_NOT_ALLOWED:"+String(spec.tool));
        if(/^(fs\.(create|delete|replace)|build\.|toolchain\.)/i.test(String(spec.tool))) throw new Error("SUBAGENT_TOOL_WRITE_NOT_ALLOWED");
        const r=await executeAgentTool(String(spec.tool) as AgentToolName,spec.args||{},projectPath);
        history.push({role:"assistant",content:reply},{role:"user",content:`[AIB_TOOL_RESULT ${spec.tool}]\n${clip(typeof r==="string"?r:JSON.stringify(r),5000)}`});
        continue;
      }catch(e:any){history.push({role:"assistant",content:reply},{role:"user",content:`[AIB_TOOL_ERROR] ${errorMessage(e)}`});continue;}
    }
    if(!run) return {role,status:"done",summary:clip(reply),commands};
    const cmd=run[1].trim();
    commands.push(cmd.slice(0,300));
    try {
      const r=await executeReadOnlyTermuxCommand(cmd,{workdir:projectPath||undefined,timeoutMs:30000});
      history.push({role:"assistant",content:reply},{role:"user",content:`[TERMUX_RESULT exit=${r.exitCode}]\n${clip((r.stdout||"")+"\n"+(r.stderr||""),5000)}`});
    } catch (e:unknown) {
      history.push({role:"assistant",content:reply},{role:"user",content:`[TERMUX_RESULT exit=126]\nstderr:\n${errorMessage(e)}`});
    }
  }
  return {role,status:"done",summary:"Subagent reached its read-only inspection limit without a final verdict.",commands};
}

export async function runSubagentWorker(task:string, role:SubagentRole, prompt:string, projectPath:string|null|undefined, model:SubagentModel, factory?:SubagentModelFactory){
  try {
    const workerModel = factory ? await factory(role) : model;
    return await runReadOnlySubagent(task,role,prompt,projectPath,workerModel);
  } catch(e:any) {
    return {role,status:"error",summary:errorMessage(e)} as SubagentResult;
  }
}
