/**
 * Runtime-only command description.
 *
 * This is data validation only. It does not execute commands and does not
 * select a shell, process API, PTY, container, Shizuku, or root backend.
 */

export type CommandSpec = {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
};

const CONTROL_CHARACTER_RE = /[\u0000-\u001f\u007f]/;

export function createCommandSpec(
  command: string,
  options: Omit<CommandSpec, "command"> = {},
): CommandSpec {
  assertCommandToken(command, "command");

  if (options.cwd !== undefined) {
    assertPathValue(options.cwd, "cwd");
  }

  if (options.args !== undefined) {
    for (const arg of options.args) {
      if (CONTROL_CHARACTER_RE.test(arg)) {
        throw new Error("Command arguments must not contain control characters");
      }
    }
  }

  if (options.env !== undefined) {
    for (const [key, value] of Object.entries(options.env)) {
      assertEnvKey(key);
      if (CONTROL_CHARACTER_RE.test(value)) {
        throw new Error(`Environment value contains control characters: ${key}`);
      }
    }
  }

  return {
    command,
    ...(options.args ? { args: [...options.args] } : {}),
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    ...(options.env ? { env: { ...options.env } } : {}),
  };
}

function assertCommandToken(value: string, field: string): void {
  if (!value || CONTROL_CHARACTER_RE.test(value)) {
    throw new Error(`Invalid ${field}`);
  }
}

function assertPathValue(value: string, field: string): void {
  if (!value || CONTROL_CHARACTER_RE.test(value)) {
    throw new Error(`Invalid ${field}`);
  }
}

function assertEnvKey(value: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(`Invalid environment key: ${value}`);
  }
}
