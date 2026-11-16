/**
 * Infer pkg.ensure profiles from user task text and build install commands.
 */
import type { AgentShellBackend } from "./agent-shell-backend";
import {
  buildMultiProfileEnsureCommand,
  type PkgProfileId,
} from "./agent-tools/pkg-bootstrap";

const PROFILE_HINTS: Array<{ id: PkgProfileId; re: RegExp }> = [
  { id: "node", re: /\b(node|nodejs|npm|npx|yarn|pnpm|javascript|typescript|\.tsx?\b)/i },
  { id: "python", re: /\b(python3?|pip3?|django|flask|pytest|\.py\b)/i },
  { id: "android-build", re: /\b(gradle|assemble|apk|aab|android\s*sdk|javac?|openjdk|aapt)/i },
  { id: "git-extras", re: /\b(git\s+clone|github\.com|gh\s+)/i },
  { id: "base", re: /\b(curl|wget|ssh|scp|openssh)\b/i },
];

export function inferPkgProfilesFromTask(task: string): PkgProfileId[] {
  const t = String(task || "");
  if (!t.trim()) return [];
  const found: PkgProfileId[] = [];
  for (const { id, re } of PROFILE_HINTS) {
    if (re.test(t) && !found.includes(id)) found.push(id);
  }
  // Always include base if any profile matched (git/curl often needed)
  if (found.length && !found.includes("base") && !found.includes("git-extras")) {
    // only add base when network tools mentioned is already handled
  }
  return found;
}

export function buildAutoPkgEnsurePlan(
  task: string,
  backend: AgentShellBackend,
): { profiles: PkgProfileId[]; command: string | null; reason: string } {
  const profiles = inferPkgProfilesFromTask(task);
  if (!profiles.length) {
    return { profiles: [], command: null, reason: "no_toolchain_hint" };
  }
  const built = buildMultiProfileEnsureCommand(profiles, backend);
  if (!built.ok) {
    return { profiles, command: null, reason: built.error };
  }
  return {
    profiles,
    command: built.command,
    reason: `profiles=${profiles.join(",")}`,
  };
}
