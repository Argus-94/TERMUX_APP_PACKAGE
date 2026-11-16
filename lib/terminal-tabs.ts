/**
 * Multi-tab terminal session model (UI state). Execution still goes through Termux bridge.
 */
export type TerminalTab = {
  id: string;
  title: string;
  cwdHint?: string;
  draft: string;
  history: string[];
  createdAt: number;
};

let seq = 0;

export function createTerminalTab(title?: string): TerminalTab {
  seq += 1;
  return {
    id: `tab-${Date.now()}-${seq}`,
    title: title || `Term ${seq}`,
    draft: "",
    history: [],
    createdAt: Date.now(),
  };
}

/** Reuse lowest free display number for titles Term 1, Term 2, … */
export function nextTerminalTitle(existing: TerminalTab[]): string {
  const used = new Set(
    existing
      .map((t) => {
        const m = /^Term\s+(\d+)$/i.exec(t.title);
        return m ? Number(m[1]) : 0;
      })
      .filter(Boolean),
  );
  let n = 1;
  while (used.has(n)) n += 1;
  return `Term ${n}`;
}
