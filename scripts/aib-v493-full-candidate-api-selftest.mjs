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
const packages = [...generated.CANDIDATE_PACKAGES];
const fullSelection = packages.map((pkg) => pkg.name);
assert.equal(packages.length, 82, "must test actual checked-in signed cohort, never synthetic extension");
let calls = [];
let filesDir = "/data/user/0/com.karat.aibuilder/files";
let runtimeReady = true;
const bridgeCalls = { lookup: 0, prepare: 0, status: 0 };
let prepareBarrier = null;
let statusBarrier = null;
function payload(action, selected = [], options = {}) {
  const evidenceBase = filesDir === "/data/data/com.karat.aibuilder/files" ? "/data/data" : "/data/user/0";
  const stateNames = action === "install" || action === "reinstall" || action === "check"
    ? fullSelection
    : action === "remove" ? selected : [];
  const state = stateNames.map((name) => {
    const pkg = packages.find((item) => item.name === name);
    return action === "remove"
      ? `AIB_FULL_CANDIDATE_PACKAGE:${name}:absent:-`
      : `AIB_FULL_CANDIDATE_PACKAGE:${name}:installed:${pkg.version}`;
  }).join("\n");
  const cohort = action === "install" || action === "reinstall" ? "AIB_FULL_CANDIDATE_COHORT:82\n" : "";
  return {
    stdout: `AIB_FULL_CANDIDATE_OK:${action}\n${cohort}AIB_FULL_CANDIDATE_EVIDENCE:${evidenceBase}/com.karat.aibuilder/files/candidate-transactions/tx-abcdefghijkl\n${state}${state ? "\n" : ""}`,
    stderr: "",
    exitCode: 0,
    timedOut: false,
    outputTruncated: false,
    ...options,
  };
}
let behavior = async (action, selected) => payload(action, selected);
const bridge = {
  getTermuxNative: () => {
    bridgeCalls.lookup++;
    return { runEmbeddedCandidateFullTransaction() {} };
  },
  prepareEmbeddedTermuxRuntime: async () => {
    bridgeCalls.prepare++;
    if (prepareBarrier) await prepareBarrier;
  },
  getEmbeddedTermuxRuntimeStatus: async () => {
    bridgeCalls.status++;
    if (statusBarrier) await statusBarrier;
    return {
      ready: runtimeReady,
      bootstrapManifestValid: true,
      applicationId: "com.karat.aibuilder",
      architecture: "aarch64",
      filesDir,
      termuxPrefix: `${filesDir}/usr`,
    };
  },
  runEmbeddedFullCandidateTransaction: async (action, selected) => {
    calls.push({ action, selected: [...selected] });
    return behavior(action, selected);
  },
};
const exports = {};
const requireModule = (id) => id === "./termux-bridge" ? bridge
  : id === "./candidate-full-packages.generated" ? generated
    : id === "./private-runtime-path.js" ? createRequire(import.meta.url)("../lib/private-runtime-path.js")
      : createRequire(import.meta.url)(id);
const source = read("lib/candidate-full-feed.ts");
vm.runInNewContext(transpile(source), {
  exports, require: requireModule, Map, Set, JSON, Promise, Array, RegExp, Error, Object, String,
});
const api = exports;
const runCandidateAction = api.runFullCandidateAction;
api.runFullCandidateAction = (action, selected = []) => runCandidateAction(action, selected, { sessionEnabled: true });
let assertions = 0;
const ok = (value, message) => { assert.ok(value, message); assertions++; };
ok(api.CANDIDATE_BOOTSTRAP_COMPATIBLE === true && packages.length === 82, "test-only compatible mode is pinned to actual signed 82 cohort");
ok(api.CANDIDATE_CACHE_NAME === generated.CANDIDATE_CACHE_NAME && api.CANDIDATE_RELEASE_VALID_UNTIL === generated.CANDIDATE_RELEASE_VALID_UNTIL, "generated cache pin and expiry exported");
ok(api.CANDIDATE_PROTECTED_PACKAGES.length > 0, "bootstrap protections remain");

const disabled = await runCandidateAction("install", fullSelection, { sessionEnabled: false });
ok(!disabled.ok && disabled.code === "AIB_FULL_CANDIDATE_SESSION_DISABLED" && disabled.mutationStatus === "not_dispatched", "disabled session is rejected before action execution");
ok(calls.length === 0 && bridgeCalls.lookup === 0 && bridgeCalls.prepare === 0 && bridgeCalls.status === 0, "disabled session performs zero native lookup, preparation, readiness query, or dispatch");

