import type { RuntimeFacade } from "../core/RuntimeFacade";
import { generateDeviceTestSuite } from "../core/device/DeviceTestPlanner";
import { DeviceEvidenceStore } from "../core/device/DeviceEvidenceStore";
import { runDeviceTestSuite, type DeviceTestSuiteRun } from "../core/device/DeviceTestRunner";
import { runAssembleDebug, type BuildAttemptResult } from "./build-loop";

export type ReleaseGateOptions = {
  runtime: RuntimeFacade;
  projectPath: string;
  projectId: string;
  goal: string;
  packageName?: string;
  requireDeviceRegression?: boolean;
  maxActionsPerCase?: number;
};

export type ReleaseGateCheck = {
  id: string;
  status: "passed" | "failed" | "blocked";
  detail: string;
};

export type ReleaseGateResult = {
  releaseAllowed: boolean;
  artifact?: string;
  build: BuildAttemptResult;
  checks: ReleaseGateCheck[];
  regression?: DeviceTestSuiteRun;
};

/**
 * Final release barrier. An APK is releasable only when the real build/signing
 * succeeds and, when requested, the deterministic on-device regression suite passes.
 * The gate never turns model output into a PASS and never mutates source code.
 */
export async function runReleaseGate(options: ReleaseGateOptions): Promise<ReleaseGateResult> {
  const checks: ReleaseGateCheck[] = [];
  const build = await runAssembleDebug(options.projectPath);
  const signedOk =
    build.signing?.success === true &&
    !/UNSIGNED_APK_OK/i.test(build.signing?.message || "") &&
    (/SIGNED_V1_V2_V3_OK/i.test(build.signing?.message || "") ||
      /V1 \+ V2 \+ V3/i.test(build.signing?.message || "") ||
      // fully signed path preferred for release
      /-signed\.apk$/i.test(build.apkHint || ""));
  const buildPassed = build.success && !!build.apkHint && signedOk;
  checks.push({
    id: "build_and_sign",
    status: buildPassed ? "passed" : "failed",
    detail: buildPassed
      ? `APK signed+verified: ${build.apkHint}`
      : build.errors.map(e => e.message).slice(-4).join(" | ") ||
        (/UNSIGNED_APK_OK/i.test(build.signing?.message || "")
          ? "UNSIGNED_APK_NOT_RELEASABLE"
          : "BUILD_OR_SIGNING_FAILED"),
  });

  if (!buildPassed) return { releaseAllowed: false, build, checks };

  // Release artifact must be a real on-device path under allowed roots
  const artifact = String(build.apkHint || "");
  if (!artifact || !/\.(apk|aab)$/i.test(artifact) || !artifact.startsWith("/")) {
    checks.push({ id: "artifact_path", status: "failed", detail: "APK_PATH_INVALID" });
    return { releaseAllowed: false, build, checks };
  }

  const deviceRequired = options.requireDeviceRegression !== false;
  if (!deviceRequired) {
    checks.push({ id: "device_regression", status: "blocked", detail: "Device regression explicitly disabled" });
    return { releaseAllowed: true, artifact: build.apkHint, build, checks };
  }

  const available = await options.runtime.device.isAvailable();
  if (!available) {
    checks.push({ id: "device_regression", status: "blocked", detail: "ADB/device unavailable; release gate requires device regression" });
    return { releaseAllowed: false, build, checks };
  }

  const suite = await generateDeviceTestSuite(options.goal, options.packageName);
  const evidence = new DeviceEvidenceStore(options.projectPath, `release-gate-${Date.now()}`);
  const regression = await runDeviceTestSuite(options.runtime.device, {
    apkPath: build.apkHint!,
    packageName: options.packageName,
    suite,
    evidence,
    maxActionsPerCase: Math.min(20, Math.max(1, options.maxActionsPerCase ?? 12)),
  });
  const passed = regression.report.status === "passed" && regression.report.totals.cases > 0;
  checks.push({
    id: "device_regression",
    status: passed ? "passed" : "failed",
    detail: `${regression.report.totals.passed}/${regression.report.totals.cases} cases passed; evidence=${regression.report.evidenceRoot}`,
  });

  const releaseAllowed = buildPassed && passed;
  checks.push({
    id: "release_decision",
    status: releaseAllowed ? "passed" : "failed",
    detail: releaseAllowed ? "RELEASE_ALLOWED" : "RELEASE_BLOCKED",
  });
  return { releaseAllowed, artifact: releaseAllowed ? build.apkHint : undefined, build, checks, regression };
}
