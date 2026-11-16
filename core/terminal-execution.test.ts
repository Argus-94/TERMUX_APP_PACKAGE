import {
  TerminalExecutionAdapter,
  TerminalExecutionBackend,
} from "./terminal-execution";

describe("terminal execution adapter", () => {
  it("delegates operations to the injected backend", async () => {
    const calls: string[] = [];
    const backend: TerminalExecutionBackend = {
      async openSession(options) {
        calls.push(`open:${options.cwd}`);
        return {
          id: options.id ?? "s1",
          cwd: options.cwd,
          size: options.size ?? { columns: 80, rows: 24 },
          async write() {},
          async resize() {},
          async close() {},
        };
      },
      async write(id, data) { calls.push(`write:${id}:${data}`); },
      async resize(id, size) { calls.push(`resize:${id}:${size.columns}x${size.rows}`); },
      async close(id) { calls.push(`close:${id}`); },
    };

    const adapter = new TerminalExecutionAdapter(backend);
    const session = await adapter.createSession({
      id: "s1",
      cwd: "/storage/emulated/0/AIBuilderTermux/workspace",
    });
    await adapter.send({ sessionId: session.id, data: "echo test\n" });
    await adapter.resize(session.id, { columns: 120, rows: 40 });
    await adapter.close(session.id);

    expect(calls).toEqual([
      "open:/storage/emulated/0/AIBuilderTermux/workspace",
      "write:s1:echo test\n",
      "resize:s1:120x40",
      "close:s1",
    ]);
  });
});
