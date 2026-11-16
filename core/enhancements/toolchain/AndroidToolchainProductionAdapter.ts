import type {
  AndroidAppIdentity,
  AndroidArtifactVerification,
  AndroidBuildResult,
  AndroidCoordinatorContext,
  AndroidInstallResult,
  AndroidManifestValidation,
  AndroidSigningResult,
  AndroidToolchainAdapter,
} from "./AndroidToolchainCoordinator";

/** Runtime-owned operations. The model receives results, never these host capabilities or signing material. */
export type AndroidToolchainProductionHost = Readonly<{
  resolvePath(path: string): Promise<string>;
  exists(path: string): Promise<boolean>;
  readText(path: string): Promise<string>;
  build(context: AndroidCoordinatorContext): Promise<AndroidBuildResult>;
  sign(context: AndroidCoordinatorContext, artifact: AndroidArtifactVerification): Promise<AndroidSigningResult>;
  verify(context: AndroidCoordinatorContext, artifactPath: string, requireV123: boolean): Promise<AndroidArtifactVerification>;
  install(context: AndroidCoordinatorContext, artifact: AndroidArtifactVerification): Promise<AndroidInstallResult>;
}>;

const APP_ID_RE = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/;
const HASH_RE = /^[a-f0-9]{64}$/i;

/**
 * Create the production-stage adapter used by RuntimeFacade. It reads a small,
 * static identity snapshot, validates it again before the build, and keeps the
 * signing implementation private inside the host. No generic shell or network
 * method is exposed to the Offline Agent.
 */
export function createAndroidToolchainProductionAdapter(host: AndroidToolchainProductionHost): AndroidToolchainAdapter {
  const signedArtifacts = new Set<string>();

  const readIdentity = async (context: AndroidCoordinatorContext): Promise<AndroidAppIdentity> => {
    const root = await host.resolvePath(context.projectRoot);
    if (root !== context.projectRoot) throw new Error("PROJECT_ROOT_NOT_CANONICAL");
    return readAndroidProjectIdentity(root, host);
  };

  return Object.freeze({
    readIdentity,
    validateManifest: async (context): Promise<AndroidManifestValidation> => {
      const identity = await readIdentity(context);
      const gradleFiles = await Promise.all([
        host.exists(`${context.projectRoot}/gradlew`),
        host.exists(`${context.projectRoot}/app/build.gradle`),
        host.exists(`${context.projectRoot}/app/build.gradle.kts`),
      ]);
      const errors: string[] = [];
      if (!gradleFiles[0]) errors.push("GRADLE_WRAPPER_MISSING");
      if (!gradleFiles[1] && !gradleFiles[2]) errors.push("ANDROID_APP_GRADLE_MANIFEST_MISSING");
      if (!APP_ID_RE.test(identity.applicationId) || !identity.appName.trim() || !identity.slug.trim()) errors.push("ANDROID_IDENTITY_INVALID");
      if (stableIdentity(identity) !== stableIdentity(context.expectedIdentity)) errors.push("ANDROID_IDENTITY_CHANGED");
      return Object.freeze({ valid: errors.length === 0, errors: Object.freeze(errors), identity });
    },
    build: (context) => host.build(context),
    verifyArtifact: async (context, artifactPath): Promise<AndroidArtifactVerification> => {
      const result = await host.verify(context, artifactPath, signedArtifacts.has(artifactPath));
      if (!result.verified || !result.regularFile || result.artifactPath !== artifactPath ||
          !HASH_RE.test(result.sha256) || result.applicationId !== context.expectedIdentity.applicationId) {
        return Object.freeze({ ...result, verified: false, errors: Object.freeze([...result.errors, "PRODUCTION_ARTIFACT_CHECK_FAILED"]) });
      }
      return result;
    },
    sign: async (context, artifact): Promise<AndroidSigningResult> => {
      const result = await host.sign(context, artifact);
      if (result.ok && result.artifactPath) signedArtifacts.add(result.artifactPath);
      return result;
    },
    install: (context, artifact) => host.install(context, artifact),
  });
}

