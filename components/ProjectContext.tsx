import { createContext, useContext, ReactNode, useState, useEffect, useCallback } from "react";
import {
  ActiveProject,
  loadActiveProject,
  saveActiveProject,
  createProjectMeta,
  upsertProjectList,
  listProjects,
  removeProjectFromList,
  buildScaffoldCommands,
  exportZipCommand,
  type CreateProjectOptions,
} from "../lib/active-project";

type ProjectContextType = {
  project: ActiveProject | null;
  projects: ActiveProject[];
  setProject: (p: ActiveProject | null) => void;
  createProject: (opts: CreateProjectOptions | string, packageName?: string, useCompose?: boolean) => Promise<ActiveProject>;
  clearProject: () => void;
  removeProject: (id: string) => Promise<void>;
  scaffoldCommands: () => string[];
  exportCommand: () => string | null;
  refreshList: () => Promise<void>;
};

const ProjectContext = createContext<ProjectContextType | null>(null);

export function ProjectProvider({ children }: { children: ReactNode }) {
  const [project, setProjectState] = useState<ActiveProject | null>(null);
  const [projects, setProjects] = useState<ActiveProject[]>([]);

  useEffect(() => {
    (async () => {
      setProjectState(await loadActiveProject());
      setProjects(await listProjects());
    })();
  }, []);

  const setProject = useCallback((p: ActiveProject | null) => {
    setProjectState(p);
    saveActiveProject(p).catch(() => {});
    if (p) upsertProjectList(p).then(() => listProjects().then(setProjects)).catch(() => {});
  }, []);

  const createProject = useCallback(
    async (opts: CreateProjectOptions | string, packageName?: string, useCompose?: boolean) => {
      const meta =
        typeof opts === "string"
          ? createProjectMeta({ name: opts, packageName, useCompose })
          : createProjectMeta(opts);
      setProject(meta);
      return meta;
    },
    [setProject]
  );

  const clearProject = useCallback(() => setProject(null), [setProject]);

  const removeProject = useCallback(
    async (id: string) => {
      await removeProjectFromList(id);
      setProjects(await listProjects());
      setProjectState((cur) => {
        if (cur?.id === id) {
          saveActiveProject(null).catch(() => {});
          return null;
        }
        return cur;
      });
    },
    []
  );

  const scaffoldCommands = useCallback(() => {
    if (!project) return [];
    return buildScaffoldCommands(project);
  }, [project]);

  const exportCommand = useCallback(() => {
    if (!project) return null;
    return exportZipCommand(project.path);
  }, [project]);

  const refreshList = useCallback(async () => {
    setProjects(await listProjects());
  }, []);

  return (
    <ProjectContext.Provider
      value={{
        project,
        projects,
        setProject,
        createProject,
        clearProject,
        removeProject,
        scaffoldCommands,
        exportCommand,
        refreshList,
      }}
    >
      {children}
    </ProjectContext.Provider>
  );
}

export function useProjectContext() {
  const ctx = useContext(ProjectContext);
  if (!ctx) throw new Error("useProjectContext outside provider");
  return ctx;
}
