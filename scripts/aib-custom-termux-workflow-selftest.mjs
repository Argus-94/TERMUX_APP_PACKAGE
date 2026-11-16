#!/usr/bin/env node
import fs from 'node:fs';
const workflow = fs.readFileSync(new URL('../.github/workflows/custom-termux-bootstrap.yml', import.meta.url), 'utf8');
const build = fs.readFileSync(new URL('./aib-build-custom-termux-bootstrap.sh', import.meta.url), 'utf8');
const namespace = fs.readFileSync(new URL('./aib-configure-termux-namespace.sh', import.meta.url), 'utf8');
const required = [
  ['manual workflow dispatch', /workflow_dispatch:/],
  ['explicit upstream ref input', /termux_packages_ref:[\s\S]*?type: string[\s\S]*?default: master/],
  ['checkout honors selected upstream ref', /ref: \$\{\{ inputs\.termux_packages_ref \|\| 'master' \}\}/],
  ['exact upstream commit recorded', /git -C termux-packages rev-parse HEAD/],
  ['source revision artifact uploaded', /aib-termux-packages-source-revision/],
  ['upstream package checkout', /repository: termux\/termux-packages/],
  ['private app namespace', /com\.karat\.aibuilder/],
  ['current upstream package variable assigned to app ID', /TERMUX_APP__PACKAGE_NAME=\"com\.karat\.aibuilder\"/],
  ['deprecated alias synchronized to current variable', /TERMUX_APP_PACKAGE=\"\$TERMUX_APP__PACKAGE_NAME\"/],
  ['workflow invokes tested namespace configurator', /aib-configure-termux-namespace\.sh/],
  ['bootstrap builder invoked', /aib-build-custom-termux-bootstrap\.sh/],
  ['artifact upload', /actions\/upload-artifact@v4/],
  ['artifact verification', /aib-verify-custom-termux-bootstrap\.mjs/],
  ['runtime verification remains honest', /runtimeVerified.*apkIntegrated/s],
];
for (const [name, pattern] of required) {
  if (!pattern.test(workflow) && !pattern.test(build) && !pattern.test(namespace)) throw new Error(`Missing workflow contract: ${name}`);
}
console.log(`PASS: ${required.length} custom bootstrap CI workflow contracts`);
