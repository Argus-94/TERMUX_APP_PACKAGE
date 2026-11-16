/**
 * Fast Path metrics — how often Native Priority routes to host Termux vs proot.
 */

export type FastPathSnapshot = {
  hostTermux: number;
  ubuntuProot: number;
  fastPathHits: number;
  lastBackend: "termux" | "ubuntu-proot" | null;
  lastAt: number | null;
};

let snapshot: FastPathSnapshot = {
  hostTermux: 0,
  ubuntuProot: 0,
  fastPathHits: 0,
  lastBackend: null,
  lastAt: null,
};

export function recordFastPathExecution(
  executionBackend: "termux" | "ubuntu-proot",
  preferredBackend: "termux" | "ubuntu-proot",
): void {
  if (executionBackend === "termux") snapshot.hostTermux += 1;
  else snapshot.ubuntuProot += 1;
  if (preferredBackend === "ubuntu-proot" && executionBackend === "termux") {
    snapshot.fastPathHits += 1;
  }
  snapshot.lastBackend = executionBackend;
  snapshot.lastAt = Date.now();
}

export function getFastPathSnapshot(): FastPathSnapshot {
  return { ...snapshot };
}

export function resetFastPathMetrics(): void {
  snapshot = {
    hostTermux: 0,
    ubuntuProot: 0,
    fastPathHits: 0,
    lastBackend: null,
    lastAt: null,
  };
}

export function formatFastPathMetricsBlock(s: FastPathSnapshot = getFastPathSnapshot()): string {
  const total = s.hostTermux + s.ubuntuProot;
  const pct = total > 0 ? Math.round((s.fastPathHits / total) * 100) : 0;
  return [
    "[FAST_PATH_METRICS]",
    `host_termux=${s.hostTermux}`,
    `ubuntu_proot=${s.ubuntuProot}`,
    `fast_path_hits=${s.fastPathHits}`,
    `fast_path_pct=${pct}`,
    `last=${s.lastBackend || "none"}`,
  ].join("\n");
}

export function fastPathMetricsOneLiner(s: FastPathSnapshot = getFastPathSnapshot()): string {
  const total = s.hostTermux + s.ubuntuProot;
  return `fast_path host=${s.hostTermux} proot=${s.ubuntuProot} hits=${s.fastPathHits}/${total || 0}`;
}
