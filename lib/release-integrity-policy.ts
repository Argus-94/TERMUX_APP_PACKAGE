export const EXPECTED_RELEASE_CERT_SHA256 = "661e5c868dbb38f8fe57d380e5c9b35e594e79bedb72d9ad2ad0113665c80418";
export const LEGACY_RELEASE_CERT_SHA256 = "b5dacc6f9c37adceace5c0d715eecb2762b5a0417468e221ec9c534ea1e6328e";
export const EXPECTED_RELEASE_APPLICATION_ID = "com.karat.aibuilder";

const ACCEPTED_RELEASE_CERT_SHA256 = new Set([EXPECTED_RELEASE_CERT_SHA256, LEGACY_RELEASE_CERT_SHA256]);

const KNOWN_HOOK_SIGNALS = new Set([
  "debugger_attached",
  "known_instrumentation_mapping",
  "xposed_class_detected",
]);

export interface ReleaseIntegrityStatus {
  allowed: boolean;
  debugBuild: boolean;
  reason: string;
  hookSignals: string[];
}

interface ReleaseIntegrityEvidence {
  applicationId?: unknown;
  debugBuild?: unknown;
  debuggable?: unknown;
  probeComplete?: unknown;
  hookScanComplete?: unknown;
  signerSha256?: unknown;
  hookSignals?: unknown;
}

function blocked(reason: string, hookSignals: string[] = []): ReleaseIntegrityStatus {
  return { allowed: false, debugBuild: false, reason, hookSignals };
}

export function unverifiedReleaseIntegrityStatus(reason = "probe_unavailable"): ReleaseIntegrityStatus {
  return blocked(reason);
}

export function notAndroidIntegrityStatus(): ReleaseIntegrityStatus {
  return { allowed: true, debugBuild: false, reason: "not_android", hookSignals: [] };
}

export function evaluateReleaseIntegrityEvidence(input: unknown): ReleaseIntegrityStatus {
  if (!input || typeof input !== "object" || Array.isArray(input)) return blocked("probe_unavailable");
  const evidence = input as ReleaseIntegrityEvidence;

  // Development builds intentionally use the Android debug signer. Production builds
  // are distinguished by the compile-time BuildConfig flag, not a mutable JS setting.
  if (evidence.debugBuild === true) {
    return { allowed: true, debugBuild: true, reason: "debug_build", hookSignals: [] };
  }

  if (evidence.applicationId !== EXPECTED_RELEASE_APPLICATION_ID) return blocked("application_id_mismatch");
  if (evidence.probeComplete !== true) return blocked("probe_incomplete");
  if (evidence.hookScanComplete !== true) return blocked("hook_scan_incomplete");
  if (evidence.debuggable !== false) return blocked("release_debuggable");

  const signers = evidence.signerSha256;
  if (!Array.isArray(signers) || signers.length !== 1 || typeof signers[0] !== "string" || !/^[a-f0-9]{64}$/i.test(signers[0])) {
    return blocked("signer_set_invalid");
  }
  if (!ACCEPTED_RELEASE_CERT_SHA256.has(signers[0].toLowerCase())) return blocked("signature_mismatch");

  if (!Array.isArray(evidence.hookSignals) || evidence.hookSignals.length > 8) return blocked("hook_evidence_invalid");
  const signals: string[] = [];
  for (const signal of evidence.hookSignals) {
    if (typeof signal !== "string" || !/^[a-z0-9_]{1,64}$/.test(signal)) return blocked("hook_evidence_invalid");
    if (!KNOWN_HOOK_SIGNALS.has(signal)) return blocked("unknown_hook_signal", [signal]);
    signals.push(signal);
  }
  if (signals.length > 0) return blocked("runtime_hook_detected", signals);
  return { allowed: true, debugBuild: false, reason: "ok", hookSignals: [] };
}

export function assertReleaseIntegrityAllowsSensitiveAction(status: ReleaseIntegrityStatus | null | undefined): void {
  if (status?.allowed === true) return;
  const reason = status && /^[a-z0-9_]{1,64}$/.test(status.reason) ? status.reason : "probe_unavailable";
  throw Object.assign(new Error(`BLOCKED_APP_INTEGRITY:${reason}`), {
    code: "AIB_APP_INTEGRITY_BLOCKED",
    integrityReason: reason,
  });
}
