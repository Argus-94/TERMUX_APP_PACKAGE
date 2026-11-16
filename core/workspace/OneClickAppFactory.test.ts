import { OneClickAppFactory } from "./OneClickAppFactory";

export async function runOneClickAppFactorySelfTest() {
  const calls: string[] = [];
  const fake: any = {
    home: { projects: "/home/projects" },
    environment: { mkdir: async (p: string) => calls.push(`mkdir:${p}`) },
    persistentWorkspaceStatus: async (id: string) => { calls.push(`workspace:${id}`); return {}; },
    projectMemoryGet: async (id: string) => { calls.push(`memory:${id}`); return {}; },
    projectMemoryRecordBuild: async () => ({}),
    projectMemoryRecordError: async () => ({}),
    projectMemoryRecordTest: async () => ({}),
    persistentWorkspaceCheckpoint: async () => ({}),
    containerCreate: async () => { calls.push("container-create"); return { id: "fake-container" }; },
    containerStart: async () => calls.push("container-start"),
    generateAIProject: async () => ({ ok: true, files: ["README.md", "package.json"] }),
    runAICodingAgent: async () => ({ ok: true, iterations: [], changedFiles: [] }),
    containerExec: async (_id: string, command: string) => {
      calls.push(`exec:${command}`);
      if (command === "npx") return { exitCode: 1, stdout: "", stderr: "toolchain unavailable" };
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
  const factory = new OneClickAppFactory(fake);
  const result = await factory.run({ name: "selftest-app", prompt: "Create a tiny Expo calculator", template: "expo", maxBuildAttempts: 1 });
  if (result.ok) throw new Error("Expected deterministic self-test to stop when Android toolchain is unavailable");
  if (result.projectId !== "selftest-app") throw new Error("project id normalization failed");
  if (!calls.includes("container-create") || !calls.includes("container-start")) throw new Error("factory orchestration missing container stages");
  if (!result.error?.includes("expo prebuild")) throw new Error(`unexpected error: ${result.error}`);
  console.log("AIB_PHASE36_ONE_CLICK_APP_FACTORY_SELFTEST_OK");
}

if (require.main === module) void runOneClickAppFactorySelfTest();
