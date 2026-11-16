import type { RuntimeLiveSnapshot } from "./types";

/** Create an immutable snapshot and omit unknown resource values instead of inventing measurements. */
export function createRuntimeLiveSnapshot(input: RuntimeLiveSnapshot): RuntimeLiveSnapshot {
  const cleanBackends = input.backends.map((backend) => Object.freeze({
    id: backend.id.slice(0, 80), status: backend.status,
    ...(Number.isFinite(backend.latencyMs) && (backend.latencyMs ?? -1) >= 0 ? { latencyMs: backend.latencyMs } : {}),
  }));
  const cleanContainers = input.containers.slice(0, 64).map((container) => Object.freeze({
    id: container.id.slice(0, 120), name: container.name.slice(0, 120), state: container.state,
    ...(Number.isFinite(container.memoryMb) && (container.memoryMb ?? -1) >= 0 ? { memoryMb: container.memoryMb } : {}),
  }));
const resources = Object.freeze({
    ...(Number.isFinite(input.resources.memUsedMb) && (input.resources.memUsedMb ?? -1) >= 0 ? { memUsedMb: input.resources.memUsedMb } : {}),
    ...(Number.isFinite(input.resources.memTotalMb) && (input.resources.memTotalMb ?? -1) > 0 ? { memTotalMb: input.resources.memTotalMb } : {}),
    ...(Number.isFinite(input.resources.batteryLevel) && (input.resources.batteryLevel ?? -1) >= 0 && (input.resources.batteryLevel ?? 101) <= 100 ? { batteryLevel: input.resources.batteryLevel } : {}),
    ...(typeof input.resources.isCharging === "boolean" ? { isCharging: input.resources.isCharging } : {}),
  });
  const allowedUnavailable = new Set(["backends", "containers", "processes", "resources", "portForwards", "interceptor"]);
  const unavailable = [...new Set((input.unavailable ?? []).filter((name) => allowedUnavailable.has(name)))].slice(0, allowedUnavailable.size);
  return Object.freeze({
    timestamp: Number.isFinite(input.timestamp) ? input.timestamp : Date.now(),
    backends: Object.freeze(cleanBackends), containers: Object.freeze(cleanContainers),
    processes: Object.freeze({ total: Math.max(0, Math.floor(input.processes.total)), supervised: Math.max(0, Math.floor(input.processes.supervised)), quarantined: Math.max(0, Math.floor(input.processes.quarantined)) }),
    resources, portForwards: Math.max(0, Math.floor(input.portForwards)),
    ...(input.interceptorActive === true ? { interceptorActive: true } : {}),
    ...(input.lastError ? { lastError: input.lastError.slice(0, 240) } : {}),
    ...(unavailable.length ? { unavailable: Object.freeze(unavailable) } : {}),
  });
}
