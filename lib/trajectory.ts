/**
 * Session Replay / AI Blame (v126).
 *
 * Не меняет ничего в агенте/сборке — просто читает уже существующий
 * persistentLogger (lib/persistent-logger.ts) и группирует записи в
 * "прогоны" (по маркеру "Новая задача:" из lib/termux-agent.ts), а из
 * текста команд/выводов вытаскивает затронутые файлы. На этом строятся:
 *  - Реплей сессии: пошаговый плеер по прогону агента.
 *  - AI Blame: по имени файла — какие шаги его трогали и когда.
 *
 * Полностью производный слой поверх LogEntry — никаких новых источников
 * данных, ничего не пишет обратно в лог.
 */

import type { LogEntry, LogLevel } from "./persistent-logger";

export interface TrajectoryStep {
  id: string;
  timestamp: number;
  tag: string;
  level: LogLevel;
  summary: string;
  files: string[];
  raw: string;
}

export interface TrajectoryRun {
  key: string;
  title: string;
  startedAt: number;
  endedAt: number;
  steps: TrajectoryStep[];
}

export interface BlameHit {
  file: string;
  step: TrajectoryStep;
  runTitle: string;
  runKey: string;
}

/** Теги persistentLogger, которые относятся к работе агента/сборки (см. build-loop.ts, termux-agent.ts, termux-packs.ts). */
const RELEVANT_TAGS = new Set(["Termux", "Build", "Packs", "TermuxBridge"]);

/** Пути файлов из вывода shell-команд: sed/cat/tee/printf/cp/mv/git-diff заголовки и просто "путь.расширение". */
const FILE_PATH_RE =
  /(?:\.\/|\.\.\/|\/)?(?:[\w.-]+\/)*[\w-]+\.(?:kt|kts|java|xml|gradle|smali|ts|tsx|js|jsx|json|py|md|txt|yml|yaml|properties|pro|cfg|h|cpp|c)\b/gi;

export function extractTouchedFiles(text: string): string[] {
  if (!text) return [];
  const found = new Set<string>();
  const matches = text.match(FILE_PATH_RE) || [];
  for (const raw of matches) {
    const clean = raw.replace(/^\.\//, "");
    if (clean.length < 3 || clean.length > 260) continue;
    if (/^https?:/i.test(clean)) continue;
    if (/^node_modules\//.test(clean)) continue;
    // Ignore system/sensitive absolute roots outside project-like trees
    if (/^\/(etc|proc|sys|dev|system|vendor)\b/i.test(clean)) continue;
    if (clean.includes("..")) continue;
    found.add(clean);
    if (found.size >= 80) break;
  }
  return [...found];
}

function summarize(message: string): string {
  const firstLine = (message || "").split(/\r?\n/)[0] || "";
  return firstLine.length > 160 ? firstLine.slice(0, 160) + "…" : firstLine;
}

/** Превращает сырые записи лога в шаги траектории (только релевантные теги, по возрастанию времени). */
export function buildTrajectorySteps(entries: LogEntry[]): TrajectoryStep[] {
  return entries
    .filter((e) => RELEVANT_TAGS.has(e.tag))
    .map((e) => ({
      id: e.id,
      timestamp: e.timestamp,
      tag: e.tag,
      level: e.level,
      summary: summarize(e.message),
      files: extractTouchedFiles(e.message),
      raw: e.message,
    }))
    .sort((a, b) => a.timestamp - b.timestamp);
}

const RUN_BOUNDARY_RE = /^Новая задача:\s*(.+)$/;

/** Группирует шаги в прогоны по маркеру начала задачи агента (свежие — первыми). */
export function splitIntoRuns(steps: TrajectoryStep[]): TrajectoryRun[] {
  const runs: TrajectoryRun[] = [];
  let current: TrajectoryStep[] = [];
  let currentTitle = "";

  const flush = () => {
    if (!current.length) return;
    runs.push({
      key: `run_${current[0].id}`,
      title: currentTitle || current[0].summary || "Session",
      startedAt: current[0].timestamp,
      endedAt: current[current.length - 1].timestamp,
      steps: current,
    });
    current = [];
  };

  for (const step of steps) {
    const marker = step.tag === "Termux" ? step.summary.match(RUN_BOUNDARY_RE) : null;
    if (marker) {
      flush();
      currentTitle = marker[1].slice(0, 90);
    }
    current.push(step);
  }
  flush();

  return runs.reverse();
}

export interface TouchedFileInfo {
  file: string;
  count: number;
  lastTouched: number;
}

/** Все файлы, встреченные хоть в одном шаге — для подсказок в поиске AI Blame. */
export function listTouchedFiles(runs: TrajectoryRun[]): TouchedFileInfo[] {
  const map = new Map<string, TouchedFileInfo>();
  for (const run of runs) {
    for (const step of run.steps) {
      for (const f of step.files) {
        const cur = map.get(f) || { file: f, count: 0, lastTouched: 0 };
        cur.count += 1;
        cur.lastTouched = Math.max(cur.lastTouched, step.timestamp);
        map.set(f, cur);
      }
    }
  }
  return [...map.values()].sort((a, b) => b.lastTouched - a.lastTouched);
}

/** AI Blame: по подстроке имени файла — все шаги, где он упомянут, последние сверху. */
export function getBlameForFile(runs: TrajectoryRun[], query: string): BlameHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const hits: BlameHit[] = [];
  for (const run of runs) {
    for (const step of run.steps) {
      const match = step.files.find((f) => f.toLowerCase().includes(q));
      if (match) {
        hits.push({ file: match, step, runTitle: run.title, runKey: run.key });
      }
    }
  }
  return hits.sort((a, b) => b.step.timestamp - a.step.timestamp);
}
