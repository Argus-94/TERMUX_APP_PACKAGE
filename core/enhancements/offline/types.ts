/** Platform-neutral contracts shared by offline GGUF lifecycle and agent modules. */

/** Exact text-chat turn shape accepted by lib/local-model.ts. */
export type OfflineChatTurn = Readonly<{ role: "system" | "user" | "assistant"; content: string }>;

/** Exact generation options shape accepted by lib/local-model.ts. */
export type OfflineGenerationParams = Readonly<{ temperature: number; maxTokens: number; topP: number }>;

/** Model settings accepted by lib/local-model.ts load(). */
export type GGUFLoadParams = Readonly<{ nCtx: number; nThreads: number; nGpuLayers: number }>;

/** Existing local-model.ts methods used by the lifecycle; implementations are injected. */
export interface GGUFModelPort {
  isDownloaded(): boolean;
  isLoaded(): boolean;
  getAppliedParams(): GGUFLoadParams | null;
  load(params?: GGUFLoadParams): Promise<void>;
  unload(): Promise<void>;
}

/** PerformanceMode names, kept as a local type to avoid runtime/platform coupling. */
export type OfflinePerformanceMode = "Performance" | "Balanced" | "Battery" | "Compatibility";

/** Metadata-only lifecycle event; deliberately excludes paths, prompts and model output. */
export type GGUFLifecycleEvent = Readonly<{
  type: "gguf.lifecycle";
  action: "load-start" | "loaded" | "load-failed" | "unloaded" | "unload-failed" | "keepalive" | "background" | "foreground" | "memory-pressure" | "performance-mode";
  at: number;
  state: "unloaded" | "loading" | "loaded" | "unloading" | "error";
  reason?: "user" | "keepalive-expired" | "background" | "memory-pressure" | "performance-mode" | "dispose";
  mode?: OfflinePerformanceMode;
}>;

/** Metadata-only offline-agent event; never contains model text, tool input/output or errors. */
export type OfflineAgentEvent = Readonly<{
  type: "offline.agent";
  action: "started" | "tool-started" | "tool-finished" | "hybrid-fallback" | "finished" | "failed" | "cancelled";
  at: number;
  step?: number;
  toolName?: string;
}>;

/** Tool handler input; credentials are not part of this interface. */
export type OfflineToolContext = Readonly<{ signal?: AbortSignal }>;

/** Explicitly injected tool capability. No implicit/global tool registry is consulted. */
export type OfflineTool = Readonly<{
  name: string;
  description: string;
  execute(args: Readonly<Record<string, unknown>>, context: OfflineToolContext): Promise<unknown> | unknown;
}>;

/** Completion-only credential proxy port. The proxy obtains credentials internally. */
export interface OfflineCredentialProxyPort {
  complete(request: Readonly<{ messages: readonly OfflineChatTurn[]; signal?: AbortSignal }>): Promise<string>;
}

/** Explicit opt-in hybrid configuration. No proxy means no online fallback. */
export type OfflineHybridOptions = Readonly<{ enabled: true; credentialProxy: OfflineCredentialProxyPort }>;
