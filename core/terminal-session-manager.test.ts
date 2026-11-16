import {
  TerminalSessionManager,
} from "./terminal-session-manager";
import type {
  ProcessControlAction,
  TerminalAdapter,
  TerminalSession,
} from "./terminal";

function makeSession(id: string): TerminalSession {
  return {
    id,
    cwd: "/storage/emulated/0/AIBuilderTermux/workspace",
    size: { columns: 80, rows: 24 },
    home: "/storage/emulated/0/AIBuilderTermux",
    async write() {},
    async resize() {},
    async close() {},
  };
}

describe("TerminalSessionManager", () => {
  it("tracks creation and close lifecycle", async () => {
    const closed: string[] = [];
    const adapter: TerminalAdapter = {
      async createSession(options) {
        return makeSession(options.id ?? "s1");
      },
      async send() {},
      async resize() {},
      async close(id) {
        closed.push(id);
      },
    };

    const manager = new TerminalSessionManager(adapter);
    await manager.create({ id: "s1", cwd: "/storage/emulated/0/AIBuilderTermux/workspace" });

    expect(manager.has("s1")).toBe(true);
    expect(manager.list()).toEqual(["s1"]);
    const handle = manager.getProcessHandle("s1");
    expect(handle).toBeDefined();
    expect(handle!.sessionId).toBe("s1");
    expect(typeof handle!.startedAt).toBe("number");

    await manager.close("s1");
    expect(manager.has("s1")).toBe(false);
    expect(closed).toEqual(["s1"]);
  });

  it("closes all managed sessions", async () => {
    const closed: string[] = [];
    const adapter: TerminalAdapter = {
      async createSession(options) {
        return makeSession(options.id!);
      },
      async send() {},
      async resize() {},
      async close(id) { closed.push(id); },
    };

    const manager = new TerminalSessionManager(adapter);
    await manager.create({ id: "s1", cwd: "/workspace" });
    await manager.create({ id: "s2", cwd: "/workspace" });

    await manager.closeAll();

    expect(manager.list()).toEqual([]);
    expect(closed).toEqual(["s1", "s2"]);
  });

  it("supports graceful stop / interrupt / kill via adapter control", async () => {
    const actions: ProcessControlAction[] = [];
    const adapter: TerminalAdapter = {
      async createSession(options) {
        return makeSession(options.id ?? "s1");
      },
      async send() {},
      async resize() {},
      async close() {},
      async control(_id, action) {
        actions.push(action);
      },
    };

    const manager = new TerminalSessionManager(adapter);
    await manager.create({ id: "s1", cwd: "/workspace" });

    await manager.stop("s1");
    await manager.interrupt("s1");
    await manager.kill("s1");

    expect(actions).toEqual(["stop", "interrupt", "kill"]);
  });
});
