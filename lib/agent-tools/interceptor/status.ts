import { getRuntimeFacade } from "../../runtime-facade";
import type { ToolArgs } from "../types";
export function validate(_args: ToolArgs): string | null { return null; }
export async function execute(_args: ToolArgs) {
  const facade = getRuntimeFacade();
  const snap = facade.interceptorEngine.getSnapshot();
  return {
    enabled: snap.enabled,
    address: (snap as any).address ?? null,
    port: (snap as any).port ?? null,
    error: snap.error ?? null,
    backend_note: "Interceptor is app-native (loopback proxy), independent of Termux/Ubuntu shell backend. Shell backend only matters for file/build tools.",
  };
}
