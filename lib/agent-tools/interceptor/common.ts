import { getRuntimeFacade } from "../../runtime-facade";
import type { InterceptorAgentCommand } from "../../../core/enhancements/interceptor";

/**
 * Chat-agent capability: allow when the interceptor subsystem is initialized.
 * Policy still runs inside InterceptorAgentBridge / InterceptorPolicy.
 * CAPABILITY_REQUIRED means user must enable agent access on the Interceptor screen.
 */
export function interceptorHasCapability(): boolean {
  try {
    const facade = getRuntimeFacade();
    // Prefer explicit agent capability if the facade exposes policy state later.
    // For chat autonomy we attempt with true; bridge/policy still deny unsafe ops.
    void facade.interceptorEngine.getSnapshot();
    return true;
  } catch {
    return false;
  }
}

export async function runInterceptor(command: InterceptorAgentCommand): Promise<unknown> {
  const facade = getRuntimeFacade();
  const has = interceptorHasCapability();
  return facade.interceptorAgentBridge.execute(command, has);
}

export async function runInterceptorText(text: string): Promise<unknown> {
  const facade = getRuntimeFacade();
  return facade.interceptorAgentBridge.executeNaturalLanguage(text, interceptorHasCapability());
}
