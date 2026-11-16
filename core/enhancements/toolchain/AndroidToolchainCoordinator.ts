/**
 * Phase 4.2: platform-neutral, adapter-driven Android toolchain coordinator.
 * This module defines policy and stage contracts only; it does not execute
 * Gradle, signing, package inspection, or device installation itself.
 */

export type AndroidBuildVariant = "debug" | "release";

export type AndroidToolchainPreset = Readonly<{
  platform: "android";
  variant: AndroidBuildVariant;
  gradleTask: "assembleDebug" | "assembleRelease";
  expectedArtifactRelativePath: string;
  requiredManifestIdentity: readonly ["applicationId", "appName", "slug"];
}>;

function makePreset(variant: AndroidBuildVariant): AndroidToolchainPreset {
  const debug = variant === "debug";
  return Object.freeze({
    platform: "android" as const,
    variant,
    gradleTask: debug ? "assembleDebug" as const : "assembleRelease" as const,
    expectedArtifactRelativePath: debug
      ? "app/build/outputs/apk/debug/app-debug.apk"
      : "app/build/outputs/apk/release/app-release.apk",
    requiredManifestIdentity: Object.freeze(["applicationId", "appName", "slug"] as const),
  });
}

/** Immutable Android workflow hints, not executable build/sign/install APIs. */
export const ANDROID_TOOLCHAIN_PRESETS: Readonly<Record<AndroidBuildVariant, AndroidToolchainPreset>> = Object.freeze({
  debug: makePreset("debug"),
  release: makePreset("release"),
});

export type AndroidAppIdentity = Readonly<{
  applicationId: string;
  appName: string;
  slug: string;
  /** Exact project build-setting snapshot; coordinator never writes these values. */
  buildSettings: Readonly<Record<string, string>>;
}>;

export type AndroidCoordinatorContext = Readonly<{
  /** Must be the canonical absolute project root established by the host. */
  projectRoot: string;
  expectedIdentity: AndroidAppIdentity;
  preset: AndroidToolchainPreset;
  /** Host cancellation signal; adapters may use it for abortable I/O. */
  signal?: AbortSignal;
}>;

export type AndroidManifestValidation = Readonly<{
  valid: boolean;
  errors: readonly string[];
  /** Validator must return the identity actually observed in the project. */
  identity: AndroidAppIdentity;
}>;

export type AndroidBuildResult = Readonly<{
  ok: boolean;
  /** Absolute path reported by the build adapter; no command output is trusted. */
  artifactPath?: string;
  failureCode?: string;
}>;

export type AndroidRepairRequest = Readonly<{
  attempt: number;
  maxAttempts: number;
  failureCode: string;
}>;

export type AndroidArtifactVerification = Readonly<{
  verified: boolean;
  /** Canonical absolute artifact path actually inspected by the verifier. */
  artifactPath: string;
  regularFile: boolean;
  sha256: string;
  applicationId: string;
  errors: readonly string[];
}>;

export type AndroidSigningResult = Readonly<{
  ok: boolean;
  /** Canonical absolute signed artifact path. */
  artifactPath?: string;
  failureCode?: string;
}>;

export type AndroidInstallResult = Readonly<{
  ok: boolean;
  installedApplicationId?: string;
  failureCode?: string;
}>;

/**
 * Host-injected capabilities. Optional methods deliberately fail closed when
 * the relevant stage is reached; no shell-command or log-text success parsing
 * is part of this contract.
 */
