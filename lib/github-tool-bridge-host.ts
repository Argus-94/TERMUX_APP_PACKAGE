import { isTrustedGithubToolDocumentUrl, parseTrustedGithubToolMessage } from "./github-tool-security.ts";

export type GithubToolNativeModule = {
  httpRequest?: (payload: string) => Promise<string>;
  secretGet?: (name: string) => Promise<string>;
  secretSet?: (name: string, value: string) => Promise<boolean>;
  secretSetResult?: (name: string, value: string) => Promise<{ saved?: boolean; stage?: string }>;
  secretSetLastStage?: () => Promise<string>;
  secretDelete?: (name: string) => Promise<boolean>;
  saveFile?: (fileName: string, mime: string, base64: string) => Promise<boolean>;
  pickFiles?: () => Promise<string>;
  uploadAsset?: (id: string, uploadUrl: string, token: string, name: string, mime: string) => void;
  cancelTransfer?: (id: string) => void;
};

export type GithubToolEventUrlKind = "trusted_asset" | "local_file_other" | "http_other" | "other_scheme" | "missing" | "oversize" | "invalid";
export type GithubToolMessageType = "httpRequest" | "secretSet" | "secretGet" | "other" | "unknown";

const MAX_DIAGNOSTIC_MESSAGE_CHARS = 2_100_000;
const SAFE_CORRELATION_ID = /^[a-z0-9]{1,16}-[a-z0-9]{8}:c[1-9][0-9]{0,9}$/;

/** Classify callback URL metadata without retaining or logging its contents. */
export function classifyGithubToolEventUrl(value: unknown): GithubToolEventUrlKind {
  if (value == null || value === "") return "missing";
  if (typeof value !== "string") return "invalid";
  if (value.length > 2048) return "oversize";
  if (isTrustedGithubToolDocumentUrl(value)) return "trusted_asset";
  if (/[\\\s\u0000-\u001f]/.test(value)) return "invalid";
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(value)?.[1]?.toLowerCase();
  if (!scheme) return "invalid";
  if (scheme === "file") return "local_file_other";
  if (scheme === "http" || scheme === "https") return "http_other";
  return "other_scheme";
}

function safeGithubToolCorrelation(value: unknown): string | undefined {
  return typeof value === "string" && value.length <= 92 && SAFE_CORRELATION_ID.test(value) ? value : undefined;
}

/** Extract only fixed message categories and a generated opaque correlation id; never return payload fields. */
export function classifyGithubToolMessage(rawData: unknown): { messageType: GithubToolMessageType; correlationId?: string } {
  if (typeof rawData !== "string" || rawData.length > MAX_DIAGNOSTIC_MESSAGE_CHARS) return { messageType: "unknown" };
  try {
    const value: unknown = JSON.parse(rawData);
    if (!value || typeof value !== "object" || Array.isArray(value)) return { messageType: "unknown" };
    const message = value as Record<string, unknown>;
    const type = message.type;
    const messageType: GithubToolMessageType = type === "httpRequest" || type === "secretSet" || type === "secretGet"
      ? type
      : typeof type === "string" ? "other" : "unknown";
    const correlationId = safeGithubToolCorrelation(message.id) || safeGithubToolCorrelation(message.correlationId);
    return correlationId ? { messageType, correlationId } : { messageType };
  } catch {
    return { messageType: "unknown" };
  }
}

const GITHUB_SECRET_NAMES = new Set(["unzipgit_token", "unzipgit_tokens", "unzipgit_apikeys"]);
const MAX_GITHUB_SECRET_CHARS = 2_000_000;
// A timeout does not cancel the native keystore operation. Keep the name
// reserved until that operation settles so retries cannot race a late commit.
const nativeSecretWritesInFlight = new Set<string>();

