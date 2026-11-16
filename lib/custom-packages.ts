/**
 * Пользовательские инструменты для меню «Пакеты».
 * Хранятся в AsyncStorage, устанавливаются/проверяются/удаляются
 * так же, как compile/reverse пакеты (Termux shell + withInstallerEnvironment).
 */

import AsyncStorage from "@react-native-async-storage/async-storage";
import { type TermuxCommandResult } from "./termux-bridge";
import { runPackageCommand } from "./package-backend";
import { persistentLogger } from "./persistent-logger";
import { isPkgMirrorFailure } from "./termux-installer-env";
import { checkPackageCommand, type PackageCheckOutcome } from "./package-check-outcome";
import { getBuildBackend, type AgentShellBackend } from "./agent-shell-backend";
import { formatPackageInstallFailure } from "./package-install-diagnostics";
import { getPrivatePackageMutationAvailability } from "./private-package-install-policy";

export type CustomToolSection = "compile" | "reverse";

/** How installCmd is generated from simpler fields */
export type CustomInstallKind =
  | "pkg" // apt-get install -y <packages>
  | "pip" // pip install <packages>
  | "npm" // npm install -g <packages>
  | "custom"; // raw shell

export interface CustomToolDef {
  id: string;
  /** Section in the packages menu */
  section: CustomToolSection;
  name: string;
  nameEn: string;
  description?: string;
  /** Ionicons name */
  icon?: string;
  installKind: CustomInstallKind;
  /** For pkg/pip/npm: space-separated package names */
  packageNames?: string;
  installCmd: string;
  checkCmd: string;
  removeCmd: string;
  estimateSec: number;
  order: number;
  createdAt: number;
  updatedAt: number;
}

const STORAGE_KEY = "aibuilder.custom_tools.v1";
const INSTALL_TIMEOUT_MS = 900_000;
const CHECK_TIMEOUT_MS = 25_000;
const REMOVE_TIMEOUT_MS = 180_000;

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "tool"
  );
}

const PACKAGE_PATTERNS: Record<Exclude<CustomInstallKind, "custom">, RegExp> = {
  pkg: /^[A-Za-z0-9][A-Za-z0-9+_.:-]{0,99}$/,
  pip: /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}(?:\[[A-Za-z0-9._,-]{1,80}\])?(?:(?:===|==|!=|~=|>=|<=|>|<)[A-Za-z0-9.*+_-]{1,80})?$/,
  npm: /^(?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9][A-Za-z0-9._-]{0,99}(?:@[A-Za-z0-9.*+_-]{1,80})?$/,
};

function packageTokens(kind: Exclude<CustomInstallKind, "custom">, value: string): string[] {
  const tokens = String(value || "").trim().split(/\s+/).filter(Boolean);
  if (!tokens.length || tokens.length > 20 || tokens.some((token) => token.length > 180 || !PACKAGE_PATTERNS[kind].test(token))) {
    throw new Error("CUSTOM_PACKAGE_NAME_INVALID");
  }
  return tokens;
}

function shellArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function pipDistributionName(spec: string): string {
  return spec.replace(/\[[^\]]*\]/, "").split(/(?:===|==|!=|~=|>=|<=|>|<)/)[0];
}

function npmDistributionName(spec: string): string {
  const versionAt = spec.lastIndexOf("@");
  return versionAt > 0 ? spec.slice(0, versionAt) : spec;
}

function shellSnippet(value: unknown, code: string, optional = false): string {
  const command = typeof value === "string" ? value.trim() : "";
  if (!command && optional) return "true";
  if (!command || command.length > 8000 || command.includes("\0")) throw new Error(code);
  return command;
}

