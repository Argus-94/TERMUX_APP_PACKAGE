import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const appConfig = fs.readFileSync(path.join(root, "app.config.ts"), "utf8");
const keepAlive = fs.readFileSync(path.join(root, "lib/keep-alive.ts"), "utf8");
const plugin = path.join(root, "plugins/withModelKeepAliveService.js");

if (appConfig.includes("withModelKeepAliveService")) throw new Error("A03_PLUGIN_STILL_ENABLED");
if (appConfig.includes("FOREGROUND_SERVICE_DATA_SYNC")) throw new Error("A03_DATASYNC_PERMISSION_STILL_DECLARED");
if (keepAlive.includes("NativeModules") || keepAlive.includes("ModelKeepAlive")) throw new Error("A03_NATIVE_KEEPALIVE_STILL_ACTIVE");
if (!keepAlive.includes("A-03") || !keepAlive.includes("no longer starts a foreground service")) throw new Error("A03_REMEDIATION_MARKER_MISSING");
if (fs.existsSync(plugin)) {
  const oldPlugin = fs.readFileSync(plugin, "utf8");
  if (oldPlugin.includes("FOREGROUND_SERVICE_TYPE_DATA_SYNC") || oldPlugin.includes('"android:foregroundServiceType": "dataSync"')) {
    throw new Error("A03_LEGACY_DATASYNC_PLUGIN_PRESENT");
  }
}
console.log("AIB_MODEL_KEEPALIVE_SELFTEST_OK");
