import { getEmbeddedTermuxRuntimeStatus } from "./termux-bridge";

export type AddonId = "termux" | "shizuku" | "termuxBoot";
export interface AddonStatus { installed: boolean; version: string | null }
const UNSUPPORTED = "UNSUPPORTED_EXTERNAL_ADDON_ACTION: only AI Builder's embedded private runtime is supported; external add-ons are disabled.";
function rejectExternal(): never { throw new Error(UNSUPPORTED); }

/** ABI probing is irrelevant to the bundled arm64 private runtime. */
export async function getSupportedAbis(): Promise<string[]> { return []; }
/** Retain legacy UI contract: 'termux' now means the embedded runtime only. */
export async function getAddonStatus(id: AddonId): Promise<AddonStatus> {
  if (id !== "termux") return { installed: false, version: null };
  const runtime = await getEmbeddedTermuxRuntimeStatus();
  return { installed: runtime?.ready === true, version: runtime?.bootstrapVersion || null };
}
export async function canInstallPackages(): Promise<boolean> { return false; }
export async function openUnknownSourcesSettings(): Promise<boolean> { return false; }
export async function downloadAddon(_id: AddonId, _onProgress?: (progress: number) => void): Promise<{ version: string; assetName: string; uri: string }> { return rejectExternal(); }
export async function cancelAddonDownload(): Promise<void> { /* no download exists */ }
export async function launchApkInstall(_uri: string, _id?: AddonId): Promise<void> { rejectExternal(); }
/** @deprecated External APK installation is unsupported. */
export async function downloadAndInstallAddon(_id: AddonId, _onProgress?: (progress: number) => void): Promise<{ version: string; assetName: string; uri: string }> { return rejectExternal(); }
/** External fallback pages are deliberately not exposed. */
export function getAddonFallbackPage(_id: AddonId): string { return ""; }