export function buildCommandsFromKind(
  kind: CustomInstallKind,
  packageNames: string,
  customInstall?: string,
  customCheck?: string,
  customRemove?: string
): { installCmd: string; checkCmd: string; removeCmd: string } {
  if (!["pkg", "pip", "npm", "custom"].includes(kind)) throw new Error("CUSTOM_INSTALL_KIND_INVALID");
  if (kind === "custom") {
    return {
      installCmd: shellSnippet(customInstall, "CUSTOM_INSTALL_COMMAND_REQUIRED"),
      checkCmd: typeof customCheck === "string" && customCheck.trim() && !["true", ":"].includes(customCheck.trim())
        ? shellSnippet(customCheck, "CUSTOM_CHECK_COMMAND_INVALID")
        : 'printf "%s\\n" CUSTOM_CHECK_NOT_CONFIGURED >&2; exit 78',
      removeCmd: shellSnippet(customRemove, "CUSTOM_REMOVE_COMMAND_INVALID", true),
    };
  }
  const tokens = packageTokens(kind, packageNames);
  const pkgs = tokens.map(shellArg).join(" ");

  if (kind === "pkg") {
    const checks = tokens.map((token) => {
      const pkg = shellArg(token);
      const statusFormat = shellArg("${db:Status-Status}");
      return `(command -v ${pkg} >/dev/null 2>&1 || [ "$(dpkg-query -W -f=${statusFormat} ${pkg} 2>/dev/null)" = "installed" ])`;
    }).join(" && ");
    return {
      installCmd: `set +e
apt-get install -y ${pkgs} 2>&1
_aib_install_status=$?
if [ "$_aib_install_status" -eq 0 ] && ${checks}; then
  echo CUSTOM_PKG_OK
  exit 0
fi
echo CUSTOM_PKG_FAIL
exit 1`,
      checkCmd: checks,
      removeCmd: `apt-get remove -y ${pkgs} 2>&1`,
    };
  }
  if (kind === "pip") {
    const distributions = tokens.map(pipDistributionName);
    const checks = distributions.map((name) => `python3 -m pip show ${shellArg(name)} >/dev/null 2>&1`).join(" && ");
    return {
      installCmd: `set +e
python3 -m pip --version >/dev/null 2>&1 || { echo CUSTOM_PIP_PREREQUISITE_MISSING >&2; exit 78; }
python3 -m pip install ${pkgs} 2>&1
_aib_install_status=$?
if [ "$_aib_install_status" -eq 0 ] && ${checks}; then echo CUSTOM_PIP_OK; exit 0; fi
echo CUSTOM_PIP_FAIL
exit 1`,
      checkCmd: checks,
      removeCmd: `python3 -m pip uninstall -y ${distributions.map(shellArg).join(" ")} 2>&1`,
    };
  }
  if (kind === "npm") {
    const distributions = tokens.map(npmDistributionName);
    const checks = distributions.map((name) => `npm ls -g --depth=0 ${shellArg(name)} >/dev/null 2>&1`).join(" && ");
    return {
      installCmd: `set +e
npm --version >/dev/null 2>&1 || { echo CUSTOM_NPM_PREREQUISITE_MISSING >&2; exit 78; }
npm install -g ${pkgs} 2>&1
_aib_install_status=$?
if [ "$_aib_install_status" -eq 0 ] && ${checks}; then echo CUSTOM_NPM_OK; exit 0; fi
echo CUSTOM_NPM_FAIL
exit 1`,
      checkCmd: checks,
      removeCmd: `npm uninstall -g ${distributions.map(shellArg).join(" ")} 2>&1`,
    };
  }
  throw new Error("CUSTOM_INSTALL_KIND_INVALID");
}

function normalizeStoredTool(value: unknown): CustomToolDef | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Partial<CustomToolDef>;
  if (
    typeof record.id !== "string" || !/^custom-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(record.id) ||
    (record.section !== "compile" && record.section !== "reverse") ||
    typeof record.name !== "string" || !record.name.trim() || record.name.length > 80 ||
    !["pkg", "pip", "npm", "custom"].includes(String(record.installKind)) ||
    typeof record.createdAt !== "number" || !Number.isFinite(record.createdAt) ||
    typeof record.updatedAt !== "number" || !Number.isFinite(record.updatedAt) ||
    typeof record.estimateSec !== "number" || !Number.isFinite(record.estimateSec) ||
    typeof record.order !== "number" || !Number.isFinite(record.order)
  ) return null;

  const name = record.name.trim();
  const nameEn = typeof record.nameEn === "string" && record.nameEn.trim() ? record.nameEn.trim() : name;
  if (nameEn.length > 80 || (record.description != null && (typeof record.description !== "string" || record.description.length > 500))) return null;

  try {
    const installKind = record.installKind as CustomInstallKind;
    const packageNames = installKind === "custom" ? undefined : String(record.packageNames || "").trim();
    const commands = buildCommandsFromKind(
      installKind,
      packageNames || "",
      record.installCmd,
      record.checkCmd,
      record.removeCmd,
    );
    return {
      id: record.id,
      section: record.section,
      name,
      nameEn,
      description: record.description as string | undefined,
      icon: typeof record.icon === "string" && /^[A-Za-z0-9-]{1,64}$/.test(record.icon) ? record.icon : "extension-puzzle-outline",
      installKind,
      packageNames,
      ...commands,
      estimateSec: Math.max(10, Math.min(3600, Number(record.estimateSec))),
      order: Math.max(0, Math.min(100000, Number(record.order))),
      createdAt: Number(record.createdAt),
      updatedAt: Number(record.updatedAt),
    };
  } catch {
    return null;
  }
}

export async function loadCustomTools(): Promise<CustomToolDef[]> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const normalized = parsed.map(normalizeStoredTool).filter((tool): tool is CustomToolDef => !!tool);
    return normalized.filter((tool, index) => normalized.findIndex((candidate) => candidate.id === tool.id) === index);
  } catch {
    return [];
  }
}

