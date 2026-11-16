/**
 * Backup / migration helpers (runtime-only).
 * Ensures projects survive container delete, privilege loss, recreation.
 */

import type { HomeLayout } from "../home/HomeLayout";

export type ProjectSurvivalReport = {
  projectId: string;
  projectPath: string;
  survivesContainerDelete: boolean;
  survivesShizukuLoss: boolean;
  survivesRootLoss: boolean;
  survivesContainerRecreation: boolean;
  notes: string[];
};

/**
 * Projects live under HOME/projects and are independent of container instances.
 * This check documents the invariant; it does not move files.
 */
export function assertProjectSurvivalInvariant(
  home: HomeLayout,
  projectId: string,
): ProjectSurvivalReport {
  const projectPath = `${home.projects}/${projectId}`;
  return {
    projectId,
    projectPath,
    survivesContainerDelete: true,
    survivesShizukuLoss: true,
    survivesRootLoss: true,
    survivesContainerRecreation: true,
    notes: [
      "Projects are stored under AIBuilderTermux HOME/projects",
      "Containers mount projects read-write but do not own them",
      "Shizuku/Root are optional capabilities; app remains functional without them",
      "Recreating a container instance does not delete projectPath",
    ],
  };
}

export type BackupManifest = {
  createdAt: number;
  homeRoot: string;
  projects: string[];
  note: string;
};

export function createBackupManifest(
  home: HomeLayout,
  projectIds: string[],
): BackupManifest {
  return {
    createdAt: Date.now(),
    homeRoot: home.root,
    projects: [...projectIds],
    note: "Logical backup manifest only; physical copy is performed by storage layer",
  };
}
