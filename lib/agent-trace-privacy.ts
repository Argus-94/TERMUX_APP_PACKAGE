type RecordValue = Record<string, unknown>;

function asRecord(value: unknown): RecordValue | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as RecordValue
    : null;
}

function safeEnum(value: unknown): string | null {
  return typeof value === "string" && /^[a-z0-9_-]{1,80}$/i.test(value)
    ? value
    : null;
}
function finiteNumber(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max ? value : null;
}

/** Keep operational trace metadata while omitting user tasks, commands and captured output. */
export function sanitizeAgentTraceForPersistence(value: unknown): RecordValue | null {
  const source = asRecord(value);
  if (!source) return null;
  const safe: RecordValue = { ...source };
  safe.task = typeof source.task === "string" ? `[USER_TASK_OMITTED chars=${source.task.length}]` : "[USER_TASK_OMITTED]";
  if ("apkPath" in source) safe.apkPath = source.apkPath ? "[PRIVATE_PATH_OMITTED]" : null;
  if (Array.isArray(source.steps)) {
    safe.steps = source.steps.map((rawStep) => {
      const step = asRecord(rawStep);
      if (!step) return null;
      const summary = typeof step.summary === "string" ? step.summary : "";
      const projected: RecordValue = { ...step };
      projected.summary = `[${safeEnum(step.kind) || "step"}_CONTENT_OMITTED chars=${summary.length}]`;
      delete projected.command;
      delete projected.stdoutPreview;
      delete projected.stderrPreview;
      const meta = asRecord(step.meta);
      if (meta) {
        const safeMeta: RecordValue = {};
        for (const [key, item] of Object.entries(meta)) {
          if (/text|prompt|message|content|token|secret|path|command|output|input|url|body|repo|file|name/i.test(key)) continue;
          if (typeof item === "number" || typeof item === "boolean") safeMeta[key] = item;
        }
        projected.meta = safeMeta;
      } else {
        delete projected.meta;
      }
      return projected;
    }).filter(Boolean);
  }
  if (Array.isArray(source.gates)) {
    safe.gates = source.gates.map((rawGate) => {
      const gate = asRecord(rawGate);
      if (!gate) return null;
      return { id: safeEnum(gate.id) || "gate", pass: gate.pass === true, detail: gate.pass === true ? "ok" : "failed" };
    }).filter(Boolean);
  }
  return safe;
}

/** Trajectories retain event shape and timing only; free-form text, paths, commands and output are never stored. */
export function sanitizeAgentTrajectoryForPersistence(value: unknown): RecordValue | null {
  const source = asRecord(value);
  if (!source || source.schemaVersion !== 1 || !safeEnum(source.id)) return null;
  const stepKinds = new Set(["playbook", "shell", "tool", "gate", "decision", "done", "error"]);
  const statuses = new Set(["pass", "fail", "skip"]);
  const backends = new Set(["termux", "ubuntu-proot", "guest", "host-termux", "embedded-private", "unknown"]);
  const steps = Array.isArray(source.steps) ? source.steps.slice(-200).map((raw) => {
    const step = asRecord(raw);
    if (!step || typeof step.kind !== "string" || !stepKinds.has(step.kind)) return null;
    const backend = typeof step.backend === "string" && backends.has(step.backend) ? step.backend : "unknown";
    const status = typeof step.status === "string" && statuses.has(step.status) ? step.status : "skip";
    const action = typeof step.action === "string" && /^[a-z0-9_.:-]{1,80}$/i.test(step.action) ? step.action : null;
    const operationClass = ["read", "write-shared", "write-project", "shell-destructive", "network", "github"].includes(String(step.operationClass)) ? String(step.operationClass) : null;
    const resultMarker = ["PLAYBOOK_OK", "PLAYBOOK_FAIL", "AIB_GOAL_OK", "GOAL_GATE_BLOCK"].includes(String(step.resultMarker)) ? String(step.resultMarker) : null;
    const fingerprintKey = typeof step.fingerprintKey === "string" && /^fp-[a-f0-9]{8}$/i.test(step.fingerprintKey) ? step.fingerprintKey.toLowerCase() : null;
    return {
      kind: step.kind,
      ...(action ? { action } : {}),
      ...(operationClass ? { operationClass } : {}),
      ...(resultMarker ? { resultMarker } : {}),
      ...(fingerprintKey ? { fingerprintKey } : {}),
      backend,
      status,
      ...(finiteNumber(step.exitCode, -100_000, 100_000) !== null ? { exitCode: step.exitCode } : {}),
      ...(finiteNumber(step.durationMs, 0, 86_400_000) !== null ? { durationMs: step.durationMs } : {}),
      at: finiteNumber(step.at) ?? 0,
      summary: `${step.kind}:${status}`,
    };
  }).filter(Boolean) : [];
  const usage = asRecord(source.usage) || {};
  const tokenCount = finiteNumber(usage.tokens, 0, 10_000_000);
  const outcome = ["running", "pass", "fail", "abort"].includes(String(source.outcome)) ? String(source.outcome) : "abort";
  const backend = typeof source.backend === "string" && backends.has(source.backend) ? source.backend : "unknown";
  const goalKind = safeEnum(source.goalKind) || "generic";
  const sessionId = safeEnum(source.sessionId);
  const projectKey = typeof source.projectKey === "string" && /^p-[a-f0-9]{8}$/i.test(source.projectKey) ? source.projectKey : undefined;
  const blame = Array.isArray(source.blame) ? source.blame.slice(-200).map((raw) => {
    const row = asRecord(raw);
    if (!row || typeof row.pathKey !== "string" || !/^p-[a-f0-9]{8}$/i.test(row.pathKey)) return null;
    return { pathKey: row.pathKey, step: Math.max(0, Math.floor(finiteNumber(row.step) ?? 0)), summary: safeEnum(row.summary) || "step" };
  }).filter(Boolean) : [];
  return {
    schemaVersion: 1,
    id: safeEnum(source.id),
    ...(sessionId ? { sessionId } : {}),
    ...(projectKey ? { projectKey } : {}),
    task: typeof source.task === "string" ? `[USER_TASK_OMITTED chars=${source.task.length}]` : "[USER_TASK_OMITTED]",
    goalKind,
    backend,
    startedAt: finiteNumber(source.startedAt) ?? 0,
    ...(finiteNumber(source.endedAt) !== null ? { endedAt: source.endedAt } : {}),
    outcome,
    steps,
    usage: {
      steps: Math.min(100_000, Math.max(0, Math.floor(finiteNumber(usage.steps) ?? steps.length))),
      durationMs: Math.min(604_800_000, Math.max(0, Math.floor(finiteNumber(usage.durationMs) ?? 0))),
      tokens: tokenCount,
    },
    blame,
  };
}

