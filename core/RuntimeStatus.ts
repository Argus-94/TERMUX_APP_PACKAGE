/**
 * Snapshot suitable for UI "Runtime" panels.
 */

import type { RuntimeFacade } from "./RuntimeFacade";
import { isNativeAccelLinked } from "./runtime/native-accel-loader";

export type RuntimeProcessBrief = {
  id: string;
  kind: string;
  label?: string;
  projectId?: string;
  watchdog?: boolean;
};

export type RuntimeContainerBrief = {
  id: string;
  name: string;
  status: string;
  imageId: string;
  projectId?: string;
};

export type RuntimeAgentBrief = {
  id: string;
  status: string;
  projectId?: string;
};

export type RuntimeToolchainBrief = {
  id: string;
  kind: string;
  name: string;
  version?: string;
  health: string;
};

export type RuntimeStatusSnapshot = {
  runtimeIdentity: { appVersion: string; runtimeVersion: string; rootfsVersion: string; toolchainVersion: string; schemaVersion: number };
  supervisor: { status: string; watched: number; lastTick: number | null; failures: number };
  home: string;
  sessions: number;
  sessionList: Array<{ id: string; projectId?: string; projectRoot?: string }>;
  processes: number;
  processList: RuntimeProcessBrief[];
  containers: number;
  containerImages: number;
  containerList: RuntimeContainerBrief[];
  agents: number;
  agentList: RuntimeAgentBrief[];
  toolchains: number;
  toolchainList: RuntimeToolchainBrief[];
  privilegeActive: string;
  nativeAvailable: boolean;
  generatedAt: number;
};

export async function snapshotRuntimeStatus(
  facade: RuntimeFacade,
): Promise<RuntimeStatusSnapshot> {
  const priv = facade.getPrivileges() ?? (await facade.refreshPrivileges());
  const processList = facade.processRegistry.list().map((p) => ({
    id: p.id,
    kind: p.kind,
    label: p.label,
    projectId: p.projectId,
    watchdog: p.metadata?.watchdog === "true",
  }));
  const containerList = facade.containers.listInstances().map((c) => ({
    id: c.id,
    name: c.name,
    status: c.status,
    imageId: c.imageId,
    projectId: c.projectId,
  }));
  return {
    runtimeIdentity: { ...facade.runtimeIdentity },
    supervisor: facade.supervisor.snapshot(),
    home: facade.home.root,
    sessions: facade.sessions.list().length,
    sessionList: facade.sessions.list().map((s) => ({
      id: s.id,
      projectId: s.projectId,
      projectRoot: s.projectRoot,
    })),
    processes: facade.processRegistry.size(),
    processList,
    containers: facade.containers.listInstances().length,
    containerImages: facade.containers.listImages().length,
    containerList,
    agents: facade.agents.list().length,
    agentList: facade.agents.list().map((a) => ({
      id: a.id,
      status: a.status,
      projectId: a.projectId,
    })),
    toolchains: facade.toolchains.list().length,
    toolchainList: facade.toolchains.list().map((m) => ({
      id: m.id,
      kind: m.kind,
      name: m.name,
      version: m.version,
      health: m.health,
    })),
    privilegeActive: priv.active,
    nativeAvailable: facade.native.detect().available || (await isNativeAccelLinked()),
    generatedAt: Date.now(),
  };
}
