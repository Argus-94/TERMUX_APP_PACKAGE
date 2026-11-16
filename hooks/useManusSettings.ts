import { useCallback, useEffect, useRef, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { hasProviderCredential, saveProviderCredential } from "../core/enhancements/auth/productionProviderTransport";
import type { ManusProfile } from "../lib/manus-api";

const STORE = "aibuilder.manus.settings.v1";
const PROFILES: ManusProfile[] = ["standard", "lite", "max", "max-medium", "max-high", "max-extra", "max-ultra"];
export interface ManusSettings { loaded: boolean; hasApiKey: boolean; profile: ManusProfile; binding: string }
const initial: ManusSettings = { loaded: false, hasApiKey: false, profile: "standard", binding: "" };
function freshBinding() { return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`; }

export function useManusSettings() {
  const [manus, setManus] = useState<ManusSettings>(initial);
  const current = useRef<ManusSettings>(initial);
  const mounted = useRef(true);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const commit = useCallback((next: ManusSettings) => { current.current = next; if (mounted.current) setManus(next); }, []);
  const enqueue = useCallback(<T,>(fn: () => Promise<T>) => {
    const result = queue.current.then(fn, fn);
    queue.current = result.catch(() => undefined);
    return result;
  }, []);
  const persist = useCallback(async (profile: ManusProfile, binding: string) => {
    await AsyncStorage.setItem(STORE, JSON.stringify({ profile, binding }));
  }, []);

  useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    void enqueue(async () => {
      try {
        const [raw, hasKey] = await Promise.all([AsyncStorage.getItem(STORE), hasProviderCredential("manus")]);
        let profile: ManusProfile = "standard", binding = freshBinding();
        if (raw) {
          const parsed = JSON.parse(raw);
          if (!parsed || typeof parsed !== "object") throw new Error("INVALID_CLOUD_SETTINGS");
          if (PROFILES.includes(parsed.profile)) profile = parsed.profile;
          if (typeof parsed.binding === "string" && /^[a-z0-9-]{1,128}$/i.test(parsed.binding)) binding = parsed.binding;
        }
        // Persist even on the first load; otherwise a restart loses the task/account namespace.
        await persist(profile, binding);
        if (!cancelled) commit({ loaded: true, hasApiKey: !!hasKey, profile, binding });
      } catch { if (!cancelled) commit(initial); }
    });
    return () => { cancelled = true; mounted.current = false; };
  }, [commit, enqueue, persist]);

  const saveManusKey = useCallback((key: string) => enqueue(async () => {
    const before = current.current;
    if (!before.loaded || key.length > 8192) return false;
    const binding = freshBinding();
    try {
      // Commit a new non-secret namespace BEFORE rotating credentials. Previous account
      // task IDs can never be followed with a newly saved key, including after restart.
      await persist(before.profile, binding);
      commit({ ...before, binding, loaded: false, hasApiKey: false });
      if (!await saveProviderCredential("manus", key.trim())) {
        commit({ ...before, binding, hasApiKey: false });
        return false;
      }
      const hasKey = await hasProviderCredential("manus");
      commit({ ...before, binding, loaded: true, hasApiKey: hasKey });
      return key.trim() ? hasKey : !hasKey;
    } catch {
      commit({ ...before, binding, hasApiKey: false });
      return false;
    }
  }), [commit, enqueue, persist]);

  const setManusProfile = useCallback((profile: ManusProfile) => enqueue(async () => {
    const before = current.current;
    if (!before.loaded || !PROFILES.includes(profile)) return false;
    try { await persist(profile, before.binding); commit({ ...before, profile }); return true; }
    catch { return false; }
  }), [commit, enqueue, persist]);
  const removeManusKey = useCallback(() => saveManusKey(""), [saveManusKey]);
  return { manus, saveManusKey, setManusProfile, removeManusKey };
}