/** Failure fixtures retain classification and counts, never user paths or captured output. */
export function sanitizeFailureFixtureForPersistence(value: unknown): RecordValue | null {
  const source = asRecord(value);
  if (!source || source.schemaVersion !== 1) return null;
  const id = typeof source.id === "string" && /^fp-[a-z0-9_-]{1,80}$/i.test(source.id) ? source.id : null;
  if (!id) return null;
  const goal = asRecord(source.goal);
  const expected = asRecord(source.expected);
  const rows = Array.isArray(source.steps) ? source.steps.slice(-40).map((raw) => {
    const step = asRecord(raw);
    if (!step) return null;
    return {
      kind: safeEnum(step.kind) || "step",
      status: safeEnum(step.status) || "skip",
      backend: safeEnum(step.backend) || "unknown",
      ...(finiteNumber(step.exitCode, -100_000, 100_000) !== null ? { exitCode: step.exitCode } : {}),
    };
  }).filter(Boolean) : [];
  return {
    schemaVersion: 1,
    id,
    fingerprint: safeEnum(source.fingerprint) || id.slice(3),
    createdAt: finiteNumber(source.createdAt) ?? 0,
    task: "[USER_TASK_OMITTED]",
    backend: safeEnum(source.backend) || "unknown",
    goal: { kind: safeEnum(goal?.kind) || "generic", mustExist: Array.isArray(goal?.mustExist) && goal.mustExist.length ? ["[USER_PATH_OMITTED]"] : [] },
    steps: rows,
    stdout: typeof source.stdout === "string" ? `[REDACTED chars=${source.stdout.length}]` : "[REDACTED]",
    stderr: typeof source.stderr === "string" ? `[REDACTED chars=${source.stderr.length}]` : "[REDACTED]",
    expected: { mustContain: expected?.mustContain === "AIB_GOAL_OK" ? "AIB_GOAL_OK" : "AIB_GOAL_OK" },
  };
}

/** Promoted fixtures keep failure classification only; free-form text is not persisted. */
export function sanitizePromotedFixtureForPersistence(value: unknown): RecordValue | null {
  const source = asRecord(value);
  if (!source) return null;
  const cluster = safeEnum(source.cluster);
  const recipeId = safeEnum(source.recipeId);
  return {
    id: safeEnum(source.id) || "fixture",
    sourceTraceId: safeEnum(source.sourceTraceId) || "trace",
    task: cluster ? `Regression fixture: ${cluster}` : "Regression fixture: private task omitted",
    cluster,
    recipeId,
    sampleDoneFail: cluster ? `AIB_TRACE_FAILURE_CLUSTER=${cluster}` : "AIB_TRACE_FAILURE_CLUSTER=unknown",
    ...(typeof source.createdAt === "number" && Number.isFinite(source.createdAt) ? { createdAt: source.createdAt } : {}),
  };
}
