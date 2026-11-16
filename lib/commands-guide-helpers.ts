import { isPackageSupportedOnBackend, packageBackendTarget, type PackageBackendTarget } from "./package-command-routing";

export type GuideLanguage = "uk" | "ru" | "en";
export type GuideBackend = "termux" | "ubuntu-proot";
export type GuideRouteKind = "termux-package" | "apt-package" | "sdkmanager" | "npm-global" | "artifact" | "bootstrap" | "setup" | "unsupported";

export interface CompileGuidePackage {
  id: string;
  name: string;
  nameEn: string;
}

export interface CompileGuideInstruction {
  target: PackageBackendTarget;
  kind: GuideRouteKind;
  /** A short, copyable shell command. Null means the route is an archive/setup action, not a package command. */
  command: string | null;
  /** Concise route text shown when there is no single safe shell command. */
  display: string;
  description: string;
  actualPackage?: string;
}

export interface CompileGuideRow<T extends CompileGuidePackage = CompileGuidePackage> {
  source: T;
  title: string;
  instruction: CompileGuideInstruction;
}

interface RouteSpec {
  kind: GuideRouteKind;
  packageName?: string;
  command?: string;
  display?: Record<GuideLanguage, string>;
  note?: Record<GuideLanguage, string>;
}

interface GuideRule {
  termux: RouteSpec;
  linux: RouteSpec;
}

const packageRoute = (packageName: string, target: PackageBackendTarget): RouteSpec => ({
  kind: target === "termux" ? "termux-package" : "apt-package",
  packageName,
  command: target === "termux"
    ? `pkg install -y ${packageName}`
    : `apt-get update && apt-get install -y ${packageName}`,
});

const sdkmanagerRoute = (target: PackageBackendTarget, sdkPackage: string): RouteSpec => ({
  kind: "sdkmanager",
  packageName: sdkPackage,
  command: `sdkmanager "${sdkPackage}"`,
});

/**
 * Compact help-only map. It deliberately does not replace or execute the catalog's
 * install scripts; packageBackendTarget mirrors the real host-vs-proot routing.
 */
