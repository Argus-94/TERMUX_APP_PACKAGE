import {
  createExecResult,
  isSuccessfulExecResult,
} from "./exec-result";

describe("ExecResult", () => {
  it("normalizes a successful result", () => {
    const result = createExecResult({
      command: "node",
      args: ["--version"],
      exitCode: 0,
      stdout: "v24\n",
      stderr: "",
      durationMs: 12,
    });

    expect(result.args).toEqual(["--version"]);
    expect(isSuccessfulExecResult(result)).toBe(true);
  });

  it("represents a terminated process without inventing an exit code", () => {
    const result = createExecResult({
      command: "node",
      args: [],
      exitCode: null,
      signal: "SIGTERM",
      stdout: "",
      stderr: "",
      durationMs: 25,
    });

    expect(result.exitCode).toBeNull();
    expect(isSuccessfulExecResult(result)).toBe(false);
  });

  it("rejects invalid result metadata", () => {
    expect(() => createExecResult({
      command: "",
      args: [],
      exitCode: 0,
      stdout: "",
      stderr: "",
      durationMs: 1,
    })).toThrow();

    expect(() => createExecResult({
      command: "node",
      args: [],
      exitCode: 0,
      stdout: "",
      stderr: "",
      durationMs: -1,
    })).toThrow();
  });
});
