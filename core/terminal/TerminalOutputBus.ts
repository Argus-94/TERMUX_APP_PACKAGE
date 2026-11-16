/**
 * Lightweight bus for terminal/runtime output into JS console listeners.
 * Bridges to termux-bridge emitJsConsoleEvent when available.
 */

export type TerminalBusEvent = {
  sessionId?: string;
  stream: "stdout" | "stderr" | "system";
  data: string;
};

type Listener = (event: TerminalBusEvent) => void;

const listeners = new Set<Listener>();

export function subscribeTerminalOutput(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function publishTerminalOutput(event: TerminalBusEvent): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      // ignore listener errors
    }
  }
  // Best-effort bridge into Termux JS console panel
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const bridge = require("../../lib/termux-bridge") as {
      emitJsConsoleEvent?: (e: {
        stream: string;
        chunk: string;
        cmdId?: string;
      }) => void;
    };
    if (bridge.emitJsConsoleEvent) {
      bridge.emitJsConsoleEvent({
        stream: event.stream === "stderr" ? "stderr" : "stdout",
        chunk: event.data,
        cmdId: event.sessionId,
      });
    }
  } catch {
    // native/js bridge may be absent in pure node selftests
  }
}