export const COMPILE_GUIDE_RULES: Record<string, GuideRule> = {
  wget: { termux: packageRoute("wget", "termux"), linux: packageRoute("wget", "linux") },
  curl: { termux: packageRoute("curl", "termux"), linux: packageRoute("curl", "linux") },
  "zip-unzip": { termux: packageRoute("zip unzip", "termux"), linux: packageRoute("zip unzip", "linux") },
  git: { termux: packageRoute("git", "termux"), linux: packageRoute("git", "linux") },
  "openjdk-17": { termux: packageRoute("openjdk-21", "termux"), linux: packageRoute("openjdk-17-jdk", "linux") },
  "build-essential": { termux: packageRoute("build-essential", "termux"), linux: packageRoute("build-essential", "linux") },
  clang: { termux: packageRoute("clang", "termux"), linux: packageRoute("clang", "linux") },
  make: { termux: packageRoute("make", "termux"), linux: packageRoute("make", "linux") },
  cmake: { termux: packageRoute("cmake", "termux"), linux: packageRoute("cmake", "linux") },
  "android-sdk": {
    termux: {
      kind: "setup",
      display: {
        ru: "Пакеты android-tools, aapt, aapt2, apksigner, d8 + ссылки SDK-пути (нет единого пакета android-sdk)",
        uk: "Пакети android-tools, aapt, aapt2, apksigner, d8 + посилання SDK-шляху (немає єдиного пакета android-sdk)",
        en: "Termux tool packages (android-tools, aapt, aapt2, apksigner, d8) plus SDK-path links; no single android-sdk package",
      },
      note: {
        ru: "Текущий каталог собирает этот набор и связывает бинарные файлы с каталогом SDK; это не pkg-пакет android-sdk.",
        uk: "Поточний каталог збирає цей набір і пов’язує бінарні файли з каталогом SDK; це не pkg-пакет android-sdk.",
        en: "The existing installer assembles this set and links binaries into the SDK directory; there is no android-sdk pkg package.",
      },
    },
    linux: {
      kind: "sdkmanager",
      packageName: "build-tools;35.0.0",
      command: 'apt-get update && apt-get install -y adb unzip wget curl && sdkmanager "build-tools;35.0.0"',
      note: {
        ru: "Требуются заранее установленные Android cmdline-tools; SDK Manager устанавливает build-tools.",
        uk: "Потрібні заздалегідь встановлені Android cmdline-tools; SDK Manager встановлює build-tools.",
        en: "Requires Android cmdline-tools to be present; SDK Manager installs the build-tools.",
      },
    },
  },
  "android-ndk": {
    termux: {
      kind: "artifact",
      display: {
        ru: "Прямой артефакт GitHub: android-ndk-r29-aarch64.tar.xz (SHA-256 закреплён; только Termux aarch64)",
        uk: "Прямий артефакт GitHub: android-ndk-r29-aarch64.tar.xz (SHA-256 закріплено; лише Termux aarch64)",
        en: "Direct GitHub artifact: android-ndk-r29-aarch64.tar.xz (pinned SHA-256; Termux aarch64 only)",
      },
    },
    linux: {
      kind: "unsupported",
      display: {
        ru: "В Debian/Ubuntu proot не поддерживается; установщик каталога предназначен для Termux aarch64.",
        uk: "У Debian/Ubuntu proot не підтримується; інсталятор каталогу призначений для Termux aarch64.",
        en: "Not supported in Debian/Ubuntu proot; the catalog installer targets Termux aarch64.",
      },
    },
  },
  gradle: { termux: packageRoute("gradle", "termux"), linux: packageRoute("gradle", "linux") },
  ant: { termux: packageRoute("ant", "termux"), linux: packageRoute("ant", "linux") },
  maven: { termux: packageRoute("maven", "termux"), linux: packageRoute("maven", "linux") },
  nano: { termux: packageRoute("nano", "termux"), linux: packageRoute("nano", "linux") },
  vim: { termux: packageRoute("vim", "termux"), linux: packageRoute("vim", "linux") },
  nodejs: { termux: packageRoute("nodejs-lts", "termux"), linux: packageRoute("nodejs", "linux") },
  npm: {
    termux: {
      ...packageRoute("nodejs-lts", "termux"),
      note: {
        ru: "Текущий установщик проверяет npm после установки nodejs-lts; отдельный пакет npm не запрашивается.",
        uk: "Поточний інсталятор перевіряє npm після встановлення nodejs-lts; окремий пакет npm не запитується.",
        en: "The current installer checks for npm after installing nodejs-lts; it does not request a separate npm package.",
      },
    },
    linux: {
      ...packageRoute("nodejs", "linux"),
      note: {
        ru: "Сценарий базы устанавливает nodejs и затем проверяет npm; отдельный apt-пакет npm им не запрашивается.",
        uk: "Сценарій бази встановлює nodejs і потім перевіряє npm; окремий apt-пакет npm ним не запитується.",
        en: "The existing installer requests nodejs and then checks npm; it does not explicitly request the separate apt package npm.",
      },
    },
  },
  pnpm: {
    termux: {
      kind: "npm-global",
      packageName: "pnpm",
      command: "npm install -g pnpm",
      note: {
        ru: "Требуется Node.js/npm; сценарий каталога предварительно устанавливает nodejs-lts.",
        uk: "Потрібен Node.js/npm; сценарій каталогу попередньо встановлює nodejs-lts.",
        en: "Requires Node.js/npm; the catalog installer first requests nodejs-lts.",
      },
    },
    linux: {
      kind: "npm-global",
      packageName: "pnpm",
      command: "npm install -g pnpm",
      note: {
        ru: "Требуется Node.js/npm; текущий сценарий устанавливает nodejs перед этой проверкой.",
        uk: "Потрібен Node.js/npm; поточний сценарій встановлює nodejs перед цією перевіркою.",
        en: "Requires Node.js/npm; the existing installer requests nodejs before this check.",
      },
    },
  },
  kotlin: { termux: packageRoute("kotlin", "termux"), linux: packageRoute("kotlin", "linux") },
  python: { termux: packageRoute("python", "termux"), linux: packageRoute("python3", "linux") },
  "termux-api": { termux: packageRoute("termux-api", "termux"), linux: packageRoute("termux-api", "termux") },
  aapt2: {
    termux: packageRoute("aapt2", "termux"),
    linux: sdkmanagerRoute("linux", "build-tools;35.0.0"),
  },
  zipalign: {
    termux: sdkmanagerRoute("termux", "build-tools;35.0.0"),
    linux: sdkmanagerRoute("linux", "build-tools;35.0.0"),
  },
  apksigner: {
    termux: packageRoute("apksigner", "termux"),
    linux: sdkmanagerRoute("linux", "build-tools;35.0.0"),
  },
  "platform-tools": { termux: packageRoute("android-tools", "termux"), linux: packageRoute("adb", "linux") },
  which: { termux: packageRoute("which", "termux"), linux: packageRoute("which", "linux") },
  ninja: { termux: packageRoute("ninja", "termux"), linux: packageRoute("ninja-build", "linux") },
  "sdk-cmdline-tools": {
    termux: {
      kind: "artifact",
      display: {
        ru: "Официальный ZIP cmdline-tools с dl.google.com → $ANDROID_HOME/cmdline-tools/latest (SHA-256 проверяется)",
        uk: "Офіційний ZIP cmdline-tools з dl.google.com → $ANDROID_HOME/cmdline-tools/latest (SHA-256 перевіряється)",
        en: "Official cmdline-tools ZIP from dl.google.com → $ANDROID_HOME/cmdline-tools/latest (SHA-256 verified)",
      },
    },
    linux: {
      kind: "artifact",
      display: {
        ru: "Официальный ZIP cmdline-tools с dl.google.com → $ANDROID_HOME/cmdline-tools/latest (SHA-256 проверяется)",
        uk: "Офіційний ZIP cmdline-tools з dl.google.com → $ANDROID_HOME/cmdline-tools/latest (SHA-256 перевіряється)",
        en: "Official cmdline-tools ZIP from dl.google.com → $ANDROID_HOME/cmdline-tools/latest (SHA-256 verified)",
      },
    },
  },
  "android-platform-34": {
    termux: sdkmanagerRoute("termux", "platforms;android-34"),
    linux: sdkmanagerRoute("linux", "platforms;android-34"),
  },
  "android-platform-35": {
    termux: sdkmanagerRoute("termux", "platforms;android-35"),
    linux: sdkmanagerRoute("linux", "platforms;android-35"),
  },
  "proot-distro": { termux: packageRoute("proot-distro", "termux"), linux: packageRoute("proot-distro", "termux") },
  "debian-rootfs": {
    termux: {
      kind: "bootstrap",
      display: { ru: "Установите через «Пакеты → Debian rootfs» — перед установкой проверяются список и вход; существующий rootfs не сбрасывается.", uk: "Встановіть через «Пакети → Debian rootfs» — перед встановленням перевіряються список і вхід; наявний rootfs не скидається.", en: "Use Packages → Debian rootfs. The app checks the installed list and login first; existing rootfs data is never reset." },
    },
    linux: {
      kind: "bootstrap",
      display: { ru: "Установите через «Пакеты → Debian rootfs» на хосте Termux; автоматический reset/remove отключён.", uk: "Встановіть через «Пакети → Debian rootfs» на хості Termux; автоматичний reset/remove вимкнено.", en: "Use Packages → Debian rootfs on the Termux host; automatic reset/remove is disabled." },
    },
  },
  "ubuntu-rootfs": {
    termux: {
      kind: "bootstrap",
      display: { ru: "Установите через «Пакеты → Ubuntu rootfs» — перед установкой проверяются список и вход; существующий rootfs не сбрасывается.", uk: "Встановіть через «Пакеты → Ubuntu rootfs» — перед встановленням перевіряються список і вхід; наявний rootfs не скидається.", en: "Use Packages → Ubuntu rootfs. The app checks the installed list and login first; existing rootfs data is never reset." },
    },
    linux: {
      kind: "bootstrap",
      display: { ru: "Установите через «Пакеты → Ubuntu rootfs» на хосте Termux; автоматический reset/remove отключён.", uk: "Встановіть через «Пакеты → Ubuntu rootfs» на хості Termux; автоматичний reset/remove вимкнено.", en: "Use Packages → Ubuntu rootfs on the Termux host; automatic reset/remove is disabled." },
    },
  },
};

