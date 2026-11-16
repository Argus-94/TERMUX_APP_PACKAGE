#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const types = fs.readFileSync(path.join(root, 'lib/agent-tools/types.ts'), 'utf8');
const index = fs.readFileSync(path.join(root, 'lib/agent-tools/index.ts'), 'utf8');
const diag = fs.readFileSync(path.join(root, 'lib/agent-tools/diagnostics-log.ts'), 'utf8');
const agent = fs.readFileSync(path.join(root, 'lib/termux-agent.ts'), 'utf8');
const ctx = fs.readFileSync(path.join(root, 'lib/session-log-context.ts'), 'utf8');
const protocol = fs.readFileSync(path.join(root, 'lib/agent-engine.ts'), 'utf8');

const checks = [
  ['tool_registry', types.includes('"diagnostics.log"') && index.includes('"diagnostics.log":')],
  ['built_in_log_reader', diag.includes('persistentLogger.getAll()') && diag.includes('BUILT_IN_LOG_DIAGNOSTICS')],
  ['trace_filter', diag.includes('traceId=') && diag.includes('backend=')],
  ['failure_context', agent.includes('buildAgentDiagnosticLogContext(agentTrace.id)') && agent.includes('[SYSTEM_DIAGNOSTICS]')],
  ['tool_failure_context', agent.includes('[AIB_TOOL_ERROR]') && agent.includes('Read the built-in AI Builder Log below')],
  ['tool_nonzero_context', agent.includes('toolFailed') && agent.includes('AIB_TOOL returned exitCode=') && agent.includes('buildAgentDiagnosticLogContext(agentTrace.id)')],
  ['model_instruction', protocol.includes('diagnostics.log') && /do not blindly repeat/i.test(protocol)],
  ['same_log_source', ctx.includes('persistentLogger.getAll()') && ctx.includes('[AGENT_BUILT_IN_LOG]')],
  ['no_system_log_dependency', !agent.includes('adb logcat') && !diag.includes('adb logcat')],
];
const failed = checks.filter(([, ok]) => !ok);
if (failed.length) {
  console.error('AIB_AGENT_LOG_RECOVERY_SELFTEST_FAIL', failed.map(([n]) => n).join(','));
  process.exit(1);
}
console.log('AIB_AGENT_LOG_RECOVERY_SELFTEST_OK tool=diagnostics.log trace=propagated failure=auto_context same_builtin_log=1');
