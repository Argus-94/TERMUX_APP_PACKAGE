/**
 * Userspace container backend skeleton.
 * In-memory bookkeeping only; real rootfs/proot binding comes later.
 * Projects are never deleted when a container is removed.
 */

import type {
  ContainerImage,
  ContainerInstance,
  ContainerManager,
  ContainerPolicy,
  MountSpec,
} from "./ContainerTypes";

export class UserspaceContainerBackend implements ContainerManager {
  private readonly images = new Map<string, ContainerImage>();
  private readonly instances = new Map<string, ContainerInstance>();

  registerImage(image: ContainerImage): void {
    this.images.set(image.id, image);
  }

  listImages(): ContainerImage[] {
    return [...this.images.values()];
  }

  listInstances(): ContainerInstance[] {
    return [...this.instances.values()];
  }

  async create(input: {
    imageId: string;
    name: string;
    mounts?: MountSpec[];
    policy?: ContainerPolicy;
    projectId?: string;
  }): Promise<ContainerInstance> {
    if (!this.images.has(input.imageId)) {
      throw new Error(`Unknown image: ${input.imageId}`);
    }
    const id = `ctr-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const instance: ContainerInstance = {
      id,
      imageId: input.imageId,
      name: input.name,
      status: "created",
      mounts: input.mounts ? [...input.mounts] : [],
      policy: input.policy ?? "PROJECT_ONLY",
      projectId: input.projectId,
      createdAt: Date.now(),
    };
    this.instances.set(id, instance);
    return instance;
  }

  async start(instanceId: string): Promise<void> {
    const inst = this.instances.get(instanceId);
    if (!inst) throw new Error(`Unknown instance: ${instanceId}`);
    this.instances.set(instanceId, { ...inst, status: "running" });
  }

  async stop(instanceId: string): Promise<void> {
    const inst = this.instances.get(instanceId);
    if (!inst) throw new Error(`Unknown instance: ${instanceId}`);
    this.instances.set(instanceId, { ...inst, status: "stopped" });
  }

  async restart(instanceId: string): Promise<void> {
    await this.stop(instanceId);
    await this.start(instanceId);
  }

  async remove(instanceId: string): Promise<void> {
    // Intentionally does NOT touch project files / projectId storage.
    this.instances.delete(instanceId);
  }

  get(instanceId: string): ContainerInstance | undefined {
    return this.instances.get(instanceId);
  }
}

export function createUserspaceContainerBackend(): UserspaceContainerBackend {
  return new UserspaceContainerBackend();
}
