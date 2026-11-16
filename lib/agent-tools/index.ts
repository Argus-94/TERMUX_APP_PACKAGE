import { isAbsolutePosixPath, normalizeAbsolutePosixPath, resolvePosixPath } from "./posix-path";
import * as buildRun from "./build-run";
import * as toolchainEnsure from "./toolchain-ensure";
import * as fsRead from "./fs/read";
import * as fsHashline from "./fs/hashline";
import * as fsCreate from "./fs/create";
import * as fsDelete from "./fs/delete";
import * as fsReplace from "./fs/replace";
import * as fsReplaceRange from "./fs/replace-range";
import * as astSearch from "./ast/search";
import * as astPreview from "./ast/preview";
import * as astEdit from "./ast/edit";
import * as lspDiagnostics from "./lsp/diagnostics";
import * as lspRequest from "./lsp/request";
import * as lspDefinition from "./lsp/definition";
import * as lspReferences from "./lsp/references";
import * as lspHover from "./lsp/hover";
import * as lspCompletion from "./lsp/completion";
import * as lspRename from "./lsp/rename";
import * as githubRead from "./github/read";
import * as githubTree from "./github/tree";
import * as githubList from "./github/list";
import * as githubDiff from "./github/diff";
import * as githubPrFiles from "./github/pr-files";
import * as githubSearch from "./github/search";
import * as githubSearchIssues from "./github/search-issues";
import * as githubRepo from "./github/repo";
import * as githubRepoCreate from "./github/repo-create";
import * as githubBranch from "./github/branch";
import * as githubApply from "./github/apply";
import * as githubPrCreate from "./github/pr-create";
import * as githubMaterialize from "./github/materialize";
import * as githubPack from "./github/pack";
import * as githubBranches from "./github/branches";
import * as githubCommits from "./github/commits";
import * as githubCommit from "./github/commit";
import * as githubTags from "./github/tags";
import * as githubReleases from "./github/releases";
import * as githubRelease from "./github/release";
import * as githubPrList from "./github/pr-list";
import * as githubPrMerge from "./github/pr-merge";
import * as githubIssue from "./github/issue";
import * as githubIssueCreate from "./github/issue-create";
import * as githubIssueComment from "./github/issue-comment";
import * as githubRename from "./github/rename";
import * as githubDownloadAsset from "./github/download-asset";
import * as githubWrite from "./github/write";
import * as githubCopy from "./github/copy";
import * as githubParse from "./github/parse";
import * as interceptorStatus from "./interceptor/status";
import * as interceptorEnable from "./interceptor/enable";
import * as interceptorDisable from "./interceptor/disable";
import * as interceptorLast from "./interceptor/last";
import * as interceptorDetail from "./interceptor/detail";
import * as interceptorCommand from "./interceptor/command";
import * as interceptorRuleToggle from "./interceptor/rule-toggle";
import * as interceptorRulesDisable from "./interceptor/rules-disable";


import * as skillsList from "./skills/list";
import * as skillsRead from "./skills/read";
import * as skillsVerify from "./skills/verify";
import * as skillsPin from "./skills/pin";
import * as memoryRecall from "./memory/recall";
import * as memoryRetain from "./memory/retain";
import * as memoryReflect from "./memory/reflect";
import * as runtimeStatus from "./runtime/status";
import * as runtimePackages from "./runtime/packages";
import * as workspaceList from "./workspace-list";
import * as workspaceRead from "./workspace-read";
import * as workspaceWrite from "./workspace-write";
import * as runtimeSession from "./runtime/session";
import * as runtimeTerminal from "./runtime/terminal";
import * as runtimeProot from "./runtime/proot";
import * as runtimeKillSession from "./runtime/kill-session";
import * as pkgEnsure from "./pkg-ensure";
import * as hardwareProbeTool from "./hardware-probe-tool";
import * as diagnosticsLog from "./diagnostics-log";
import * as ctxCompose from "./ctx/compose";
import * as ctxExpand from "./ctx/expand";
import * as ctxMetrics from "./ctx/metrics";
import { AGENT_TOOL_NAMES, type AgentToolCall, type AgentToolName, type ToolArgs, type ToolDefinition, type ToolExecutionContext } from "./types";
import { isArgsObject } from "./common";
import { executeAfterMutationCheckpoint, isAgentToolMutation } from "./mutation-checkpoint";
import { AI_BUILDER_WORKSPACE_ROOT, isCanonicalAIBuilderWorkspacePath, isSafeAIBuilderWorkspaceRelativePath } from "../private-workspace-policy";
import { privateAgentToolUnsupportedReason } from "../agent-private-tool-policy";
import { persistentLogger } from "../persistent-logger";
import { githubMutationTarget, isGithubMutationTool } from "./github-mutations";

