/**
 * Runtime-only container models.
 * Containers never own projects; projects live under AIBuilderTermux HOME.
 */

export type MountMode = "ro" | "rw";

export type MountSpec = {
  readonly hostPath: string;
  readonly containerPath: string;
  readonly mode: MountMode;
};

export type ContainerPolicy =
  | "PROJECT_ONLY"
  | "PROJECT_AND_WORKSPACE"
  | "INTEGRATED_HOME";

export type ContainerImage = {
  readonly id: string;
  readonly name: string;
  readonly tag: string;
  readonly profile: "ubuntu" | "custom";
  readonly path?: string;
  readonly sizeBytes?: number;
  readonly createdAt: number;
};

export type ContainerStatus =
  | "created"
  | "running"
  | "stopped"
  | "error"
  | "unknown";

export type ContainerInstance = {
  readonly id: string;
  readonly imageId: string;
  readonly name: string;
  readonly status: ContainerStatus;
  readonly mounts: MountSpec[];
  readonly policy: ContainerPolicy;
  readonly projectId?: string;
  readonly createdAt: number;
  readonly metadata?: Readonly<Record<string, string>>;
};

export interface ContainerManager {
  listImages(): Promise<ContainerImage[]> | ContainerImage[];
  listInstances(): Promise<ContainerInstance[]> | ContainerInstance[];
  create(input: {
    imageId: string;
    name: string;
    mounts?: MountSpec[];
    policy?: ContainerPolicy;
    projectId?: string;
  }): Promise<ContainerInstance>;
  start(instanceId: string): Promise<void>;
  stop(instanceId: string): Promise<void>;
  restart(instanceId: string): Promise<void>;
  remove(instanceId: string): Promise<void>;
  get(instanceId: string): Promise<ContainerInstance | undefined> | ContainerInstance | undefined;
}
