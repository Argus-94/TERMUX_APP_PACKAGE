/**
 * Phase 27: persistent proot container manager.
 * Userspace containers; no root or daemon required.
 */
import type { ExecutionEnvironment } from "../environment/ExecutionEnvironment";
import type { HomeLayout } from "../home/HomeLayout";
import type { ContainerInstance, ContainerImage, ContainerManager, ContainerPolicy, MountSpec } from "./ContainerTypes";
import { validateProjectName } from "../project-manager";
import { buildProotDistroProbeCommand, parseProotDistroProbe } from "../../lib/proot-distro-state";

export type ProotContainerProfile = "debian" | "ubuntu";
export type ProotContainerRecord = ContainerInstance & {
  readonly profile: ProotContainerProfile;
  readonly rootfsPath?: string;
  readonly lastExitCode?: number;
  readonly lastExecAt?: number;
};
export type ContainerExecResult = {
  exitCode: number; stdout: string; stderr: string; command: string; durationMs: number;
};

const MAX_TIMEOUT_MS = 15 * 60_000;
const MIN_TIMEOUT_MS = 1000;
const ALLOWED_COMMANDS = new Set([
  "pwd", "ls", "cat", "head", "tail", "find", "grep", "sed", "awk",
  "node", "npm", "pnpm", "npx", "python", "python3", "pip", "pip3", "git", "java", "javac",
  "gradle", "./gradlew", "which", "uname", "env", "mkdir", "cp", "mv", "rm", "touch",
]);

function shellQuote(value: string): string {
  if (value.includes("\0") || value.length > 4096) throw new Error("Invalid container argument");
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}
function safeName(value: string): string {
  const v = value.trim().replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 64);
  if (!v) throw new Error("CONTAINER_NAME_REQUIRED");
  return v;
}
function isSafeWorkspaceCwd(cwd: string): boolean {
  if (!(cwd === "/workspace" || cwd.startsWith("/workspace/"))) return false;
  return !cwd.split("/").includes("..");
}

function profileFromImage(imageId: string): ProotContainerProfile {
  if (imageId.startsWith("debian:")) return "debian";
  if (imageId.startsWith("ubuntu:")) return "ubuntu";
  throw new Error(`Unsupported proot image: ${imageId}`);
}

export class ProotContainerManager implements ContainerManager {
  private readonly images = new Map<string, ContainerImage>();
  private readonly instances = new Map<string, ProotContainerRecord>();
  private readonly activeExecutions = new Set<string>();
  private loaded = false;
  private readonly statePath: string;

  constructor(private readonly environment: ExecutionEnvironment, private readonly home: HomeLayout) {
    this.statePath = `${home.metadata}/proot-containers.json`;
  }

  registerImage(image: ContainerImage): void { this.images.set(image.id, image); }
  listImages(): ContainerImage[] { return [...this.images.values()]; }
  listInstances(): ContainerInstance[] { this.ensureLoadedSyncSafe(); return [...this.instances.values()]; }
  get(instanceId: string): ProotContainerRecord | undefined { this.ensureLoadedSyncSafe(); return this.instances.get(instanceId); }
  async getAsync(instanceId: string): Promise<ProotContainerRecord | undefined> { await this.load(); return this.instances.get(instanceId); }
  isExecuting(instanceId: string): boolean { return this.activeExecutions.has(instanceId); }

  /** Resolve the most recently used persisted container for an existing project. */
  async findByProjectId(projectId: string): Promise<ProotContainerRecord | undefined> {
    const safeProjectId = validateProjectName(projectId);
    await this.load();
    return [...this.instances.values()]
      .filter((instance) => instance.projectId === safeProjectId)
      .sort((a, b) => Number(b.lastExecAt !== undefined) - Number(a.lastExecAt !== undefined)
        || (b.lastExecAt ?? b.createdAt) - (a.lastExecAt ?? a.createdAt))[0];
  }

