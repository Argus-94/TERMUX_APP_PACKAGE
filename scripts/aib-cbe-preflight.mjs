/**
 * Static checks before Cloud Build Engine / expo prebuild.
 * Exit 1 if config would break prebuild (invalid plugins, missing shim, version drift).
 */
import fs from "node:fs";
import path from "node:path";

import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const errors = [];

const pkg = JSON.parse(read("package.json"));
const app = read("app.config.ts");
const readme = read("README.md");

if (!pkg.version) errors.push("PACKAGE_VERSION_MISSING");
const appVer = app.match(/version:\s*["']([^"']+)["']/)?.[1];
const usesCanonicalVersion = /version:\s*APP_VERSION\b/.test(app);
if (appVer && appVer !== pkg.version) errors.push(`VERSION_DRIFT package=${pkg.version} app.config=${appVer}`);
if (!appVer && !usesCanonicalVersion) errors.push(`VERSION_SOURCE_MISSING package=${pkg.version}`);
if (!readme.includes(pkg.version)) errors.push(`README_VERSION_MISSING expected ${pkg.version}`);

// Forbidden: packages that are NOT Expo config plugins but were wrongly listed
const FORBIDDEN_PLUGINS = ["expo-clipboard", "expo-file-system", "expo-secure-store", "axios"];
for (const name of FORBIDDEN_PLUGINS) {
  // only flag if appears as a top-level plugins string entry: "name" or 'name' near plugins block
  const re = new RegExp(`plugins:\\s*\\([\\s\\S]*?["']${name.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}["']`);
  if (re.test(app)) errors.push(`FORBIDDEN_CONFIG_PLUGIN:${name}`);
}

// Required plugins / local plugins
for (const need of ["expo-router", "expo-speech-recognition", "expo-notifications", "llama.rn", "withTermuxBridge", "withFixGradleProperties"]) {
  if (!app.includes(need)) errors.push(`REQUIRED_PLUGIN_MISSING:${need}`);
}

if (!fs.existsSync(path.join(root, "gradlew"))) errors.push("CBE_GRADLEW_SHIM_MISSING");
if (!fs.existsSync(path.join(root, "gradle.properties"))) errors.push("CBE_GRADLE_PROPERTIES_STUB_MISSING");
if (!fs.existsSync(path.join(root, "pnpm-lock.yaml"))) errors.push("PNPM_LOCKFILE_MISSING");
if (fs.existsSync(path.join(root, "package-lock.json"))) errors.push("NPM_LOCKFILE_FORBIDDEN");
if (pkg.packageManager !== "pnpm@9.15.0") errors.push(`PACKAGE_MANAGER_MISMATCH expected=pnpm@9.15.0 actual=${pkg.packageManager || "missing"}`);

const gradlew = read("gradlew");
if (!gradlew.includes("expo prebuild")) errors.push("GRADLEW_SHIM_NO_PREBUILD");

// withFixGradleProperties must be last in the plugins:([ ... ]) array (not import order)
const pluginsBlock = app.match(/plugins:\s*\(\[([\s\S]*?)\]\s*as any\)/)?.[1] || "";
const activePluginsBlock = pluginsBlock
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/\/\/.*$/gm, "");
const iTermux = activePluginsBlock.lastIndexOf("withTermuxBridge");
const iFix = activePluginsBlock.lastIndexOf("withFixGradleProperties");
const lastPlugin = activePluginsBlock.split(",").map((entry) => entry.trim()).filter(Boolean).at(-1) || "";
if (iTermux < 0 || iFix < 0 || iFix < iTermux || !/^withFixGradleProperties\s*$/.test(lastPlugin)) {
  errors.push("withFixGradleProperties_MUST_BE_LAST_AFTER_withTermuxBridge_IN_PLUGINS_ARRAY");
}

if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log(`AIB_CBE_PREFLIGHT_OK version=${pkg.version} packageManager=pnpm@9.15.0 lockfile=pnpm shim=gradlew`);