function targetLabel(lang: GuideLanguage, target: PackageBackendTarget, selectedBackend: GuideBackend): string {
  if (target === "termux") return lang === "en" ? "Termux host" : "хост Termux";
  const distro = "Ubuntu";
  return `${distro} proot`;
}

const ROUTE_LABEL: Record<GuideLanguage, Record<GuideRouteKind, string>> = {
  ru: {
    "termux-package": "Пакет Termux",
    "apt-package": "Пакет apt",
    sdkmanager: "Android SDK Manager",
    "npm-global": "Глобальный пакет npm",
    artifact: "Прямая загрузка",
    bootstrap: "Инициализация среды",
    setup: "Сборка SDK-инструментов",
    unsupported: "Маршрут недоступен",
  },
  uk: {
    "termux-package": "Пакет Termux",
    "apt-package": "Пакет apt",
    sdkmanager: "Android SDK Manager",
    "npm-global": "Глобальний пакет npm",
    artifact: "Пряме завантаження",
    bootstrap: "Ініціалізація середовища",
    setup: "Збирання SDK-інструментів",
    unsupported: "Маршрут недоступний",
  },
  en: {
    "termux-package": "Termux package",
    "apt-package": "apt package",
    sdkmanager: "Android SDK Manager",
    "npm-global": "Global npm package",
    artifact: "Direct download",
    bootstrap: "Environment bootstrap",
    setup: "SDK tool setup",
    unsupported: "Route unavailable",
  },
};

