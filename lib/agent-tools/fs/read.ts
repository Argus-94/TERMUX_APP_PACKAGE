/**
 * fs.read — LeanCTX-inspired multi-mode file read.
 *
 * Modes: full | signatures | map | lines | density | auto
 * Uses context-engine shaping + optional cache. Executes via guarded Termux.
 */
import { executeGuardedTermuxCommand } from "../../termux-executor";
import { quote, safePath } from "../common";
import { guardHashlineCommand, requireProjectRoot } from "./path-guard";
import type { ToolArgs, ToolExecutionContext } from "../types";
import {
  shapeFileContent,
  tryCacheHit,
  maybeCompressToHandle,
  type ReadMode,
} from "../../context-engine";

const MODES = new Set(["full", "signatures", "map", "lines", "density", "auto"]);

export function validate(args: ToolArgs): string | null {
  const path = String(args.path || "");
  if (!path.trim()) return "PATH_REQUIRED";
  if (path.includes("\0") || path.startsWith("/") || path.startsWith("~") || /^[A-Za-z]:[\\/]/.test(path) || path.split(/[\\/]/).includes(".."))
    return "PATH_NOT_ALLOWED";
  if (args.mode !== undefined && !MODES.has(String(args.mode))) return "FS_READ_MODE_INVALID";
  return null;
}

export async function execute(args: ToolArgs, projectPath?: string | null, context?: ToolExecutionContext) {
  const path = safePath(String(args.path ?? ""));
  const workdir = requireProjectRoot(projectPath);
  const mode = (String(args.mode || "auto") as ReadMode) || "auto";
  const start = Math.max(1, Number(args.start || 1));
  const end = Math.max(start, Number(args.end || start + 200));
  const density = Math.min(0.9, Math.max(0.15, Number(args.density || 0.4)));

  const modeArg = mode === "lines" ? "full" : mode;
  const cmd = guardHashlineCommand(path,
    mode === "lines" || mode === "full"
      ? `node scripts/aib-hashline.mjs read ${quote(path)} ${start} ${end}`
      : `node scripts/aib-hashline.mjs read-mode ${quote(path)} ${quote(modeArg)} ${density}`);

  let rawOut: string;
  try {
    const result = await executeGuardedTermuxCommand(cmd, {
      workdir,
      traceId: context?.traceId,
      timeoutMs: 30_000,
    });
    rawOut = extractStdout(result);
  } catch {
    const result = await executeGuardedTermuxCommand(
      guardHashlineCommand(path, `node scripts/aib-hashline.mjs read ${quote(path)} ${start} ${end}`),
      { workdir,
      traceId: context?.traceId, timeoutMs: 30_000 },
    );
    rawOut = extractStdout(result);
  }

  const plain = stripHashline(rawOut);
  const cached = tryCacheHit(path, mode, plain, { start, end });
  if (cached) return cached;

  const shaped = shapeFileContent(path, plain, mode, { start, end, density });
  const body = maybeCompressToHandle("file", shaped.text, { path, mode: shaped.modeUsed }, 14_000);
  return `[fs.read mode=${shaped.modeUsed} path=${path} rawChars=${shaped.rawLen}]\n${body}`;
}

function extractStdout(result: unknown): string {
  if (typeof result === "string") return result;
  if (result && typeof result === "object" && typeof (result as { stdout?: string }).stdout === "string") {
    return (result as { stdout: string }).stdout;
  }
  return String(result ?? "");
}

function stripHashline(text: string): string {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  for (const line of lines) {
    const m = line.match(/^\d+\|[0-9A-Fa-f]{8}\|(.*)$/);
    if (m) out.push(m[1]);
    else out.push(line);
  }
  return out.join("\n");
}
