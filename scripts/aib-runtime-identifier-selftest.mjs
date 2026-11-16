import fs from "node:fs";

const context = fs.readFileSync("components/TermuxConsoleContext.tsx", "utf8");
const settings = fs.readFileSync("app/termux-settings.tsx", "utf8");

if (!/const toggle\s*=\s*useCallback\(\(\)\s*=>\s*\{\s*setVisible\(\(current\)\s*=>\s*!current\);/s.test(context)) {
  throw new Error("TermuxConsoleContext toggle handler is missing; app startup would throw ReferenceError: toggle");
}
if (!/const value\s*=\s*useMemo\([\s\S]*?\btoggle\b[\s\S]*?\),/m.test(context)) {
  throw new Error("TermuxConsoleContext context value does not expose toggle");
}
if (!/import \{[\s\S]*?cancelAddonDownload[\s\S]*?\} from \"\.\.\/lib\/termux-addon-installer\";/m.test(settings)) {
  throw new Error("termux-settings.tsx uses cancelAddonDownload without importing it");
}
console.log("AIB_RUNTIME_IDENTIFIER_SELFTEST_OK toggle=declared cancelAddonDownload=imported");