const DEFINITIONS: Record<AgentToolName, ToolDefinition> = {
  "build.run": { validate: buildRun.validate, execute: buildRun.execute },
  "toolchain.ensure": { validate: toolchainEnsure.validate, execute: toolchainEnsure.execute },
  "fs.read": { validate: fsRead.validate, execute: fsRead.execute },
  "fs.hashline": { validate: fsHashline.validate, execute: fsHashline.execute },
  "fs.create": { validate: fsCreate.validate, execute: fsCreate.execute },
  "fs.delete": { validate: fsDelete.validate, execute: fsDelete.execute },
  "fs.replace": { validate: fsReplace.validate, execute: fsReplace.execute },
  "fs.replaceRange": { validate: fsReplaceRange.validate, execute: fsReplaceRange.execute },
  "ast.search": { validate: astSearch.validate, execute: astSearch.execute },
  "ast.preview": { validate: astPreview.validate, execute: astPreview.execute },
  "ast.edit": { validate: astEdit.validate, execute: astEdit.execute },
  "lsp.diagnostics": { validate: lspDiagnostics.validate, execute: lspDiagnostics.execute },
  "lsp.request": { validate: lspRequest.validate, execute: lspRequest.execute },
  "lsp.definition": { validate: lspDefinition.validate, execute: lspDefinition.execute },
  "lsp.references": { validate: lspReferences.validate, execute: lspReferences.execute },
  "lsp.hover": { validate: lspHover.validate, execute: lspHover.execute },
  "lsp.completion": { validate: lspCompletion.validate, execute: lspCompletion.execute },
  "lsp.rename": { validate: lspRename.validate, execute: lspRename.execute },
  "github.read": { validate: githubRead.validate, execute: githubRead.execute },
  "github.tree": { validate: githubTree.validate, execute: githubTree.execute },
  "github.list": { validate: githubList.validate, execute: githubList.execute },
  "github.diff": { validate: githubDiff.validate, execute: githubDiff.execute },
  "github.prFiles": { validate: githubPrFiles.validate, execute: githubPrFiles.execute },
  "github.search": { validate: githubSearch.validate, execute: githubSearch.execute },
  "github.searchIssues": { validate: githubSearchIssues.validate, execute: githubSearchIssues.execute },
  "github.repo": { validate: githubRepo.validate, execute: githubRepo.execute },
  "github.repoCreate": { validate: githubRepoCreate.validate, execute: githubRepoCreate.execute },
  "github.branch": { validate: githubBranch.validate, execute: githubBranch.execute },
  "github.apply": { validate: githubApply.validate, execute: githubApply.execute },
  "github.prCreate": { validate: githubPrCreate.validate, execute: githubPrCreate.execute },
  "github.materialize": { validate: githubMaterialize.validate, execute: githubMaterialize.execute },
  "github.pack": { validate: githubPack.validate, execute: githubPack.execute },
  "github.branches": { validate: githubBranches.validate, execute: githubBranches.execute },
  "github.commits": { validate: githubCommits.validate, execute: githubCommits.execute },
  "github.commit": { validate: githubCommit.validate, execute: githubCommit.execute },
  "github.tags": { validate: githubTags.validate, execute: githubTags.execute },
  "github.releases": { validate: githubReleases.validate, execute: githubReleases.execute },
  "github.release": { validate: githubRelease.validate, execute: githubRelease.execute },
  "github.prList": { validate: githubPrList.validate, execute: githubPrList.execute },
  "github.prMerge": { validate: githubPrMerge.validate, execute: githubPrMerge.execute },
  "github.issue": { validate: githubIssue.validate, execute: githubIssue.execute },
  "github.issueCreate": { validate: githubIssueCreate.validate, execute: githubIssueCreate.execute },
  "github.issueComment": { validate: githubIssueComment.validate, execute: githubIssueComment.execute },
  "github.rename": { validate: githubRename.validate, execute: githubRename.execute },
  "github.downloadAsset": { validate: githubDownloadAsset.validate, execute: githubDownloadAsset.execute },
  "github.write": { validate: githubWrite.validate, execute: githubWrite.execute },
  "github.copy": { validate: githubCopy.validate, execute: githubCopy.execute },
  "github.parse": { validate: githubParse.validate, execute: async (args) => githubParse.execute(args) },
  "interceptor.status": { validate: interceptorStatus.validate, execute: interceptorStatus.execute },
  "interceptor.enable": { validate: interceptorEnable.validate, execute: interceptorEnable.execute },
  "interceptor.disable": { validate: interceptorDisable.validate, execute: interceptorDisable.execute },
  "interceptor.last": { validate: interceptorLast.validate, execute: interceptorLast.execute },
  "interceptor.detail": { validate: interceptorDetail.validate, execute: interceptorDetail.execute },
  "interceptor.command": { validate: interceptorCommand.validate, execute: interceptorCommand.execute },
  "interceptor.ruleToggle": { validate: interceptorRuleToggle.validate, execute: interceptorRuleToggle.execute },
  "interceptor.rulesDisable": { validate: interceptorRulesDisable.validate, execute: interceptorRulesDisable.execute },


  "skills.list": { validate: skillsList.validate, execute: skillsList.execute },
  "skills.read": { validate: skillsRead.validate, execute: skillsRead.execute },
  "skills.verify": { validate: skillsVerify.validate, execute: skillsVerify.execute },
  "skills.pin": { validate: skillsPin.validate, execute: skillsPin.execute },
  "memory.recall": { validate: memoryRecall.validate, execute: memoryRecall.execute },
  "memory.retain": { validate: memoryRetain.validate, execute: memoryRetain.execute },
  "memory.reflect": { validate: memoryReflect.validate, execute: memoryReflect.execute },
  "runtime.status": { validate: runtimeStatus.validate, execute: runtimeStatus.execute },
  "runtime.packages": { validate: runtimePackages.validate, execute: runtimePackages.execute },
  "workspace.list": { validate: workspaceList.validate, execute: workspaceList.execute },
  "workspace.read": { validate: workspaceRead.validate, execute: workspaceRead.execute },
  "workspace.write": { validate: workspaceWrite.validate, execute: workspaceWrite.execute },
  "runtime.session": { validate: runtimeSession.validate, execute: runtimeSession.execute },
  "runtime.terminal": { validate: runtimeTerminal.validate, execute: runtimeTerminal.execute },
  "runtime.proot": { validate: runtimeProot.validate, execute: runtimeProot.execute },
  "runtime.killSession": { validate: runtimeKillSession.validate, execute: runtimeKillSession.execute },
  "pkg.ensure": { validate: pkgEnsure.validate, execute: pkgEnsure.execute },
  "hardware.probe": { validate: hardwareProbeTool.validate, execute: hardwareProbeTool.execute },
  "diagnostics.log": { validate: diagnosticsLog.validate, execute: diagnosticsLog.execute },
  "ctx.compose": { validate: ctxCompose.validate, execute: ctxCompose.execute },
  "ctx.expand": { validate: ctxExpand.validate, execute: ctxExpand.execute },
  "ctx.metrics": { validate: ctxMetrics.validate, execute: ctxMetrics.execute },
};

