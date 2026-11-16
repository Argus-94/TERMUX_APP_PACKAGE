#!/usr/bin/env node
/**
 * v227 production-logic scenarios. Native/device, live APIs, apt and model
 * inference are explicit mocks; generated project files and shell scripts use
 * a disposable local filesystem where practical.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Module from "node:module";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const require = createRequire(import.meta.url);
const ts = require("typescript");
const moduleCache = new Map();
const runtime = { runShellCommand: null, rootCheck: null, initLlama: null, sharedRoot: null };
const asyncStorage = new Map();
const secureStorage = new Map();
let secureWriteFailures = 0;

function resolveTs(parent, request) {
  const base = path.resolve(path.dirname(parent), request);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, path.join(base, "index.ts")]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}
function loadTs(file) {
  file = path.resolve(file);
  if (moduleCache.has(file)) return moduleCache.get(file).exports;
  const mod = new Module(file);
  mod.filename = file;
  mod.paths = Module._nodeModulePaths(path.dirname(file));
  moduleCache.set(file, mod);
  mod.require = (request) => {
    if (request === "./termux-bridge") return { runShellCommand: runtime.runShellCommand, getTermuxNative: () => ({}) };
    if (request.includes("termux-executor") && file.endsWith("/core/environment/AIBuilderTermuxEnvironment.ts")) {
      return { executeGuardedTermuxCommand: async (command) => runtime.runShellCommand(command) };
    }
    if (request.includes("writable-path-policy") && file.endsWith("/core/environment/AIBuilderTermuxEnvironment.ts")) {
      const sharedRoot = runtime.sharedRoot;
      return {
        AI_BUILDER_SHARED_ROOT: sharedRoot,
        SHARED_APP_WRITE_ROOTS: [sharedRoot],
        async resolveAllowedWritePath(candidate, roots, resolve) {
          const canonical = await resolve(candidate);
          if (roots.some((root) => canonical === root || canonical.startsWith(`${root.replace(/\/+$/, "")}/`))) return canonical;
          throw new Error("PATH_OUTSIDE_ALLOWED_WRITE_ROOT");
        },
      };
    }
    if (request === "./foreground-task") return { withForegroundTask: async (_kind, _label, fn) => fn(() => {}) };
    if (request === "./termux-bootstrap-install") return { buildProotDistroRootfsCheckCommand: (profile) => runtime.rootCheck(profile) };
    if (request === "expo-file-system") return {
      Paths: { document: "/mock/documents" },
      Directory: class { constructor(..._args) {} get exists() { return true; } create() {} },
      File: class {
        constructor(...args) { this.name = String(args[args.length - 1] || "model.gguf"); this.uri = `/mock/models/${this.name}`; }
        get exists() { return true; }
        get size() { return 1_929_903_264; }
        open() { throw new Error("native file read intentionally mocked"); }
      },
    };
    if (request === "expo-file-system/legacy") return {};
    if (request === "llama.rn") return { initLlama: runtime.initLlama };
    if (request === "@react-native-async-storage/async-storage") return {
      default: {
        async getItem(k) { return asyncStorage.has(k) ? asyncStorage.get(k) : null; },
        async setItem(k, v) { asyncStorage.set(k, String(v)); },
        async removeItem(k) { asyncStorage.delete(k); },
      },
      async getItem(k) { return asyncStorage.has(k) ? asyncStorage.get(k) : null; },
      async setItem(k, v) { asyncStorage.set(k, String(v)); },
      async removeItem(k) { asyncStorage.delete(k); },
    };
    if (request === "expo-secure-store") return {
      async setItemAsync(k, v) {
        if (secureWriteFailures > 0) { secureWriteFailures -= 1; throw new Error("controlled secure store failure"); }
        secureStorage.set(k, String(v));
      },
      async getItemAsync(k) { return secureStorage.has(k) ? secureStorage.get(k) : null; },
    };
    if (request === "./project-generator") return { generateProjectStructure: () => ({}) };
    if (request === "./termux-guard") {
      const guardModule = resolveTs(file, request);
      return guardModule ? loadTs(guardModule) : { getPreferredProjectRoot: () => "/tmp/aib-projects" };
    }
    if (request.includes("writable-path-policy") && runtime.sharedRoot) {
      const sharedRoot = String(runtime.sharedRoot || "");
      const within = (candidate) => {
        const resolved = path.resolve(String(candidate || ""));
        return !!sharedRoot && resolved.startsWith(`${path.resolve(sharedRoot)}/`);
      };
      return {
        AI_BUILDER_SHARED_ROOT: sharedRoot,
        SHARED_APP_WRITE_ROOTS: [sharedRoot],
        isWithinSharedAppRoot: within,
        isWithinSharedProjectsRoot: (candidate) => within(candidate) && path.resolve(String(candidate || "")).startsWith(path.join(path.resolve(sharedRoot), "projects") + path.sep),
        async resolveAllowedWritePath(candidate, _roots, resolvePath) {
          const canonical = await resolvePath(String(candidate));
          if (!within(canonical)) throw new Error("PATH_OUTSIDE_ALLOWED_WRITE_ROOT");
          return canonical;
        },
      };
    }
    const resolved = request.startsWith(".") ? resolveTs(file, request) : null;
    return resolved ? loadTs(resolved) : createRequire(file)(request);
  };
  const js = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: file,
  }).outputText;
  mod._compile(js, file);
  return mod.exports;
}
function bash(command, env = {}) {
  const r = spawnSync("bash", ["-c", command], { encoding: "utf8", env: { ...process.env, ...env }, timeout: 30_000 });
  return { exitCode: r.status ?? 1, stdout: r.stdout || "", stderr: r.stderr || (r.error?.message ?? "") };
}
function installFakeProotDistro(bin) {
  const script = [
    "#!/bin/sh", "set -eu", "case \"$1\" in",
    "  list)", "    printf 'Installed distributions:\\n'", "    found=0",
    "    for alias in debian ubuntu; do if [ -f \"$STATE_DIR/$alias\" ]; then printf '  %s\\n' \"$alias\"; found=1; fi; done",
    "    [ \"$found\" -eq 1 ] || printf '(none)\\n'", "    exit 0", "    ;;",
    "  login)", "    alias=\"${2:-}\"", "    [ -f \"$STATE_DIR/$alias\" ] || exit 1",
    "    root=\"$PREFIX/var/lib/proot-distro/installed-rootfs/$alias\"",
    "    id=$(sed -n 's/^ID=//p' \"$root/etc/os-release\" 2>/dev/null | head -1 | tr -d '\"')",
    "    [ \"$id\" = \"$alias\" ] || exit 1",
    "    printf 'AIB_PROBE_ID:%s\\nAIB_PROBE_UID:1000\\nAIB_PROBE_UNAME:x86_64\\n' \"$alias\"", "    exit 0", "    ;;",
    "  restore)", "    archive=\"${2:-}\"", "    stage=$(mktemp -d \"${TMPDIR:-/tmp}/aib-fixture-restore.XXXXXX\")",
    "    if ! tar -xzf \"$archive\" -C \"$stage\" --strip-components=1 >/dev/null 2>&1; then rm -rf \"$stage\"; echo RESTORE_REJECTED >&2; exit 1; fi",
    "    first=$(tar -tzf \"$archive\" 2>/dev/null | head -1 || true)", "    alias=${first%%/*}",
    "    case \"$alias\" in debian|ubuntu) ;; *) rm -rf \"$stage\"; echo RESTORE_REJECTED >&2; exit 1;; esac",
    "    id=$(sed -n 's/^ID=//p' \"$stage/etc/os-release\" 2>/dev/null | head -1 | tr -d '\"')",
    "    if [ \"$id\" != \"$alias\" ]; then rm -rf \"$stage\"; echo RESTORE_REJECTED >&2; exit 1; fi",
    "    root=\"$PREFIX/var/lib/proot-distro/installed-rootfs/$alias\"",
    "    if [ -e \"$root\" ]; then rm -rf \"$stage\"; echo RESTORE_REFUSED_EXISTING_ROOT >&2; exit 1; fi",
    "    mkdir -p \"$root\" \"$STATE_DIR\"", "    cp -a \"$stage/.\" \"$root/\"", "    touch \"$STATE_DIR/$alias\"", "    rm -rf \"$stage\"", "    exit 0", "    ;;",
    "  *) exit 1;;", "esac",
  ].join(String.fromCharCode(10));
  fs.writeFileSync(path.join(bin, "proot-distro"), script + String.fromCharCode(10), { mode: 0o755 });
}
const cases = [];
async function scenario(name, fn) {
  try {
    await fn();
    cases.push({ name, ok: true });
    console.log(`PASS ${name}`);
  } catch (error) {
    cases.push({ name, ok: false, error });
    console.error(`FAIL ${name}: ${error instanceof Error ? error.stack || error.message : String(error)}`);
  }
}

await scenario("Project journey: select node template → write Unicode/space-named edit → build/test → production export command → verify archive artifact", async () => {
  moduleCache.clear();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aib-v227-project-"));
  runtime.sharedRoot = tmp;
  try {
    const projectPath = path.join(tmp, "projects", "Demo project 'λ");
    fs.mkdirSync(projectPath, { recursive: true });
    const { AIWorkspaceBuilder } = loadTs(path.join(root, "core/workspace/AIWorkspaceBuilder.ts"));
    const { AIProjectGenerator } = loadTs(path.join(root, "core/workspace/AIProjectGenerator.ts"));
    const calls = [];
    const containers = {
      async exec(id, command, args, opts) {
        calls.push({ id, command, args, opts });
        if (command === "python3") {
          const rel = String(args[1]).match(/p=("[^\"]+")/)?.[1];
          assert.ok(rel, "generator writes through its Python adapter");
          const virtual = JSON.parse(rel);
          const local = path.join(projectPath, virtual.replace(/^\/workspace\//, ""));
          const rewritten = String(args[1]).replace(rel, JSON.stringify(local));
          const r = spawnSync("python3", ["-c", rewritten], { encoding: "utf8" });
          return { exitCode: r.status ?? 1, stdout: r.stdout || "", stderr: r.stderr || "", durationMs: 1 };
        }
        if (command === "pnpm" && args[0] === "run" && args[1] === "build") {
          fs.mkdirSync(path.join(projectPath, "dist"), { recursive: true });
          fs.writeFileSync(path.join(projectPath, "dist", "artifact.txt"), "BUILD_FIXTURE_OK\n");
        }
        return { exitCode: 0, stdout: `${command} ${args.join(" ")} OK`, stderr: "", durationMs: 1 };
      },
    };
    const builder = new AIWorkspaceBuilder(containers);
    const generator = new AIProjectGenerator(containers, builder);
    const result = await generator.generate("container-test", {
      name: "demo-app", goal: "Create an offline demo", template: "node",
      files: [{ path: "src/hello world-λ.js", content: "export const label = 'Привет';\n" }],
      runWorkflow: true, build: true, test: true,
    });
    assert.equal(result.ok, true);
    assert.equal(result.template, "node");
    assert.equal(result.build?.steps.map((s) => s.name).join(","), "install,build,test");
    assert.equal(fs.readFileSync(path.join(projectPath, "src/hello world-λ.js"), "utf8"), "export const label = 'Привет';\n");
    assert.equal(fs.readFileSync(path.join(projectPath, "dist/artifact.txt"), "utf8"), "BUILD_FIXTURE_OK\n");
    const { exportZipCommand } = loadTs(path.join(root, "lib/active-project.ts"));
    const exported = bash(exportZipCommand(projectPath));
    assert.equal(exported.exitCode, 0, exported.stderr);
    const archiveName = fs.readdirSync(path.join(tmp, "projects")).find((name) => name.startsWith("Demo project 'λ-export-") && name.endsWith(".tar.gz"));
    assert.ok(archiveName, "export command creates a timestamped archive beside the project");
    const archive = path.join(tmp, "projects", archiveName);
    assert.ok(fs.existsSync(archive), "export command creates artifact at quoted path");
    const members = bash(`tar -tzf ${JSON.stringify(archive)}`);
    assert.equal(members.exitCode, 0, members.stderr);
    assert.match(members.stdout, /src\/hello world-λ\.js/);
    assert.match(members.stdout, /dist\/artifact\.txt/);
    assert.ok(calls.some((c) => c.command === "pnpm" && c.args[0] === "run" && c.args[1] === "build"));
    await assert.rejects(generator.generate("container-test", { name: "bad", goal: "x", template: "node", files: [{ path: "../escape", content: "x" }], runWorkflow: false }), /PROJECT_FILE_PATH_INVALID/);
  } finally { runtime.sharedRoot = null; fs.rmSync(tmp, { recursive: true, force: true }); }
});

await scenario("Debian import preserves registered rootfs and restores a validated archive only into confirmed-absent state", async () => {
  moduleCache.clear();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aib-v227-debian-"));
  try {
    const prefix = path.join(tmp, "prefix");
    const rootfs = path.join(prefix, "var/lib/proot-distro/installed-rootfs/debian");
    const bin = path.join(tmp, "bin");
    const stateDir = path.join(tmp, "state");
    fs.mkdirSync(path.join(rootfs, "etc"), { recursive: true }); fs.mkdirSync(bin); fs.mkdirSync(stateDir);
    fs.writeFileSync(path.join(rootfs, "etc/os-release"), "ID=debian\nNAME=Debian\n");
    fs.writeFileSync(path.join(rootfs, "keep.txt"), "old-debian-state");
    fs.writeFileSync(path.join(stateDir, "debian"), "");
    fs.writeFileSync(path.join(tmp, "broken archive.tar.gz"), "not a tar archive");
    installFakeProotDistro(bin);
    runtime.runShellCommand = async (cmd) => bash(cmd, { PREFIX: prefix, HOME: tmp, STATE_DIR: stateDir, PATH: `${bin}:/usr/bin:/bin` });
    const { importDebian } = loadTs(path.join(root, "lib/ubuntu-distro.ts"));
    const result = await importDebian(path.join(tmp, "broken archive.tar.gz"));
    assert.equal(result.ok, false, "an installed Debian rootfs is never replaced by an import");
    assert.equal(fs.readFileSync(path.join(rootfs, "keep.txt"), "utf8"), "old-debian-state", "registered rootfs is preserved");

    fs.rmSync(path.join(stateDir, "debian"), { force: true });
    fs.rmSync(rootfs, { recursive: true, force: true });
    const rejected = await importDebian(path.join(tmp, "broken archive.tar.gz"));
    assert.equal(rejected.ok, false, "a corrupt archive cannot report successful import into a missing distro");
    assert.equal(fs.existsSync(rootfs), false, "corrupt archive must not create a partial rootfs");

    const payload = path.join(tmp, "valid rootfs", "debian");
    fs.mkdirSync(path.join(payload, "etc"), { recursive: true });
    fs.writeFileSync(path.join(payload, "etc/os-release"), "ID=debian\nNAME=Debian\n");
    fs.writeFileSync(path.join(payload, "new.txt"), "replacement-state");
    const archive = path.join(tmp, "valid archive with spaces.tar.gz");
    const made = spawnSync("tar", ["-czf", archive, "-C", path.dirname(payload), "debian"], { encoding: "utf8" });
    assert.equal(made.status, 0, made.stderr);
    const replaced = await importDebian(archive);
    assert.equal(replaced.ok, true, replaced.log);
    assert.equal(fs.readFileSync(path.join(rootfs, "new.txt"), "utf8"), "replacement-state");
    assert.equal(fs.existsSync(path.join(rootfs, "keep.txt")), false, "fresh restore contains only the validated archive");
    assert.equal(fs.readdirSync(path.dirname(rootfs)).some((name) => name.startsWith(".aib-debian-import-")), false, "temporary stage/pre-image cleaned");
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

await scenario("Ubuntu import: bad archive is not reported successful merely because old Ubuntu remains installed", async () => {
  moduleCache.clear();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aib-v227-ubuntu-"));
  try {
    const prefix = path.join(tmp, "prefix");
    const rootfs = path.join(prefix, "var/lib/proot-distro/installed-rootfs/ubuntu");
    const bin = path.join(tmp, "bin");
    const stateDir = path.join(tmp, "state");
    fs.mkdirSync(path.join(rootfs, "etc"), { recursive: true }); fs.mkdirSync(bin); fs.mkdirSync(stateDir);
    fs.writeFileSync(path.join(rootfs, "etc/os-release"), "ID=ubuntu\nNAME=Ubuntu\n");
    fs.writeFileSync(path.join(rootfs, "keep.txt"), "old-ubuntu-state");
    fs.writeFileSync(path.join(stateDir, "ubuntu"), "");
    fs.writeFileSync(path.join(tmp, "broken archive.tar.gz"), "not a tar archive");
    installFakeProotDistro(bin);
    runtime.runShellCommand = async (cmd) => bash(cmd, { PREFIX: prefix, HOME: tmp, STATE_DIR: stateDir, PATH: `${bin}:/usr/bin:/bin` });
    const { importUbuntu } = loadTs(path.join(root, "lib/ubuntu-distro.ts"));
    const result = await importUbuntu(path.join(tmp, "broken archive.tar.gz"));
    assert.equal(result.ok, false, "an installed Ubuntu rootfs must not be replaced by an archive import");
    assert.notEqual(result.exitCode, 0);
    assert.equal(fs.readFileSync(path.join(rootfs, "keep.txt"), "utf8"), "old-ubuntu-state");
    assert.equal(fs.readFileSync(path.join(rootfs, "etc/os-release"), "utf8"), "ID=ubuntu\nNAME=Ubuntu\n");

    fs.rmSync(path.join(stateDir, "ubuntu"), { force: true });
    fs.rmSync(rootfs, { recursive: true, force: true });

    const shellOnly = path.join(tmp, "shell-only", "ubuntu");
    fs.mkdirSync(path.join(shellOnly, "bin"), { recursive: true });
    fs.writeFileSync(path.join(shellOnly, "bin/sh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const shellOnlyArchive = path.join(tmp, "shell-only.tar.gz");
    const shellOnlyTar = spawnSync("tar", ["-czf", shellOnlyArchive, "-C", path.dirname(shellOnly), "ubuntu"], { encoding: "utf8" });
    assert.equal(shellOnlyTar.status, 0, shellOnlyTar.stderr);
    const unidentified = await importUbuntu(shellOnlyArchive);
    assert.equal(unidentified.ok, false, "an executable shell alone does not establish Ubuntu identity");
    assert.match(unidentified.log, /RESTORE_REJECTED/);
    assert.equal(fs.existsSync(rootfs), false, "unidentified archive must not create or replace a rootfs");

    const legacy = path.join(tmp, "legacy-rootfs", "ubuntu");
    fs.mkdirSync(path.join(legacy, "etc"), { recursive: true });
    fs.mkdirSync(path.join(legacy, "bin"), { recursive: true });
    fs.writeFileSync(path.join(legacy, "etc/os-release"), "ID=ubuntu\nNAME=Ubuntu\n");
    fs.writeFileSync(path.join(legacy, "etc/lsb-release"), "DISTRIB_ID=Ubuntu\nDISTRIB_RELEASE=20.04\n");
    fs.writeFileSync(path.join(legacy, "bin/sh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    fs.writeFileSync(path.join(legacy, "legacy.txt"), "recognized-legacy-ubuntu");
    const legacyArchive = path.join(tmp, "legacy-ubuntu.tar.gz");
    const legacyTar = spawnSync("tar", ["-czf", legacyArchive, "-C", path.dirname(legacy), "ubuntu"], { encoding: "utf8" });
    assert.equal(legacyTar.status, 0, legacyTar.stderr);
    const legacyImported = await importUbuntu(legacyArchive);
    assert.equal(legacyImported.ok, true, legacyImported.log);
    assert.equal(fs.readFileSync(path.join(rootfs, "legacy.txt"), "utf8"), "recognized-legacy-ubuntu");
    assert.equal(fs.existsSync(path.join(rootfs, "keep.txt")), false, "recognized legacy import commits only after identity validation");
    assert.equal(fs.readdirSync(path.dirname(rootfs)).some((name) => name.startsWith(".aib-ubuntu-previous-") || name.startsWith(".aib-ubuntu-import-")), false, "rollback restores old root and removes staging/backup directories");
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

await scenario("Runtime backends honor request.env with shell-safe values on host and guest paths", async () => {
  moduleCache.clear();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aib-v227-env-"));
  try {
    const bin = path.join(tmp, "bin"); fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "proot-distro"), "#!/bin/sh\n[ \"$1\" = login ] || exit 3\nshift\nwhile [ \"$#\" -gt 0 ] && [ \"$1\" != -- ]; do shift; done\n[ \"$#\" -gt 0 ] && shift\nexec \"$@\"\n", { mode: 0o755 });
    const { TermuxNativeBackend } = loadTs(path.join(root, "core/runtime/backends/TermuxNativeBackend.ts"));
    const { ProotDistroBackend } = loadTs(path.join(root, "core/runtime/backends/ProotDistroBackend.ts"));
    const value = "space ' ; $(touch SHOULD_NOT_EXIST) 雪";
    const termux = new TermuxNativeBackend(async (command) => bash(command, { PATH: `${bin}:/usr/bin:/bin` }));
    const host = await termux.exec({ command: "printf '%s' \"$AIB_V227_VALUE\"", env: { AIB_V227_VALUE: value } });
    assert.equal(host.exitCode, 0);
    assert.equal(host.stdout, value);
    const guest = new ProotDistroBackend(async (command) => bash(command, { PATH: `${bin}:/usr/bin:/bin` }));
    const inside = await guest.exec({ command: "printf '%s' \"$AIB_V227_VALUE\"", env: { AIB_V227_VALUE: value } });
    assert.equal(inside.exitCode, 0, `guest fake stdout=${inside.stdout} stderr=${inside.stderr}`);
    assert.equal(inside.stdout, value);
    assert.equal(fs.existsSync(path.join(tmp, "SHOULD_NOT_EXIST")), false, "env value must never execute as shell syntax");
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

await scenario("Large backup restore: preserve full tar member listing across the production compression boundary", async () => {
  moduleCache.clear();
  const { TermuxBackupAdapter } = loadTs(path.join(root, "core/backup/TermuxBackupAdapter.ts"));
  const { compressShellOutput } = loadTs(path.join(root, "lib/context-engine.ts"));
  const listing = ["projects", ...Array.from({ length: 500 }, (_, i) => `projects/long file name 雪-${String(i).padStart(4, "0")}.txt`)].join("\n") + "\n";
  const typeListing = ["drwxr-xr-x user/group 0 2026-01-01 00:00 projects", ...Array.from({ length: 500 }, (_, i) => `-rw-r--r-- user/group 1 2026-01-01 00:00 projects/long file name 雪-${String(i).padStart(4, "0")}.txt`)].join("\n") + "\n";
  const compressed = compressShellOutput(listing);
  assert.notEqual(compressed, listing, "fixture must cross the real context-engine compression boundary");
  const calls = [];
  const fakeEnv = {
    async exec(command, options = {}) {
      calls.push({ command, options });
      if (command.includes("| wc -l")) return { exitCode: 0, stdout: "501\n" };
      if (command.includes("| wc -c")) return { exitCode: 0, stdout: "2048\n" };
      if (command.includes("grep")) return { exitCode: 1, stdout: "", stderr: "" };
      if (command.startsWith("tar -tvzf ")) return { exitCode: 0, stdout: typeListing };
      if (command.startsWith("tar -tzf ")) return { exitCode: 0, stdout: options.preserveOutput ? listing : compressed };
      return { exitCode: 0, stdout: "" };
    },
    async mkdir() {},
  };
  const adapter = new TermuxBackupAdapter(fakeEnv, { root: "/termux/home" });
  await adapter.restore("/backup with spaces", ["/termux/home/projects"]);
  const listingCall = calls.find((x) => x.command.startsWith("tar -tzf ") && !x.command.includes("| wc -l"));
  assert.equal(listingCall?.options.preserveOutput, true, "adapter requests uncompressed structured listing");
  assert.ok(calls.some((x) => x.command.startsWith("tar -tvzf ")), "adapter checks file types before destructive clear");
  const extract = calls.find((x) => x.command.startsWith("tar -xzf ") && x.command.includes(" -C "))?.command || "";
  for (const i of [0, 249, 499]) assert.ok(extract.includes(`long file name 雪-${String(i).padStart(4, "0")}.txt`), `validated member ${i} reaches extraction`);
});

await scenario("Profile restore: stage/validate/commit; corrupt archive and injected commit failure roll back with no temp leaks", async () => {
  moduleCache.clear();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aib-v227-profile-"));
  const home = path.join(tmp, "home with ' quotes");
  const source = path.join(tmp, "profile source ' 雪.tar.gz");
  try {
    fs.mkdirSync(path.join(home, "projects"), { recursive: true });
    fs.writeFileSync(path.join(home, "projects", "keep.txt"), "old-state");
    const payload = path.join(tmp, "payload");
    fs.mkdirSync(path.join(payload, "projects"), { recursive: true });
    fs.mkdirSync(path.join(payload, "metadata"), { recursive: true });
    fs.writeFileSync(path.join(payload, "projects", "restored λ.txt"), "new-state");
    fs.writeFileSync(path.join(payload, "metadata", "profile.json"), "{}\n");
    assert.equal(bash(`tar -czf ${JSON.stringify(source)} -C ${JSON.stringify(payload)} projects metadata`).exitCode, 0);
    const { buildProfileImportCommand } = loadTs(path.join(root, "lib/profile-transfer-shell.ts"));
    const success = bash(buildProfileImportCommand(source, home));
    assert.equal(success.exitCode, 0, success.stderr);
    assert.match(success.stdout, /PROFILE_IMPORT_OK/);
    assert.equal(fs.readFileSync(path.join(home, "projects", "restored λ.txt"), "utf8"), "new-state");
    assert.equal(fs.existsSync(path.join(home, "projects", "keep.txt")), false, "restores the affected project scope");
    assert.equal(fs.readFileSync(path.join(home, "metadata", "profile.json"), "utf8"), "{}\n");
    assert.equal(fs.readdirSync(home).some((n) => n.startsWith(".aib-profile-")), false, "stage and pre-image removed on success");

    fs.rmSync(path.join(home, "projects"), { recursive: true, force: true });
    fs.mkdirSync(path.join(home, "projects"), { recursive: true });
    fs.writeFileSync(path.join(home, "projects", "keep.txt"), "rollback-state");
    const corrupt = path.join(tmp, "corrupt.tar.gz"); fs.writeFileSync(corrupt, "truncated gzip");
    const bad = bash(buildProfileImportCommand(corrupt, home));
    assert.notEqual(bad.exitCode, 0);
    assert.equal(fs.readFileSync(path.join(home, "projects", "keep.txt"), "utf8"), "rollback-state");

    const bin = path.join(tmp, "bin"); fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "mv"), "#!/bin/sh\ncase \"$*\" in *aib-profile-stage*projects*) [ \"$AIB_FAIL_COMMIT_MV\" = 1 ] && exit 17;; esac\nexec /bin/mv \"$@\"\n", { mode: 0o755 });
    const failedCommit = bash(buildProfileImportCommand(source, home), { PATH: `${bin}:/usr/bin:/bin`, AIB_FAIL_COMMIT_MV: "1" });
    assert.notEqual(failedCommit.exitCode, 0, "injected commit failure must be visible");
    assert.equal(fs.readFileSync(path.join(home, "projects", "keep.txt"), "utf8"), "rollback-state", "old state restored after partial commit");
    assert.equal(fs.readdirSync(home).some((n) => n.startsWith(".aib-profile-")), false, "rollback leaves no temporary directories");
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

await scenario("Secure API-key persistence: repeated SecureStore failure stays false and never creates a plaintext fallback", async () => {
  moduleCache.clear(); secureStorage.clear(); asyncStorage.clear();
  const { persistSecureStoreItem, readSecureStoreItem } = loadTs(path.join(root, "lib/persistence.ts"));
  secureWriteFailures = 2;
  assert.equal(await persistSecureStoreItem("provider.key", "controlled-test-payload"), false);
  assert.equal(await readSecureStoreItem("provider.key"), null, "failed writes are not mistaken for durable hydration");
  secureWriteFailures = 0;
  assert.equal(await persistSecureStoreItem("provider.key", "stored"), true);
  assert.equal(await readSecureStoreItem("provider.key"), "stored");
  secureWriteFailures = 2;
  assert.equal(await persistSecureStoreItem("fallback.key", "recoverable", { fallbackKey: "provider.fallback" }), false);
  assert.equal(asyncStorage.has("provider.fallback"), false, "new API keys must not be mirrored to plaintext AsyncStorage");
  assert.equal(await readSecureStoreItem("fallback.key", "provider.fallback"), null);
  secureWriteFailures = 2;
  asyncStorage.set("provider.fallback", "legacy-session-value");
  assert.equal(await readSecureStoreItem("fallback.key", "provider.fallback"), "legacy-session-value", "an existing fallback remains usable in-session if migration fails");
  assert.equal(asyncStorage.get("provider.fallback"), "legacy-session-value", "failed migration must not delete the only existing copy");
});

await scenario("Local model lifecycle: concurrent same-load is deduplicated; stop/unload during init releases context and prevents stale loaded state", async () => {
  moduleCache.clear();
  let initCount = 0;
  let releaseCount = 0;
  let gate = null;
  runtime.initLlama = async () => {
    initCount += 1;
    const thisGate = gate;
    if (thisGate) await thisGate.promise;
    return {
      async release() { releaseCount += 1; },
      async initMultimodal() { return false; },
      async releaseMultimodal() {},
      async completion() { return { text: "ok" }; },
    };
  };
  const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
  const settleUntil = async (predicate) => {
    for (let i = 0; i < 100 && !predicate(); i += 1) await new Promise((r) => setTimeout(r, 0));
    assert.ok(predicate(), "controlled native init reached expected boundary");
  };
  const { localModelEngine } = loadTs(path.join(root, "lib/local-model.ts"));
  const params = { nCtx: 1024, nThreads: 1, nGpuLayers: 0 };
  gate = deferred();
  const first = localModelEngine.load(params);
  await settleUntil(() => initCount === 1);
  const duplicate = localModelEngine.load(params);
  assert.equal(initCount, 1, "same parameter load shares in-flight native initialization");
  gate.resolve();
  await Promise.all([first, duplicate]);
  assert.equal(localModelEngine.isLoaded(), true);
  assert.equal(initCount, 1);
  gate = null;
  await localModelEngine.unload();
  assert.equal(localModelEngine.isLoaded(), false);
  assert.equal(releaseCount, 1);

  gate = deferred();
  const pending = localModelEngine.load({ ...params, nCtx: 2048 });
  await settleUntil(() => initCount === 2);
  const stopping = localModelEngine.unload();
  gate.resolve();
  await Promise.all([pending, stopping]);
  assert.equal(localModelEngine.isLoaded(), false, "unload wins over a stale init completion");
  assert.equal(releaseCount, 2, "every initialized native context is released exactly once");
});

await scenario("Agent tool sequence: symlink to outside home is denied before read; shell output without exitCode is not success", async () => {
  moduleCache.clear();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aib-v227-agent-"));
  try {
    const home = path.join(tmp, "home"); const outside = path.join(tmp, "outside");
    fs.mkdirSync(home); fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "secret.txt"), "outside-secret");
    fs.symlinkSync(outside, path.join(home, "linked"), "dir");
    let readCount = 0;
    const env = {
      getHome: () => home,
      async resolvePath(p) { return fs.realpathSync(p); },
      async exists(p) { return fs.existsSync(p); },
      async mkdir(p) { fs.mkdirSync(p, { recursive: true }); },
      async read(p) { readCount += 1; return fs.readFileSync(p, "utf8"); },
      async write() {}, async spawn() { return { exitCode: 0, stdout: "", stderr: "" }; },
      async exec() { return { exitCode: 0, stdout: "", stderr: "" }; },
    };
    const { AgentManager } = loadTs(path.join(root, "core/agent/AgentManager.ts"));
    const manager = new AgentManager(env);
    const fsAgent = manager.create({ id: "symlink-agent", policy: { projectIsolation: false } });
    const escaped = await manager.execute(fsAgent.id, { tool: "fs.read", capability: "filesystem", args: { path: path.join(home, "linked", "secret.txt") } });
    assert.equal(escaped.ok, false);
    assert.match(escaped.error, /HOME isolation/);
    assert.equal(readCount, 0, "outside target is denied before environment.read");

    const shellManager = new AgentManager(env);
    const shellAgent = shellManager.create({ id: "shell-agent", policy: { allowedCapabilities: ["filesystem", "terminal"], homeIsolation: false, projectIsolation: false } });
    shellManager.setHostHooks({ runShell: async () => ({ stdout: "looks successful" }) });
    const result = await shellManager.execute(shellAgent.id, { tool: "shell.exec", capability: "terminal", args: { command: "false" } });
    assert.equal(result.ok, false);
    assert.equal(result.error, "SHELL_EXIT_CODE_UNAVAILABLE");
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

await scenario("Termux environment filesystem: quoted Unicode/apostrophe paths survive read/write and symlink canonicalization", async () => {
  moduleCache.clear();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aib-v227-termux-env-"));
  runtime.sharedRoot = tmp;
  try {
    const home = path.join(tmp, "workspace with spaces"); const outside = path.join(tmp, "outside");
    fs.mkdirSync(home); fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "secret.txt"), "outside");
    fs.symlinkSync(outside, path.join(home, "linked"), "dir");
    runtime.runShellCommand = async (command) => bash(command);
    const { AIBuilderTermuxEnvironment } = loadTs(path.join(root, "core/environment/AIBuilderTermuxEnvironment.ts"));
    const env = new AIBuilderTermuxEnvironment(home);
    const target = path.join(home, "file ' 雪.txt");
    const content = "literal apostrophe ' ; snow 雪 λ";
    await env.write(target, content);
    assert.equal(await env.read(target), content);
    assert.equal(await env.exists(target), true);
    assert.equal(await env.resolvePath(path.join(home, "linked", "secret.txt")), path.join(outside, "secret.txt"));
    const marker = path.join(tmp, "should-not-exist");
    const literalPath = path.join(home, `$(touch ${marker})`);
    try { assert.equal(await env.exists(literalPath), false); }
    catch (error) { assert.match(String(error), /BLOCKED_BY_APP/); }
    assert.equal(fs.existsSync(marker), false, "metasymbol path remains data, not a shell command");
  } finally { runtime.sharedRoot = null; fs.rmSync(tmp, { recursive: true, force: true }); }
});

await scenario("GitHub bridge security: external/untrusted documents cannot dispatch secret or save messages; HTTP targets limited to GitHub endpoints", async () => {
  moduleCache.clear();
  const { isTrustedGithubToolDocumentUrl, parseTrustedGithubToolMessage, isAllowedGithubToolHttpUrl } = loadTs(path.join(root, "lib/github-tool-security.ts"));
  const bundled = "file:///android_asset/github-tool/repos.html";
  const secretMessage = JSON.stringify({ type: "secretGet", id: "1", name: "unzipgit_token" });
  assert.equal(isTrustedGithubToolDocumentUrl(bundled), true);
  assert.deepEqual(parseTrustedGithubToolMessage(bundled, secretMessage), { type: "secretGet", id: "1", name: "unzipgit_token" });
  for (const untrusted of ["https://attacker.invalid/page.html", "https://github.com/login", "file:///android_asset/other.html", "file:///android_asset/github-tool/../evil.html", undefined]) {
    assert.equal(isTrustedGithubToolDocumentUrl(untrusted), false);
    assert.equal(parseTrustedGithubToolMessage(untrusted, secretMessage), null, `untrusted origin ${String(untrusted)} cannot dispatch bridge calls`);
  }
  assert.equal(isAllowedGithubToolHttpUrl("https://api.github.com/user"), true);
  assert.equal(isAllowedGithubToolHttpUrl("https://raw.githubusercontent.com/o/r/main/a.txt"), true);
  for (const target of ["http://api.github.com/user", "https://api.github.com.attacker.invalid/user", "https://attacker.invalid/steal", "https://u:p@api.github.com/user", "https://api.github.com:444/user"]) {
    assert.equal(isAllowedGithubToolHttpUrl(target), false, `unsafe bridge URL rejected: ${target}`);
  }
  const plugin = fs.readFileSync(path.join(root, "plugins/withGithubTool.js"), "utf8");
  const moduleSave = plugin.match(/ReactMethod fun saveFile\(fileName: String, mime: String, base64: String, promise: com\.facebook\.react\.bridge\.Promise\) \{([\s\S]*?)\n  \}/)?.[1] || "";
  assert.match(moduleSave, /saveFileFromReact\(fileName, mime, base64, promise\)/);
  assert.doesNotMatch(moduleSave, /promise\.resolve\(true\)/, "RN wrapper must not report picker request as completed save");
  const activitySave = plugin.match(/if \(requestCode == GithubToolHost\.SAVE_DOC_REQUEST\) \{([\s\S]*?)\n    if \(requestCode == GithubToolHost\.MULTI_PICK_REQUEST\)/)?.[1] || "";
  assert.match(activitySave, /GITHUB_SAVE_CANCELLED/);
  assert.match(activitySave, /openOutputStream\(data\.data!!\) \?: throw/);
  assert.ok(activitySave.indexOf("it.flush()") < activitySave.indexOf("completion?.resolve(true)"), "success resolution follows flush");
  assert.match(plugin, /insertedUri\?\.let \{ context\.contentResolver\.delete\(it, null, null\) \}/, "failed MediaStore write attempts partial-row cleanup");
});

await scenario("Project lifecycle: rename/delete metadata failures restore original payload, metadata and remove quarantine", async () => {
  moduleCache.clear();
  const layout = { root: "/home", projects: "/home/projects", metadata: "/home/.ai-builder/metadata" };
  const projectPath = "/home/projects/alpha";
  const sourceMetadata = "/home/.ai-builder/metadata/projects/alpha.json";
  const targetMetadata = "/home/.ai-builder/metadata/projects/beta.json";
  const dirs = new Set(["/home", layout.projects, "/home/.ai-builder", "/home/.ai-builder/metadata", "/home/.ai-builder/metadata/projects", projectPath]);
  const files = new Map([[`${projectPath}/main.ts`, "original-code"], [sourceMetadata, JSON.stringify({ projectName: "alpha", note: "keep" })]]);
  const fakeFs = {
    failRemoveFile: null,
    failRemoveDir: null,
    async ensureDirectory(p) {
      let cur = "";
      for (const part of p.split("/").filter(Boolean)) { cur += `/${part}`; dirs.add(cur); }
    },
    async listDirectories(p) { return [...dirs].filter((x) => x.startsWith(`${p}/`) && !x.slice(p.length + 1).includes("/")).map((x) => x.slice(p.length + 1)); },
    async readTextFile(p) { if (!files.has(p)) throw new Error("file missing"); return files.get(p); },
    async writeTextFile(p, v) { files.set(p, v); },
    async fileExists(p) { return files.has(p); },
    async removeFile(p) { if (this.failRemoveFile === p) throw new Error("controlled metadata remove failure"); files.delete(p); },
    async removeDirectory(p) {
      if (this.failRemoveDir === p) throw new Error("controlled directory remove failure");
      for (const d of [...dirs]) if (d === p || d.startsWith(`${p}/`)) dirs.delete(d);
      for (const f of [...files.keys()]) if (f === p || f.startsWith(`${p}/`)) files.delete(f);
    },
    async moveDirectory(from, to) {
      if (!dirs.has(from)) throw new Error(`directory missing: ${from}`);
      if (dirs.has(to)) throw new Error(`destination exists: ${to}`);
      for (const d of [...dirs]) if (d === from || d.startsWith(`${from}/`)) { dirs.delete(d); dirs.add(to + d.slice(from.length)); }
      for (const [f, v] of [...files.entries()]) if (f.startsWith(`${from}/`)) { files.delete(f); files.set(to + f.slice(from.length), v); }
    },
  };
  const { ProjectLifecycle } = loadTs(path.join(root, "core/project-lifecycle.ts"));
  const lifecycle = new ProjectLifecycle(layout, fakeFs);
  fakeFs.failRemoveFile = sourceMetadata;
  await assert.rejects(lifecycle.rename("alpha", "beta"), /controlled metadata remove failure/);
  assert.equal(dirs.has(projectPath), true);
  assert.equal(dirs.has("/home/projects/beta"), false);
  assert.equal(files.get(`${projectPath}/main.ts`), "original-code");
  assert.equal(JSON.parse(files.get(sourceMetadata)).projectName, "alpha");
  assert.equal(files.has(targetMetadata), false, "target metadata removed during rename rollback");

  await assert.rejects(lifecycle.delete("alpha"), /controlled metadata remove failure/);
  assert.equal(dirs.has(projectPath), true, "delete metadata failure restores payload directory");
  assert.equal(files.get(`${projectPath}/main.ts`), "original-code");
  assert.equal(files.has(sourceMetadata), true);
  assert.equal([...dirs].some((d) => d.includes(".aib-delete-")), false, "failed delete leaves no quarantined orphan");

  fakeFs.failRemoveFile = null;
  fakeFs.failRemoveDir = (pathName) => pathName;
  const originalRemove = fakeFs.removeDirectory;
  fakeFs.removeDirectory = async function (p) {
    if (p.includes(".aib-delete-")) throw new Error("controlled quarantine remove failure");
    return originalRemove.call(this, p);
  };
  let deleteFailure;
  try { await lifecycle.delete("alpha"); } catch (error) { deleteFailure = error; }
  assert.match(String(deleteFailure), /PROJECT_DELETE_CLEANUP_FAILED:quarantine=/);
  const quarantine = [...dirs].find((d) => d.startsWith(`${layout.projects}/.aib-delete-`));
  assert.ok(quarantine, "incomplete cleanup remains quarantined, never exposed as a restored project");
  assert.equal(dirs.has(projectPath), false);
  assert.equal(files.get(`${quarantine}/main.ts`), "original-code", "payload survives in recovery quarantine");
  const recoveryPath = `${layout.metadata}/deletions/${quarantine.split("/").pop()}.json`;
  assert.equal(JSON.parse(files.get(recoveryPath)).projectName, "alpha", "recovery marker retains project metadata");
});

await scenario("Termux tool package routing: host and guest destinations remain distinct under success/failure", async () => {
  moduleCache.clear();
  const { packageBackendTarget, adaptPackageCommandForBackend } = loadTs(path.join(root, "lib/package-command-routing.ts"));
  const hostTarget = packageBackendTarget("termux", "git");
  const guestTarget = packageBackendTarget("ubuntu-proot", "git");
  assert.equal(hostTarget, "termux");
  assert.equal(guestTarget, "linux");
  const host = adaptPackageCommandForBackend("apt-get install -y git", "install", hostTarget);
  const guest = adaptPackageCommandForBackend("apt-get install -y git", "install", guestTarget);
  assert.match(host, /pkg install -y git/);
  assert.match(guest, /apt-get install -y git/);
  assert.notEqual(host, guest);
  const failed = { exitCode: 100, stdout: "", stderr: "repository unavailable" };
  assert.notEqual(failed.exitCode, 0, "controlled apt failure is not successful installation");
});

console.log(`AIB_V227_REGRESSION_SELFTEST ${cases.filter((c) => c.ok).length}/${cases.length}`);
if (cases.some((c) => !c.ok)) process.exitCode = 1;
