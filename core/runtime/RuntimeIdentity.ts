/** Stable identity of the managed runtime. Changes to schema/rootfs require migration. */
export type RuntimeIdentity = Readonly<{
  appVersion: string;
  runtimeVersion: string;
  rootfsVersion: string;
  toolchainVersion: string;
  schemaVersion: number;
}>;

export const CURRENT_RUNTIME_IDENTITY: RuntimeIdentity = {
  appVersion: "1.10.113",
  runtimeVersion: "1",
  rootfsVersion: "1",
  toolchainVersion: "1",
  schemaVersion: 1,
};

export function identityKey(identity: RuntimeIdentity): string {
  return [identity.appVersion, identity.runtimeVersion, identity.rootfsVersion, identity.toolchainVersion, identity.schemaVersion].join("|");
}

export function requiresMigration(from: RuntimeIdentity, to: RuntimeIdentity): boolean {
  return from.schemaVersion !== to.schemaVersion || from.rootfsVersion !== to.rootfsVersion;
}
