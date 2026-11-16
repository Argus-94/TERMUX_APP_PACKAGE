/**
 * Phase 32: Agentic Build Loop.
 * Bridges the LLM Coding Brain to the existing Android build/device QA loop.
 * The LLM remains behind the bounded AICodingAgent policy boundary.
 */
import type { RuntimeFacade } from "../RuntimeFacade";
import type { AICodingAgentResult } from "./AICodingAgent";
import type { WorkspaceBuildTemplate } from "./AIWorkspaceBuilder";
import type { VisionAnalyzer, DeviceAutomationResult } from "../device/DeviceAutomationAgent";
import { runAutonomousDeviceDevelopmentLoop, type AutonomousDeviceLoopEvent } from "../../lib/autonomous-device-loop";

export type AgenticBuildLoopRequest = {
  readonly containerId: string;
  readonly projectId: string;
  readonly name: string;
  readonly goal: string;
  readonly template: WorkspaceBuildTemplate;
  readonly packageName?: string;
  readonly maxCodingIterations?: number;
  readonly maxBuildAttempts?: number;
  readonly maxDeviceSteps?: number;
  readonly vision: VisionAnalyzer;
  readonly onEvent?: (event: AgenticBuildLoopEvent) => void;
};

export type AgenticBuildLoopEvent =
  | { type: "coding_started" }
  | { type: "coding_finished"; result: AICodingAgentResult }
  | { type: "device"; event: AutonomousDeviceLoopEvent };

export type AgenticBuildLoopResult = {
  readonly ok: boolean;
  readonly coding: AICodingAgentResult;
  readonly device?: DeviceAutomationResult;
  readonly buildAttempts: number;
  readonly history: readonly string[];
  readonly error?: string;
};

const MAX_CODING_ITERATIONS = 3;
const MAX_BUILD_ATTEMPTS = 4;
const MAX_DEVICE_STEPS = 10;

export async function runAgenticBuildLoop(
  runtime: RuntimeFacade,
  request: AgenticBuildLoopRequest,
): Promise<AgenticBuildLoopResult> {
  const maxCodingIterations = Math.min(MAX_CODING_ITERATIONS, Math.max(1, Math.floor(request.maxCodingIterations ?? 2)));
  const maxBuildAttempts = Math.min(MAX_BUILD_ATTEMPTS, Math.max(1, Math.floor(request.maxBuildAttempts ?? 3)));
  const maxDeviceSteps = Math.min(MAX_DEVICE_STEPS, Math.max(1, Math.floor(request.maxDeviceSteps ?? 8)));

  request.onEvent?.({ type: "coding_started" });
  const coding = await runtime.runAICodingAgent(request.containerId, {
    name: request.name,
    goal: request.goal,
    template: request.template,
    maxIterations: maxCodingIterations,
    build: true,
    test: true,
  });
  request.onEvent?.({ type: "coding_finished", result: coding });

  if (!coding.ok) {
    return {
      ok: false,
      coding,
      buildAttempts: 0,
      history: coding.iterations.map((x) => `[coding ${x.iteration}] ${x.plan.summary}`),
      error: coding.error || "CODING_PHASE_FAILED",
    };
  }

  const projectPath = `${runtime.home.projects}/${request.projectId}`;
  const history: string[] = coding.iterations.map((x) => `[coding ${x.iteration}] ${x.plan.summary}`);

  const device = await runAutonomousDeviceDevelopmentLoop({
    runtime,
    projectPath,
    projectId: request.projectId,
    packageName: request.packageName,
    goal: request.goal,
    vision: request.vision,
    maxBuildAttempts,
    maxDeviceSteps,
    repair: async (prompt) => {
      const repair = await runtime.runAICodingAgent(request.containerId, {
        name: request.name,
        goal: `${request.goal}\n\nDEVICE RECOVERY CONTEXT:\n${prompt}`,
        template: request.template,
        maxIterations: 1,
        build: true,
        test: true,
      });
      const summary = repair.iterations.map((x) => x.plan.summary).join("; ") || repair.error || "no repair edits";
      history.push(`[device-repair] ${summary}`);
      return summary;
    },
    onEvent: (event) => request.onEvent?.({ type: "device", event }),
  });

  return {
    ok: device.ok,
    coding,
    device: device.device,
    buildAttempts: device.buildAttempts,
    history: [...history, ...device.history],
    error: device.ok ? undefined : device.device?.reason || "DEVICE_LOOP_FAILED",
  };
}
