import fs from 'node:fs';
import path from 'node:path';
const root = process.cwd();
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const src = read('lib/production-deployment-manager.ts');
for (const token of ['deployReleaseChannel','getDeploymentState','autoRollback','healthCheck','DEVICE_INSTALL_FAILED','AUTO_ROLLBACK_COMPLETED','DEPLOYMENT_HEALTHCHECK_FAILED','mv -f']) {
  if (!src.includes(token)) throw new Error(`missing:${token}`);
}
const bridge = read('core/device/DeviceAgentBridge.ts');
for (const token of ['install(apkPath','launch(packageName','uiHierarchy()','detectPackageName']) {
  if (!bridge.includes(token)) throw new Error(`bridge-missing:${token}`);
}
console.log('AIB_PHASE12_PRODUCTION_DEPLOYMENT_SELFTEST_OK');
