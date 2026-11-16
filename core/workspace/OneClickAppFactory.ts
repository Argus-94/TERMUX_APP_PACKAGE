/**
 * Phase 36: One-Click App Factory.
 *
 * Bounded end-to-end orchestration:
 * request -> project -> container -> scaffold -> coding brain/agent ->
 * Android prebuild -> APK -> optional real-device QA/repair -> final APK.
 *
 * This module never gives the LLM arbitrary shell access. All edits remain
 * behind AICodingAgent and all container commands remain behind the existing
 * ProotContainerManager allowlist.
 */
import type { RuntimeFacade } from "../RuntimeFacade";
import type { WorkspaceBuildTemplate } from "./AIWorkspaceBuilder";
import type { VisionAnalyzer, DeviceAutomationResult } from "../device/DeviceAutomationAgent";
import { validateProjectName } from "../project-manager";
import { runAssembleDebug, type BuildAttemptResult } from "../../lib/build-loop";

export type OneClickAppFactoryRequest = {
  readonly name: string;
  readonly prompt: string;
  readonly template?: WorkspaceBuildTemplate;
  readonly packageName?: string;
  readonly deviceGoal?: string;
  readonly vision?: VisionAnalyzer;
  readonly runDeviceQA?: boolean;
  readonly maxCodingIterations?: number;
  readonly maxBuildAttempts?: number;
};

export type FactoryStage = "project" | "container" | "scaffold" | "coding" | "android_build" | "device_qa" | "complete";
export type FactoryStageResult = {
  readonly stage: FactoryStage;
  readonly ok: boolean;
  readonly detail: string;
  readonly durationMs: number;
};

export type OneClickAppFactoryResult = {
  readonly ok: boolean;
  readonly projectId: string;
  readonly projectPath: string;
  readonly template: WorkspaceBuildTemplate;
  readonly packageName?: string;
  readonly apkPath?: string;
  readonly containerId?: string;
  readonly stages: readonly FactoryStageResult[];
  readonly device?: DeviceAutomationResult;
  readonly history: readonly string[];
  readonly error?: string;
};

const MAX_CODING_ITERATIONS = 4;
const MAX_BUILD_ATTEMPTS = 3;
const MAX_NAME = 64;

function slug(value: string): string {
  const v = value.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, MAX_NAME);
  if (!v) throw new Error("FACTORY_NAME_REQUIRED");
  return validateProjectName(v);
}

function inferTemplate(prompt: string, requested?: WorkspaceBuildTemplate): WorkspaceBuildTemplate {
  if (requested) return requested;
  const p = prompt.toLowerCase();
  if (/python|django|fastapi|flask|pytest/.test(p)) return "python";
  if (/node|express|backend|cli|typescript|javascript/.test(p)) return "node";
  return "expo";
}

function packageFor(projectId: string, explicit?: string): string {
  const suffix = projectId.toLowerCase().replace(/[^a-z0-9]+/g, "") || "app";
  const defaultPackage = `com.aibuilder.${/^[a-z]/.test(suffix) ? suffix : `app${suffix}`}`;
  const value = (explicit || defaultPackage).trim();
  if (!/^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*){1,8}$/.test(value)) throw new Error("FACTORY_PACKAGE_NAME_INVALID");
  return value;
}

export class OneClickAppFactory {
  constructor(private readonly runtime: RuntimeFacade) {}

