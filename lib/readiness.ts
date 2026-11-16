import { checkTermuxReadiness } from "./termux-bridge";

export type ReadyLevel = "ok" | "warn" | "bad" | "off";

export interface ReadyItem {
  id: string;
  level: ReadyLevel;
  label: string;
}

export interface ReadinessSnapshot {
  items: ReadyItem[];
  /** short one-line summary */
  summary: string;
}

export type ReadyMode = "local" | "online" | "custom" | "opencode" | "manus";

export async function computeReadiness(opts: {
  /** OpenRouter / online key present */
  hasApiKey: boolean;
  /** Custom provider (slot 1 or 2) key present */
  hasCustomApiKey?: boolean;
  /** OpenCode key present */
  hasOpenCodeApiKey?: boolean;
  hasManusApiKey?: boolean;
  mode: ReadyMode;
  localLoaded: boolean;
  localDownloaded: boolean;
  termuxEnabled: boolean;
  labels: {
    api: string;
    modelOnline: string;
    modelOffline: string;
    modelOfflineNeed: string;
    modelCustom?: string;
    modelOpenCode?: string;
    modelManus?: string;
    cloudApiSaved?: string;
    cloudNoKey?: string;
    cloudLocalUnused?: string;
    termuxOn: string;
    termuxOff: string;
    termuxNotReady: string;
  };
}): Promise<ReadinessSnapshot> {
  const items: ReadyItem[] = [];
  const mode = opts.mode;
  if (mode === "manus") {
    return {
      items: [
        { id: "api", level: opts.hasManusApiKey ? "warn" : "bad", label: opts.hasManusApiKey ? (opts.labels.cloudApiSaved || "API key saved; account not checked here") : (opts.labels.cloudNoKey || "API key not saved") },
        { id: "model", level: "off", label: opts.labels.modelManus || "Manus · cloud task" },
        { id: "termux", level: "off", label: opts.labels.cloudLocalUnused || "Local Termux not used" },
      ], summary: [opts.labels.modelManus || "Manus · cloud task", opts.hasManusApiKey ? (opts.labels.cloudApiSaved || "API key saved; account not checked here") : (opts.labels.cloudNoKey || "API key not saved"), opts.labels.cloudLocalUnused || "Local Termux not used"].join(" · "),
    };
  }

  const effectiveApi =
    mode === "custom"
      ? !!opts.hasCustomApiKey
      : mode === "opencode"
        ? !!opts.hasOpenCodeApiKey
        : mode === "online"
          ? opts.hasApiKey
          : opts.hasApiKey || !!opts.hasCustomApiKey;

  items.push({
    id: "api",
    level: effectiveApi
      ? "ok"
      : mode === "local"
        ? "warn"
        : "bad",
    label: opts.labels.api + (effectiveApi ? " ✓" : " —"),
  });

  if (mode === "online") {
    items.push({
      id: "model",
      level: opts.hasApiKey ? "ok" : "bad",
      label: opts.labels.modelOnline,
    });
  } else if (mode === "custom") {
    items.push({
      id: "model",
      level: opts.hasCustomApiKey ? "ok" : "bad",
      label: opts.labels.modelCustom || "Custom",
    });
  } else if (mode === "opencode") {
    items.push({
      id: "model",
      level: opts.hasOpenCodeApiKey ? "ok" : "bad",
      label: opts.labels.modelOpenCode || "OpenCode",
    });
  } else {
    items.push({
      id: "model",
      level: opts.localLoaded ? "ok" : opts.localDownloaded ? "warn" : "bad",
      label: opts.localLoaded
        ? opts.labels.modelOffline
        : opts.labels.modelOfflineNeed,
    });
  }

  if (opts.termuxEnabled) {
    const r = await checkTermuxReadiness();
    items.push({
      id: "termux",
      level: r.ready ? "ok" : "bad",
      label: r.ready ? opts.labels.termuxOn : opts.labels.termuxNotReady,
    });
  } else {
    items.push({
      id: "termux",
      level: "off",
      label: opts.labels.termuxOff,
    });
  }

  const summary = items.map((i) => i.label).join(" · ");
  return { items, summary };
}


/** Aggregate worst level for UI badge. */
export function overallReadyLevel(items: ReadyItem[]): ReadyLevel {
  if (items.some((i) => i.level === "bad")) return "bad";
  if (items.some((i) => i.level === "warn")) return "warn";
  if (items.some((i) => i.level === "off")) return "off";
  return "ok";
}
