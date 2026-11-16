/** True only when the user message contains an explicit AIB_TOOL invocation shape. */
export function isExplicitAgentToolRequest(message: string): boolean {
  return /\bAIB_TOOL\b\s*:??\s*(?:\{\s*["']tool["']\s*:|[a-z][a-z0-9_-]*\.[a-z][a-z0-9_.-]*)/i.test(message);
}
