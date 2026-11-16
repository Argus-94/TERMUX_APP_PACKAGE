#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, existsSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { typescript } from "./test-helpers/load-typescript.mjs";

const { PRIVATE_BUILD_PATHS_INIT_SH } = await import("../lib/private-path-policy.ts");
const { buildProjectPathPinReadbackCommand } = await import("../lib/termux-project-path.ts");
const { setAgentUnrestrictedShell } = await import("../lib/agent-unrestricted.ts");
setAgentUnrestrictedShell(false); // strict-guard test; unrestricted default covered by aib-v389-guard-selftest
const { guardTermuxCommand } = await import("../lib/termux-guard.ts");
const { getBuiltinBuildScript } = await import("../lib/builtin-build-script.ts");
const root = mkdtempSync(join(tmpdir(), "aib-private-path-audit-"));
try {
  const shared = join(root, "shared");
  const home = join(root, "termux-home");
  const privateRoot = join(home, ".aibuilder");
  const legacy = join(shared, ".aibuilder");
  mkdirSync(join(legacy, "work"), { recursive: true });
  mkdirSync(join(legacy, "keys"), { recursive: true });
  mkdirSync(join(legacy, "cache"), { recursive: true });
  const marker = " /storage/emulated/0/AIBuilderTermux/projects/old-project ";
  writeFileSync(join(legacy, "work", "proj_path"), marker);
  writeFileSync(join(legacy, "work", "build_path"), marker);
  writeFileSync(join(legacy, "keys", "aib-debug.keystore"), "fixture-debug-keystore-bytes");
  writeFileSync(join(legacy, "cache", "gradle-wrapper.jar"), "fixture-wrapper-bytes");
  const legacySnapshot = readdirSync(legacy, { recursive: true }).sort();

  const shellSyntax = spawnSync("bash", ["-n"], { input: `${PRIVATE_BUILD_PATHS_INIT_SH}\n`, encoding: "utf8" });
  assert.equal(shellSyntax.status, 0, `private initializer shell syntax: ${shellSyntax.stderr}`);
  const initialized = spawnSync("bash", ["-c", PRIVATE_BUILD_PATHS_INIT_SH], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, AIB_PRIVATE_ROOT: privateRoot, AIB_SHARED_ROOT: shared },
  });
  assert.equal(initialized.status, 0, `private initialization failed: ${initialized.stderr || initialized.stdout}`);

  assert.equal(readFileSync(join(privateRoot, "work", "proj_path"), "utf8"), marker, "legacy marker is copied byte-for-byte");
  assert.equal(readFileSync(join(privateRoot, "keys", "aib-debug.keystore"), "utf8"), "fixture-debug-keystore-bytes");
  assert.equal(readFileSync(join(privateRoot, "cache", "gradle-wrapper.jar"), "utf8"), "fixture-wrapper-bytes");
  assert.equal(statSync(privateRoot).mode & 0o777, 0o700, "private metadata root mode is 0700");
  assert.equal(statSync(join(privateRoot, "keys", "aib-debug.keystore")).mode & 0o777, 0o600, "debug key mode is 0600");
  assert.deepEqual(readdirSync(legacy, { recursive: true }).sort(), legacySnapshot, "legacy metadata is preserved, not deleted by automatic migration");

  const pinCommand = buildProjectPathPinReadbackCommand();
  assert.match(pinCommand, /\$AIB_PRIVATE_ROOT/);
  assert.doesNotMatch(pinCommand, /AIBuilderTermux\/\.aibuilder\/work/);
  assert.match(pinCommand, /AIBuilderTermux\/projects/);

  const validPrivateCommand = 'AIB_PRIVATE_ROOT="${AIB_PRIVATE_ROOT:-$HOME/.aibuilder}"; mkdir -p "$AIB_PRIVATE_ROOT/keys"';
  assert.equal(guardTermuxCommand(validPrivateCommand).ok, true, "canonical private root is accepted by command guard");
  const escapingPrivateCommand = 'AIB_PRIVATE_ROOT="/storage/emulated/0"; mkdir -p "$AIB_PRIVATE_ROOT/keys"';
  assert.equal(guardTermuxCommand(escapingPrivateCommand).ok, false, "private-root override into shared storage is rejected");

  const signing = readFileSync(new URL("../lib/signing-tool.ts", import.meta.url), "utf8");
  const signingUi = readFileSync(new URL("../app/signing-keys.tsx", import.meta.url), "utf8");
  const buildLoop = readFileSync(new URL("../lib/build-loop.ts", import.meta.url), "utf8");
  const templates = readFileSync(new URL("../lib/script-templates.ts", import.meta.url), "utf8");
  const builtin = getBuiltinBuildScript();
  assert.match(signing, /SIGNING_ROOT\s*=\s*"~\/.aibuilder\/keys"/);
  assert.match(signing, /LEGACY_SIGNING_ROOT/);
  assert.match(signing, /mkdir -p "\$SIGNING_ROOT" "\$AIB_PRIVATE_ROOT\/tmp"/);
  assert.match(signing, /KEYSTORE_COPY_SUMMARY copied=\$copied already_private=\$already conflicts=\$conflicts failed=\$failed source_preserved=1/);
  const copyOnlyKeyCommand = signing.match(/export function buildLegacySigningKeystoreCopyCommand\(\): string \{[\s\S]*?\n\}/)?.[0] || "";
  assert.match(copyOnlyKeyCommand, /cmp -s -- "\$source" "\$dest"/);
  assert.match(copyOnlyKeyCommand, /KEYSTORE_COPIED:/);
  assert.doesNotMatch(copyOnlyKeyCommand, /rm -f -- "\$source"/, "copying legacy keys must never delete their shared originals");
  assert.match(signing, /\[ ! -L "\$source" \]/);
  assert.match(signing, /TMP="\$AIB_PRIVATE_ROOT\/tmp\/apksign-\$\$\.aligned\.apk"/);
  assert.doesNotMatch(signing.match(/export async function importSigningKeystore[\s\S]*?\n}\n/)?.[0] || "", /rm -f -- "\$SOURCE"/);
  assert.match(signingUi, /copyLegacySigningKeystores\(\)/);
  assert.match(signingUi, /Исходные файлы в общей папке никогда не удаляются и не изменяются/);

  const copyStart = signing.indexOf("export function buildLegacySigningKeystoreCopyCommand(): string {");
  const copyEnd = signing.indexOf("export async function copyLegacySigningKeystores()", copyStart);
  assert.ok(copyStart >= 0 && copyEnd > copyStart, "production copy-only migration command is available for fixture testing");
  const copyFunction = signing.slice(copyStart, copyEnd).replace("export function", "function");
  const copyJs = typescript.transpileModule(
    `${copyFunction}\nmodule.exports = { buildLegacySigningKeystoreCopyCommand };`,
    { compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2022 } },
  ).outputText;
  const copyModule = { exports: {} };
  new Function("module", "exports", copyJs)(copyModule, copyModule.exports);
  const command = copyModule.exports.buildLegacySigningKeystoreCopyCommand();
  const copyFixture = join(root, "copy-fixture");
  const sharedKeys = join(copyFixture, "shared", ".aibuilder", "keys");
  const fixtureHome = join(copyFixture, "termux-home");
  const privateKeys = join(fixtureHome, ".aibuilder", "keys");
  mkdirSync(sharedKeys, { recursive: true });
  mkdirSync(privateKeys, { recursive: true });
  const sourceKey = join(sharedKeys, "legacy-fixture.jks");
  const privateCollision = join(privateKeys, "conflict.keystore");
  writeFileSync(sourceKey, "synthetic-fixture-bytes-only");
  writeFileSync(join(sharedKeys, "conflict.keystore"), "legacy-content");
  writeFileSync(privateCollision, "private-content");
  const runCopy = () => spawnSync("bash", ["-c", command], {
    encoding: "utf8",
    env: { ...process.env, HOME: fixtureHome, AIB_PRIVATE_ROOT: join(fixtureHome, ".aibuilder"), AIB_SHARED_ROOT: join(copyFixture, "shared") },
  });
  const firstCopy = runCopy();
  assert.equal(firstCopy.status, 1, "different-content collision fails closed without removing either key");
  assert.match(firstCopy.stdout, /KEYSTORE_COPIED:legacy-fixture\.jks/);
  assert.match(firstCopy.stdout, /KEYSTORE_COPY_CONFLICT:conflict\.keystore/);
  assert.equal(readFileSync(sourceKey, "utf8"), "synthetic-fixture-bytes-only", "source key remains unchanged after copy");
  assert.equal(readFileSync(join(privateKeys, "legacy-fixture.jks"), "utf8"), "synthetic-fixture-bytes-only");
  assert.equal(statSync(join(privateKeys, "legacy-fixture.jks")).mode & 0o777, 0o600);
  assert.equal(readFileSync(privateCollision, "utf8"), "private-content", "different private key is never overwritten");
  const secondCopy = runCopy();
  assert.equal(secondCopy.status, 1);
  assert.match(secondCopy.stdout, /KEYSTORE_COPY_ALREADY_PRESENT:legacy-fixture\.jks/);
  assert.equal(readFileSync(sourceKey, "utf8"), "synthetic-fixture-bytes-only", "repeat copy still leaves the source in place");
  assert.match(signingUi, /\$\{SIGNED_APK_ROOT\}\//);
  assert.match(templates, /KEYS="\$AIB_PRIVATE_ROOT\/keys"/);
  assert.match(templates, /SIGNED="\$WORK\/artifacts/);
  assert.match(templates, /ZIPALIGN_FAIL/);
  assert.match(builtin, /AIB_PRIVATE_ROOT="\$\{AIB_PRIVATE_ROOT:-\$HOME\/\.aibuilder\}"/);
  assert.match(builtin, /AIB_WORK="\$AIB_PRIVATE_ROOT\/work"/);
  assert.match(builtin, /ZIPALIGN_FAIL: raw APK fallback disabled/);
  assert.match(builtin, /APKSIGNER_VERIFY_FAIL/);
  assert.doesNotMatch(builtin, /UNSIGNED_APK_OK|zipalign fail — use raw/);
  assert.match(buildLoop, /runAndroidToolchainSign/);
  assert.match(signing, /SIGNED_APK_ROOT/);
  assert.doesNotMatch(signing, /SIGN_SOURCE=\$\{raw\}/);

  console.log("AIB_PRIVATE_PATH_MIGRATION_SELFTEST_OK");
} finally {
  rmSync(root, { recursive: true, force: true });
}
