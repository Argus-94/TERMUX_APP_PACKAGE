import { NativeModules, Platform } from 'react-native';

export type DeviceWatchdogState = 'started' | 'stopped' | 'unavailable';

function native(): { start(): Promise<boolean>; stop(): Promise<boolean> } | null {
  if (Platform.OS !== 'android') return null;
  const mod = NativeModules.AibDeviceWatchdog;
  return mod && typeof mod.start === 'function' && typeof mod.stop === 'function' ? mod : null;
}

export async function startDeviceWatchdog(): Promise<DeviceWatchdogState> {
  const n = native();
  if (!n) return 'unavailable';
  try { await n.start(); return 'started'; } catch { return 'unavailable'; }
}
export async function stopDeviceWatchdog(): Promise<DeviceWatchdogState> {
  const n = native();
  if (!n) return 'unavailable';
  try { await n.stop(); return 'stopped'; } catch { return 'unavailable'; }
}
