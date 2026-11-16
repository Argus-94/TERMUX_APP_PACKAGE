export type InterceptorStatus = "stopped" | "starting" | "stopping" | "listening" | "capturing" | "error" | "unsupported";
export type InterceptorSource = "user" | "agent" | "preset";
export type InterceptorProtocol = "http:" | "https:";
export type SafeHeaders = Readonly<Record<string, string>>;

export type RequestRecord = Readonly<{
  id: string;
  startedAt: number;
  url: string;
  method: string;
  protocol: InterceptorProtocol;
  requestHeaders: SafeHeaders;
  requestBody?: string;
}>;
export type ResponseRecord = Readonly<{
  status: number;
  statusText?: string;
  headers: SafeHeaders;
  body?: string;
}>;
export type InterceptorTiming = Readonly<{ start: number; end: number; totalMs: number }>;
export type CapturedExchange = Readonly<{
  id: string;
  request: RequestRecord;
  response?: ResponseRecord;
  timing: InterceptorTiming;
  matchedRules: readonly string[];
  modified: boolean;
  blocked: boolean;
  error?: string;
  bytesIn: number;
  bytesOut: number;
}>;

export type RuleCondition =
  | Readonly<{ type: "urlContains"; value: string }>
  | Readonly<{ type: "urlMatches"; value: string }>
  | Readonly<{ type: "urlEquals"; value: string }>
  | Readonly<{ type: "methodIs"; value: string }>
  | Readonly<{ type: "headerExists"; name: string }>
  | Readonly<{ type: "headerEquals"; name: string; value: string }>
  | Readonly<{ type: "statusCodeIs"; value: number }>
  | Readonly<{ type: "bodyContains"; value: string }>;
export type RuleAction =
  | Readonly<{ type: "mockResponse"; status: number; headers?: SafeHeaders; body: string }>
  | Readonly<{ type: "modifyBody"; find: string; replace: string; regex?: boolean; jsonPath?: string }>
  | Readonly<{ type: "modifyHeaders"; add?: SafeHeaders; remove?: readonly string[]; set?: SafeHeaders }>
  | Readonly<{ type: "setStatusCode"; status: number }>
  | Readonly<{ type: "block" }>
  | Readonly<{ type: "delay"; ms: number }>
  | Readonly<{ type: "breakpoint" }>
  | Readonly<{ type: "mapLocal"; filePath: string; status?: number; contentType?: string }>
  | Readonly<{ type: "mapRemote"; targetUrl: string }>;
export type InterceptorRule = Readonly<{
  id: string;
  name: string;
  enabled: boolean;
  priority: number;
  conditions: readonly RuleCondition[];
  actions: readonly RuleAction[];
  createdAt: number;
  updatedAt: number;
  source: InterceptorSource;
}>;
export type InterceptorSettings = Readonly<{
  mode: "simple" | "advanced";
  port: number;
  mitmEnabled: boolean;
  maxRecords: number;
  autoClear: boolean;
  bodyLimitBytes: number;
}>;
export type InterceptorTimelineEvent = Readonly<{
  operation: string;
  outcome: "allowed" | "denied" | "failed";
  reason?: string;
  source: "user" | "agent" | "runtime";
  details?: Readonly<Record<string, unknown>>;
}>;
export type InterceptorTimeline = (event: InterceptorTimelineEvent) => Promise<void> | void;
export type InterceptorStoreAdapter = Readonly<{ read(): Promise<string | null>; write(value: string): Promise<void> }>;
export type InterceptorTrafficHandler = (request: Readonly<{ url: string; method: string; headers: SafeHeaders; body?: string }>) => Promise<ResponseRecord>;
export type InterceptorRuntimeAdapter = Readonly<{
  start(options: Readonly<{ port: number; mitmEnabled: boolean; onRequest: InterceptorTrafficHandler }>): Promise<Readonly<{ address: string; port: number; verified: boolean; authToken?: string }>>;
  stop(): Promise<void>;
}>;
export type InterceptorCertificateAdapter = Readonly<{
  generateAndStore(): Promise<Readonly<{ fingerprint: string; subject: string }>>;
  exportPublicCertificate(): Promise<Readonly<{ pem: string; fingerprint: string; subject: string }>>;
  checkTrust(): Promise<"trusted" | "not-trusted" | "unknown">;
  remove(): Promise<void>;
}>;

export const DEFAULT_INTERCEPTOR_SETTINGS: InterceptorSettings = Object.freeze({ mode: "simple", port: 8888, mitmEnabled: false, maxRecords: 300, autoClear: true, bodyLimitBytes: 256_000 });
