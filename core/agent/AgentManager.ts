/**
 * Runtime-only AgentManager / Executor.
 * Agent runs through ExecutionEnvironment; capabilities are policy-gated.
 */

import type { ExecutionEnvironment } from "../environment/ExecutionEnvironment";
import type { DeviceAutomationAgent, DeviceAutomationOptions, DeviceAutomationResult } from "../device/DeviceAutomationAgent";
import { validateProjectName } from "../project-manager";
import {
  DEFAULT_AGENT_POLICY,
  type AgentExecRequest,
  type AgentExecResult,
  type AgentPolicy,
  type AgentCapability,
  type AgentSession,
} from "./AgentTypes";

/** Optional host hooks so agent can open terminals / run shell without tight coupling. */
export type AgentHostHooks = {
  openTerminalForProject?: (projectId: string) => Promise<{ id: string }>;
  openIsolatedTerminalForProject?: (projectId: string, projectRoot: string) => Promise<{ id: string }>;
  runShell?: (
    command: string,
    options?: { cwd?: string; env?: Record<string, string>; signal?: AbortSignal },
  ) => Promise<{ exitCode?: number | null; stdout?: string; stderr?: string }>;
  runIsolatedShell?: (
    command: string,
    options: { cwd: string; projectRoot: string; env?: Record<string, string>; signal?: AbortSignal },
  ) => Promise<{ exitCode?: number | null; stdout?: string; stderr?: string }>;
  runDeviceAutomation?: (options: DeviceAutomationOptions) => Promise<DeviceAutomationResult>;
  runDeviceTool?: (tool: string, args: Record<string, unknown>) => Promise<unknown>;
  /** Narrow host-owned Android build/sign workflow; never exposes a command runner to the model. */
  runAndroidToolchain?: (agent: AgentSession, args: Record<string, unknown>, projectRoot: string, signal?: AbortSignal) => Promise<unknown>;
  /** Called once before each agent shell task; may return only safe/dummy environment values. */
  beforeTask?: (agent: AgentSession, taskId: string, promptSummary: string, request: AgentExecRequest) => Promise<Record<string, string> | void>;
  /** Best-effort completion event and post-task service hook. */
  afterTask?: (agent: AgentSession, taskId: string, result: Readonly<{ ok: boolean; error?: string }>) => Promise<void>;
  /** Wake a sleeping userspace container before shell execution. */
  wakeForTask?: (agent: AgentSession) => Promise<void>;
  /** Explicit policy-gated checkpoint recovery hook. */
  revertCheckpoint?: (agent: AgentSession, taskId: string) => Promise<void>;
  /** Must persist a pre-write checkpoint before any agent-controlled filesystem mutation. */
  beforeFileWrite?: (agent: AgentSession, absolutePath: string) => Promise<void>;
  /** Validated manifest write hook; host owns .aib/runtime.yaml path policy. */
  writeManifest?: (agent: AgentSession, content: string) => Promise<void>;
  /** Optional narrow handler; network forwarding still requires its own explicit capability. */
  portForward?: (agent: AgentSession, args: Readonly<Record<string, unknown>>) => Promise<unknown>;
  /** Narrow traffic interception handler; this capability is never granted by the default policy. */
  interceptor?: (agent: AgentSession, args: Readonly<Record<string, unknown>>) => Promise<unknown>;
  /** Optional preference-only hook; terminal.theme is never granted by default. */
  setTerminalTheme?: (agent: AgentSession, themeId: string) => Promise<unknown>;
};

function normalizeAbsolutePath(value: string): string | null {
  if (!value.startsWith("/") || value.includes("\0")) return null;
  const parts: string[] = [];
  for (const part of value.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) return null;
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return `/${parts.join("/")}`;
}

function isWithinHome(path: string, home: string): boolean {
  const normalizedPath = normalizeAbsolutePath(path);
  const normalizedHome = normalizeAbsolutePath(home);
  if (!normalizedPath || !normalizedHome) return false;
  return normalizedPath === normalizedHome || normalizedPath.startsWith(`${normalizedHome.replace(/\/$/, "")}/`);
}

function projectRootFor(agent: AgentSession, home: string): string | null {
  if (!agent.projectId) return null;
  try {
    const name = validateProjectName(agent.projectId);
    return `${home.replace(/[\\/]+$/, "")}/projects/${name}`;
  } catch {
    return null;
  }
}

