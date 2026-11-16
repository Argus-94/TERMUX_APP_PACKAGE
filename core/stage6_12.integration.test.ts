/**
 * Lightweight integration contracts for stages 6–12.
 */
import { createProcessRegistry } from "./process/ProcessRegistry";
import { createLockManager } from "./process/LockManager";
import { createSessionManager } from "./session/SessionManager";
import { buildDiagnosticReport } from "./diagnostics/DiagnosticReport";
import { createRecoveryManager } from "./recovery/RecoveryManager";
import { createUserspaceContainerBackend } from "./container/UserspaceContainerBackend";
import { ubuntuImageManifest, projectWorkspaceMount } from "./ubuntu/UbuntuProfile";
import { createHomeLayout } from "./home/HomeLayout";
import { createAgentManager } from "./agent/AgentManager";
import { createInMemoryAndroidBridge } from "./bridge/AndroidBridge";
import {
  NoneProvider,
  ShizukuProvider,
  RootProvider,
  detectPrivileges,
} from "./privilege/PrivilegeProvider";
import { createNativeContainerRuntime } from "./native/NativeContainerRuntime";
import {
  assertFinalValidationOk,
  runFinalValidation,
} from "./FinalValidation";
import { createToolchainManager } from "./toolchain/ToolchainManager";

describe("stages 6-12 integration contracts", () => {
  const home = createHomeLayout("/AIBuilderTermux");

  it("process registry + locks + sessions", () => {
    const reg = createProcessRegistry();
    reg.register({
      id: "p1",
      kind: "terminal",
      startedAt: Date.now(),
    });
    expect(reg.list("terminal")).toHaveLength(1);

    const locks = createLockManager();
    const h = locks.tryAcquire("project", "proj1", "owner1");
    expect(h).not.toBeNull();
    expect(locks.isLocked("project", "proj1")).toBe(true);
    expect(locks.tryAcquire("project", "proj1", "owner2")).toBeNull();
    locks.release("project", "proj1", "owner1");

    const sessions = createSessionManager();
    const s = sessions.create({ projectId: "proj1", projectRoot: home.projects + "/demo" });
    sessions.attachTerminal(s.id, "term-1");
    expect(sessions.get(s.id)?.terminalSessionIds).toContain("term-1");
  });

  it("diagnostics + recovery", async () => {
    const report = buildDiagnosticReport([
      { area: "home", level: "ok", message: "ok" },
      { area: "bridge", level: "warn", message: "optional" },
    ]);
    expect(report.summary.ok).toBe(1);

    const recovery = createRecoveryManager();
    recovery.register({
      id: "restart_terminal",
      kind: "restart_terminal",
      description: "Restart terminal session",
      run: () => {},
    });
    const result = await recovery.run("restart_terminal");
    expect(result.ok).toBe(true);
  });

  it("containers ubuntu lifecycle without owning projects", async () => {
    const backend = createUserspaceContainerBackend();
    backend.registerImage(ubuntuImageManifest(home));
    const inst = await backend.create({
      imageId: "ubuntu:base",
      name: "u1",
      mounts: [projectWorkspaceMount(home.projects + "/demo")],
      policy: "PROJECT_ONLY",
      projectId: "demo",
    });
    await backend.start(inst.id);
    expect(backend.get(inst.id)?.status).toBe("running");
    await backend.stop(inst.id);
    await backend.remove(inst.id);
    // project path is untouched by design (no project API called)
    expect(backend.get(inst.id)).toBeUndefined();
  });

  it("agent policy isolation", async () => {
    const env = {
      async exec() {
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      async spawn() {
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      async read() {
        return "";
      },
      async write() {},
      async exists() {
        return true;
      },
      async mkdir() {},
      getHome() {
        return home.root;
      },
    };
    const agents = createAgentManager(env);
    const agent = agents.create({
      policy: { allowedCapabilities: ["filesystem"], projectIsolation: true },
    });
    const denied = await agents.execute(agent.id, {
      tool: "net.fetch",
      capability: "network",
    });
    expect(denied.ok).toBe(false);
    const ok = await agents.execute(agent.id, {
      tool: "env.home",
      capability: "filesystem",
    });
    expect(ok.ok).toBe(true);
    expect(ok.output).toBe(home.root);
  });

  it("bridge auth + device", async () => {
    const bridge = createInMemoryAndroidBridge();
    const token = bridge.issueToken();
    expect(bridge.authenticate(token)).toBe(true);
    const res = await bridge.request({
      id: "1",
      method: "ping",
      token,
    });
    expect(res.ok).toBe(true);
    expect(bridge.getDeviceInfo().sdkInt).toBe(34);
  });

  it("privilege detection none/shizuku/root", async () => {
    const det = await detectPrivileges({
      none: new NoneProvider(),
      shizuku: new ShizukuProvider(false),
      root: new RootProvider(false),
    });
    expect(det.none).toBe(true);
    expect(det.active).toBe("none");

    const det2 = await detectPrivileges({
      none: new NoneProvider(),
      shizuku: new ShizukuProvider(true),
      root: new RootProvider(false),
    });
    expect(det2.active).toBe("shizuku");
  });

  it("native runtime default off", () => {
    const native = createNativeContainerRuntime();
    expect(native.detect().available).toBe(false);
    expect(native.isEnabled()).toBe(false);
  });

  it("final validation aggregates modules", () => {
    const report = runFinalValidation({
      homeLayout: home,
      executionEnvironment: {},
      projectManager: {},
      terminalSessionManager: {},
      toolchainManager: createToolchainManager(),
      processRegistry: createProcessRegistry(),
      sessionManager: createSessionManager(),
      containerManager: createUserspaceContainerBackend(),
      agentManager: {},
      androidBridge: createInMemoryAndroidBridge(),
      privilegeNone: new NoneProvider(),
      nativeRuntime: createNativeContainerRuntime(),
    });
    assertFinalValidationOk(report);
    expect(report.passed).toBe(12);
  });
});

describe("RuntimeFacade", () => {
  it("wires modules and passes final validation", async () => {
    const { createRuntimeFacade } = require("./RuntimeFacade");
    const { assertProjectSurvivalInvariant } = require("./recovery/BackupMigration");
    const facade = createRuntimeFacade({
      homeRoot: "/storage/emulated/0/AIBuilderTermux",
    });
    const session = facade.openProjectSession("demo");
    expect(session.projectId).toBe("demo");
    const report = facade.finalValidation();
    expect(report.failed).toBe(0);
    const survival = assertProjectSurvivalInvariant(facade.home, "demo");
    expect(survival.survivesContainerDelete).toBe(true);
    const diag = await facade.diagnostics();
    expect(diag.items.length).toBeGreaterThan(0);
  });
});
