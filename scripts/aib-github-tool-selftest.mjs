import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fail = (m) => { console.error(`AIB_GITHUB_TOOL_SELFTEST_FAIL: ${m}`); process.exit(1); };
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(root, p));

const expected = [
  'index.html','repos.html','files.html','releases.html','tokens.html',
  'css/common.css','css/files.css','css/releases.css','css/style.css','css/builder-theme.css',
  'js/app.js','js/common.js','js/files.js','js/highlight.js','js/icons.js','js/jszip.min.js','js/releases.js','js/repos.js','js/tokens.js'
];
for (const p of expected) if (!exists(`assets/github-tool/${p}`)) fail(`missing asset ${p}`);
for (const forbidden of ['AndroidManifest.xml','MainActivity.kt','res/menu/drawer_menu.xml','res/layout/activity_main.xml']) {
  if (exists(`assets/github-tool/${forbidden}`)) fail(`second-app artifact copied: ${forbidden}`);
}
const drawer = read('components/DrawerContent.tsx');
const layout = read('app/_layout.tsx');
const config = read('app.config.ts');
const plugin = read('plugins/withGithubTool.js');
const rel = read('assets/github-tool/js/releases.js');
if (!drawer.includes('name: "github"') || !drawer.includes('logo-github')) fail('drawer GitHub item missing');
if (!layout.includes('name="github"')) fail('GitHub route missing');
if (!config.includes('withGithubTool')) fail('native plugin not registered');
if (!plugin.includes('GithubToolActivity') || !plugin.includes('GithubToolPackage') || !plugin.includes('GithubToolHost')) fail('native GitHub Activity host missing');
if (!plugin.includes('fun pickFiles') || !plugin.includes('fun uploadAsset')) fail('pickFiles/uploadAsset missing');
const releasesJs = fs.readFileSync('assets/github-tool/js/releases.js','utf8');
if (!releasesJs.includes('N.pickFiles') || !releasesJs.includes('uploadAsset') || !releasesJs.includes('nativeUpload')) fail('releases.js native upload path missing');
for (const method of ['httpRequest','isOnline','openUrl','keepScreenOn','showToast','showError','shareText','saveFile','downloadAsset','cancelTransfer','getAppVersion','secretGet','secretSet']) if (!plugin.includes(`fun ${method}`)) fail(`bridge method missing: ${method}`);
if (!plugin.includes('isBase64') || !plugin.includes('wantBinary')) fail('httpRequest binary/base64 missing');
if (!plugin.includes('GithubToolActivity') || !plugin.includes('openHost')) fail('GithubToolActivity/openHost missing');
if (!plugin.includes('emptyList')) fail('ViewManagers must be empty for New Architecture');
if (!plugin.includes('withGithubActivity') && !plugin.includes('GithubToolActivity')) fail('activity registration missing');
if (!plugin.includes('instanceFollowRedirects = false')) fail('redirect SSRF guard missing');
if (!rel.includes('downloadAsset') || !rel.includes('__ugDownloadDone')) fail('release download wiring missing');
if (!rel.includes('cancelTransfer') && !rel.includes('cancelActiveUpload') && !plugin.includes('cancelTransfer')) fail('release upload cancel missing');
if (!rel.includes('N.pickFiles') && !read('assets/github-tool/releases.html').includes('id="ugFileInput"')) fail('release file picker missing');
if (!rel.includes('nativeUpload') && !rel.includes('XMLHttpRequest') && !plugin.includes('uploadAsset')) fail('release upload not integrated');
if (!plugin.includes('fun pickFiles') || !plugin.includes('fun uploadAsset')) fail('native pickFiles/uploadAsset missing');
if (!read('assets/github-tool/index.html').includes('builder-theme.css')) fail('Builder theme not attached');
console.log('AIB_GITHUB_TOOL_SELFTEST_OK');
