#!/usr/bin/env node
import fs from "node:fs";
const fail = (m) => { console.error(`AIB_GITHUB_AGENT_WRITE_SELFTEST_FAIL ${m}`); process.exit(1); };
const read = (p) => fs.readFileSync(p, "utf8");
const tools = read("lib/github-tools.ts");
const types = read("lib/agent-tools/types.ts");
const registry = read("lib/agent-tools/index.ts");
const protocol = read("lib/agent-engine.ts");
const agent = read("lib/termux-agent.ts");
const native = read("plugins/withGithubTool.js");

if (!native.includes("ReactMethod fun secretGet(name: String, promise:") || !native.includes("secretVault.secretGet(name)")) fail("native_secret_bridge_missing");
if (!native.includes("ReactMethod fun httpRequest(payload: String, promise:")) fail("native_http_bridge_missing");

const names = [
  "github.repo","github.branch","github.apply","github.prCreate","github.materialize","github.pack",
  "github.branches","github.commits","github.commit","github.tags","github.releases","github.release",
  "github.prList","github.prMerge","github.issue","github.issueCreate","github.issueComment",
  "github.rename","github.downloadAsset","github.write","github.copy","github.parse",
  "github.read","github.tree","github.list","github.diff","github.prFiles","github.search","github.searchIssues",
];
for (const name of names) {
  if (!types.includes(`"${name}"`)) fail(`tool_name_missing:${name}`);
  if (!registry.includes(`"${name}"`)) fail(`tool_registry_missing:${name}`);
}

for (const marker of [
  "githubRepoInfo","githubCreateBranch","githubApplyFiles","githubCreatePullRequest",
  "githubMaterializeRepo","githubPackLocalDir","githubWriteFile","githubCopyFile","parseGithubRepoRef",
  "githubReadFile","decodeGithubFileContent","GITHUB_TOKEN_NOT_CONNECTED","AIB_GH_MATERIALIZE_OK",
  "AIB_GH_PACK_OK","AIB_GH_DOWNLOAD_OK","githubListBranches","githubRenameFile","githubMergePullRequest",
]) {
  if (!tools.includes(marker)) fail(`github_marker_missing:${marker}`);
}

if (!/GITHUB_TOKEN_MUST_REMAIN_IN_SECURE_VAULT/.test(registry)) fail("token_guard_missing");
if (!/UNIVERSAL RULE/.test(protocol)) fail("protocol_missing_universal_rule");
if (!/github\.write/.test(protocol) || !/github\.materialize/.test(protocol)) fail("protocol_missing_tool_examples");
if (!/github\.prCreate can infer/.test(protocol)) fail("pr_default_base_protocol_missing");
if (!agent.includes("[GITHUB_TASK]") && !agent.includes("githubTaskHint")) fail("agent_missing_github_task_hint");
// Decoded file content in read
if (!tools.includes('encoding: "utf-8"') || !tools.includes("decodeGithubFileContent")) fail("read_decode_missing");
if (!/commitSha/.test(tools) || !/GITHUB_COMMIT_VERIFY_FAILED/.test(tools)) fail("commit_evidence_missing");
console.log(`AIB_GITHUB_AGENT_WRITE_SELFTEST_OK tools=${names.length} decode=utf8 materialize=ok pack=ok`);