export async function saveCustomTools(list: CustomToolDef[]): Promise<void> {
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(list));
}

export async function upsertCustomTool(
  input: Omit<CustomToolDef, "id" | "createdAt" | "updatedAt" | "order"> & {
    id?: string;
    order?: number;
  }
): Promise<CustomToolDef> {
  if (input.section !== "compile" && input.section !== "reverse") throw new Error("CUSTOM_TOOL_SECTION_INVALID");
  if (!["pkg", "pip", "npm", "custom"].includes(String(input.installKind))) throw new Error("CUSTOM_INSTALL_KIND_INVALID");
  const name = String(input.name || "").trim();
  const nameEn = String(input.nameEn || name).trim();
  if (!name || name.length > 80 || !nameEn || nameEn.length > 80) throw new Error("CUSTOM_TOOL_NAME_INVALID");
  const description = input.description?.trim();
  if (description && description.length > 500) throw new Error("CUSTOM_TOOL_DESCRIPTION_INVALID");
  const packageNames = input.installKind === "custom" ? undefined : String(input.packageNames || "").trim();
  const commands = buildCommandsFromKind(input.installKind, packageNames || "", input.installCmd, input.checkCmd, input.removeCmd);
  if (input.id && !/^custom-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.id)) throw new Error("CUSTOM_TOOL_ID_INVALID");
  const list = await loadCustomTools();
  const now = Date.now();
  if (input.id) {
    const idx = list.findIndex((t) => t.id === input.id);
    if (idx < 0) throw new Error("CUSTOM_TOOL_ID_NOT_FOUND");
    const next: CustomToolDef = {
      ...list[idx],
      ...input,
      name,
      nameEn,
      description: description || undefined,
      icon: typeof input.icon === "string" && /^[A-Za-z0-9-]{1,64}$/.test(input.icon) ? input.icon : "extension-puzzle-outline",
      packageNames,
      ...commands,
      id: input.id,
      updatedAt: now,
    };
    list[idx] = next;
    await saveCustomTools(list);
    return next;
  }
  const base = slugify(nameEn || name);
  let id = `custom-${base}`;
  let n = 1;
  while (list.some((t) => t.id === id)) {
    id = `custom-${base}-${n++}`;
  }
  const maxOrder = list.reduce((m, t) => Math.max(m, t.order || 0), 0);
  const tool: CustomToolDef = {
    id,
    section: input.section,
    name,
    nameEn,
    description: description || undefined,
    icon: typeof input.icon === "string" && /^[A-Za-z0-9-]{1,64}$/.test(input.icon) ? input.icon : "extension-puzzle-outline",
    installKind: input.installKind,
    packageNames,
    ...commands,
    estimateSec: Math.max(10, input.estimateSec || 60),
    order: input.order ?? maxOrder + 1,
    createdAt: now,
    updatedAt: now,
  };
  list.push(tool);
  await saveCustomTools(list);
  return tool;
}

export async function deleteCustomTool(id: string): Promise<boolean> {
  const list = await loadCustomTools();
  const next = list.filter((t) => t.id !== id);
  if (next.length === list.length) return false;
  await saveCustomTools(next);
  return true;
}

export async function verifyCustomToolInstalled(
  def: CustomToolDef,
  selectedBackend: AgentShellBackend = getBuildBackend(),
): Promise<boolean> {
  return (await checkCustomToolInstalled(def, false, selectedBackend)).status === "installed";
}

export async function checkCustomToolInstalled(
  def: CustomToolDef,
  allowRawCustom = false,
  selectedBackend: AgentShellBackend = getBuildBackend(),
): Promise<PackageCheckOutcome> {
  if (def.installKind === "custom" && !allowRawCustom) {
    return { status: "error", detail: "CUSTOM_COMMAND_REQUIRES_USER_REVIEW" };
  }
  if (def.installKind === "custom" && (!def.checkCmd?.trim() || ["true", ":"].includes(def.checkCmd.trim()) || def.checkCmd.includes("CUSTOM_CHECK_NOT_CONFIGURED"))) {
    return { status: "error", detail: "CUSTOM_CHECK_COMMAND_REQUIRED" };
  }
  // A user-authored shell check can contain install/download commands; a "check" label is not proof of read-only behavior.
  if (def.installKind === "custom" && !getPrivatePackageMutationAvailability().allowed) {
    return { status: "error", detail: "CUSTOM_RAW_CHECK_BLOCKED_UNQUALIFIED_FEED" };
  }
  return checkPackageCommand(() =>
    runPackageCommand(def.checkCmd, {
      timeoutMs: CHECK_TIMEOUT_MS, kind: "check", packageId: def.id,
      selectedBackend,
    })
  );
}

