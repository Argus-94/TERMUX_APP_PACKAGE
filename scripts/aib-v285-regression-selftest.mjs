import fs from 'node:fs';

const persistence = fs.readFileSync('lib/persistence.ts', 'utf8');
if (!/persistAsyncStorageItem/.test(persistence)) throw new Error('AIB_V285_ASYNC_PERSIST_HELPER_MISSING');
if (!/persistSecureStoreItem/.test(persistence)) throw new Error('AIB_V285_SECURE_PERSIST_HELPER_MISSING');
if (!/AsyncStorage write failed/.test(persistence)) throw new Error('AIB_V285_ASYNC_PERSIST_FAILURE_NOT_OBSERVABLE');
if (!/SecureStore write failed/.test(persistence)) throw new Error('AIB_V285_SECURE_PERSIST_FAILURE_NOT_OBSERVABLE');
if (/setItem\([^\n]*\)\.catch\(\(\) *=>/.test(persistence)) throw new Error('AIB_V285_SILENT_ASYNC_CATCH_PRESENT');
if (/setItemAsync\([^\n]*\)\.catch\(\(\) *=>/.test(persistence)) throw new Error('AIB_V285_SILENT_SECURE_CATCH_PRESENT');

for (const file of [
  'components/TermuxContext.tsx',
  'components/LanguageContext.tsx',
  'hooks/useAppSettings.ts',
  'hooks/useLLM.ts',
  'lib/agent-intelligence.ts',
  'lib/persistent-logger.ts',
]) {
  const src = fs.readFileSync(file, 'utf8');
  if (/\.(setItem|setItemAsync)\([^\n]*\)\.catch\(\(\) *=>/.test(src)) {
    throw new Error(`AIB_V285_SILENT_PERSISTENCE_CATCH_PRESENT:${file}`);
  }
}

// Secret values must never be included in the persistence failure message.
if (/console\.warn\([^\n]*(value|token|secret|apiKey)/i.test(persistence)) {
  throw new Error('AIB_V285_PERSISTENCE_LOG_MAY_EXPOSE_SECRET');
}

console.log('AIB_V285_REGRESSION_SELFTEST_OK persistence_failures=observable secrets=not_logged');
