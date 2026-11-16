import * as SecureStore from "expo-secure-store";
import type { SecureCredentialStorage } from "./types";
import { AuthError } from "./types";

/** Production provider credentials are persisted exclusively through Expo SecureStore. */
export function createSecureCredentialStorage(): SecureCredentialStorage {
  return {
    get: async (key) => {
      try { return await SecureStore.getItemAsync(key); }
      catch { throw new AuthError("SECURE_STORAGE_FAILED", "Secure credential read failed"); }
    },
    set: async (key, value) => {
      try { await SecureStore.setItemAsync(key, value); }
      catch { throw new AuthError("SECURE_STORAGE_FAILED", "Secure credential write failed"); }
    },
    delete: async (key) => {
      try { await SecureStore.deleteItemAsync(key); }
      catch { throw new AuthError("SECURE_STORAGE_FAILED", "Secure credential deletion failed"); }
    },
  };
}
