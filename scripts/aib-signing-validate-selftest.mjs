#!/usr/bin/env node
/** Mirrors assertPassword from lib/signing-tool.ts */
function assertPassword(value, label = "PASSWORD") {
  const v = String(value ?? "").trim();
  if (v.length < 6) throw new Error(`${label}_TOO_SHORT`);
  if (/[\n\r]/.test(v)) throw new Error(`${label}_INVALID`);
  return v;
}
function assertPath(value, label) {
  const p = String(value ?? "").trim();
  if (!p) throw new Error(`${label}_REQUIRED`);
  if (/[\n\r]/.test(p)) throw new Error(`${label}_INVALID`);
  return p;
}
const expectThrow = (fn, code) => {
  try { fn(); return false; } catch (e) { return String(e.message).includes(code); }
};
let f = 0;
if (!expectThrow(() => assertPassword("", "STORE_PASSWORD"), "TOO_SHORT")) { console.error("empty"); f++; }
if (!expectThrow(() => assertPassword("12345", "STORE_PASSWORD"), "TOO_SHORT")) { console.error("short"); f++; }
if (!expectThrow(() => assertPassword("abc\ndef", "STORE_PASSWORD"), "INVALID")) { console.error("nl"); f++; }
if (assertPassword("secret1", "STORE_PASSWORD") !== "secret1") { console.error("ok-pass"); f++; }
if (!expectThrow(() => assertPath("", "KEYSTORE_PATH"), "REQUIRED")) { console.error("path"); f++; }
if (assertPath("/storage/emulated/0/x.keystore", "KEYSTORE_PATH") !== "/storage/emulated/0/x.keystore") { console.error("path-ok"); f++; }
if (f) process.exit(1);
console.log("AIB_SIGNING_VALIDATE_SELFTEST_OK");
