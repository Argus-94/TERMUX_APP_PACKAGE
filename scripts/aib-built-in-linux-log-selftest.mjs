import fs from 'node:fs';
import path from 'node:path';
const root = process.cwd();
const read = p => fs.readFileSync(path.join(root,p), 'utf8');
const logger=read('lib/persistent-logger.ts');
const bridge=read('lib/termux-bridge.ts');
const screen=read('app/log-screen.tsx');
const i18n=read('lib/i18n.ts');
const errors=[];
for (const token of ['"linux"', 'source?: "app" | "termux" | "linux"']) if(!logger.includes(token)) errors.push('LOGGER_LINUX_SOURCE_MISSING:'+token);
for (const token of ['isLinux ? "linux" : "termux"', 'Linux:${ctx!.label}:${cmdId}:stream-summary', 'const backend = ctx?.backend ?? "termux"', 'Linux:${ctx!.label}:lifecycle', 'step: "native.heartbeat"', 'target: isLinux ? "ubuntu" : "termux"']) if(!bridge.includes(token)) errors.push('BRIDGE_LINUX_LOG_MISSING:'+token);
for (const token of ['"linux"', 'logSourceLinux']) if(!screen.includes(token)) errors.push('LOG_SCREEN_LINUX_FILTER_MISSING:'+token);
if(!i18n.includes('logSourceLinux: "Linux (Ubuntu/Debian)"')) errors.push('I18N_LINUX_SOURCE_MISSING');
if(errors.length){console.error(errors.join('\n'));process.exit(1);}
console.log('AIB_BUILT_IN_LINUX_LOG_SELFTEST_OK source=linux screen=Log trace=commandId');