const partialCases = [
  ["install", [packages[0].name]],
  ["install", []],
  ["reinstall", [packages[0].name]],
  ["reinstall", []],
  ["install", fullSelection.slice(1)],
];
for (const [action, selected] of partialCases) {
  const before = { ...bridgeCalls };
  const result = await api.runFullCandidateAction(action, selected);
  const expected = selected.length ? "AIB_FULL_CANDIDATE_FULL_COHORT_REQUIRED" : "AIB_FULL_CANDIDATE_SELECTION_REQUIRED";
  ok(!result.ok && result.code === expected && result.mutationStatus === "not_dispatched", `${action} rejects partial/empty selection before native dispatch`);
  ok(calls.length === 0 && bridgeCalls.lookup === before.lookup && bridgeCalls.prepare === before.prepare && bridgeCalls.status === before.status, "partial/empty selection performs zero native lookup, preparation, readiness query, or dispatch");
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
const waitFor = async (predicate) => {
  for (let i = 0; i < 20 && !predicate(); i++) await tick();
  ok(predicate(), "async gate reached expected preflight boundary");
};
let sessionLive = true;
let releasePrepare;
prepareBarrier = new Promise((resolve) => { releasePrepare = resolve; });
const duringPrepare = runCandidateAction("install", fullSelection, { sessionEnabled: true, isSessionEnabled: () => sessionLive });
await waitFor(() => bridgeCalls.prepare === 1);
sessionLive = false;
releasePrepare();
const prepareBlocked = await duringPrepare;
prepareBarrier = null;
sessionLive = true;
ok(!prepareBlocked.ok && prepareBlocked.code === "AIB_FULL_CANDIDATE_SESSION_DISABLED" && prepareBlocked.mutationStatus === "not_dispatched", "session disabled during runtime preparation blocks transaction before readiness/native dispatch");
ok(bridgeCalls.status === 0 && calls.length === 0, "session recheck after preparation prevents later readiness and mutation calls");

let releaseStatus;
statusBarrier = new Promise((resolve) => { releaseStatus = resolve; });
let sessionAvailable = true;
const duringStatus = runCandidateAction("install", fullSelection, { sessionEnabled: true, isSessionEnabled: () => sessionAvailable });
await waitFor(() => bridgeCalls.status === 1);
sessionAvailable = false;
releaseStatus();
const statusBlocked = await duringStatus;
statusBarrier = null;
sessionAvailable = true;
ok(!statusBlocked.ok && statusBlocked.code === "AIB_FULL_CANDIDATE_SESSION_DISABLED" && statusBlocked.mutationStatus === "not_dispatched", "session disabled during readiness blocks native transaction");
ok(calls.length === 0, "readiness race is closed before native transaction starts");

for (const path of ["/data/user/0/com.karat.aibuilder/files", "/data/data/com.karat.aibuilder/files"]) {
  filesDir = path;
  const before = calls.length;
  const result = await api.runFullCandidateAction("install", fullSelection);
  ok(result.ok && Object.keys(result.states).length === 82 && calls.at(-1).selected.length === 82, "only the full actual cohort is dispatched and verified");
  ok(calls.length === before + 1, "exactly one native dispatch");
}
for (const action of ["verify", "check"]) {
  calls = [];
  if (action === "check") {
    const invalid = await api.runFullCandidateAction(action, [packages[0].name]);
    ok(!invalid.ok && invalid.mutationStatus === "not_requested", "check rejects package selections before native dispatch");
  }
  await api.runFullCandidateAction(action);
  ok(calls.at(-1).selected.length === 0, `${action} native receives no selected package names`);
}
const removable = packages.find((pkg) => !generated.CANDIDATE_PROTECTED_PACKAGES.includes(pkg.name));
const removal = await api.runFullCandidateAction("remove", [removable.name]);
ok(removal.ok && calls.at(-1).selected.length === 1 && calls.at(-1).selected[0] === removable.name, "single-package remove remains limited to its exact selected name");

for (const [label, mutate, options] of [
  ["missing one", (rows) => rows.slice(1), {}],
  ["duplicate", (rows) => [...rows, rows[0]], {}],
  ["wrong version", (rows) => rows.map((row, index) => index === 0 ? row.replace(packages[0].version, "wrong-version") : row), {}],
  ["marker but nonzero exit", (rows) => rows, { exitCode: 2 }],
]) {
  behavior = async (action, selected) => {
    const result = payload(action, selected);
    const lines = result.stdout.split("\n");
    const rows = lines.filter((line) => line.startsWith("AIB_FULL_CANDIDATE_PACKAGE:"));
    const base = lines.filter((line) => !line.startsWith("AIB_FULL_CANDIDATE_PACKAGE:"));
    return { ...result, stdout: [...base, ...mutate(rows)].join("\n"), ...options };
  };
  const result = await api.runFullCandidateAction("install", fullSelection);
  ok(!result.ok && result.states === undefined, `${label} fails closed`);
}
behavior = async (action, selected) => {
  const result = payload(action, selected);
  return { ...result, stdout: result.stdout.replace("AIB_FULL_CANDIDATE_COHORT:82\n", "") };
};
ok(!(await api.runFullCandidateAction("reinstall", fullSelection)).ok, "missing cohort marker rejected");

const privateStdout = "https://custom-provider.example/key=secret";
const privateStderr = "/home/private user=token";
behavior = async (action, selected) => payload(action, selected, { stdout: privateStdout, stderr: privateStderr, exitCode: 7 });
const nonzero = await api.runFullCandidateAction("install", fullSelection);
ok(!nonzero.ok && nonzero.code === "AIB_FULL_CANDIDATE_UNCONFIRMED" && nonzero.mutationStatus === "unconfirmed", "nonzero candidate result remains unconfirmed");
ok(nonzero.diagnostics.phase === "result_validation" && nonzero.diagnostics.reasonCode === "CANDIDATE_NONZERO_EXIT" && nonzero.diagnostics.exitCode === 7, "safe failure phase/reason/exitCode preserved");
ok(nonzero.diagnostics.stdoutChars === privateStdout.length && nonzero.diagnostics.stderrChars === privateStderr.length && nonzero.diagnostics.stdoutBytes === privateStdout.length && nonzero.diagnostics.stderrBytes === privateStderr.length, "output volume is measured without copying streams");
ok(!JSON.stringify(nonzero.diagnostics).includes("custom-provider.example") && !JSON.stringify(nonzero.diagnostics).includes("/home/private"), "structured diagnostics exclude raw output and paths");
behavior = async (action, selected) => payload(action, selected, { timedOut: true });
const timeout = await api.runFullCandidateAction("install", fullSelection);
ok(!timeout.ok && timeout.code === "AIB_FULL_CANDIDATE_TIMEOUT" && timeout.mutationStatus === "unconfirmed" && timeout.diagnostics.reasonCode === "CANDIDATE_NATIVE_TIMEOUT" && timeout.diagnostics.timedOut === true, "timeout remains unconfirmed and is categorized");
behavior = async (action, selected) => payload(action, selected, { outputTruncated: true });
const truncated = await api.runFullCandidateAction("install", fullSelection);
ok(!truncated.ok && truncated.code === "AIB_FULL_CANDIDATE_TRUNCATED" && truncated.mutationStatus === "unconfirmed" && truncated.diagnostics.reasonCode === "CANDIDATE_OUTPUT_TRUNCATED" && truncated.diagnostics.outputTruncated === true, "truncated result remains unconfirmed and is categorized");
behavior = async (action, selected) => payload(action, selected);
const protectedName = generated.CANDIDATE_PROTECTED_PACKAGES[0];
ok((await api.runFullCandidateAction("remove", [protectedName])).code === "AIB_FULL_CANDIDATE_BOOTSTRAP_REMOVAL_FORBIDDEN", "protected removal rejected locally");
runtimeReady = false;
calls = [];
const failed = await api.runFullCandidateAction("install", fullSelection);
ok(!failed.ok && failed.code === "AIB_FULL_CANDIDATE_PRIVATE_RUNTIME_REQUIRED" && calls.length === 0, "missing runtime blocks before transaction dispatch");
runtimeReady = true;
const panel = read("components/FullCandidatePackagesPanel.tsx");
ok(panel.includes("82 пакета") && panel.includes("CANDIDATE_RELEASE_VALID_UNTIL") && panel.includes("НЕ ВЫПОЛНЕНО"), "UI displays actual cohort, exact expiry, and device-test caveat");
ok(panel.includes("runFullCohortAction") && panel.includes("Reinstall full set (82)"), "install/reinstall are separate explicit whole-cohort actions");
ok(!panel.includes('["install", "reinstall", "remove", "check"]'), "per-row actions no longer expose install/reinstall");
ok(source.includes("CANDIDATE_BOOTSTRAP_COMPATIBLE = true") && source.includes("productionEnabled: false") && source.includes("qualified: false"), "test activation does not promote production qualification");
console.log(`aib-v493-full-candidate-api-selftest: PASS (${assertions} assertions; actual signed 82 catalog; partial mutation rejected before native I/O; test-only mode; production disabled)`);
