/**
 * Builds proot-oriented launch command lines from ContainerShellSpec.
 * Does not execute; backends consume the string when proot is available.
 * Runtime-only; projects stay on host under AIBuilderTermux HOME.
 */

import type { ContainerShellSpec } from "./ContainerShell";
import { DUMMY_PROXY_API_KEY } from "../enhancements/auth/CredentialProxy";
import type { ProxyClientConfiguration } from "../enhancements/auth/types";
import { buildHardenedProotOptions, type HardenedProotPolicy } from "../enhancements/isolation/HardenedProotOptions";

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export type ProotCommandErrorCode = "PROXY_CLIENT_CONFIGURATION_INVALID" | "PROOT_BIND_INVALID" | "PROOT_ENV_INVALID" | "BACKEND_ENV_INVALID";
/** Typed failure raised when a command cannot be built without weakening its safety checks. */
export class ProotCommandError extends Error { constructor(readonly code: ProotCommandErrorCode) { super(code); this.name = "ProotCommandError"; } }

function isCredentialEnvironmentName(name: string): boolean {
  const normalized = name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[\s-]+/g, "_").toUpperCase();
  const segments = normalized.split(/[^A-Z0-9]+/).filter(Boolean);
  if (segments.some((segment) => /^(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD|CREDENTIALS?|AUTH(?:ORIZATION)?)$/.test(segment))) return true;
  return /(?:API|ACCESS|PRIVATE|CLIENT)?_?KEY$/.test(normalized);
}

/** Remove secret-bearing environment entries before any userspace/proot launch. */
export function buildProxySafeEnvironment(input: Readonly<Record<string, string>>, proxy?: ProxyClientConfiguration): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!isCredentialEnvironmentName(key) && !/(?:^|_)(?:OPENAI|OPENROUTER|ANTHROPIC|AIB_LLM)_BASE_URL$/i.test(key)) safe[key] = value;
  }
  if (proxy) {
    let url: URL;
    try { url = new URL(proxy.baseUrl); } catch { throw new ProotCommandError("PROXY_CLIENT_CONFIGURATION_INVALID"); }
    if (proxy.apiKey !== DUMMY_PROXY_API_KEY || !/^[A-Za-z0-9_-]{1,128}$/.test(proxy.sessionId) || url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.username || url.password || url.search || url.hash || url.pathname !== `/v1/session/${proxy.sessionId}`) throw new ProotCommandError("PROXY_CLIENT_CONFIGURATION_INVALID");
    safe.AIB_LLM_BASE_URL = proxy.baseUrl;
    safe.OPENAI_BASE_URL = proxy.baseUrl;
    safe.OPENROUTER_BASE_URL = proxy.baseUrl;
    safe.AIB_LLM_API_KEY = DUMMY_PROXY_API_KEY;
    for (const alias of ["OPENAI_API_KEY", "OPENROUTER_API_KEY"]) {
      safe[alias] = DUMMY_PROXY_API_KEY;
    }
  }
  return safe;
}

export type ProotLaunchPlan = {
  /** Full shell command suitable for Termux/proot wrapper */
  command: string;
  /** Environment to export before launch */
  env: Record<string, string>;
  /** Host path that must remain mounted (project) */
  projectRoot: string;
  profile: ContainerShellSpec["profile"];
  instanceId: string;
  hardening: ReturnType<typeof buildHardenedProotOptions>;
};

/**
 * Construct a conservative proot launch plan.
 * When rootfs is not present, command is a no-op diagnostic echo.
 */
export function buildProotLaunchPlan(
  spec: ContainerShellSpec,
  options?: {
    rootfsPath?: string;
    prootBinary?: string;
    extraBinds?: Array<{ host: string; guest: string }>;
    credentialProxy?: ProxyClientConfiguration;
    hardening?: HardenedProotPolicy;
  },
): ProotLaunchPlan {
  const proot = options?.prootBinary ?? "proot";
  const rootfs = options?.rootfsPath;
  const safeEnv = buildProxySafeEnvironment(spec.env, options?.credentialProxy);
  const hardening = buildHardenedProotOptions(spec.shellCommand, options?.hardening);
  const binds = [
    { host: spec.projectRoot, guest: "/workspace" },
    ...(options?.extraBinds ?? []),
  ];

  if (!rootfs) {
    return {
      command: `echo "AIB_PROOT_ROOTFS_MISSING profile=${spec.profile} instance=${spec.instanceId}"`,
      env: safeEnv,
      projectRoot: spec.projectRoot,
      profile: spec.profile,
      instanceId: spec.instanceId,
      hardening,
    };
  }

  for (const bind of binds) {
    if (!bind.host.startsWith("/") || bind.host.includes("\0") || !bind.guest.startsWith("/") || bind.guest.includes(":")) {
      throw new ProotCommandError("PROOT_BIND_INVALID");
    }
  }
  const bindArgs = binds
    .map((b) => `-b ${shellQuote(`${b.host}:${b.guest}`)}`)
    .join(" ");
  const envExports = Object.entries(safeEnv)
    .map(([k, v]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || String(v).includes("\0")) throw new ProotCommandError("PROOT_ENV_INVALID");
      return `${k}=${shellQuote(String(v))}`;
    })
    .join(" ");

  const command = [
    envExports,
    shellQuote(proot),
    "-0",
    `-r ${shellQuote(rootfs)}`,
    bindArgs,
    `-w ${shellQuote(spec.containerCwd)}`,
    "--",
    hardening.shellCommand,
  ]
    .filter(Boolean)
    .join(" ");

  return {
    command,
    env: safeEnv,
    projectRoot: spec.projectRoot,
    profile: spec.profile,
    instanceId: spec.instanceId,
    hardening,
  };
}
