/**
 * In-task scratchpad: tried steps, last error, next hint — code-owned, not model memory.
 */
export type SessionScratchNote = Readonly<{
  at: number;
  kind: "try" | "error" | "ok" | "note" | "goal";
  text: string;
}>;

export type SessionScratchpad = {
  notes: SessionScratchNote[];
  lastErrorFp: string | null;
  lastOkSummary: string | null;
  artifactPath: string | null;
};

export function createSessionScratchpad(): SessionScratchpad {
  return { notes: [], lastErrorFp: null, lastOkSummary: null, artifactPath: null };
}

export function scratchPush(pad: SessionScratchpad, kind: SessionScratchNote["kind"], text: string): void {
  pad.notes.push({ at: Date.now(), kind, text: String(text || "").slice(0, 240) });
  if (pad.notes.length > 24) pad.notes.splice(0, pad.notes.length - 24);
  if (kind === "error") pad.lastErrorFp = text.slice(0, 120);
  if (kind === "ok") pad.lastOkSummary = text.slice(0, 160);
}

export function formatScratchBlock(pad: SessionScratchpad): string {
  if (!pad.notes.length && !pad.artifactPath) return "";
  const lines = ["[SESSION_MEMORY]"];
  if (pad.artifactPath) lines.push(`artifact=${pad.artifactPath}`);
  if (pad.lastErrorFp) lines.push(`last_error_fp=${pad.lastErrorFp}`);
  if (pad.lastOkSummary) lines.push(`last_ok=${pad.lastOkSummary}`);
  const recent = pad.notes.slice(-8);
  for (const n of recent) lines.push(`- [${n.kind}] ${n.text}`);
  lines.push("Use SESSION_MEMORY to avoid repeating the same failed step; try a different layer.");
  return lines.join("\n");
}