/** Read identity only from JSON and literal config values; never evaluate project code. */
export async function readAndroidProjectIdentity(
  root: string,
  host: AndroidToolchainProductionHost,
): Promise<AndroidAppIdentity> {
  const [identityText, appJsonText, packageText, appConfigText, gradleText, gradleKtsText] = await Promise.all([
    readOptional(host, `${root}/AI_BUILDER_ANDROID_IDENTITY.json`),
    readOptional(host, `${root}/app.json`),
    readOptional(host, `${root}/package.json`),
    readOptional(host, `${root}/app.config.ts`),
    readOptional(host, `${root}/app/build.gradle`),
    readOptional(host, `${root}/app/build.gradle.kts`),
  ]);
  const identityFile = parseJson(identityText);
  const appFile = parseJson(appJsonText);
  const expo = record(appFile?.expo) ?? appFile ?? {};
  const android = record(expo.android) ?? {};
  const pkg = parseJson(packageText) ?? {};
  const config = appConfigText ?? "";
  const gradle = gradleText ?? gradleKtsText ?? "";

  const applicationId = firstString(
    identityFile?.applicationId,
    android.package,
    staticLiteral(config, "package"),
    gradleLiteral(gradle, "applicationId"),
  );
  const appName = firstString(expo.name, staticLiteral(config, "name"));
  const slug = firstString(expo.slug, staticLiteral(config, "slug"));
  const appVersionConstant = config.match(/\bconst\s+APP_VERSION\s*=\s*(["'])([^"']+)\1/)?.[2];
  const version = firstString(expo.version, staticLiteral(config, "version"), appVersionConstant, pkg.version);
  if (!applicationId || !APP_ID_RE.test(applicationId) || !appName || !slug || !version) {
    throw new Error("ANDROID_STATIC_IDENTITY_UNAVAILABLE");
  }

  const settings: Record<string, string> = {
    "app.version": version,
    "package.version": typeof pkg.version === "string" ? pkg.version : version,
    "android.applicationId": applicationId,
    "source.identity.json": identityText ?? "",
    "source.app.json": appJsonText ?? "",
    "source.app.config.ts": appConfigText ?? "",
    "source.package.json": packageText ?? "",
    "source.android.gradle": gradle,
  };
  for (const [key, value] of Object.entries({
    versionCode: firstString(android.versionCode, gradleLiteral(gradle, "versionCode")),
    versionName: firstString(android.versionName, gradleLiteral(gradle, "versionName")),
    minSdkVersion: firstString(android.minSdkVersion, gradleLiteral(gradle, "minSdkVersion"), gradleLiteral(gradle, "minSdk")),
    targetSdkVersion: firstString(android.targetSdkVersion, gradleLiteral(gradle, "targetSdkVersion"), gradleLiteral(gradle, "targetSdk")),
    compileSdkVersion: firstString(android.compileSdkVersion, gradleLiteral(gradle, "compileSdkVersion"), gradleLiteral(gradle, "compileSdk")),
    namespace: firstString(identityFile?.namespace, gradleLiteral(gradle, "namespace")),
  })) {
    if (value !== undefined) settings[`android.${key}`] = value;
  }

  return Object.freeze({
    applicationId,
    appName,
    slug,
    buildSettings: Object.freeze(settings),
  });
}

async function readOptional(host: AndroidToolchainProductionHost, path: string): Promise<string | null> {
  if (!(await host.exists(path))) return null;
  return host.readText(path);
}

function parseJson(text: string | null): Record<string, unknown> | null {
  if (text === null) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return record(parsed);
  } catch {
    return null;
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) if (typeof value === "string" && value.trim()) return value.trim();
  for (const value of values) if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function staticLiteral(source: string, property: string): string | undefined {
  const pattern = new RegExp(`(?:^|[,{\\n])\\s*${escapeRegExp(property)}\\s*:\\s*([\"'])([^\\r\\n]*?)\\1`, "m");
  return pattern.exec(source)?.[2]?.trim();
}

function gradleLiteral(source: string, property: string): string | undefined {
  const pattern = new RegExp(`\\b${escapeRegExp(property)}\\s*(?:=|\\s)\\s*([\"'])([^\"']+)\\1|\\b${escapeRegExp(property)}\\s*(?:=|\\s)\\s*(\\d+)`);
  const match = pattern.exec(source);
  return match?.[2] ?? match?.[3];
}

function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

function stableIdentity(identity: AndroidAppIdentity): string {
  return JSON.stringify({
    applicationId: identity.applicationId,
    appName: identity.appName,
    slug: identity.slug,
    buildSettings: Object.fromEntries(Object.entries(identity.buildSettings).sort(([a], [b]) => a.localeCompare(b))),
  });
}
