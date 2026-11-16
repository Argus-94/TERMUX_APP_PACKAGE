import { errorMessage } from "./error-utils";
import { persistentLogger } from "./persistent-logger";
import { executeGuardedTermuxCommand } from "./termux-executor";
import { makeSubagentTasks, runSubagentWorker, type SubagentResult } from "./subagents";
import type { AgentTranscriptTurn } from "./termux-agent";
import type { AgentIntelligenceSettings } from "./agent-intelligence";
import { runTypeScriptDiagnostics } from "./lsp";
import { collectProjectReview, aiReviewProject } from "./reviewer";
import { buildSkillsPrompt } from "./agent-skills";
import { recallProjectMemory, reflectProjectMemoryWithModel, retainProjectMemory, completeProjectMemorySession, type MemorySession } from "./session-memory";

export interface AgentModel {
  askModel(history: AgentTranscriptTurn[]): Promise<string>;
  /** Optional true per-worker model factory for providers that support isolated contexts. */
  createSubagentModel?: (role: "architecture"|"security"|"build"|"ui") => Promise<AgentModel> | AgentModel;
}

export async function startMemoryLifecycle(task:string, projectPath:string|null|undefined, settings:AgentIntelligenceSettings):Promise<MemorySession|null>{
  if(!settings.memory || !projectPath) return null;
  const { beginProjectMemorySession } = await import("./session-memory");
  return beginProjectMemorySession(projectPath, task);
}

export async function finishMemoryLifecycle(projectPath:string|null|undefined, session:MemorySession|null, outcome:string, settings:AgentIntelligenceSettings):Promise<void>{
  if(!settings.memory || !projectPath || !session) return;
  await completeProjectMemorySession(projectPath, session, outcome);
}
const clip=(s:string,n=5000)=>(s||"").slice(-n);

function isProviderRateLimit(text:string):boolean {
  return /(HTTP\s*429|too many requests|rate limit|free-models-per-day|лимит запрос|достигнут дневной бесплатный лимит)/i.test(text || "");
}

/** Stop preflight burst on hard transport failures (log: 4× ERR_NETWORK spam). */
function isProviderNetworkHardFail(text:string):boolean {
  return /(ERR_NETWORK|ECONNABORTED|ETIMEDOUT|ECONNRESET|Network Error|Custom provider:\s*Network Error)/i.test(text || "");
}

export async function runSubagents(task:string, projectPath:string|null|undefined, model:AgentModel, settings:AgentIntelligenceSettings):Promise<SubagentResult[]> {
  if(!settings.subagents) return [];
  const jobs=makeSubagentTasks();
  const results: SubagentResult[] = [];
  // Sequential only. After first rate-limit OR hard network failure, abort the
  // remaining preflight roles so we do not burn the provider with 4 dead POSTs.
  for (const {role,prompt} of jobs) {
    const result = await runSubagentWorker(
      task, role, prompt, projectPath, model,
      model.createSubagentModel ? (r)=>model.createSubagentModel!(r) : undefined
    );
    results.push(result);
    if (result.status === "error" && isProviderRateLimit(result.summary)) {
      persistentLogger.add("warn", "Agent", `Preflight stopped after provider rate limit in ${role}`);
      break;
    }
    if (result.status === "error" && isProviderNetworkHardFail(result.summary)) {
      persistentLogger.add("warn", "Agent", `Preflight stopped after network hard-fail in ${role}`);
      break;
    }
  }
  return results;
}

export async function buildPreflightContext(task:string, projectPath:string|null|undefined, model:AgentModel, settings:AgentIntelligenceSettings):Promise<string>{
  const results = await runSubagents(task,projectPath,model,settings);
  const skills = settings.memory ? await buildSkillsPrompt(projectPath) : "";
  const memories = settings.memory && projectPath ? await recallProjectMemory(projectPath,task) : [];
  const preflightRateLimited = results.some(r => r.status === "error" && isProviderRateLimit(r.summary));
  const reflection = settings.memory && projectPath && !preflightRateLimited
    ? await reflectProjectMemoryWithModel(projectPath,task,model)
    : "";
  const blocks:string[]=[];
  if(skills) blocks.push(skills);
  if(memories.length) blocks.push("[MEMORY_RECALL]\n"+memories.map(m=>`[${m.kind}] ${m.text}`).join("\n"));
  if(reflection) blocks.push("[MEMORY_REFLECTION]\n"+reflection);
  if(results.length) blocks.push("[PREFLIGHT_SUBAGENTS]\n"+results.map(r=>`[${r.role}] ${r.status}: ${r.summary}`).join("\n\n"));
  return blocks.join("\n\n");
}

export async function runAdvisor(task:string, transcript:AgentTranscriptTurn[], projectPath:string|null|undefined, model:AgentModel, settings:AgentIntelligenceSettings):Promise<string>{
  if(!settings.advisor) return "";
  try{
    const snap=projectPath?await executeGuardedTermuxCommand("git status --short; git diff --stat; printf '\\n---FILES---\\n'; find . -maxdepth 2 -type f | head -60",{workdir:projectPath,timeoutMs:30000}):null;
    const answer=await model.askModel([{role:"user",content:`[ADVISOR] Act as a watchdog. Do not execute or modify anything. Inspect the current task and recent transcript. Identify only a concrete risk, missing verification, stale edit, security issue, or unsafe action. If none, answer exactly OK.\nTASK: ${task}\nRECENT: ${JSON.stringify(transcript.slice(-8))}\nSNAPSHOT: ${clip((snap?.stdout||"")+"\n"+(snap?.stderr||""),3500)}`}]);
    const a=answer.trim(); if(!/^OK$/i.test(a)){persistentLogger.add("info","Advisor",`MODEL_RESPONSE_OMITTED chars=${a.length}`);return `[ADVISOR] ${clip(a,2500)}`;}
  }catch(e:unknown){persistentLogger.add("warn","Advisor",errorMessage(e));}
  return "";
}

export async function runPostReview(task:string,result:string,projectPath:string|null|undefined,model:AgentModel,settings:AgentIntelligenceSettings):Promise<string>{
  if(!settings.reviewer||!settings.autoPostReview) return "";
  try{
    const staticReview=await collectProjectReview(projectPath);
    const diagnostics=settings.lsp?await runTypeScriptDiagnostics(projectPath):null;
    const ai=await aiReviewProject({task,result,projectPath,staticReview,diagnostics},model);
    if(settings.memory&&projectPath){
      await retainProjectMemory(projectPath,"lesson",`Post-review for task: ${task.slice(0,500)}\n${ai.slice(0,1500)}`);
      const facts=[...ai.matchAll(/\[MEMORY\s+(fact|decision|lesson)\]\s*([^\n]+)/gi)];
      for(const m of facts) await retainProjectMemory(projectPath,m[1].toLowerCase() as "fact" | "decision" | "lesson",m[2]);
    }
    return ai;
  }catch(e:unknown){persistentLogger.add("warn","Reviewer",errorMessage(e));return "";}
}
