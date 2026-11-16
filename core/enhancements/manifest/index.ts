import { parseManifest } from "./ManifestParser";
import { validateManifest } from "./RuntimeManifest";
import { getRuntimePreset, runtimePresetNames } from "./Presets";
import type { RuntimeManifest as RuntimeManifestSchema } from "./types";

export { parseManifest } from "./ManifestParser";
export { validateManifest, applyManifest } from "./RuntimeManifest";
export { getRuntimePreset, runtimePresetNames } from "./Presets";
export const Presets = Object.freeze({ names: runtimePresetNames, get: getRuntimePreset });
/** Value namespace paired with the `RuntimeManifest` schema type. */
export const RuntimeManifest = Object.freeze({ parse: parseManifest, validate: validateManifest });
export { ManifestError } from "./types";
export type RuntimeManifest = RuntimeManifestSchema;
export type { ManifestProcess, ValidationIssue, ValidationResult, ManifestProcessAdapter } from "./types";
export type { ManifestCapability } from "./types";
export type { RuntimePreset, RuntimePresetName } from "./Presets";
