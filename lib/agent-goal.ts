/**
 * Goal extraction + success criteria. DONE is forbidden until verify passes.
 */
import { resolveUserStorageBase, joinUserStorage, isUserSharedAbsolutePath, ANDROID_SHARED_ROOT } from "./user-storage-paths.ts";

export type AgentGoalKind =
  | "file_write"
  | "dir_mkdir"
  | "file_delete"
  | "file_rename"
  | "file_copy"
  | "dir_list"
  | "apk_build"
  | "github_remote"
  | "github_local"
  | "interceptor"
  | "generic";

export type AgentGoal = Readonly<{
  kind: AgentGoalKind;
  summary: string;
  /** Absolute paths that must exist after success. */
  mustExist: string[];
  /** Secondary path (rename target / copy destination). */
  mustExistTo?: string[];
  /** Substring that must appear in a target file (optional). */
  contentContains?: { path: string; text: string };
  /** Interceptor-specific. */
  interceptorAction?: "enable" | "disable" | "last" | "rule" | "other";
  /** GitHub owner/repo if parsed. */
  github?: { owner?: string; repo?: string };
  /** Forbidden operations for this goal (hints for policy). */
  forbidden: string[];
}>;

export function parseAgentGoal(userTask: string): AgentGoal {
  const t = String(userTask || "").trim();
  const lower = t.toLowerCase();

  // Interceptor / traffic
  if (/перехват\s*трафик|traffic\s*intercept|interceptor|mitm|прокси\s*перехват/i.test(t)) {
    let interceptorAction: AgentGoal["interceptorAction"] = "other";
    if (/включ|enable|старт|start/i.test(t)) interceptorAction = "enable";
    else if (/выключ|отключ|disable|stop/i.test(t)) interceptorAction = "disable";
    else if (/последн|last\s+request|покажи.*запрос/i.test(t)) interceptorAction = "last";
    else if (/правил|rule|блокир|block|mock/i.test(t)) interceptorAction = "rule";
    return {
      kind: "interceptor",
      summary: t.slice(0, 200),
      mustExist: [],
      interceptorAction,
      forbidden: ["proot-distro install", "rootfs reset"],
    };
  }

  // GitHub-related tasks (platform intent; language-agnostic URL forms preferred).
  // Name/visibility extraction is left to the model + github.* tools — no quote/keyword lock-in.
  if (
    /github\.com\/|raw\.githubusercontent\.com\/|api\.github\.com\//i.test(t) ||
    /\bgit\s*hub\b/i.test(t) ||
    /\bgh\s+repo\b/i.test(t)
  ) {
    const m = t.match(/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/i);
    const local = /materialize|clone|pack|zip|download|скач|звантаж/i.test(t);
    return {
      kind: local ? "github_local" : "github_remote",
      summary: t.slice(0, 200),
      mustExist: [],
      github: m ? { owner: m[1], repo: m[2].replace(/\.git$/i, "") } : undefined,
      forbidden: [
        "claim no GitHub API access",
        "ask user to use browser or gh CLI when github.* tools exist",
      ],
    };
  }

  // APK / AAB build from path or archive (Russian/Ukrainian/English verbs)
  // «Создай apk из …zip» must classify as apk_build — not generic chat and not GitHub.
  if (
    /(?:собери|собрать|збери|зроби|создай|создать|сгенерируй|build|compile|make|assemble).{0,60}(?:\b(?:apk|aab)\b|(?:^|[^А-Яа-яЁё])апк(?:$|[^А-Яа-яЁё]))/i.test(t) ||
    /assemble(?:Debug|Release)|bundleRelease|gradlew/i.test(t) ||
    /\.apk\b/i.test(t) ||
    (/(?:\b(?:apk|aab)\b|(?:^|[^А-Яа-яЁё])апк(?:$|[^А-Яа-яЁё]))/i.test(t) && /(?:\/storage\/|\/sdcard\/|\.zip\b)/i.test(t))
  ) {
    return {
      kind: "apk_build",
      summary: t.slice(0, 200),
      mustExist: [],
      forbidden: ["TERMUX_DONE without absolute .apk path"],
    };
  }


  // Create folder/directory in Download / shared storage
  const dirCreate =
    /(?:создай|создать|create|mkdir|make)\w*.{0,100}(?:папк\w*|folder|каталог|director(?:y|ies)|dir\b)/i.test(t) ||
    /(?:новую\s+)?папк\w*.{0,40}(?:с\s+именем|named|name)/i.test(t);
  if (dirCreate) {
    const nameMatch =
      t.match(/(?:именем|name|named|название)\s*[:=]?\s*[«"']?([A-Za-z0-9._\u0400-\u04FF-]+)[»"']?/i) ||
      t.match(/(?:папк[а-яё]*|folder|каталог)\s+[«"']?([A-Za-z0-9._\u0400-\u04FF-]+)[»"']?/i) ||
      t.match(/mkdir\s+(?:-p\s+)?[«"']?([A-Za-z0-9._\u0400-\u04FF/-]+)[»"']?/i);
    let folderName = nameMatch ? nameMatch[1].replace(/^\/+|\/+$/g, "") : "new_folder";
    folderName = folderName.split("/").filter(Boolean).pop() || folderName;
    const base =
      resolveUserStorageBase(t, { defaultTo: "download" }) ||
      `${ANDROID_SHARED_ROOT}/Download`;
    // If base already ends with the folder name (absolute path given), use base as path
    const path =
      isUserSharedAbsolutePath(base) && base.split("/").pop() === folderName
        ? base
        : joinUserStorage(base, folderName);
    return {
      kind: "dir_mkdir",
      summary: t.slice(0, 200),
      mustExist: [path],
      forbidden: ["proot-distro", "apt-get", "rootfs", "ask user to open Termux"],
    };
  }

  // File create in Download / shared storage
  const fileCreate = /(?:создай|создать|create|write|запиш)\w*.{0,80}(?:файл|file|txt|json)/i.test(t)
    || /файл\s+\S+\.txt/i.test(t);
  if (fileCreate) {
    const nameMatch = t.match(/(?:файл|file)\s+([A-Za-z0-9._\u0400-\u04FF-]+\.[A-Za-z0-9]+)/i)
      || t.match(/([A-Za-z0-9._-]+\.(?:txt|json|md|log|csv))\b/i);
    const fname = nameMatch ? nameMatch[1] : "file.txt";
    const base = resolveUserStorageBase(t, { defaultTo: "download" }) || `${ANDROID_SHARED_ROOT}/Download`;
    const path = fname.startsWith("/")
      ? (isUserSharedAbsolutePath(fname) ? fname : joinUserStorage(base, fname.split("/").pop() || "file.txt"))
      : joinUserStorage(base, fname);
    const contentMatch = t.match(/(?:текстом|text|содержим\w*)\s*[;:–—-]?\s*[«"']?(.+?)[»"']?\s*$/i);
    const content = contentMatch ? contentMatch[1].trim() : undefined;
    return {
      kind: "file_write",
      summary: t.slice(0, 200),
      mustExist: [path],
      contentContains: content ? { path, text: content } : undefined,
      forbidden: ["proot-distro", "apt-get", "rootfs", "Ubuntu rootfs check"],
    };
  }


  // Rename / move on shared storage
  if (/(?:переимен[а-яё]*|rename|перемест[а-яё]*|move\b).{0,80}/i.test(t) && !/(?:github|git\s)/i.test(t)) {
    const pair =
      t.match(/(?:переимен[а-яё]*|rename)\s+[«"']?([^\s«"']+)[»"']?\s+(?:в|to|into|as)\s+[«"']?([^\s«"']+)/i) ||
      t.match(/(?:перемест[а-яё]*|move)\s+[«"']?([^\s«"']+)[»"']?\s+(?:в|to|into)\s+[«"']?([^\s«"']+)/i);
    if (pair) {
      let from = pair[1].replace(/[»"']/g, "");
      let to = pair[2].replace(/[»"']/g, "");
      const base = resolveUserStorageBase(t, { defaultTo: "download" }) || `${ANDROID_SHARED_ROOT}/Download`;
      if (!from.startsWith("/")) from = joinUserStorage(base, from);
      if (!to.startsWith("/")) to = joinUserStorage(base, to);
      if (isUserSharedAbsolutePath(from) && isUserSharedAbsolutePath(to)) {
        return {
          kind: "file_rename",
          summary: t.slice(0, 200),
          mustExist: [to],
          mustExistTo: [from],
          forbidden: ["/system", "/data"],
        };
      }
    }
  }

  // Copy on shared storage
  if (/(?:скопир\w*|copy|скопировать)\w*.{0,80}/i.test(t)) {
    const pair =
      t.match(/(?:скопир\w*|copy)\s+[«"']?([^\s«"']+)[»"']?\s+(?:в|to|into|as)\s+[«"']?([^\s«"']+)/i);
    if (pair) {
      let from = pair[1].replace(/[»"']/g, "");
      let to = pair[2].replace(/[»"']/g, "");
      const base = resolveUserStorageBase(t, { defaultTo: "download" }) || `${ANDROID_SHARED_ROOT}/Download`;
      if (!from.startsWith("/")) from = joinUserStorage(base, from);
      if (!to.startsWith("/")) to = joinUserStorage(base, to);
      if (isUserSharedAbsolutePath(from) && isUserSharedAbsolutePath(to)) {
        return {
          kind: "file_copy",
          summary: t.slice(0, 200),
          mustExist: [to],
          mustExistTo: [from],
          forbidden: ["/system", "/data"],
        };
      }
    }
  }

  // List directory on shared storage
  if (/(?:покажи|list|ls\b|содержим\w*|перечисл\w*)\w*.{0,60}(?:папк|folder|каталог|Download|Documents|Pictures|DCIM|Music|Movies|\/storage|\/sdcard)/i.test(t)
    || /(?:покажи|list|ls\b).{0,40}(?:файл\w*|files?)/i.test(t) && /download|document|picture|storage|sdcard|загрузк|документ/i.test(t)) {
    const base = resolveUserStorageBase(t, { defaultTo: "download" }) || `${ANDROID_SHARED_ROOT}/Download`;
    const path = isUserSharedAbsolutePath(base) ? base : `${ANDROID_SHARED_ROOT}/Download`;
    return {
      kind: "dir_list",
      summary: t.slice(0, 200),
      mustExist: [path],
      forbidden: [],
    };
  }

  // Delete file or folder on shared storage
  if (/(?:удал\w*|delete|remove)\w*.{0,60}(?:файл|file|папк\w*|folder|каталог|dir)/i.test(t)) {
    const pathMatch =
      t.match(/(\/storage\/emulated\/\d\/[^\s"'`]+)/) ||
      t.match(/(\/sdcard\/[^\s"'`]+)/) ||
      t.match(/(?:файл|file|папк\w*|folder)\s+[«"']?([A-Za-z0-9._\u0400-\u04FF-]+(?:\.[A-Za-z0-9]+)?)[»"']?/i);
    let target = pathMatch ? pathMatch[1] : "";
    if (target && !target.startsWith("/")) {
      const base = resolveUserStorageBase(t, { defaultTo: "download" }) || `${ANDROID_SHARED_ROOT}/Download`;
      target = joinUserStorage(base, target);
    } else if (target && !isUserSharedAbsolutePath(target)) {
      target = ""; // refuse system/root paths
    }
    return {
      kind: "file_delete",
      summary: t.slice(0, 200),
      mustExist: target ? [target] : [],
      forbidden: ["proot-distro", "ask user to open Termux"],
    };
  }

  return {
    kind: "generic",
    summary: t.slice(0, 200),
    mustExist: [],
    forbidden: [],
  };
}

export function formatGoalBlock(goal: AgentGoal): string {
  const lines = [
    "[GOAL]",
    `kind=${goal.kind}`,
    `summary=${goal.summary}`,
    goal.mustExist.length ? `must_exist=${goal.mustExist.join(";")}` : "must_exist=none",
    goal.mustExistTo?.length ? `must_exist_from=${goal.mustExistTo.join(";")}` : "",
    goal.contentContains ? `content_contains=${goal.contentContains.path} :: ${goal.contentContains.text.slice(0, 80)}` : "",
    goal.interceptorAction ? `interceptor_action=${goal.interceptorAction}` : "",
    goal.github ? `github=${goal.github.owner}/${goal.github.repo}` : "",
    goal.forbidden.length ? `forbidden=${goal.forbidden.join(" | ")}` : "",
    "DONE_RULE=never emit TERMUX_DONE/UBUNTU_DONE/DEBIAN_DONE until must_exist verified (or interceptor action confirmed). Prefer AIB_TOOL when available.",
  ].filter(Boolean);
  return lines.join("\n");
}

/**
 * Build a host Termux verify command for file goals.
 * Returns null when goal has no file criteria (model/tool path).
 */
export function buildGoalVerifyCommand(goal: AgentGoal): string | null {
  if ((goal.kind === "file_write" || goal.kind === "dir_mkdir" || goal.kind === "file_rename" || goal.kind === "file_copy") && goal.mustExist[0]) {
    const p = goal.mustExist[0].replace(/'/g, `'"'"'`);
    if (goal.kind === "dir_mkdir") {
      return `test -d '${p}' && ls -la '${p}' && echo AIB_GOAL_OK`;
    }
    if (goal.kind === "file_rename" && goal.mustExistTo?.[0]) {
      const from = goal.mustExistTo[0].replace(/'/g, `'"'"'`);
      return `test ! -e '${from}' && test -e '${p}' && ls -la '${p}' && echo AIB_GOAL_OK`;
    }
    if (goal.kind === "file_copy") {
      return `test -e '${p}' && ls -la '${p}' && echo AIB_GOAL_OK`;
    }
    if (goal.contentContains?.text) {
      const needle = goal.contentContains.text.replace(/'/g, `'"'"'`).slice(0, 200);
      return `test -f '${p}' && grep -F '${needle}' '${p}' >/dev/null && ls -la '${p}' && echo AIB_GOAL_OK`;
    }
    return `test -f '${p}' && ls -la '${p}' && echo AIB_GOAL_OK`;
  }
  if (goal.kind === "dir_list" && goal.mustExist[0]) {
    const p = goal.mustExist[0].replace(/'/g, `'"'"'`);
    return `test -d '${p}' && ls -la '${p}' && echo AIB_GOAL_OK`;
  }
  if (goal.kind === "apk_build") {
    return (
      "APK=$(find /storage/emulated/0/AIBuilderTermux " +
      "-type f -name '*.apk' 2>/dev/null | head -1); " +
      "if [ -n \"$APK\" ] && [ -s \"$APK\" ]; then ls -la \"$APK\"; echo \"AIB_GOAL_OK:$APK\"; else echo AIB_GOAL_NO_APK; exit 1; fi"
    );
  }
  return null;
}

export function goalVerifyPassed(stdout: string, stderr: string): boolean {
  const blob = `${stdout || ""}\n${stderr || ""}`;
  return /\bAIB_GOAL_OK\b/.test(blob);
}


/**
 * Before accepting TERMUX_DONE: run host verify when goal has file criteria.
 * Returns { ok, detail }. ok=true means DONE may proceed.
 */
export async function shouldBlockDoneForGoal(
  goal: AgentGoal,
  doneMessage: string,
  runVerify: (cmd: string) => Promise<{ exitCode: number; stdout: string; stderr: string }>,
): Promise<{ ok: boolean; detail: string }> {
  if ((goal.kind === "file_write" || goal.kind === "dir_mkdir" || goal.kind === "file_rename" || goal.kind === "file_copy" || goal.kind === "dir_list") && goal.mustExist[0]) {
    const cmd = buildGoalVerifyCommand(goal);
    if (!cmd) return { ok: true, detail: "no_verify" };
    try {
      const r = await runVerify(cmd);
      if (goalVerifyPassed(r.stdout || "", r.stderr || "") || r.exitCode === 0) {
        return { ok: true, detail: (r.stdout || "").slice(0, 400) };
      }
      return {
        ok: false,
        detail: `GOAL_NOT_MET path=${goal.mustExist[0]} exit=${r.exitCode}\n${(r.stderr || r.stdout || "").slice(0, 500)}`,
      };
    } catch (e: unknown) {
      return { ok: false, detail: e instanceof Error ? e.message : String(e) };
    }
  }
  if (goal.kind === "file_delete" && goal.mustExist[0]) {
    const p = goal.mustExist[0].replace(/'/g, `'"'"'`);
    try {
      const r = await runVerify(`test ! -e '${p}' && echo AIB_GOAL_OK || (ls -la '${p}' 2>/dev/null; echo AIB_GOAL_STILL_EXISTS)`);
      if (goalVerifyPassed(r.stdout || "", r.stderr || "") || r.exitCode === 0) {
        return { ok: true, detail: "deleted" };
      }
      return { ok: false, detail: `GOAL_NOT_MET still exists: ${goal.mustExist[0]}` };
    } catch (e: unknown) {
      return { ok: false, detail: e instanceof Error ? e.message : String(e) };
    }
  }
    if (goal.kind === "apk_build") {
    const doneApk = (doneMessage || "").match(/(\/(?:storage|data|sdcard)[^\s"'`]+\.apk)/i);
    if (doneApk) {
      const p = doneApk[1].replace(/'/g, `'\"'\"'`);
      try {
        const r = await runVerify(`test -s '${p}' && ls -la '${p}' && echo AIB_GOAL_OK`);
        if (goalVerifyPassed(r.stdout || "", r.stderr || "") || r.exitCode === 0) {
          return { ok: true, detail: (r.stdout || "").slice(0, 400) };
        }
        return { ok: false, detail: `GOAL_NOT_MET apk missing or empty: ${doneApk[1]}` };
      } catch (e: unknown) {
        return { ok: false, detail: e instanceof Error ? e.message : String(e) };
      }
    }
    const cmd = buildGoalVerifyCommand(goal);
    if (!cmd) {
      return { ok: false, detail: "GOAL_APK_PATH_MISSING: TERMUX_DONE must include absolute .apk path" };
    }
    try {
      const r = await runVerify(cmd);
      if (goalVerifyPassed(r.stdout || "", r.stderr || "") || (r.exitCode === 0 && /AIB_GOAL_OK/i.test(r.stdout || ""))) {
        return { ok: true, detail: (r.stdout || "").slice(0, 400) };
      }
      return {
        ok: false,
        detail: `GOAL_NOT_MET apk not found exit=${r.exitCode}\n${(r.stderr || r.stdout || "").slice(0, 500)}`,
      };
    } catch (e: unknown) {
      return { ok: false, detail: e instanceof Error ? e.message : String(e) };
    }
  }
  if (goal.kind === "interceptor") {
    // Interceptor success is tool-side; allow DONE
    return { ok: true, detail: "interceptor_ok" };
  }
  if (goal.kind === "github_local") {
    // Expect materialize path or pack path in message
    if (!/\/storage\/emulated\/0\//.test(doneMessage) && !/AIB_GH_/i.test(doneMessage) && !/materializ/i.test(doneMessage)) {
      return { ok: false, detail: "GOAL_GITHUB_LOCAL: DONE must report local path under /storage/emulated/0" };
    }
    return { ok: true, detail: "github_local_ok" };
  }
  return { ok: true, detail: "generic_ok" };
}