  async create(input: { imageId: string; name: string; mounts?: MountSpec[]; policy?: ContainerPolicy; projectId?: string }): Promise<ContainerInstance> {
    await this.load();
    const image = this.images.get(input.imageId);
    if (!image) throw new Error(`Unknown image: ${input.imageId}`);
    const profile = profileFromImage(input.imageId);
    const projectId = input.projectId ? validateProjectName(input.projectId) : undefined;
    if (!projectId && !(input.mounts ?? []).some((m) => m.containerPath === "/workspace")) {
      throw new Error("PROJECT_OR_WORKSPACE_MOUNT_REQUIRED");
    }
    const id = `proot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const instance: ProotContainerRecord = {
      id, imageId: input.imageId, name: safeName(input.name), status: "created",
      mounts: input.mounts ? [...input.mounts] : [], policy: input.policy ?? "PROJECT_ONLY",
      projectId, createdAt: Date.now(), profile,
      metadata: { backend: "proot-distro", lifecycle: "ephemeral-process", rootfsState: "unverified" },
    };
    this.instances.set(id, instance);
    await this.save();
    return instance;
  }

  async start(instanceId: string): Promise<void> {
    await this.load();
    if (this.activeExecutions.has(instanceId)) throw new Error("CONTAINER_BUSY");
    const inst = this.require(instanceId);
    const state = await this.inspectProfile(inst.profile, 20_000);
    if (state.healthy) {
      this.instances.set(instanceId, { ...inst, status: "running", metadata: { ...inst.metadata, rootfsState: "healthy" } });
      await this.save();
      return;
    }
    if (state.installed !== false) {
      const kind = state.installed === true ? "installed-login-failed" : "unverified";
      const nextStatus = state.installed === true ? "error" : "unknown";
      this.instances.set(instanceId, { ...inst, status: nextStatus, metadata: { ...inst.metadata, rootfsState: kind } });
      await this.save();
      throw new Error(state.installed === true
        ? `PROOT_PROFILE_INSTALLED_LOGIN_FAILED:${inst.profile}; rootfs preserved; no reinstall/reset attempted`
        : `PROOT_PROFILE_STATE_UNVERIFIED:${inst.profile}; no install/reset attempted`);
    }
    // Runtime has no qualified embedded distro image/feed; refuse downloads.
    this.instances.set(instanceId, { ...inst, status: "unknown", metadata: { ...inst.metadata, rootfsState: "unsupported-install" } });
    await this.save();
    throw new Error(`PROOT_PROFILE_INSTALL_UNSUPPORTED:${inst.profile}; no qualified embedded distro image/feed; no external download attempted`);
    this.instances.set(instanceId, { ...inst, status: "running", metadata: { ...inst.metadata, rootfsState: "healthy" } });
    await this.save();
  }

  async stop(instanceId: string): Promise<void> {
    await this.load();
    if (this.activeExecutions.has(instanceId)) throw new Error("CONTAINER_BUSY");
    const inst = this.require(instanceId);
    this.instances.set(instanceId, { ...inst, status: "stopped" });
    await this.save();
  }

  async restart(instanceId: string): Promise<void> { await this.stop(instanceId); await this.start(instanceId); }

  async remove(instanceId: string): Promise<void> {
    await this.load();
    if (this.activeExecutions.has(instanceId)) throw new Error("CONTAINER_BUSY");
    this.instances.delete(instanceId);
    await this.save();
  }

  async exec(instanceId: string, command: string, args: readonly string[] = [], options: { cwd?: string; timeoutMs?: number } = {}): Promise<ContainerExecResult> {
    await this.load();
    const inst = this.require(instanceId);
    if (inst.status !== "running") throw new Error("CONTAINER_NOT_RUNNING");
    const base = command.trim();
    if (!ALLOWED_COMMANDS.has(base)) throw new Error(`CONTAINER_COMMAND_NOT_ALLOWED: ${command}`);
    const cwd = options.cwd ?? "/workspace";
    if (!isSafeWorkspaceCwd(cwd)) throw new Error("CONTAINER_CWD_MUST_BE_WORKSPACE");
    const timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, options.timeoutMs ?? 120_000));
    const safeArgs = args.map(shellQuote);
    const inner = `${command} ${safeArgs.join(" ")}`.trim();
    const started = Date.now();
    if (this.activeExecutions.has(instanceId)) throw new Error("CONTAINER_BUSY");
    this.activeExecutions.add(instanceId);
    try {
      const mounts = await this.normalizedMounts(inst);
      const bindArgs = mounts.flatMap((mount) => ["--bind", `${mount.hostPath}:${mount.containerPath}`]);
      const hostCommand = [
        "proot-distro", "login", inst.profile, ...bindArgs, "--", "sh", "-c",
        `cd ${shellQuote(cwd)} && exec ${inner}`,
      ].map(shellQuote).join(" ");
      const raw = await this.environment.exec(hostCommand, {
        cwd: this.home.root,
        // Keep Termux's native HOME for host-side proot-distro; app data lives in AI_BUILDER_HOME.
        env: { AI_BUILDER_HOME: this.home.root, AIB_CONTAINER_ID: inst.id },
        timeoutMs,
      });
      const r = raw as { exitCode?: number; stdout?: string; stderr?: string };
      const exitCode = typeof r.exitCode === "number" && Number.isSafeInteger(r.exitCode) ? r.exitCode : -1;
      const result = { exitCode, stdout: String(r.stdout ?? ""), stderr: String(r.stderr ?? ""), command: hostCommand, durationMs: Date.now() - started };
      this.instances.set(instanceId, { ...inst, status: result.exitCode === 0 ? "running" : "error", lastExitCode: result.exitCode, lastExecAt: Date.now() });
      await this.save();
      return result;
    } finally {
      this.activeExecutions.delete(instanceId);
    }
  }

  async inspect(instanceId: string): Promise<ProotContainerRecord> {
    await this.load();
    const inst = this.require(instanceId);
    const state = await this.inspectProfile(inst.profile, 20_000);
    const next: ProotContainerRecord = {
      ...inst,
      status: state.healthy ? "running" : state.installed === true ? "error" : "unknown",
      metadata: { ...inst.metadata, rootfsState: state.healthy ? "healthy" : state.installed === true ? "installed-login-failed" : "unverified" },
    };
    this.instances.set(instanceId, next);
    await this.save();
    return next;
  }

  private async inspectProfile(profile: ProotContainerProfile, timeoutMs: number) {
    try {
      const raw = await this.environment.exec(buildProotDistroProbeCommand(profile), { cwd: this.home.root, timeoutMs });
      const result = raw as { exitCode?: number; code?: number; stdout?: string; stderr?: string };
      const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
      return parseProotDistroProbe(profile, output, Number(result.exitCode ?? result.code ?? -1));
    } catch (error) {
      return parseProotDistroProbe(profile, error instanceof Error ? error.message : String(error), -1);
    }
  }

  private require(id: string): ProotContainerRecord { const inst = this.instances.get(id); if (!inst) throw new Error(`Unknown container: ${id}`); return inst; }
  private async normalizedMounts(inst: ProotContainerRecord): Promise<MountSpec[]> {
    const projectRoot = inst.projectId ? `${this.home.projects.replace(/[\\/]+$/, "")}/${inst.projectId}` : undefined;
    const configured = inst.mounts.length ? inst.mounts : (projectRoot ? [{ hostPath: projectRoot, containerPath: "/workspace", mode: "rw" as const }] : []);
    const projectsRoot = this.home.projects.replace(/[\\/]+$/, "");
    const canonicalProjectsRoot = await this.resolveExistingMountPath(projectsRoot);
    return Promise.all(configured.map(async (mount) => {
      const host = mount.hostPath.replace(/[\\/]+$/, "");
      if (!host || host.includes("\\") || host.split("/").includes("..") || !(host === projectsRoot || host.startsWith(`${projectsRoot}/`))) throw new Error("CONTAINER_MOUNT_HOST_OUTSIDE_PROJECTS");
      const canonicalHost = await this.resolveExistingMountPath(host);
      const hostIsWithinProjects = canonicalProjectsRoot === "/"
        ? canonicalHost.startsWith("/")
        : canonicalHost === canonicalProjectsRoot || canonicalHost.startsWith(`${canonicalProjectsRoot}/`);
      if (!hostIsWithinProjects) throw new Error("CONTAINER_MOUNT_HOST_OUTSIDE_PROJECTS");
      const destination = mount.containerPath;
      if (!destination || destination.includes("\\") || /[\0-\x1f\x7f:]/.test(destination)
        || !(destination === "/workspace" || destination.startsWith("/workspace/"))
        || destination.split("/").some((segment) => segment === ".." || segment === ".")) throw new Error("CONTAINER_MOUNT_PATH_INVALID");
      if (!/^(ro|rw)$/.test(mount.mode)) throw new Error("CONTAINER_MOUNT_MODE_INVALID");
      return { ...mount, hostPath: canonicalHost };
    }));
  }
  private async resolveExistingMountPath(candidate: string): Promise<string> {
    if (!candidate.startsWith("/") || candidate.includes("\\") || /[\0-\x1f\x7f:]/.test(candidate)) throw new Error("CONTAINER_MOUNT_PATH_INVALID");
    try {
      if (!(await this.environment.exists(candidate))) throw new Error("CONTAINER_MOUNT_HOST_NOT_FOUND");
      let canonical: string;
      if (this.environment.resolvePath) canonical = await this.environment.resolvePath(candidate);
      else {
        const result = await this.environment.exec(`realpath -e -- ${shellQuote(candidate)}`, { cwd: this.home.root, timeoutMs: 10_000 });
        if (Number(result.exitCode ?? 1) !== 0) throw new Error("REALPATH_FAILED");
        canonical = String(result.stdout ?? "").replace(/\r?\n$/, "");
      }
      if (!canonical.startsWith("/") || /[\0-\x1f\x7f]/.test(canonical)) throw new Error("REALPATH_INVALID");
      return canonical.replace(/\/+$/, "") || "/";
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("CONTAINER_MOUNT_")) throw error;
      throw new Error("CONTAINER_MOUNT_REALPATH_FAILED");
    }
  }

  private async commandExists(command: string): Promise<boolean> {
    try { const r = await this.environment.exec(`command -v ${shellQuote(command)}`, { timeoutMs: 5000 }); return Number((r as { exitCode?: number }).exitCode ?? 1) === 0; } catch { return false; }
  }
  private ensureLoadedSyncSafe(): void { /* persisted state is loaded by async operations; constructor remains side-effect free */ }
  private async load(): Promise<void> {
    if (this.loaded) return;
    let exists: boolean;
    try {
      exists = await this.environment.exists(this.statePath);
    } catch {
      throw new Error("PROOT_CONTAINER_STATE_LOAD_FAILED");
    }
    if (!exists) { this.loaded = true; return; }
    let parsed: unknown;
    try {
      const raw = await this.environment.read(this.statePath);
      parsed = JSON.parse(raw) as unknown;
    } catch {
      throw new Error("PROOT_CONTAINER_STATE_LOAD_FAILED");
    }
    if (!Array.isArray(parsed)) throw new Error("PROOT_CONTAINER_STATE_INVALID");
    const next = new Map<string, ProotContainerRecord>();
    try {
      for (const item of parsed) {
        if (!item || typeof item !== "object") throw new Error("INVALID_RECORD");
        const record = item as Partial<ProotContainerRecord>;
        if (typeof record.id !== "string" || !/^[A-Za-z0-9._:-]{1,160}$/.test(record.id)
          || typeof record.imageId !== "string" || typeof record.name !== "string"
          || !["created", "running", "stopped", "error", "unknown"].includes(String(record.status))
          || (record.profile !== "debian" && record.profile !== "ubuntu")
          || !Array.isArray(record.mounts) || !Number.isFinite(record.createdAt)) throw new Error("INVALID_RECORD");
        if (record.projectId !== undefined) validateProjectName(record.projectId);
        const persisted = record as ProotContainerRecord;
        // proot launches are ephemeral. A persisted `running` bit is only old
        // metadata and must be re-probed before a guest can be used again.
        next.set(record.id, persisted.status === "running"
          ? { ...persisted, status: "unknown", metadata: { ...persisted.metadata, rootfsState: "unverified" } }
          : persisted);
      }
    } catch {
      throw new Error("PROOT_CONTAINER_STATE_INVALID");
    }
    this.instances.clear();
    for (const [id, record] of next) this.instances.set(id, record);
    this.loaded = true;
  }
  private async save(): Promise<void> {
    await this.environment.mkdir(this.home.metadata);
    await this.environment.write(this.statePath, JSON.stringify([...this.instances.values()], null, 2));
  }
}

export function createProotContainerManager(environment: ExecutionEnvironment, home: HomeLayout): ProotContainerManager {
  return new ProotContainerManager(environment, home);
}
