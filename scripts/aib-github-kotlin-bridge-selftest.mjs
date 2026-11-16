import fs from 'node:fs';
import assert from 'node:assert/strict';

const p = 'plugins/withGithubTool.js';
const s = fs.readFileSync(p, 'utf8');

assert.match(s, /override fun onActivityResult\(activity: Activity, requestCode: Int, resultCode: Int, data: Intent\?\)/,
  'GithubTool native bridge must use the React Native ActivityEventListener signature');
assert.match(s, /override fun createNativeModules\(c: com\.facebook\.react\.bridge\.ReactApplicationContext\) = listOf\(GithubToolModule\(c\)\)/,
  'GithubToolPackage must pass ReactApplicationContext into GithubToolModule');
assert.doesNotMatch(s, /override fun onActivityResult\(activity: Activity\?,/,
  'nullable Activity signature is incompatible with the current React Native BaseActivityEventListener');
assert.doesNotMatch(s, /listOf\(GithubToolModule\(\)\)/,
  'GithubToolModule must not be constructed without ReactApplicationContext');

console.log('AIB_GITHUB_KOTLIN_BRIDGE_SELFTEST_OK signature=context');
