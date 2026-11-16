import type { RuntimeFacade } from "../core/RuntimeFacade";
import type { ReleaseGateResult } from "./release-gate";

export type ReleaseArtifactManagerOptions = {
  runtime: RuntimeFacade;
  projectPath: string;
  projectId: string;
  version: string;
  releaseName?: string;
  gate: ReleaseGateResult;
};

export type ReleaseArtifactResult = {
  created: boolean;
  releaseId: string;
  bundleDir?: string;
  bundleZip?: string;
  bundleArchive?: string;
  apkPath?: string;
  manifestPath?: string;
  reportPath?: string;
  sha256?: string;
  message: string;
};

function shellQuote(value: string): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function safeReleaseId(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned.slice(0, 80) || `release-${Date.now()}`;
}

async function exec(runtime: RuntimeFacade, command: string, cwd?: string) {
  const result = await runtime.environment.exec(command, { cwd });
  const r = result as { exitCode?: number; stdout?: string; stderr?: string };
  return { exitCode: r?.exitCode ?? 0, stdout: r?.stdout ?? "", stderr: r?.stderr ?? "" };
}

/**
 * Turns a passed Release Gate result into an immutable, self-describing release bundle.
 * It never creates an artifact when the gate is blocked and never rebuilds source code.
 */
export async function createReleaseArtifact(options: ReleaseArtifactManagerOptions): Promise<ReleaseArtifactResult> {
  const releaseId = safeReleaseId(options.releaseName || `v${options.version}-${Date.now()}`);
  if (!options.gate.releaseAllowed || !options.gate.artifact) {
    return { created: false, releaseId, message: "RELEASE_GATE_NOT_PASSED" };
  }

  const apk = options.gate.artifact;
  const bundleRoot = `${options.projectPath}/artifacts/releases/${releaseId}`;
  const apkName = `AIBuilder-${options.version}.apk`;
  const manifestPath = `${bundleRoot}/release-manifest.json`;
  const reportPath = `${bundleRoot}/qa-report.json`;
  const copiedApk = `${bundleRoot}/${apkName}`;
  const zipPath = `${options.projectPath}/artifacts/releases/${releaseId}.zip`;
  const tarPath = `${options.projectPath}/artifacts/releases/${releaseId}.tar.gz`;

  const payload = {
    schema: 1,
    product: "AI Builder",
    projectId: options.projectId,
    version: options.version,
    releaseId,
    createdAt: new Date().toISOString(),
    gate: {
      releaseAllowed: options.gate.releaseAllowed,
      checks: options.gate.checks,
    },
    artifact: apkName,
    regression: options.gate.regression?.report ?? null,
  };
  const payloadText = JSON.stringify(payload, null, 2);
  const report = options.gate.regression?.report ?? { status: "not-run", totals: {}, evidenceRoot: null };
  const reportText = JSON.stringify(report, null, 2);

  const cmd = [
    "set -e",
    `mkdir -p ${shellQuote(bundleRoot)}`,
    `[ -f ${shellQuote(apk)} ] || { echo APK_NOT_FOUND >&2; exit 40; }`,
    `cp -f ${shellQuote(apk)} ${shellQuote(copiedApk)}`,
    `printf '%s\n' ${shellQuote(payloadText)} > ${shellQuote(manifestPath)}`,
    `printf '%s\n' ${shellQuote(reportText)} > ${shellQuote(reportPath)}`,
    `sha256sum ${shellQuote(copiedApk)} | awk '{print $1}' > ${shellQuote(bundleRoot + "/SHA256SUM.txt")}`,
    `printf '%s  %s\\n' "$(cat ${shellQuote(bundleRoot + "/SHA256SUM.txt")})" ${shellQuote(apkName)} > ${shellQuote(bundleRoot + "/checksums.txt")}`,
    `if command -v zip >/dev/null 2>&1; then cd ${shellQuote(bundleRoot)} && zip -q -r ${shellQuote(zipPath)} . && printf '%s\n' ${shellQuote("ARCHIVE=" + zipPath)}; else cd ${shellQuote(bundleRoot)} && tar -czf ${shellQuote(tarPath)} . && printf '%s\n' ${shellQuote("ARCHIVE=" + tarPath)}; fi`,
    `cat ${shellQuote(bundleRoot + "/SHA256SUM.txt")}`,
  ].join("; ");

  const result = await exec(options.runtime, cmd);
  if (result.exitCode !== 0) {
    return { created: false, releaseId, message: result.stderr || result.stdout || "RELEASE_BUNDLE_FAILED" };
  }

  const sha256 = result.stdout.split(/\n/).find((line) => /^[a-f0-9]{64}$/i.test(line.trim()))?.trim();
  const archive = result.stdout.split(/\n/).find((line) => line.startsWith("ARCHIVE="))?.slice("ARCHIVE=".length);
  return {
    created: true,
    releaseId,
    bundleDir: bundleRoot,
    bundleZip: archive?.endsWith(".zip") ? zipPath : undefined,
    bundleArchive: archive ? (archive.endsWith(".zip") ? zipPath : tarPath) : undefined,
    apkPath: copiedApk,
    manifestPath,
    reportPath,
    sha256,
    message: "RELEASE_BUNDLE_CREATED",
  };
}
