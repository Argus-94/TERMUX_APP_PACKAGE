import fs from 'node:fs';
import assert from 'node:assert/strict';

const src = fs.readFileSync('assets/github-tool/js/common.js', 'utf8');
const grab = (name) => {
  const m = src.match(new RegExp(`    function ${name}\\([\\s\\S]*?\\n    }\\n`));
  assert.ok(m, `${name} missing in common.js`);
  return m[0];
};
const { normalizeToken, tokenFormatError } = new Function(
  `${grab('normalizeToken')}\n${grab('tokenFormatError')}\nreturn { normalizeToken, tokenFormatError };`,
)();

const core = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
const pat = 'github_pat_' + 'A1b2C3d4E5f6G7h8I9j0_K1l2M3n4O5p6Q7r8S9t0';
for (const raw of [core, `  ${core}\n`, `\u200B${core}\uFEFF`, `Bearer ${core}`, `token ${core}`, `Authorization: Bearer ${core}`, `"${core}"`, `“${core}”`, `${core.slice(0, 10)} ${core.slice(10)}`, `${core}\u00A0`]) {
  assert.equal(normalizeToken(raw), core, JSON.stringify(raw));
  assert.equal(tokenFormatError(normalizeToken(raw)), '');
}
assert.equal(normalizeToken(pat), pat);
assert.equal(tokenFormatError(pat), '');
assert.equal(tokenFormatError('0123456789abcdef0123456789abcdef01234567'), '', 'legacy 40-hex classic token');
assert.match(tokenFormatError(''), /Введите/);
assert.match(tokenFormatError('ghp_short'), /короткий/);
assert.match(tokenFormatError('ghp_пароль1234567890123456'), /недопустим/);
assert.match(tokenFormatError('ssh-ed25519AAAAC3NzaC1lZDI1NTE5AAAAIabcdefgh'), /SSH/);

