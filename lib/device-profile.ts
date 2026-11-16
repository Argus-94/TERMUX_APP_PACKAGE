import { Platform } from "react-native";
import * as Device from "expo-device";
import type { TranslationKey } from "./i18n";

/**
 * Определение параметров телефона для автонастройки офлайн-модели.
 *
 * expo-device не даёт числа ядер CPU напрямую (такого кросс-платформенного
 * API в React Native нет), поэтому количество потоков (n_threads) оценивается
 * по объёму ОЗУ (Device.totalMemory) — на практике это неплохой показатель
 * класса устройства: телефоны с 3-4 ГБ почти всегда 4-ядерные/слабые,
 * 6-8 ГБ — обычно 6-8 ядер, 12+ ГБ — топовые SoC с 8 быстрыми ядрами.
 */

export interface DeviceProfile {
  totalMemoryBytes: number | null;
  totalMemoryGB: number | null;
  modelName: string | null;
  manufacturer: string | null;
  osVersion: string | null;
  isPhysicalDevice: boolean;
  supportedCpuArchitectures: string[] | null;
  /** false только если явно обнаружена 32-битная сборка без arm64 — llama.rn требует arm64-v8a */
  isArm64Compatible: boolean;
}

export interface RecommendedModelSettings {
  nCtx: number;
  nThreads: number;
  nGpuLayers: number;
  /** Generation defaults tuned with the same auto-pass. */
  temperature: number;
  maxTokens: number;
  topP: number;
  tier: "low" | "medium" | "high" | "unknown";
  /** Ключ перекладу для пояснювального тексту — фінальний рядок збирається
   *  на екрані (useLanguage().t(noteKey, noteParams)) так, щоб він одразу
   *  реагував на зміну мови додатку, а не "застигав" мовою, яка була
   *  активна в момент визначення параметрів телефону. */
  noteKey: TranslationKey;
  noteParams?: Record<string, string | number>;
  /** Short machine summary for the main log. */
  reason?: string;
}

/** Facts about the on-disk GGUF used to refine auto settings. */
export type ModelAnalysis = {
  fileBytes: number;
  quant?: string;
  /** Approximate parameter count in billions (from filename 0.5b / 3b / 7b). */
  paramsB?: number;
  displayName?: string;
  hasMmproj?: boolean;
};

/**
 * Parse GGUF file name + size into analysis (no need to read tensor headers).
 */
