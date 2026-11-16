/**
 * Single entry for agent shell: always the active Termux / Ubuntu backend
 * unless hostTermux is forced (shared-storage verify, broken rootfs fallback).
 */
import {
  executeGuardedTermuxCommand,
  type GuardedTermuxOptions,
} from "./termux-executor";
import type { TermuxCommandResult } from "./termux-bridge";
import { getBuildBackend, isLinuxProotBackend } from "./agent-shell-backend";
import { persistentLogger } from "./persistent-logger";

export type RunInActiveEnvOptions = GuardedTermuxOptions & {
  /** Override backend label in logs only */
  logTag?: string;
};

export async function runInActiveEnv(
  command: string,
  options: RunInActiveEnvOptions = {},
): Promise<TermuxCommandResult> {
  const backend = getBuildBackend();
  const { logTag, ...rest } = options;
  const host = !!rest.hostTermux;
  persistentLogger.add(
    "info",
    logTag || "RunInActiveEnv",
    `backend=${backend} hostTermux=${host} isLinux=${isLinuxProotBackend()} cmdLen=${String(command || "").length}`,
    "agent",
  );
  return executeGuardedTermuxCommand(command, rest);
}

/** Install packages with the correct manager for the active environment. */
export async function packageInstall(
  packages: string[],
  options: RunInActiveEnvOptions = {},
): Promise<TermuxCommandResult> {
  const pkgs = packages.map((p) => String(p || "").trim()).filter(Boolean);
  if (!pkgs.length) {
    throw new Error("PACKAGE_LIST_EMPTY");
  }
  const quoted = pkgs.map((p) => "'" + p.replace(/'/g, "'\"'\"'") + "'").join(" ");
  const backend = getBuildBackend();
  const cmd =
    backend === "ubuntu-proot"
      ? `export DEBIAN_FRONTEND=noninteractive; apt-get update -y && apt-get install -y ${quoted}`
      : `pkg install -y ${quoted}`;
  return runInActiveEnv(cmd, {
    timeoutMs: options.timeoutMs ?? 600_000,
    isBuild: true,
    ...options,
    logTag: options.logTag || "PackageInstall",
  });
}
