/**
 * ctx.metrics — session context budget / savings snapshot.
 */
import { getContextMetrics, formatMetricsLine, resetContextMetrics } from "../../context-engine";
import type { ToolArgs } from "../types";

export function validate(_args: ToolArgs): string | null {
  return null;
}

export async function execute(args: ToolArgs) {
  if (args.reset === true || args.reset === "true") {
    resetContextMetrics();
    return { ok: true, reset: true, metrics: getContextMetrics() };
  }
  const m = getContextMetrics();
  return {
    ok: true,
    metrics: m,
    line: formatMetricsLine(m),
  };
}
