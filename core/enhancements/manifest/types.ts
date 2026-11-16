/** Declarative userspace runtime manifest schema, version 1. */
export type ManifestCapability = "terminal" | "network" | "filesystem.read" | "filesystem.write" | "web" | "build";
export type RuntimeManifest = Readonly<{
  version: 1;
  web?: Readonly<{ command: string; port?: number; health?: string }>;
  workers?: readonly Readonly<{ name: string; command: string; restart?: boolean }>[];
  build?: Readonly<{ command: string; afterTask?: boolean }>;
  health?: Readonly<{ command: string; intervalMs?: number }>;
  restartAfterTask?: boolean;
  env?: Readonly<Record<string, string>>;
  capabilities?: readonly ManifestCapability[];
}>;
export type ValidationIssue = Readonly<{ path: string; code: string; message: string }>;
export type ValidationResult = Readonly<{ ok: boolean; issues: readonly ValidationIssue[] }>;
export class ManifestError extends Error {
  constructor(readonly code: "PARSE_FAILED" | "VALIDATION_FAILED" | "POLICY_DENIED" | "APPLY_FAILED", message: string, readonly issues: readonly ValidationIssue[] = []) { super(message); this.name = "ManifestError"; }
}
export type ManifestProcess = Readonly<{ name: string; command: string; env: Readonly<Record<string, string>>; capabilities: readonly ManifestCapability[]; healthCommand?: string; healthIntervalMs: number; restart: boolean; restartAfterTask: boolean }>;
export type ManifestProcessAdapter = Readonly<{
  /** Must enforce every requested capability as well as command-specific policy. */
  authorize(command: string, name: string, capabilities: readonly ManifestCapability[]): Promise<boolean> | boolean;
  /** The adapter must avoid occupiedIds before spawning and return a unique, bounded id. */
  start(process: ManifestProcess, context?: Readonly<{ occupiedIds: readonly string[] }>): Promise<Readonly<{ id: string; pid?: number | string }>>;
  stop(id: string): Promise<void>;
  runOnce?(command: string, env: Readonly<Record<string, string>>, capabilities: readonly ManifestCapability[]): Promise<void>;
}>;