  async run(request: OneClickAppFactoryRequest): Promise<OneClickAppFactoryResult> {
    const projectId = slug(request.name);
    const template = inferTemplate(request.prompt, request.template);
    const projectPath = `${this.runtime.home.projects}/${projectId}`;
    const stages: FactoryStageResult[] = [];
    const history: string[] = [];
    const maxCodingIterations = Math.min(MAX_CODING_ITERATIONS, Math.max(1, Math.floor(request.maxCodingIterations ?? 3)));
    const maxBuildAttempts = Math.min(MAX_BUILD_ATTEMPTS, Math.max(1, Math.floor(request.maxBuildAttempts ?? 2)));
    let containerId: string | undefined;
    let apkPath: string | undefined;
    let packageName: string | undefined;
    let device: DeviceAutomationResult | undefined;
    let currentStage: FactoryStage = "project";
    let currentStageStartedAt = Date.now();

    const record = (stage: FactoryStage, ok: boolean, detail: string, started: number) => stages.push({ stage, ok, detail: detail.slice(0, 4000), durationMs: Date.now() - started });
    try {
      let started = Date.now();
      currentStage = "project"; currentStageStartedAt = Date.now();
      await this.runtime.environment.mkdir(projectPath);
      const workspaceStatus = await this.runtime.persistentWorkspaceStatus(projectId);
      if (workspaceStatus.head) {
        await this.runtime.persistentWorkspaceSnapshot(projectId, `factory-before-${Date.now()}`);
        history.push("[project] existing workspace snapshot created before factory run");
      }
      await this.runtime.projectMemoryGet(projectId);
      record("project", true, `project=${projectId}`, started);

      started = Date.now();
      currentStage = "container"; currentStageStartedAt = Date.now();
      const instance = await this.runtime.containerCreate({ imageId: "ubuntu:24.04", name: `aib-factory-${projectId}`, projectId });
      containerId = instance.id;
      await this.runtime.containerStart(containerId);
      record("container", true, containerId, started);

      started = Date.now();
      currentStage = "scaffold"; currentStageStartedAt = Date.now();
      await this.ensureContainerToolchain(containerId, template);
      const generated = await this.runtime.generateAIProject(containerId, {
        name: projectId,
        goal: request.prompt,
        template,
        runWorkflow: false,
      });
      if (!generated.ok) throw new Error(generated.error || "FACTORY_SCAFFOLD_FAILED");
      packageName = template === "expo" ? packageFor(projectId, request.packageName) : request.packageName;
      if (template === "expo") await this.configureExpoPackage(containerId, packageName!);
      await this.runtime.persistentWorkspaceCheckpoint(projectId, "factory: scaffold");
      await this.runtime.projectMemoryRecordBuild(projectId, "Factory scaffold created", generated.files.join(", "));
      record("scaffold", true, `${generated.files.length} files`, started);

      started = Date.now();
      currentStage = "coding"; currentStageStartedAt = Date.now();
      const coding = await this.runtime.runAICodingAgent(containerId, {
        name: projectId,
        goal: request.prompt,
        template,
        maxIterations: maxCodingIterations,
        build: true,
        test: true,
      });
      history.push(...coding.iterations.map((x) => `[coding ${x.iteration}] ${x.plan.summary}`));
      if (!coding.ok) throw new Error(coding.error || "FACTORY_CODING_FAILED");
      await this.runtime.persistentWorkspaceCheckpoint(projectId, "factory: coding complete");
      record("coding", true, `${coding.iterations.length} iteration(s); changed=${coding.changedFiles.length}`, started);

      started = Date.now();
      currentStage = "android_build"; currentStageStartedAt = Date.now();
      if (template !== "expo") {
        record("android_build", true, `skipped for template=${template}`, started);
      } else {
        let lastError = "ANDROID_BUILD_NOT_ATTEMPTED";
        for (let attempt = 1; attempt <= maxBuildAttempts; attempt++) {
          const build = await this.runAndroidBuild(containerId, projectId);
          history.push(`[android-build ${attempt}] ${build.detail}`);
          if (build.ok && build.apkPath) { apkPath = build.apkPath; lastError = ""; break; }
          lastError = build.detail;
          await this.runtime.projectMemoryRecordError(projectId, `Android build attempt ${attempt} failed`, build.detail);
          if (attempt < maxBuildAttempts) {
            const repair = await this.runtime.runAICodingAgent(containerId, {
              name: projectId,
              goal: `${request.prompt}\n\nANDROID BUILD FAILURE (attempt ${attempt}):\n${build.detail}`,
              template,
              maxIterations: 1,
              build: true,
              test: true,
            });
            history.push(`[android-repair ${attempt}] ${repair.error || repair.iterations.map((x) => x.plan.summary).join("; ") || "no edits"}`);
            if (!repair.ok && !repair.iterations.length) lastError = repair.error || lastError;
          }
        }
        if (!apkPath) throw new Error(lastError || "FACTORY_ANDROID_BUILD_FAILED");
        await this.runtime.projectMemoryRecordBuild(projectId, "Android APK build succeeded", apkPath);
        await this.runtime.persistentWorkspaceCheckpoint(projectId, "factory: APK built");
        record("android_build", true, apkPath, started);
      }

      started = Date.now();
      currentStage = "device_qa"; currentStageStartedAt = Date.now();
      if (!request.runDeviceQA) {
        record("device_qa", true, "skipped by request", started);
      } else if (!apkPath || !request.vision) {
        record("device_qa", false, !apkPath ? "APK_UNAVAILABLE" : "VISION_ANALYZER_REQUIRED", started);
        throw new Error(!apkPath ? "FACTORY_DEVICE_QA_REQUIRES_APK" : "FACTORY_DEVICE_QA_REQUIRES_VISION");
      } else {
        const qa = await this.runContainerDeviceQA({
          containerId,
          projectId,
          name: projectId,
          goal: request.deviceGoal || request.prompt,
          template,
          packageName,
          vision: request.vision,
          maxAttempts: maxBuildAttempts,
          apkPath: apkPath!,
          history,
        });
        device = qa.device;
        apkPath = qa.apkPath;
        if (!qa.ok) throw new Error(qa.error || "FACTORY_DEVICE_QA_FAILED");
        record("device_qa", true, qa.device?.reason || "device QA passed", started);
      }

      await this.runtime.projectMemoryRecordTest(projectId, "One-click factory pipeline completed", apkPath || "no APK for non-Expo template");
      await this.runtime.persistentWorkspaceCheckpoint(projectId, "factory: complete");
      stages.push({ stage: "complete", ok: true, detail: apkPath ? `APK=${apkPath}` : `template=${template}`, durationMs: 0 });
      return { ok: true, projectId, projectPath, template, packageName, apkPath, containerId, stages, device, history };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      record(currentStage, false, message, currentStageStartedAt);
      await this.runtime.projectMemoryRecordError(projectId, "One-click factory failed", message).catch(() => undefined);
      return { ok: false, projectId, projectPath, template, packageName, apkPath, containerId, stages, device, history, error: message };
    }
  }

