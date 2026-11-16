/**
 * Public runtime surface for AIBuilderTermux core.
 */

export { createRuntimeFacade, RuntimeFacade } from "./RuntimeFacade";
export type { RuntimeFacadeOptions } from "./RuntimeFacade";
export * from "./enhancements";

export { createHomeLayout, AI_BUILDER_HOME_ENV, AI_BUILDER_HOME_NAME } from "./home/HomeLayout";
export { createHomeEnvironment, DEFAULT_AI_BUILDER_HOME } from "./home/HomeEnvironment";
export { AIBuilderTermuxEnvironment } from "./environment/AIBuilderTermuxEnvironment";
export type { ExecutionEnvironment } from "./environment/ExecutionEnvironment";

export { createProcessRegistry } from "./process/ProcessRegistry";
export { createLockManager } from "./process/LockManager";
export { createSessionManager } from "./session/SessionManager";
export { createToolchainManager } from "./toolchain/ToolchainManager";
export { createUserspaceContainerBackend } from "./container/UserspaceContainerBackend";
export { AgentManager, createAgentManager } from "./agent/AgentManager";
export type { AgentHostHooks } from "./agent/AgentManager";
export type { AgentCapability, AgentPolicy, AgentSession, AgentExecRequest, AgentExecResult } from "./agent/AgentTypes";
export { createInMemoryAndroidBridge } from "./bridge/AndroidBridge";
export { createDeviceManager } from "./bridge/DeviceManager";
export {
  NoneProvider,
  ShizukuProvider,
  RootProvider,
  detectPrivileges,
} from "./privilege/PrivilegeProvider";
export { createNativeContainerRuntime } from "./native/NativeContainerRuntime";
export { createRecoveryManager } from "./recovery/RecoveryManager";
export {
  assertProjectSurvivalInvariant,
  createBackupManifest,
} from "./recovery/BackupMigration";
export { runFinalValidation, assertFinalValidationOk } from "./FinalValidation";
export { TerminalSessionManager } from "./terminal-session-manager";
export { snapshotRuntimeStatus } from "./RuntimeStatus";
export type { RuntimeStatusSnapshot } from "./RuntimeStatus";
export {
  launchUbuntuForProject,
  stopUbuntu,
  destroyUbuntuInstance,
} from "./ubuntu/UbuntuLifecycle";
export { createTermuxTerminalBackend } from "./environment/TermuxTerminalBackend";

export { buildUbuntuShellSpec, describeUbuntuShell } from "./ubuntu/UbuntuShell";

export { buildContainerShellSpec, describeContainerShell } from "./container/ContainerShell";
export type { ContainerShellSpec, ContainerProfile } from "./container/ContainerShell";

export { buildProotLaunchPlan, ProotCommandError } from "./container/ProotCommandBuilder";
export type { ProotLaunchPlan, ProotCommandErrorCode } from "./container/ProotCommandBuilder";

export { discoverRootfsPath, rootfsCandidates } from "./container/RootfsDiscovery";

export { subscribeTerminalOutput, publishTerminalOutput } from "./terminal/TerminalOutputBus";
export { ensureRootfsLayout } from "./container/RootfsEnsure";

export { detectDevicePrivileges } from "./privilege/DevicePrivilegeDetection";
export { buildRootfsImageManifest, isRootfsReady } from "./container/RootfsImageManifest";

export { CURRENT_RUNTIME_IDENTITY, identityKey, requiresMigration } from "./runtime/RuntimeIdentity";
export { RuntimeTaskGate } from "./runtime/RuntimeTaskGate";
export { RuntimeJournal } from "./runtime/RuntimeJournal";
export { RuntimeSupervisor } from "./runtime/RuntimeSupervisor";
export { RuntimeHealth } from "./diagnostics/RuntimeHealth";
export { BackupManager } from "./backup/BackupManager";
export { TermuxBackupAdapter } from "./backup/TermuxBackupAdapter";
export { UnavailableDeviceAgentBridge } from "./device/DeviceAgentBridge";
export type { DeviceAgentBridge, DeviceCommandResult } from "./device/DeviceAgentBridge";
export { parseUiHierarchy, findUiNodes, flattenUiTree, nodeCenter } from "./device/AccessibilityTree";
export type { UiNode, UiSnapshot, UiBounds } from "./device/AccessibilityTree";
export { generateDeviceTestPlan } from "./device/DeviceTestPlan";
export type { DeviceTestPlan, DeviceTestStep, DeviceAssertion } from "./device/DeviceTestPlan";
export { evaluateDeviceTestPlan } from "./device/DeviceTestAssertions";
export type { DeviceTestResult, AssertionResult } from "./device/DeviceTestAssertions";

