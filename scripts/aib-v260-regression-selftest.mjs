import fs from 'node:fs';
import path from 'node:path';
const root = process.cwd();
const settings = fs.readFileSync(path.join(root, 'app/termux-settings.tsx'), 'utf8');
const all = fs.readFileSync(path.join(root, 'lib/termux-addon-installer.ts'), 'utf8') + settings;
if (/termux-app\/releases\/latest/i.test(all)) throw new Error('AIB_V260_MUTABLE_TERMUX_RELEASE_URL_PRESENT');
if (!/https:\/\/github\.com\/termux\/termux-app\/releases/.test(settings)) throw new Error('AIB_V260_TERMUX_RELEASES_PAGE_MISSING');
console.log('AIB_V260_REGRESSION_SELFTEST_OK mutable_latest_ui=blocked');
