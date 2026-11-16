/**
 * ctx.expand — retrieve full content from a reversible CTX_HANDLE.
 */
import { expandHandle } from "../../context-engine";
import type { ToolArgs } from "../types";

export function validate(args: ToolArgs): string | null {
  if (typeof args.id !== "string" || !String(args.id).trim()) return "CTX_EXPAND_ID_REQUIRED";
  return null;
}

export async function execute(args: ToolArgs) {
  const id = String(args.id || "").trim();
  const h = expandHandle(id);
  if (!h) {
    return { ok: false, error: "CTX_HANDLE_NOT_FOUND", id };
  }
  return {
    ok: true,
    id: h.id,
    kind: h.kind,
    path: h.path ?? null,
    mode: h.mode ?? null,
    chars: h.content.length,
    originalChars: h.originalChars,
    truncated: h.truncated,
    content: h.content,
  };
}
