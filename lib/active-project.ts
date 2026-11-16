import AsyncStorage from "@react-native-async-storage/async-storage";
import { generateProjectStructure, type ProjectConfig, type ProjectTemplateId } from "./project-generator";
import { getPreferredProjectRoot } from "./termux-guard";
import { mirrorDurableRecord, readDurableRecord, removeDurableRecord } from "./durable-persistence";
import { AI_BUILDER_SHARED_ROOT, isWithinSharedAppRoot } from "./writable-path-policy";

function utf8ToBase64(str: string): string {
  const utf8 = unescape(encodeURIComponent(str));
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let output = "";
  for (let i = 0; i < utf8.length; i += 3) {
    const c1 = utf8.charCodeAt(i);
    const c2 = i + 1 < utf8.length ? utf8.charCodeAt(i + 1) : NaN;
    const c3 = i + 2 < utf8.length ? utf8.charCodeAt(i + 2) : NaN;
    const e1 = c1 >> 2;
    const e2 = ((c1 & 3) << 4) | (isNaN(c2) ? 0 : c2 >> 4);
    const e3 = isNaN(c2) ? 64 : ((c2 & 15) << 2) | (isNaN(c3) ? 0 : c3 >> 4);
    const e4 = isNaN(c3) ? 64 : c3 & 63;
    output += chars.charAt(e1) + chars.charAt(e2) + (e3 === 64 ? "=" : chars.charAt(e3)) + (e4 === 64 ? "=" : chars.charAt(e4));
  }
  return output;
}

export type { ProjectTemplateId };

export interface ActiveProject {
  id: string;
  name: string;
  packageName: string;
  path: string;
  createdAt: number;
  updatedAt: number;
  useCompose?: boolean;
  /** empty | compose | bottomnav */
  template?: ProjectTemplateId;
  minSdk?: number;
  targetSdk?: number;
  gitInit?: boolean;
}

export interface CreateProjectOptions {
  name: string;
  packageName?: string;
  useCompose?: boolean;
  template?: ProjectTemplateId;
  minSdk?: number;
  targetSdk?: number;
  gitInit?: boolean;
}

const STORAGE_KEY = "aibuilder.activeProject.v1";
const LIST_KEY = "aibuilder.projectList.v1";

function shellQuote(value: string): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

const SHARED_PROJECTS_ROOT = `${AI_BUILDER_SHARED_ROOT}/projects`;

function isValidProjectPath(value: unknown): value is string {
  if (typeof value !== "string" || !isWithinSharedAppRoot(value)) return false;
  const normalized = `/${value.split("/").filter(Boolean).filter((part) => part !== ".").join("/")}`;
  return normalized.startsWith(`${SHARED_PROJECTS_ROOT}/`);
}

function assertProjectPath(value: string): void {
  if (!isValidProjectPath(value)) throw new Error("PROJECT_PATH_OUTSIDE_SHARED_PROJECTS_ROOT");
}

function isActiveProject(value: unknown): value is ActiveProject {
  if (!value || typeof value !== "object") return false;
  const project = value as Partial<ActiveProject>;
  return typeof project.id === "string" && typeof project.name === "string" && isValidProjectPath(project.path);
}

export async function loadActiveProject(): Promise<ActiveProject | null> {
  try {
    let raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) {
      raw = await readDurableRecord(STORAGE_KEY);
      if (raw) await AsyncStorage.setItem(STORAGE_KEY, raw);
    } else {
      void mirrorDurableRecord(STORAGE_KEY, raw).catch(() => undefined);
    }
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isActiveProject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function saveActiveProject(project: ActiveProject | null): Promise<void> {
  if (!project) {
    await AsyncStorage.removeItem(STORAGE_KEY);
    try { await removeDurableRecord(STORAGE_KEY); } catch { /* AsyncStorage remains the primary source */ }
    return;
  }
  assertProjectPath(project.path);
  const value = JSON.stringify(project);
  await AsyncStorage.setItem(STORAGE_KEY, value);
  try { await mirrorDurableRecord(STORAGE_KEY, value); } catch { /* durable mirror is best-effort */ }
}

export async function listProjects(): Promise<ActiveProject[]> {
  try {
    let raw = await AsyncStorage.getItem(LIST_KEY);
    if (!raw) {
      raw = await readDurableRecord(LIST_KEY);
      if (raw) await AsyncStorage.setItem(LIST_KEY, raw);
    } else {
      void mirrorDurableRecord(LIST_KEY, raw).catch(() => undefined);
    }
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isActiveProject) : [];
  } catch {
    return [];
  }
}

