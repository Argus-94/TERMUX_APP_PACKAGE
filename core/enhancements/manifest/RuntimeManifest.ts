import type { ProcessRegistry } from "../../process/ProcessRegistry";
import { ManifestError, type ManifestCapability, type ManifestProcess, type ManifestProcessAdapter, type RuntimeManifest, type ValidationIssue, type ValidationResult } from "./types";

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const CAPABILITIES = new Set<ManifestCapability>(["terminal", "network", "filesystem.read", "filesystem.write", "web", "build"]);
const SECRET_VALUE = /(?:\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|xox[baprs]-[A-Za-z0-9-]{12,})\b|-----BEGIN[[:space:]]+(?:RSA[[:space:]]+|EC[[:space:]]+|OPENSSH[[:space:]]+)?PRIVATE[[:space:]]+KEY-----|Bearer[[:space:]]+[A-Za-z0-9._~+/-]{16,})/i;
const SECRET_VALUE_WORD = /(?:^|[^A-Za-z0-9])(?:secret|token|password|credential|api[_ -]?key|private[_ -]?key|bearer)(?:$|[^A-Za-z0-9])/i;
function validCommand(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0 && value.length <= 2048 && !value.includes("\0"); }
function looksLikeSecretValue(value: string): boolean { return SECRET_VALUE.test(value) || SECRET_VALUE_WORD.test(value); }

/** Validate manifest data before any process launch. Unknown object properties fail closed. */
export function validateManifest(value: unknown): ValidationResult {
  const issues: ValidationIssue[] = [];
  const issue = (path: string, code: string, message: string) => issues.push({ path, code, message });
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, issues: [{ path: "$", code: "TYPE", message: "Manifest must be an object" }] };
  const m = value as Record<string, unknown>;
  const allowed = new Set(["version", "web", "workers", "build", "health", "restartAfterTask", "env", "capabilities"]);
  for (const key of Object.keys(m)) if (!allowed.has(key)) issue(key, "UNKNOWN_FIELD", "Unknown manifest field");
  if (m.version !== 1) issue("version", "VERSION", "Only manifest version 1 is supported");
  if (m.web !== undefined) {
    if (!m.web || typeof m.web !== "object" || Array.isArray(m.web)) issue("web", "TYPE", "web must be an object");
    else {
      const w = m.web as Record<string, unknown>;
      if (!validCommand(w.command)) issue("web.command", "COMMAND", "A bounded command is required");
      if (w.port !== undefined && (!Number.isInteger(w.port) || (w.port as number) < 1 || (w.port as number) > 65535)) issue("web.port", "PORT", "Port must be 1..65535");
      if (w.health !== undefined && !validCommand(w.health)) issue("web.health", "COMMAND", "Health command is invalid");
      for (const key of Object.keys(w)) if (!["command", "port", "health"].includes(key)) issue(`web.${key}`, "UNKNOWN_FIELD", "Unknown web field");
    }
  }
  let workerCount = 0;
  if (m.workers !== undefined) {
    if (!Array.isArray(m.workers) || m.workers.length > 32) issue("workers", "TYPE", "workers must be an array with at most 32 entries");
    else {
      workerCount = m.workers.length;
      const names = new Set<string>();
      m.workers.forEach((item, i) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) { issue(`workers.${i}`, "TYPE", "worker must be an object"); return; }
        const w = item as Record<string, unknown>;
        if (typeof w.name !== "string" || !NAME_RE.test(w.name)) issue(`workers.${i}.name`, "NAME", "Invalid worker name");
        else if (names.has(w.name)) issue(`workers.${i}.name`, "DUPLICATE", "Worker names must be unique");
        else names.add(w.name);
        if (!validCommand(w.command)) issue(`workers.${i}.command`, "COMMAND", "A bounded command is required");
        if (w.restart !== undefined && typeof w.restart !== "boolean") issue(`workers.${i}.restart`, "TYPE", "restart must be boolean");
        for (const key of Object.keys(w)) if (!["name", "command", "restart"].includes(key)) issue(`workers.${i}.${key}`, "UNKNOWN_FIELD", "Unknown worker field");
      });
    }
  }
  if (m.build !== undefined) {
    if (!m.build || typeof m.build !== "object" || Array.isArray(m.build)) issue("build", "TYPE", "build must be an object");
    else {
      const b = m.build as Record<string, unknown>;
      if (!validCommand(b.command)) issue("build.command", "COMMAND", "A bounded command is required");
      if (b.afterTask !== undefined && typeof b.afterTask !== "boolean") issue("build.afterTask", "TYPE", "afterTask must be boolean");
      for (const key of Object.keys(b)) if (!["command", "afterTask"].includes(key)) issue(`build.${key}`, "UNKNOWN_FIELD", "Unknown build field");
    }
  }
  if (m.health !== undefined) {
    if (!m.health || typeof m.health !== "object" || Array.isArray(m.health)) issue("health", "TYPE", "health must be an object");
    else {
      const h = m.health as Record<string, unknown>;
      if (!validCommand(h.command)) issue("health.command", "COMMAND", "Health command is invalid");
      if (h.intervalMs !== undefined && (!Number.isInteger(h.intervalMs) || (h.intervalMs as number) < 1000 || (h.intervalMs as number) > 3_600_000)) issue("health.intervalMs", "RANGE", "intervalMs must be 1000..3600000");
      for (const key of Object.keys(h)) if (!["command", "intervalMs"].includes(key)) issue(`health.${key}`, "UNKNOWN_FIELD", "Unknown health field");
    }
    if (m.web === undefined && workerCount === 0) issue("health", "UNUSED", "Health checks require at least one managed web process or worker");
  }
  if (m.restartAfterTask !== undefined && typeof m.restartAfterTask !== "boolean") issue("restartAfterTask", "TYPE", "restartAfterTask must be boolean");
  if (m.env !== undefined) {
    if (!m.env || typeof m.env !== "object" || Array.isArray(m.env)) issue("env", "TYPE", "env must be a string map");
    else for (const [key, val] of Object.entries(m.env as Record<string, unknown>)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key) || /(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH)/i.test(key)) issue(`env.${key}`, "SECRET_OR_NAME", "Secret-like or invalid environment names are forbidden");
      if (typeof val !== "string" || val.length > 4096 || val.includes("\0")) issue(`env.${key}`, "VALUE", "Environment values must be bounded strings");
      else if (looksLikeSecretValue(val)) issue(`env.${key}`, "SECRET_VALUE", "Credential-like environment values are forbidden even under non-secret field names");
    }
  }
  if (m.capabilities !== undefined) {
    if (!Array.isArray(m.capabilities) || m.capabilities.some((c) => typeof c !== "string" || !CAPABILITIES.has(c as ManifestCapability))) issue("capabilities", "CAPABILITY", "Manifest contains an unsupported capability");
    else if (new Set(m.capabilities).size !== m.capabilities.length) issue("capabilities", "DUPLICATE", "Manifest capabilities must be unique");
  }
  return { ok: issues.length === 0, issues };
}

