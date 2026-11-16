import { createHomeLayout } from "../home/HomeLayout";
import { PersistentAIWorkspace } from "./PersistentAIWorkspace";

type FileMap = Record<string, string>;

class FakeEnvironment {
  readonly files: FileMap = {};
  readonly dirs = new Set<string>();
  async mkdir(path: string) { this.dirs.add(path); }
  async write(path: string, content: string) { this.files[path] = content; }
  async read(path: string) { return this.files[path] || ""; }
  async exists(path: string) { return path in this.files || this.dirs.has(path); }
  async exec(command: string): Promise<any> {
    if (command.includes("rev-parse --is-inside-work-tree")) return { exitCode: 0, stdout: "true\n", stderr: "" };
    if (command.includes("status --porcelain")) return { exitCode: 0, stdout: "## main\n", stderr: "" };
    if (command.includes("rev-parse HEAD")) return { exitCode: 0, stdout: "abc123\n", stderr: "" };
    if (command.includes("git add")) return { exitCode: 0, stdout: "", stderr: "" };
    if (command.includes("git commit")) return { exitCode: 1, stdout: "nothing to commit\n", stderr: "" };
    if (command.includes("git log")) return { exitCode: 0, stdout: "abc123\tinitial\t2026-01-01T00:00:00Z\n", stderr: "" };
    if (command.includes("git diff")) return { exitCode: 0, stdout: "", stderr: "" };
    if (command.includes("ls-files")) return { exitCode: 0, stdout: "", stderr: "" };
    return { exitCode: 0, stdout: "", stderr: "" };
  }
}

export async function runPersistentAIWorkspaceSelfTest(): Promise<void> {
  const env = new FakeEnvironment();
  const workspace = new PersistentAIWorkspace(env as any, createHomeLayout("/tmp/aib"));
  const path = await workspace.ensure("demo");
  if (!path.endsWith("/projects/demo")) throw new Error("PERSISTENT_WORKSPACE_PATH_FAILED");
  const status = await workspace.status("demo");
  if (!status.gitReady || !status.clean) throw new Error("PERSISTENT_WORKSPACE_STATUS_FAILED");
  const history = await workspace.history("demo");
  if (history.length !== 1 || history[0].hash !== "abc123") throw new Error("PERSISTENT_WORKSPACE_HISTORY_FAILED");
  const cache = await workspace.dependencyCachePath("demo");
  if (!cache.endsWith("/cache/dependencies/demo")) throw new Error("PERSISTENT_WORKSPACE_CACHE_FAILED");
}

if (require.main === module) {
  runPersistentAIWorkspaceSelfTest().then(() => console.log("AIB_PHASE34_PERSISTENT_WORKSPACE_SELFTEST_OK"));
}
