#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const docPath = path.join(root, "docs", "TERMUX_MIRRORS.md");
const errors = [];
if (!fs.existsSync(docPath)) errors.push("missing docs/TERMUX_MIRRORS.md");
const doc = fs.existsSync(docPath) ? fs.readFileSync(docPath, "utf8") : "";
for (const n of ["termux-change-repo", "chosen_mirrors", "packages.termux.dev", "A08", "APT_CONFIG", "signature verification"]) {
  if (!doc.includes(n)) errors.push("TERMUX_MIRRORS missing: " + n);
}
const installer = fs.readFileSync(path.join(root, "lib/termux-installer-env.ts"), "utf8");
const aptInstall = fs.readFileSync(path.join(root, "lib/termux-apt-install.ts"), "utf8");
const bootstrap = fs.readFileSync(path.join(root, "lib/termux-bootstrap-install.ts"), "utf8");
const fallbackTest = fs.readFileSync(path.join(root, "scripts/aib-termux-mirror-fallback-selftest.mjs"), "utf8");
const official = "https://packages.termux.dev/apt/termux-main";
if ((aptInstall.match(/https:\/\/packages\.termux\.dev\/apt\/termux-main/g) || []).length !== 1) {
  errors.push("installer must have exactly one pinned official Termux main fallback endpoint");
}
if (/mirror\.termina\.online|mirrors\.ustc\.edu\.cn|mirror\.mwt\.me|ghproxy/i.test(installer + aptInstall + bootstrap)) {
  errors.push("installer contains an untrusted/third-party mirror or proxy");
}
if (!installer.includes('from "./termux-apt-install"')) errors.push("installer does not use the Termux apt policy module");
if (!aptInstall.includes("termux-change-repo") && !doc.includes("termux-change-repo")) {
  errors.push("manual Termux mirror guidance is missing");
}
if (!aptInstall.includes("chosen_mirrors") || !aptInstall.includes("sources.list")) {
  errors.push("installer does not check existing Termux source configuration");
}
if (!aptInstall.includes("sources.list.d/*.list") || !aptInstall.includes("sources.list.d/*.sources")) {
  errors.push("installer does not account for additional APT source files");
}
if (/rm\s+-f[^;\n]*sources\.list(?:\.d)?/.test(aptInstall) || />\s*"\$PREFIX\/etc\/apt\/sources\.list"/.test(aptInstall)) {
  errors.push("installer rewrites or removes user APT source files");
}
for (const marker of ["aib_fallback_source_is_eligible", "aib_transient_mirror_unavailable", "Dir::Etc::sourcelist", "Dir::Etc::sourceparts", "Dir::State::lists", "aib_cleanup_apt_transaction", "AIB_APT_FALLBACK_UPDATE_EXIT"]) {
  if (!aptInstall.includes(marker)) errors.push(`bounded fallback contract missing ${marker}`);
}
if (!aptInstall.includes(official)) errors.push("official endpoint does not match the trust policy");
if (/AllowUnauthenticated\s*(?:=|"?true)|AllowInsecureRepositories\s*(?:=|"?true)/i.test(aptInstall)) {
  errors.push("fallback weakens apt signature verification");
}
if (!bootstrap.includes("wrapTermuxAptInstallWithUpdate")) errors.push("bootstrap installs bypass the mirror-aware apt wrapper");
for (const marker of ["configured_first=1", "official_retry_once=1", "sources_unchanged=1", "cleanup=1", "fake_apt_pkg_only=1"]) {
  if (!fallbackTest.includes(marker)) errors.push(`fake fixture coverage missing ${marker}`);
}
if (!doc.includes("never invokes `termux-change-repo`")) {
  errors.push("documentation must state that persistent mirror selection remains user-controlled");
}
if (errors.length) { console.error(errors.join("\n")); process.exit(1); }
console.log("AIB_TERMUX_MIRRORS_DOC_SELFTEST_OK official_main=one_shot signature_verification=preserved sources_unchanged=1");
