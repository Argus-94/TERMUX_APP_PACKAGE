import fs from "node:fs";
import path from "node:path";
const root = process.cwd();
const errors = [];
const ok = (v, m) => { if (!v) errors.push(m); };
const required = [
  "core/runtime/RuntimeIdentity.ts", "core/runtime/RuntimeTaskGate.ts", "core/runtime/RuntimeJournal.ts",
  "core/runtime/RuntimeSupervisor.ts", "core/runtime/RuntimeStores.ts", "core/backup/BackupManager.ts",
  "core/backup/TermuxBackupAdapter.ts", "core/diagnostics/RuntimeHealth.ts", "core/diagnostics/RuntimeDiagnostics.ts",
  "core/device/DeviceAgentBridge.ts", "core/recovery/RecoveryManager.ts",
];
for (const rel of required) ok(fs.existsSync(path.join(root, rel)), `MISSING:${rel}`);
const facade = fs.readFileSync(path.join(root, "core/RuntimeFacade.ts"), "utf8");
for (const token of ["RuntimeTaskGate", "RuntimeJournal", "RuntimeSupervisor", "RuntimeHealth", "BackupManager", "TermuxBackupAdapter", "createBackup", "restoreBackup"]) ok(facade.includes(token), `FACADE_TOKEN:${token}`);
const status = fs.readFileSync(path.join(root, "core/RuntimeStatus.ts"), "utf8");
ok(status.includes("runtimeIdentity"), "STATUS_IDENTITY");
ok(status.includes("supervisor"), "STATUS_SUPERVISOR");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
if (errors.length) { console.error(errors.join("\n")); process.exit(1); }
console.log(`AIB_RUNTIME_DS​​HA_SELFTEST_OK version=${pkg.version}`.replace("DS​​HA", "DSHA"));
