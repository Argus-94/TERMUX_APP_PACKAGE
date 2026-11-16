import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const logger = fs.readFileSync(path.join(root, "lib/persistent-logger.ts"), "utf8");
const redaction = fs.readFileSync(path.join(root, "lib/log-redaction.ts"), "utf8");
const errors = [];
if (!redaction.includes("export function redactSecrets")) errors.push("REDACTION_MODULE_EXPORT_MISSING");
if (!logger.includes('from "./log-redaction"')) errors.push("LOGGER_REDACTION_IMPORT_MISSING");
if (logger.includes("function redactSecrets(value: string)")) errors.push("REDACTION_IMPLEMENTATION_NOT_EXTRACTED");
if (!redaction.includes("PRIVATE KEY") || !redaction.includes("AKIA[REDACTED]")) errors.push("REDACTION_RULES_LOST");
if (!logger.includes("export function redactLogText")) errors.push("PUBLIC_REDACTION_EXPORT_LOST");
if (errors.length) { console.error(errors.join("\n")); process.exit(1); }
console.log("AIB_P2_ARCHITECTURE_SELFTEST_OK logger_redaction_extracted=true");
