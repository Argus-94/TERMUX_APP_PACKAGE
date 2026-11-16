import fs from "node:fs";

const source = fs.readFileSync(new URL("../app/settings.tsx", import.meta.url), "utf8");

for (const token of [
  'useFocusEffect',
  'refreshPackReadinessState',
  'checkTermuxReadiness({ deep: true, refreshPermission: true })',
  'setPacksBridgeOk(isNativeModuleAvailable())',
  'setPacksReady(r.ready)',
]) {
  if (!source.includes(token)) throw new Error(`missing settings readiness token: ${token}`);
}

if (!/useFocusEffect\(\s*useCallback\(\(\)\s*=>\s*\{\s*void refreshPackReadinessState\(\);\s*\},\s*\[refreshPackReadinessState\]\)\s*\);/.test(source)) {
  throw new Error('Settings screen must recheck Termux readiness with a synchronous focus callback');
}

console.log('AIB_V297_SETTINGS_READINESS_SELFTEST_OK');
