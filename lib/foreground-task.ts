import { persistentLogger } from "./persistent-logger";
/**
 * Logical tracker for long-running work. This tracker updates the in-app UI and
 * the single status notification. It is deliberately not described as an Android
 * foreground service: notification updates alone do not grant process immunity.
 */
export type ForegroundTaskKind =
  | "build" | "inference" | "rootfs" | "backup" | "restore"
  | "download" | "agent" | "first-run" | "bootstrap" | "other";
export type ForegroundTask = Readonly<{
  id: string; kind: ForegroundTaskKind; title: string; progress?: number;
  startedAt: number; meta?: Readonly<Record<string, string>>;
}>;
type Listener = (tasks: readonly ForegroundTask[]) => void;
const tasks = new Map<string, ForegroundTask>();
const listeners = new Set<Listener>();
function emit(): void {
  const snap = [...tasks.values()];
  for (const l of listeners) { try { l(snap); } catch { /* listener isolation */ } }
}
function kindLabel(kind: ForegroundTaskKind): string {
  const labels: Record<ForegroundTaskKind, string> = {
    build: "Сборка APK", inference: "Генерация ответа", rootfs: "Подготовка Linux",
    backup: "Создание резервной копии", restore: "Восстановление данных",
    download: "Загрузка файлов", agent: "AI-агент", "first-run": "Первичная настройка",
    bootstrap: "Подготовка окружения", other: "Длительная задача",
  };
  return labels[kind];
}
async function notifyFg(title: string, body: string): Promise<void> {
  try {
    const n = await import("./app-notifications");
    if (typeof n.notifyLongTask === "function") await n.notifyLongTask(title, body);
  } catch (e) { persistentLogger.add("warn", "Foreground", `notification update failed: ${String(e)}`); }
}
function notificationBody(t: ForegroundTask): string {
  const pct = t.progress === undefined ? null : Math.round(t.progress * 100);
  const elapsed = Math.max(0, Math.floor((Date.now() - t.startedAt) / 60000));
  const duration = elapsed < 1 ? "меньше минуты" : `${elapsed} мин.`;
  // No invented percentage: progress is shown only when the task reported one.
  return `${pct === null ? "Выполняется" : `Прогресс ${pct}%`} · ${duration}`;
}
export function startForegroundTask(kind: ForegroundTaskKind, title: string, meta?: Record<string, string>): string {
  if (tasks.size >= 8) {
    const oldest = [...tasks.values()].sort((a,b) => a.startedAt-b.startedAt)[0];
    if (oldest) { tasks.delete(oldest.id); persistentLogger.add("warn", "Foreground", `evicted stale task ${oldest.id} (${oldest.kind})`); }
  }
  const id = `fg-${Date.now()}-${Math.random().toString(36).slice(2,7)}`;
  const safeTitle = String(title || kindLabel(kind)).replace(/\s+/g," ").trim().slice(0,120) || kindLabel(kind);
  const task: ForegroundTask = { id, kind, title: safeTitle, startedAt: Date.now(), meta, progress: 0 };
  tasks.set(id, task); emit();
  void notifyFg(`AI Builder · ${kindLabel(kind)}`, `${safeTitle} · ${notificationBody(task)}`);
  persistentLogger.add("info", "Foreground", `start [${kind}] ${safeTitle}`);
  return id;
}
export function updateForegroundTask(id: string, patch: { title?: string; progress?: number }): void {
  const t = tasks.get(id); if (!t) return;
  const next: ForegroundTask = { ...t, title: patch.title ?? t.title,
    progress: patch.progress !== undefined ? Math.min(1,Math.max(0,Number.isFinite(patch.progress)?patch.progress:0)) : t.progress };
  tasks.set(id,next); emit();
  void notifyFg(`AI Builder · ${kindLabel(next.kind)}`, `${next.title} · ${notificationBody(next)}`);
}
export function endForegroundTask(id: string): void {
  const t = tasks.get(id);
  if (t) persistentLogger.add("info", "Foreground", `end [${t.kind}] ${t.title}`);
  tasks.delete(id); emit();
  if (tasks.size === 0) void (async () => {
    try { const n = await import("./app-notifications"); if (typeof n.clearTaskSticky === "function") await n.clearTaskSticky(); }
    catch (e) { persistentLogger.add("warn", "Foreground", `clear notification failed: ${String(e)}`); }
  })();
}
export function listForegroundTasks(): ForegroundTask[] { return [...tasks.values()]; }
export function subscribeForegroundTasks(listener: Listener): () => void { listeners.add(listener); return () => listeners.delete(listener); }
export async function withForegroundTask<T>(kind: ForegroundTaskKind, title: string, body: (update: (progress: number, title?: string) => void) => Promise<T>): Promise<T> {
  const id = startForegroundTask(kind,title);
  try { return await body((progress,newTitle) => updateForegroundTask(id,{progress,title:newTitle})); }
  catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    persistentLogger.add("error", "Foreground", `[${kind}] ${title} failed: ${reason.slice(0,240)}`);
    throw e;
  } finally { endForegroundTask(id); }
}