export function analyzeGgufModel(
  fileName: string,
  fileBytes: number,
  opts?: { hasMmproj?: boolean },
): ModelAnalysis {
  const base = String(fileName || "").trim().replace(/\.gguf$/i, "");
  let quant: string | undefined;
  const qMatch = base.match(/[-_.](iq\d+[_\w]*|q\d+_k_[sml]|q\d+_0|q\d+_1|f16|f32)$/i);
  if (qMatch) quant = qMatch[1].toUpperCase().replace(/-/g, "_");

  let paramsB: number | undefined;
  const sMatch = base.match(/(\d+(?:\.\d+)?)\s*b\b/i);
  if (sMatch) paramsB = parseFloat(sMatch[1]);
  // Heuristic from size if name has no "Xb"
  if (paramsB == null && fileBytes > 0) {
    const gb = fileBytes / 1024 ** 3;
    // Rough Q4 sizes: 0.5B~0.35GB, 1.5B~1GB, 3B~2GB, 7B~4.5GB
    if (gb < 0.6) paramsB = 0.5;
    else if (gb < 1.4) paramsB = 1.5;
    else if (gb < 3.2) paramsB = 3;
    else if (gb < 6) paramsB = 7;
    else paramsB = 13;
  }

  return {
    fileBytes: Math.max(0, fileBytes | 0),
    quant,
    paramsB,
    displayName: base || undefined,
    hasMmproj: !!opts?.hasMmproj,
  };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Подбирает параметры офлайн-модели под ОЗУ телефона + размер/квант модели.
 * n_gpu_layers по умолчанию 0 (стабильность Mali/Adreno offline).
 */
export function recommendModelSettings(
  profile: DeviceProfile,
  model?: ModelAnalysis | null,
): RecommendedModelSettings {
  const gb = profile.totalMemoryGB;
  const modelGb = model && model.fileBytes > 0 ? model.fileBytes / 1024 ** 3 : 0;
  const paramsB = model?.paramsB;
  const quant = (model?.quant || "").toUpperCase();
  const ramGb = gb ?? 6;
  const weightGb = modelGb > 0 ? modelGb : paramsB != null ? paramsB * 0.55 : 1.0;

  // --- Phone tier by RAM ---
  let tier: RecommendedModelSettings["tier"] = "unknown";
  let noteKey: TranslationKey = "deviceNoteUnknown";
  const noteParams: Record<string, string | number> = {};
  if (gb != null) {
    noteParams.gb = gb.toFixed(1);
    if (gb < 4) {
      tier = "low";
      noteKey = "deviceNoteLow1";
    } else if (gb < 6) {
      tier = "low";
      noteKey = "deviceNoteLow2";
    } else if (gb < 8) {
      tier = "medium";
      noteKey = "deviceNoteMedium";
    } else if (gb < 12) {
      tier = "high";
      noteKey = "deviceNoteHigh";
    } else {
      tier = "high";
      noteKey = "deviceNoteFlagship";
    }
  }

  // Headroom: OS + UI + Termux ~1.5–2 GB; KV cache scales with n_ctx
  const freeAfterModel = Math.max(0.4, ramGb - weightGb - 1.8);

  // --- Context: small models on mid phones → lower ctx (agent system prompt is huge) ---
  let nCtx = 2048;
  if (paramsB != null) {
    if (paramsB <= 0.6) {
      // 0.5B: can use more ctx if RAM allows
      nCtx = freeAfterModel >= 3 ? 4096 : freeAfterModel >= 2 ? 3072 : 2048;
    } else if (paramsB <= 1.8) {
      // 1–1.5B (Qwen Coder 1.5B): stability > long ctx on phones ≤8 GB
      if (ramGb < 5) nCtx = 1536;
      else if (ramGb < 8) nCtx = 2048;
      else if (ramGb < 12) nCtx = 2560;
      else nCtx = 3072;
    } else if (paramsB <= 3.5) {
      if (ramGb < 6) nCtx = 1536;
      else if (ramGb < 8) nCtx = 2048;
      else if (ramGb < 12) nCtx = 3072;
      else nCtx = 4096;
    } else if (paramsB <= 8) {
      if (ramGb < 8) nCtx = 1536;
      else if (ramGb < 12) nCtx = 2048;
      else nCtx = 3072;
    } else {
      // 13B+
      nCtx = ramGb >= 12 ? 2048 : 1536;
    }
  } else {
    // No model info: conservative by phone only
    if (ramGb < 4) nCtx = 1536;
    else if (ramGb < 7) nCtx = 2048;
    else if (ramGb < 10) nCtx = 2560;
    else nCtx = 3072;
  }

  // Quant weight: heavier quants need lower ctx
  if (/F16|F32/.test(quant)) nCtx = Math.floor(nCtx * 0.7);
  else if (/Q8|Q6_K|Q5/.test(quant)) nCtx = Math.floor(nCtx * 0.85);
  else if (/Q2|Q3|IQ2|IQ3/.test(quant)) nCtx = Math.floor(nCtx * 1.05);

  // Hard cap by free RAM (empirical KV budget)
  const ctxCap = Math.max(1024, Math.floor(freeAfterModel * 700));
  nCtx = clamp(nCtx, 1024, ctxCap);
  nCtx = Math.max(1024, Math.floor(nCtx / 256) * 256);

  // --- Threads: leave cores for UI; fewer for tiny models (less parallel gain) ---
  let nThreads = 3;
  if (ramGb < 4) nThreads = 2;
  else if (ramGb < 6) nThreads = 3;
  else if (ramGb < 8) nThreads = paramsB != null && paramsB <= 1.8 ? 3 : 4;
  else if (ramGb < 12) nThreads = 4;
  else nThreads = 6;
  if (paramsB != null && paramsB <= 1.0 && nThreads > 3) nThreads = 3;

  // --- Generation: short answers for small models (TERMUX_RUN one-liners) ---
  let temperature = 0.3;
  let topP = 0.9;
  let maxTokens = 768;
  if (paramsB != null && paramsB <= 1.8) {
    temperature = 0.25;
    topP = 0.85;
    maxTokens = clamp(Math.floor(nCtx * 0.35), 384, 768);
  } else if (paramsB != null && paramsB <= 4) {
    temperature = 0.3;
    maxTokens = clamp(Math.floor(nCtx * 0.4), 512, 1024);
  } else {
    temperature = 0.3;
    maxTokens = clamp(Math.floor(nCtx * 0.4), 512, 1536);
  }

  const reasonParts = [
    gb != null ? `ram=${gb.toFixed(1)}GB` : "ram=?",
    modelGb > 0 ? `weights=${modelGb.toFixed(2)}GB` : null,
    paramsB != null ? `~${paramsB}B` : "model=?",
    quant || null,
    `n_ctx=${nCtx}`,
    `threads=${nThreads}`,
    `maxTok=${maxTokens}`,
    `temp=${temperature}`,
  ].filter(Boolean);

  return {
    nCtx,
    nThreads,
    nGpuLayers: 0,
    temperature,
    maxTokens,
    topP,
    tier,
    noteKey,
    noteParams: Object.keys(noteParams).length ? noteParams : undefined,
    reason: reasonParts.join(" "),
  };
}



export async function getDeviceProfile(_forceRefresh = false): Promise<DeviceProfile> {
  let totalMemoryBytes: number | null = null;
  try {
    const tm = (Device as { totalMemory?: number | null }).totalMemory;
    if (typeof tm === "number" && Number.isFinite(tm) && tm > 0) {
      totalMemoryBytes = tm;
    }
  } catch {
    totalMemoryBytes = null;
  }
  const totalMemoryGB =
    totalMemoryBytes != null ? Math.round((totalMemoryBytes / (1024 ** 3)) * 100) / 100 : null;

  let supportedCpuArchitectures: string[] | null = null;
  try {
    const arch = (Device as { supportedCpuArchitectures?: string[] | null }).supportedCpuArchitectures;
    if (Array.isArray(arch) && arch.length) supportedCpuArchitectures = arch.map(String);
  } catch {
    supportedCpuArchitectures = null;
  }

  const isArm64Compatible = !(
    supportedCpuArchitectures &&
    supportedCpuArchitectures.length > 0 &&
    !supportedCpuArchitectures.some((a) => /arm64|aarch64/i.test(a)) &&
    supportedCpuArchitectures.some((a) => /armeabi|armv7|x86(?!_64)/i.test(a))
  );

  return {
    totalMemoryBytes,
    totalMemoryGB,
    modelName: (Device as { modelName?: string | null }).modelName ?? null,
    manufacturer: (Device as { manufacturer?: string | null }).manufacturer ?? null,
    osVersion: (Device as { osVersion?: string | null }).osVersion ?? Platform.Version?.toString?.() ?? null,
    isPhysicalDevice: !!(Device as { isDevice?: boolean }).isDevice,
    supportedCpuArchitectures,
    isArm64Compatible,
  };
}

/**
 * Профиль «телефон слабый» для Gradle (priority #9):
 * меньше parallel, offline если кэш есть. Не переписывает gradle.properties проекта —
 * только флаги CLI при запуске.
 */
export function getWeakPhoneGradleFlags(profile?: DeviceProfile | null): string[] {
  const gb = profile?.totalMemoryGB ?? null;
  const flags: string[] = [];
  // Always safe
  flags.push("--no-daemon");
  if (gb != null && gb < 4) {
    // Very weak: aggressive heap + single worker (OOM loop prevention)
    flags.push("--max-workers=1");
    flags.push("-Dorg.gradle.parallel=false");
    flags.push("-Dorg.gradle.configureondemand=false");
    flags.push("-Dorg.gradle.jvmargs=-Xmx768m");
  } else if (gb == null || gb < 6) {
    flags.push("--max-workers=2");
    flags.push("-Dorg.gradle.parallel=false");
    flags.push("-Dorg.gradle.jvmargs=-Xmx1536m");
  } else if (gb < 8) {
    flags.push("--max-workers=3");
    flags.push("-Dorg.gradle.jvmargs=-Xmx2048m");
  }
  return flags;
}

/** Shell snippet: detect gradle cache and optionally --offline */
export function getGradleOfflineHintShell(): string {
  return (
    'GH="${GRADLE_USER_HOME:-$HOME/.aibuilder-gradle}"; ' +
    'if [ -d "$GH/caches/modules-2" ] && [ "$(find "$GH/caches/modules-2" -type f 2>/dev/null | head -5 | wc -l)" -ge 3 ]; then ' +
    'echo GRADLE_CACHE_HIT; else echo GRADLE_CACHE_MISS; fi'
  );
}
