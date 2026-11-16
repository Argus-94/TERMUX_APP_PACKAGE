import fs from 'node:fs';
const files = ['core/device/DeviceAutomationAgent.ts','core/RuntimeFacade.ts','core/device/DeviceAgentTools.ts'];
for (const f of files) if (!fs.existsSync(f)) throw new Error(`MISSING_${f}`);
const s=fs.readFileSync('core/device/DeviceAutomationAgent.ts','utf8');
for (const x of ['DeviceAutomationAgent','parseDecision','MAX_STEPS_REACHED','SCREENSHOT_UNAVAILABLE']) if(!s.includes(x)) throw new Error(`MISSING_CONTRACT_${x}`);
console.log('AIB_DEVICE_AUTOMATION_SELFTEST_OK');