  private async configureExpoPackage(containerId: string, packageName: string): Promise<void> {
    const script = "import json; p='/workspace/app.json'; d=json.load(open(p)); e=d.setdefault('expo',{}); e['android']=dict(e.get('android') or {}); e['android']['package']=__import__('sys').argv[1]; open(p,'w').write(json.dumps(d,indent=2)+'\\n')";
    const result = await this.runtime.containerExec(containerId, "python3", ["-c", script, packageName], { cwd: "/workspace", timeoutMs: 15_000 });
    if (result.exitCode !== 0) throw new Error(`FACTORY_PACKAGE_CONFIG_FAILED:${result.stderr.slice(-500)}`);
  }

  private async ensureContainerToolchain(containerId: string, template: WorkspaceBuildTemplate): Promise<void> {
    const required = template === "python" ? ["python3", "pip3", "git"] : ["node", "npm", "pnpm", "python3", "git"];
    const missing: string[] = [];
    for (const command of required) {
      const probe = await this.runtime.containerExec(containerId, "which", [command], { cwd: "/workspace", timeoutMs: 10_000 });
      if (probe.exitCode !== 0) missing.push(command);
    }
    if (missing.length) {
      const install = await this.runtime.containerExec(containerId, "apt-get", ["update"], { cwd: "/workspace", timeoutMs: 5 * 60_000 });
      if (install.exitCode !== 0) throw new Error(`FACTORY_TOOLCHAIN_APT_UPDATE_FAILED:${install.stderr.slice(-1200)}`);
      const packages = template === "python"
        ? ["python3", "python3-pip", "git", "ca-certificates"]
        : ["nodejs", "npm", "python3", "python3-pip", "git", "ca-certificates"];
      const installPackages = await this.runtime.containerExec(containerId, "apt-get", ["install", "-y", "--no-install-recommends", ...packages], { cwd: "/workspace", timeoutMs: 10 * 60_000 });
      if (installPackages.exitCode !== 0) throw new Error(`FACTORY_TOOLCHAIN_INSTALL_FAILED:${installPackages.stderr.slice(-1800)}`);
    }
    if (template !== "python") {
      const pnpm = await this.runtime.containerExec(containerId, "which", ["pnpm"], { cwd: "/workspace", timeoutMs: 10_000 });
      if (pnpm.exitCode !== 0) {
        const installPnpm = await this.runtime.containerExec(containerId, "npm", ["install", "--global", "pnpm@9.15.0"], { cwd: "/workspace", timeoutMs: 5 * 60_000 });
        if (installPnpm.exitCode !== 0) throw new Error(`FACTORY_PNPM_INSTALL_FAILED:${installPnpm.stderr.slice(-1600)}`);
      }
    }
  }