export function createGithubToolSessionSecretVault() {
  const values = new Map<string, string>();
  const pending = new Map<string, string>();
  const declinedDocuments = new Map<string, string>();
  let sessionOnly = false;
  return {
    isSessionOnly: () => sessionOnly,
    enableSessionOnly: () => { sessionOnly = true; },
    has: (name: string) => values.has(name),
    hasPending: (name: string) => pending.has(name),
    get: (name: string) => values.get(name) || "",
    set: (name: string, value: string) => { if (GITHUB_SECRET_NAMES.has(name) && value.length <= MAX_GITHUB_SECRET_CHARS) values.set(name, value); },
    delete: (name: string) => values.delete(name),
    getPending: (name: string) => pending.get(name) || "",
    setPending: (name: string, value: string) => { if (GITHUB_SECRET_NAMES.has(name) && value.length <= MAX_GITHUB_SECRET_CHARS) { pending.set(name, value); declinedDocuments.delete(name); } },
    declinedForDocument: (name: string, documentId: string) => declinedDocuments.get(name) === documentId,
    markDeclinedForDocument: (name: string, documentId: string) => { if (documentId) declinedDocuments.set(name, documentId); },
    clearPending: (name: string) => { pending.delete(name); declinedDocuments.delete(name); },
  };
}

export type GithubToolSessionSecretVault = ReturnType<typeof createGithubToolSessionSecretVault>;

type GithubToolWebRef = { current: { injectJavaScript: (js: string) => void } | null };

type HostDependencies = {
  native: GithubToolNativeModule | undefined;
  sessionVault?: GithubToolSessionSecretVault;
  confirmSessionOnly?: (reason: string) => Promise<boolean>;
  secretWriteTimeoutMs?: number;
  onSessionOnly?: () => void;
  notifySecretsUpdated?: (sourceDocumentId: string) => void;
  parseMessage: (url: unknown, data: unknown) => Record<string, unknown> | null;
  isAllowedHttpUrl: (url: unknown) => boolean;
  reply: (id: string | undefined, data: string) => void;
  saveFile: (name: string, mime: string, base64: string) => Promise<void>;
  openUrl: (url: string) => Promise<unknown>;
  log?: (text: string) => void;
  stage?: (value: string) => void;
  shareText: (text: string, title: string) => Promise<unknown>;
  emitToWeb?: (fn: string, args: unknown[]) => void;
  fetchRequest?: (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal }) => Promise<{
    ok: boolean;
    status: number;
    statusText?: string;
    headers: { forEach: (callback: (value: string, key: string) => void) => void };
    text: () => Promise<string>;
    arrayBuffer: () => Promise<ArrayBuffer>;
  }>;
};

export type GithubToolBridgeEvent = { nativeEvent: { data: string; url?: string | null } };

const SAFE_SECRET_SET_STAGES = new Set([
  "not_started", "input_rejected", "keystore_error", "key_invalidated", "provider_error", "encrypt_error", "snapshot_error",
  "commit_failed", "commit_error", "readback_missing", "readback_storage_error",
  "readback_decode_error", "readback_keystore_error", "readback_provider_error", "readback_decrypt_error",
  "readback_mismatch", "rollback_failed", "verified", "verified_retry", "verified_after_recovery",
  "recovery_reset_failed", "module_exception", "module_timeout",
]);

function settleBefore<T>(promise: Promise<T>, timeoutMs: number): Promise<{ timedOut: true } | { timedOut: false; value: T }> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ timedOut: true });
    }, timeoutMs);
    promise.then((value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ timedOut: false, value });
    }, () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ timedOut: false, value: undefined as T });
    });
  });
}

function secretFailureKind(stage: string, hasNativeSecretWriter: boolean): string {
  if (!hasNativeSecretWriter || stage === "unavailable") return "module_unavailable";
  if (stage === "rollback_failed") return "rollback_failed";
  if (stage === "input_rejected") return "input_rejected";
  if (/keystore|encrypt|recovery|provider|invalidated/i.test(stage)) return "keystore_unavailable";
  return "storage_unavailable";
}

