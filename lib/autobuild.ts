import { AUTOBUILD_SCRIPT_BODY } from "./autobuild-script-body.ts";

/**
 * Self-healing build wrapper (v389).
 *
 * The generated build-apk-<project>.sh no longer runs the build command once.
 * It embeds the real command as `aib_primary` and wraps it in the autobuild
 * engine: preflight (install JDK/SDK/node/aapt2 when missing) -> build ->
 * read the log -> apply every matching fixer -> rebuild, entirely inside the
 * script and inside the selected backend (Termux host or Ubuntu guest).
 * What the script cannot fix (real source errors) is handed back with
 * AIB_AUTOBUILD_NEEDS_LLM=1 so the agent writes the next revision from the log.
 */
export type AutobuildBackend = "termux" | "ubuntu-proot";

export const AUTOBUILD_MARKER = "# AI_BUILDER_AUTOBUILD_ENGINE:v1";
export const AUTOBUILD_DEFAULT_MAX_ATTEMPTS = 10;
export const AUTOBUILD_DEFAULT_WALL_SECONDS = 9000;

export type AutobuildOptions = Readonly<{
  backend: AutobuildBackend;
  projectKind: string;
  /** The adapter-generated build command; it runs as a subshell per attempt. */
  primaryCommand: string;
  maxAttempts?: number;
  wallSeconds?: number;
}>;

const KNOWN_KINDS = new Set(["gradle", "expo", "react-native", "capacitor", "cordova", "maven", "native", "flutter"]);

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

export function normalizeAutobuildKind(kind: string): string {
  const k = String(kind || "").toLowerCase().replace(/[^a-z-]/g, "");
  if (k === "reactnative") return "react-native";
  if (k === "cmake" || k === "ndk") return "native";
  return KNOWN_KINDS.has(k) ? k : "unknown";
}

export function wrapWithAutobuild(options: AutobuildOptions): string {
  const command = String(options.primaryCommand || "").trim();
  if (!command || /\0/.test(command)) throw new Error("AUTOBUILD_PRIMARY_COMMAND_INVALID");
  if (options.backend !== "termux" && options.backend !== "ubuntu-proot") throw new Error("AUTOBUILD_BACKEND_INVALID");
  const max = clampInt(options.maxAttempts, AUTOBUILD_DEFAULT_MAX_ATTEMPTS, 1, 30);
  const wall = clampInt(options.wallSeconds, AUTOBUILD_DEFAULT_WALL_SECONDS, 300, 6 * 3600);
  return [
    AUTOBUILD_MARKER,
    `AIB_AB_BACKEND=${options.backend}`,
    `AIB_AB_KIND=${normalizeAutobuildKind(options.projectKind)}`,
    `AIB_AB_MAX=${max}`,
    `AIB_AB_WALL=${wall}`,
    AUTOBUILD_SCRIPT_BODY,
    "aib_primary() (",
    command,
    ")",
    "aib_autobuild_main",
  ].join("\n");
}

export type AutobuildResult = Readonly<{
  ok: boolean;
  attempts: number;
  fixes: readonly string[];
  needsLlm: boolean;
  firstError: string;
  historyLog: string;
}>;

/** Parse the markers printed by the engine; null when the script did not use it. */
export function parseAutobuildResult(output: string): AutobuildResult | null {
  const text = String(output || "");
  const results = [...text.matchAll(/^AIB_AUTOBUILD_RESULT=(ok|failed)$/gm)];
  if (!results.length) return null;
  const last = (name: string): string => [...text.matchAll(new RegExp(`^${name}=(.*)$`, "gm"))].at(-1)?.[1]?.trim() ?? "";
  const fixes = last("AIB_AUTOBUILD_FIXES").split(",").map((x) => x.trim()).filter(Boolean);
  return {
    ok: results.at(-1)![1] === "ok",
    attempts: Number(last("AIB_AUTOBUILD_ATTEMPTS")) || 0,
    fixes,
    needsLlm: last("AIB_AUTOBUILD_NEEDS_LLM") === "1",
    firstError: last("AIB_AUTOBUILD_FIRST_ERROR"),
    historyLog: last("AIB_AUTOBUILD_LOG"),
  };
}