  private async runAndroidBuild(containerId: string, projectId: string): Promise<{ ok: boolean; apkPath?: string; detail: string }> {
    const prebuild = await this.runtime.containerExec(containerId, "npx", ["expo", "prebuild", "--platform", "android", "--non-interactive", "--no-install"], { cwd: "/workspace", timeoutMs: 5 * 60_000 });
    if (prebuild.exitCode !== 0) return { ok: false, detail: `expo prebuild failed: ${prebuild.stderr.slice(-5000)}\n${prebuild.stdout.slice(-3000)}` };

    const projectPath = `${this.runtime.home.projects}/${validateProjectName(projectId)}`;
    const build: BuildAttemptResult = await runAssembleDebug(projectPath, 10 * 60_000);
    if (!build.success || !build.apkHint) {
      return { ok: false, detail: `host Android build failed: ${build.errors.map((e) => e.message).join("\n").slice(-7000)}\n${build.log.slice(-5000)}` };
    }
    return { ok: true, apkPath: build.apkHint, detail: `APK built and signed: ${build.apkHint}` };
  }

  private async runContainerDeviceQA(options: {
    containerId: string;
    projectId: string;
    name: string;
    goal: string;
    template: WorkspaceBuildTemplate;
    packageName?: string;
    vision: VisionAnalyzer;
    maxAttempts: number;
    apkPath: string;
    history: string[];
  }): Promise<{ ok: boolean; apkPath?: string; device?: DeviceAutomationResult; error?: string }> {
    let apkPath = options.apkPath;
    let lastDevice: DeviceAutomationResult | undefined;
    for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
      lastDevice = await this.runtime.runDeviceAutomationAsAgent(options.projectId, {
        apkPath,
        packageName: options.packageName,
        goal: options.goal,
        maxSteps: 8,
        vision: options.vision,
      });
      options.history.push(`[device ${attempt}] ${lastDevice.reason}`);
      if (lastDevice.completed) return { ok: true, apkPath, device: lastDevice };
      if (attempt >= options.maxAttempts) break;
      const repair = await this.runtime.runAICodingAgent(options.containerId, {
        name: options.name,
        goal: `${options.goal}\n\nDEVICE QA FAILURE (attempt ${attempt}):\n${lastDevice.reason}\n\nRepair the smallest root cause and keep the requested UI behavior.`,
        template: options.template,
        maxIterations: 1,
        build: true,
        test: true,
      });
      options.history.push(`[device-repair ${attempt}] ${repair.iterations.map((x) => x.plan.summary).join("; ") || repair.error || "no edits"}`);
      if (!repair.ok) return { ok: false, apkPath, device: lastDevice, error: repair.error || "FACTORY_DEVICE_REPAIR_FAILED" };
      const rebuilt = await this.runAndroidBuild(options.containerId, options.projectId);
      if (!rebuilt.ok || !rebuilt.apkPath) return { ok: false, apkPath, device: lastDevice, error: rebuilt.detail };
      apkPath = rebuilt.apkPath;
    }
    return { ok: false, apkPath, device: lastDevice, error: lastDevice?.reason || "FACTORY_DEVICE_QA_FAILED" };
  }

}

export function createOneClickAppFactory(runtime: RuntimeFacade): OneClickAppFactory { return new OneClickAppFactory(runtime); }