function githubApiHost(url: string): boolean {
  return /^https:\/\/api\.github\.com(?::443)?(?:[/?#]|$)/i.test(url);
}

function fallbackHeaders(headers: Record<string, string>, url: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers || {})) {
    const lower = name.toLowerCase();
    if (lower === "proxy-authorization" || lower === "cookie") continue;
    if (lower === "authorization" && !githubApiHost(url)) continue;
    out[name] = value;
  }
  return out;
}

/** The production onMessage normalization, kept small and directly exercised by the source E2E test. */
export function createGithubToolOnMessage(
  getTrustedDocumentUrl: () => string,
  route: (event: GithubToolBridgeEvent) => Promise<void>,
  diagnostic: (stage: string) => void,
) {
  return async (rawEvent: GithubToolBridgeEvent): Promise<void> => {
    const eventUrl = rawEvent.nativeEvent.url;
    const trackedUrl = getTrustedDocumentUrl();
    const trustedTrackedUrl = isTrustedGithubToolDocumentUrl(trackedUrl);
    const trustedEventUrl = isTrustedGithubToolDocumentUrl(eventUrl);
    const eventMatchesTrackedDocument = trustedTrackedUrl && trustedEventUrl && eventUrl === trackedUrl;
    // The patched Android listener forwards the current top-level document URL;
    // the legacy JavaScript-interface path already uses WebView.getUrl(). Never
    // substitute the tracked page for missing, stale, foreign, or noncanonical metadata.
    const senderUrl = eventMatchesTrackedDocument ? eventUrl : "";
    const messageMetadata = classifyGithubToolMessage(rawEvent.nativeEvent.data);
    const correlation = messageMetadata.correlationId || "none";
    try {
      diagnostic(`rn.onMessage.received eventUrlKind=${classifyGithubToolEventUrl(eventUrl)} trackedDocumentTrusted=${trustedTrackedUrl} eventMatchesTrackedDocument=${eventMatchesTrackedDocument} messageType=${messageMetadata.messageType} correlation=${correlation}`);
    } catch { /* diagnostics never break the bridge */ }
    try {
      await route({ nativeEvent: { ...rawEvent.nativeEvent, url: senderUrl } });
      try { diagnostic(`rn.onMessage.completed correlation=${correlation}`); } catch { /* diagnostics never break the bridge */ }
    } catch (error) {
      try { diagnostic(`rn.onMessage.failed correlation=${correlation}`); } catch { /* diagnostics never break the bridge */ }
      throw error;
    }
  };
}

/** Production parser wrapper: report trust outcome only, never document URL or message content. */
export function createGithubToolMessageParser(diagnostic: (stage: string) => void) {
  return (documentUrl: unknown, rawData: unknown): Record<string, unknown> | null => {
    const metadata = classifyGithubToolMessage(rawData);
    const correlation = metadata.correlationId || "none";
    const parsed = parseTrustedGithubToolMessage(documentUrl, rawData);
    try {
      diagnostic(parsed
        ? `message.parse.accepted messageType=${metadata.messageType} correlation=${correlation}`
        : `message.parse.rejected trust=${isTrustedGithubToolDocumentUrl(documentUrl) ? "trusted" : "denied"} messageType=${metadata.messageType} correlation=${correlation}`);
    } catch { /* diagnostics never break the bridge */ }
    return parsed;
  };
}

function isAuthVerificationGet(payload: { url?: string; method?: string; body?: string | null; binary?: boolean }, url: string): boolean {
  return /^https:\/\/api\.github\.com(?::443)?\/user$/i.test(url) &&
    (payload.method || "GET").toUpperCase() === "GET" && payload.body == null && !payload.binary;
}

function isRecoverableAuthTransportFailure(value: unknown): boolean {
  const message = value instanceof Error ? value.message : String(value ?? "");
  return /timeout|timed out|UnknownHostException|Unable to resolve host|No address associated|ConnectException|NoRouteToHostException|SocketException|Connection reset|Broken pipe|Connection refused|Network is unreachable|ECONNREFUSED|EHOSTUNREACH|EAI_AGAIN/i.test(message);
}

