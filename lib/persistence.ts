import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";
import { mirrorDurableRecord } from "./durable-persistence";

function storageErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Fire-and-forget persistence with observable failures. Never logs the value being stored. */
export function persistAsyncStorageItem(key: string, value: string): void {
  void AsyncStorage.setItem(key, value).then(() => {
    void mirrorDurableRecord(key, value).catch(() => undefined);
  }).catch((error: unknown) => {
    console.warn(`[AIB][storage] AsyncStorage write failed for ${key}: ${storageErrorMessage(error)}`);
  });
}

const secureWriteQueues = new Map<string, Promise<void>>();

/** SecureStore write with one retry, serialized by key. Secrets are never newly mirrored to AsyncStorage. */
export function persistSecureStoreItem(key: string, value: string, opts?: { fallbackKey?: string }): Promise<boolean> {
  const previous = secureWriteQueues.get(key) || Promise.resolve();
  const write = previous.catch(() => undefined).then(async () => {
    try {
      await SecureStore.setItemAsync(key, value);
      if (opts?.fallbackKey) {
        try { await AsyncStorage.removeItem(opts.fallbackKey); } catch { /* old plaintext copy remains until a later successful migration */ }
      }
      return true;
    } catch (error: unknown) {
      console.warn(`[AIB][storage] SecureStore write failed for ${key}: ${storageErrorMessage(error)}`);
    }
    try {
      await SecureStore.setItemAsync(key, value);
      if (opts?.fallbackKey) {
        try { await AsyncStorage.removeItem(opts.fallbackKey); } catch { /* best effort cleanup */ }
      }
      return true;
    } catch (error: unknown) {
      console.warn(`[AIB][storage] SecureStore retry failed for ${key}: ${storageErrorMessage(error)}`);
      return false;
    }
  });
  secureWriteQueues.set(key, write.then(() => undefined, () => undefined));
  return write;
}

/** Read SecureStore with AsyncStorage fallback (for keys written via fallbackKey). */
export async function readSecureStoreItem(key: string, fallbackKey?: string): Promise<string | null> {
  try {
    const v = await SecureStore.getItemAsync(key);
    if (v != null && v !== "") return v;
  } catch {
    /* continue to fallback */
  }
  if (fallbackKey) {
    try {
      const v = await AsyncStorage.getItem(fallbackKey);
      if (v != null && v !== "") {
        const migrated = await persistSecureStoreItem(key, v, { fallbackKey });
        if (migrated) return v;
        // Keep an existing legacy value usable for this session when secure
        // storage is unavailable. Do not remove it or create a new plaintext
        // copy; a later successful migration will move it into SecureStore.
        console.warn(`[AIB][storage] Legacy plaintext key ${key} could not be migrated; legacy fallback remains in use for this session`);
        return v;
      }
    } catch {
      /* ignore */
    }
  }
  return null;
}
