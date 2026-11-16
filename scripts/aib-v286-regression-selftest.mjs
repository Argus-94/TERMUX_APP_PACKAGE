import fs from 'node:fs';

const logger = fs.readFileSync('lib/persistent-logger.ts', 'utf8');
const redaction = fs.readFileSync('lib/log-redaction.ts', 'utf8');
const required = [
  'AKIA[REDACTED]',
  '[REDACTED_JWT]',
  'basic\\s+',
  'cookie|set-cookie',
  'npm_config_',
  'API[_-]?KEY',
];
for (const marker of required) {
  if (!logger.includes(marker) && !redaction.includes(marker)) throw new Error(`AIB_V286_REDACTION_RULE_MISSING:${marker}`);
}
if (!logger.includes('export function redactLogText')) throw new Error('AIB_V286_REDACT_EXPORT_MISSING');
// Guard against accidentally logging request bodies/headers through the fetch wrapper.
if (/JSON\.stringify\(init/i.test(logger)) {
  throw new Error('AIB_V286_FETCH_BODY_LOGGING_RISK');
}
console.log('AIB_V286_REGRESSION_SELFTEST_OK extended_redaction=enabled fetch_body_logging=absent');
