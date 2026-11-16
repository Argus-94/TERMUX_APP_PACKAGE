#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const file = path.join(root, 'lib/agent-tools/diagnostics-log.ts');
const source = fs.readFileSync(file, 'utf8');
if (!source.includes('from "../persistent-logger"')) {
  throw new Error('diagnostics-log must import lib/persistent-logger.ts from one directory up');
}
if (source.includes('from "../../persistent-logger"')) {
  throw new Error('stale diagnostics-log import ../../persistent-logger remains');
}
if (!fs.existsSync(path.join(root, 'lib/persistent-logger.ts'))) {
  throw new Error('lib/persistent-logger.ts missing');
}
console.log('AIB_DIAGNOSTICS_LOG_IMPORT_SELFTEST_OK relative_import=correct target=exists');