export type AndroidToolchainAdapter = Readonly<{
  readIdentity?: (context: AndroidCoordinatorContext) => Promise<AndroidAppIdentity> | AndroidAppIdentity;
  validateManifest?: (
    context: AndroidCoordinatorContext,
  ) => Promise<AndroidManifestValidation> | AndroidManifestValidation;
  build?: (
    context: AndroidCoordinatorContext,
  ) => Promise<AndroidBuildResult> | AndroidBuildResult;
  repair?: (
    context: AndroidCoordinatorContext,
    request: AndroidRepairRequest,
  ) => Promise<void> | void;
  verifyArtifact?: (
    context: AndroidCoordinatorContext,
    artifactPath: string,
  ) => Promise<AndroidArtifactVerification> | AndroidArtifactVerification;
  sign?: (
    context: AndroidCoordinatorContext,
    verifiedArtifact: AndroidArtifactVerification,
  ) => Promise<AndroidSigningResult> | AndroidSigningResult;
  install?: (
    context: AndroidCoordinatorContext,
    verifiedSignedArtifact: AndroidArtifactVerification,
  ) => Promise<AndroidInstallResult> | AndroidInstallResult;
}>;

export type AndroidToolchainRequest = Readonly<{
  projectRoot: string;
  expectedIdentity: AndroidAppIdentity;
  variant: AndroidBuildVariant;
  /** Number of repair actions allowed after failed builds; clamped to 0..3. */
  maxRepairAttempts?: number;
  install: boolean;
  /** Both flags are required for an install; neither implies the other. */
  installPermission?: boolean;
  installConsent?: boolean;
  /** Cancellation stops progression at the next safe stage boundary. */
  signal?: AbortSignal;
}>;

export type AndroidToolchainStage =
  | "manifest-validation"
  | "build"
  | "repair"
  | "artifact-verification"
  | "signing"
  | "signed-artifact-verification"
  | "install"
  | "complete";

export type AndroidToolchainEvent = Readonly<{
  stage: AndroidToolchainStage;
  ok: boolean;
  detail?: string;
}>;

export type AndroidToolchainResult = Readonly<{
  ok: boolean;
  stage: AndroidToolchainStage;
  buildAttempts: number;
  repairAttempts: number;
  artifactPath?: string;
  events: readonly AndroidToolchainEvent[];
  error?: string;
  detail?: string;
}>;

const MAX_REPAIR_ATTEMPTS = 3;
const APP_ID_RE = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/;
const HASH_RE = /^[a-f0-9]{64}$/i;

function fail(stage: AndroidToolchainStage, code: string, buildAttempts: number, repairAttempts: number, events: AndroidToolchainEvent[], detail?: string): AndroidToolchainResult {
  events.push({ stage, ok: false, detail: detail ?? code });
  return { ok: false, stage, buildAttempts, repairAttempts, events: [...events], error: code, ...(detail ? { detail } : {}) };
}

function canonicalAbsolutePath(value: string): string | null {
  if (!value || value.includes("\0") || value.includes("\\") || !value.startsWith("/")) return null;
  const parts = value.split("/");
  if (parts.slice(1).some((part) => !part || part === "." || part === "..")) return null;
  return value.length > 1 ? value.replace(/\/$/, "") : "/";
}

function pathIsWithin(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root === "/" ? "/" : `${root}/`);
}

function artifactIsWithinProject(root: string, candidate: string): boolean {
  return candidate !== root && pathIsWithin(root, candidate);
}

function identityIsValid(identity: AndroidAppIdentity): boolean {
  if (!identity || typeof identity.applicationId !== "string" || !APP_ID_RE.test(identity.applicationId) ||
      typeof identity.appName !== "string" || !identity.appName.trim() ||
      typeof identity.slug !== "string" || !identity.slug.trim()) return false;
  if (!identity.buildSettings || typeof identity.buildSettings !== "object" || Array.isArray(identity.buildSettings)) return false;
  return Object.entries(identity.buildSettings).every(([key, value]) => Boolean(key.trim()) && typeof value === "string");
}

function stableIdentity(identity: AndroidAppIdentity): string {
  const settings = Object.fromEntries(Object.entries(identity.buildSettings).sort(([a], [b]) => a.localeCompare(b)));
  return JSON.stringify({ applicationId: identity.applicationId, appName: identity.appName, slug: identity.slug, buildSettings: settings });
}

