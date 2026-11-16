import { spawnSync } from "node:child_process";
const result = spawnSync("python3", [new URL("./aib-v496-candidate-stage-jvm-selftest.py", import.meta.url).pathname], { stdio: "inherit" });
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
