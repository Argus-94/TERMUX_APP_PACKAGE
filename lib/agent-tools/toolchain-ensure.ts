/**
 * Agent tool: toolchain.ensure
 * Read-only verification of Java + Gradle + Android SDK layout on the selected backend.
 */
import { ensureAndroidToolchain } from "../agent-engine";
import type { ToolArgs } from "./types";

export function validate(_args: ToolArgs): string | null {
  return null;
}

export async function execute(args: ToolArgs, _projectPath?: string | null) {
  const timeoutMs = Math.min(Math.max(Number(args.timeoutMs) || 120_000, 30_000), 180_000);
  const result = await ensureAndroidToolchain(timeoutMs);
  return {
    ok: result.ok,
    log: result.log,
    exitCode: result.ok ? 0 : 1,
  };
}
