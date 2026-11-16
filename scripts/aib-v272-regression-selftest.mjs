import fs from "node:fs";
const src=fs.readFileSync("core/toolchain/ToolchainManager.ts","utf8");
if (!src.includes("registerSource") || !src.includes("register(manifest")) throw new Error("TOOLCHAIN_REGISTRY_API_MISSING");
if (!src.includes("Object.values" ) && !src.includes("[...this.registry.values()]")) throw new Error("TOOLCHAIN_REGISTRY_LOOKUP_MISSING");
if (!src.includes("android-sdk") || !src.includes("java") || !src.includes("node")) throw new Error("TOOLCHAIN_EXPECTED_KINDS_MISSING");
if (!src.includes("Never mutates project Gradle/Expo/Android compilation settings")) throw new Error("TOOLCHAIN_MUTATION_BOUNDARY_MISSING");
console.log("AIB_V272_REGRESSION_SELFTEST_OK toolchain_output=registry_only");