export function validateAgentToolCall(spec: unknown): { ok: true } | { ok: false; error: string } {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
    return { ok: false, error: "TOOL_CALL_OBJECT_REQUIRED" };
  }
  const call = spec as AgentToolCall;
  if (typeof call.tool !== "string" || !call.tool.trim()) {
    return { ok: false, error: "TOOL_NAME_REQUIRED" };
  }
  if (!Object.prototype.hasOwnProperty.call(DEFINITIONS, call.tool)) {
    return { ok: false, error: `UNKNOWN_AGENT_TOOL:${call.tool}` };
  }
  if (call.args !== undefined && !isArgsObject(call.args)) {
    return { ok: false, error: "TOOL_ARGS_OBJECT_REQUIRED" };
  }
  const args = call.args || {};
  if (Object.prototype.hasOwnProperty.call(args, "allowDangerous")) {
    return { ok: false, error: "ALLOW_DANGEROUS_NOT_ALLOWED" };
  }
  if (call.tool.startsWith("github.") && Object.prototype.hasOwnProperty.call(args, "token")) {
    return { ok: false, error: "GITHUB_TOKEN_MUST_REMAIN_IN_SECURE_VAULT" };
  }
  const error = DEFINITIONS[call.tool as AgentToolName].validate(args);
  return error ? { ok: false, error } : { ok: true };
}

