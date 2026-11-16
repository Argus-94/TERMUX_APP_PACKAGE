import { APK_BUILD_SAFETY_POLICY } from "./apk-build-safety-policy";

/**
 * Backend-aware autonomy policy for the chat agent:
 * detect missing tools → install with the correct package manager →
 * on failure read logs → fix cause → retry.
 */
/** Mirrors AgentShellBackend without importing it (avoid cycles). */
export type AutonomyBackend = "termux" | "ubuntu-proot";

export type AutonomyInstallHint = Readonly<{
  /** Logical tool id */
  id: string;
  /** How to detect presence (shell) */
  check: string;
  /** Install on Termux host */
  termuxInstall: string;
  /** Install inside the Ubuntu proot guest (apt) */
  linuxInstall: string;
}>;

/** Common task dependencies and how to install them per environment. */
export const AUTONOMY_INSTALL_HINTS: readonly AutonomyInstallHint[] = [
  {
    id: "git",
    check: "command -v git",
    termuxInstall: "pkg update -y && pkg install -y git",
    linuxInstall: "apt-get update -y && apt-get install -y git",
  },
  {
    id: "curl",
    check: "command -v curl",
    termuxInstall: "pkg install -y curl",
    linuxInstall: "apt-get update -y && apt-get install -y curl",
  },
  {
    id: "wget",
    check: "command -v wget",
    termuxInstall: "pkg install -y wget",
    linuxInstall: "apt-get update -y && apt-get install -y wget",
  },
  {
    id: "python",
    check: "command -v python3 || command -v python",
    termuxInstall: "pkg install -y python",
    linuxInstall: "apt-get update -y && apt-get install -y python3 python3-pip",
  },
  {
    id: "nodejs",
    check: "command -v node",
    termuxInstall: "pkg install -y nodejs",
    linuxInstall: "apt-get update -y && apt-get install -y nodejs npm",
  },
  {
    id: "unzip",
    check: "command -v unzip",
    termuxInstall: "pkg install -y unzip",
    linuxInstall: "apt-get update -y && apt-get install -y unzip",
  },
  {
    id: "clang",
    check: "command -v clang || command -v gcc",
    termuxInstall: "pkg install -y clang make pkg-config",
    linuxInstall: "apt-get update -y && apt-get install -y build-essential",
  },
  {
    id: "maven",
    check: "command -v mvn",
    termuxInstall: "pkg install -y maven",
    linuxInstall: "apt-get update -y && apt-get install -y maven",
  },
  {
    id: "cmake",
    check: "command -v cmake",
    termuxInstall: "pkg install -y cmake",
    linuxInstall: "apt-get update -y && apt-get install -y cmake",
  },
];

export function installCommandForTool(
  toolId: string,
  backend: AutonomyBackend,
): string | null {
  const hint = AUTONOMY_INSTALL_HINTS.find((h) => h.id === toolId);
  if (!hint) return null;
  return backend === "termux" ? hint.termuxInstall : hint.linuxInstall;
}

/** Default step budget of one chat-agent run (was 32). */
export const AGENT_DEFAULT_MAX_STEPS = 48;
/** How many times a non-create task may auto-extend its budget by +24 steps (was 2). */
export const AGENT_MAX_STEP_EXTENSIONS = 4;
/** Budget for pure file-operation tasks (was 12). */
export const AGENT_FILE_OPS_MAX_STEPS = 24;

/**
 * System-prompt block: use EVERY available agent tool on your own.
 * Tool names mirror AGENT_TOOL_NAMES (lib/agent-tools/types.ts); calls use the
 * existing whole-response `AIB_TOOL: {"tool":"<name>","args":{...}}` envelope.
 */
export function agentToolFirstPromptBlock(): string {
  return (
    `[TOOL-FIRST AUTONOMY]\n` +
    `You are a fully autonomous agent. Do the whole task yourself, end to end, using every available tool. Never stop at the first error: read the log, diagnose, fix, retry until the user task is done or truly exhausted. ` +
    `Never ask the user for permission, paths or confirmation that you can obtain or verify with a tool. ` +
    `Do not describe a plan instead of acting: call the tool.\n` +
    `Tool families (call as AIB_TOOL, whole response = one tool call):\n` +
    `  - runtime.status / runtime.session / runtime.terminal / runtime.proot / diagnostics.log: inspect the environment and read logs BEFORE guessing and AFTER every failure.\n` +
    `  - fs.read / fs.hashline / fs.create / fs.replace / fs.replaceRange / fs.delete: read and edit files with these instead of cat/sed/echo in the shell; re-read after writing to verify.\n` +
    `  - ast.search / ast.preview / ast.edit: structural code search and refactors; preview before edit.\n` +
    `  - lsp.diagnostics / lsp.definition / lsp.references / lsp.hover / lsp.completion / lsp.rename / lsp.request: run lsp.diagnostics after every code change and fix what it reports.\n` +
    `  - toolchain.ensure / build.run: make sure the toolchain exists, then build; on failure read diagnostics.log, fix the cause, rebuild.\n` +
    `  - github.* (read, tree, list, search, repo, branch, commit, apply, write, prCreate, issue, releases, downloadAsset, ...): work with repositories directly instead of manual git steps when a token is available.\n` +
    `  - memory.recall / memory.retain / memory.reflect: recall relevant project facts at the start of a long task; retain durable decisions and fixes at the end.\n` +
    `  - ctx.compose / ctx.expand / ctx.metrics: when the context gets large, compose a summary and expand handles only when needed.\n` +
    `  - skills.list / skills.read / skills.verify: check for a matching skill before a specialised task and follow it.\n` +
    `  - interceptor.*: inspect or toggle interceptor rules only when the task is about them.\n` +
    `Working rules:\n` +
    `1) Pick the dedicated tool first; use the shell only when no tool covers the step.\n` +
    `2) Chain steps without stopping: read -> change -> lsp.diagnostics -> build.run/test -> verify result.\n` +
    `3) If a call returns an error, change the arguments or the tool and retry; never repeat an identical failing call.\n` +
    `4) Finish only when the result is verified (file re-read, diagnostics clean, build/APK present). Then give a short final report.\n` +
    `5) Irreversible or externally visible actions (fs.delete outside the project, github.prMerge, github.repoCreate, force pushes, payments) only when the user task clearly asks for them; the app's own confirmation gate stays active.\n` +
    `6) Ask the user only when required data is truly missing and no tool can obtain it.`
  );
}

