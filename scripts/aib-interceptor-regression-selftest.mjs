import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
const __AIB_VER = (await import("node:fs")).readFileSync(new URL("../core/runtime/RuntimeIdentity.ts", import.meta.url), "utf8").match(/appVersion: "([^"]+)"/)[1]; // v407: single source of truth (RuntimeIdentity == package.json)
const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
const expected = {
  "pnpm-lock.yaml": "fe6513fae51ceaaf0126792bdfe9901711d60d0f4439389b7eaef500b3d78efc",
  // Adds only the Expo config plugin for the user-controlled traffic interceptor.
  "app.config.ts": "21877ea4fc30325711ecce2a95c30978e1d9c277ceb985d50d4d30b7317dce89",
  "babel.config.js": "ad89cf8ef20ab83fd9136fe78e9b40d5996dbf6463d33084f5a5b3bcf176e43f",
  "metro.config.js": "5c543e824439ed42dd757a4ce7deabd9f59392a870ecd93d0dc7abc859e28bac",
  "tsconfig.json": "6f61880e6963bd3c5b5ff4a0e7393797f513dccbc707b5cb268400a0a6a1fc91",
  "eas.json": "b89c0cc62bc73ed611f34733a209f2705f78293927b05c4e12fff802e09eeee5",
  "gradle.properties": "fd048ca701127912fae07cc1116c79301032c8c25fc6c520f3709de5470b6074",
  "gradlew": "1bc8581ffd9565ce928ce5bc9a15cab6044a0b4d81857ca70390449afe4556c5",
};
for (const [name, hash] of Object.entries(expected)) assert.equal(createHash("sha256").update(readFileSync(resolve(root, name))).digest("hex"), hash, `${name} is protected and must remain unchanged`);
const packageManifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
assert.equal(packageManifest.name, "ai-builder");
assert.equal(packageManifest.version, __AIB_VER, "tests/scripts may be registered without changing the published app version");
assert.equal(packageManifest.expo?.android?.package, undefined, "Android package identity remains owned by Expo configuration");
const screen = readFileSync(resolve(root, "components/interceptor/InterceptorScreen.tsx"), "utf8");
const layout = readFileSync(resolve(root, "app/_layout.tsx"), "utf8");
const drawer = readFileSync(resolve(root, "components/DrawerContent.tsx"), "utf8");
const facade = readFileSync(resolve(root, "core/RuntimeFacade.ts"), "utf8");
assert.match(screen, /startByUser\(true\)/);
assert.match(screen, /unsupportedBody/);
assert.match(layout, /navigate\("interceptor"/);
assert.match(layout, /name="interceptor" options=\{\{ title: t\("trafficInterceptor"\), drawerLabel:/);
assert.doesNotMatch(layout, /name="interceptor"[^\n]*drawerItemStyle: \{ display: "none" \}/);
assert.match(drawer, /interceptorEngine\.subscribe/);
assert.match(drawer, /"active" in item/);
assert.match(facade, /interceptorActive:/);
assert.match(facade, /this\.portForwards\.list\(\)/);
const moduleNames = new Set(readdirSync(resolve(root, "core/enhancements/interceptor")));
for (const name of ["InterceptorEngine.ts", "InterceptorPolicy.ts", "InterceptorCertificate.ts", "InterceptorRules.ts", "InterceptorCapture.ts", "InterceptorReplay.ts", "InterceptorExport.ts", "InterceptorAgentBridge.ts", "InterceptorSessionStorage.ts"]) assert.ok(moduleNames.has(name), `${name} missing`);
console.log("aib-interceptor-regression-selftest: PASS");
