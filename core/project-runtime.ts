/**
 * Bridge between ProjectManager paths and RuntimeFacade sessions/containers.
 * Runtime-only.
 */

import type { RuntimeFacade } from "./RuntimeFacade";
import type { BuilderSession } from "./session/SessionManager";
import type { ContainerInstance } from "./container/ContainerTypes";

export type ProjectRuntimeBinding = {
  projectId: string;
  projectRoot: string;
  session: BuilderSession;
  ubuntu?: ContainerInstance;
};

/**
 * Open session for project and optionally launch Ubuntu with project mount.
 */
export async function bindProjectToRuntime(
  facade: RuntimeFacade,
  projectId: string,
  options?: { launchUbuntu?: boolean },
): Promise<ProjectRuntimeBinding> {
  const session = facade.openProjectSession(projectId);
  const projectRoot = session.projectRoot ?? `${facade.home.projects}/${projectId}`;
  let ubuntu: ContainerInstance | undefined;
  if (options?.launchUbuntu) {
    const launched = await facade.launchUbuntu(projectId);
    ubuntu = launched.instance;
    facade.sessions.attachAgent(session.id, `ubuntu-${ubuntu.id}`);
  }
  return {
    projectId,
    projectRoot,
    session,
    ubuntu,
  };
}

/**
 * Tear down container for project without deleting project files.
 */
export async function unbindProjectContainer(
  facade: RuntimeFacade,
  instanceId: string,
): Promise<void> {
  await facade.stopContainer(instanceId);
  try {
    await facade.containers.remove(instanceId);
  } catch {
    // already gone
  }
}
