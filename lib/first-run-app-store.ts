import { FirstRunStoreReadError, type FirstRunStore } from "../core/enhancements/onboarding/FirstRunOrchestrator.ts";

export type FirstRunKeyValueStore = Readonly<{
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}>;
export type FirstRunLegacyTextStore = Readonly<{ read(): Promise<string | null> }>;

/**
 * App-private metadata is authoritative after migration. The legacy Termux HOME
 * marker is read only when the app-private key is absent; a denied/unavailable
 * bridge is an error, never evidence that the marker is missing.
 */
export function createFirstRunAppStore(
  appStorage: FirstRunKeyValueStore,
  legacyStore: FirstRunLegacyTextStore,
  key = "aibuilder.first-run-state.v1",
): FirstRunStore {
  const writeVerified = async (value: string): Promise<void> => {
    const previous = await appStorage.getItem(key);
    try {
      await appStorage.setItem(key, value);
      if (await appStorage.getItem(key) !== value) throw new Error("FIRST_RUN_STATE_READBACK_MISMATCH");
    } catch (error) {
      // Best-effort rollback keeps an earlier valid marker if a write fails.
      try {
        if (previous === null) await appStorage.removeItem(key);
        else await appStorage.setItem(key, previous);
      } catch { /* retain the original failure; never claim a successful write */ }
      throw error;
    }
  };

  return {
    async read() {
      const current = await appStorage.getItem(key);
      if (current !== null) return current;
      let legacy: string | null;
      try { legacy = await legacyStore.read(); }
      catch { throw new FirstRunStoreReadError("LEGACY_STATE_UNAVAILABLE"); }
      if (legacy === null) return null;
      await writeVerified(legacy);
      return legacy;
    },
    write: writeVerified,
    async quarantine(value) {
      const backupKey = `${key}.recovery.${Date.now()}`;
      await appStorage.setItem(backupKey, value);
      if (await appStorage.getItem(backupKey) !== value) throw new Error("FIRST_RUN_RECOVERY_READBACK_MISMATCH");
    },
  };
}

export type FirstRunPromptDeferralStore = Readonly<{
  isDeferred(targetVersion: string): Promise<boolean>;
  defer(targetVersion: string): Promise<void>;
  clear(): Promise<void>;
}>;

/** A prompt-only marker; it never changes the authoritative setup-stage state. */
export function createFirstRunPromptDeferralStore(
  appStorage: FirstRunKeyValueStore,
  key = "aibuilder.first-run-prompt.v1",
): FirstRunPromptDeferralStore {
  const writeVerified = async (value: string): Promise<void> => {
    const previous = await appStorage.getItem(key);
    try {
      await appStorage.setItem(key, value);
      if (await appStorage.getItem(key) !== value) throw new Error("FIRST_RUN_PROMPT_READBACK_MISMATCH");
    } catch (error) {
      try {
        if (previous === null) await appStorage.removeItem(key);
        else await appStorage.setItem(key, previous);
      } catch { /* retain the original error and never report a verified deferral */ }
      throw error;
    }
  };

  return {
    async isDeferred(targetVersion) {
      const raw = await appStorage.getItem(key);
      if (!raw) return false;
      try {
        const value: unknown = JSON.parse(raw);
        if (!value || typeof value !== "object") return false;
        const marker = value as { version?: unknown; targetVersion?: unknown; deferred?: unknown };
        return marker.version === 1 && marker.deferred === true && marker.targetVersion === targetVersion;
      } catch { return false; }
    },
    async defer(targetVersion) {
      if (typeof targetVersion !== "string" || targetVersion.length < 1 || targetVersion.length > 64) {
        throw new Error("FIRST_RUN_PROMPT_VERSION_INVALID");
      }
      await writeVerified(JSON.stringify({ version: 1, targetVersion, deferred: true, updatedAt: Date.now() }));
    },
    async clear() {
      const previous = await appStorage.getItem(key);
      try {
        await appStorage.removeItem(key);
        if (await appStorage.getItem(key) !== null) throw new Error("FIRST_RUN_PROMPT_CLEAR_READBACK_MISMATCH");
      } catch (error) {
        try { if (previous !== null) await appStorage.setItem(key, previous); }
        catch { /* preserve the marker if rollback itself is unavailable */ }
        throw error;
      }
    },
  };
}
