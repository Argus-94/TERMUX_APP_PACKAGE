import {
  getTermuxNative,
  getEmbeddedTermuxRuntimeStatus,
  prepareEmbeddedTermuxRuntime,
  runEmbeddedFullCandidateTransaction,
} from "./termux-bridge";
import { CANDIDATE_PACKAGES, CANDIDATE_PROTECTED_PACKAGES, CANDIDATE_RELEASE_VALID_UNTIL } from "./candidate-full-packages.generated";
import { isSamePrivateRuntimePath } from "./private-runtime-path.js";
export { CANDIDATE_PACKAGES, CANDIDATE_PROTECTED_PACKAGES, CANDIDATE_CACHE_NAME, CANDIDATE_RELEASE_VALID_UNTIL } from "./candidate-full-packages.generated";

export { CANDIDATE_REQUIRED_PRIVATE_FREE_BYTES } from "./candidate-full-packages.generated";
export const CANDIDATE_BOOTSTRAP_COMPATIBLE = true;
export const CANDIDATE_INSTALL_BLOCKER = "Требуется приватный runtime приложения";

export type FullCandidateAction = "verify" | "install" | "reinstall" | "remove" | "check";
export type FullCandidateDiagnostics = {
  phase: "preflight" | "native_rejection" | "result_validation";
  reasonCode: "CANDIDATE_PREFLIGHT_REJECTED" | "CANDIDATE_NATIVE_REJECTED" | "CANDIDATE_NATIVE_TIMEOUT" | "CANDIDATE_OUTPUT_TRUNCATED" | "CANDIDATE_NONZERO_EXIT" | "CANDIDATE_CONFIRMATION_NOT_PROVEN" | "CANDIDATE_CONFIRMED";
  exitCode: number | null;
  timedOut: boolean | null;
  outputTruncated: boolean | null;
  stdoutChars: number | null;
  stderrChars: number | null;
  stdoutBytes: number | null;
  stderrBytes: number | null;
};
export interface FullCandidateResult {
  ok: boolean;
  action: FullCandidateAction;
  code: string;
  log: string;
  evidencePath?: string;
  qualified: false;
  productionEnabled: false;
  mutationStatus: "not_requested" | "not_dispatched" | "verified" | "unconfirmed";
  diagnostics: FullCandidateDiagnostics;
  states?: Record<string, { status: "installed" | "absent"; version: string }>;
}
const noPromotion = { qualified: false, productionEnabled: false } as const;
const names = new Map<string, { version: string }>(CANDIDATE_PACKAGES.map((pkg) => [pkg.name, pkg]));
const protectedNames = new Set(CANDIDATE_PROTECTED_PACKAGES);
const actions = new Set(["verify", "install", "reinstall", "remove", "check"]);
let pending: { signature: string; promise: Promise<FullCandidateResult> } | undefined;

function outputBytes(text: string): number {
  let bytes = 0;
  for (const character of text) {
    const point = character.codePointAt(0) ?? 0;
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
  }
  return bytes;
}

/** A tool alias is only a catalog selection, never a shell installer or an unsupported artifact substitute. */
export function candidatePackageIdsForTool(id: string): readonly string[] | undefined {
  const aliases: Record<string, readonly string[]> = {
    "openjdk17": ["openjdk-17"], "java": ["openjdk-17"], "jdk": ["openjdk-17"],
    "pkgconfig": ["pkg-config"], "gh-cli": ["gh"],
  };
  const selected = aliases[id] ?? (names.has(id) ? [id] : undefined);
  return selected?.every((name) => names.has(name)) ? selected : undefined;
}
function errorResult(action: FullCandidateAction, code: string, dispatched = false, evidencePath?: string,
  phase: "preflight" | "native_rejection" = "preflight"): FullCandidateResult {
  return { ...noPromotion, action, ok: false, code, log: code, evidencePath,
    diagnostics: { phase, reasonCode: phase === "native_rejection" ? "CANDIDATE_NATIVE_REJECTED" : "CANDIDATE_PREFLIGHT_REJECTED",
      exitCode: null, timedOut: null, outputTruncated: null, stdoutChars: null, stderrChars: null, stdoutBytes: null, stderrBytes: null },
    mutationStatus: action === "verify" || action === "check" ? "not_requested" : dispatched ? "unconfirmed" : "not_dispatched" };
}
function normalizeSelection(action: FullCandidateAction, selected: readonly string[]): readonly string[] {
  if (!actions.has(action) || !Array.isArray(selected) || selected.length > CANDIDATE_PACKAGES.length ||
      selected.some((name) => typeof name !== "string" || !/^[a-z0-9][a-z0-9+.-]{0,127}$/.test(name) || !names.has(name)) ||
      new Set(selected).size !== selected.length) throw new Error("AIB_FULL_CANDIDATE_SELECTION_INVALID");
  if (["verify", "check"].includes(action) && selected.length) throw new Error("AIB_FULL_CANDIDATE_SELECTION_INVALID");
  if (["install", "reinstall", "remove"].includes(action) && !selected.length) throw new Error("AIB_FULL_CANDIDATE_SELECTION_REQUIRED");
  if (["install", "reinstall"].includes(action) &&
      (selected.length !== CANDIDATE_PACKAGES.length || CANDIDATE_PACKAGES.some((pkg) => !selected.includes(pkg.name)))) {
    throw new Error("AIB_FULL_CANDIDATE_FULL_COHORT_REQUIRED");
  }
  if (["install", "reinstall", "remove"].includes(action) && (!CANDIDATE_BOOTSTRAP_COMPATIBLE || CANDIDATE_PACKAGES.length !== 82)) throw new Error("AIB_FULL_CANDIDATE_BOOTSTRAP_INCOMPATIBLE");
  if (action === "remove" && selected.some((name) => protectedNames.has(name))) throw new Error("AIB_FULL_CANDIDATE_BOOTSTRAP_REMOVAL_FORBIDDEN");
  return [...selected].sort();
}