const repos = fs.readFileSync('assets/github-tool/js/repos.js', 'utf8');
assert.match(repos, /U\.normalizeToken\(\$\('cnToken'\)\.value\)/, 'connect() must normalize pasted token');
assert.ok(repos.indexOf('tokenFormatError') < repos.indexOf("U.gh('GET', '/user'"), 'format check precedes any network call');
const tsx = fs.readFileSync('app/github.tsx', 'utf8');
assert.match(tsx, /if \(result !== '1' && result !== '1:session'\)[\s\S]*?return false/s, 'failed secretSet must not activate the candidate in the WebView cache');
assert.match(tsx, /window\.__aibSecretCache\[k\] = value/, 'WebView cache activates a candidate only after verified secure or explicit session-mode success');
assert.doesNotMatch(tsx, /sessionStorage\.setItem\(['"](?:unzipgit_token|aib_sec_unzipgit_token)/, 'active GitHub credentials are not copied to WebView sessionStorage');
assert.doesNotMatch(tsx, /catch\(function\(e\) \{\s*try \{ sessionStorage\.removeItem\('aib_sec_' \+ k\); \}/, 'old unconditional session wipe is gone');
console.log('AIB_GITHUB_TOKEN_INPUT_SELFTEST_OK normalize=bearer,quotes,zero-width,whitespace rollback=secure-vault/RAM-cache');

// --- hedged GET: native bridge hang / error must not block token verification ---
const grabAsync = (name) => {
  const m = src.match(new RegExp(`    (?:async )?function ${name}\\([\\s\\S]*?\\n    }\\n`));
  assert.ok(m, `${name} missing`);
  return m[0];
};
const hedgeSrc = src.slice(src.indexOf('    var HEDGE_MS'), src.indexOf('    async function http('));
async function runHedge({ nativeImpl, directImpl }) {
  const factory = new Function('nativeCall', 'directFetch', 'trace', `${hedgeSrc}\nHEDGE_MS = 30;\nreturn hedgedGet;`);
  return factory(nativeImpl, directImpl, () => {})('GET', 'https://api.github.com/user', {}, undefined, 1000);
}
const okRes = { ok: true, status: 200, text: '{"login":"x"}' };
// 1. native never answers -> direct wins
assert.equal((await runHedge({ nativeImpl: () => new Promise(() => {}), directImpl: async () => okRes })).status, 200);
// 2. native throws -> direct runs immediately
assert.equal((await runHedge({ nativeImpl: async () => { throw new Error('bridge timeout'); }, directImpl: async () => okRes })).status, 200);
// 3. native answers 401 quickly -> that is final, direct result ignored
assert.equal((await runHedge({ nativeImpl: async () => ({ ok: false, status: 401, text: '{}' }), directImpl: () => new Promise(() => {}) })).status, 401);
// 4. both fail -> native error surfaces
await assert.rejects(runHedge({ nativeImpl: async () => { throw new Error('native-fail'); }, directImpl: async () => { throw new Error('direct-fail'); } }), /native-fail/);
const common = src;
assert.match(common, /preferNative && \/\^\(GET\|HEAD\)\$\/i\.test\(method\)\) return hedgedGet/, 'http() hedges idempotent GET');

// --- diagnostics: stage trace must never carry token text and must reach the app log ---
assert.match(src, /function trace\(s\)/);
assert.match(src, /gh\[pousr\]_\|github_pat_/, 'trace masks token-shaped strings');
const tsx2 = fs.readFileSync('app/github.tsx', 'utf8');
assert.match(tsx2, /window\.__aibLog/);
assert.match(tsx2, /persistentLogger\.add\("info", "GithubTool"/);
assert.match(fs.readFileSync('lib/github-tool-bridge-host.ts', 'utf8'), /msg\.type === "log"/);
assert.match(fs.readFileSync('assets/github-tool/js/repos.js', 'utf8'), /Диагностика:/);
console.log('AIB_GITHUB_HEDGED_GET_OK');

// --- security helper must not depend on the runtime's URL implementation (RN/Hermes has partial URL) ---
const secSrc = fs.readFileSync('lib/github-tool-security.ts', 'utf8');
assert.doesNotMatch(secSrc, /new URL\(/, 'security helper must not use new URL()');
assert.doesNotMatch(fs.readFileSync('lib/github-tool-bridge-host.ts', 'utf8'), /new URL\(/, 'bridge host must not use new URL()');
console.log('AIB_GITHUB_NO_URL_DEPENDENCY_OK');

// --- Android WebView forwards the current top-level URL; trust requires exact agreement with the tracked page ---
const tsx3 = fs.readFileSync('app/github.tsx', 'utf8');
assert.match(tsx3, /docUrlRef/, 'tracks last trusted document url as a consistency gate');
assert.match(tsx3, /createGithubToolOnMessage\(\(\) => docUrlRef\.current/, 'production callback checks event URL against the tracked document');
const host = fs.readFileSync('lib/github-tool-bridge-host.ts', 'utf8');
assert.match(host, /const eventMatchesTrackedDocument = trustedTrackedUrl && trustedEventUrl && eventUrl === trackedUrl/, 'the full event document URL must match the last allowlisted navigation exactly');
assert.match(host, /const senderUrl = eventMatchesTrackedDocument \? eventUrl : ""/, 'missing, local-alias, stale and foreign URLs are never replaced with a trusted fallback');
assert.doesNotMatch(host, /trusted-local-fallback|trusted-fallback|localFileEventUrl|useTrackedUrl/, 'the previously attempted v271 URL fallback is not repeated');
assert.match(tsx3, /if \(trusted\) docUrlRef\.current = request\.url/, 'only trusted navigations update the tracked url');
assert.match(tsx3, /onNavigationStateChange/, 'navigation state keeps tracked url in sync');
// The native WebMessageListener patch supplies a main-frame URL; the host still independently checks it.
const sec = fs.readFileSync('lib/github-tool-security.ts', 'utf8');
assert.match(sec, /isTrustedGithubToolDocumentUrl\(documentUrl\)/);
console.log('AIB_GITHUB_ANDROID_WEBVIEW_DOCUMENT_URL_STRICT_OK');
