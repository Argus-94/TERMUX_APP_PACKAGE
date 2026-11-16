import { NativeModules } from "react-native";
import { AuthError, type NativeProxySession, type NativeProxyTransport, type ProviderRoute } from "./types";

type NativeModuleContract = {
  startProxy(provider: string, credential: string, baseUrl?: string, authHeader?: string, authScheme?: string): Promise<NativeProxySession>;
  stopProxy(sessionId: string): Promise<boolean>;
};

/** Native Android loopback transport. It never falls back to a non-proxy network path. */
export class NativeProxyTransportAdapter implements NativeProxyTransport {
  private get module(): NativeModuleContract {
    const candidate = NativeModules.AibCredentialProxy as NativeModuleContract | undefined;
    if (!candidate || typeof candidate.startProxy !== "function" || typeof candidate.stopProxy !== "function") throw new AuthError("NATIVE_TRANSPORT_UNAVAILABLE", "Native credential proxy transport is unavailable");
    return candidate;
  }

  start(provider: string, credential: string, route?: ProviderRoute): Promise<NativeProxySession> {
    return this.module.startProxy(provider, credential, route?.baseUrl, route?.authHeader, route?.authScheme);
  }

  stop(sessionId: string): Promise<boolean> {
    return this.module.stopProxy(sessionId);
  }
}
