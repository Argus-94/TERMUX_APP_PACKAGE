import { createCommandSpec } from "./command-spec";

describe("command specification", () => {
  it("creates a structured command without executing it", () => {
    expect(
      createCommandSpec("node", {
        args: ["--version"],
        cwd: "/storage/emulated/0/AIBuilderTermux/workspace",
        env: { NODE_ENV: "test" },
      }),
    ).toEqual({
      command: "node",
      args: ["--version"],
      cwd: "/storage/emulated/0/AIBuilderTermux/workspace",
      env: { NODE_ENV: "test" },
    });
  });

  it("rejects control characters", () => {
    expect(() => createCommandSpec("node\n")).toThrow();
    expect(() => createCommandSpec("node", { args: ["ok\u0000"] })).toThrow();
    expect(() => createCommandSpec("node", { env: { NODE_ENV: "bad\u0001" } })).toThrow();
  });

  it("validates environment keys", () => {
    expect(() => createCommandSpec("node", { env: { "BAD-KEY": "x" } })).toThrow();
  });
});
