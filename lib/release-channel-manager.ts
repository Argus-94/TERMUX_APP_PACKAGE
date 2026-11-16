import type { RuntimeFacade } from "../core/RuntimeFacade";
import type { ReleaseArtifactResult } from "./release-artifact-manager";

export type ReleaseChannel = "debug" | "internal" | "beta" | "production";
export const RELEASE_CHANNELS: readonly ReleaseChannel[] = ["debug", "internal", "beta", "production"];

export type ReleaseChannelEntry = {
  releaseId: string;
  channel: ReleaseChannel;
  versionName: string;
  versionCode: number;
  apkPath: string;
  sha256: string;
  publishedAt: string;
  artifactBundle?: string;
};

export type ReleaseChannelState = {
  schema: 1;
  channel: ReleaseChannel;
  current?: ReleaseChannelEntry;
  history: ReleaseChannelEntry[];
};

export type PublishReleaseChannelOptions = {
  runtime: RuntimeFacade;
  projectPath: string;
  channel: ReleaseChannel;
  versionName: string;
  versionCode?: number;
  artifact: ReleaseArtifactResult;
};

export type PublishReleaseChannelResult = {
  published: boolean;
  channel: ReleaseChannel;
  entry?: ReleaseChannelEntry;
  statePath: string;
  message: string;
};

export type RollbackReleaseChannelOptions = {
  runtime: RuntimeFacade;
  projectPath: string;
  channel: ReleaseChannel;
  targetReleaseId?: string;
};

export type RollbackReleaseChannelResult = {
  rolledBack: boolean;
  channel: ReleaseChannel;
  entry?: ReleaseChannelEntry;
  message: string;
};

function shellQuote(value: string): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function validChannel(value: string): value is ReleaseChannel {
  return (RELEASE_CHANNELS as readonly string[]).includes(value);
}

function safeName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "release";
}

async function exec(runtime: RuntimeFacade, command: string, cwd?: string) {
  const result = await runtime.environment.exec(command, { cwd });
  const r = result as { exitCode?: number; stdout?: string; stderr?: string };
  return { exitCode: r?.exitCode ?? 0, stdout: r?.stdout ?? "", stderr: r?.stderr ?? "" };
}

async function readState(runtime: RuntimeFacade, path: string, channel: ReleaseChannel): Promise<ReleaseChannelState> {
  const result = await exec(runtime, `if [ -f ${shellQuote(path)} ]; then cat ${shellQuote(path)}; else printf '%s\\n' ${shellQuote(JSON.stringify({ schema: 1, channel, history: [] }))}; fi`);
  try {
    const parsed = JSON.parse(result.stdout) as ReleaseChannelState;
    if (parsed?.schema === 1 && parsed?.channel === channel && Array.isArray(parsed.history)) return parsed;
  } catch {}
  return { schema: 1, channel, history: [] };
}

function nextVersionCode(state: ReleaseChannelState, requested?: number): number {
  if (Number.isInteger(requested) && requested! > 0) return requested!;
  const max = state.history.reduce((n, x) => Math.max(n, Number.isFinite(x.versionCode) ? x.versionCode : 0), 0);
  return max + 1;
}

export async function getReleaseChannelState(runtime: RuntimeFacade, projectPath: string, channel: ReleaseChannel): Promise<ReleaseChannelState> {
  if (!validChannel(channel)) throw new Error("INVALID_RELEASE_CHANNEL");
  const statePath = `${projectPath}/artifacts/channels/${channel}/channel.json`;
  return readState(runtime, statePath, channel);
}

