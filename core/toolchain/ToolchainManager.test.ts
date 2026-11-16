import { createToolchainManager } from "./ToolchainManager";
import { createToolchainManifest } from "./ToolchainManifest";
import { discoverAndroidSdk } from "./AndroidSdkDiscovery";
import { discoverSimpleTools } from "./ToolDiscovery";
import { buildToolchainDiagnostics } from "./ToolchainDiagnostics";

describe("ToolchainManager", () => {
  it("registers and lists manifests", () => {
    const mgr = createToolchainManager();
    mgr.register(
      createToolchainManifest({
        id: "java:test",
        kind: "java",
        name: "Java",
        version: "17",
        path: "/usr/lib/jvm/java-17",
        health: "healthy",
      }),
    );
    expect(mgr.list("java")).toHaveLength(1);
    expect(mgr.get("java:test")?.version).toBe("17");
  });

  it("refreshes from injected sources", async () => {
    const mgr = createToolchainManager();
    mgr.registerSource({
      discover: () => [
        createToolchainManifest({
          id: "node:test",
          kind: "node",
          name: "Node.js",
          version: "20.0.0",
          health: "healthy",
        }),
      ],
    });
    const result = await mgr.refresh();
    expect(result.found).toHaveLength(1);
    expect(result.missing).toContain("java");
  });
});

describe("AndroidSdkDiscovery", () => {
  it("returns empty when no candidates exist", async () => {
    const found = await discoverAndroidSdk({
      exists: async () => false,
    });
    expect(found).toEqual([]);
  });

  it("reports existing SDK path read-only", async () => {
    const found = await discoverAndroidSdk(
      {
        exists: async (p) => p.includes("Android/Sdk"),
        readText: async () => "Pkg.Revision=34.0.0\n",
      },
      { homeSdkPath: "/storage/emulated/0/AIBuilderTermux/sdk" },
    );
    expect(found.length).toBeGreaterThanOrEqual(1);
    expect(found[0].kind).toBe("android-sdk");
    expect(found[0].metadata?.discovery).toBe("read-only");
  });
});

describe("ToolDiscovery", () => {
  it("discovers simple tools via command probe", async () => {
    const found = await discoverSimpleTools({
      whichVersion: async (cmd) => {
        if (cmd === "node") return { path: "/usr/bin/node", version: "v20.11.0" };
        if (cmd === "git") return { path: "/usr/bin/git", version: "git version 2.43.0" };
        return null;
      },
    });
    expect(found.some((f) => f.kind === "node")).toBe(true);
    expect(found.some((f) => f.kind === "git")).toBe(true);
  });
});

describe("ToolchainDiagnostics", () => {
  it("builds report", () => {
    const mgr = createToolchainManager();
    mgr.register(
      createToolchainManifest({
        id: "git:1",
        kind: "git",
        name: "Git",
        health: "healthy",
      }),
    );
    const report = buildToolchainDiagnostics(mgr);
    expect(report.available).toBe(1);
    expect(report.missingKinds).toContain("java");
  });
});
