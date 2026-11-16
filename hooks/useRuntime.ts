/**
 * React hook for AIBuilderTermux RuntimeFacade status.
 * Safe for UI panels; does not touch compilation settings.
 */

import { useCallback, useEffect, useState } from "react";
import { getRuntimeFacade } from "../lib/runtime-facade";
import {
  snapshotRuntimeStatus,
  type RuntimeStatusSnapshot,
} from "../core/RuntimeStatus";
import type { DiagnosticReport } from "../core/diagnostics/DiagnosticReport";
import type { RestoreResult } from "../core/backup/RestoreTransaction";

export type UseRuntimeState = {
  status: RuntimeStatusSnapshot | null;
  diagnostics: DiagnosticReport | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  openProjectSession: (projectId: string) => void;
  launchUbuntu: (projectId: string) => Promise<void>;
  openTerminal: (projectId: string, projectRoot?: string) => Promise<string>;
  createAgent: (projectId: string) => string;
  launchKali: (projectId: string) => Promise<void>;
  runProot: (profile: "ubuntu", instanceId: string, projectId: string, rootfsPath?: string) => Promise<string>;
  runProotAuto: (profile: "ubuntu", instanceId: string, projectId: string) => Promise<string>;
  stopContainer: (instanceId: string) => Promise<void>;
  destroyContainer: (instanceId: string) => Promise<void>;
  runRecovery: (actionId: string) => Promise<string>;
  listRecoveryActions: () => Array<{ id: string; description: string }>;
  runFinalValidation: () => { passed: number; failed: number; checks: Array<{ name: string; ok: boolean }> };
  ensureRootfs: (profile: "ubuntu") => Promise<string>;
  createBackup: (scope: "full" | "projects" | "sessions" | "agent" | "toolchains", destination: string) => Promise<string>;
  restoreBackup: (source: string, options?: { preBackupDestination?: string; skipPreBackup?: boolean }) => Promise<RestoreResult>;
  runHealthChecks: () => Promise<Array<{ id: string; level: string; message: string; repairable?: boolean }>>;
  repairHealth: (id: string) => Promise<unknown>;
  initUserspace: () => Promise<{ ready: boolean; activeBackend: string | null }>;
};

export function useRuntime(): UseRuntimeState {
  const [status, setStatus] = useState<RuntimeStatusSnapshot | null>(null);
  const [diagnostics, setDiagnostics] = useState<DiagnosticReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const facade = getRuntimeFacade();
      const [snap, diag] = await Promise.all([
        snapshotRuntimeStatus(facade),
        facade.diagnostics(),
      ]);
      setStatus(snap);
      setDiagnostics(diag);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const openProjectSession = useCallback((projectId: string) => {
    getRuntimeFacade().openProjectSession(projectId);
    void refresh();
  }, [refresh]);

  const launchUbuntu = useCallback(
    async (projectId: string) => {
      await getRuntimeFacade().launchUbuntu(projectId);
      await refresh();
    },
    [refresh],
  );

  const openTerminal = useCallback(
    async (projectId: string, projectRoot?: string) => {
      const session = await getRuntimeFacade().openTerminalForProject(projectId, projectRoot);
      await refresh();
      return session.id;
    },
    [refresh],
  );

  const createAgent = useCallback(
    (projectId: string) => {
      const agent = getRuntimeFacade().createAgentForProject(projectId);
      void refresh();
      return agent.id;
    },
    [refresh],
  );

  const launchKali = useCallback(
    async (projectId: string) => {
      await getRuntimeFacade().launchKali(projectId);
      await refresh();
    },
    [refresh],
  );

  const runProot = useCallback(
    async (
      profile: "ubuntu",
      instanceId: string,
      projectId: string,
      rootfsPath?: string,
    ) => {
      const { plan, result } = await getRuntimeFacade().runProotPlanForInstance(
        profile,
        instanceId,
        projectId,
        rootfsPath,
      );
      await refresh();
      const stdout =
        result && typeof result === "object" && "stdout" in result
          ? String((result as { stdout?: string }).stdout ?? "")
          : "";
      return stdout || plan.command;
    },
    [refresh],
  );

  const runProotAuto = useCallback(
    async (
      profile: "ubuntu",
      instanceId: string,
      projectId: string,
    ) => {
      const { plan, result } = await getRuntimeFacade().runProotAuto(
        profile,
        instanceId,
        projectId,
      );
      await refresh();
      const stdout =
        result && typeof result === "object" && "stdout" in result
          ? String((result as { stdout?: string }).stdout ?? "")
          : "";
      return stdout || plan.command;
    },
    [refresh],
  );

  const stopContainer = useCallback(
    async (instanceId: string) => {
      await getRuntimeFacade().stopContainer(instanceId);
      await refresh();
    },
    [refresh],
  );

  const destroyContainer = useCallback(
    async (instanceId: string) => {
      const facade = getRuntimeFacade();
      try {
        await facade.stopContainer(instanceId);
      } catch {
        // already stopped
      }
      await facade.containers.remove(instanceId);
      await refresh();
    },
    [refresh],
  );

  const runRecovery = useCallback(
    async (actionId: string) => {
      const result = await getRuntimeFacade().recovery.run(actionId);
      await refresh();
      return result.ok ? `ok:${actionId}` : `fail:${actionId}:${result.error ?? ""}`;
    },
    [refresh],
  );

  const listRecoveryActions = useCallback(() => {
    return getRuntimeFacade().recovery.list().map((a) => ({
      id: a.id,
      description: a.description,
    }));
  }, []);

  const runFinalValidation = useCallback(() => {
    return getRuntimeFacade().finalValidation();
  }, []);

  const createBackup = useCallback(async (scope: "full" | "projects" | "sessions" | "agent" | "toolchains", destination: string) => {
    const manifest = await getRuntimeFacade().createBackup(scope, destination);
    await refresh();
    return manifest.digest ?? "created";
  }, [refresh]);

  const restoreBackup = useCallback(async (source: string, options?: { preBackupDestination?: string; skipPreBackup?: boolean }) => {
    const result = await getRuntimeFacade().restoreBackup(source, options);
    await refresh();
    return result;
  }, [refresh]);

  const runHealthChecks = useCallback(async () => {
    return getRuntimeFacade().runHealthChecks();
  }, []);

  const repairHealth = useCallback(async (id: string) => {
    return getRuntimeFacade().repairHealth(id);
  }, []);

  const initUserspace = useCallback(async () => {
    const s = await getRuntimeFacade().initUserspaceRuntime();
    return { ready: s.ready, activeBackend: s.activeBackend };
  }, []);

  const ensureRootfs = useCallback(
    async (profile: "ubuntu") => {
      const result = await getRuntimeFacade().ensureRootfs(profile);
      await refresh();
      return result.primaryPath;
    },
    [refresh],
  );

  return {
    status,
    diagnostics,
    loading,
    error,
    refresh,
    openProjectSession,
    launchUbuntu,
    openTerminal,
    createAgent,
    launchKali,
    runProot,
    runProotAuto,
    stopContainer,
    destroyContainer,
    runRecovery,
    listRecoveryActions,
    runFinalValidation,
    ensureRootfs,
    createBackup,
    restoreBackup,
    runHealthChecks,
    repairHealth,
    initUserspace,
  };
}
