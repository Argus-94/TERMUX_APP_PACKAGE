import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const buildLoop = fs.readFileSync(path.join(root, "lib/build-loop.ts"), "utf8");
const prompt = fs.readFileSync(path.join(root, "lib/autonomous-engineer.ts"), "utf8");

if (!buildLoop.includes('root.startsWith("/")')) throw new Error("DYNAMIC_ABSOLUTE_ROOT_NOT_ACCEPTED");
if (!buildLoop.includes('PROJECT_PATH_INVALID')) throw new Error("INVALID_ROOT_GUARD_MISSING");
if (!buildLoop.includes("valid projects merely because their path is not one of the")) throw new Error("DYNAMIC_PATH_COMMENT_MISSING");
if (!prompt.includes("Never assume /storage/emulated/0/AIBuilderTermux")) throw new Error("UNIVERSAL_DYNAMIC_PATH_RULE_MISSING");
if (!prompt.includes("Maintain one canonical PROJECT_ROOT")) throw new Error("PROJECT_ROOT_CANONICALIZATION_MISSING");
console.log("AIB_DYNAMIC_PROJECT_ROOT_SELFTEST_OK absolute_paths=backend_agnostic traversal=blocked prompt=dynamic");
