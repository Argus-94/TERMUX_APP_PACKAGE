/**
 * Optional native accelerator loader (plan G).
 * NativeModules.AibNativeAccel — open MIT module from plugins/withAibNativeAccel.js
 */
import { NativeModules, Platform } from "react-native";
import { persistentLogger } from "../../lib/persistent-logger";

export type NativeAccelProbe = {
  ok: boolean;
  /** True only when cwd/env/timeout and the shared Termux workspace are honored. */
  supportsRuntimeContext?: boolean;
  detail?: string;
  jni?: boolean;
  version?: string;
};

export type NativeAccelExecRequest = {
  command: string;
  cwd?: string;
  timeoutMs?: number;
  env?: Readonly<Record<string, string>>;
};

export type NativeAccelModule = {
  isAvailable: () => Promise<boolean>;
  probe: () => Promise<NativeAccelProbe>;
  exec: (request: NativeAccelExecRequest) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
  mapPath?: (path: string, from: string, to: string) => Promise<string>;
};

export function getNativeAccelModule(): NativeAccelModule | null {
  if (Platform.OS !== "android") return null;
  try {
    const mod = (NativeModules as { AibNativeAccel?: NativeAccelModule }).AibNativeAccel;
    if (!mod || typeof mod !== "object") return null;
    if (typeof mod.isAvailable !== "function" || typeof mod.probe !== "function" || typeof mod.exec !== "function") return null;
    return mod;
  } catch {
    return null;
  }
}

export async function isNativeAccelLinked(): Promise<boolean> {
  const mod = getNativeAccelModule();
  if (!mod) {
    return false;
  }
  try {
    const available = await mod.isAvailable();
    if (!available) {
      persistentLogger.add("info", "NativeAccel", "module present but isAvailable=false");
      return false;
    }
    const p = await mod.probe();
    const ok = !!p?.ok && p.supportsRuntimeContext === true;
    persistentLogger.add(
      "info",
      "NativeAccel",
      `probe ok=${ok} jni=${!!p?.jni} ${p?.detail || ""}`.trim(),
    );
    return ok;
  } catch (e: unknown) {
    persistentLogger.add(
      "warn",
      "NativeAccel",
      `probe failed: ${e instanceof Error ? e.message : String(e)}`,
    );
    return false;
  }
}