async function execute(action: FullCandidateAction, selected: readonly string[], signal: AbortSignal | undefined, isSessionEnabled: () => boolean): Promise<FullCandidateResult> {
  let dispatched = false;
  let nativeCallStarted = false;
  let evidencePath: string | undefined;
  try {
    // This signed cohort is test-only; prevent preparation and mutations after its declared validity window.
    const releaseExpiry = Date.parse(CANDIDATE_RELEASE_VALID_UNTIL);
    if (!Number.isFinite(releaseExpiry) || Date.now() > releaseExpiry) throw new Error("AIB_FULL_CANDIDATE_RELEASE_EXPIRED");
    if (!isSessionEnabled()) throw new Error("AIB_FULL_CANDIDATE_SESSION_DISABLED");
    const native = getTermuxNative();
    if (!native?.runEmbeddedCandidateFullTransaction) throw new Error("AIB_FULL_CANDIDATE_UNAVAILABLE");
    if (signal?.aborted) throw new Error("AIB_FULL_CANDIDATE_CANCELLED");
    await prepareEmbeddedTermuxRuntime();
    if (!isSessionEnabled()) throw new Error("AIB_FULL_CANDIDATE_SESSION_DISABLED");
    const status = await getEmbeddedTermuxRuntimeStatus();
    if (!isSessionEnabled()) throw new Error("AIB_FULL_CANDIDATE_SESSION_DISABLED");
    if (!status?.ready || !status.bootstrapManifestValid || status.applicationId !== "com.karat.aibuilder" ||
        status.architecture !== "aarch64" || !["/data/user/0/com.karat.aibuilder/files", "/data/data/com.karat.aibuilder/files"].includes(status.filesDir) ||
        !isSamePrivateRuntimePath(status.filesDir, status.termuxPrefix)) throw new Error("AIB_FULL_CANDIDATE_PRIVATE_RUNTIME_REQUIRED");
    // Native builds the command from its sealed cache and validated names. No arbitrary command, URL or prefix is accepted.
    dispatched = action !== "verify" && action !== "check";
    const nativeSelection = ["verify", "check"].includes(action) ? [] : ["install", "reinstall"].includes(action) ? CANDIDATE_PACKAGES.map((pkg) => pkg.name) : selected;
    nativeCallStarted = true;
    const result = await runEmbeddedFullCandidateTransaction(action, nativeSelection, signal);
    const lines = result.stdout.split(/\r?\n/);
    const marker = `AIB_FULL_CANDIDATE_OK:${action}`;
    const cohortMarker = "AIB_FULL_CANDIDATE_COHORT:82";
    const successes = lines.filter((line) => line.startsWith("AIB_FULL_CANDIDATE_OK:"));
    const evidence = lines.filter((line) => line.startsWith("AIB_FULL_CANDIDATE_EVIDENCE:"));
    const stateLines = lines.filter((line) => line.startsWith("AIB_FULL_CANDIDATE_PACKAGE:"));
    let valid = result.exitCode === 0 && !result.timedOut && !result.outputTruncated && successes.length === 1 && successes[0] === marker;
    const cohortLines = lines.filter((line) => line.startsWith("AIB_FULL_CANDIDATE_COHORT:"));
    if (["install", "reinstall"].includes(action) && (CANDIDATE_PACKAGES.length !== 82 || cohortLines.length !== 1 || cohortLines[0] !== cohortMarker)) valid = false;
    if (!["install", "reinstall"].includes(action) && cohortLines.length) valid = false;
    if (evidence.length !== 1 || !/^AIB_FULL_CANDIDATE_EVIDENCE:\/(?:data\/user\/0|data\/data)\/com\.karat\.aibuilder\/files\/candidate-transactions\/tx-[A-Za-z0-9-]{12,80}$/.test(evidence[0] ?? "")) valid = false;
    else evidencePath = evidence[0].slice("AIB_FULL_CANDIDATE_EVIDENCE:".length);
    const states: NonNullable<FullCandidateResult["states"]> = {};
    for (const line of stateLines) {
      const match = /^AIB_FULL_CANDIDATE_PACKAGE:([a-z0-9][a-z0-9+.-]{0,127}):(installed|absent):([A-Za-z0-9.+:~_-]+)$/.exec(line);
      if (!match || !names.has(match[1]) || states[match[1]]) { valid = false; continue; }
      if (match[2] === "absent" && match[3] !== "-") valid = false;
      if (action === "remove" && !selected.includes(match[1])) valid = false;
      if (["install", "reinstall"].includes(action) && (match[2] !== "installed" || match[3] !== names.get(match[1])!.version)) valid = false;
      states[match[1]] = { status: match[2] as "installed" | "absent", version: match[3] };
    }
    if (["verify", "check"].includes(action) && stateLines.length && action === "verify") valid = false;
    if (["verify", "check"].includes(action) && action === "check" && selected.length) valid = false;
    if (action === "check" && (Object.keys(states).length !== CANDIDATE_PACKAGES.length || CANDIDATE_PACKAGES.some((pkg) => !states[pkg.name]))) valid = false;
    if (["install", "reinstall"].includes(action) && (Object.keys(states).length !== 82 || CANDIDATE_PACKAGES.some((pkg) => !states[pkg.name] || states[pkg.name].status !== "installed" || states[pkg.name].version !== pkg.version))) valid = false;
    if (["install", "reinstall", "remove"].includes(action) && (!CANDIDATE_BOOTSTRAP_COMPATIBLE || CANDIDATE_PACKAGES.length !== 82)) throw new Error("AIB_FULL_CANDIDATE_BOOTSTRAP_INCOMPATIBLE");
  if (action === "remove" && (Object.keys(states).length !== selected.length || selected.some((name) => states[name]?.status !== "absent"))) valid = false;
    if (["install", "reinstall"].includes(action) && (result.exitCode !== 0 || !valid)) valid = false;
    const code = valid ? marker : result.timedOut ? "AIB_FULL_CANDIDATE_TIMEOUT" : result.outputTruncated ? "AIB_FULL_CANDIDATE_TRUNCATED" : "AIB_FULL_CANDIDATE_UNCONFIRMED";
    const reasonCode = result.timedOut ? "CANDIDATE_NATIVE_TIMEOUT" : result.outputTruncated ? "CANDIDATE_OUTPUT_TRUNCATED"
      : result.exitCode !== 0 ? "CANDIDATE_NONZERO_EXIT" : valid ? "CANDIDATE_CONFIRMED" : "CANDIDATE_CONFIRMATION_NOT_PROVEN";
    return { ...noPromotion, action, ok: valid, code, evidencePath,
      diagnostics: { phase: "result_validation", reasonCode, exitCode: result.exitCode, timedOut: result.timedOut,
        outputTruncated: result.outputTruncated, stdoutChars: result.stdout.length, stderrChars: result.stderr.length,
        stdoutBytes: outputBytes(result.stdout), stderrBytes: outputBytes(result.stderr) },
      mutationStatus: dispatched ? valid ? "verified" : "unconfirmed" : "not_requested",
      states: valid && action !== "verify" ? states : undefined,
      log: `${result.stdout}\n${result.stderr}`.trim().slice(-12000) };
  } catch (error: unknown) {
    const value = error as { message?: unknown; code?: unknown };
    const candidate = typeof value?.code === "string" ? value.code : value?.message;
    const code = typeof candidate === "string" && /^(?:AIB_FULL_CANDIDATE_[A-Z0-9_]{1,80}|EMBEDDED_[A-Z0-9_]{1,80})$/.test(candidate)
      ? candidate : "AIB_FULL_CANDIDATE_UNCONFIRMED";
    return errorResult(action, code, dispatched, evidencePath, nativeCallStarted ? "native_rejection" : "preflight");
  }
}

/** Explicit test-only catalog channel. This does not change ordinary private-package-install-policy or production qualification. */
export async function runFullCandidateAction(
  action: FullCandidateAction, packages: readonly string[] = [], options: { signal?: AbortSignal; sessionEnabled?: boolean; isSessionEnabled?: () => boolean } = {},
): Promise<FullCandidateResult> {
  const isSessionEnabled = () => {
    try { return options.sessionEnabled === true && (options.isSessionEnabled?.() ?? true); }
    catch { return false; }
  };
  if (!isSessionEnabled()) return errorResult(action, "AIB_FULL_CANDIDATE_SESSION_DISABLED");
  let selected: readonly string[];
  try { selected = normalizeSelection(action, packages); }
  catch (error: unknown) { return errorResult(action, (error as Error).message); }
  const signature = JSON.stringify([action, selected]);
  if (pending) return pending.signature === signature && !options.signal ? pending.promise : errorResult(action, "AIB_FULL_CANDIDATE_BUSY");
  const entry = { signature, promise: execute(action, selected, options.signal, isSessionEnabled) };
  pending = entry;
  try { return await entry.promise; }
  finally { if (pending === entry) pending = undefined; }
}