function frozenIdentity(identity: AndroidAppIdentity): AndroidAppIdentity {
  const snapshot = {
    applicationId: identity.applicationId,
    appName: identity.appName,
    slug: identity.slug,
    buildSettings: Object.freeze({ ...identity.buildSettings }),
  };
  return Object.freeze(snapshot);
}

/** Execute the ordered Android lifecycle using only explicitly injected capabilities. */
export async function runAndroidToolchainCoordinator(
  adapter: AndroidToolchainAdapter,
  request: AndroidToolchainRequest,
): Promise<AndroidToolchainResult> {
  const events: AndroidToolchainEvent[] = [];
  let buildAttempts = 0;
  let repairAttempts = 0;
  if (request.signal?.aborted) return fail("manifest-validation", "ABORTED", 0, 0, events);
  const root = canonicalAbsolutePath(request.projectRoot);
  if (!root || root !== request.projectRoot) return fail("manifest-validation", "PROJECT_ROOT_NOT_CANONICAL_ABSOLUTE", 0, 0, events);
  if (request.variant !== "debug" && request.variant !== "release") return fail("manifest-validation", "ANDROID_PRESET_INVALID", 0, 0, events);
  if (!identityIsValid(request.expectedIdentity)) return fail("manifest-validation", "EXPECTED_IDENTITY_INVALID", 0, 0, events);

  const expectedIdentity = frozenIdentity(request.expectedIdentity);
  const context: AndroidCoordinatorContext = Object.freeze({
    projectRoot: root,
    expectedIdentity,
    preset: ANDROID_TOOLCHAIN_PRESETS[request.variant],
    ...(request.signal ? { signal: request.signal } : {}),
  });
  const requestedRepairLimit = request.maxRepairAttempts ?? 1;
  const repairLimit = Number.isFinite(requestedRepairLimit)
    ? Math.min(MAX_REPAIR_ATTEMPTS, Math.max(0, Math.floor(requestedRepairLimit)))
    : 1;

  if (!adapter.readIdentity) return fail("manifest-validation", "ADAPTER_MISSING:readIdentity", 0, 0, events);
  if (!adapter.validateManifest) return fail("manifest-validation", "ADAPTER_MISSING:validateManifest", 0, 0, events);
  const identityMatches = async (): Promise<boolean> => {
    try {
      const observed = await adapter.readIdentity!(context);
      return identityIsValid(observed) && stableIdentity(observed) === stableIdentity(expectedIdentity);
    } catch {
      return false;
    }
  };

  if (request.signal?.aborted) return fail("manifest-validation", "ABORTED", 0, 0, events);
  if (!(await identityMatches())) return fail("manifest-validation", request.signal?.aborted ? "ABORTED" : "PROJECT_IDENTITY_MISMATCH", 0, 0, events);
  let manifest: AndroidManifestValidation;
  try {
    manifest = await adapter.validateManifest(context);
  } catch {
    return fail("manifest-validation", request.signal?.aborted ? "ABORTED" : "MANIFEST_VALIDATION_ERROR", 0, 0, events);
  }
  if (request.signal?.aborted) return fail("manifest-validation", "ABORTED", 0, 0, events);
  if (!manifest?.valid || !identityIsValid(manifest.identity) || stableIdentity(manifest.identity) !== stableIdentity(expectedIdentity)) {
    return fail("manifest-validation", "ANDROID_MANIFEST_INVALID_OR_IDENTITY_MISMATCH", 0, 0, events);
  }
  if (!(await identityMatches())) return fail("manifest-validation", request.signal?.aborted ? "ABORTED" : "PROJECT_IDENTITY_CHANGED", 0, 0, events);
  events.push({ stage: "manifest-validation", ok: true });

  if (!adapter.build) return fail("build", "ADAPTER_MISSING:build", 0, 0, events);
  let build: AndroidBuildResult | undefined;
  while (true) {
    buildAttempts += 1;
    try {
      build = await adapter.build(context);
    } catch {
      build = { ok: false, failureCode: "BUILD_ADAPTER_ERROR" };
    }
    if (request.signal?.aborted) return fail("build", "ABORTED", buildAttempts, repairAttempts, events);
    if (!(await identityMatches())) return fail("build", request.signal?.aborted ? "ABORTED" : "PROJECT_IDENTITY_CHANGED", buildAttempts, repairAttempts, events);
    if (build?.ok) {
      if (!build.artifactPath) return fail("build", "BUILD_ARTIFACT_PATH_MISSING", buildAttempts, repairAttempts, events);
      const buildArtifactPath = canonicalAbsolutePath(build.artifactPath);
      if (!buildArtifactPath || !artifactIsWithinProject(root, buildArtifactPath)) return fail("build", "BUILD_ARTIFACT_OUTSIDE_PROJECT", buildAttempts, repairAttempts, events);
      break;
    }
    const failureCode = typeof build?.failureCode === "string" && build.failureCode ? build.failureCode : "BUILD_FAILED";
    events.push({ stage: "build", ok: false, detail: failureCode });
    // Fail closed until every transaction stage is implemented and fault-tested by a trusted host.
    if (repairLimit === 0) return fail(
      "repair",
      "AUTOMATIC_REPAIR_UNAVAILABLE_SAFE_HOST",
      buildAttempts,
      repairAttempts,
      events,
      "Safe offline repair is unavailable: AndroidToolchainProductionHost lacks isolated worktree/temp-patch staging, a changed-file allowlist plus protected-file denylist, secret/policy validation, project-test and offline-build gates, and path-scoped atomic compare-and-swap apply/revert with concurrent-change detection. The app exposes no trusted adapter for these steps; repair remains disabled.",
    );
    if (repairAttempts >= repairLimit) return fail("build", "BUILD_FAILED_REPAIR_LIMIT_REACHED", buildAttempts, repairAttempts, events);
    if (!adapter.repair) return fail("repair", "ADAPTER_MISSING:repair", buildAttempts, repairAttempts, events);
    repairAttempts += 1;
    try {
      await adapter.repair(context, { attempt: repairAttempts, maxAttempts: repairLimit, failureCode });
    } catch {
      return fail("repair", request.signal?.aborted ? "ABORTED" : "REPAIR_ADAPTER_ERROR", buildAttempts, repairAttempts, events);
    }
    if (request.signal?.aborted) return fail("repair", "ABORTED", buildAttempts, repairAttempts, events);
    if (!(await identityMatches())) return fail("repair", request.signal?.aborted ? "ABORTED" : "PROJECT_IDENTITY_CHANGED", buildAttempts, repairAttempts, events);
    events.push({ stage: "repair", ok: true, detail: `attempt ${repairAttempts}/${repairLimit}` });
  }
  events.push({ stage: "build", ok: true });

  if (!adapter.verifyArtifact) return fail("artifact-verification", "ADAPTER_MISSING:verifyArtifact", buildAttempts, repairAttempts, events);
  const verify = async (stage: "artifact-verification" | "signed-artifact-verification", artifactPath: string): Promise<AndroidArtifactVerification | AndroidToolchainResult> => {
    if (request.signal?.aborted) return fail(stage, "ABORTED", buildAttempts, repairAttempts, events);
    let result: AndroidArtifactVerification;
    try {
      result = await adapter.verifyArtifact!(context, artifactPath);
    } catch {
      return fail(stage, request.signal?.aborted ? "ABORTED" : "ARTIFACT_VERIFIER_ERROR", buildAttempts, repairAttempts, events);
    }
    if (request.signal?.aborted) return fail(stage, "ABORTED", buildAttempts, repairAttempts, events);
    const verifiedPath = canonicalAbsolutePath(result?.artifactPath ?? "");
    if (!result?.verified || !result.regularFile || !verifiedPath || !artifactIsWithinProject(root, verifiedPath) || verifiedPath !== artifactPath || !HASH_RE.test(result.sha256) || result.applicationId !== expectedIdentity.applicationId) {
      return fail(stage, "ARTIFACT_VERIFICATION_FAILED", buildAttempts, repairAttempts, events);
    }
    events.push({ stage, ok: true });
    return result;
  };
  const builtArtifactPath = canonicalAbsolutePath(build!.artifactPath!);
  const verifiedBuild = await verify("artifact-verification", builtArtifactPath!);
  if ("ok" in verifiedBuild) return verifiedBuild;
  if (request.signal?.aborted) return fail("signing", "ABORTED", buildAttempts, repairAttempts, events);

  if (!adapter.sign) return fail("signing", "ADAPTER_MISSING:sign", buildAttempts, repairAttempts, events);
  let signed: AndroidSigningResult;
  try {
    signed = await adapter.sign(context, verifiedBuild);
  } catch {
    return fail("signing", request.signal?.aborted ? "ABORTED" : "SIGNING_ADAPTER_ERROR", buildAttempts, repairAttempts, events);
  }
  if (request.signal?.aborted) return fail("signing", "ABORTED", buildAttempts, repairAttempts, events);
  if (!signed?.ok) return fail("signing", signed?.failureCode || "SIGNING_FAILED", buildAttempts, repairAttempts, events);
  const signedPath = canonicalAbsolutePath(signed.artifactPath ?? "");
  if (!signedPath || !artifactIsWithinProject(root, signedPath)) return fail("signing", "SIGNED_ARTIFACT_OUTSIDE_PROJECT", buildAttempts, repairAttempts, events);
  if (!(await identityMatches())) return fail("signing", request.signal?.aborted ? "ABORTED" : "PROJECT_IDENTITY_CHANGED", buildAttempts, repairAttempts, events);
  events.push({ stage: "signing", ok: true });

  const verifiedSigned = await verify("signed-artifact-verification", signedPath);
  if ("ok" in verifiedSigned) return verifiedSigned;

  if (request.install) {
    if (request.signal?.aborted) return fail("install", "ABORTED", buildAttempts, repairAttempts, events);
    if (request.installPermission !== true || request.installConsent !== true) {
      return fail("install", "INSTALL_REQUIRES_EXPLICIT_PERMISSION_AND_CONSENT", buildAttempts, repairAttempts, events);
    }
    if (!adapter.install) return fail("install", "ADAPTER_MISSING:install", buildAttempts, repairAttempts, events);
    let installed: AndroidInstallResult;
    try {
      installed = await adapter.install(context, verifiedSigned);
    } catch {
      return fail("install", request.signal?.aborted ? "ABORTED_INSTALL_OUTCOME_UNKNOWN" : "INSTALL_ADAPTER_ERROR", buildAttempts, repairAttempts, events);
    }
    if (request.signal?.aborted) return fail("install", "ABORTED_INSTALL_OUTCOME_UNKNOWN", buildAttempts, repairAttempts, events);
    if (!installed?.ok || installed.installedApplicationId !== expectedIdentity.applicationId) {
      return fail("install", installed?.failureCode || "INSTALL_FAILED_OR_IDENTITY_MISMATCH", buildAttempts, repairAttempts, events);
    }
    if (!(await identityMatches())) return fail("install", request.signal?.aborted ? "ABORTED_INSTALL_OUTCOME_UNKNOWN" : "PROJECT_IDENTITY_CHANGED", buildAttempts, repairAttempts, events);
    events.push({ stage: "install", ok: true });
  }

  events.push({ stage: "complete", ok: true });
  return {
    ok: true,
    stage: "complete",
    buildAttempts,
    repairAttempts,
    artifactPath: signedPath,
    events: [...events],
  };
}
