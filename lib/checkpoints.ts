/**
 * Локальные checkpoint'ы сессии чата.
 * Хранят снимок сообщений; откат восстанавливает состояние чата.
 * Максимум MAX_CHECKPOINTS на сессию (LRU).
 *
 * v4: умные заголовки/превью — не все «После ответа ИИ».
 */

import AsyncStorage from "@react-native-async-storage/async-storage";
import { persistentLogger } from "./persistent-logger";

export interface CheckpointMessage {
  id: string;
  role: string;
  content: string;
  timestamp: number;
}

export interface CheckpointStats {
  total: number;
  user: number;
  assistant: number;
  system: number;
}

export interface Checkpoint {
  id: string;
  sessionId: string;
  /** Короткий заголовок (для списка). Старые записи могут содержать только reason. */
  reason: string;
  /** Опциональный умный заголовок (новый формат). */
  title?: string;
  /** Превью последнего запроса пользователя. */
  preview?: string;
  /** Счётчики ролей. */
  stats?: CheckpointStats;
  createdAt: number;
  messages: CheckpointMessage[];
}

const STORAGE_KEY = "aibuilder.checkpoints.v3";
const MAX_CHECKPOINTS = 50;

/** Обрезает текст до maxLen, убирает лишние пробелы/переносы. */
export function snippet(text: string, maxLen = 72): string {
  const one = (text || "")
    .replace(/\s+/g, " ")
    .replace(/```[\s\S]*?```/g, "[код]")
    .trim();
  if (!one) return "";
  if (one.length <= maxLen) return one;
  return one.slice(0, maxLen - 1).trimEnd() + "…";
}

export function computeStats(messages: CheckpointMessage[]): CheckpointStats {
  let user = 0;
  let assistant = 0;
  let system = 0;
  for (const m of messages) {
    const r = (m.role || "").toLowerCase();
    if (r === "user") user++;
    else if (r === "assistant") assistant++;
    else system++;
  }
  return { total: messages.length, user, assistant, system };
}

/**
 * Строит человекочитаемый заголовок и превью из сообщений.
 * Использует последний user-запрос; если его нет — fallback на reason.
 */
export function buildCheckpointMeta(
  messages: CheckpointMessage[],
  fallbackReason?: string
): { title: string; preview: string; stats: CheckpointStats } {
  const stats = computeStats(messages);
  const users = messages.filter((m) => (m.role || "").toLowerCase() === "user");
  const lastUser = users.length > 0 ? users[users.length - 1] : null;
  const firstUser = users.length > 0 ? users[0] : null;

  const lastSnippet = lastUser ? snippet(lastUser.content, 80) : "";
  const firstSnippet = firstUser ? snippet(firstUser.content, 48) : "";

  let title: string;
  if (lastSnippet) {
    // «Запрос: сделай экран настроек…»
    title = lastSnippet;
  } else if (fallbackReason && fallbackReason.trim()) {
    title = fallbackReason.trim();
  } else {
    title = `Снимок · ${stats.total} сообщ.`;
  }

  // Превью: если title уже = last user, покажем первый запрос или счётчики
  let preview = "";
  if (lastSnippet && firstSnippet && firstSnippet !== lastSnippet && users.length > 1) {
    preview = `Начало: ${firstSnippet}`;
  } else if (lastSnippet) {
    preview = `${stats.user} запрос · ${stats.assistant} ответ`;
  } else {
    preview = `${stats.total} сообщ.`;
  }

  return { title, preview, stats };
}

/** Для UI: всегда даёт title/preview/stats, даже для старых checkpoint без полей. */
export function resolveCheckpointDisplay(cp: Checkpoint): {
  title: string;
  preview: string;
  stats: CheckpointStats;
} {
  if (cp.title && cp.preview && cp.stats) {
    return { title: cp.title, preview: cp.preview, stats: cp.stats };
  }
  const meta = buildCheckpointMeta(cp.messages || [], cp.reason);
  // Старые записи с reason «После ответа ИИ» — подменяем title на сниппет из messages
  const generic =
    !cp.reason ||
    /после ответа/i.test(cp.reason) ||
    /after (ai|the)?\s*reply/i.test(cp.reason) ||
    /після відповіді/i.test(cp.reason);
  return {
    title: generic && meta.title ? meta.title : cp.title || cp.reason || meta.title,
    preview: cp.preview || meta.preview,
    stats: cp.stats || meta.stats,
  };
}

async function loadAll(): Promise<Checkpoint[]> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function saveAll(list: Checkpoint[]): Promise<void> {
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(list.slice(-MAX_CHECKPOINTS)));
}

export async function createCheckpoint(
  sessionId: string,
  reason: string,
  messages: CheckpointMessage[]
): Promise<Checkpoint> {
  const meta = buildCheckpointMeta(messages, reason);
  const cp: Checkpoint = {
    id: `cp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    sessionId,
    reason: reason || meta.title,
    title: meta.title,
    preview: meta.preview,
    stats: meta.stats,
    createdAt: Date.now(),
    messages: messages.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      timestamp: m.timestamp,
    })),
  };
  const all = await loadAll();
  all.push(cp);
  await saveAll(all);
  persistentLogger.markAppEvent("CHECKPOINT_CREATED", {
    id: cp.id,
    sessionId,
    messages: cp.messages.length,
    title: cp.title,
  });
  return cp;
}

export async function listCheckpoints(sessionId: string): Promise<Checkpoint[]> {
  const all = await loadAll();
  return all.filter((c) => c.sessionId === sessionId).sort((a, b) => b.createdAt - a.createdAt);
}

export async function getCheckpoint(id: string): Promise<Checkpoint | null> {
  const all = await loadAll();
  return all.find((c) => c.id === id) || null;
}

/** Удалить один checkpoint по его ID. Безопасно для уже удалённой записи. */
export async function deleteCheckpoint(id: string): Promise<void> {
  const all = await loadAll();
  const next = all.filter((c) => c.id !== id);
  if (next.length !== all.length) {
    await saveAll(next);
    persistentLogger.markAppEvent("CHECKPOINT_DELETED", { id });
  }
}

export async function deleteCheckpointsForSession(sessionId: string): Promise<void> {
  const all = await loadAll();
  const next = all.filter((c) => c.sessionId !== sessionId);
  const removed = all.length - next.length;
  await saveAll(next);
  if (removed > 0) {
    persistentLogger.markAppEvent("CHECKPOINTS_DELETED_ALL", { sessionId, count: removed });
  }
}