/** Apply services after explicit capability-aware authorization and ownership-safe registration. */
export async function applyManifest(registry: ProcessRegistry, adapter: ManifestProcessAdapter, manifest: RuntimeManifest, projectId: string): Promise<readonly string[]> {
  const validation = validateManifest(manifest);
  if (!validation.ok) throw new ManifestError("VALIDATION_FAILED", "Runtime manifest failed validation", validation.issues);
  const capabilities = manifest.capabilities ?? [];
  const processes: ManifestProcess[] = [];
  const healthIntervalMs = manifest.health?.intervalMs ?? 5_000;
  if (manifest.web) processes.push({ name: "web", command: manifest.web.command, env: manifest.env ?? {}, capabilities, healthCommand: manifest.web.health ?? manifest.health?.command, healthIntervalMs, restart: true, restartAfterTask: manifest.restartAfterTask ?? false });
  for (const worker of manifest.workers ?? []) processes.push({ name: worker.name, command: worker.command, env: manifest.env ?? {}, capabilities, healthCommand: manifest.health?.command, healthIntervalMs, restart: worker.restart ?? true, restartAfterTask: manifest.restartAfterTask ?? false });
  const started: Array<{ id: string; name: string; pid?: number | string }> = [];
  try {
    for (const process of processes) {
      if (!(await adapter.authorize(process.command, process.name, capabilities))) throw new ManifestError("POLICY_DENIED", `Policy denied manifest process: ${process.name}`);
      if (process.healthCommand && !(await adapter.authorize(process.healthCommand, `${process.name}:health`, capabilities))) throw new ManifestError("POLICY_DENIED", `Policy denied manifest health probe: ${process.name}`);
      const result = await adapter.start(process, { occupiedIds: registry.list().map((registered) => registered.id) });
      if (!result || typeof result.id !== "string" || !/^[A-Za-z0-9._:-]{1,160}$/.test(result.id) || registry.get(result.id)) throw new ManifestError("APPLY_FAILED", "Manifest adapter returned an invalid or occupied process id");
      registry.register({ id: result.id, kind: "runtime", projectId, label: process.name, startedAt: Date.now(), pid: result.pid, metadata: { watchdog: "true", healthCommand: process.healthCommand ?? "", healthIntervalMs: String(process.healthIntervalMs), restart: String(process.restart), restartAfterTask: String(process.restartAfterTask), manifestManaged: "true" } });
      // Only processes that this call successfully registered are eligible for rollback.
      started.push({ ...result, name: process.name });
    }
    if (manifest.build && manifest.build.afterTask !== true) {
      if (!adapter.runOnce || !(await adapter.authorize(manifest.build.command, "build", capabilities))) throw new ManifestError("POLICY_DENIED", "Build command is not authorized");
      await adapter.runOnce(manifest.build.command, manifest.env ?? {}, capabilities);
    }
    return started.map((process) => process.id);
  } catch (error) {
    for (const process of started.reverse()) {
      try { await adapter.stop(process.id); registry.unregister(process.id); }
      catch { registry.patchMetadata(process.id, { health: "quarantined", manifestRollbackStopFailed: "true", watchdogStopFailedAt: String(Date.now()) }); }
    }
    if (error instanceof ManifestError) throw error;
    throw new ManifestError("APPLY_FAILED", "Manifest process application failed");
  }
}