function capabilityForTool(tool: string): AgentCapability | null {
  if (tool === "fs.write" || tool === "fs.mkdir") return "filesystem.write";
  if (tool === "env.home" || tool.startsWith("fs.")) return "filesystem";
  if (tool === "terminal.open" || tool === "shell.exec") return "terminal";
  if (tool === "network.portforward") return "network.portforward";
  if (tool === "network.interceptor") return "network.intercept";
  if (tool === "terminal.theme") return "terminal.theme";
  if (tool === "device.automation_loop") return "adb";
  if (tool.startsWith("android.toolchain.")) return "android.toolchain";
  if (tool.startsWith("device.adb.")) return "device.adb";
  if (tool.startsWith("device.accessibility.")) return "device.accessibility";
  if (tool.startsWith("device.virtualdisplay.")) return "device.virtualdisplay";
  if (tool === "checkpoint.revert") return "checkpoint.revert";
  if (tool === "manifest.write") return "manifest.write";
  return null;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function isSensitiveListedPath(value: string): boolean {
  const normalized = value.replace(/\\/g, "/");
  const leaf = normalized.split("/").pop()?.toLowerCase() ?? "";
  if (/^\.env\.(?:example|sample|template|dist)$/.test(leaf)) return false;
  return /(?:^|\/)\.git(?:\/|$)/i.test(normalized) ||
    /(?:^|\/)\.env(?:\.[^/]*)?(?:\/|$)/i.test(normalized) ||
    /(?:^|\/)\.envrc(?:\.[^/]*)?(?:\/|$)/i.test(normalized) ||
    /(?:^|\/)(?:\.ssh|\.npmrc|\.pypirc|\.netrc|\.git-credentials|secrets?|credentials?)(?:\.[^/]*)?(?:\/|$)/i.test(normalized) ||
    /(?:^|\/)[^/]*(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|private[_-]?key|credential|secret)[^/]*(?:\.[^/]*)?$/i.test(normalized) ||
    /\.(?:pem|key|p12|pfx|jks|keystore)$/i.test(normalized);
}

export class AgentManager {
  private readonly agents = new Map<string, AgentSession>();
  private readonly activeExecutions = new Map<string, Set<AbortController>>();
  private readonly stoppingAgents = new Set<string>();
  private host: AgentHostHooks = {};

  constructor(private readonly environment: ExecutionEnvironment) {}

  private commandReferencesSensitivePath(command: string): boolean {
    return command.split(/[\s"'`=<>|;&]+/).filter(Boolean).some((token) => isSensitiveListedPath(token));
  }

  private async resolveIsolatedPath(path: string, home: string): Promise<string | null> {
    if (!isWithinHome(path, home)) return null;
    if (!this.environment.resolvePath) return path;
    try {
      const [canonicalHome, canonicalPath] = await Promise.all([
        this.environment.resolvePath(home),
        this.environment.resolvePath(path),
      ]);
      return isWithinHome(canonicalPath, canonicalHome) ? canonicalPath : null;
    } catch {
      return null;
    }
  }

  private async resolveProjectPath(path: string, agent: AgentSession, home: string): Promise<string | null> {
    if (agent.projectRoot) {
      if (!this.environment.resolvePath) return null;
      try {
        const [canonicalHome, canonicalRoot] = await Promise.all([
          this.environment.resolvePath(home),
          this.environment.resolvePath(agent.projectRoot),
        ]);
        if (canonicalRoot === canonicalHome || !isWithinHome(canonicalRoot, canonicalHome)) return null;
        return this.resolveIsolatedPath(path, canonicalRoot);
      } catch {
        return null;
      }
    }
    const root = projectRootFor(agent, home);
    if (!root || !this.environment.resolvePath) return null;
    try {
      const projectName = validateProjectName(agent.projectId || "");
      const projects = `${home.replace(/[\\/]+$/, "")}/projects`;
      const [canonicalHome, canonicalProjects, canonicalRoot] = await Promise.all([
        this.environment.resolvePath(home),
        this.environment.resolvePath(projects),
        this.environment.resolvePath(root),
      ]);
      const expectedRoot = `${canonicalProjects.replace(/[\\/]+$/, "")}/${projectName}`;
      if (!isWithinHome(canonicalProjects, canonicalHome) || canonicalRoot !== expectedRoot) return null;
      return this.resolveIsolatedPath(path, canonicalRoot);
    } catch {
      return null;
    }
  }

  setHostHooks(hooks: AgentHostHooks): void {
    this.host = { ...this.host, ...hooks };
  }

  create(input?: {
    id?: string;
    sessionId?: string;
    projectId?: string;
    projectRoot?: string;
    policy?: Partial<AgentPolicy>;
  }): AgentSession {
    const id = input?.id ?? `agent-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    if (this.agents.has(id)) {
      throw new Error(`Agent already exists: ${id}`);
    }
    const policy: AgentPolicy = {
      ...DEFAULT_AGENT_POLICY,
      ...input?.policy,
      allowedCapabilities:
        input?.policy?.allowedCapabilities ?? DEFAULT_AGENT_POLICY.allowedCapabilities,
    };
    const session: AgentSession = {
      id,
      sessionId: input?.sessionId,
      projectId: input?.projectId,
      projectRoot: input?.projectRoot,
      policy,
      createdAt: Date.now(),
      status: "idle",
    };
    this.agents.set(id, session);
    return session;
  }

  get(id: string): AgentSession | undefined {
    return this.agents.get(id);
  }

  list(): AgentSession[] {
    return [...this.agents.values()];
  }

  async execute(agentId: string, request: AgentExecRequest): Promise<AgentExecResult> {
    const agent = this.agents.get(agentId);
    const started = Date.now();
    if (!agent) {
      return { ok: false, error: `Unknown agent: ${agentId}`, durationMs: 0 };
    }
    if (agent.status === "stopped") {
      return { ok: false, error: "AGENT_STOPPED", durationMs: Date.now() - started };
    }
    if (this.stoppingAgents.has(agentId)) {
      return { ok: false, error: "AGENT_STOPPING", durationMs: Date.now() - started };
    }
    const active = this.activeExecutions.get(agentId) ?? new Set<AbortController>();
    const concurrencyLimit = Math.max(1, Math.floor(agent.policy.maxConcurrentTools || 1));
    if (active.size >= concurrencyLimit) {
      return { ok: false, error: `AGENT_CONCURRENCY_LIMIT:${concurrencyLimit}`, durationMs: Date.now() - started };
    }
    const requiredCapability = capabilityForTool(request.tool);
    if (requiredCapability && request.capability !== requiredCapability) {
      return { ok: false, error: `TOOL_CAPABILITY_MISMATCH:${request.tool}:${requiredCapability}`, durationMs: Date.now() - started };
    }
    if (!agent.policy.allowedCapabilities.includes(request.capability)) {
      return {
        ok: false,
        error: `Capability denied: ${request.capability}`,
        durationMs: Date.now() - started,
      };
    }
    const controller = new AbortController();
    active.add(controller);
    this.activeExecutions.set(agentId, active);
    agent.status = "running";
    const ensureActive = () => {
      if (controller.signal.aborted) throw new Error("ABORTED");
    };
    const markIdle = () => {
      if (agent.status === "stopped" || agent.status === "error") return;
      agent.status = active.size > 1 ? "running" : "idle";
    };
    let activeTaskId: string | undefined;
    const finishTask = async (ok: boolean, error?: string) => {
      if (!activeTaskId) return;
      const taskId = activeTaskId;
      activeTaskId = undefined;
      try { await this.host.afterTask?.(agent, taskId, { ok, ...(error ? { error: error.slice(0, 240) } : {}) }); } catch { /* reporting/restart hooks must not fail an already completed task */ }
    };
    try {
      const home = String(await Promise.resolve(this.environment.getHome()));
      ensureActive();

      if (request.tool === "env.home") {
        markIdle();
        return { ok: true, output: home, durationMs: Date.now() - started };
      }

      if (request.tool === "network.portforward") {
        if (!this.host.portForward) { markIdle(); return { ok: false, error: "PORT_FORWARD_HOST_UNAVAILABLE", durationMs: Date.now() - started }; }
        const action = request.args?.action;
        if (action !== "list" && action !== "add" && action !== "remove") { markIdle(); return { ok: false, error: "PORT_FORWARD_ACTION_INVALID", durationMs: Date.now() - started }; }
        ensureActive();
        const result = await this.host.portForward(agent, request.args ?? {});
        ensureActive(); markIdle();
        return { ok: true, output: typeof result === "string" ? result : JSON.stringify(result), durationMs: Date.now() - started };
      }

      if (request.tool === "network.interceptor") {
        if (!this.host.interceptor) { markIdle(); return { ok: false, error: "INTERCEPTOR_HOST_UNAVAILABLE", durationMs: Date.now() - started }; }
        const action = request.args?.action;
        if (action !== "command" && action !== "enable" && action !== "disable" && action !== "last" && action !== "detail" && action !== "rule-add" && action !== "rule-toggle" && action !== "rule-delete" && action !== "rules-disable" && action !== "replay") { markIdle(); return { ok: false, error: "INTERCEPTOR_ACTION_INVALID", durationMs: Date.now() - started }; }
        ensureActive();
        const result = await this.host.interceptor(agent, request.args ?? {});
        ensureActive(); markIdle();
        const output = typeof result === "string" ? result : JSON.stringify(result);
        return { ok: true, output: (output ?? "null").slice(0, 32_000), durationMs: Date.now() - started };
      }

      if (request.tool === "terminal.theme") {
        const themeId = request.args?.themeId;
        if (typeof themeId !== "string" || themeId.length > 80) { markIdle(); return { ok: false, error: "TERMINAL_THEME_ID_INVALID", durationMs: Date.now() - started }; }
        if (!this.host.setTerminalTheme) { markIdle(); return { ok: false, error: "TERMINAL_THEME_HOST_UNAVAILABLE", durationMs: Date.now() - started }; }
        ensureActive(); const result = await this.host.setTerminalTheme(agent, themeId); ensureActive(); markIdle();
        return { ok: true, output: typeof result === "string" ? result : JSON.stringify(result), durationMs: Date.now() - started };
      }

      if (request.tool === "fs.exists" && typeof request.args?.path === "string") {
        const path = String(request.args.path);
        const isolate = agent.policy.homeIsolation || agent.policy.projectIsolation;
        const isolatedPath = agent.policy.projectIsolation
          ? await this.resolveProjectPath(path, agent, home)
          : agent.policy.homeIsolation ? await this.resolveIsolatedPath(path, home) : path;
        if (isolate && !isolatedPath) {
          markIdle();
          return {
            ok: false,
            error: agent.policy.projectIsolation ? "PROJECT isolation: path outside agent project" : "HOME isolation: path outside AI_BUILDER_HOME",
            durationMs: Date.now() - started,
          };
        }
        ensureActive();
        const exists = await this.environment.exists(isolatedPath || path);
        ensureActive();
        markIdle();
        return {
          ok: true,
          output: exists ? "true" : "false",
          durationMs: Date.now() - started,
        };
      }

      if (request.tool === "fs.list" && typeof request.args?.path === "string") {
        const path = String(request.args.path);
        const requestedDepth = request.args.maxDepth === undefined ? 2 : Number(request.args.maxDepth);
        if (path.length > 800 || path.includes("\\") || path.includes("\0") || !Number.isInteger(requestedDepth) || requestedDepth < 1 || requestedDepth > 4) {
          markIdle();
          return { ok: false, error: "FS_LIST_ARGUMENT_INVALID", durationMs: Date.now() - started };
        }
        const isolate = agent.policy.homeIsolation || agent.policy.projectIsolation;
        const isolatedPath = agent.policy.projectIsolation
          ? await this.resolveProjectPath(path, agent, home)
          : agent.policy.homeIsolation ? await this.resolveIsolatedPath(path, home) : path;
        if (isolate && !isolatedPath) {
          markIdle();
          return { ok: false, error: agent.policy.projectIsolation ? "PROJECT isolation: path outside agent project" : "HOME isolation: path outside AI_BUILDER_HOME", durationMs: Date.now() - started };
        }
        const directory = isolatedPath || path;
        ensureActive();
        const result = await this.environment.exec(
          `find ${shellQuote(directory)} -maxdepth ${requestedDepth} -mindepth 1 -type f -print 2>/dev/null | head -n 200`,
          { cwd: directory, timeoutMs: 15_000, signal: controller.signal, preserveOutput: true },
        );
        ensureActive();
        if (result.exitCode !== 0) {
          markIdle();
          return { ok: false, error: "FS_LIST_FAILED", durationMs: Date.now() - started };
        }
        const entries = result.stdout.split(/\r?\n/).map((entry) => entry.trim())
          .filter((entry) => entry.startsWith(`${directory.replace(/[\\/]+$/, "")}/`) && entry.length <= 1000 && !isSensitiveListedPath(entry))
          .slice(0, 150);
        markIdle();
        return { ok: true, output: entries.join("\n").slice(0, 20_000), durationMs: Date.now() - started };
      }

      if (request.tool === "fs.mkdir" && typeof request.args?.path === "string") {
        const path = String(request.args.path);
        const isolate = agent.policy.homeIsolation || agent.policy.projectIsolation;
        const isolatedPath = agent.policy.projectIsolation
          ? await this.resolveProjectPath(path, agent, home)
          : agent.policy.homeIsolation ? await this.resolveIsolatedPath(path, home) : path;
        if (isolate && !isolatedPath) {
          markIdle();
          return {
            ok: false,
            error: agent.policy.projectIsolation ? "PROJECT isolation: path outside agent project" : "HOME isolation: path outside AI_BUILDER_HOME",
            durationMs: Date.now() - started,
          };
        }
        if (!this.host.beforeFileWrite) {
          markIdle();
          return { ok: false, error: "DIRECTORY_CREATE_CHECKPOINT_UNAVAILABLE", durationMs: Date.now() - started };
        }
        ensureActive();
        await this.host.beforeFileWrite(agent, isolatedPath || path);
        ensureActive();
        await this.environment.mkdir(isolatedPath || path);
        ensureActive();
        markIdle();
        return { ok: true, output: path, durationMs: Date.now() - started };
      }

      if (request.tool === "fs.read" && typeof request.args?.path === "string") {
        const path = String(request.args.path);
        const isolate = agent.policy.homeIsolation || agent.policy.projectIsolation;
        const isolatedPath = agent.policy.projectIsolation
          ? await this.resolveProjectPath(path, agent, home)
          : agent.policy.homeIsolation ? await this.resolveIsolatedPath(path, home) : path;
        if (isolate && !isolatedPath) {
          markIdle();
          return {
            ok: false,
            error: agent.policy.projectIsolation ? "PROJECT isolation: path outside agent project" : "HOME isolation: path outside AI_BUILDER_HOME",
            durationMs: Date.now() - started,
          };
        }
        if (isSensitiveListedPath(path) || (isolatedPath && isSensitiveListedPath(isolatedPath))) {
          markIdle();
          return { ok: false, error: "SENSITIVE_FILE_READ_BLOCKED", durationMs: Date.now() - started };
        }
        ensureActive();
        const content = await this.environment.read(isolatedPath || path);
        ensureActive();
        markIdle();
        return { ok: true, output: content, durationMs: Date.now() - started };
      }

      if (request.tool === "fs.write" && typeof request.args?.path === "string" && typeof request.args?.content === "string") {
        const path = String(request.args.path);
        const content = String(request.args.content);
        if (path.length > 800 || path.split(/[\\/]/).includes("..") || content.length > 512_000 || content.includes("\0")) {
          markIdle();
          return { ok: false, error: "FS_WRITE_ARGUMENT_INVALID", durationMs: Date.now() - started };
        }
        const isolate = agent.policy.homeIsolation || agent.policy.projectIsolation;
        const isolatedPath = agent.policy.projectIsolation
          ? await this.resolveProjectPath(path, agent, home)
          : agent.policy.homeIsolation ? await this.resolveIsolatedPath(path, home) : path;
        if (isolate && !isolatedPath) {
          markIdle();
          return { ok: false, error: agent.policy.projectIsolation ? "PROJECT isolation: path outside agent project" : "HOME isolation: path outside AI_BUILDER_HOME", durationMs: Date.now() - started };
        }
        if (!this.host.beforeFileWrite) {
          markIdle();
          return { ok: false, error: "FILE_WRITE_CHECKPOINT_UNAVAILABLE", durationMs: Date.now() - started };
        }
        ensureActive();
        await this.host.beforeFileWrite(agent, isolatedPath || path);
        ensureActive();
        const target = isolatedPath || path;
        const parent = target.slice(0, Math.max(1, target.lastIndexOf("/"))) || "/";
        await this.environment.mkdir(parent);
        ensureActive();
        await this.environment.write(target, content);
        ensureActive();
        markIdle();
        return { ok: true, output: "file written after checkpoint", durationMs: Date.now() - started };
      }

      if (request.tool === "checkpoint.revert") {
        const taskId = typeof request.args?.taskId === "string" ? request.args.taskId : "";
        if (!taskId || !this.host.revertCheckpoint) { markIdle(); return { ok: false, error: "CHECKPOINT_REVERT_UNAVAILABLE", durationMs: Date.now() - started }; }
        ensureActive(); await this.host.revertCheckpoint(agent, taskId); ensureActive(); markIdle();
        return { ok: true, output: "checkpoint restored", durationMs: Date.now() - started };
      }

      if (request.tool === "manifest.write") {
        const content = typeof request.args?.content === "string" ? request.args.content : "";
        if (!content || !this.host.writeManifest) { markIdle(); return { ok: false, error: "MANIFEST_WRITE_UNAVAILABLE", durationMs: Date.now() - started }; }
        const rootCandidate = agent.projectRoot ?? (agent.projectId ? projectRootFor(agent, home) : null);
        const projectRoot = rootCandidate ? await this.resolveProjectPath(rootCandidate, agent, home) : null;
        if (!projectRoot) { markIdle(); return { ok: false, error: "MANIFEST_PROJECT_ISOLATION_FAILED", durationMs: Date.now() - started }; }
        if (!this.host.beforeFileWrite) { markIdle(); return { ok: false, error: "MANIFEST_CHECKPOINT_UNAVAILABLE", durationMs: Date.now() - started }; }
        await this.host.beforeFileWrite(agent, `${projectRoot.replace(/[\\/]+$/, "")}/.aib/runtime.yaml`);
        ensureActive(); await this.host.writeManifest(agent, content); ensureActive(); markIdle();
        return { ok: true, output: "runtime manifest updated", durationMs: Date.now() - started };
      }

      if (request.tool === "android.toolchain.run") {
        const untrustedRoot = agent.projectRoot ?? (agent.projectId ? projectRootFor(agent, home) : null);
        const projectRoot = untrustedRoot ? await this.resolveProjectPath(untrustedRoot, agent, home) : null;
        if (!projectRoot) { markIdle(); return { ok: false, error: "ANDROID_TOOLCHAIN_PROJECT_ISOLATION_FAILED", durationMs: Date.now() - started }; }
        if (!this.host.beforeFileWrite) { markIdle(); return { ok: false, error: "ANDROID_TOOLCHAIN_CHECKPOINT_UNAVAILABLE", durationMs: Date.now() - started }; }
        if (!this.host.runAndroidToolchain) { markIdle(); return { ok: false, error: "ANDROID_TOOLCHAIN_HOST_UNAVAILABLE", durationMs: Date.now() - started }; }
        ensureActive();
        await this.host.beforeFileWrite(agent, `${projectRoot.replace(/[\\/]+$/, "")}/.aib-toolchain-build`);
        ensureActive();
        const value = await this.host.runAndroidToolchain(agent, request.args ?? {}, projectRoot, controller.signal);
        ensureActive();
        markIdle();
        return { ok: true, output: JSON.stringify(value), durationMs: Date.now() - started };
      }

      if (request.tool === "terminal.open") {
        if (!agent.policy.allowedCapabilities.includes("terminal")) {
          markIdle();
          return {
            ok: false,
            error: "Capability denied: terminal",
            durationMs: Date.now() - started,
          };
        }
        let projectId =
          (typeof request.args?.projectId === "string"
            ? request.args.projectId
            : agent.projectId) ?? "default";
        const projectRoot = agent.policy.projectIsolation ? projectRootFor(agent, home) : null;
        if (agent.policy.projectIsolation && (!projectRoot || projectId !== agent.projectId)) {
          markIdle();
          return { ok: false, error: "PROJECT isolation: terminal target must match agent project", durationMs: Date.now() - started };
        }
        try { projectId = validateProjectName(projectId); } catch {
          markIdle();
          return { ok: false, error: "INVALID_PROJECT_NAME", durationMs: Date.now() - started };
        }
        if ((agent.policy.homeIsolation || agent.policy.projectIsolation) && !this.host.openIsolatedTerminalForProject) {
          markIdle();
          return { ok: false, error: "ISOLATED_TERMINAL_UNAVAILABLE", durationMs: Date.now() - started };
        }
        if (!this.host.openTerminalForProject && !this.host.openIsolatedTerminalForProject) {
          markIdle();
          return {
            ok: false,
            error: "terminal host not configured",
            durationMs: Date.now() - started,
          };
        }
        const terminalRoot = projectRoot
          ? await this.resolveProjectPath(projectRoot, agent, home)
          : agent.policy.homeIsolation ? home : null;
        if ((agent.policy.homeIsolation || agent.policy.projectIsolation) && !terminalRoot) {
          markIdle();
          return { ok: false, error: "ISOLATED_TERMINAL_ROOT_INVALID", durationMs: Date.now() - started };
        }
        ensureActive();
        const term = terminalRoot && this.host.openIsolatedTerminalForProject
          ? await this.host.openIsolatedTerminalForProject(projectId, terminalRoot)
          : await this.host.openTerminalForProject!(projectId);
        ensureActive();
        markIdle();
        return {
          ok: true,
          output: term.id,
          durationMs: Date.now() - started,
        };
      }

      if (/^device\.(?:accessibility|adb|virtualdisplay)\.(?:status|tree|clickText|tap|swipe|inputText|systemKey|pair|connect|list|reconnect|capture|input)$/.test(request.tool)) {
        const needed = capabilityForTool(request.tool)!;
        if (!agent.policy.allowedCapabilities.includes(needed)) { markIdle(); return { ok: false, error: `Capability denied: ${needed}`, durationMs: Date.now() - started }; }
        if (!this.host.runDeviceTool) { markIdle(); return { ok: false, error: "DEVICE_TOOL_HOST_UNAVAILABLE", durationMs: Date.now() - started }; }
        ensureActive(); const value = await this.host.runDeviceTool(request.tool, request.args ?? {}); ensureActive(); markIdle();
        return { ok: true, output: JSON.stringify(value), durationMs: Date.now() - started };
      }

      if (request.tool === "device.automation_loop") {
        if (!agent.policy.allowedCapabilities.includes("adb")) {
          markIdle();
          return { ok: false, error: "Capability denied: adb", durationMs: Date.now() - started };
        }
        if (!this.host.runDeviceAutomation) {
          markIdle();
          return { ok: false, error: "device automation host not configured", durationMs: Date.now() - started };
        }
        const apkPath = typeof request.args?.apkPath === "string" ? request.args.apkPath : "";
        const packageName = typeof request.args?.packageName === "string" ? request.args.packageName : undefined;
        const goal = typeof request.args?.goal === "string" ? request.args.goal : "";
        const vision = request.args?.vision;
        if (!apkPath || !goal || typeof vision !== "function") {
          markIdle();
          return { ok: false, error: "INVALID_DEVICE_AUTOMATION_ARGUMENTS", durationMs: Date.now() - started };
        }
        const result = await this.host.runDeviceAutomation({
          apkPath, packageName, goal,
          maxSteps: typeof request.args?.maxSteps === "number" ? request.args.maxSteps : undefined,
          settleMs: typeof request.args?.settleMs === "number" ? request.args.settleMs : undefined,
          screenshotPath: typeof request.args?.screenshotPath === "string" ? request.args.screenshotPath : undefined,
          vision: vision as DeviceAutomationOptions["vision"],
          signal: controller.signal,
        });
        ensureActive();
        markIdle();
        return { ok: result.ok, output: JSON.stringify(result), durationMs: Date.now() - started };
      }

      if (request.tool === "shell.exec" && typeof request.args?.command === "string") {
        if (!agent.policy.allowedCapabilities.includes("terminal")) {
          markIdle();
          return {
            ok: false,
            error: "Capability denied: terminal",
            durationMs: Date.now() - started,
          };
        }
        const command = String(request.args.command);
        if (this.commandReferencesSensitivePath(command)) {
          markIdle();
          return { ok: false, error: "SENSITIVE_FILE_ACCESS_BLOCKED", durationMs: Date.now() - started };
        }
        const suppliedTaskId = typeof request.args.taskId === "string" ? request.args.taskId : "";
        activeTaskId = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(suppliedTaskId) ? suppliedTaskId : `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const promptSummary = typeof request.args.promptSummary === "string" ? request.args.promptSummary.slice(0, 1000) : "";
        let taskEnv: Record<string, string> | undefined;
        const cwd =
          typeof request.args.cwd === "string" ? String(request.args.cwd) : undefined;
        const isolate = agent.policy.homeIsolation || agent.policy.projectIsolation;
        const projectRoot = agent.policy.projectIsolation ? projectRootFor(agent, home) : null;
        if (agent.policy.projectIsolation && !projectRoot) {
          markIdle();
          return { ok: false, error: "PROJECT isolation: agent project is not configured", durationMs: Date.now() - started };
        }
        const canonicalProjectRoot = projectRoot
          ? await this.resolveProjectPath(projectRoot, agent, home)
          : null;
        const scopeRoot = canonicalProjectRoot || home;
        const isolatedCwd = agent.policy.projectIsolation
          ? await this.resolveProjectPath(cwd || scopeRoot, agent, home)
          : isolate ? await this.resolveIsolatedPath(cwd || scopeRoot, scopeRoot) : cwd;
        if (isolate && !isolatedCwd) {
          markIdle();
          return {
            ok: false,
            error: agent.policy.projectIsolation ? "PROJECT isolation: cwd outside agent project" : "HOME isolation: cwd outside AI_BUILDER_HOME",
            durationMs: Date.now() - started,
          };
        }
        if (isolate && !this.host.runIsolatedShell) {
          markIdle();
          return { ok: false, error: "ISOLATED_SHELL_UNAVAILABLE", durationMs: Date.now() - started };
        }
        await this.host.wakeForTask?.(agent);
        const preparedEnv = await this.host.beforeTask?.(agent, activeTaskId, promptSummary, request);
        taskEnv = preparedEnv && typeof preparedEnv === "object" ? preparedEnv : undefined;
        ensureActive();
        if (isolate && this.host.runIsolatedShell) {
          const result = await this.host.runIsolatedShell(command, { cwd: isolatedCwd || scopeRoot, projectRoot: scopeRoot, env: taskEnv, signal: controller.signal });
          ensureActive();
          await finishTask(result.exitCode === 0, result.stderr);
          markIdle();
          return {
            ok: result.exitCode === 0,
            output: result.stdout ?? "",
            error: result.stderr || (result.exitCode == null ? "SHELL_EXIT_CODE_UNAVAILABLE" : undefined),
            durationMs: Date.now() - started,
          };
        }
        if (this.host.runShell) {
          const result = await this.host.runShell(command, { cwd: isolatedCwd || cwd, env: taskEnv, signal: controller.signal });
          ensureActive();
          await finishTask(result.exitCode === 0, result.stderr);
          markIdle();
          return {
            ok: result.exitCode === 0,
            output: result.stdout ?? "",
            error: result.stderr || (result.exitCode == null ? "SHELL_EXIT_CODE_UNAVAILABLE" : undefined),
            durationMs: Date.now() - started,
          };
        }
        const result = await this.environment.exec(command, { cwd: isolatedCwd || cwd, env: taskEnv, signal: controller.signal });
        ensureActive();
        const rawExitCode = result && typeof result === "object" && "exitCode" in result
          ? (result as { exitCode?: number | null }).exitCode
          : null;
        const exitCode = typeof rawExitCode === "number" ? rawExitCode : null;
        const stdout =
          result && typeof result === "object" && "stdout" in result
            ? String((result as { stdout: string }).stdout)
            : "";
        await finishTask(exitCode === 0, result && typeof result === "object" && "stderr" in result ? String((result as { stderr: string }).stderr) : undefined);
        markIdle();
        return {
          ok: exitCode === 0,
          output: stdout,
          error: exitCode === null ? "SHELL_EXIT_CODE_UNAVAILABLE" : undefined,
          durationMs: Date.now() - started,
        };
      }

      markIdle();
      return {
        ok: false,
        error: `Unsupported tool in skeleton: ${request.tool}`,
        durationMs: Date.now() - started,
      };
    } catch (e) {
      await finishTask(false, e instanceof Error ? e.message : String(e));
      if (!controller.signal.aborted) agent.status = "error";
      return {
        ok: false,
        error: controller.signal.aborted ? "ABORTED" : e instanceof Error ? e.message : String(e),
        durationMs: Date.now() - started,
      };
    } finally {
      active.delete(controller);
      if (active.size === 0) {
        this.activeExecutions.delete(agentId);
        if (this.stoppingAgents.delete(agentId) || controller.signal.aborted) agent.status = "stopped";
        else if (agent.status === "running") markIdle();
      }
    }
  }

  stop(agentId: string): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;
    const active = this.activeExecutions.get(agentId);
    if (!active?.size) {
      agent.status = "stopped";
      return;
    }
    this.stoppingAgents.add(agentId);
    for (const controller of active) controller.abort();
  }

  remove(agentId: string): boolean {
    this.stop(agentId);
    return this.agents.delete(agentId);
  }
}

export function createAgentManager(env: ExecutionEnvironment): AgentManager {
  return new AgentManager(env);
}
