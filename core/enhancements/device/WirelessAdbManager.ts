import { DevicePolicy } from "./DevicePolicy.ts";
import type { AdbPairingAdapter } from "./types.ts";

export type AdbHostPort = string;
const PORT_RE = /^(?:((?:\d{1,3}\.){3}\d{1,3})|\[([0-9a-fA-F:]+)\]):(\d{1,5})$/;
export function validateAdbHostPort(value: string): AdbHostPort {
  if (typeof value !== "string" || value.length > 64 || /\s|[@/\\]/.test(value)) throw new Error("ADB_INVALID_HOST_PORT");
  const match = PORT_RE.exec(value);
  if (!match) throw new Error("ADB_INVALID_HOST_PORT");
  const port = Number(match[3]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("ADB_INVALID_PORT");
  if (match[1] && match[1].split(".").some((n) => Number(n) < 0 || Number(n) > 255 || !/^\d{1,3}$/.test(n))) throw new Error("ADB_INVALID_IP");
  if (match[2] && (match[2].split(":").length < 3 || !/^[0-9a-fA-F:]+$/.test(match[2]))) throw new Error("ADB_INVALID_IP");
  return value;
}
/** The six-digit pairing code is forwarded once and never returned, logged, or stored here. */
export class WirelessAdbManager {
  private readonly policy: DevicePolicy; private readonly adapter: AdbPairingAdapter;
  constructor(policy: DevicePolicy, adapter: AdbPairingAdapter) { this.policy = policy; this.adapter = adapter; }
  async pair(hostPort: string, pairingCode: string): Promise<{ ok: boolean; message: string }> {
    const address = validateAdbHostPort(hostPort);
    if (typeof pairingCode !== "string" || !/^\d{6}$/.test(pairingCode)) throw new Error("ADB_INVALID_PAIRING_CODE");
    return this.policy.run("adb.pair", async () => { const result = await this.adapter.pair(address, pairingCode); return { ok: !!result.ok, message: result.ok ? "Paired; connect using the Wireless debugging connection port." : "Pairing failed or Termux ADB is unavailable." }; });
  }
  async connect(hostPort: string): Promise<{ ok: boolean; message: string }> {
    const address = validateAdbHostPort(hostPort);
    return this.policy.run("adb.connect", () => this.connectAndVerify(address));
  }
  async list(): Promise<{ ok: boolean; devices: readonly { serial: string; state: string }[] }> {
    return this.policy.run("adb.list", async () => { const result = await this.adapter.list(); return { ok: !!result.ok, devices: Object.freeze((result.devices || []).slice(0, 32).map((d) => ({ serial: scrubSerial(d.serial), state: safeState(d.state) }))) }; });
  }
  /** Manual/event-driven reconnect only: no polling or persisted pairing secrets. */
  async reconnect(): Promise<{ ok: boolean; message: string }> {
    return this.policy.run("adb.reconnect", async () => {
      if (!this.adapter.loadLastHost) return { ok: false, message: "Reconnect unavailable: Termux bridge is not configured." };
      const last = await this.adapter.loadLastHost();
      if (!last) return { ok: false, message: "No previous ADB address is available." };
      return this.connectAndVerify(validateAdbHostPort(last), "Reconnected.");
    });
  }

  private async connectAndVerify(address: string, successMessage = "Connected."): Promise<{ ok: boolean; message: string }> {
    try {
      const connected = await this.adapter.connect(address);
      const devices = await this.adapter.list();
      const isOnline = devices.ok && devices.devices.some((device) => device.serial === address && device.state === "device");
      if (isOnline) return { ok: true, message: successMessage };
      return {
        ok: false,
        message: connected.ok
          ? "ADB accepted the connection, but the target is not authorized and online (device state is not `device`)."
          : "Connect failed, timed out, or the target is not authorized and online.",
      };
    } catch {
      return { ok: false, message: "Connect failed, timed out, or Termux ADB is unavailable." };
    }
  }
}
function scrubSerial(v: string): string { return typeof v === "string" && /^[\w.:[\]-]{1,128}$/.test(v) ? v : "[invalid serial]"; }
function safeState(v: string): string { return ["device", "offline", "unauthorized", "unknown"].includes(v) ? v : "unknown"; }
/** Lazy adapter calls the existing restricted adb-pairing helper (adb pair/connect/devices only). */
export function createTermuxAdbPairingAdapter(): AdbPairingAdapter {
  return {
    async pair(hostPort, code) { const m = await import("../../../lib/adb-pairing"); const r = await m.adbPair(hostPort, code); return { ok: r.ok, message: "" }; },
    async connect(hostPort) { const m = await import("../../../lib/adb-pairing"); const r = await m.adbConnect(hostPort); return { ok: r.ok, message: "" }; },
    async list() { const m = await import("../../../lib/adb-pairing"); const r = await m.adbListDevices(); return { ok: r.ok, devices: (r.devices || []).map(({serial,state}) => ({serial,state})) }; },
    async loadLastHost() { const m = await import("../../../lib/adb-pairing"); return m.loadLastAdbHost(); },
  };
}