export async function installCustomTool(
  def: CustomToolDef,
  onProgress: (p: number, detail: string) => void,
  shouldAbort?: () => boolean,
  allowRawCustom = false,
  selectedBackend: AgentShellBackend = getBuildBackend(),
): Promise<{ ok: boolean; error?: string }> {
  if (def.installKind === "custom" && !allowRawCustom) return { ok: false, error: "CUSTOM_COMMAND_REQUIRES_USER_REVIEW" };
  const tag = `CustomTool:${def.id}`;
  const tick = (p: number, detail: string) => {
    if (shouldAbort?.()) return;
    onProgress(Math.min(99, Math.max(0, p)), detail);
  };

  try {
    tick(0, "Подготовка…");
    if (shouldAbort?.()) return { ok: false, error: "aborted" };

    tick(0, `Установка ${def.name}…`);
    let installResult: TermuxCommandResult | null = null;
    let installError: string | undefined;

    try {
      installResult = await runPackageCommand(def.installCmd, {
        timeoutMs: INSTALL_TIMEOUT_MS,
        isBuild: true,
        kind: "install",
        packageId: def.id,
        selectedBackend,
      });
    } catch (e: unknown) {
      installError = e instanceof Error ? e.message : String(e);
    }

    if (shouldAbort?.()) return { ok: false, error: "aborted" };

    if (
      !installError &&
      installResult &&
      !installResult.timedOut &&
      isPkgMirrorFailure(installResult)
    ) {
      tick(0, "Временная ошибка источника — один повтор с обновлением индексов…");
      if (shouldAbort?.()) return { ok: false, error: "aborted" };
      tick(0, `Повторная установка ${def.name}…`);
      try {
        installResult = await runPackageCommand(def.installCmd, {
          timeoutMs: INSTALL_TIMEOUT_MS,
          isBuild: true,
          kind: "install",
          packageId: def.id,
          selectedBackend,
        });
        installError = undefined;
      } catch (e: unknown) {
        installError = e instanceof Error ? e.message : String(e);
      }
      if (shouldAbort?.()) return { ok: false, error: "aborted" };
    }

    if (installError) {
      tick(0, "Ошибка");
      return { ok: false, error: installError };
    }
    if (!installResult || installResult.timedOut) {
      tick(0, "Таймаут");
      return { ok: false, error: "timeout" };
    }

    tick(0, "Проверка…");
    const verification = await checkCustomToolInstalled(def, allowRawCustom, selectedBackend);
    if (installResult.exitCode === 0 && !installResult.timedOut && verification.status === "installed") {
      tick(100, "Установлено");
      return { ok: true };
    }

    tick(0, "Не подтверждено");
    return {
      ok: false,
      error: formatPackageInstallFailure(
        installResult,
        verification.status === "error" ? verification.detail : undefined,
      ),
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    persistentLogger.add("error", tag, msg);
    onProgress(0, "Ошибка");
    return { ok: false, error: msg };
  }
}

export async function removeCustomToolPkg(
  def: CustomToolDef,
  onProgress: (p: number, detail: string) => void,
  shouldAbort?: () => boolean,
  allowRawCustom = false,
  selectedBackend: AgentShellBackend = getBuildBackend(),
): Promise<{ ok: boolean; error?: string }> {
  if (def.installKind === "custom" && !allowRawCustom) return { ok: false, error: "CUSTOM_COMMAND_REQUIRES_USER_REVIEW" };
  const tag = `CustomTool:${def.id}`;
  try {
    onProgress(0, "Удаление…");
    if (shouldAbort?.()) return { ok: false, error: "aborted" };

    const r = await runPackageCommand(def.removeCmd, {
      timeoutMs: REMOVE_TIMEOUT_MS,
      isBuild: true,
      kind: "remove",
      packageId: def.id,
      selectedBackend,
    });
    if (shouldAbort?.()) return { ok: false, error: "aborted" };

    onProgress(0, "Проверка…");
    const verification = await checkCustomToolInstalled(def, allowRawCustom, selectedBackend);
    if (verification.status === "error") {
      return { ok: false, error: `PACKAGE_CHECK_INCONCLUSIVE:${verification.detail}` };
    }
    const still = verification.status === "installed";
    if (!still) {
      onProgress(100, "Удалено");
      return { ok: true };
    }
    if (r.exitCode === 0 && !r.timedOut && still) {
      return {
        ok: false,
        error: "uninstall exit 0, but verify still detects the tool",
      };
    }
    return {
      ok: false,
      error: r.timedOut ? "timeout" : `exit ${r.exitCode}`,
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    persistentLogger.add("error", tag, msg);
    onProgress(0, "Ошибка");
    return { ok: false, error: msg };
  }
}
