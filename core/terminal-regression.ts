/**
 * Runtime-only terminal subsystem regression harness.
 * Verifies terminal contracts without modifying projects or compilation settings.
 */
import type { TerminalSessionManager } from "./terminal-session-manager";
import type { TerminalAdapter, TerminalSessionOptions } from "./terminal";

export type TerminalRegressionCheck = {
  name: string;
  run: () => Promise<void> | void;
};

export type TerminalRegressionReport = {
  passed: string[];
  failed: Array<{ name: string; error: string }>;
};

export async function runTerminalRegression(
  checks: TerminalRegressionCheck[],
): Promise<TerminalRegressionReport> {
  const passed: string[] = [];
  const failed: Array<{ name: string; error: string }> = [];

  for (const check of checks) {
    try {
      await check.run();
      passed.push(check.name);
    } catch (error) {
      failed.push({
        name: check.name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { passed, failed };
}

export function assertTerminalRegressionClean(
  report: TerminalRegressionReport,
): void {
  if (report.failed.length > 0) {
    const details = report.failed
      .map((item) => `${item.name}: ${item.error}`)
      .join("; ");
    throw new Error(`Terminal regression failed: ${details}`);
  }
}

/** Standard contract checks for a TerminalSessionManager + adapter pair. */
export function buildTerminalRegressionChecks(
  manager: TerminalSessionManager,
  baseOptions: TerminalSessionOptions,
): TerminalRegressionCheck[] {
  return [
    {
      name: "session_create_and_list",
      run: async () => {
        const session = await manager.create({
          ...baseOptions,
          id: "reg-session-1",
        });
        if (!manager.has(session.id)) {
          throw new Error("session not tracked after create");
        }
        if (!manager.list().includes(session.id)) {
          throw new Error("session missing from list");
        }
      },
    },
    {
      name: "process_handle_present",
      run: async () => {
        const handle = manager.getProcessHandle("reg-session-1");
        if (!handle) {
          throw new Error("ProcessHandle missing");
        }
        if (handle.sessionId !== "reg-session-1") {
          throw new Error("ProcessHandle sessionId mismatch");
        }
      },
    },
    {
      name: "graceful_stop_interrupt_kill",
      run: async () => {
        await manager.stop("reg-session-1");
        await manager.interrupt("reg-session-1");
        await manager.kill("reg-session-1");
      },
    },
    {
      name: "session_close",
      run: async () => {
        await manager.close("reg-session-1");
        if (manager.has("reg-session-1")) {
          throw new Error("session still present after close");
        }
      },
    },
    {
      name: "home_and_pwd_options_accepted",
      run: async () => {
        const session = await manager.create({
          id: "reg-session-home",
          cwd: baseOptions.cwd,
          home: baseOptions.home ?? "/storage/emulated/0/AIBuilderTermux",
          projectRoot: baseOptions.projectRoot,
          env: {
            HOME: baseOptions.home ?? "/storage/emulated/0/AIBuilderTermux",
            PWD: baseOptions.cwd,
            AI_BUILDER_HOME:
              baseOptions.home ?? "/storage/emulated/0/AIBuilderTermux",
          },
        });
        if (!session) throw new Error("failed to create session with HOME/PWD");
        await manager.close(session.id);
      },
    },
  ];
}
