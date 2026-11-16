export type BuildArtifactKind = "apk" | "aab";

export type BuildArtifactGateInput = Readonly<{
  buildOk: boolean;
  collectExitCode: number;
  collectLog: string;
  artifactPath: string | null;
  validationOk: boolean;
  expectedKind?: BuildArtifactKind;
}>;

export type BuildArtifactGateResult = Readonly<{
  ok: boolean;
  kind: BuildArtifactKind | null;
  reason: string;
}>;

function exactPathMarker(log: string, marker: string): string | null {
  const matches = [...String(log || "").matchAll(new RegExp(`^${marker}=(.+)$`, "gm"))];
  if (matches.length !== 1) return null;
  return matches[0][1].trim() || null;
}

/**
 * Final fail-closed gate: a successful compiler message alone is insufficient.
 * APKs must have a matching signed-artifact marker and pass on-disk validation;
 * AABs must have their own marker and pass bundle signature validation.
 */
export function evaluateBuildArtifactGate(input: BuildArtifactGateInput): BuildArtifactGateResult {
  if (!input.buildOk) return { ok: false, kind: null, reason: "BUILD_NOT_VERIFIED" };
  if (input.collectExitCode !== 0) return { ok: false, kind: null, reason: "COLLECT_EXIT_NONZERO" };
  const artifactPath = String(input.artifactPath || "").trim();
  if (!artifactPath || /[\0\r\n]/.test(artifactPath)) return { ok: false, kind: null, reason: "ARTIFACT_PATH_MISSING_OR_INVALID" };

  const kind: BuildArtifactKind | null = /\.apk$/i.test(artifactPath)
    ? "apk"
    : /\.aab$/i.test(artifactPath)
      ? "aab"
      : null;
  if (!kind) return { ok: false, kind: null, reason: "ARTIFACT_EXTENSION_UNSUPPORTED" };
  if (input.expectedKind && kind !== input.expectedKind) {
    return { ok: false, kind, reason: "ARTIFACT_KIND_MISMATCH" };
  }

  const marker = kind === "apk" ? "SIGNED_V1_V2_V3_OK" : "AAB_OK";
  if (exactPathMarker(input.collectLog, marker) !== artifactPath) {
    return { ok: false, kind, reason: kind === "apk" ? "APK_SIGNATURE_MARKER_MISSING_OR_MISMATCHED" : "AAB_SIGNATURE_MARKER_MISSING_OR_MISMATCHED" };
  }
  if (!input.validationOk) return { ok: false, kind, reason: "ON_DISK_ARTIFACT_VALIDATION_FAILED" };
  return { ok: true, kind, reason: "VERIFIED_SIGNED_ARTIFACT" };
}
