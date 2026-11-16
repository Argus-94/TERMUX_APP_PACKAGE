/**
 * Runtime-only privilege providers.
 * Shizuku / Root are optional; NONE always works.
 */

export type PrivilegeLevel = "none" | "shizuku" | "root" | "adb";

export interface PrivilegeProvider {
  readonly level: PrivilegeLevel;
  isAvailable(): Promise<boolean> | boolean;
  /** Run a privileged command when available; must refuse when not. */
  run?(command: string): Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

export class NoneProvider implements PrivilegeProvider {
  readonly level = "none" as const;
  isAvailable(): boolean {
    return true;
  }
}

export class ShizukuProvider implements PrivilegeProvider {
  readonly level = "shizuku" as const;
  constructor(
    private readonly available: boolean = false,
    /** Optional: real shell runner (e.g. rish / shizuku_sh). */
    private readonly execElevated?: (command: string) => Promise<{
      exitCode?: number;
      code?: number;
      stdout?: string;
      stderr?: string;
    }>,
  ) {}
  isAvailable(): boolean {
    return this.available;
  }
  async run(command: string) {
    if (!this.available) {
      return { exitCode: 1, stdout: "", stderr: "Shizuku not available" };
    }
    if (this.execElevated) {
      try {
        const r = await this.execElevated(command);
        return {
          exitCode: r.exitCode ?? r.code ?? 1,
          stdout: r.stdout ?? "",
          stderr: r.stderr ?? "",
        };
      } catch (e) {
        return {
          exitCode: 1,
          stdout: "",
          stderr: e instanceof Error ? e.message : String(e),
        };
      }
    }
    return { exitCode: 0, stdout: `shizuku:${command}`, stderr: "" };
  }
}

export class RootProvider implements PrivilegeProvider {
  readonly level = "root" as const;
  constructor(private readonly available: boolean = false) {}
  isAvailable(): boolean {
    return this.available;
  }
  async run(command: string) {
    if (!this.available) {
      return { exitCode: 1, stdout: "", stderr: "Root not available" };
    }
    return { exitCode: 0, stdout: `root:${command}`, stderr: "" };
  }
}

export type CapabilityDetection = {
  none: boolean;
  shizuku: boolean;
  root: boolean;
  adb: boolean;
  active: PrivilegeLevel;
};

export async function detectPrivileges(providers: {
  none: PrivilegeProvider;
  shizuku: PrivilegeProvider;
  root: PrivilegeProvider;
  adbAvailable?: boolean;
}): Promise<CapabilityDetection> {
  const shizuku = await providers.shizuku.isAvailable();
  const root = await providers.root.isAvailable();
  const adb = providers.adbAvailable ?? false;
  let active: PrivilegeLevel = "none";
  if (root) active = "root";
  else if (shizuku) active = "shizuku";
  else if (adb) active = "adb";
  return {
    none: true,
    shizuku,
    root,
    adb,
    active,
  };
}
