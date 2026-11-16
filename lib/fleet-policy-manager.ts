import type { RuntimeFacade } from "../core/RuntimeFacade";
import type { ReleaseChannel } from "./release-channel-manager";

export type FleetRole = "viewer" | "operator" | "release-manager" | "admin";
export type FleetAction = "view" | "deploy" | "rollback" | "canary" | "acknowledge_incident" | "set_policy";

export type FleetPolicy = {
  role: FleetRole;
  requireProductionConfirmation: boolean;
  productionConfirmationPhrase: string;
  updatedAt: string;
};

export type FleetAuditEntry = {
  id: string;
  at: string;
  role: FleetRole;
  action: FleetAction;
  channel: ReleaseChannel;
  serial?: string;
  result: "allowed" | "denied" | "executed";
  reason?: string;
};

const ROLES: FleetRole[] = ["viewer", "operator", "release-manager", "admin"];
const CHANNELS: ReleaseChannel[] = ["debug", "internal", "beta", "production"];
const DEFAULT_PHRASE = "DEPLOY PRODUCTION";

function q(v: string): string { return `'${String(v).replace(/'/g, `\'"'"\'`)}'`; }
function safeSegment(v: string): boolean { return /^[A-Za-z0-9._:-]{1,128}$/.test(v); }
function validRole(v: string): v is FleetRole { return ROLES.includes(v as FleetRole); }
function validChannel(v: string): v is ReleaseChannel { return CHANNELS.includes(v as ReleaseChannel); }

function allowed(role: FleetRole, action: FleetAction, channel: ReleaseChannel): boolean {
  if (action === "view" || action === "acknowledge_incident") return role !== "viewer" || action === "view";
  if (action === "set_policy") return role === "admin";
  if (action === "deploy" || action === "canary") {
    if (channel === "production") return role === "release-manager" || role === "admin";
    return role !== "viewer";
  }
  if (action === "rollback") {
    if (channel === "production") return role === "admin" || role === "release-manager";
    return role !== "viewer";
  }
  return false;
}

async function readPolicy(runtime: RuntimeFacade, projectPath: string): Promise<FleetPolicy> {
  const path = `${projectPath}/artifacts/deployments/fleet-policy.json`;
  const r = await runtime.environment.exec(`if [ -f ${q(path)} ]; then cat ${q(path)}; fi`, {});
  if (r.stdout?.trim()) {
    try {
      const parsed = JSON.parse(r.stdout) as Partial<FleetPolicy>;
      if (parsed.role && validRole(parsed.role)) return {
        role: parsed.role,
        requireProductionConfirmation: parsed.requireProductionConfirmation !== false,
        productionConfirmationPhrase: typeof parsed.productionConfirmationPhrase === "string" && parsed.productionConfirmationPhrase.length >= 8 ? parsed.productionConfirmationPhrase : DEFAULT_PHRASE,
        updatedAt: parsed.updatedAt || new Date().toISOString(),
      };
    } catch { /* fallback */ }
  }
  return { role: "operator", requireProductionConfirmation: true, productionConfirmationPhrase: DEFAULT_PHRASE, updatedAt: new Date().toISOString() };
}

async function appendAudit(runtime: RuntimeFacade, projectPath: string, entry: FleetAuditEntry): Promise<void> {
  const dir = `${projectPath}/artifacts/deployments`;
  const path = `${dir}/fleet-audit.jsonl`;
  const chainPath = `${dir}/fleet-audit-chain.jsonl`;
  const line = JSON.stringify(entry);
  const prevResult = await runtime.environment.exec(`if [ -f ${q(chainPath)} ]; then tail -n 1 ${q(chainPath)}; fi`, {});
  let prevHash = "GENESIS";
  try { const last = JSON.parse(String(prevResult.stdout || "")); if (last?.hash) prevHash = String(last.hash).toLowerCase(); } catch {}
  const canonical = JSON.stringify({ id: entry.id, at: entry.at, role: entry.role, action: entry.action, channel: entry.channel, serial: entry.serial, result: entry.result, reason: entry.reason });
  const hashResult = await runtime.environment.exec(`printf '%s\\n%s' ${q(prevHash)} ${q(canonical)} | sha256sum | awk '{print $1}'`, {});
  const hash = String(hashResult.stdout || "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("SHA256_UNAVAILABLE_FOR_AUDIT");
  const chainLine = JSON.stringify({ ...entry, prevHash, hash });
  await runtime.environment.exec(`mkdir -p ${q(dir)}; printf '%s\\n' ${q(line)} >> ${q(path)}; printf '%s\\n' ${q(chainLine)} >> ${q(chainPath)}`, {});
}

export async function getFleetPolicy(options: { runtime: RuntimeFacade; projectPath: string }): Promise<FleetPolicy> {
  return readPolicy(options.runtime, options.projectPath);
}

export async function setFleetPolicy(options: {
  runtime: RuntimeFacade;
  projectPath: string;
  role: FleetRole;
  requireProductionConfirmation?: boolean;
  productionConfirmationPhrase?: string;
}): Promise<FleetPolicy> {
  if (!validRole(options.role)) throw new Error("INVALID_FLEET_ROLE");
  const current = await readPolicy(options.runtime, options.projectPath);
  const next: FleetPolicy = {
    role: options.role,
    requireProductionConfirmation: options.requireProductionConfirmation ?? current.requireProductionConfirmation,
    productionConfirmationPhrase: options.productionConfirmationPhrase && options.productionConfirmationPhrase.length >= 8 ? options.productionConfirmationPhrase : current.productionConfirmationPhrase,
    updatedAt: new Date().toISOString(),
  };
  const path = `${options.projectPath}/artifacts/deployments/fleet-policy.json`;
  const tmp = `${path}.tmp-${Date.now()}`;
  await options.runtime.environment.exec(`mkdir -p ${q(options.projectPath + "/artifacts/deployments")}; printf '%s\\n' ${q(JSON.stringify(next, null, 2))} > ${q(tmp)}; mv -f ${q(tmp)} ${q(path)}`, {});
  await appendAudit(options.runtime, options.projectPath, { id: `audit-${Date.now()}`, at: next.updatedAt, role: next.role, action: "set_policy", channel: "internal", result: "executed" });
  return next;
}

export async function authorizeFleetAction(options: {
  runtime: RuntimeFacade;
  projectPath: string;
  action: FleetAction;
  channel: ReleaseChannel;
  serial?: string;
  confirmation?: string;
}): Promise<{ allowed: true; policy: FleetPolicy } | { allowed: false; policy: FleetPolicy; reason: string }> {
  if (!validChannel(options.channel)) throw new Error("INVALID_RELEASE_CHANNEL");
  if (options.serial && !safeSegment(options.serial)) throw new Error("INVALID_DEVICE_SERIAL");
  const policy = await readPolicy(options.runtime, options.projectPath);
  let reason = "";
  let ok = allowed(policy.role, options.action, options.channel);
  if (!ok) reason = "ROLE_NOT_AUTHORIZED";
  if (ok && options.channel === "production" && (options.action === "deploy" || options.action === "rollback" || options.action === "canary") && policy.requireProductionConfirmation) {
    if (options.confirmation !== policy.productionConfirmationPhrase) {
      ok = false;
      reason = "PRODUCTION_CONFIRMATION_REQUIRED";
    }
  }
  await appendAudit(options.runtime, options.projectPath, {
    id: `audit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    at: new Date().toISOString(),
    role: policy.role,
    action: options.action,
    channel: options.channel,
    serial: options.serial,
    result: ok ? "allowed" : "denied",
    reason: ok ? undefined : reason,
  });
  return ok ? { allowed: true, policy } : { allowed: false, policy, reason };
}

export async function recordFleetExecution(options: {
  runtime: RuntimeFacade;
  projectPath: string;
  role: FleetRole;
  action: FleetAction;
  channel: ReleaseChannel;
  serial?: string;
  success: boolean;
  reason?: string;
}): Promise<void> {
  await appendAudit(options.runtime, options.projectPath, {
    id: `audit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    at: new Date().toISOString(),
    role: options.role,
    action: options.action,
    channel: options.channel,
    serial: options.serial,
    result: "executed",
    reason: options.success ? undefined : options.reason || "EXECUTION_FAILED",
  });
}

export async function listFleetAudit(options: { runtime: RuntimeFacade; projectPath: string; limit?: number }): Promise<FleetAuditEntry[]> {
  const path = `${options.projectPath}/artifacts/deployments/fleet-audit.jsonl`;
  const r = await options.runtime.environment.exec(`if [ -f ${q(path)} ]; then tail -n ${Math.min(Math.max(options.limit || 50, 1), 500)} ${q(path)}; fi`, {});
  return String(r.stdout || "").split(/\r?\n/).filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean) as FleetAuditEntry[];
}
