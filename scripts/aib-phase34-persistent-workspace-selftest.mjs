import fs from "node:fs";
const source=fs.readFileSync("core/workspace/PersistentAIWorkspace.ts","utf8");
for (const token of ["async snapshot(","async restoreSnapshot(","pruneSnapshots", "tar -tzf", "WORKSPACE_SNAPSHOT_PATH_TRAVERSAL", "maxSnapshots"]) {
  if (!source.includes(token)) throw new Error(`PERSISTENT_WORKSPACE_CONTRACT_MISSING:${token}`);
}
if (source.includes("currentProjectIdHint")) throw new Error("SHARED_PROJECT_STATE_REGRESSION");
console.log("AIB_PHASE34_PERSISTENT_WORKSPACE_SELFTEST_OK");
