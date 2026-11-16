import { NativeEventEmitter, NativeModules, Platform } from "react-native";
import type { InterceptorCertificateAdapter, InterceptorRuntimeAdapter, ResponseRecord, SafeHeaders } from "../core/enhancements/interceptor/types";
import { registerNativePinnedEgressTransport } from "../core/enhancements/interceptor/NativeEgressTransportAttestation";

type NativeInterceptorModule = {
  addListener(eventName: string): void;
  removeListeners(count: number): void;
  startProxy(port: number, mitmEnabled: boolean): Promise<{ address: string; port: number; verified: boolean; authToken: string }>;
  stopProxy(): Promise<void>;
  respond(requestId: string, response: ResponseRecord): Promise<boolean>;
  fetchUpstream(request: { url: string; method: string; headers: Record<string, string>; body?: string }): Promise<ResponseRecord>;
  generateAndStoreCertificate(): Promise<{ fingerprint: string; subject: string }>;
  exportPublicCertificate(): Promise<{ pem: string; fingerprint: string; subject: string }>;
  checkCertificateTrust(): Promise<"trusted" | "not-trusted" | "unknown">;
  removeCertificate(): Promise<void>;
};

type NativeProxyRequest = Readonly<{
  requestId: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}>;

const EVENT_NAME = "aibInterceptorRequest";

/** Native transport adapters exist only on Android builds that include the checked module. */
export function createNativeInterceptorAdapters(): Readonly<{
  runtimeAdapter?: InterceptorRuntimeAdapter;
  certificateAdapter?: InterceptorCertificateAdapter;
  fetcher?: typeof fetch;
}> {
  if (Platform.OS !== "android") return {};
  const native = NativeModules.AibInterceptorProxy as NativeInterceptorModule | undefined;
  if (!native || typeof native.startProxy !== "function" || typeof native.fetchUpstream !== "function") return {};

  const emitter = new NativeEventEmitter(native as never);
  let subscription: { remove(): void } | null = null;
  let running = false;

  const runtimeAdapter: InterceptorRuntimeAdapter = Object.freeze({
    async start(options) {
      if (running) throw new Error("PROXY_ALREADY_RUNNING");
      subscription?.remove();
      subscription = emitter.addListener(EVENT_NAME, (raw: NativeProxyRequest) => {
        if (!raw || typeof raw.requestId !== "string" || raw.requestId.length > 80) return;
        void (async () => {
          try {
            if (typeof raw.url !== "string" || raw.url.length > 4096 || typeof raw.method !== "string" || typeof raw.headers !== "object" || !raw.headers) {
              await native.respond(raw.requestId, { status: 400, statusText: "Invalid request", headers: {}, body: "The native request was invalid." });
              return;
            }
            const response = await options.onRequest({
              url: raw.url,
              method: raw.method,
              headers: raw.headers as SafeHeaders,
              ...(typeof raw.body === "string" ? { body: raw.body } : {}),
            });
            await native.respond(raw.requestId, response);
          } catch {
            try { await native.respond(raw.requestId, { status: 502, statusText: "Interceptor failed", headers: {}, body: "The interceptor could not process this request." }); } catch { /* listener may have stopped */ }
          }
        })();
      });
      try {
        const result = await native.startProxy(options.port, options.mitmEnabled);
        if (result.address !== "127.0.0.1" || result.port !== options.port || result.verified !== true || typeof result.authToken !== "string" || !/^[A-Za-z0-9_-]{24,256}$/.test(result.authToken)) {
          await native.stopProxy().catch(() => undefined);
          throw new Error("NATIVE_PROXY_RESULT_UNVERIFIED");
        }
        running = true;
        return { address: result.address, port: result.port, verified: true, authToken: result.authToken };
      } catch (error) {
        subscription?.remove(); subscription = null; running = false;
        throw new Error(error instanceof Error && /MITM_CA_UNAVAILABLE/.test(error.message) ? "MITM_CA_UNAVAILABLE" : "NATIVE_PROXY_START_FAILED");
      }
    },
    async stop() {
      subscription?.remove(); subscription = null; running = false;
      await native.stopProxy();
    },
  });

  const certificateAdapter: InterceptorCertificateAdapter = {
    generateAndStore: () => native.generateAndStoreCertificate(),
    exportPublicCertificate: () => native.exportPublicCertificate(),
    checkTrust: () => native.checkCertificateTrust(),
    remove: () => native.removeCertificate(),
  };

  const fetcher: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? (typeof input === "object" && !(input instanceof URL) ? input.method : "GET") ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers ?? (typeof input === "object" && !(input instanceof URL) ? input.headers : undefined));
    const safeHeaders: Record<string, string> = {};
    headers.forEach((value, key) => { safeHeaders[key] = value; });
    const body = typeof init?.body === "string" ? init.body : undefined;
    if (init?.body != null && body === undefined) throw new Error("NATIVE_UPSTREAM_BODY_TYPE_UNSUPPORTED");
    const result = await native.fetchUpstream({ url, method, headers: safeHeaders, ...(body !== undefined ? { body } : {}) });
    const noBody = ["HEAD"].includes(method) || [204, 205, 304].includes(result.status);
    return new Response(noBody ? null : result.body ?? "", {
      status: result.status,
      statusText: result.statusText ?? "",
      headers: result.headers ?? {},
    });
  };

  registerNativePinnedEgressTransport(runtimeAdapter, fetcher);
  return { runtimeAdapter, certificateAdapter, fetcher };
}
