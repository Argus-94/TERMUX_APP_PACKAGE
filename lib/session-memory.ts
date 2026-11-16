/**
 * Cross-session memory (v126).
 *
 * lib/session-digest.ts сжимает ОДИН длинный чат в дайджест ради экономии
 * токенов. Этот модуль — надстройка: сохраняет последний дайджест каждого
 * проекта (по activeProject.path) в AsyncStorage, чтобы при следующем
 * запуске/новом чате по тому же проекту агент видел краткую память о
 * прошлых сессиях, а не начинал с нуля. Ничего не удаляет и не меняет в
 * session-digest.ts — только читает его результат и хранит.
 */

import AsyncStorage from "@react-native-async-storage/async-storage";
import type { AgentTranscriptTurn } from "./termux-agent";
import { mirrorDurableRecord, readDurableRecord, removeDurableRecord } from "./durable-persistence";
import { sanitizeMemoryText, sanitizeProjectMemoryMap } from "./session-memory-safety";

const STORAGE_KEY = "aibuilder.session-memory.v1";
const MAX_DIGEST_CHARS = 1500;
const MAX_PROJECTS = 30;

export interface MemoryItem { id: string; kind: "fact"|"decision"|"lesson"|"digest"; text: string; updatedAt: number; }
export interface StoredMemory { digest: string; updatedAt: number; items?: MemoryItem[]; }

function normalizeKey(projectPath: string): string {
  let k = (projectPath || "").trim().replace(/\/+$/, "");
  if (!k || k.includes("\0") || k.includes("..")) return "default";
  // Cap key length to avoid AsyncStorage bloat from huge paths
  if (k.length > 240) k = k.slice(0, 240);
  return k || "default";
}

async function loadAll(): Promise<Record<string, StoredMemory>> {
  try {
    let raw = await AsyncStorage.getItem(STORAGE_KEY);
    const primaryHadValue = raw !== null;
    if (!raw) {
      raw = await readDurableRecord(STORAGE_KEY);
    }
    if (!raw) return {};
    const safe = sanitizeProjectMemoryMap(JSON.parse(raw)) as Record<string, StoredMemory>;
    const serialized = JSON.stringify(safe);
    if (!primaryHadValue || serialized !== raw) await AsyncStorage.setItem(STORAGE_KEY, serialized);
    void mirrorDurableRecord(STORAGE_KEY, serialized).catch(() => undefined);
    return safe;
  } catch {
    return {};
  }
}

async function saveAll(map: Record<string, StoredMemory>): Promise<void> {
  const safe = sanitizeProjectMemoryMap(map) as Record<string, StoredMemory>;
  const entries = Object.entries(safe)
    .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
    .slice(0, MAX_PROJECTS);
  try {
    const value = JSON.stringify(Object.fromEntries(entries));
    await AsyncStorage.setItem(STORAGE_KEY, value);
    try { await mirrorDurableRecord(STORAGE_KEY, value); } catch { /* durable mirror is best-effort */ }
  } catch {
    // тихо игнорируем — память не критична для работы приложения
  }
}

/** Сохранить/обновить дайджест последней сессии для проекта. */
export async function saveCrossSessionMemory(projectPath: string, digest: string): Promise<void> {
  if (!digest || !digest.trim()) return;
  const key = normalizeKey(projectPath);
  const all = await loadAll();
  const now = Date.now();
  const previous = all[key]?.items || [];
  const item: MemoryItem = { id: `${now}-${Math.random().toString(36).slice(2,8)}`, kind: "digest", text: digest.slice(0, MAX_DIGEST_CHARS), updatedAt: now };
  all[key] = { digest: digest.slice(0, MAX_DIGEST_CHARS), updatedAt: now, items: [...previous, item].slice(-40) };
  await saveAll(all);
}

/** Прочитать память проекта в готовом для истории чата виде (пусто, если ничего нет). */
export async function loadCrossSessionMemory(projectPath: string): Promise<string> {
  const key = normalizeKey(projectPath);
  const all = await loadAll();
  const entry = all[key];
  if (!entry || !entry.digest) return "";
  return `[CROSS_SESSION_MEMORY project=${key}]\n${entry.digest}`;
}

/** Список памяти по всем проектам — для отладочного экрана, если понадобится. */
export async function listCrossSessionMemory(): Promise<
  Array<{ project: string; digest: string; updatedAt: number }>