/** Publish only an already-created, Release-Gate-approved artifact. */
export async function publishReleaseChannel(options: PublishReleaseChannelOptions): Promise<PublishReleaseChannelResult> {
  if (!validChannel(options.channel)) throw new Error("INVALID_RELEASE_CHANNEL");
  if (!options.artifact.created || !options.artifact.apkPath || !options.artifact.sha256) {
    return { published: false, channel: options.channel, statePath: `${options.projectPath}/artifacts/channels/${options.channel}/channel.json`, message: "RELEASE_ARTIFACT_NOT_VERIFIED" };
  }

  const channelRoot = `${options.projectPath}/artifacts/channels/${options.channel}`;
  const statePath = `${channelRoot}/channel.json`;
  const state = await readState(options.runtime, statePath, options.channel);
  const versionCode = nextVersionCode(state, options.versionCode);
  const releaseId = safeName(options.artifact.releaseId);
  const destination = `${channelRoot}/${releaseId}-${safeName(options.versionName)}-${versionCode}.apk`;
  const entry: ReleaseChannelEntry = {
    releaseId,
    channel: options.channel,
    versionName: options.versionName,
    versionCode,
    apkPath: destination,
    sha256: options.artifact.sha256,
    publishedAt: new Date().toISOString(),
    artifactBundle: options.artifact.bundleArchive || options.artifact.bundleZip,
  };
  const nextState: ReleaseChannelState = { schema: 1, channel: options.channel, current: entry, history: [...state.history, entry].slice(-50) };
  const stateText = JSON.stringify(nextState, null, 2);
  const tmpState = `${statePath}.tmp-${Date.now()}`;

  const command = [
    "set -e",
    `mkdir -p ${shellQuote(channelRoot)}`,
    `[ -f ${shellQuote(options.artifact.apkPath)} ] || { echo ARTIFACT_APK_NOT_FOUND >&2; exit 41; }`,
    `cp -f ${shellQuote(options.artifact.apkPath)} ${shellQuote(destination)}`,
    `printf '%s\\n' ${shellQuote(stateText)} > ${shellQuote(tmpState)}`,
    `mv -f ${shellQuote(tmpState)} ${shellQuote(statePath)}`,
    `cp -f ${shellQuote(destination)} ${shellQuote(channelRoot + "/current.apk")}`,
  ].join("; ");
  const result = await exec(options.runtime, command);
  if (result.exitCode !== 0) return { published: false, channel: options.channel, statePath, message: result.stderr || result.stdout || "CHANNEL_PUBLISH_FAILED" };
  return { published: true, channel: options.channel, entry, statePath, message: "RELEASE_CHANNEL_PUBLISHED" };
}

/** Roll back to a previously published entry without modifying source code. */
export async function rollbackReleaseChannel(options: RollbackReleaseChannelOptions): Promise<RollbackReleaseChannelResult> {
  if (!validChannel(options.channel)) throw new Error("INVALID_RELEASE_CHANNEL");
  const channelRoot = `${options.projectPath}/artifacts/channels/${options.channel}`;
  const statePath = `${channelRoot}/channel.json`;
  const state = await readState(options.runtime, statePath, options.channel);
  if (state.history.length < 2) return { rolledBack: false, channel: options.channel, message: "NO_PREVIOUS_RELEASE" };
  const target = options.targetReleaseId
    ? state.history.find(x => x.releaseId === options.targetReleaseId)
    : state.history[state.history.length - 2];
  if (!target) return { rolledBack: false, channel: options.channel, message: "ROLLBACK_TARGET_NOT_FOUND" };
  const nextState: ReleaseChannelState = { ...state, current: target };
  const tmpState = `${statePath}.tmp-${Date.now()}`;
  const command = [
    "set -e",
    `[ -f ${shellQuote(target.apkPath)} ] || { echo ROLLBACK_APK_NOT_FOUND >&2; exit 42; }`,
    `cp -f ${shellQuote(target.apkPath)} ${shellQuote(channelRoot + "/current.apk")}`,
    `printf '%s\\n' ${shellQuote(JSON.stringify(nextState, null, 2))} > ${shellQuote(tmpState)}`,
    `mv -f ${shellQuote(tmpState)} ${shellQuote(statePath)}`,
  ].join("; ");
  const result = await exec(options.runtime, command);
  if (result.exitCode !== 0) return { rolledBack: false, channel: options.channel, message: result.stderr || result.stdout || "ROLLBACK_FAILED" };
  return { rolledBack: true, channel: options.channel, entry: target, message: "RELEASE_CHANNEL_ROLLED_BACK" };
}
