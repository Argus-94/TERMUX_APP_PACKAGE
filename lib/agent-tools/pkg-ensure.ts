/**
 * Agent tool: pkg.ensure
 * Install a toolchain profile inside AI Builder's embedded private runtime.
 */
import { privateRuntimeProvider } from "../private-runtime-provider";
import { getBuildBackend } from "../agent-shell-backend";
import {
  buildMultiProfileEnsureCommand,
  buildPkgEnsureCommand,
  listPkgProfiles,
  type PkgProfileId,
} from "./pkg-bootstrap";
import { isNonEmptyString } from "./common";
import type { ToolArgs } from "./types";

export function validate(args: ToolArgs): string | null {
  const profile = args.profile;
  const profiles = args.profiles;
  if (isNonEmptyString(profile)) return null;
  if (Array.isArray(profiles) && profiles.length > 0 && profiles.every((p) => isNonEmptyString(p))) {
    return null;
  }
  const known = listPkgProfiles()
    .map((p) => p.id)
    .join(", ");
  return `PKG_PROFILE_REQUIRED: pass profile (one of ${known}) or profiles[]`;
}

export async function execute(args: ToolArgs) {
  const backend = getBuildBackend();
  const timeoutMs = Math.min(Math.max(Number(args.timeoutMs) || 300_000, 60_000), 600_000);

  // This tool's provider intentionally runs only in the embedded private runtime.
  // Do not pass guest apt commands to that shell or fall back to an external app.
  if (backend === "ubuntu-proot") {
    return { ok: false, error: "PKG_PROFILE_GUEST_INSTALL_UNAVAILABLE", backend };
  }

  let built:
    | { ok: true; command: string; packages: string[] }
    | { ok: false; error: string };

  if (Array.isArray(args.profiles) && args.profiles.length > 0) {
    built = buildMultiProfileEnsureCommand(
      args.profiles.map((p) => String(p)),
      backend,
    );
  } else {
    built = buildPkgEnsureCommand(String(args.profile) as PkgProfileId, backend);
  }

  if (!built.ok) {
    return { ok: false, error: built.error, backend };
  }

  const result = await privateRuntimeProvider.execute(built.command, {
    timeoutMs,
  });

  return {
    ok: result.exitCode === 0,
    backend,
    packages: built.packages,
    command: built.command,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}
