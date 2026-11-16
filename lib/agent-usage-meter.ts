/**
 * Per-session token/step/time accounting.
 */

export type AgentUsageMeter = {
  startedAt: number;
  steps: number;
  durationMs: number;
  tokens: number | null;
  hostCommands: number;
  prootCommands: number;
};

export function createUsageMeter(startedAt = Date.now(), tokens: number | null = null): AgentUsageMeter {
  return {
    startedAt,
    steps: 0,
    durationMs: 0,
    tokens: Number.isFinite(tokens) && (tokens as number) >= 0 ? Math.floor(tokens as number) : null,
    hostCommands: 0,
    prootCommands: 0,
  };
}

export function recordUsageStep(meter: AgentUsageMeter, tokens?: number | null): AgentUsageMeter {
  meter.steps = Math.min(100_000, meter.steps + 1);
  if (Number.isFinite(tokens) && (tokens as number) >= 0) meter.tokens = Math.floor(tokens as number);
  return meter;
}

export function recordUsageBackend(
  meter: AgentUsageMeter,
  backend: "termux" | "ubuntu-proot",
): AgentUsageMeter {
  if (backend === "termux") {
    meter.hostCommands = (meter.hostCommands || 0) + 1;
  } else {
    meter.prootCommands = (meter.prootCommands || 0) + 1;
  }
  return meter;
}

export function finishUsageMeter(meter: AgentUsageMeter, endedAt = Date.now(), tokens?: number | null): AgentUsageMeter {
  if (Number.isFinite(tokens) && (tokens as number) >= 0) meter.tokens = Math.floor(tokens as number);
  meter.durationMs = Math.max(0, Math.min(7 * 24 * 60 * 60 * 1000, Math.floor(endedAt - meter.startedAt)));
  return meter;
}

export function formatUsageSummary(
  meter: AgentUsageMeter,
  language: "ru" | "uk" | "en" = "en",
): string {
  const sec = Math.round(meter.durationMs / 1000);
  const tok = meter.tokens == null ? "—" : String(meter.tokens);
  if (language === "ru") {
    return `Итог сессии: шагов ${meter.steps}, ~${sec}с, tokens ${tok}, host ${(meter.hostCommands || 0)}, proot ${(meter.prootCommands || 0)}`;
  }
  if (language === "uk") {
    return `Підсумок сесії: кроків ${meter.steps}, ~${sec}с, tokens ${tok}, host ${(meter.hostCommands || 0)}, proot ${(meter.prootCommands || 0)}`;
  }
  return `Session summary: steps ${meter.steps}, ~${sec}s, tokens ${tok}, host ${(meter.hostCommands || 0)}, proot ${(meter.prootCommands || 0)}`;
}

export function formatUsageSummaryBlock(meter: AgentUsageMeter): string {
  return [
    "[USAGE_SUMMARY]",
    `steps=${meter.steps}`,
    `duration_ms=${meter.durationMs}`,
    `tokens=${meter.tokens ?? "unknown"}`,
    `host_commands=${(meter.hostCommands || 0)}`,
    `proot_commands=${(meter.prootCommands || 0)}`,
  ].join("\n");
}