function isNativeTransportErrorResponse(value: string): boolean {
  try {
    const response = JSON.parse(value) as { status?: number; error?: string };
    return response.status === 0 && typeof response.error === "string" && isRecoverableAuthTransportFailure(response.error);
  } catch {
    return false;
  }
}

/** Resolves an outstanding call created by the packaged WebView's postMessage bridge. */
export function createGithubToolReply(webRef: GithubToolWebRef) {
  return (id: string | undefined, data: string) => {
    const web = webRef.current;
    if (!id || !web) return;
    const key = JSON.stringify(id);
    const js =
      `try{var c=window.__aibCbs&&window.__aibCbs[${key}];` +
      `if(c){c.resolve(${JSON.stringify(data)});delete window.__aibCbs[${key}];}}catch(e){}` +
      `true;`;
    web.injectJavaScript(js);
  };
}

/** Production onMessage router. Platform/network/storage behavior is injected at its real native boundary. */
export async function routeGithubToolMessage(
  event: { nativeEvent: { data: string; url?: string | null } },
  deps: HostDependencies,
): Promise<void> {
  const parsed = deps.parseMessage(event.nativeEvent.url, event.nativeEvent.data);
  if (!parsed) return;
  const msg = parsed as {
    type?: string;
    id?: string;
    payload?: string;
    documentId?: string;
    name?: string;
    value?: string;
    correlationId?: string;
    migration?: boolean;
    mime?: string;
    url?: string;
    title?: string;
    text?: string;
    stage?: string;
    transferId?: string;
    token?: string;
  };
  const id = typeof msg.id === "string" && msg.id.length <= 160 ? msg.id : undefined;
  const correlation = safeGithubToolCorrelation(msg.id) || safeGithubToolCorrelation(msg.correlationId) || "none";
  const documentId = typeof msg.documentId === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(msg.documentId) ? msg.documentId : "";
  const mod = deps.native;
  const sessionVault = deps.sessionVault;
  const reply = deps.reply;
  const hostLog = (text: string) => { try { deps.log?.(text); } catch { /* logging never breaks the bridge */ } };
  const stage = (text: string) => { try { deps.stage?.(`${text} correlation=${correlation}`); } catch { /* diagnostics never break the bridge */ } };
  const knownType = new Set(["log", "diag", "httpRequest", "saveFile", "secretGet", "secretSet", "secretDelete", "openUrl", "shareText", "toast", "pickFiles", "uploadAsset", "cancelTransfer"]);
  stage(`host.message.accepted type=${knownType.has(String(msg.type)) ? String(msg.type) : "other"}`);

  if (msg.type === "log") {
    // WebView log text can include account names, paths, or user-provided content.
    hostLog("webview log suppressed");
    return;
  }

  if (msg.type === "diag") {
    const safeWebStages = new Set(["secretSet_reply_success", "secretSet_reply_failure", "secretSet_promise_rejected"]);
    const value = typeof msg.stage === "string" && safeWebStages.has(msg.stage) ? msg.stage : "unknown";
    stage(`webview.${value}`);
    return;
  }

  try {
    if (msg.type === "httpRequest" && id && msg.payload != null) {
      let p: {
        url?: string;
        method?: string;
        headers?: Record<string, string>;
        body?: string | null;
        binary?: boolean;
        timeoutMs?: number;
      };
      try {
        p = JSON.parse(msg.payload);
      } catch {
        reply(id, JSON.stringify({ ok: false, status: 0, error: "bad payload" }));
        return;
      }
      const url = String(p.url || "");
      if (!deps.isAllowedHttpUrl(url)) {
        reply(id, JSON.stringify({ ok: false, status: 0, error: "github host not allowed" }));
        return;
      }
      stage(`httpRequest.dispatch transport=${mod?.httpRequest ? "native" : "fetch-fallback"}`);
      let legacyAuthFetch = false;
      // v255 verified the user's token with React Native fetch. Preserve that
      // supported path only for the idempotent /user check when Android's new
      // URLConnection transport reports a connection/DNS failure or timeout.
      // This endpoint is an idempotent identity check; the short, same-host RN
      // fallback restores v255's supported path without replaying mutations.
      // Any actual HTTP status, non-/user request, or other error is final.
      if (mod?.httpRequest) {
        try {
          const response = await mod.httpRequest(JSON.stringify(p));
          try {
            const r0 = JSON.parse(String(response)) as { status?: number };
            stage(`httpRequest.native.response status=${Number.isInteger(r0.status) ? r0.status : "unknown"}`);
          } catch { stage("httpRequest.native.response invalid-format"); }
          if (typeof response !== "string") {
            reply(id, JSON.stringify({ ok: false, status: 0, error: "invalid native HTTP response" }));
            return;
          }
          if (isAuthVerificationGet(p, url) && isNativeTransportErrorResponse(response)) legacyAuthFetch = true;
          else {
            reply(id, response);
            return;
          }
        } catch (e: unknown) {
          stage("httpRequest.native.rejected");
          if (isAuthVerificationGet(p, url) && isRecoverableAuthTransportFailure(e)) legacyAuthFetch = true;
          else {
            const err = e instanceof Error ? e.message : String(e);
            reply(id, JSON.stringify({ ok: false, status: 0, error: /timeout|timed out/i.test(err) ? "timeout" : "native HTTP bridge failed" }));
            return;
          }
        }
      }
      const ctrl = new AbortController();
      const requestedTimeoutMs = Number(p.timeoutMs) || (p.binary ? 120000 : 15000);
      const timeoutMs = legacyAuthFetch
        ? Math.max(1000, Math.min(requestedTimeoutMs, 8000))
        : Math.max(1000, Math.min(requestedTimeoutMs, p.binary ? 180000 : 30000));
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const fetchRequest = deps.fetchRequest || ((target, init) => fetch(target, init as RequestInit));
        const requestAndRead = async (): Promise<string> => {
          const res = await fetchRequest(url, {
            method: (p.method || "GET").toUpperCase(),
            headers: fallbackHeaders(p.headers || {}, url),
            body: p.body != null && p.method && !/^(GET|HEAD)$/i.test(p.method) ? p.body : undefined,
            signal: ctrl.signal,
          });
          let bodyText = "";
          let isBase64 = false;
          if (p.binary) {
            const buf = await res.arrayBuffer();
            const bytes = new Uint8Array(buf);
            let binary = "";
            const chunk = 0x8000;
            for (let i = 0; i < bytes.length; i += chunk) {
              binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)) as unknown as number[]);
            }
            const b64 = typeof globalThis.btoa === "function" ? globalThis.btoa(binary) : (() => {
              const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
              let out = "";
              for (let i = 0; i < bytes.length; i += 3) {
                const a = bytes[i];
                const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
                const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
                out += chars[a >> 2];
                out += chars[((a & 3) << 4) | (b >> 4)];
                out += i + 1 < bytes.length ? chars[((b & 15) << 2) | (c >> 6)] : "=";
                out += i + 2 < bytes.length ? chars[c & 63] : "=";
              }
              return out;
            })();
            bodyText = b64;
            isBase64 = true;
          } else {
            bodyText = await res.text();
          }
          const headers: Record<string, string> = {};
          res.headers.forEach((v, k) => { headers[k] = v; });
          return JSON.stringify({ ok: res.ok, status: res.status, statusText: res.statusText || "", headers, body: bodyText, isBase64 });
        };
        if (legacyAuthFetch) {
          // AbortSignal alone is not a hard bound if the RN fetch implementation stalls after abort.
          const deadline = new Promise<string>((_resolve, reject) => {
            timer = setTimeout(() => {
              ctrl.abort();
              reject(new Error("timeout"));
            }, timeoutMs);
          });
          reply(id, await Promise.race([requestAndRead(), deadline]));
        } else {
          // Preserve the existing fetch semantics for non-auth and old-build fallback traffic.
          timer = setTimeout(() => ctrl.abort(), timeoutMs);
          reply(id, await requestAndRead());
        }
      } catch (e: unknown) {
        const err = e instanceof Error ? e.message : String(e);
        reply(id, JSON.stringify({ ok: false, status: 0, error: /abort/i.test(err) ? "timeout" : err }));
      } finally {
        if (timer) clearTimeout(timer);
      }
      return;
    }
    if (msg.type === "pickFiles" && id) {
      // Native Storage Access Framework picker; resolves with a JSON array of {id,name,size,mime}.
      let picked = "[]";
      try {
        if (mod?.pickFiles) picked = String((await mod.pickFiles()) || "[]");
      } catch { picked = "[]"; }
      reply(id, picked);
      return;
    }
    if (msg.type === "uploadAsset") {
      const transferId = typeof msg.transferId === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(msg.transferId) ? msg.transferId : "";
      const url = typeof msg.url === "string" ? msg.url : "";
      if (!transferId || !/^https:\/\/uploads\.github\.com(?::443)?\//i.test(url) || typeof msg.token !== "string" || !msg.token) {
        if (transferId) deps.emitToWeb?.("window.__ugDone", [transferId, 0, "Недопустимый запрос загрузки"]);
        return;
      }
      if (!mod?.uploadAsset) {
        deps.emitToWeb?.("window.__ugDone", [transferId, 0, "Загрузка файлов недоступна в этой сборке"]);
        return;
      }
      try {
        mod.uploadAsset(transferId, url, msg.token, String(msg.name || "file").slice(0, 255), String(msg.mime || "application/octet-stream").slice(0, 120));
      } catch (e: unknown) {
        deps.emitToWeb?.("window.__ugDone", [transferId, 0, e instanceof Error ? e.message : String(e)]);
      }
      return;
    }
    if (msg.type === "cancelTransfer") {
      const transferId = typeof msg.transferId === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(msg.transferId) ? msg.transferId : "";
      try { if (transferId) mod?.cancelTransfer?.(transferId); } catch { /* ignore */ }
      return;
    }
    if (msg.type === "saveFile" && id && msg.name != null) {
      try {
        await deps.saveFile(msg.name, msg.mime || "application/octet-stream", msg.value || "");
        reply(id, "1");
      } catch (e: unknown) {
        reply(id, "0:" + (e instanceof Error ? e.message : String(e)));
      }
      return;
    }
    if (msg.type === "secretGet" && id && msg.name != null) {
      const name = typeof msg.name === "string" ? msg.name : "";
      let value = "";
      if (!GITHUB_SECRET_NAMES.has(name)) { reply(id, ""); return; }
      try { value = sessionVault?.get(name) || ""; } catch { value = ""; }
      if (!value) {
        try { if (mod?.secretGet) value = (await mod.secretGet(name)) || ""; } catch { value = ""; }
      }
      if (value) { reply(id, value); return; }
      const pending = sessionVault?.getPending(name) || "";
      const sourceDocumentId = typeof msg.documentId === "string" ? msg.documentId : "";
      if (pending && !(sourceDocumentId && sessionVault?.declinedForDocument(name, sourceDocumentId))) {
        let nativeStage = "unavailable";
        let saved = false;
        const hasNativeWriter = Boolean(mod?.secretSetResult || mod?.secretSet);
        if (hasNativeWriter) {
          const retryWrite = (async () => {
            if (mod?.secretSetResult) {
              const result = await mod.secretSetResult(name, pending);
              return {
                saved: Boolean(result?.saved),
                stage: typeof result?.stage === "string" && SAFE_SECRET_SET_STAGES.has(result.stage) ? result.stage : "unknown",
              };
            }
            return { saved: Boolean(await mod?.secretSet?.(name, pending)), stage: "unavailable" };
          })();
          const writeDeadlineMs = Number.isFinite(deps.secretWriteTimeoutMs) ? Math.max(1, Math.min(Number(deps.secretWriteTimeoutMs), 15000)) : 15000;
          const retry = await settleBefore(retryWrite, writeDeadlineMs);
          if (retry.timedOut) {
            nativeStage = "module_timeout";
            void retryWrite.then((late) => {
              if (late.saved) {
                sessionVault?.clearPending(name);
                try { if (sourceDocumentId) deps.notifySecretsUpdated?.(sourceDocumentId); } catch { /* late hydration is best effort */ }
              }
            }).catch(() => {});
          } else if (retry.value) {
            saved = retry.value.saved;
            nativeStage = retry.value.stage;
          }
        }
        if (saved) {
          value = pending;
          sessionVault?.clearPending(name);
        } else if (sessionVault && deps.confirmSessionOnly) {
          let accepted = false;
          try { accepted = await deps.confirmSessionOnly(secretFailureKind(nativeStage, hasNativeWriter)); } catch { accepted = false; }
          if (accepted) {
            sessionVault.enableSessionOnly();
            sessionVault.set(name, pending);
            sessionVault.clearPending(name);
            try { deps.onSessionOnly?.(); } catch { /* UI callback never breaks storage */ }
            value = pending;
          } else {
            sessionVault.markDeclinedForDocument(name, sourceDocumentId);
          }
        } else {
          sessionVault?.markDeclinedForDocument(name, sourceDocumentId);
        }
      }
      reply(id, value);
      return;
    }
    if (msg.type === "secretSet" && id && msg.name != null) {
      stage("secretSet.dispatch");
      const name = typeof msg.name === "string" ? msg.name : "";
      const value = typeof msg.value === "string" ? msg.value : null;
      if (!GITHUB_SECRET_NAMES.has(name) || value == null || value.length > MAX_GITHUB_SECRET_CHARS) {
        stage("secretSet.input.rejected");
        reply(id, "0:input_rejected");
        return;
      }
      if (msg.migration === true) sessionVault?.setPending(name, value);
      let saved = false;
      let nativeStage = "unavailable";
      let sessionSaved = false;
      const hasNativeSecretWriter = Boolean(mod?.secretSetResult || mod?.secretSet);
      if (sessionVault?.isSessionOnly()) {
        sessionVault.set(name, value);
        saved = true;
        sessionSaved = true;
        stage("secretSet.session.result=success");
      } else {
        if (nativeSecretWritesInFlight.has(name)) {
          nativeStage = "module_timeout";
          stage("secretSet.native.pending_previous_write");
        } else if (!hasNativeSecretWriter) {
          stage("secretSet.native.unavailable");
        } else {
          stage("secretSet.native.begin");
          const nativeWrite = (async () => {
            if (mod?.secretSetResult) {
              const result = await mod.secretSetResult(name, value);
              return {
                saved: Boolean(result?.saved),
                stage: typeof result?.stage === "string" && SAFE_SECRET_SET_STAGES.has(result.stage) ? result.stage : "unknown",
              };
            }
            const nativeSaved = Boolean(await mod?.secretSet?.(name, value));
            let status = "unavailable";
            try {
              const result = await mod?.secretSetLastStage?.();
              if (typeof result === "string" && SAFE_SECRET_SET_STAGES.has(result)) status = result;
              else if (typeof result === "string") status = "unknown";
            } catch { status = "unavailable"; }
            return { saved: nativeSaved, stage: status };
          })();
          nativeSecretWritesInFlight.add(name);
          void nativeWrite.then(
            () => { nativeSecretWritesInFlight.delete(name); },
            () => { nativeSecretWritesInFlight.delete(name); },
          );
          try {
            const writeDeadlineMs = Number.isFinite(deps.secretWriteTimeoutMs) ? Math.max(1, Math.min(Number(deps.secretWriteTimeoutMs), 15000)) : 15000;
            const outcome = await settleBefore(nativeWrite, writeDeadlineMs);
            if (outcome.timedOut) {
              nativeStage = "module_timeout";
              stage("secretSet.native.timeout");
              void nativeWrite.then((late) => {
                stage(late.saved ? "secretSet.native.late_settled_success" : "secretSet.native.late_settled_failure");
              }).catch(() => { stage("secretSet.native.late_settled_rejection"); });
            } else if (outcome.value) {
              saved = outcome.value.saved;
              nativeStage = outcome.value.stage;
            }
            stage(`secretSet.native.result=${saved ? "success" : "failure"}`);
          } catch {
            stage("secretSet.native.result=rejected");
            saved = false;
            nativeStage = "module_exception";
          }
          stage(`secretSet.native.stage=${nativeStage}`);
        }
        if (!saved && nativeStage !== "rollback_failed" && nativeStage !== "input_rejected" && nativeStage !== "module_timeout" && sessionVault && deps.confirmSessionOnly) {
          const reason = secretFailureKind(nativeStage, hasNativeSecretWriter);
          stage(`secretSet.fallback.prompt reason=${reason}`);
          let accepted = false;
          try { accepted = await deps.confirmSessionOnly(reason); } catch { accepted = false; }
          if (accepted) {
            sessionVault.enableSessionOnly();
            sessionVault.set(name, value);
            saved = true;
            sessionSaved = true;
            try { deps.onSessionOnly?.(); } catch { /* UI callback never breaks storage */ }
            stage("secretSet.fallback.accepted mode=session");
          } else {
            if (msg.migration === true && documentId) sessionVault?.markDeclinedForDocument(name, documentId);
            stage("secretSet.fallback.declined");
          }
        } else if (msg.migration === true && documentId) {
          sessionVault?.markDeclinedForDocument(name, documentId);
        }
      }
      stage(`secretSet.response.begin result=${saved ? "success" : "failure"}`);
      const reason = secretFailureKind(nativeStage, hasNativeSecretWriter);
      if (saved) sessionVault?.clearPending(name);
      reply(id, saved ? (sessionSaved ? "1:session" : "1") : `0:${reason}`);
      stage("secretSet.response.sent");
      if (saved && documentId) {
        try { deps.notifySecretsUpdated?.(documentId); } catch { /* rehydration is best effort */ }
      }
      return;
    }
    if (msg.type === "secretDelete" && id && msg.name != null) {
      const name = typeof msg.name === "string" ? msg.name : "";
      if (!GITHUB_SECRET_NAMES.has(name)) { reply(id, "0"); return; }
      let deleted = false;
      try {
        if (mod?.secretDelete) deleted = Boolean(await mod.secretDelete(name));
        else if (sessionVault && (sessionVault.has(name) || sessionVault.hasPending(name))) deleted = true;
      } catch { deleted = false; }
      if (deleted) { sessionVault?.delete(name); sessionVault?.clearPending(name); }
      reply(id, deleted ? "1" : "0");
      if (deleted && documentId) {
        try { deps.notifySecretsUpdated?.(documentId); } catch { /* rehydration is best effort */ }
      }
      return;
    }
    if (msg.type === "openUrl" && msg.url) {
      try { await deps.openUrl(msg.url); } catch { /* ignore */ }
      if (id) reply(id, "1");
      return;
    }
    if (msg.type === "shareText" && msg.text != null) {
      try { await deps.shareText(msg.text, msg.title || "AI Builder"); } catch { /* ignore */ }
      if (id) reply(id, "1");
      return;
    }
    if (msg.type === "toast" && msg.text && id) reply(id, "1");
  } catch (e: unknown) {
    stage("host.dispatch.failed");
    if (id) reply(id, JSON.stringify({ ok: false, status: 0, error: e instanceof Error ? e.message : String(e) }));
  }
}
