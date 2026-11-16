import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const logger = read('lib/persistent-logger.ts');
const redaction = read('lib/log-redaction.ts');
const screen = read('app/log-screen.tsx');
const hook = read('hooks/useLogger.ts');
const checkpoint = read('lib/checkpoints.ts');
const errors = [];

for (const token of [
  'redactSecrets', 'sanitizePersistedEntry', 'MAX_PERSISTED_CHARS', 'trimToStorageBudget',
  'sessionId', 'source', 'GlobalError', 'UnhandledRejection', 'fetchInstalled'
]) if (!logger.includes(token) && !redaction.includes(token)) errors.push(`LOGGER_FEATURE_MISSING:${token}`);
for (const token of ['SOURCE_OPTIONS', 'sourceFilter', 'logSourceTermux', 'logSourceLinux', 'item.source', 'item.sessionId']) {
  if (!screen.includes(token)) errors.push(`LOG_UI_FEATURE_MISSING:${token}`);
}
if (!/\[\$\{(?:l|entry)\.source \|\| "app"\}\] \[\$\{(?:l|entry)\.sessionId \|\| "unknown-session"\}\]/.test(hook)) errors.push('LOG_EXPORT_METADATA_MISSING');
for (const token of ['CHECKPOINT_CREATED', 'CHECKPOINT_DELETED']) if (!checkpoint.includes(token)) errors.push(`CHECKPOINT_LOG_MISSING:${token}`);

for (const token of [
  'authorization', 'bearer', 'api[_-]?key', 'apikey', 'password', 'secret',
  'https?:\\/\\/', 'x-api-key', 'x-goog-api-key', 'Credential-like CLI flags',
  'sk-(?:proj-|ant-|or-v1-)?', 'AIza', 'github_pat_', 'PRIVATE KEY', '[URL_REDACTED]',
  'sanitizePersistedEntry', 'AsyncStorage.removeItem("aibuilder.log.persistent.v1")'
]) if (!logger.toLowerCase().includes(token.toLowerCase()) && !redaction.toLowerCase().includes(token.toLowerCase())) errors.push(`REDACTION_PATTERN_MISSING:${token}`);

if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
if (!logger.includes('source?: \"app\" | \"termux\" | \"linux\"')) errors.push('LOGGER_LINUX_SOURCE_MISSING');
console.log('AIB_LOGGER_SELFTEST_OK');
