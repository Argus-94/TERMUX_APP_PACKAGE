/** Conservative first-run defaults inferred only from explicitly detected capabilities. */

/** Backend and feature signals that the caller actually detected. */
export type BackendCandidate = Readonly<{ id: string; healthy: boolean; capabilities: readonly string[] }>;
/** Explicit model and connectivity facts; omitted values remain unknown. */
export type SmartDefaultsInput = Readonly<{
  backends: readonly BackendCandidate[];
  online: boolean | "unknown";
  onlineProviderConfigured?: boolean | "unknown";
  offlineModelAvailable?: boolean;
}>;
/** Minimal security-first backend, model, preset, and connectivity recommendation. */
export type SmartDefaultsRecommendation = Readonly<{
  backend: "termux-native" | "proot-distro" | "unavailable";
  security: "strict";
  preset: "minimal";
  performanceMode: "Balanced";
  applied?: Readonly<{ performanceMode: boolean; recommendationPersisted: boolean; existingSelectionPreserved: boolean }>;
  models: Readonly<{
    online: "configured-provider" | "configured-but-offline" | "optional-unconfigured" | "provider-configuration-unknown";
    offline: "local-model-available" | "local-model-on-demand" | "not-probed";
  }>;
  hints: readonly string[];
  detectedCapabilities: readonly string[];
}>;

/** A positive probe wins; otherwise any inaccessible secure-store result remains unknown. */
export function summarizeProviderConfiguration(probes: readonly (boolean | "unknown")[]): boolean | "unknown" {
  if (probes.includes(true)) return true;
  return probes.includes("unknown") ? "unknown" : false;
}

/** Recommends only a healthy backend with detected execution capabilities. */
export function recommendSmartDefaults(input: SmartDefaultsInput): SmartDefaultsRecommendation {
  const termux = input.backends.find((backend) => backend.id === "termux-native" && backend.healthy && backend.capabilities.includes("termux-native-execution"));
  const proot = input.backends.some((backend) => backend.id === "proot-distro" && backend.healthy);
  const backend = termux ? "termux-native" : proot ? "proot-distro" : "unavailable";
  const detectedCapabilities = input.backends.filter((candidate) => candidate.healthy).flatMap((candidate) => candidate.capabilities).filter((capability, index, all) => all.indexOf(capability) === index);
  const hints = input.online === true
    ? ["Online availability detected; optional downloads may be offered when requested."]
    : input.online === false
      ? ["Offline mode detected; prefer cached or locally installed resources."]
      : ["Network state is unknown; verify connectivity before optional downloads."];
  if (input.onlineProviderConfigured === undefined || input.onlineProviderConfigured === "unknown") {
    hints.push("Secure credential-store availability could not be confirmed; online provider setup status is unknown.");
  }
  if (backend === "unavailable") hints.push("No usable execution backend was detected; setup remains unavailable until one passes its health probe.");
  return {
    backend,
    security: "strict",
    preset: "minimal",
    performanceMode: "Balanced",
    models: {
      online: input.onlineProviderConfigured === true
        ? input.online === false ? "configured-but-offline" : "configured-provider"
        : input.onlineProviderConfigured === false ? "optional-unconfigured" : "provider-configuration-unknown",
      offline: input.offlineModelAvailable === true ? "local-model-available" : input.offlineModelAvailable === false ? "local-model-on-demand" : "not-probed",
    },
    hints,
    detectedCapabilities,
  };
}
