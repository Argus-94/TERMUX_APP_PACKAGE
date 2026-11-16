/** Adapter-driven, secret-safe host readiness diagnostics; performs no host actions. */
/** Fail-closed result vocabulary for one host readiness check. */
export type DiagnosticStatus = "ok" | "denied" | "offline" | "wrong-rootfs" | "unavailable" | "unknown" | "error";
/** Supported independent bootstrap diagnostic domains. */
export type DiagnosticName = "termux" | "proot" | "rootfs" | "permissions" | "network" | "storage";
/** Adapter observation containing only a status and optional scrubbed prose. */
export type DiagnosticObservation = Readonly<{ status: DiagnosticStatus; detail?: string }>;
/** Read-only host probe adapter contract; probes must not mutate host state. */
export type DiagnosticAdapter = Readonly<{ inspect(): Promise<DiagnosticObservation> }>;
/** Complete adapter set required to produce a diagnostic report. */
export type DiagnosticAdapters = Readonly<Record<DiagnosticName, DiagnosticAdapter>>;
/** Sanitized result row for a single diagnostic domain. */
export type DiagnosticEntry = Readonly<{ name: DiagnosticName; status: DiagnosticStatus; detail: string }>;
/** Human-readable and sanitized machine-readable aggregate diagnostic result. */
export type DiagnosticReport = Readonly<{ generatedAt: number; overall: "ready" | "degraded" | "blocked"; entries: readonly DiagnosticEntry[]; humanReadable: string; json: string }>;
/** Optional best-effort async event sink; sink failures never fail diagnostics. */
export type DiagnosticTimelineSink = Readonly<{ record(event: Readonly<{ type: "bootstrap-diagnostic"; name: DiagnosticName; status: DiagnosticStatus; at: number }>): Promise<void> | void }>;

const CONNECTIVITY_CHECK_URL = "https://connectivitycheck.gstatic.com/generate_204";

/** Perform a body-free connectivity check; no credentials or user data are sent. */
export async function probeInternetConnectivity(fetcher: typeof fetch | undefined = globalThis.fetch, timeoutMs = 4000): Promise<DiagnosticObservation> {
  if (typeof fetcher !== "function" || typeof AbortController !== "function") return { status: "unknown", detail: "Connectivity probing is unavailable on this runtime." };
  const controller = new AbortController();
  const timeout = Math.max(500, Math.min(15_000, Math.trunc(timeoutMs)));
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetcher(CONNECTIVITY_CHECK_URL, { method: "GET", cache: "no-store", redirect: "manual", signal: controller.signal });
    try { await response.body?.cancel(); } catch { /* response body is deliberately discarded */ }
    if (response.status === 204) return { status: "ok", detail: "Internet connectivity check succeeded (HTTP 204)." };
    return { status: "offline", detail: `Connectivity check returned HTTP ${response.status}.` };
  } catch {
    return { status: "offline", detail: "Connectivity check failed or timed out." };
  } finally {
    clearTimeout(timer);
  }
}

const names: readonly DiagnosticName[] = ["termux", "proot", "rootfs", "permissions", "network", "storage"];
const secretPatterns: readonly RegExp[] = [/(?:bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, /\b(?:token|secret|password|api[_-]?key|authorization)\s*[:=]\s*[^\s,;]+/gi, /\b[A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY)\s*=[^\s,;]+/g, /\b[A-Za-z_][A-Za-z0-9_]{0,63}\s*=\s*[^\s,;]+/g];

/** Redacts common credentials and environment assignments from diagnostic prose. */
export function sanitizeDiagnosticText(input: string): string {
  let output = input.replace(/[\u0000-\u001f\u007f]/g, " ");
  for (const pattern of secretPatterns) output = output.replace(pattern, "[redacted]");
  return output.slice(0, 240).trim();
}

/** Collects independent host probes; a failed adapter becomes an explicit error entry. */
export class BootstrapDiagnostics {
  /** Creates a diagnostic collector with host-supplied adapters and optional timeline. */
  constructor(private readonly adapters: DiagnosticAdapters, private readonly timeline?: DiagnosticTimelineSink) {}

  /** Produces human-readable and sanitized JSON diagnostics without throwing adapter errors. */
  async collect(): Promise<DiagnosticReport> {
    const entries: DiagnosticEntry[] = [];
    for (const name of names) {
      let observation: DiagnosticObservation;
      try { observation = await this.adapters[name].inspect(); }
      catch { observation = { status: "error", detail: "Diagnostic adapter failed." }; }
      const status: DiagnosticStatus = observation && ["ok", "denied", "offline", "wrong-rootfs", "unavailable", "unknown", "error"].includes(observation.status) ? observation.status : "unknown";
      const detail = sanitizeDiagnosticText(typeof observation?.detail === "string" ? observation.detail : "No additional detail.");
      const entry: DiagnosticEntry = { name, status, detail };
      entries.push(entry);
      try { await this.timeline?.record({ type: "bootstrap-diagnostic", name, status, at: Date.now() }); } catch { /* optional sink is non-critical */ }
    }
    const blocked = entries.some((entry) => entry.status === "denied" || entry.status === "wrong-rootfs" || entry.status === "error");
    const degraded = entries.some((entry) => entry.status !== "ok");
    const overall = blocked ? "blocked" : degraded ? "degraded" : "ready";
    const humanReadable = entries.map((entry) => `${entry.name}: ${entry.status} — ${entry.detail}`).join("\n");
    const safeEntries = entries.map(({ name, status, detail }) => ({ name, status, detail }));
    return { generatedAt: Date.now(), overall, entries, humanReadable, json: JSON.stringify({ generatedAt: Date.now(), overall, entries: safeEntries }) };
  }
}
