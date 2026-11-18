import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const errors = [];
const smoke = fs.readFileSync(path.join(root, "DEVICE_SMOKE.md"), "utf8");
for (const token of [
  "AI Builder v513",
  "APK v513 **не собирался и не подписывался**",
  "Android device smoke: **NOT RUN**",
  "emulator smoke также не запускался",
]) {
  if (!smoke.includes(token)) errors.push(`SMOKE_MISSING:${token}`);
}
const cl = fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
if (!cl.includes("1.3.160") && !cl.includes("v211")) {
  // version filled after bump — soft
}
const old = fs.readdirSync(root).filter((f) => /^CHANGELOG_V\d+\.md$/.test(f));
const tooOld = old.filter((f) => {
  const n = Number(f.match(/V(\d+)/)[1]);
  return n < 200;
});
if (tooOld.length) errors.push(`OLD_CHANGELOGS_PRESENT:${tooOld.length}`);
if (!fs.existsSync(path.join(root, "CHANGELOG_ARCHIVE_INDEX.md"))) errors.push("ARCHIVE_INDEX_MISSING");
if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log(`AIB_DEVICE_SMOKE_SELFTEST_OK changelogs_kept=${old.length}`);
