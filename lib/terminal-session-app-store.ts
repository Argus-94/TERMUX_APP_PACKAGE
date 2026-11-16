import type { TerminalPreferenceStore } from "../core/enhancements/terminal/types";

export type TerminalSessionAppStorage = Readonly<{
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}>;

/** Terminal snapshots belong to the app sandbox, not the user-visible shared project directory. */
export function createTerminalSessionAppStore(storage: TerminalSessionAppStorage): TerminalPreferenceStore {
  return Object.freeze({
    get: (key) => storage.getItem(key),
    set: async (key, value) => { await storage.setItem(key, value); },
  });
}
