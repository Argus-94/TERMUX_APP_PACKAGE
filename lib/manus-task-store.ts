import AsyncStorage from "@react-native-async-storage/async-storage";
import type { ManusTaskState } from "./manus-api";

/** Non-secret task metadata only. Credential binding prevents cross-account follow-ups. */
export function manusTaskStorageKey(binding: string, chatId: string, createdAt: number, epoch = "initial"): string {
  if (!binding || !chatId) throw new Error("CLOUD_TASK_BINDING_REQUIRED");
  return `aibuilder.manus.task.v1.${[binding, chatId, String(createdAt), epoch].map(encodeURIComponent).join(".")}`;
}

export async function loadManusTask(key: string): Promise<ManusTaskState | undefined> {
  // Fail closed on storage errors: do not create another remote task after a failed read.
  const raw = await AsyncStorage.getItem(key);
  if (!raw) return undefined;
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || typeof (parsed as ManusTaskState).taskId !== "string") {
    throw new Error("CLOUD_TASK_STATE_INVALID");
  }
  return parsed as ManusTaskState;
}

export async function saveManusTask(key: string, state: ManusTaskState): Promise<void> {
  // Await this write before sending/continuing a task. Never use fire-and-forget persistence here.
  await AsyncStorage.setItem(key, JSON.stringify(state));
}
