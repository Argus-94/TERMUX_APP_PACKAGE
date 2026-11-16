import AsyncStorage from "@react-native-async-storage/async-storage";
import { classifyRecoveryFailure } from "./agent-recovery";

export const BUILD_RECOVERY_MEMORY_KEY = "aibuilder.build-recovery-recipes.v1";
const MEMORY_VERSION = 1;
const MAX_RECORDS = 48;
const SAFE_RECIPE_IDS = new Set([
  "java-install", "android-tools", "nodejs", "unzip", "git", "wget-curl",
  "local-properties", "gradle-wrapper", "gradle-cache", "build-lock", "disk-cache",
  "ndk-path", "aapt2-sdk", "expo-deps", "expo-cli", "signing-tools", "maven-deps", "flutter-pub",
]);

type MemoryRecord = Readonly<{
  version: 1;
  key: string;
  backend: string;
  recipeId: string;
  appliedAt: number;
}>;

type Storage = Pick<typeof AsyncStorage, "getItem" | "setItem">;

function hash(value: string): string {
  let result = 2166136261;
  for (let i = 0; i < value.length; i++) result = Math.imul(result ^ value.charCodeAt(i), 16777619);
  return (result >>> 0).toString(16).padStart(8, "0");
}

/** Stable privacy-preserving key; raw diagnostics and paths are never persisted. */
export function buildRecoveryMemoryKey(failureLog: string, backend: string): string {
  const state = classifyRecoveryFailure(failureLog);
  return `br-${hash(`${backend}|${state.fingerprint}`)}`;
}

function validateRecords(value: unknown): MemoryRecord[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is MemoryRecord => {
    if (!item || typeof item !== "object") return false;
    const row = item as Partial<MemoryRecord>;
    return row.version === MEMORY_VERSION && typeof row.key === "string" && /^br-[a-f0-9]{8}$/.test(row.key) &&
      typeof row.backend === "string" && row.backend.length > 0 && row.backend.length <= 40 &&
      typeof row.recipeId === "string" && SAFE_RECIPE_IDS.has(row.recipeId) &&
      typeof row.appliedAt === "number" && Number.isFinite(row.appliedAt);
  });
}

async function readRecords(storage: Storage): Promise<MemoryRecord[]> {
  try {
    const raw = await storage.getItem(BUILD_RECOVERY_MEMORY_KEY);
    return raw ? validateRecords(JSON.parse(raw)) : [];
  } catch {
    return [];
  }
}

/** Store only after the corresponding repair recipe was followed by verified artifact success. */
export async function rememberVerifiedBuildRepair(
  failureLog: string,
  backend: string,
  recipeId: string,
  storage: Storage = AsyncStorage,
): Promise<boolean> {
  if (!SAFE_RECIPE_IDS.has(recipeId) || !backend || backend.length > 40) return false;
  try {
    const key = buildRecoveryMemoryKey(failureLog, backend);
    const records = await readRecords(storage);
    const next: MemoryRecord[] = [
      { version: MEMORY_VERSION as 1, key, backend, recipeId, appliedAt: Date.now() },
      ...records.filter((row) => !(row.key === key && row.backend === backend)),
    ].slice(0, MAX_RECORDS);
    await storage.setItem(BUILD_RECOVERY_MEMORY_KEY, JSON.stringify(next));
    return true;
  } catch {
    return false;
  }
}

/** A hit returns a validated recipe ID only; callers still use the normal allowlisted runner. */
export async function findVerifiedBuildRepair(
  failureLog: string,
  backend: string,
  storage: Storage = AsyncStorage,
): Promise<string | null> {
  if (!backend || backend.length > 40) return null;
  const key = buildRecoveryMemoryKey(failureLog, backend);
  const records = await readRecords(storage);
  return records.find((row) => row.key === key && row.backend === backend)?.recipeId || null;
}