export function getCompileGuideInstruction(
  id: string,
  selectedBackend: GuideBackend,
  lang: GuideLanguage,
): CompileGuideInstruction {
  const rule = COMPILE_GUIDE_RULES[id];
  if (!rule) throw new Error(`COMPILE_GUIDE_RULE_MISSING:${id}`);
  const target = packageBackendTarget(selectedBackend, id);
  const route = rule[target];
  const command = route.command ?? null;
  const display = command ?? route.display?.[lang] ?? "";
  const actualPackage = route.packageName;
  const routeLabel = ROUTE_LABEL[lang][route.kind];
  const environmentLabel = targetLabel(lang, target, selectedBackend);
  const packageSuffix = actualPackage
    ? ` · ${lang === "en" ? "actual name" : lang === "uk" ? "фактична назва" : "фактическое имя"}: ${actualPackage}`
    : "";
  const description = [
    `${lang === "en" ? "Target" : lang === "uk" ? "Середовище" : "Среда"}: ${environmentLabel}`,
    `${routeLabel}${packageSuffix}`,
    route.note?.[lang] ?? "",
  ].filter(Boolean).join(". ");
  if (id === "android-ndk" && !isPackageSupportedOnBackend(id, target)) {
    return { target, kind: "unsupported", command: null, display, description, actualPackage };
  }
  return { target, kind: route.kind, command, display, description, actualPackage };
}

export function buildCompileGuideRows<T extends CompileGuidePackage>(
  packages: readonly T[],
  backend: GuideBackend,
  lang: GuideLanguage,
): CompileGuideRow<T>[] {
  return packages.map((source) => ({
    source,
    title: lang === "en" ? source.nameEn : source.name,
    instruction: getCompileGuideInstruction(source.id, backend, lang),
  }));
}

export function filterCompileGuideRows<T extends CompileGuidePackage>(
  rows: readonly CompileGuideRow<T>[],
  query: string,
): CompileGuideRow<T>[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [...rows];
  return rows.filter(({ source, title, instruction }) => {
    const haystack = [
      source.id,
      source.name,
      source.nameEn,
      instruction.description,
      instruction.command ?? "",
      instruction.display,
      instruction.actualPackage ?? "",
    ].join(" ").toLocaleLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}
