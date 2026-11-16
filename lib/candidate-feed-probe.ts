import {
  getTermuxNative,
  getEmbeddedTermuxRuntimeStatus,
  prepareEmbeddedTermuxRuntime,
  runEmbeddedTermuxCommand,
} from "./termux-bridge";

type CandidateAction = "verify" | "install-make";
export interface CandidateFeedProbeResult {
  ok: boolean;
  code: string;
  log: string;
  evidencePath?: string;
  action: CandidateAction;
  installed: boolean;
  installationStatus: "not_requested" | "verified" | "unconfirmed";
  qualified: false;
  productionEnabled: false;
}

let pendingProbe: { action: CandidateAction; promise: Promise<CandidateFeedProbeResult> } | null = null;
const noPromotion = { qualified: false, productionEnabled: false } as const;

/** Fixed, explicit candidate actions. No arbitrary packages, URLs, shell commands or production policy changes. */
async function probeOnce(action: CandidateAction): Promise<CandidateFeedProbeResult> {
  let installDispatched = false;
  let evidencePath: string | undefined;
  try {
    const native = getTermuxNative();
    if (!native?.stageEmbeddedCandidateFeedProbe) throw new Error("AIB_CANDIDATE_PROBE_UNAVAILABLE");
    await prepareEmbeddedTermuxRuntime();
    const status = await getEmbeddedTermuxRuntimeStatus();
    if (!status?.ready || !status.bootstrapManifestValid || status.applicationId !== "com.karat.aibuilder" ||
      status.architecture !== "aarch64" || !/^\/data\/user\/0\/com\.karat\.aibuilder\/files$/.test(status.filesDir) ||
      status.termuxPrefix !== `${status.filesDir}/usr`) {
      throw new Error("AIB_CANDIDATE_PROBE_PRIVATE_RUNTIME_REQUIRED");
    }
    const root: unknown = await native.stageEmbeddedCandidateFeedProbe();
    const base = `${status.filesDir}/candidate-probes/`;
    if (typeof root !== "string" || !root.startsWith(base) ||
      !/^probe-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(root.slice(base.length))) {
      throw new Error("AIB_CANDIDATE_PROBE_STAGE_PATH_INVALID");
    }
    evidencePath = root;
    const script = action === "install-make" ? "install-make.sh" : "probe.sh";
    const command = `"$PREFIX/bin/bash" --noprofile --norc '${root}/${script}' '${root}'`;
    installDispatched = action === "install-make";
    const result = await runEmbeddedTermuxCommand(command, { timeoutMs: 120_000 });
    const successMarker = action === "install-make" ? "AIB_CANDIDATE_MAKE_INSTALLED" : "AIB_CANDIDATE_PROBE_OK";
    const markers = result.stdout.split(/\r?\n/).filter((line) => line === successMarker);
    const ok = result.exitCode === 0 && !result.timedOut && !result.outputTruncated && markers.length === 1;
    return {
      ...noPromotion, action, ok,
      installed: ok && action === "install-make",
      installationStatus: action === "verify" ? "not_requested" : ok ? "verified" : "unconfirmed",
      code: ok ? successMarker : result.timedOut ? "AIB_CANDIDATE_PROBE_TIMEOUT" :
        result.outputTruncated ? "AIB_CANDIDATE_PROBE_OUTPUT_TRUNCATED" : "AIB_CANDIDATE_PROBE_FAILED",
      evidencePath,
      log: `${result.stdout}\n${result.stderr}`.trim().slice(-6000),
    };
  } catch (error: unknown) {
    const value = error as { code?: unknown; message?: unknown };
    const candidate = typeof value?.code === "string" ? value.code : value?.message;
    const code = typeof candidate === "string" && /^(?:AIB_CANDIDATE_[A-Z0-9_]{1,80}|EMBEDDED_[A-Z0-9_]{1,80})$/.test(candidate)
      ? candidate : "AIB_CANDIDATE_PROBE_FAILED";
    return { ...noPromotion, action, ok: false, installed: false,
      installationStatus: installDispatched ? "unconfirmed" : "not_requested", code, log: code, evidencePath };
  }
}

async function runCandidateAction(action: CandidateAction): Promise<CandidateFeedProbeResult> {
  if (pendingProbe) {
    if (pendingProbe.action === action) return pendingProbe.promise;
    return { ...noPromotion, action, ok: false, installed: false, installationStatus: "not_requested",
      code: "AIB_CANDIDATE_PROBE_BUSY", log: "AIB_CANDIDATE_PROBE_BUSY" };
  }
  const pending = { action, promise: probeOnce(action) };
  pendingProbe = pending;
  try { return await pending.promise; }
  finally { if (pendingProbe === pending) pendingProbe = null; }
}

/** Read-only package preflight; does not install or run the candidate executable. */
export function runCandidateFeedProbe(): Promise<CandidateFeedProbeResult> { return runCandidateAction("verify"); }
/** Call only after an explicit user review of this bounded test transaction. This never enables ordinary catalog mutations. */
export function installCandidateMake(): Promise<CandidateFeedProbeResult> { return runCandidateAction("install-make"); }
