import { createHomeLayout } from "../home/HomeLayout";
import { AIProjectMemoryStore } from "./AIProjectMemory";

class FakeEnvironment {
  files: Record<string,string> = {}; dirs = new Set<string>();
  async mkdir(path:string){this.dirs.add(path)} async write(path:string,c:string){this.files[path]=c}
  async read(path:string){return this.files[path]||""} async exists(path:string){return path in this.files||this.dirs.has(path)}
  async exec(){return {exitCode:0,stdout:"",stderr:""}} async spawn(){return {}}
  getHome(){return "/tmp"}
}
export async function runAIProjectMemorySelfTest(){
 const env=new FakeEnvironment(); const store=new AIProjectMemoryStore(env as any,createHomeLayout("/tmp/aib"));
 await store.setArchitecture("demo","Expo -> Android native module -> Termux runtime");
 await store.setDependencies("demo",["expo","react","expo","apiKey=SHOULD_REDACT"]);
 await store.setConventions("demo",["strict TypeScript","small bounded edits"]);
 await store.recordBuild("demo","Build failed","token=secret error: gradle");
 await store.recordFix("demo","Fixed Gradle config","safe change");
 await store.recordTest("demo","Device smoke passed");
 const m=await store.get("demo");
 if(m.architecture.indexOf("Expo")<0 || m.dependencies.length!==2 || !m.buildHistory.length || !m.successfulFixes.length || !m.testHistory.length) throw new Error("PROJECT_MEMORY_RECORD_FAILED");
 const ctx=await store.context("demo"); if(ctx.includes("SHOULD_REDACT")||ctx.includes("secret")) throw new Error("PROJECT_MEMORY_SECRET_LEAK");
 await store.reset("demo"); const r=await store.get("demo"); if(r.architecture||r.buildHistory.length) throw new Error("PROJECT_MEMORY_RESET_FAILED");
}
if(require.main===module) runAIProjectMemorySelfTest().then(()=>console.log("AIB_PHASE35_PROJECT_MEMORY_SELFTEST_OK"));