export async function upsertProjectList(project: ActiveProject): Promise<void> {
  assertProjectPath(project.path);
  const list = await listProjects();
  const next = [project, ...list.filter((p) => p.id !== project.id)].slice(0, 30);
  const value = JSON.stringify(next);
  await AsyncStorage.setItem(LIST_KEY, value);
  try { await mirrorDurableRecord(LIST_KEY, value); } catch { /* durable mirror is best-effort */ }
}

export async function removeProjectFromList(id: string): Promise<void> {
  const list = await listProjects();
  const value = JSON.stringify(list.filter((p) => p.id !== id));
  await AsyncStorage.setItem(LIST_KEY, value);
  try { await mirrorDurableRecord(LIST_KEY, value); } catch { /* durable mirror is best-effort */ }
}

export function createProjectMeta(opts: CreateProjectOptions | string, packageName?: string, useCompose = false): ActiveProject {
  const o: CreateProjectOptions =
    typeof opts === "string"
      ? { name: opts, packageName, useCompose }
      : opts;
  const now = Date.now();
  const nonce = Math.random().toString(36).slice(2, 8);
  const safe = (o.name || "App").replace(/[^a-zA-Z0-9_-]/g, "_") || "App";
  const path = `${getPreferredProjectRoot()}/${safe}-${now.toString(36)}-${nonce}`;
  const template: ProjectTemplateId = o.template || (o.useCompose ? "compose" : "empty");
  const compose = template === "compose" || template === "bottomnav" ? true : !!o.useCompose;
  return {
    id: `proj_${now.toString(36)}`,
    name: safe,
    packageName: o.packageName || `com.aibuilder.${safe.toLowerCase()}`,
    path,
    createdAt: now,
    updatedAt: now,
    useCompose: compose,
    template,
    minSdk: o.minSdk ?? 24,
    targetSdk: o.targetSdk ?? 34,
    gitInit: !!o.gitInit,
  };
}

/** Файлы каркаса + shell-скрипт записи в Termux (вызывается агентом). */
export function buildScaffoldCommands(project: ActiveProject): string[] {
  assertProjectPath(project.path);
  const config: ProjectConfig = {
    name: project.name,
    packageName: project.packageName,
    useCompose: !!project.useCompose,
    projectPath: project.path,
    template: project.template || (project.useCompose ? "compose" : "empty"),
    minSdk: project.minSdk ?? 24,
    targetSdk: project.targetSdk ?? 34,
    gitInit: !!project.gitInit,
  };
  const files = generateProjectStructure(config);
  const cmds: string[] = [`if [ -e ${shellQuote(project.path)} ]; then echo PROJECT_PATH_EXISTS >&2; exit 73; else mkdir -p ${shellQuote(project.path)}; fi`];
  for (const [rel, content] of Object.entries(files)) {
    const full = `${project.path}/${rel}`;
    const dir = full.replace(/\/[^/]+$/, "");
    const b64 = utf8ToBase64(content);
    cmds.push(`mkdir -p ${shellQuote(dir)}`);
    cmds.push(`echo '${b64}' | base64 -d > ${shellQuote(full)}`);
  }
  if (project.gitInit) {
    cmds.push(`cd ${shellQuote(project.path)} && git init 2>/dev/null || true`);
  }
  cmds.push(`printf '%s\\n' ${shellQuote(`Scaffold written to ${project.path}`)}`);
  return cmds;
}

export function buildGradleAssembleCommands(projectPath: string): string[] {
  assertProjectPath(projectPath);
  return [
    `cd ${shellQuote(projectPath)} && (test -f gradlew && chmod +x gradlew; true)`,
    `cd ${shellQuote(projectPath)} && SDK=\"\"; for d in \"$ANDROID_HOME\" \"$ANDROID_SDK_ROOT\" \"$PREFIX/opt/android-sdk\" \"$PREFIX/share/android-sdk\" \"$HOME/Android/Sdk\" \"$HOME/android-sdk\" \"/opt/android-sdk\" \"/usr/local/android-sdk\"; do [ -n \"$d\" ] && [ -f \"$d/platforms/android-34/android.jar\" ] && SDK=\"$d\" && break; done; [ -n \"$SDK\" ] || { echo ANDROID_SDK_NOT_FOUND >&2; exit 20; }; export ANDROID_HOME=\"$SDK\" ANDROID_SDK_ROOT=\"$SDK\"; bash gradlew assembleDebug --stacktrace --no-daemon`,
  ];
}

export function exportZipCommand(projectPath: string): string {
  assertProjectPath(projectPath);
  const parent = projectPath.replace(/\/[^/]+$/, "");
  const base = projectPath.split("/").pop() || "project";
  const archive = `${base}-export-${Date.now().toString(36)}.tar.gz`;
  return `cd ${shellQuote(parent)} && tar -czvf ${shellQuote(archive)} ${shellQuote(base)} && ls -la ${shellQuote(archive)}`;
}
