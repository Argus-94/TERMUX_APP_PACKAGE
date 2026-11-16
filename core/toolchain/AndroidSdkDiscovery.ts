/**
 * Read-only Android SDK discovery.
 *
 * Locates an existing SDK under common locations or AIBuilderTermux HOME/sdk.
 * Never writes local.properties, never changes project compileSdk/targetSdk.
 */

import type { ToolchainManifest } from "./ToolchainManifest";
import { createToolchainManifest } from "./ToolchainManifest";

export type PathProbe = {
  exists: (path: string) => Promise<boolean> | boolean;
  isDirectory?: (path: string) => Promise<boolean> | boolean;
  isFile?: (path: string) => Promise<boolean> | boolean;
  isNonEmptyFile?: (path: string) => Promise<boolean> | boolean;
  isExecutable?: (path: string) => Promise<boolean> | boolean;
  listDirectories?: (path: string) => Promise<string[]> | string[];
  readText?: (path: string) => Promise<string> | string;
};

const COMMON_SDK_CANDIDATES = [
  "/data/data/com.karat.aibuilder/files/home/android-sdk",
  "/data/data/com.karat.aibuilder/files/usr/opt/android-sdk",
  "/usr/lib/android-sdk",
];

async function safeExists(probe: PathProbe, path: string): Promise<boolean> {
  try { return await probe.exists(path); } catch { return false; }
}

async function safeIsDirectory(probe: PathProbe, path: string): Promise<boolean> {
  if (!probe.isDirectory) return false;
  try { return await probe.isDirectory(path); } catch { return false; }
}

async function safeIsFile(probe: PathProbe, path: string): Promise<boolean> {
  if (!probe.isFile) return false;
  try { return await probe.isFile(path); } catch { return false; }
}

async function safeIsNonEmptyFile(probe: PathProbe, path: string): Promise<boolean> {
  if (!probe.isNonEmptyFile) return false;
  try { return await probe.isNonEmptyFile(path); } catch { return false; }
}

async function safeIsExecutable(probe: PathProbe, path: string): Promise<boolean> {
  if (!probe.isExecutable) return false;
  try { return await probe.isExecutable(path); } catch { return false; }
}

async function safeIsExecutableFile(probe: PathProbe, path: string): Promise<boolean> {
  return (await safeIsFile(probe, path))
    && (await safeIsNonEmptyFile(probe, path))
    && (await safeIsExecutable(probe, path));
}

async function safeListDirectories(probe: PathProbe, path: string): Promise<string[]> {
  if (!probe.listDirectories) return [];
  try { return (await probe.listDirectories(path)).filter((name) => !!name && !name.includes("/") && name !== "." && name !== ".."); }
  catch { return []; }
}

export async function discoverAndroidSdk(
  probe: PathProbe,
  options?: {
    homeSdkPath?: string;
    extraCandidates?: string[];
  },
): Promise<ToolchainManifest[]> {
  const candidates = [
    ...(options?.homeSdkPath ? [options.homeSdkPath] : []),
    ...(options?.extraCandidates ?? []),
    ...COMMON_SDK_CANDIDATES,
  ];

  const results: ToolchainManifest[] = [];
  const seen = new Set<string>();

  for (const candidate of candidates) {
    if (/\/data\/(?:data|user(?:_de)?\/\d+)\/(?!com\.karat\.aibuilder(?:\/|$))[A-Za-z0-9_.]+/.test(candidate)) continue;
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    if (!(await safeExists(probe, candidate)) || !(await safeIsDirectory(probe, candidate))) continue;

    const root = candidate.replace(/\/+$/, "");
    const adbPath = `${root}/platform-tools/adb`;
    const hasAdb = await safeExists(probe, adbPath);
    const adbExecutable = await safeIsExecutableFile(probe, adbPath);

    const platformNames = await safeListDirectories(probe, `${root}/platforms`);
    let hasPlatformJar = false;
    for (const name of platformNames) {
      if (!/^android-\d+$/.test(name)) continue;
      const androidJar = `${root}/platforms/${name}/android.jar`;
      if (await safeIsFile(probe, androidJar) && await safeIsNonEmptyFile(probe, androidJar)) {
        hasPlatformJar = true;
        break;
      }
    }

    const buildToolNames = await safeListDirectories(probe, `${root}/build-tools`);
    let hasUsableBuildTools = false;
    for (const name of buildToolNames) {
      if (!/^\d+(?:\.\d+){1,3}$/.test(name)) continue;
      const toolRoot = `${root}/build-tools/${name}`;
      const [aapt2, zipalign, d8, dx] = await Promise.all([
        safeIsExecutableFile(probe, `${toolRoot}/aapt2`),
        safeIsExecutableFile(probe, `${toolRoot}/zipalign`),
        safeIsExecutableFile(probe, `${toolRoot}/d8`),
        safeIsExecutableFile(probe, `${toolRoot}/dx`),
      ]);
      if (aapt2 && zipalign && (d8 || dx)) {
        hasUsableBuildTools = true;
        break;
      }
    }

    const cmdlineVersions = await safeListDirectories(probe, `${root}/cmdline-tools`);
    let hasSdkManager = await safeIsExecutableFile(probe, `${root}/cmdline-tools/latest/bin/sdkmanager`)
      || await safeIsExecutableFile(probe, `${root}/tools/bin/sdkmanager`);
    if (!hasSdkManager) {
      for (const name of cmdlineVersions) {
        if (await safeIsExecutableFile(probe, `${root}/cmdline-tools/${name}/bin/sdkmanager`)) {
          hasSdkManager = true;
          break;
        }
      }
    }

    let version: string | undefined;
    let sdkBaseDescriptor = false;
    const sourcePropertiesPath = `${root}/source.properties`;
    if (probe.readText && await safeIsFile(probe, sourcePropertiesPath)) {
      try {
        const sourceProps = await probe.readText(sourcePropertiesPath);
        const match = /^Pkg\.Revision\s*=\s*([^\r\n]+)$/im.exec(sourceProps);
        if (match) version = match[1].trim();
        sdkBaseDescriptor = /^Pkg\.Desc\s*=\s*Android SDK Base\s*$/im.test(sourceProps);
      } catch {
        // A missing or unreadable source.properties file is not SDK proof.
      }
    }

    // Do not treat an existing path or empty SDK-shaped directories as healthy.
    // Keep recognizable but incomplete installations as degraded for diagnostics.
    const evidence = [
      sdkBaseDescriptor && "sdk-base",
      hasAdb && "platform-tools/adb",
      hasSdkManager && "sdkmanager",
      hasPlatformJar && "platform/android.jar",
      hasUsableBuildTools && "build-tools/aapt2+d8+zipalign",
    ].filter(Boolean).join(",");
    if (!evidence) continue;

    const completeLayout = sdkBaseDescriptor && adbExecutable && hasPlatformJar && hasUsableBuildTools;
    results.push(
      createToolchainManifest({
        id: `android-sdk:${candidate}`,
        kind: "android-sdk",
        name: "Android SDK",
        path: candidate,
        home: candidate,
        version,
        health: completeLayout ? "healthy" : "degraded",
        metadata: { discovery: "read-only", evidence },
      }),
    );
  }

  return results;
}
