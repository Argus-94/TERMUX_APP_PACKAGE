import fs from "node:fs";
const i18n=fs.readFileSync("lib/i18n.ts","utf8");
const manager=fs.readFileSync("core/toolchain/ToolchainManager.ts","utf8");
if (!/verified APK (?:build )?tool-pack/i.test(i18n)) throw new Error("AIB_V263_VERIFIED_TOOLPACK_GUIDANCE_MISSING");
if (!manager.includes("Never mutates project Gradle/Expo/Android compilation settings")) throw new Error("AIB_V263_TOOLCHAIN_RUNTIME_ONLY_CONTRACT_MISSING");
console.log("AIB_V263_REGRESSION_SELFTEST_OK install_guidance=verified_toolpack");
