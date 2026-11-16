/** Auth and proxy contracts. Real provider credentials are absent from public client configuration. */
export type AuthErrorCode = "INVALID_PROVIDER" | "PROVIDER_NOT_SUPPORTED" | "EMPTY_CREDENTIAL" | "INVALID_CREDENTIAL" | "SECURE_STORAGE_FAILED" | "PROXY_ACCESS_DENIED" | "CREDENTIAL_MISSING" | "ROUTE_NOT_CONFIGURED" | "INVALID_REQUEST" | "UPSTREAM_FAILED" | "NATIVE_TRANSPORT_UNAVAILABLE" | "PROXY_NOT_STARTED" | "PROXY_SESSION_INVALID";
export class AuthError extends Error { constructor(readonly code: AuthErrorCode, message: string) { super(message); this.name = "AuthError"; } }
export type MaskedProviderCredential = Readonly<{ provider: string; configured: boolean; masked: string | null }>;
/** SecureStore-only adapter; implementations must never mirror values to workspace or backups. */
export type SecureCredentialStorage = Readonly<{ get(key: string): Promise<string | null>; set(key: string, value: string): Promise<void>; delete(key: string): Promise<void> }>;
export type ProxyRequest = Readonly<{ provider: string; path: string; method?: string; headers?: Readonly<Record<string, string>>; body?: BodyInit | null; model?: string; signal?: AbortSignal }>;
export type ProxyMetadata = Readonly<{ provider: string; model?: string; status: number; latencyMs: number; streaming: boolean }>;
export type ProviderRoute = Readonly<{ baseUrl: string; authHeader?: "authorization" | "x-api-key" | "x-manus-api-key"; authScheme?: "Bearer" | "raw" }>;
export type ProxyFetch = (input: string, init: RequestInit) => Promise<Response>;
export type ProxyMetadataLogger = (metadata: ProxyMetadata) => void;
export type NativeProxySession = Readonly<{ sessionId: string; baseUrl: string; apiKey: string }>;
export type ProxyClientConfiguration = Readonly<{ provider: string; baseUrl: string; apiKey: "dummy-aib-proxy-key"; sessionId: string }>;
export interface NativeProxyTransport { start(provider: string, credential: string, route?: ProviderRoute): Promise<NativeProxySession>; stop(sessionId: string): Promise<boolean> }
