export type ProviderProbePurpose = "key" | "endpoint" | "model" | "request";

export type ProviderProbeStatus =
  | "key_valid"
  | "key_invalid"
  | "access_denied"
  | "rate_limited"
  | "daily_quota"
  | "model_unavailable"
  | "no_chat_models"
  | "endpoint_unavailable"
  | "upstream_error"
  | "network_error"
  | "timeout"
  | "request_success"
  | "request_error"
  | "storage_error"
  | "empty_key";

export type ProviderProbeTone = "success" | "warning" | "danger";
export type ProviderProbeMessageKey =
  | "apiKeyValid" | "apiKeyInvalid" | "providerCheckCredentialAccepted" | "providerCheckAccessDenied"
  | "providerCheckNoChatModels" | "providerCheckRateLimited" | "providerCheckDailyQuota"
  | "providerCheckModelUnavailable" | "providerCheckEndpointUnavailable" | "providerCheckUpstreamError"
  | "providerCheckNetworkError" | "providerCheckTimeout" | "providerCheckRequestSuccess"
  | "providerCheckRequestError" | "secureKeySaveFailed" | "apiKeyEmpty";

export function classifyProviderHttpStatus(
  httpStatus: number,
  purpose: ProviderProbePurpose,
  details = "",
): ProviderProbeStatus {
  if (httpStatus >= 200 && httpStatus < 300) return purpose === "key" ? "key_valid" : "request_success";
  if (httpStatus === 401) return "key_invalid";
  if (httpStatus === 403) return purpose === "key" ? "key_invalid" : "access_denied";
  if (httpStatus === 429) {
    return details.toLowerCase().includes("free-models-per-day") ? "daily_quota" : "rate_limited";
  }
  if (httpStatus === 404) return purpose === "model" ? "model_unavailable" : purpose === "request" ? "request_error" : "endpoint_unavailable";
  if (httpStatus >= 500 && httpStatus <= 599) return "upstream_error";
  return "request_error";
}

export function classifyProviderTransportFailure(isTimeout: boolean): ProviderProbeStatus {
  return isTimeout ? "timeout" : "network_error";
}

/** Status-only error used across provider dialogs; it intentionally carries no upstream body. */
export class ProviderProbeError extends Error {
  readonly name = "ProviderProbeError";
  constructor(
    readonly probeStatus: ProviderProbeStatus,
    readonly httpStatus?: number,
    readonly retryAfterMs?: number,
  ) {
    super(httpStatus ? `HTTP ${httpStatus}: ${probeStatus}` : probeStatus);
  }
}

export function classifyProviderProbeError(error: unknown, purpose: ProviderProbePurpose): ProviderProbeStatus {
  if (error instanceof ProviderProbeError) return error.probeStatus;
  const candidate = error as { code?: unknown; httpStatus?: unknown; status?: unknown; name?: unknown; message?: unknown } | null;
  const httpStatus = Number(candidate?.httpStatus ?? candidate?.status);
  if (Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599) {
    return classifyProviderHttpStatus(httpStatus, purpose);
  }
  const code = String(candidate?.code ?? "").toUpperCase();
  if (/TIMEOUT|TIMED_OUT/.test(code)) return "timeout";
  if (code === "UPSTREAM_FAILED" || code === "NETWORK_ERROR" || code === "PROVIDER_PROXY_UNAVAILABLE") return "network_error";
  const description = `${String(candidate?.name ?? "")} ${String(candidate?.message ?? error ?? "")}`.toLowerCase();
  if (/timeout|timed out|timeouterror/.test(description)) return "timeout";
  if (/network|fetch failed|failed to fetch|connection|offline|socket/.test(description)) return "network_error";
  return "request_error";
}

export function providerProbeRetryAfterMs(error: unknown): number | undefined {
  return error instanceof ProviderProbeError ? error.retryAfterMs : undefined;
}

/** A true key verdict is possible only from an auth endpoint or explicit auth rejection. */
export function providerKeyValidity(status: ProviderProbeStatus): boolean | null {
  if (status === "key_valid" || status === "request_success") return true;
  if (status === "key_invalid") return false;
  return null;
}

export function providerProbeMessageKey(status: ProviderProbeStatus): ProviderProbeMessageKey {
  switch (status) {
    case "key_valid": return "apiKeyValid";
    case "key_invalid": return "apiKeyInvalid";
    case "access_denied": return "providerCheckAccessDenied";
    case "no_chat_models": return "providerCheckNoChatModels";
    case "rate_limited": return "providerCheckRateLimited";
    case "daily_quota": return "providerCheckDailyQuota";
    case "model_unavailable": return "providerCheckModelUnavailable";
    case "endpoint_unavailable": return "providerCheckEndpointUnavailable";
    case "upstream_error": return "providerCheckUpstreamError";
    case "network_error": return "providerCheckNetworkError";
    case "timeout": return "providerCheckTimeout";
    case "request_success": return "providerCheckRequestSuccess";
    case "request_error": return "providerCheckRequestError";
    case "storage_error": return "secureKeySaveFailed";
    case "empty_key": return "apiKeyEmpty";
  }
}

export function providerProbeTone(status: ProviderProbeStatus): ProviderProbeTone {
  if (status === "key_valid" || status === "request_success") return "success";
  if (status === "key_invalid" || status === "access_denied" || status === "model_unavailable") return "danger";
  return "warning";
}
