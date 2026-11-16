import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const errors = [];
const packs = read("lib/termux-packs.ts");
const settings = read("app/settings.tsx");
const hooks = read("hooks/useAppSettings.ts");
const i18n = read("lib/i18n.ts");

for (const tok of [
  "checkTermuxFreeSpace",
  "PACK_MIN_FREE_BYTES",
  "getPackEstimate",
  "rememberSuccessfulDownloadUrl",
  "getRememberedDownloadUrl",
  "shouldAbort",
  "runChunkedDownload",
]) {
  if (!packs.includes(tok) && !hooks.includes(tok)) errors.push(`PACKS_MISSING:${tok}`);
}
if (!hooks.includes("shouldAbort: () => !!packAbortRef")) errors.push("ABORT_NOT_WIRED");
if (!hooks.includes("pkill")) errors.push("CANCEL_PKILL_MISSING");
if (!hooks.includes("checkTermuxFreeSpace")) errors.push("HOOKS_DF_MISSING");
if (!settings.includes("packTermuxNotReadyBanner") && !i18n.includes("packTermuxNotReadyBanner"))
  errors.push("BANNER_I18N_MISSING");
if (!settings.includes("getPackEstimate") && !hooks.includes("getPackEstimate")) errors.push("SETTINGS_ESTIMATE_MISSING");
if (!settings.includes("packContinue") && !i18n.includes("packContinue")) errors.push("CONTINUE_LABEL_MISSING");
if (!i18n.includes("packLowSpace")) errors.push("LOW_SPACE_I18N_MISSING");
if (!settings.includes("packsApkSeparateHint") && !i18n.includes("packsApkSeparateHint")) errors.push("APK_HINT_MISSING");
if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log("AIB_PACKS_SELFTEST_OK");
