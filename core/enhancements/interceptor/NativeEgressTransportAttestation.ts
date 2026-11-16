import type { InterceptorRuntimeAdapter } from "./types";

/*
 * Internal trust registry for the production Android transport. Trust is granted
 * only to the exact fetcher and listener object created together by
 * createNativeInterceptorAdapters. It is deliberately not a boolean carried in
 * caller-controlled RuntimeFacadeOptions.
 */
const pinnedFetchers = new WeakSet<Function>();
const pinnedListenerFetchers = new WeakMap<object, Function>();

/** Internal registration hook used only by the native adapter factory. */
export function registerNativePinnedEgressTransport(
  runtimeAdapter: InterceptorRuntimeAdapter,
  fetcher: typeof fetch,
): void {
  pinnedFetchers.add(fetcher);
  pinnedListenerFetchers.set(runtimeAdapter as object, fetcher);
}

export function isNativePinnedEgressFetcher(fetcher: unknown): fetcher is typeof fetch {
  return typeof fetcher === "function" && pinnedFetchers.has(fetcher);
}

export function isNativePinnedListenerTransport(
  runtimeAdapter: unknown,
  fetcher: unknown,
): boolean {
  return typeof runtimeAdapter === "object" && runtimeAdapter !== null &&
    typeof fetcher === "function" && pinnedListenerFetchers.get(runtimeAdapter) === fetcher;
}
