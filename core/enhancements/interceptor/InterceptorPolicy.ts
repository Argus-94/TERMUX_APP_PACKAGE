import type { InterceptorSource, InterceptorTimeline } from "./types";
import type { InterceptorRuntimeAdapter } from "./types";
import { isNativePinnedEgressFetcher, isNativePinnedListenerTransport } from "./NativeEgressTransportAttestation";

export const INTERCEPTOR_CAPABILITY = "network.intercept" as const;
const BUILTIN_SENSITIVE_HOSTS = Object.freeze([
  "accounts.google.com", "login.microsoftonline.com", "paypal.com", "stripe.com",
  "wise.com", "venmo.com", "cash.app", "1password.com", "bitwarden.com",
  "vault.azure.net", "login.gov", "healthcare.gov",
]);
const SENSITIVE_LABEL = /(?:^|[.-])(?:bank|banking|wallet|payment|medical|healthcare|patient|insurance)(?:[.-]|$)/i;

export type InterceptorPolicyResult = Readonly<{ allowed: boolean; reason?: string }>;
export type InterceptorEgressTransport = Readonly<{ fetcher?: typeof fetch; runtimeAdapter?: InterceptorRuntimeAdapter }>;

/** Fail-closed policy. Consent is memory-only and must be granted by an explicit user UI action. */
export class InterceptorPolicy {
  private userConsent = false;
  private readonly extraDeniedHosts = new Set<string>();

  constructor(private readonly record?: InterceptorTimeline) {}

  get isUserConsentGranted(): boolean { return this.userConsent; }

  async confirmUserEnable(confirmed: boolean): Promise<InterceptorPolicyResult> {
    if (!confirmed) return this.deny("enable", "USER_CONFIRMATION_REQUIRED", "user");
    this.userConsent = true;
    await this.audit({ operation: "enable-consent", outcome: "allowed", source: "user" });
    return { allowed: true };
  }

  async revokeUserConsent(): Promise<void> {
    this.userConsent = false;
    await this.audit({ operation: "revoke-consent", outcome: "allowed", source: "user" });
  }

  async authorize(operation: string, source: InterceptorSource | "runtime", capability: boolean, targetUrl?: string, transport?: InterceptorEgressTransport): Promise<InterceptorPolicyResult> {
    if (!capability) return this.deny(operation, "CAPABILITY_REQUIRED", source);
    if (!this.userConsent) return this.deny(operation, "USER_CONSENT_REQUIRED", source);
    if (targetUrl) {
      const blocked = this.deniedHostReason(targetUrl);
      if (blocked) return this.deny(operation, blocked, source, { host: safeHostname(targetUrl) });
      const operationName = operation.toLowerCase();
      // Passive observation does not open an upstream socket. Egress trust is
      // bound to the concrete fetcher; CONNECT is bound to the exact native
      // listener/fetcher pair. A caller-supplied boolean can never grant trust.
      const hasPinnedTransport = operationName === "connect-tunnel" || operationName === "mitm-transport"
        ? isNativePinnedListenerTransport(transport?.runtimeAdapter, transport?.fetcher)
        : isNativePinnedEgressFetcher(transport?.fetcher);
      if (operationName !== "capture" && operationName !== "capture-request" && !isIpAddressLiteral(safeHostname(targetUrl)) && !hasPinnedTransport) {
        return this.deny(operation, "DNS_TARGET_VALIDATION_UNAVAILABLE", source, { host: safeHostname(targetUrl) });
      }
    }
    await this.audit({ operation, outcome: "allowed", source: timelineSource(source) });
    return { allowed: true };
  }

  /** Add a user-managed denial; built-in sensitive entries cannot be removed. */
  async addDeniedHost(host: string, source: InterceptorSource = "user"): Promise<void> {
    const normalized = normalizeHost(host);
    if (!normalized) throw new Error("INTERCEPTOR_HOST_INVALID");
    this.extraDeniedHosts.add(normalized);
    await this.audit({ operation: "deny-host-add", outcome: "allowed", source: timelineSource(source), details: { host: normalized } });
  }

