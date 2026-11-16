import AsyncStorage from "@react-native-async-storage/async-storage";

const KEY = "aibuilder.termux.cmdHistory.v1";
const MAX = 20;

export interface HistoryEntry {
  command: string;
  exitCode: number;
  at: number;
}

export async function loadTermuxHistory(): Promise<HistoryEntry[]> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.slice(0, MAX) : [];
  } catch {
    return [];
  }
}

export async function pushTermuxHistory(command: string, exitCode: number): Promise<void> {
  const prev = await loadTermuxHistory();
  const next = [
    { command, exitCode, at: Date.now() },
    ...prev.filter((e) => e.command !== command),
  ].slice(0, MAX);
  await AsyncStorage.setItem(KEY, JSON.stringify(next));
}
