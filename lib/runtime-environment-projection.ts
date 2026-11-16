export type RuntimeEnvironmentTarget = "termux" | "ubuntu-proot";

export type RuntimeEnvironmentHealth =
  | "ready"
  | "needs-setup"
  | "confirmed-absent"
  | "login-unverified"
  | "unverified";

export type RuntimeEnvironmentProjectionInput = Readonly<{
  termuxReady?: boolean | null;
  ubuntu?: Readonly<{ installed?: boolean | null; healthy?: boolean }> | null;
  debian?: Readonly<{ rootfsInstalled?: boolean | null; healthy?: boolean }> | null;
}>;

export type RuntimeEnvironmentProjection = Readonly<{
  target: RuntimeEnvironmentTarget;
  environmentLabel: "Termux" | "Ubuntu proot" | "Debian proot";
  health: RuntimeEnvironmentHealth;
  statusRows: readonly Readonly<{
    id: "termux" | "ubuntu-rootfs" | "debian-rootfs";
    label: "Termux" | "Ubuntu proot" | "Debian proot";
    ready: boolean | null;
  }>[];
  settingsPath: "/termux-settings" | null;
  prepareAlias: "ubuntu" | "debian" | null;
}>;

export type RuntimeEnvironmentCheckState = Readonly<{
  target: RuntimeEnvironmentTarget;
  status: "ready" | "missing" | "error";
}>;

export type RuntimeRootfsReadiness = Readonly<{
  rootfs: "healthy" | "missing" | "unknown";
  rootfsState?: Readonly<{ installed: boolean | null; healthy: boolean }> | null;
}>;

/** Unknown/error and healthy states never expose installation; Termux is host-only. */
export function canOfferRuntimeInstall(
  target: RuntimeEnvironmentTarget,
  check: RuntimeEnvironmentCheckState | null | undefined,
): boolean {
  return target !== "termux" && check?.target === target && check.status === "missing";
}

/** Show a guarded Prepare action for unknown/error too; click-time preflight decides whether mutation is allowed. */
export function canOfferRuntimePreparationAction(
  target: RuntimeEnvironmentTarget,
  check: RuntimeEnvironmentCheckState | null | undefined,
): boolean {
  if (target === "termux") return false;
  return check?.target !== target || check.status !== "ready";
}

/** Project only rootfs evidence into the rootfs row; host/baseline misses are not rootfs absence. */
export function projectProotRootfsReadiness(
  readiness: RuntimeRootfsReadiness | null | undefined,
): Readonly<{ installed: boolean | null; healthy: boolean }> | null {
  if (!readiness) return null;
  return {
    installed: readiness.rootfs === "healthy"
      ? true
      : readiness.rootfs === "missing"
        ? false
        : readiness.rootfsState?.installed ?? null,
    healthy: readiness.rootfs === "healthy",
  };
}

function rootfsHealth(
  installed: boolean | null | undefined,
  healthy: boolean | undefined,
): RuntimeEnvironmentHealth {
  if (healthy === true) return "ready";
  if (installed === false) return "confirmed-absent";
  if (installed === true) return "login-unverified";
  return "unverified";
}

function rootfsReadyValue(
  installed: boolean | null | undefined,
  healthy: boolean | undefined,
): boolean | null {
  if (healthy === true) return true;
  if (installed === false || installed === true) return false;
  return null;
}

/**
 * Project all environment-specific Runtime UI data from the active selection.
 * Foreign environment objects are intentionally never copied into the result.
 */
export function projectRuntimeEnvironment(
  target: RuntimeEnvironmentTarget,
  input: RuntimeEnvironmentProjectionInput,
): RuntimeEnvironmentProjection {
  if (target === "termux") {
    const ready = input.termuxReady ?? null;
    return {
      target,
      environmentLabel: "Termux",
      health: ready === true ? "ready" : ready === false ? "needs-setup" : "unverified",
      statusRows: [{ id: "termux", label: "Termux", ready }],
      settingsPath: "/termux-settings",
      prepareAlias: null,
    };
  }

  if (target === "ubuntu-proot") {
    const status = input.ubuntu;
    return {
      target,
      environmentLabel: "Ubuntu proot",
      health: rootfsHealth(status?.installed, status?.healthy),
      statusRows: [{
        id: "ubuntu-rootfs",
        label: "Ubuntu proot",
        ready: rootfsReadyValue(status?.installed, status?.healthy),
      }],
      settingsPath: null,
      prepareAlias: "ubuntu",
    };
  }

  const status = input.debian;
  return {
    target: "ubuntu-proot",
    environmentLabel: "Debian proot",
    health: rootfsHealth(status?.rootfsInstalled, status?.healthy),
    statusRows: [{
      id: "debian-rootfs",
      label: "Debian proot",
      ready: rootfsReadyValue(status?.rootfsInstalled, status?.healthy),
    }],
    settingsPath: null,
    prepareAlias: "debian",
  };
}

/**
 * Keep generic app-level diagnostics visible, but never project a sibling
 * runtime's explicitly scoped failure into the active environment panel.
 * Ambiguous guest/rootfs diagnostics are hidden because their target is unknown.
 */
export function isRuntimeEnvironmentDetailVisible(
  target: RuntimeEnvironmentTarget,
  detail: string,
): boolean {
  const normalized = detail.toLowerCase();
  const scopes: RuntimeEnvironmentTarget[] = [];
  if (/\btermux\b|\$prefix/.test(normalized)) scopes.push("termux");
  if (/\bubuntu\b/.test(normalized)) scopes.push("ubuntu-proot");
  if (/\bdebian\b/.test(normalized)) scopes.push("ubuntu-proot");
  if (scopes.length > 0) return scopes.every((scope) => scope === target);
  if (/\b(rootfs|proot|apt(?:-get)?|guest)\b/.test(normalized)) return false;
  return true;
}