/**
 * System-prompt block: autonomous detect → install → log → fix loop.
 * Injected with SHELL_BACKEND so the model uses the right package manager.
 */
export function agentAutonomyPromptBlock(backend: AutonomyBackend): string {
  const distro = backend === "ubuntu-proot" ? "Ubuntu" : "Termux";
  const isLinux = backend === "ubuntu-proot";
  const pm = isLinux ? "apt-get (inside guest)" : "pkg (Termux host)";
  const examples = AUTONOMY_INSTALL_HINTS
    .map((h) => {
      const cmd = isLinux ? h.linuxInstall : h.termuxInstall;
      return `  - ${h.id}: check \`${h.check}\`; if missing → \`${cmd}\``;
    })
    .join("\n");

  const apkNote = `APK build IN ${distro}: ${APK_BUILD_SAFETY_POLICY}`;

  return (
    `[AUTONOMY — selected environment: ${distro} / ${backend}]\n` +
    `This environment is independent. Create/build/install ONLY here. Do not migrate the task to another environment.\n` +
    `You MUST complete the user task here without asking the user to install or fix anything manually.\n` +
    `Loop for every task:\n` +
    `1) PLAN — list binaries/packages the task needs (e.g. git, java, python3, node, unzip, Android SDK).\n` +
    `2) DETECT — run short checks (\`command -v …\`). Package manager is ${pm}.\n` +
    `3) INSTALL — missing utilities use ${pm}; Android SDK/platform/build-tools/CMake/NDK use sdkmanager (accept licenses first); JDK 17 via ${pm}. Re-check every repair.\n` +
    `4) EXECUTE — run the actual task commands in THIS environment.\n` +
    `5) ON ERROR — read [TERMUX_RESULT]/diagnostics.log; fix cause; retry a CHANGED command; do not switch environment.\n` +
    `6) STOP only when done or genuine blockers (no network, embedded-private runtime/workspace access, confirmed-absent rootfs).\n` +
    `Android project workflow (archive, existing folder, or new app) — run it end to end without asking the user:\n` +
    `  A) INSPECT: find the project root and stack from manifests (settings.gradle[.kts], gradlew, AGP/Gradle/Kotlin versions, compileSdk/ndkVersion, package.json + lockfile for Expo/React Native/Capacitor, pubspec.yaml, pom.xml, CMakeLists.txt). New app: write the full source tree under the project folder first, run lsp.diagnostics / static checks and fix every error before building.\n` +
    `  B) TOOLCHAIN: check what this ${distro} environment already has (java -version, sdkmanager, ANDROID_HOME, build-tools, node, pnpm). Anything missing is installed by the build script itself (the aib-autobuild engine) or by you with ${pm}/sdkmanager/curl.\n` +
    `  C) SCRIPT: write build-apk-<project>.sh into the project folder (the build.run tool does this and wraps the command in the self-healing engine), then run it with \`bash <path>\` (shared storage may be noexec).\n` +
    `  D) MONITOR + FIX LOOP: read the output. AIB_AUTOBUILD_RESULT=ok means the engine already repaired and rebuilt; AIB_AUTOBUILD_NEEDS_LLM=1 means a cause it cannot fix alone — read AIB_AUTOBUILD_FIRST_ERROR and the history log, fix source/config/paths, regenerate the script, run again. Repeat until a real non-empty signed APK/AAB exists. Do not stop at the first, second or third error.\n` +
    `  E) VERIFY: check the APK structure and signature, then report the path.\n` +
    `Do not delete the user's projects or unrelated shared-storage data as a repair; reset a rootfs only when its login is unrecoverable.\n` +
    `Install cheat-sheet:\n${examples}\n` +
    `${apkNote}\n` +
    `APK TOOLCHAIN: toolchain.ensure only probes; installing and repairing is done by the build script engine or by you. Keep the project's compilation config, identity and lockfiles as written unless a source error proves otherwise.\n` +
    `Rules:\n` +
    `- ${isLinux ? "Ubuntu: apt only. Termux is not the build machine for this session." : "Termux: pkg only."}\n` +
    `- User project/source/build-script files stay under /storage/emulated/0/AIBuilderTermux; an archive may be read from Download, but extract/copy it into a project child there. Toolchains and build caches stay in the selected ${distro} backend.\n` +
    `- Prefer repairing the rootfs over proot-distro reset/remove; install a rootfs only when list+login confirm absence.\n` +
    `- Speak briefly in the user's language when starting a long install.\n` +
    agentToolFirstPromptBlock()
  );
}