  isSensitiveUrl(url: string): boolean { return this.deniedHostReason(url) !== undefined; }

  private deniedHostReason(rawUrl: string): string | undefined {
    let parsed: URL;
    try { parsed = new URL(rawUrl); } catch { return "URL_INVALID"; }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "PROTOCOL_DENIED";
    if (parsed.username || parsed.password) return "URL_CREDENTIALS_DENIED";
    // Never capture the app's secret-bearing native CredentialProxy endpoints.
    if ((parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost") && /^\/v1\/session\//.test(parsed.pathname)) return "CREDENTIAL_PROXY_EXCLUDED";
    const host = parsed.hostname.toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
    if (isLocalOrNonPublicHost(host)) return "PRIVATE_NETWORK_TARGET_DENIED";
    if (BUILTIN_SENSITIVE_HOSTS.some((entry) => host === entry || host.endsWith(`.${entry}`)) || SENSITIVE_LABEL.test(host)) return "SENSITIVE_DOMAIN_DENIED";
    if ([...this.extraDeniedHosts].some((entry) => host === entry || host.endsWith(`.${entry}`))) return "USER_DENIED_DOMAIN";
    return undefined;
  }

  private async deny(operation: string, reason: string, source: InterceptorSource | "runtime", details?: Readonly<Record<string, unknown>>): Promise<InterceptorPolicyResult> {
    await this.audit({ operation, outcome: "denied", reason, source: timelineSource(source), ...(details ? { details } : {}) });
    return { allowed: false, reason };
  }
  private async audit(event: Parameters<NonNullable<InterceptorTimeline>>[0]): Promise<void> {
    try { await this.record?.(event); } catch { /* a telemetry failure never relaxes policy */ }
  }
}

function normalizeHost(input: string): string | null {
  const value = input.trim().toLowerCase().replace(/^\*\./, "").replace(/\.$/, "");
  if (!value || value.length > 253 || !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/.test(value)) return null;
  return value;
}
function isLocalOrNonPublicHost(input: string): boolean {
  const host = input.replace(/^\[|\]$/g, "").replace(/%[0-9a-z._-]+$/i, "").replace(/\.$/, "").toLowerCase();
  if (!host.includes(":")) {
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".home.arpa") || host.endsWith(".lan") || !host.includes(".")) return true;
    const octets = host.split(".").map(Number);
    if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return false;
    const [a, b, c] = octets;
    return a === 0 || a === 10 || a === 127 || (a === 100 && b! >= 64 && b! <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b! >= 16 && b! <= 31) ||
      (a === 192 && (b === 168 || (b === 0 && c === 0) || (b === 0 && c === 2))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113) || a! >= 224;
  }
  // IPv6 is allowed only from the global-unicast 2000::/3 block; explicitly
  // reject special-use ranges that sit inside that block as well.
  const first = Number.parseInt(host.split(":")[0] || "0", 16);
  if (!Number.isFinite(first) || first < 0x2000 || first > 0x3fff) return true;
  return host.startsWith("2001:db8:") || host.startsWith("2001:10:") || host.startsWith("2001:20:") || host.startsWith("2002:") || host.startsWith("64:ff9b:");
}
function isIpAddressLiteral(input: string): boolean {
  const host = input.replace(/^\[|\]$/g, "").replace(/%[0-9a-z._-]+$/i, "");
  return host.includes(":") || /^(?:\d{1,3}\.){3}\d{1,3}$/.test(host);
}
function safeHostname(raw: string): string { try { return new URL(raw).hostname.slice(0, 253); } catch { return "invalid"; } }
function timelineSource(source: InterceptorSource | "runtime"): "user" | "agent" | "runtime" { return source === "preset" ? "user" : source; }
