#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { guardTermuxCommand } from "../lib/termux-guard.ts";
import { setAgentUnrestrictedShell } from "../lib/agent-unrestricted.ts";
setAgentUnrestrictedShell(false); // strict-guard test; the unrestricted default is covered by aib-v389-guard-selftest
import { buildAndroidToolchainCommand } from "../lib/android-toolchain-script.ts";
const __AIB_VER = (await import("node:fs")).readFileSync(new URL("../core/runtime/RuntimeIdentity.ts", import.meta.url), "utf8").match(/appVersion: "([^"]+)"/)[1]; // v407: single source of truth (RuntimeIdentity == package.json)

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const licenseWrite = `printf accepted > "$SDK/licenses/android-sdk-license"`;
const ordinary = guardTermuxCommand(licenseWrite);
assert.equal(ordinary.ok, false, "model/general commands must not write outside the trusted roots");
assert.match(ordinary.reason, /outside trusted roots/);

const exactAuthorized = guardTermuxCommand(licenseWrite, { allowSdkLicenseWrites: true });
assert.equal(exactAuthorized.ok, true, "only the accepted SDK license file is authorized for internal bootstrap");
for (const target of [
  `printf x > "$SDK/licenses/other-file"`,
  `printf x > "$SDK/licenses/android-sdk-license/../outside"`,
  `printf x > "$SDK/platforms/android-99/android.jar"`,
]) {
  const result = guardTermuxCommand(target, { allowSdkLicenseWrites: true });
  assert.equal(result.ok, false, `must reject non-license SDK target: ${target}`);
}

const signingCommand = `keytool -genkeypair -keystore "$AIB_KEYS/aib-debug.keystore" -storepass android -keypass android -alias androiddebugkey`;
const signingBlocked = guardTermuxCommand(signingCommand);
assert.equal(signingBlocked.ok, false);
assert.match(signingBlocked.reason, /sensitive file access/);
assert.equal(guardTermuxCommand(signingCommand, { allowInternalDebugKeystore: true }).ok, true,
  "the app-owned debug keystore is available only through the explicit internal signing capability");
assert.equal(guardTermuxCommand(`keytool -genkeypair -keystore "$HOME/private-upload.keystore"`, {
  allowInternalDebugKeystore: true,
}).ok, false, "the exception must not permit other signing stores");

const productionBootstrap = buildAndroidToolchainCommand();
const bootstrapGuard = guardTermuxCommand(productionBootstrap, { allowSdkLicenseWrites: true });
assert(bootstrapGuard.ok || bootstrapGuard.confirmable === true,
  `trusted bootstrap must not hit a hard SDK-license path denial: ${bootstrapGuard.reason ?? ""}`);
assert(!bootstrapGuard.reason?.includes("$SDK/licenses/android-sdk-license"));
assert.match(productionBootstrap, /SDK_CANON=.*realpath -m/);
assert.match(productionBootstrap, /SDK_CANON=\$\(realpath -m -- \"\$SDK\"/);
assert.match(productionBootstrap, /find \"\$SDK_CANON\/platforms\"/);
assert.doesNotMatch(productionBootstrap, /sdkmanager|pkg install|apt-get install|android-sdk-license/);
assert.match(productionBootstrap, /java-21-openjdk[\s\S]*java-17-openjdk/);
assert.match(productionBootstrap, /Java 17 or newer is required/);

function probeWithJdks(jdks) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "aib-java-preflight-"));
  try {
    const prefix = path.join(temp, "prefix");
    const bin = path.join(temp, "bin");
    const sdk = path.join(prefix, "opt", "android-sdk");
    fs.mkdirSync(bin, { recursive: true });
    fs.mkdirSync(path.join(sdk, "platforms", "android-35"), { recursive: true });
    fs.mkdirSync(path.join(sdk, "build-tools", "35.0.0"), { recursive: true });
    fs.writeFileSync(path.join(sdk, "platforms", "android-35", "android.jar"), "fixture");
    for (const tool of ["find", "head", "realpath", "sed", "sort", "tail"]) {
      fs.symlinkSync(`/usr/bin/${tool}`, path.join(bin, tool));
    }
    for (const [relative, major] of jdks) {
      const java = path.join(prefix, relative, "bin", "java");
      fs.mkdirSync(path.dirname(java), { recursive: true });
      fs.writeFileSync(java, `#!/bin/sh\nprintf '%s\\n' 'openjdk version "${major}.0.2" 2024-01-16'\n`, { mode: 0o755 });
    }
    const aapt2 = path.join(sdk, "build-tools", "35.0.0", "aapt2");
    fs.writeFileSync(aapt2, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    // Keep the fixture deterministic even when the sandbox itself has a JDK
    // under /usr/lib/jvm; only the temporary PREFIX candidates should count.
    const hermeticBootstrap = productionBootstrap.replace(/^  \/usr\/lib\/jvm\/[^\n]* \\\n/gm, "");
    const result = spawnSync("/bin/bash", ["-c", hermeticBootstrap], {
      encoding: "utf8",
      env: { ...process.env, PREFIX: prefix, PATH: bin, ANDROID_HOME: "", ANDROID_SDK_ROOT: "" },
    });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    return `${result.stdout || ""}\n${result.stderr || ""}`;
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

const java21 = probeWithJdks([
  ["lib/jvm/java-17-openjdk", 17],
  ["lib/jvm/java-21-openjdk", 21],
]);
assert.match(java21, /java=OK:.*java-21-openjdk\/bin\/java:openjdk version "21/);
assert.match(java21, /sdk_platforms=OK:.*android\.jar/);
assert.match(java21, /aapt2=OK:.*aapt2/);
const java17 = probeWithJdks([["lib/jvm/java-17-openjdk", 17]]);
assert.match(java17, /java=OK:.*java-17-openjdk\/bin\/java:openjdk version "17/);
const java11 = probeWithJdks([["lib/jvm/java-17-openjdk", 11]]);
assert.match(java11, /java=TOO_OLD:/);
assert.match(java11, /Java 17 or newer is required/);

const executor = fs.readFileSync(path.join(root, "lib/termux-executor.ts"), "utf8");
assert.match(executor, /options\.trustedInternal === true && options\.allowSdkLicenseWrites === true/);
assert.match(executor, /options\.trustedInternal === true && options\.allowInternalDebugKeystore === true/);

const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const appConfig = fs.readFileSync(path.join(root, "app.config.ts"), "utf8");
assert.equal(pkg.name, "ai-builder");
assert.equal(pkg.version, __AIB_VER);
assert.match(appConfig, /slug:\s*"ai-builder"/);
assert.match(appConfig, /package:\s*"com\.karat\.aibuilder"/);

console.log(`AIB_SDK_LICENSE_GUARD_SELFTEST_OK identity=ai-builder/com.karat.aibuilder/${__AIB_VER} read_only_probe=1`);
