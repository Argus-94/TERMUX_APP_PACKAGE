/**
 * Deterministic playbooks — no LLM when the task is fully classified.
 * v395: simple file playbooks prefer host Termux (Native Priority / Fast Path).
 * Shell playbooks return host commands; tool playbooks return AIB_TOOL steps.
 */
import type { AgentGoal } from "./agent-goal";

export type ShellPlaybook = Readonly<{
  kind: "shell";
  id: string;
  /**
   * preferHost: try host Termux first (rare).
   * preferGuest: try active Ubuntu proot first when selected, host fallback if rootfs cannot start.
   * hostOnly: always host (storage edge cases).
   */
  storageMode: "preferHost" | "preferGuest" | "hostOnly";
  command: string;
  doneMessage: string;
}>;

export type ToolStep = Readonly<{ tool: string; args: Record<string, unknown> }>;

export type ToolPlaybook = Readonly<{
  kind: "tools";
  id: string;
  steps: ToolStep[];
  doneMessage: string;
}>;

export type PlaybookResult = ShellPlaybook | ToolPlaybook;




export function tryFileRenamePlaybook(goal: AgentGoal): ShellPlaybook | null {
  if (goal.kind !== "file_rename" || !goal.mustExist[0] || !goal.mustExistTo?.[0]) return null;
  const to = goal.mustExist[0].replace(/'/g, `'\"'\"'`);
  const from = goal.mustExistTo[0].replace(/'/g, `'\"'\"'`);
  const command =
    `mv -f '${from}' '${to}' && test ! -e '${from}' && test -e '${to}' && ls -la '${to}' && echo AIB_GOAL_OK`;
  return { kind: "shell", id: "file_rename_shared", storageMode: "preferHost", command, doneMessage: to };
}

export function tryFileCopyPlaybook(goal: AgentGoal): ShellPlaybook | null {
  if (goal.kind !== "file_copy" || !goal.mustExist[0] || !goal.mustExistTo?.[0]) return null;
  const to = goal.mustExist[0].replace(/'/g, `'\"'\"'`);
  const from = goal.mustExistTo[0].replace(/'/g, `'\"'\"'`);
  const command =
    `cp -a '${from}' '${to}' && test -e '${to}' && ls -la '${to}' && echo AIB_GOAL_OK`;
  return { kind: "shell", id: "file_copy_shared", storageMode: "preferHost", command, doneMessage: to };
}

export function tryDirListPlaybook(goal: AgentGoal): ShellPlaybook | null {
  if (goal.kind !== "dir_list" || !goal.mustExist[0]) return null;
  const path = goal.mustExist[0].replace(/'/g, `'\"'\"'`);
  const command =
    `test -d '${path}' && ls -la '${path}' && echo AIB_GOAL_OK`;
  return { kind: "shell", id: "dir_list_shared", storageMode: "preferHost", command, doneMessage: path };
}

export function tryFileDeletePlaybook(goal: AgentGoal): ShellPlaybook | null {
  if (goal.kind !== "file_delete" || !goal.mustExist[0]) return null;
  const path = goal.mustExist[0];
  const pathEsc = path.replace(/'/g, `'\"'\"'`);
  const command =
    `rm -rf '${pathEsc}' && test ! -e '${pathEsc}' && echo AIB_GOAL_OK`;
  return {
    kind: "shell",
    id: "file_delete_shared",
    storageMode: "preferHost",
    command,
    doneMessage: `deleted ${path}`,
  };
}

export function tryDirMkdirPlaybook(goal: AgentGoal): ShellPlaybook | null {
  if (goal.kind !== "dir_mkdir" || !goal.mustExist[0]) return null;
  const path = goal.mustExist[0];
  const pathEsc = path.replace(/'/g, `'\"'\"'`);
  const command =
    `mkdir -p '${pathEsc}' && test -d '${pathEsc}' && ls -la '${pathEsc}' && echo AIB_GOAL_OK`;
  return {
    kind: "shell",
    id: "dir_mkdir_shared",
    storageMode: "preferHost",
    command,
    doneMessage: path,
  };
}

export function tryFileWritePlaybook(goal: AgentGoal): ShellPlaybook | null {
  if (goal.kind !== "file_write" || !goal.mustExist[0]) return null;
  const path = goal.mustExist[0];
  const dir = path.replace(/\/[^/]+$/, "");
  const text = goal.contentContains?.text ?? "";
  const esc = text.replace(/'/g, `'\"'\"'`);
  const pathEsc = path.replace(/'/g, `'\"'\"'`);
  const dirEsc = dir.replace(/'/g, `'\"'\"'`);
  const command =
    `mkdir -p '${dirEsc}' && ` +
    `printf '%s\\n' '${esc}' > '${pathEsc}' && ` +
    `test -f '${pathEsc}' && ls -la '${pathEsc}' && echo AIB_GOAL_OK`;
  return {
    kind: "shell",
    id: "file_write_shared",
    storageMode: "preferHost",
    command,
    doneMessage: path,
  };
}

/** GitHub → local dir (+ optional pack). Requires owner/repo from goal. */
export function tryGithubLocalPlaybook(goal: AgentGoal, userTask: string): ToolPlaybook | null {
  if (goal.kind !== "github_local" || !goal.github?.owner || !goal.github?.repo) return null;
  const owner = goal.github.owner;
  const repo = goal.github.repo;
  const wantPack = /pack|zip|архив|на\s+телефон|download|загрузк/i.test(userTask);
  const steps: ToolStep[] = [
    { tool: "github.materialize", args: { owner, repo, ref: "HEAD" } },
  ];
  // pack path filled after materialize by runner using result.localPath
  if (wantPack) {
    steps.push({ tool: "github.pack", args: { sourceDir: "__MATERIALIZE_PATH__" } });
  }
  const wantApk = /(?:apk|aab|assemble|собери|собрать|скомпилир|build\s+apk|gradlew)/i.test(userTask);
  if (wantApk) {
    steps.push({ tool: "toolchain.ensure", args: {} });
    steps.push({
      tool: "build.run",
      args: {
        command: "__MATERIALIZE_BUILD__",
      },
    });
  }
  const id =
    wantApk && wantPack ? "github_materialize_pack_apk"
    : wantApk ? "github_materialize_apk"
    : wantPack ? "github_materialize_pack"
    : "github_materialize";
  return {
    kind: "tools",
    id,
    steps,
    doneMessage:
      `GitHub ${owner}/${repo} materialized` +
      (wantPack ? " and packed" : "") +
      (wantApk ? " and APK build attempted" : ""),
  };
}

/** Interceptor enable/disable/last without LLM. */
export function tryInterceptorPlaybook(goal: AgentGoal): ToolPlaybook | null {
  if (goal.kind !== "interceptor") return null;
  const a = goal.interceptorAction || "other";
  if (a === "enable") {
    return { kind: "tools", id: "interceptor_enable", steps: [{ tool: "interceptor.enable", args: {} }], doneMessage: "Interceptor enabled" };
  }
  if (a === "disable") {
    return { kind: "tools", id: "interceptor_disable", steps: [{ tool: "interceptor.disable", args: {} }, { tool: "interceptor.rulesDisable", args: {} }], doneMessage: "Interceptor disabled" };
  }
  if (a === "last") {
    return { kind: "tools", id: "interceptor_last", steps: [{ tool: "interceptor.last", args: { limit: 20 } }], doneMessage: "Interceptor last requests" };
  }
  // rule / other → LLM
  return null;
}

/** APK: only when absolute project path is already in the task (no LLM discovery). */
export function tryApkBuildPlaybook(goal: AgentGoal, userTask: string): ToolPlaybook | null {
  if (goal.kind !== "apk_build") return null;
  // Absolute shared-storage project dir or .zip.
  const pathMatch =
    userTask.match(/(\/storage\/emulated\/\d+\/[^\s"'`]+)/i) ||
    userTask.match(/(\/sdcard\/[^\s"'`]+)/i) ||
    userTask.match(/(\/data\/data\/com\.termux\/files\/home\/[^\s"'`]+)/i);
  if (!pathMatch) return null;
  const srcPath = pathMatch[1].replace(/\/$/, "");
  const q = srcPath.replace(/'/g, `'\"'\"'`);
  // Shell script as ordinary strings so bash ${...} / $() are NOT parsed as JS template slots.
  const command = [
    "set -e",
    "SRC='" + q + "'",
    'if [ ! -e "$SRC" ]; then echo "AIB_SRC_MISSING:$SRC"; exit 2; fi',
    'ROOT=""',
    'if [ -f "$SRC" ] && echo "$SRC" | grep -qi "\\.zip$"; then',
    '  WORK="${TMPDIR:-/tmp}/aib-apk-$$"',
    '  rm -rf "$WORK"; mkdir -p "$WORK"',
    '  unzip -o -q "$SRC" -d "$WORK" || { echo AIB_UNZIP_FAILED; exit 3; }',
    '  if [ "$(find "$WORK" -mindepth 1 -maxdepth 1 | wc -l)" -eq 1 ] && [ -d "$(find "$WORK" -mindepth 1 -maxdepth 1)" ]; then',
    '    ROOT="$(find "$WORK" -mindepth 1 -maxdepth 1 -type d)"',
    '  else ROOT="$WORK"; fi',
    'elif [ -d "$SRC" ]; then ROOT="$SRC"',
    'else echo "AIB_SRC_NOT_DIR_OR_ZIP:$SRC"; exit 2; fi',
    'cd "$ROOT"',
    'if [ -f gradlew ]; then bash gradlew assembleDebug --no-daemon -x test',
    'elif [ -f android/gradlew ]; then cd android && bash gradlew assembleDebug --no-daemon -x test',
    'else echo AIB_NO_GRADLEW; find . -maxdepth 3 -name gradlew 2>/dev/null | head; exit 2; fi',
    "APK=$(find . -type f -path '*/outputs/apk/*' -name '*.apk' 2>/dev/null | head -1)",
    'if [ -n "$APK" ]; then echo "AIB_APK_OK:$(pwd)/$APK"; else echo AIB_APK_NOT_FOUND; exit 4; fi',
  ].join("; ");

  return {
    kind: "tools",
    id: "apk_build_known_path",
    steps: [
      { tool: "toolchain.ensure", args: {} },
      { tool: "build.run", args: { command } },
    ],
    doneMessage: "APK build attempted for " + srcPath,
  };
}


export function tryPlaybook(goal: AgentGoal, userTask = ""): PlaybookResult | null {
  // Structural playbooks first (paths / file ops). Linguistic github/interceptor are optional accelerators only.
  return (

    tryFileRenamePlaybook(goal) ||
    tryFileCopyPlaybook(goal) ||
    tryDirListPlaybook(goal) ||
    tryFileDeletePlaybook(goal) ||
    tryDirMkdirPlaybook(goal) ||
    tryFileWritePlaybook(goal) ||
    tryInterceptorPlaybook(goal) ||
    tryGithubLocalPlaybook(goal, userTask) ||
    tryApkBuildPlaybook(goal, userTask) ||
    null
  );
}
