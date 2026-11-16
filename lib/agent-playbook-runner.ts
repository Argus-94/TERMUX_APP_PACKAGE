/**
 * Deterministic playbook execution (shell + tool steps).
 * Extracted from termux-agent to keep the agent loop readable.
 */
import { persistentLogger } from "./persistent-logger";
import { executeGuardedTermuxCommand } from "./termux-executor";
import { buildProotDistroRootfsCheckCommand } from "./termux-bootstrap-install";
import {
  isLinuxProotBackend,
  getBuildBackend,
  backendLabel,
} from "./agent-shell-backend";
import { goalVerifyPassed } from "./agent-goal";
import { executeAgentTool, type AgentToolName } from "./agent-tools";
import type { PlaybookResult } from "./agent-playbooks";
import type { SessionScratchpad } from "./agent-session-memory";
import { scratchPush } from "./agent-session-memory";
import type { AgentTrajectoryStepInput } from "./agent-trajectory";
import { classifyAgentOperationClass } from "./agent-policy-router";

export function resolvePlaybookToolArgs(
  tool: string,
  args: Record<string, unknown>,
  materializePath: string,
): { args: Record<string, unknown>; error?: string } {
  const next = { ...args };
  if (tool === "github.pack" && next.sourceDir === "__MATERIALIZE_PATH__") {
    if (!materializePath) return { args: next, error: "GITHUB_PACK_SKIPPED: no materialize path" };
    next.sourceDir = materializePath;
  }
  if (tool === "build.run" && next.command === "__MATERIALIZE_BUILD__") {
    if (!materializePath) return { args: next, error: "GITHUB_APK_SKIPPED: no materialize path" };
    const mp = String(materializePath).replace(/'/g, `'\"'\"'`);
    next.command =
      `cd '${mp}' && ` +
      `if [ -f gradlew ]; then bash gradlew assembleDebug --no-daemon -x test; ` +
      `elif [ -f android/gradlew ]; then cd android && bash gradlew assembleDebug --no-daemon -x test; ` +
      `else echo AIB_NO_GRADLEW; exit 2; fi`;
  }
  return { args: next };
}

export function extractMaterializePath(tool: string, result: unknown): string {
  if (tool !== "github.materialize" || !result || typeof result !== "object") return "";
  const r = result as { localPath?: string; path?: string };
  if (typeof r.localPath === "string" && r.localPath) return r.localPath;
  if (typeof r.path === "string" && r.path) return r.path;
  return "";
}

export type PlaybookRunOptions = {
  perCommandTimeoutMs?: number;
  projectPath?: string | null;
  onTrajectoryStep?: (step: AgentTrajectoryStepInput) => void;
  /** Compatible with termux-agent onActivity (subset). */
  onActivity?: (a: {
    command: string | null;
    step: number;
    maxSteps: number;
    detail?: string;
    stage?: string;
  } | null) => void;
};

/**
 * Run a classified playbook. Returns a final agent string on success, or null to fall through to LLM.
 */
export async function executeDeterministicPlaybook(
  playbook: PlaybookResult,
  sessionScratch: SessionScratchpad,
  options: PlaybookRunOptions = {},
): Promise<string | null> {
  try {
    persistentLogger.add("info", "Termux", `Playbook ${playbook.id} kind=${playbook.kind}`);
    options.onActivity?.({
      command: playbook.id,
      step: 1,
      maxSteps: 1,
      detail: `Playbook ${playbook.id}`,
      stage: "playbook",
    });

    if (playbook.kind === "shell") {
      const mode = playbook.storageMode || "preferGuest";
      const linux = isLinuxProotBackend();
      let useHost = mode === "hostOnly" || mode === "preferHost" || !linux;
      if (mode === "preferGuest" && linux) {
        try {
          const backend = getBuildBackend();
          const distro = "ubuntu";
          const marker = "UBUNTU";
          const probe = await executeGuardedTermuxCommand(
            buildProotDistroRootfsCheckCommand(distro),
            { timeoutMs: 20_000, trustedInternal: true, executionTarget: "embedded-private" },
          );
          const out = ((probe.stdout || "") + (probe.stderr || "")).trim();
          useHost = !new RegExp(`${marker}_ROOTFS_OK`).test(out);
          persistentLogger.add(
            "info",
            "Termux",
            `Playbook ${playbook.id} preferGuest rootfs=${useHost ? "UNVERIFIED→host" : "OK→guest(" + backend + ")"}`,
          );
        } catch {
          useHost = true;
        }
      }
      const shellStartedAt = Date.now();
      let pbResult = await executeGuardedTermuxCommand(playbook.command, {
        timeoutMs: Math.min(options.perCommandTimeoutMs || 120_000, 60_000),
        trustedInternal: true,
        hostTermux: useHost,
      });
      let ok = goalVerifyPassed(pbResult.stdout || "", pbResult.stderr || "") || pbResult.exitCode === 0;
      if (!ok && !useHost && /\/storage\/emulated\/|\/sdcard\//.test(playbook.command)) {
        persistentLogger.add("warn", "Termux", `Playbook ${playbook.id} guest failed; retry host Termux`);
        pbResult = await executeGuardedTermuxCommand(playbook.command, {
          timeoutMs: Math.min(options.perCommandTimeoutMs || 120_000, 60_000),
          trustedInternal: true,
          executionTarget: "embedded-private",
        });
        ok = goalVerifyPassed(pbResult.stdout || "", pbResult.stderr || "") || pbResult.exitCode === 0;
        useHost = true;
      }
      if (ok) {
        options.onTrajectoryStep?.({
          kind: "shell",
          action: `playbook.${playbook.id}`,
          operationClass: classifyAgentOperationClass({ command: playbook.command, projectPath: options.projectPath }),
          resultMarker: "PLAYBOOK_OK",
          status: "pass",
          backend: useHost ? "host-termux" : isLinuxProotBackend() ? "guest" : "termux",
          exitCode: pbResult.exitCode,
          durationMs: Date.now() - shellStartedAt,
        });
        options.onActivity?.(null);
        scratchPush(sessionScratch, "ok", `${playbook.id}:${useHost ? "host" : "guest"}`);
        return (
          `PLAYBOOK_OK id=${playbook.id} backend=${useHost ? "host-termux" : backendLabel(getBuildBackend())}\n` +
          (pbResult.stdout || "").slice(0, 1500) +
          `\n${playbook.doneMessage}`
        );
      }
      options.onTrajectoryStep?.({
        kind: "shell",
        action: `playbook.${playbook.id}`,
        operationClass: classifyAgentOperationClass({ command: playbook.command, projectPath: options.projectPath }),
        resultMarker: "PLAYBOOK_FAIL",
        status: "fail",
        backend: useHost ? "host-termux" : isLinuxProotBackend() ? "guest" : "termux",
        exitCode: pbResult.exitCode,
        durationMs: Date.now() - shellStartedAt,
      });
      persistentLogger.add("warn", "Termux", `Playbook ${playbook.id} failed exit=${pbResult.exitCode}; fall through to LLM`);
      return null;
    }

    if (playbook.kind === "tools") {
      let materializePath = "";
      const parts: string[] = [];
      let allOk = true;
      const totalSteps = Math.max(1, playbook.steps.length);
      const stageState = playbook.steps.map((s, i) => ({
        id: `pb-${i}-${s.tool}`,
        label: s.tool,
        status: "pending" as "pending" | "active" | "done" | "error" | "skipped",
        detail: undefined as string | undefined,
      }));
      const publish = (stepIndex: number, status: "running" | "completed" | "failed") => {
        const doneCount = stageState.filter((s) => s.status === "done").length;
        const activeBonus = stageState.some((s) => s.status === "active") ? 0.35 : 0;
        const pct =
          status === "completed"
            ? 100
            : status === "failed"
              ? Math.floor(((doneCount + activeBonus) / totalSteps) * 100)
              : Math.floor(((doneCount + activeBonus) / totalSteps) * 100);
        options.onActivity?.({
          command: `Playbook ${playbook.id}`,
          step: Math.min(totalSteps, stepIndex + 1),
          maxSteps: totalSteps,
          detail: `Playbook ${playbook.id}`,
          stage: stageState[stepIndex]?.label || playbook.id,
        });
      };
      publish(0, "running");
      for (let i = 0; i < playbook.steps.length; i++) {
        const step = playbook.steps[i];
        const toolStartedAt = Date.now();
        stageState[i].status = "active";
        publish(i, "running");
        const resolved = resolvePlaybookToolArgs(step.tool, step.args || {}, materializePath);
        if (resolved.error) {
          allOk = false;
          stageState[i].status = "error";
          stageState[i].detail = resolved.error;
          parts.push(resolved.error);
          publish(i, "failed");
          break;
        }
        try {
          const result = await executeAgentTool(
            step.tool as AgentToolName,
            resolved.args,
            options.projectPath ?? null,
            { traceId: undefined },
          );
          const outText = typeof result === "string" ? result : JSON.stringify(result, null, 0);
          const toolExitCode = typeof result === "object" && result && "exitCode" in result ? Number((result as { exitCode: number }).exitCode) : 0;
          options.onTrajectoryStep?.({
            kind: "tool",
            action: step.tool,
            operationClass: classifyAgentOperationClass({ tool: step.tool, projectPath: options.projectPath }),
            status: Number.isFinite(toolExitCode) && toolExitCode !== 0 ? "fail" : "pass",
            backend: getBuildBackend(),
            ...(Number.isFinite(toolExitCode) ? { exitCode: toolExitCode } : {}),
            durationMs: Date.now() - toolStartedAt,
            path: options.projectPath || undefined,
          });
          parts.push(`[${step.tool}] ${outText.slice(0, 1200)}`);
          const lp = extractMaterializePath(step.tool, result);
          if (lp) materializePath = lp;
          if (typeof result === "object" && result && "exitCode" in result && Number((result as { exitCode: number }).exitCode) !== 0) {
            allOk = false;
            stageState[i].status = "error";
            stageState[i].detail = `exit ${Number((result as { exitCode: number }).exitCode)}`;
            publish(i, "failed");
            break;
          }
          stageState[i].status = "done";
          publish(i, "running");
        } catch (e: unknown) {
          allOk = false;
          options.onTrajectoryStep?.({ kind: "tool", action: step.tool, status: "fail", backend: getBuildBackend(), durationMs: Date.now() - toolStartedAt, path: options.projectPath || undefined });
          const msg = e instanceof Error ? e.message : String(e);
          stageState[i].status = "error";
          stageState[i].detail = msg;
          parts.push(`[${step.tool}] ERROR ${msg}`);
          publish(i, "failed");
          break;
        }
      }
      if (allOk) {
        for (const s of stageState) if (s.status !== "done") s.status = "done";
        publish(totalSteps - 1, "completed");
        options.onActivity?.(null);
        scratchPush(sessionScratch, "ok", playbook.id);
        if (materializePath) sessionScratch.artifactPath = materializePath;
        return (
          `PLAYBOOK_OK id=${playbook.id}\n${parts.join("\n")}\n${playbook.doneMessage}` +
          (materializePath ? "\n" + materializePath : "")
        );
      }
      persistentLogger.add("warn", "Termux", `Playbook ${playbook.id} tool steps failed; fall through to LLM`);
      return null;
    }

    return null;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    persistentLogger.add("warn", "Termux", `Playbook ${playbook.id} error: ${msg}; fall through to LLM`);
    return null;
  }
}
