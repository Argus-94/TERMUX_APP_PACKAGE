/** Pure command routing for the package menu; kept separate for shell-level tests. */
export type PackageBackendTarget = "termux" | "linux";
export type PackageCommandKind = "check" | "install" | "remove" | "update";

/** Resolve one SDK root for every package operation; explicit ANDROID_HOME wins. */
export function androidSdkRootEnvironment(): string {
  return 'ANDROID_HOME="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$PREFIX/opt/android-sdk}}"; ANDROID_SDK_ROOT="$ANDROID_HOME"; export ANDROID_HOME ANDROID_SDK_ROOT; ';
}

const HOST_TERMUX_PACKAGE_IDS = new Set([
  "proot-distro",
  "debian-rootfs",
  "ubuntu-rootfs",
  "termux-api",
  "frida-tools",
]);

const APT_MAP: Record<string, string> = {
  "openjdk-17": "openjdk-17-jdk",
  "openjdk-21": "openjdk-21-jdk",
  "nodejs-lts": "nodejs",
  python: "python3",
  "kotlin-compiler": "kotlin",
  ninja: "ninja-build",
  "android-tools": "adb",
  "zip-unzip": "zip unzip",
  "termux-api": "__UNSUPPORTED__",
  aapt2: "__SDKMANAGER__",
  aapt: "__SDKMANAGER__",
  apksigner: "__SDKMANAGER__",
  zipalign: "__SDKMANAGER__",
  d8: "__SDKMANAGER__",
};

export function packageBackendTarget(
  selectedBackend: "termux" | "ubuntu-proot",
  packageId?: string,
): PackageBackendTarget {
  if (selectedBackend === "termux" || HOST_TERMUX_PACKAGE_IDS.has(String(packageId || ""))) {
    return "termux";
  }
  return "linux";
}

export function isPackageSupportedOnBackend(
  packageId: string | undefined,
  target: PackageBackendTarget,
): boolean {
  return !(target === "linux" && packageId === "android-ndk");
}

/** Convert catalog commands to Termux's supported pkg frontend, preserving apt repair commands. */
export function adaptTermuxPackageCommand(command: string): string {
  return String(command || "")
    .split("\n")
    .map((line) => {
      if (/^\s*(?:#|echo\b|printf\b)/i.test(line)) return line;
      return line
        .replace(/\bapt-get\s+install(?:\s+-y)?\b/g, "pkg install -y")
        .replace(/\bapt-get\s+(?:remove|purge)(?:\s+-y)?\b/g, "pkg uninstall -y");
    })
    .join("\n");
}

function transformPkgArgs(args: string, verb: "install" | "uninstall"): string {
  // Keep shell redirections/pipelines outside the package-name list.
  const m = args.match(/^(.*?)(\s+(?:2?>&?\d+|[|&]).*)$/);
  const pkgPart = (m ? m[1] : args).trim();
  const suffix = m ? m[2] : "";
  const tokens = pkgPart.split(/\s+/).filter(Boolean);
  const sdkOnly = tokens
    .filter((token) => !["-y", "--yes"].includes(token))
    .some((token) => APT_MAP[token] === "__SDKMANAGER__");

  if (sdkOnly) {
    const sdkPkgs = tokens.filter(
      (token) => !["-y", "--yes"].includes(token) && APT_MAP[token] !== "__SDKMANAGER__",
    );
    const base = sdkPkgs.length
      ? `apt-get ${verb === "install" ? "install" : "remove"} -y ${sdkPkgs
          .map((token) => APT_MAP[token] ?? token)
          .join(" ")}`
      : ":";
    const sdkmanager =
      '"${ANDROID_HOME:-$PREFIX/opt/android-sdk}/cmdline-tools/latest/bin/sdkmanager"';
    if (verb !== "install") {
      return `${base}; if [ -x ${sdkmanager} ]; then yes | ${sdkmanager} --uninstall "build-tools;35.0.0"; else echo SDKMANAGER_REQUIRED >&2; exit 78; fi${suffix}`;
    }
    return `${base}; if [ -x ${sdkmanager} ]; then yes | ${sdkmanager} "build-tools;35.0.0"; else echo SDKMANAGER_REQUIRED >&2; exit 78; fi${suffix}`;
  }

  const out: string[] = [];
  for (const token of tokens) {
    if (token === "-y" || token === "--yes") continue;
    const mapped = APT_MAP[token] ?? token;
    if (mapped === "__UNSUPPORTED__") {
      throw new Error(`PACKAGE_UNSUPPORTED_IN_LINUX: ${token}`);
    }
    out.push(...mapped.split(/\s+/));
  }
  return `apt-get ${verb === "install" ? "install" : "remove"} -y ${out.join(" ")}${suffix}`;
}

/** Apply Ubuntu/Debian package mappings to catalog apt-get commands. */
function adaptAptGetPackageCommands(command: string): string {
  return String(command || "")
    .split("\n")
    .map((line) => {
      if (/^\s*(?:#|echo\b|printf\b)/i.test(line)) return line;
      return line.replace(
        /(^\s*|(?:&&|\|\||;)\s*)apt-get\s+(install|remove)\s+([\s\S]*?)(?=(?:\s*(?:&&|\|\||;)\s*apt-get\s+(?:install|remove)\b)|$)/g,
        (_match, prefix: string, verb: "install" | "remove", args: string) =>
          prefix + transformPkgArgs(args, verb === "remove" ? "uninstall" : "install"),
      );
    })
    .join("\n");
}

/** Convert one legacy package catalog command for its actual execution backend. */
export function adaptPackageCommandForBackend(
  command: string,
  kind: PackageCommandKind,
  target: PackageBackendTarget,
): string {
  if (target === "termux") return adaptTermuxPackageCommand(command);

  let c = String(command || "");
  c = c.replace(/\/data\/data\/com\.termux\/files\/usr/g, "$PREFIX");
  c = c.replace(/\/data\/data\/com\.termux\/files\/home/g, "$HOME");
  c = c.replace(/\$PREFIX/g, "${PREFIX}");
  c = `PREFIX="${"${PREFIX:-/root/.aibuilder-prefix}"}"; export PREFIX; ` + c;
  c = c.replace(/\btermux-change-repo\b[^;\n]*/g, "true");
  c = c.replace(/\bpkg\s+update(?:\s+-y)?/g, "apt-get update");
  c = c.replace(/\bpkg\s+install\s+([^;\n]+)/g, (_match, args: string) =>
    transformPkgArgs(args, "install"),
  );
  c = c.replace(/\bpkg\s+uninstall\s+([^;\n]+)/g, (_match, args: string) =>
    transformPkgArgs(args, "uninstall"),
  );
  c = adaptAptGetPackageCommands(c);
  c = c.replace(/#!\/data\/data\/com\.termux\/files\/usr\/bin\/(?:sh|bash)/g, "#!/bin/sh");

  // The kind is included in this API so call sites cannot silently bypass the
  // same backend adaptation for installation, verification, and removal.
  void kind;
  return c;
}