> {
  const all = await loadAll();
  return Object.entries(all)
    .map(([project, v]) => ({ project, digest: v.digest, updatedAt: v.updatedAt }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function clearCrossSessionMemory(): Promise<void> {
  try {
    await AsyncStorage.removeItem(STORAGE_KEY);
    try { await removeDurableRecord(STORAGE_KEY); } catch { /* best-effort mirror cleanup */ }
  } catch {
    // ignore
  }
}

export async function retainProjectMemory(projectPath: string, kind: "fact"|"decision"|"lesson", text: string): Promise<void> {
  const clean=sanitizeMemoryText(text,2000); if (!clean) return; const key=normalizeKey(projectPath); const all=await loadAll(); const now=Date.now(); const entry=all[key]||{digest:"",updatedAt:now,items:[]};
  const normalized=clean.toLowerCase().replace(/\s+/g," ");
  const existing=entry.items||[];
  const duplicate=existing.find(x=>x.kind===kind && x.text.toLowerCase().replace(/\s+/g," ")===normalized);
  if(duplicate){ duplicate.updatedAt=now; }
  else entry.items=[...existing,{id:`${now}-${Math.random().toString(36).slice(2,8)}`,kind,text:clean,updatedAt:now}].slice(-40);
  entry.updatedAt=now; all[key]=entry; await saveAll(all);
}
export async function recallProjectMemory(projectPath: string, query?: string): Promise<MemoryItem[]> {
  const key=normalizeKey(projectPath); const all=await loadAll(); const items=all[key]?.items||[]; if(!query?.trim()) return items.slice(-12); const q=query.toLowerCase().split(/\s+/).filter(Boolean); return items.map(x=>({x,score:q.reduce((n,w)=>n+(x.text.toLowerCase().includes(w)?1:0),0)})).filter(x=>x.score>0).sort((a,b)=>b.score-a.score||b.x.updatedAt-a.x.updatedAt).slice(0,12).map(x=>x.x);
}

export interface MemorySession { id: string; project: string; task: string; startedAt: number; }

/** Start a bounded cross-session lifecycle record. The task itself is retained as a fact so
 * later agent runs can recall what this project was being worked on without storing chat noise. */
export async function beginProjectMemorySession(projectPath: string, task: string): Promise<MemorySession> {
  const session: MemorySession = { id: `${Date.now()}-${Math.random().toString(36).slice(2,8)}`, project: normalizeKey(projectPath), task: task.trim().slice(0,1200), startedAt: Date.now() };
  if (session.task) await retainProjectMemory(projectPath, "fact", `Active task started: ${session.task}`);
  return session;
}

/** Close the lifecycle with a compact durable lesson/outcome. Raw transcripts are never persisted here. */
export async function completeProjectMemorySession(projectPath: string, session: MemorySession | null | undefined, outcome: string): Promise<void> {
  if (!session) return;
  const clean = (outcome || "").trim().slice(0,1600);
  if (!clean) return;
  await retainProjectMemory(projectPath, "lesson", `Session outcome (${session.id}): ${clean}`);
  await consolidateProjectMemory(projectPath);
}

export async function getProjectMemorySnapshot(projectPath: string, limit = 20): Promise<MemoryItem[]> {
  const key = normalizeKey(projectPath);
  const all = await loadAll();
  return (all[key]?.items || []).sort((a,b)=>b.updatedAt-a.updatedAt).slice(0, Math.max(1, Math.min(50, limit)));
}

export async function consolidateProjectMemory(projectPath: string): Promise<void> {
  const key = normalizeKey(projectPath);
  const all = await loadAll();
  const entry = all[key];
  if (!entry) return;
  const items = (entry.items || []).sort((a,b)=>b.updatedAt-a.updatedAt).slice(0, 40);
  const durable = items.filter(x => x.kind !== "digest").slice(0, 16);
  entry.digest = durable.map(x => `[${x.kind}] ${x.text}`).join("\n").slice(0, MAX_DIGEST_CHARS);
  entry.items = items;
  entry.updatedAt = Date.now();
  all[key] = entry;
  await saveAll(all);
}

export async function reflectProjectMemory(projectPath:string, query:string):Promise<string>{ const items=await recallProjectMemory(projectPath,query); return items.length?items.map(x=>`[${x.kind}] ${x.text}`).join("\n"):""; }

/** Model-assisted consolidation of recalled memory. The model is advisory; raw memory remains intact. */
export async function reflectProjectMemoryWithModel(projectPath:string, query:string, model:{askModel(history:AgentTranscriptTurn[]):Promise<string>}):Promise<string>{
  const items=await recallProjectMemory(projectPath,query);
  if(!items.length) return "";
  try{
    const answer=await model.askModel([{role:"user",content:`[MEMORY REFLECT] Synthesize durable, project-specific guidance from these recalled memories. Do not invent facts. Return 3-8 concise bullets: decisions, lessons, constraints, and what to verify against current repo state.\nQUERY: ${query}\nMEMORIES:\n${items.map(x=>`[${x.kind}] ${x.text}`).join("\n")}`}]);
    return answer.trim().slice(0,3500);
  }catch{return "";}
}
