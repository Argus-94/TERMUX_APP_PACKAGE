import { TerminalSessionManager } from "./terminal-session-manager";
import type { TerminalAdapter, TerminalSession } from "./terminal";
import {
  assertTerminalRegressionClean,
  buildTerminalRegressionChecks,
  runTerminalRegression,
} from "./terminal-regression";

function makeSession(id: string, cwd: string): TerminalSession {
  return {
    id,
    cwd,
    size: { columns: 80, rows: 24 },
    home: "/storage/emulated/0/AIBuilderTermux",
    async write() {},
    async resize() {},
    async close() {},
    async stop() {},
    async interrupt() {},
    async kill() {},
  };
}

describe("terminal regression", () => {
  it("passes standard terminal contract checks", async () => {
    const adapter: TerminalAdapter = {
      async createSession(options) {
        return makeSession(options.id ?? "auto", options.cwd);
      },
      async send() {},
      async resize() {},
      async close() {},
      async control() {},
    };

    const manager = new TerminalSessionManager(adapter);
    const checks = buildTerminalRegressionChecks(manager, {
      cwd: "/storage/emulated/0/AIBuilderTermux/projects/demo",
      home: "/storage/emulated/0/AIBuilderTermux",
      projectRoot: "/storage/emulated/0/AIBuilderTermux/projects/demo",
    });

    const report = await runTerminalRegression(checks);
    assertTerminalRegressionClean(report);
    expect(report.passed.length).toBeGreaterThanOrEqual(4);
  });
});