export async function executeAgentTool(name: AgentToolName, args: ToolArgs, projectPath?: string | null, context?: ToolExecutionContext) {
  const definition = DEFINITIONS[name];
  if (!definition) throw new Error(`UNKNOWN_AGENT_TOOL:${name}`);
  // Enforce the capability boundary here as well as at model-facing callers so
  // playbooks, subagents, tests, and direct facade users cannot bypass a private
  // target denial. Missing context uses only the bundled private runtime.
  const executionTarget = context?.executionTarget ?? "embedded-private";
  context = { ...context, executionTarget };
  const privatePolicyDenial = privateAgentToolUnsupportedReason(name, executionTarget);
  if (privatePolicyDenial) throw new Error(privatePolicyDenial);
  const validationError = definition.validate(args ?? {});
  if (validationError) throw new Error(validationError);
  if (isGithubMutationTool(name)) {
    if (!context.authorizeExternalMutation) throw new Error("GITHUB_MUTATION_CONFIRMATION_REQUIRED");
    const authorizationArgs = Object.freeze(JSON.parse(JSON.stringify(args ?? {})) as Record<string, unknown>);
    await context.authorizeExternalMutation({
      tool: name,
      target: githubMutationTarget(name, args ?? {}),
      args: authorizationArgs,
    });
  }
  persistentLogger.add(
    "info",
    "AgentTool",
    `→ tool=${name} traceId=${context?.traceId || "-"} argCount=${Object.keys(args ?? {}).length}`,
    "agent"
  );
  const startedAt = Date.now();
  try {
    let result;
    if (isAgentToolMutation(name)) {
      if (name === "workspace.write") {
        if (!isSafeAIBuilderWorkspaceRelativePath(args.relativePath)) throw new Error("AIB_WORKSPACE_RELATIVE_PATH_INVALID");
        let workspaceRoot: string = AI_BUILDER_WORKSPACE_ROOT;
        if (projectPath !== undefined && projectPath !== null) {
          if (!isCanonicalAIBuilderWorkspacePath(projectPath)) throw new Error("AIB_WORKSPACE_PROJECT_ROOT_NOT_ALLOWED");
          workspaceRoot = projectPath;
        }
        // Native relativePath is always relative to the fixed workspace root,
        // never to the optional current project. Checkpoint that exact target.
        const target = resolvePosixPath(AI_BUILDER_WORKSPACE_ROOT, args.relativePath);
        if (target === workspaceRoot || !target.startsWith(`${workspaceRoot}/`)) throw new Error("PATH_NOT_ALLOWED");
        result = await executeAfterMutationCheckpoint(name, target, context?.beforeFileMutation,
          () => definition.execute(args, projectPath, context));
      } else {
      if (!projectPath || !isAbsolutePosixPath(projectPath)) throw new Error("PROJECT_ROOT_REQUIRED");
      const projectRoot = normalizeAbsolutePosixPath(projectPath);
      const target = name === "ast.edit"
        ? projectRoot
        : resolvePosixPath(projectRoot, String(args.path ?? ""));
      if (target !== projectRoot && !target.startsWith(`${projectRoot}/`)) {
        throw new Error("PATH_NOT_ALLOWED");
      }
      result = await executeAfterMutationCheckpoint(
        name,
        target,
        context?.beforeFileMutation,
        () => definition.execute(args, projectPath, context),
      );
      }
    } else {
      result = await definition.execute(args, projectPath, context);
    }
    const exit = typeof result === "object" && result !== null && "exitCode" in result ? String((result as any).exitCode) : "ok";
    const safeExit = /^-?\d{1,4}$/.test(exit) || exit === "ok" ? exit : "failed";
    const resultType = result === null ? "null" : Array.isArray(result) ? "array" : typeof result;
    const resultSize = typeof result === "string" ? result.length : result && typeof result === "object" ? Object.keys(result).length : 0;
    persistentLogger.add(
      safeExit === "0" || safeExit === "ok" ? "info" : "warn",
      "AgentTool",
      `← tool=${name} traceId=${context?.traceId || "-"} exit=${safeExit} durationMs=${Date.now() - startedAt} resultType=${resultType} resultSize=${resultSize}`,
      "agent"
    );
    return result;
  } catch (e: unknown) {
    const errorName = e instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(e.name) ? e.name : "Error";
    const errorCode = e instanceof Error && /^[A-Z][A-Z0-9_.:-]{1,80}$/.test(e.message) ? e.message : "REDACTED";
    persistentLogger.add("error", "AgentTool", `× tool=${name} traceId=${context?.traceId || "-"} durationMs=${Date.now() - startedAt} error=${errorName} code=${errorCode}`, "agent");
    throw e;
  }
}

export { AGENT_TOOL_NAMES };
export type { AgentToolCall, AgentToolName, ToolArgs } from "./types";