export { generateDeviceTestSuite, buildFallbackSuite } from "./device/DeviceTestPlanner";
export type { DeviceTestSuite, DeviceTestCase, TestPlanModel } from "./device/DeviceTestPlanner";
export { DeviceEvidenceStore } from "./device/DeviceEvidenceStore";
export type { EvidenceRef } from "./device/DeviceEvidenceStore";
export { runDeviceTestSuite } from "./device/DeviceTestRunner";
export type { DeviceTestSuiteRun, DeviceTestRunnerOptions } from "./device/DeviceTestRunner";
export { renderDeviceTestReport } from "./device/DeviceTestReport";
export type { DeviceTestReport, DeviceCaseReport } from "./device/DeviceTestReport";

export { runSelfHealingDeviceSuite } from "../lib/self-healing-device-suite";
export type { SelfHealingDeviceSuiteOptions, SelfHealingDeviceSuiteResult, SelfHealingDeviceSuiteEvent } from "../lib/self-healing-device-suite";

export { runReleaseGate } from "../lib/release-gate";
export type { ReleaseGateOptions, ReleaseGateResult, ReleaseGateCheck } from "../lib/release-gate";
export { createReleaseArtifact } from "../lib/release-artifact-manager";
export type { ReleaseArtifactManagerOptions, ReleaseArtifactResult } from "../lib/release-artifact-manager";
export { publishReleaseChannel, rollbackReleaseChannel, getReleaseChannelState, RELEASE_CHANNELS } from "../lib/release-channel-manager";
export type { ReleaseChannel, ReleaseChannelEntry, ReleaseChannelState, PublishReleaseChannelOptions, PublishReleaseChannelResult, RollbackReleaseChannelOptions, RollbackReleaseChannelResult } from "../lib/release-channel-manager";
export { deployReleaseChannel, getDeploymentState } from "../lib/production-deployment-manager";
export type { ProductionDeploymentOptions, ProductionDeploymentResult, DeploymentHealth, DeploymentState } from "../lib/production-deployment-manager";
export { verifyFleetAuditChain, listSecureFleetAudit, createFleetRecoverySnapshot, restoreFleetRecoverySnapshot, exportFleetAuditBundle } from "../lib/fleet-audit-recovery";
export type { SecureAuditEntry, AuditFilter, AuditVerification, FleetRecoverySnapshot } from "../lib/fleet-audit-recovery";

export { LinuxRuntime } from "./linux/LinuxRuntime";
export type { LinuxRuntimeProfile, LinuxRuntimeStatus, LinuxExecResult } from "./linux/LinuxRuntime";
export { ProotContainerManager, createProotContainerManager } from "./container/ProotContainerManager";
export type { ProotContainerProfile, ProotContainerRecord, ContainerExecResult } from "./container/ProotContainerManager";
export { AIWorkspaceBuilder, createAIWorkspaceBuilder } from "./workspace/AIWorkspaceBuilder";
export type { WorkspaceBuildTemplate, WorkspaceBuildPlan, WorkspaceBuildResult, WorkspaceStep } from "./workspace/AIWorkspaceBuilder";
export { AIProjectGenerator, createAIProjectGenerator } from "./workspace/AIProjectGenerator";
export type { AIProjectRequest, AIProjectResult, GeneratedFile } from "./workspace/AIProjectGenerator";
export { AICodingAgent, createAICodingAgent } from "./workspace/AICodingAgent";
export type { AICodingAgentRequest, AICodingAgentResult, CodingPlan, CodingEdit, CodingPlannerContext, CodingPlanProvider, CodingIteration } from "./workspace/AICodingAgent";
export { LLMCodingBrain, createLLMCodingBrain, parseCodingPlan } from "./workspace/LLMCodingBrain";
export { runAgenticBuildLoop } from "./workspace/AgenticBuildLoop";
export type { AgenticBuildLoopRequest, AgenticBuildLoopResult, AgenticBuildLoopEvent } from "./workspace/AgenticBuildLoop";
export { PersistentAIWorkspace, createPersistentAIWorkspace } from "./workspace/PersistentAIWorkspace";
export type { PersistentWorkspaceOptions, PersistentWorkspaceSnapshot, PersistentWorkspaceStatus, WorkspaceGitEntry } from "./workspace/PersistentAIWorkspace";
export { AIProjectMemoryStore, createAIProjectMemory } from "./workspace/AIProjectMemory";
export type { AIProjectMemory, ProjectMemoryEntry } from "./workspace/AIProjectMemory";
export { OneClickAppFactory, createOneClickAppFactory } from "./workspace/OneClickAppFactory";
export type { OneClickAppFactoryRequest, OneClickAppFactoryResult, FactoryStage, FactoryStageResult } from "./workspace/OneClickAppFactory";
