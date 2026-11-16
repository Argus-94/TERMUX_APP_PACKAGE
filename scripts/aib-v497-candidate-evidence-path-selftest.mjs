import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";
import { typescript } from "./test-helpers/load-typescript.mjs";

const root = new URL("../", import.meta.url);
const read = (path) => fs.readFileSync(new URL(path, root), "utf8");
const generated = {};
const transpile = (source) => typescript.transpileModule(source, {
  compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2020 },
}).outputText;
vm.runInNewContext(transpile(read("lib/candidate-full-packages.generated.ts")), {
  exports: generated,
  require: createRequire(import.meta.url),
});

const filesDir = "/data/user/0/com.karat.aibuilder/files";
let mode = "stage-failure";
const bridge = {
  getTermuxNative: () => ({ runEmbeddedCandidateFullTransaction() {} }),
  prepareEmbeddedTermuxRuntime: async () => {},
  getEmbeddedTermuxRuntimeStatus: async () => ({
    ready: true,
    bootstrapManifestValid: true,
    applicationId: "com.karat.aibuilder",
    architecture: "aarch64",
    filesDir,
    termuxPrefix: `${filesDir}/usr`,
  }),
  runEmbeddedFullCandidateTransaction: async (action) => {
    if (mode === "stage-failure") {
      const error = new Error("AIB_FULL_CANDIDATE_STAGE_IO_FAILURE");
      error.code = "AIB_FULL_CANDIDATE_STAGE_IO_FAILURE";
      throw error;
    }
    return {
      stdout: `AIB_FULL_CANDIDATE_OK:${action}\nAIB_FULL_CANDIDATE_EVIDENCE:${filesDir}/candidate-transactions/tx-abcdefghijkl\n`,
      stderr: "",
      exitCode: 2,
      timedOut: false,
      outputTruncated: false,
    };
  },
};
const nativeRequire = createRequire(import.meta.url);
const requireModule = (id) => {
  if (id === "./termux-bridge") return bridge;
  if (id === "./candidate-full-packages.generated") return generated;
  if (id === "./private-runtime-path.js") return nativeRequire("../lib/private-runtime-path.js");
  return nativeRequire(id);
};
const apiExports = {};
vm.runInNewContext(transpile(read("lib/candidate-full-feed.ts")), {
  exports: apiExports,
  require: requireModule,
  Map,
  Set,
  JSON,
  Promise,
  Array,
  RegExp,
  Error,
  Object,
  String,
});

let assertions = 0;
const check = (condition, message) => { assert.ok(condition, message); assertions += 1; };
const stagedFailure = await apiExports.runFullCandidateAction("verify", [], { sessionEnabled: true });
check(!stagedFailure.ok && stagedFailure.code === "AIB_FULL_CANDIDATE_STAGE_IO_FAILURE", "preserves safe native stage failure code");
check(stagedFailure.evidencePath === undefined, "does not claim candidate-transactions before a native evidence marker");
check(!stagedFailure.log.includes("candidate-transactions"), "stage failure log does not imply an evidence directory exists");

mode = "native-error-with-evidence";
const nativeFailure = await apiExports.runFullCandidateAction("verify", [], { sessionEnabled: true });
check(!nativeFailure.ok && nativeFailure.code === "AIB_FULL_CANDIDATE_UNCONFIRMED", "nonzero native result stays unconfirmed");
check(nativeFailure.evidencePath === `${filesDir}/candidate-transactions/tx-abcdefghijkl`, "retains only the exact validated transaction marker path");

const panel = read("components/FullCandidatePackagesPanel.tsx");
check(panel.includes("Transaction ID"), "English UI shows only the safe transaction ID");
check(panel.includes("ID транзакции"), "Russian UI shows only the safe transaction ID");
check(!panel.includes(" · ${r.evidencePath}"), "UI no longer appends evidence path beside the error code");
console.log(`aib-v497-candidate-evidence-path-selftest: PASS (${assertions} assertions)`);
