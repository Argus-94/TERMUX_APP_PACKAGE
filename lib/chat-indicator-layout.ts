export type InterceptorUiSnapshot = Readonly<{
  status?: string;
  address?: string;
  port?: number;
}>;

export type InterceptorIndicatorState = "running" | "starting" | "stopping" | "error" | "unsupported" | "stopped";

/** Accent is allowed only after the adapter has confirmed the exact loopback listener. */
export function isInterceptorListenerLive(snapshot: InterceptorUiSnapshot | null | undefined): boolean {
  return !!snapshot &&
    (snapshot.status === "listening" || snapshot.status === "capturing") &&
    snapshot.address === "127.0.0.1" &&
    Number.isInteger(snapshot.port) &&
    (snapshot.port as number) >= 1 &&
    (snapshot.port as number) <= 65535;
}

/** UI state is derived from the engine's native-confirmed listener snapshot, never saved intent. */
export function getInterceptorIndicatorState(snapshot: InterceptorUiSnapshot | null | undefined): InterceptorIndicatorState {
  if (isInterceptorListenerLive(snapshot)) return "running";
  if (!snapshot) return "stopped";
  if (snapshot.status === "starting" || snapshot.status === "stopping" || snapshot.status === "error" || snapshot.status === "unsupported") return snapshot.status;
  // A claimed listening/capturing state without the verified loopback endpoint is a failure, not live.
  if (snapshot.status === "listening" || snapshot.status === "capturing") return "error";
  return "stopped";
}

export type IndicatorBodyAllocation = Readonly<{
  buildBodyHeight: number;
  thinkingBodyHeight: number;
  equalShare: boolean;
}>;

/**
 * Reserve room for the readiness row and a usable message list. With both
 * panels expanded, their complete heights (header + body) are equal halves;
 * different header heights are subtracted from each body's share. A single
 * open panel gets the remaining viewport up to the comfortable 320px cap.
 */
export function allocateIndicatorBodyHeights(
  chatViewportHeight: number,
  options: Readonly<{
    buildVisible: boolean;
    thinkingVisible: boolean;
    buildExpanded: boolean;
    thinkingExpanded: boolean;
  }>,
): IndicatorBodyAllocation {
  const viewport = Number.isFinite(chatViewportHeight) ? Math.max(0, Math.floor(chatViewportHeight)) : 0;
  const readinessHeight = 36;
  const messageReserve = 80;
  const buildHeader = 90;
  const thinkingHeader = 48;
  const shellReserve = readinessHeight + messageReserve;

  if (options.buildVisible && options.thinkingVisible && options.buildExpanded && options.thinkingExpanded) {
    const halfPanel = Math.floor(Math.max(0, viewport - shellReserve) / 2);
    return {
      buildBodyHeight: Math.max(0, halfPanel - buildHeader),
      thinkingBodyHeight: Math.max(0, halfPanel - thinkingHeader),
      equalShare: true,
    };
  }

  let buildBodyHeight = 320;
  let thinkingBodyHeight = 320;
  if (options.buildExpanded) {
    const collapsedThinkingHeader = options.thinkingVisible ? thinkingHeader : 0;
    buildBodyHeight = Math.min(320, Math.max(0, viewport - shellReserve - buildHeader - collapsedThinkingHeader));
  }
  if (options.thinkingExpanded) {
    const collapsedBuildHeader = options.buildVisible ? buildHeader : 0;
    thinkingBodyHeight = Math.min(320, Math.max(0, viewport - shellReserve - thinkingHeader - collapsedBuildHeader));
  }
  return { buildBodyHeight, thinkingBodyHeight, equalShare: false };
}
