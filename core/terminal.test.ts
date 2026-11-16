import {
  TerminalAdapter,
  TerminalSession,
  TerminalSessionOptions,
} from "./terminal";

describe("terminal abstraction", () => {
  it("keeps terminal concerns behind an injected adapter", () => {
    const adapter: TerminalAdapter = {
      async createSession(options: TerminalSessionOptions): Promise<TerminalSession> {
        return {
          id: options.id ?? "test-session",
          cwd: options.cwd,
          size: options.size ?? { columns: 80, rows: 24 },
          async write() {},
          async resize() {},
          async close() {},
        };
      },
      async send() {},
      async resize() {},
      async close() {},
    };

    expect(adapter).toBeDefined();
  });

  it("models terminal resize and input without prescribing an implementation", () => {
    const options: TerminalSessionOptions = {
      cwd: "/storage/emulated/0/AIBuilderTermux/workspace",
      size: { columns: 120, rows: 40 },
    };

    expect(options.size).toEqual({ columns: 120, rows: 40 });
  });
});
