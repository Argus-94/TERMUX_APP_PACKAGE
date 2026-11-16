/**
 * App-layer access to AIBuilderTermux RuntimeFacade.
 * Singleton-style helper; safe to import from UI / agent code.
 * Runtime-only — does not touch compilation settings.
 */

import {
  createRuntimeFacade,
  type RuntimeFacade,
  type RuntimeFacadeOptions,
} from "../core/RuntimeFacade";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { createHomeEnvironment } from "../core/home/HomeEnvironment";
import { AIBuilderTermuxEnvironment } from "../core/environment/AIBuilderTermuxEnvironment";
import { EnvironmentTextStore } from "../core/runtime/RuntimeStores";
import { createDefaultBootstrapRunner } from "./bootstrap-stage-runner";
import { getBuildBackend } from "./agent-shell-backend";
import { bootstrapImageFingerprint } from "./runtime-command-routing";
import { createNativeInterceptorAdapters } from "./native-interceptor-adapters";
import { createFirstRunAppStore } from "./first-run-app-store";
import { createTerminalSessionAppStore } from "./terminal-session-app-store";

let singleton: RuntimeFacade | null = null;

export function getRuntimeFacade(options?: RuntimeFacadeOptions): RuntimeFacade {
  if (!singleton) {
    const nativeInterceptor = createNativeInterceptorAdapters();
    const configuredInterceptor = options?.enhancements?.interceptor;
    const home = createHomeEnvironment(options?.homeRoot ? { AI_BUILDER_HOME: options.homeRoot } : {}).layout;
    const legacyFirstRunStore = new EnvironmentTextStore(
      new AIBuilderTermuxEnvironment(home.root),
      `${home.metadata}/first-run-state.json`,
    );
    const firstRunStore = options?.firstRunStore ?? createFirstRunAppStore({
      getItem: (key) => AsyncStorage.getItem(key),
      setItem: (key, value) => AsyncStorage.setItem(key, value),
      removeItem: (key) => AsyncStorage.removeItem(key),
    }, legacyFirstRunStore);
    const terminalSessionStore = createTerminalSessionAppStore({
      getItem: (key) => AsyncStorage.getItem(key),
      setItem: (key, value) => AsyncStorage.setItem(key, value),
    });
    singleton = createRuntimeFacade({
      ...options,
      firstRunStore,
      terminalSessionStore,
      enhancements: {
        ...options?.enhancements,
        interceptor: {
          ...nativeInterceptor,
          ...configuredInterceptor,
        },
      },
    });
    singleton.registerDefaultToolchainSources();
    singleton.bindBootstrapRunner(
      createDefaultBootstrapRunner(),
      (stageId) => stageId === "environment-image"
        ? bootstrapImageFingerprint(getBuildBackend())
        : undefined,
    );
    // Recover unfinished maintenance journal entries from a previous crash (best-effort).
    void singleton.recoverPendingTransactions().catch(() => {
      /* non-fatal */
    });
  }
  return singleton;
}

/** Test / recovery helper: drop singleton so next get creates a fresh facade. */
export function resetRuntimeFacade(): void {
  singleton = null;
}

export type { RuntimeFacade, RuntimeFacadeOptions };
