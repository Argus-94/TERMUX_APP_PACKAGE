// AI Builder

document.addEventListener('DOMContentLoaded', () => {
    const U = window.UG;
    const usernameInput = document.getElementById('username');
    const repoInput = document.getElementById('repo');
    const tokenInput = document.getElementById('token');
    const branchInput = document.getElementById('branch');
    const archivePathInput = document.getElementById('archivePath');
    const fileInput = document.getElementById('fileInput');
    const filePickBtn = document.getElementById('filePickBtn');
    const fileNameLabel = document.getElementById('fileNameLabel');
    const fileInfo = document.getElementById('fileInfo');
    const unzipBtn = document.getElementById('unzipBtn');
    const clearBtn = document.getElementById('clearBtn');
    const retryBtn = document.getElementById('retryBtn');
    const openRepoBtn = document.getElementById('openRepoBtn');
    const exportLogBtn = document.getElementById('exportLogBtn');
    const forgetTokenBtn = document.getElementById('forgetTokenBtn');
    const toggleTokenBtn = document.getElementById('toggleTokenBtn');
    const dryRunCheck = document.getElementById('dryRunCheck');
    const singleCommitCheck = document.getElementById('singleCommitCheck');
    const progress = document.getElementById('progress');
    const progressBar = progress.querySelector('.progress-bar');
    const statsEl = document.getElementById('stats');
    const logEl = document.getElementById('log');
    const phaseEl = document.getElementById('phase');
    const etaEl = document.getElementById('eta');
    const repoHistoryChips = document.getElementById('repoHistoryChips');
    const repoHistoryList = document.getElementById('repoHistoryList');
    const onboarding = document.getElementById('onboarding');
    const onboardingOk = document.getElementById('onboardingOk');

    let isRunning = false;
    let runId = 0;
    let abortController = null;
    let lastRun = null;
    let lastRepoUrl = null;
    let logLines = [];

    const STORE_KEYS = { username: usernameInput, repo: repoInput, branch: branchInput, token: tokenInput };
    const HISTORY_KEY = 'unzipgit_repo_history';
    const ONBOARD_KEY = 'unzipgit_onboarded_v1';
    const MAX_HISTORY = 5;
    const WARN_ZIP_MB = 25;
    const WARN_FILE_COUNT = 200;
    const MAX_FILE_BYTES = 100 * 1024 * 1024;

    function notifyError(message) {
        try {
            if (window.AndroidInterface && typeof window.AndroidInterface.showError === 'function') {
                window.AndroidInterface.showError(message);
            }
        } catch (e) { /* ignore */ }
    }

    function log(msg, type = 'info') {
        const timestamp = new Date().toLocaleTimeString('ru-RU');
        let color = '#9AA3AC';
        if (type === 'error') color = '#FFB4AB';
        if (type === 'success') color = '#8FD69A';
        if (type === 'warn') color = 'var(--gold)';
        const line = document.createElement('div');
        line.style.color = color;
        const text = '[' + timestamp + '] ' + msg;
        line.textContent = text;
        logEl.appendChild(line);
        logEl.scrollTop = logEl.scrollHeight;
        logLines.push(text);
        if (logLines.length > 2000) logLines.shift();
    }

    function clearLog() { logEl.innerHTML = ''; logLines = []; }

    function setPhase(text) {
        if (!text) { phaseEl.classList.add('hidden'); phaseEl.textContent = ''; return; }
        phaseEl.classList.remove('hidden');
        phaseEl.textContent = text;
    }

    function setProgress(percent) {
        progress.classList.remove('hidden');
        progressBar.style.width = Math.min(100, Math.max(0, percent)) + '%';
    }

    function hideProgress() {
        progress.classList.add('hidden');
        progressBar.style.width = '0%';
        etaEl.classList.add('hidden');
        setPhase('');
    }

    function setEta(done, total, startedAt) {
        if (!total || done <= 0) { etaEl.classList.add('hidden'); return; }
        const elapsed = (Date.now() - startedAt) / 1000;
        const left = Math.max(0, Math.ceil((elapsed / done) * (total - done)));
        etaEl.classList.remove('hidden');
        const m = Math.floor(left / 60), s = left % 60;
        etaEl.textContent = left < 5
            ? ('Осталось меньше 5 сек · ' + done + '/' + total)
            : ('Осталось ~' + (m > 0 ? m + ' мин ' : '') + s + ' сек · ' + done + '/' + total);
    }

    function showStats(success, errors, total) {
        statsEl.classList.remove('hidden');
        statsEl.textContent = 'Успешно: ' + success + ' | Ошибок: ' + errors + ' | Всего: ' + total;
        statsEl.style.color = errors === 0 ? '#8FD69A' : (success > 0 ? 'var(--gold)' : '#FFB4AB');
    }

    function loadSaved() {
        try {
            Object.keys(STORE_KEYS).forEach(k => {
                const v = k === 'token' ? U.token() : localStorage.getItem('unzipgit_' + k);
                if (v) STORE_KEYS[k].value = v;
            });
        } catch (e) {}
    }
    window.addEventListener('aib-secrets-ready', () => {
        if (!tokenInput.value.trim()) {
            try {
                tokenInput.value = U.token();
                if (tokenInput.value) forgetTokenBtn.classList.remove('hidden');
            } catch (e) {}
        }
    });
    async function saveInputs() {
        try {
            for (const k of Object.keys(STORE_KEYS)) {
                const v = k === 'token' && U.normalizeToken ? U.normalizeToken(STORE_KEYS[k].value) : STORE_KEYS[k].value.trim();
                if (k === 'token') {
                    // An empty optional field must not erase the previously active credential;
                    // explicit removal is handled by the dedicated Forget Token action.
                    if (!v) continue;
                    const saved = U.ls('unzipgit_token', v);
                    const ok = saved && typeof saved.then === 'function' ? await saved : saved === true;
                    if (!ok) return false;
                } else localStorage.setItem('unzipgit_' + k, v);
            }
            return true;
        } catch (e) { return false; }
    }
    function getHistory() {
        try {
            const arr = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
            return Array.isArray(arr) ? arr.slice(0, MAX_HISTORY) : [];
        } catch (e) { return []; }
    }
    function saveHistoryEntry(owner, repo) {
        try {
            const key = owner + '/' + repo;
            let list = getHistory().filter(x => x !== key);
            list.unshift(key);
            localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, MAX_HISTORY)));
            renderHistory();
        } catch (e) {}
    }
    function renderHistory() {
        const list = getHistory();
        repoHistoryList.innerHTML = '';
        list.forEach(item => {
            const opt = document.createElement('option');
            opt.value = item;
            repoHistoryList.appendChild(opt);
        });
        if (!list.length) { repoHistoryChips.classList.add('hidden'); repoHistoryChips.innerHTML = ''; return; }
        repoHistoryChips.classList.remove('hidden');
        repoHistoryChips.innerHTML = '';
        list.forEach(item => {
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = 'chip';
            chip.textContent = item;
            chip.addEventListener('click', () => {
                const parts = item.split('/');
                usernameInput.value = parts[0] || '';
                repoInput.value = parts.slice(1).join('/') || '';
            });
            repoHistoryChips.appendChild(chip);
        });
    }
    function keepAwake(on) {
        try {
            if (window.AndroidInterface && typeof window.AndroidInterface.keepScreenOn === 'function') {
                window.AndroidInterface.keepScreenOn(on);
            }
        } catch (e) {}
    }
    function openExternal(url) {
        try {
            if (window.AndroidInterface && typeof window.AndroidInterface.openUrl === 'function') {
                window.AndroidInterface.openUrl(url);
                return;
            }
        } catch (e) {}
        window.open(url, '_blank');
    }

    loadSaved();
    renderHistory();
    if (tokenInput.value) forgetTokenBtn.classList.remove('hidden');
    try {
        if (!localStorage.getItem(ONBOARD_KEY)) onboarding.classList.remove('hidden');
    } catch (e) {}

    onboardingOk.addEventListener('click', () => {
        onboarding.classList.add('hidden');
        try { localStorage.setItem(ONBOARD_KEY, '1'); } catch (e) {}
    });
    toggleTokenBtn.addEventListener('click', () => {
        const show = tokenInput.type === 'password';
        tokenInput.type = show ? 'text' : 'password';
        toggleTokenBtn.textContent = show ? '🙈' : '👁';
        toggleTokenBtn.title = show ? 'Скрыть токен' : 'Показать токен';
    });

    function validateInputs() {
        const username = usernameInput.value.trim();
        const repo = repoInput.value.trim();
        const token = tokenInput.value.trim();
        if (!username) return 'Введите имя пользователя GitHub';
        if (!repo) return 'Введите название репозитория';
        if (!token) return 'Введите токен доступа';
        if (!/^gh[pousr]_[a-zA-Z0-9]{36,}$/.test(token) && !/^github_pat_[a-zA-Z0-9_]+$/.test(token)) {
            return 'Токен имеет неверный формат. Ожидается ghp_..., gho_... или github_pat_...';
        }
        if (!/^[a-zA-Z0-9_.-]+$/.test(username)) return 'Имя пользователя содержит недопустимые символы';
        const repoName = repo.split('/')[0];
        if (!repoName || !/^[a-zA-Z0-9_.-]+$/.test(repoName)) return 'Название репозитория содержит недопустимые символы';
        return null;
    }

    function encodePath(path) { return path.split('/').map(encodeURIComponent).join('/'); }
    function apiBase(owner, repo) {
        return 'https://api.github.com/repos/' + encodeURIComponent(owner) + '/' + encodeURIComponent(repo);
    }
    function authHeaders(token, extra) {
        return Object.assign({
            'Authorization': 'token ' + token,
            'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28'
        }, extra || {});
    }
    function sanitizePath(path) {
        return path.replace(/\\/g, '/').split('/').filter(p => p && p !== '.' && p !== '..').join('/');
    }
    function parseGitHubUrl(str) {
        if (!str || typeof str !== 'string') return null;
        let s = str.trim();
        if (/^(?:www\.)?github\.com\//i.test(s) || /^raw\.githubusercontent\.com\//i.test(s)) {
            s = 'https://' + s.replace(/^https?:\/\//i, '');
        }
        let m = s.match(/^https?:\/\/raw\.githubusercontent\.com\/([^/\s]+)\/([^/\s]+)\/([^/\s]+)\/(.+)$/i);
        if (m) return { owner: m[1], repo: m[2], branch: m[3], path: sanitizePath(m[4].split('?')[0]) };
        m = s.match(/^https?:\/\/(?:www\.)?github\.com\/([^/\s]+)\/([^/\s]+)\/(?:blob|raw|tree)\/([^/\s]+)\/(.+)$/i);
        if (m) return { owner: m[1], repo: m[2], branch: m[3], path: sanitizePath(m[4].split('?')[0]) };
        m = s.match(/^https?:\/\/(?:www\.)?github\.com\/([^/\s]+)\/([^/\s]+)\/?$/i);
        if (m) return { owner: m[1], repo: m[2], branch: null, path: null };
        return null;
    }
    function normalizeBranch(branch) {
        if (!branch) return '';
        const b = branch.trim();
        if (/^https?:\/\//i.test(b) || b.includes('github.com') || b.startsWith('/') || (b.includes('/') && !/^[a-zA-Z0-9._\/-]+$/.test(b))) {
            const parsed = parseGitHubUrl(b);
            if (parsed && parsed.branch) return parsed.branch;
            return '';
        }
        if (!/^[a-zA-Z0-9._\/-]+$/.test(b)) return '';
        return b;
    }
    function normalizeArchivePath(path) {
        if (!path) return '';
        const parsed = parseGitHubUrl(path);
        if (parsed) return parsed.path || '';
        let p = path.trim().replace(/^\/+/, '');
        if (/^(?:www\.)?github\.com\//i.test(p) || /^raw\.githubusercontent\.com\//i.test(p)) return '';
        if (/^(blob|raw|tree)\//i.test(p)) {
            const parts = p.split('/');
            if (parts.length >= 3) p = parts.slice(2).join('/');
        }
        return sanitizePath(p);
    }
    function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
    function aborted(myRun) {
        return !isRunning || myRun !== runId || (abortController && abortController.signal.aborted);
    }

    async function parseApiError(res) {
        let msg = res.status + ' ' + res.statusText;
        try {
            const j = await res.clone().json();
            if (j.message) msg = j.message;
            if (j.errors && j.errors.length) msg += ' · ' + j.errors.map(e => e.message || JSON.stringify(e)).join('; ');
            if (j.documentation_url) msg += ' (' + j.documentation_url + ')';
        } catch (e) {}
        return msg;
    }

    function hasNativeHttp() {
        try {
            if (window.__aibHttp) return true;
            return !!(window.AndroidInterface && typeof window.AndroidInterface.httpRequest === 'function');
        } catch (e) { return false; }
    }

    /** Нативный HTTP через Android (обход CORS file:// / WebView). */
    async function nativeHttp(url, options) {
        options = options || {};
        const method = (options.method || 'GET').toUpperCase();
        const headers = options.headers || {};
        const body = options.body != null ? String(options.body) : null;
        const binary = !!options.binary;
        const payload = JSON.stringify({
            url: url,
            method: method,
            headers: headers,
            body: body,
            binary: binary
        });
        let raw;
        try {
            if (window.__aibHttp) raw = await window.__aibHttp(payload);
            else raw = window.AndroidInterface.httpRequest(payload);
        } catch (e) {
            throw new Error('Сетевой мост Android: ' + (e.message || e));
        }
        let data;
        try { data = JSON.parse(raw); }
        catch (e) { throw new Error('Некорректный ответ сетевого моста'); }
        if (data.error && (!data.status || data.status === 0)) {
            throw new Error('Сеть: ' + data.error);
        }
        if ((!data.status || data.status === 0) && !data.ok) {
            throw new Error('Нет сети или сервер недоступен' + (data.statusText ? (': ' + data.statusText) : ''));
        }
        const headerMap = data.headers || {};
        const res = {
            ok: !!data.ok,
            status: data.status || 0,
            statusText: data.statusText || '',
            headers: {
                get: function (name) {
                    const key = Object.keys(headerMap).find(k => k.toLowerCase() === String(name).toLowerCase());
                    return key ? headerMap[key] : null;
                }
            },
            _body: data.body || '',
            _isBase64: !!data.isBase64,
            clone: function () { return res; },
            json: async function () {
                if (res._isBase64) throw new Error('binary response');
                return JSON.parse(res._body || '{}');
            },
            text: async function () {
                if (res._isBase64) throw new Error('binary response');
                return res._body || '';
            },
            blob: async function () {
                if (res._isBase64) {
                    const bin = atob(res._body);
                    const bytes = new Uint8Array(bin.length);
                    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
                    return new Blob([bytes]);
                }
                return new Blob([res._body || '']);
            }
        };
        return res;
    }

    async function doFetch(url, opts) {
        const options = opts || {};
        // На Android всегда предпочитаем нативный HTTP — стабильнее, без CORS
        if (hasNativeHttp()) {
            const headers = {};
            if (options.headers) {
                if (options.headers.forEach) {
                    options.headers.forEach(function (v, k) { headers[k] = v; });
                } else {
                    Object.keys(options.headers).forEach(function (k) { headers[k] = options.headers[k]; });
                }
            }
            const accept = headers['Accept'] || headers['accept'] || '';
            const binary = !!options.binary || /raw|octet-stream|zip|application\/vnd\.github\.raw/i.test(accept);
            return await nativeHttp(url, {
                method: options.method || 'GET',
                headers: headers,
                body: options.body,
                binary: binary
            });
        }
        try {
            return await fetch(url, options);
        } catch (err) {
            if (err.name === 'AbortError') throw err;
            const msg = (err && err.message) ? err.message : String(err);
            if (/Failed to fetch|NetworkError|Load failed|Network request failed/i.test(msg)) {
                throw new Error(
                    'Нет сети или WebView блокирует запрос (CORS). ' +
                    'Проверьте интернет. Если ошибка повторяется — переустановите приложение (нужен нативный сетевой мост).'
                );
            }
            throw err;
        }
    }

    async function fetchWithRetry(url, options, retries) {
        retries = retries || 5;
        const opts = Object.assign({}, options || {});
        if (abortController && !hasNativeHttp()) opts.signal = abortController.signal;
        for (let i = 0; i < retries; i++) {
            const last = i === retries - 1;
            let res;
            try {
                if (abortController && abortController.signal.aborted) {
                    throw new Error('Операция отменена');
                }
                res = await doFetch(url, opts);
            } catch (err) {
                if (err.name === 'AbortError') throw new Error('Операция отменена');
                if (/отменена/i.test(err.message || '')) throw err;
                if (last) throw err;
                await sleep(1000 * (i + 1));
                continue;
            }
            if (last) return res;
            if (res.status === 403 || res.status === 429) {
                const retryAfter = res.headers.get('Retry-After');
                const remaining = res.headers.get('X-RateLimit-Remaining');
                const resetTime = res.headers.get('X-RateLimit-Reset');
                let waitMs = 0;
                if (retryAfter) waitMs = Math.max(1000, parseInt(retryAfter, 10) * 1000);
                else if (remaining === '0' && resetTime) waitMs = Math.max(1000, parseInt(resetTime, 10) * 1000 - Date.now());
                else {
                    const errData = await res.clone().json().catch(() => ({}));
                    if (res.status === 429 || /rate limit|abuse|secondary/i.test(errData.message || '')) waitMs = 30000;
                }
                if (waitMs > 0) {
                    log('Лимит API, ожидание ' + Math.ceil(Math.min(waitMs, 120000) / 1000) + ' сек...', 'warn');
                    await sleep(Math.min(waitMs, 120000));
                    continue;
                }
            }
            if (res.status === 502 || res.status === 503 || res.status === 504) {
                await sleep(1000 * (i + 1));
                continue;
            }
            return res;
        }
        throw new Error('Превышено количество попыток');
    }

    async function validateToken(token) {
        const res = await fetchWithRetry('https://api.github.com/user', { headers: authHeaders(token) });
        if (res.status === 401) throw new Error('Неверный токен или нет доступа (401)');
        if (!res.ok) throw new Error('Не удалось проверить токен: ' + await parseApiError(res));
        const user = await res.json();
        return { login: user.login, scopes: res.headers.get('X-OAuth-Scopes') || '' };
    }

    async function getFileContent(owner, repo, token, path, branch) {
        const cleanPath = sanitizePath(path);
        if (!cleanPath) throw new Error('Некорректный путь к архиву');
        const ref = branch || '';
        let metaUrl = apiBase(owner, repo) + '/contents/' + encodePath(cleanPath);
        if (ref) metaUrl += '?ref=' + encodeURIComponent(ref);
        const metaRes = await fetchWithRetry(metaUrl, { headers: authHeaders(token) });
        if (metaRes.status === 404) throw new Error('Архив не найден в репозитории: ' + cleanPath + (ref ? ' (ветка: ' + ref + ')' : '') + '. Укажите относительный путь, не URL.');
        if (metaRes.status === 401) throw new Error('Неверный токен или нет доступа (401)');
        if (metaRes.ok) {
            const meta = await metaRes.json();
            if (Array.isArray(meta)) throw new Error(cleanPath + ' — это папка, а не файл.');
            if (meta && meta.download_url) {
                const dl = await fetchWithRetry(meta.download_url, {
                    // GitHub's download_url points to raw/CDN-style hosts: never forward a PAT.
                    // If that URL is not accessible for a private repository, the authenticated
                    // API contents endpoint below returns the file bytes instead.
                    headers: { 'Accept': 'application/octet-stream' },
                    binary: true
                });
                if (dl.ok) return await dl.blob();
            }
            const rawRes = await fetchWithRetry(metaUrl, {
                headers: authHeaders(token, { 'Accept': 'application/vnd.github.raw+json' }),
                binary: true
            });
            if (rawRes.ok) return await rawRes.blob();
            throw new Error('Не удалось скачать файл ' + cleanPath);
        }
        throw new Error('Ошибка загрузки файла: ' + await parseApiError(metaRes));
    }

    async function getRepoInfo(owner, repo, token) {
        const res = await fetchWithRetry(apiBase(owner, repo), { headers: authHeaders(token) });
        if (res.status === 401) throw new Error('Неверный токен или нет доступа (401)');
        if (res.status === 404) throw new Error('Репозиторий не найден или нет доступа к нему');
        if (!res.ok) throw new Error('Ошибка получения репозитория: ' + await parseApiError(res));
        return await res.json();
    }

    async function checkBranch(owner, repo, token, branch) {
        const res = await fetchWithRetry(apiBase(owner, repo) + '/branches/' + encodeURIComponent(branch), { headers: authHeaders(token) });
        if (res.status === 404) throw new Error('Ветка «' + branch + '» не найдена в репозитории');
        if (!res.ok) throw new Error('Ошибка проверки ветки: ' + await parseApiError(res));
    }

    async function getCurrentSha(owner, repo, token, path, branch) {
        const ref = encodeURIComponent(branch || 'main');
        const res = await fetchWithRetry(apiBase(owner, repo) + '/contents/' + encodePath(path) + '?ref=' + ref, { headers: authHeaders(token) });
        if (res.status === 404) return null;
        if (!res.ok) throw new Error('Не удалось получить SHA: ' + await parseApiError(res));
        const data = await res.json();
        if (Array.isArray(data)) throw new Error(path + ' — это папка');
        return data.sha || null;
    }

    async function createOrUpdateFile(owner, repo, token, path, contentBase64, message, sha, branch) {
        const url = apiBase(owner, repo) + '/contents/' + encodePath(path);
        let currentSha = sha;
        for (let attempt = 0; attempt < 3; attempt++) {
            const body = { message: message, content: contentBase64, branch: branch || 'main' };
            if (currentSha) body.sha = currentSha;
            const res = await fetchWithRetry(url, {
                method: 'PUT',
                headers: authHeaders(token, { 'Content-Type': 'application/json' }),
                body: JSON.stringify(body)
            });
            if (res.ok) return await res.json();
            const errText = await parseApiError(res);
            if ((res.status === 409 || (res.status === 422 && /sha/i.test(errText))) && attempt < 2) {
                await sleep(1000 * (attempt + 1));
                currentSha = await getCurrentSha(owner, repo, token, path, branch);
                continue;
            }
            throw new Error('Ошибка записи ' + path + ': ' + errText);
        }
        throw new Error('Ошибка записи ' + path);
    }

    async function adaptiveDelay(res, baseMs) {
        const remaining = res && res.headers ? res.headers.get('X-RateLimit-Remaining') : null;
        if (remaining != null) {
            const n = parseInt(remaining, 10);
            if (!isNaN(n) && n < 50) return sleep(Math.max(baseMs, 2000));
            if (!isNaN(n) && n < 100) return sleep(Math.max(baseMs, 1200));
        }
        return sleep(baseMs);
    }

    async function getBranchHeadSha(owner, repo, token, branch) {
        const res = await fetchWithRetry(apiBase(owner, repo) + '/git/ref/heads/' + encodeURIComponent(branch), { headers: authHeaders(token) });
        if (res.status === 404) return null;
        if (!res.ok) throw new Error('HEAD ветки: ' + await parseApiError(res));
        const data = await res.json();
        return data.object && data.object.sha ? data.object.sha : null;
    }
    async function createBlob(owner, repo, token, contentBase64) {
        const res = await fetchWithRetry(apiBase(owner, repo) + '/git/blobs', {
            method: 'POST', headers: authHeaders(token, { 'Content-Type': 'application/json' }),
            body: JSON.stringify({ content: contentBase64, encoding: 'base64' })
        });
        if (!res.ok) throw new Error('blob: ' + await parseApiError(res));
        return { sha: (await res.json()).sha, res: res };
    }
    async function createTree(owner, repo, token, treeItems, baseTreeSha) {
        const body = { tree: treeItems };
        if (baseTreeSha) body.base_tree = baseTreeSha;
        const res = await fetchWithRetry(apiBase(owner, repo) + '/git/trees', {
            method: 'POST', headers: authHeaders(token, { 'Content-Type': 'application/json' }),
            body: JSON.stringify(body)
        });
        if (!res.ok) throw new Error('tree: ' + await parseApiError(res));
        return (await res.json()).sha;
    }
    async function createCommit(owner, repo, token, message, treeSha, parentSha) {
        const body = { message: message, tree: treeSha };
        if (parentSha) body.parents = [parentSha];
        const res = await fetchWithRetry(apiBase(owner, repo) + '/git/commits', {
            method: 'POST', headers: authHeaders(token, { 'Content-Type': 'application/json' }),
            body: JSON.stringify(body)
        });
        if (!res.ok) throw new Error('commit: ' + await parseApiError(res));
        return (await res.json()).sha;
    }
    async function updateRef(owner, repo, token, branch, commitSha, isNew) {
        if (isNew) {
            const res = await fetchWithRetry(apiBase(owner, repo) + '/git/refs', {
                method: 'POST', headers: authHeaders(token, { 'Content-Type': 'application/json' }),
                body: JSON.stringify({ ref: 'refs/heads/' + branch, sha: commitSha })
            });
            if (!res.ok) throw new Error('ref create: ' + await parseApiError(res));
            return;
        }
        const res = await fetchWithRetry(apiBase(owner, repo) + '/git/refs/heads/' + encodeURIComponent(branch), {
            method: 'PATCH', headers: authHeaders(token, { 'Content-Type': 'application/json' }),
            body: JSON.stringify({ sha: commitSha, force: false })
        });
        if (!res.ok) throw new Error('ref update: ' + await parseApiError(res));
    }
    async function getCommitTreeSha(owner, repo, token, commitSha) {
        const res = await fetchWithRetry(apiBase(owner, repo) + '/git/commits/' + commitSha, { headers: authHeaders(token) });
        if (!res.ok) return null;
        const data = await res.json();
        return data.tree && data.tree.sha ? data.tree.sha : null;
    }

    async function uploadViaTreeApi(ctx, names, myRun) {
        const { zip, owner, repo, token, targetFolder, targetBranch } = ctx;
        const total = names.length;
        const failed = [];
        let successCount = 0;
        const startedAt = Date.now();
        setPhase('Создание blob-объектов…');
        const headSha = await getBranchHeadSha(owner, repo, token, targetBranch);
        if (aborted(myRun)) return { successCount: 0, failed: names.slice() };
        const isNewBranch = !headSha;
        if (isNewBranch) log('Ветка будет создана первым коммитом', 'warn');
        const baseTreeSha = headSha ? await getCommitTreeSha(owner, repo, token, headSha) : null;
        // Без base_tree GitHub создал бы дерево ТОЛЬКО из файлов архива и стёр бы остальное содержимое репозитория
        if (headSha && !baseTreeSha) throw new Error('не удалось получить дерево текущего коммита');
        const treeItems = [];
        for (let i = 0; i < total; i++) {
            if (aborted(myRun)) {
                names.slice(i).forEach(n => failed.push(n));
                log('Операция отменена пользователем', 'warn');
                break;
            }
            const fileName = names[i];
            const fileObj = zip.file(fileName);
            if (!fileObj) continue;
            const safeName = sanitizePath(fileName);
            if (!safeName) continue;
            const destPath = targetFolder ? (targetFolder + '/' + safeName) : safeName;
            setProgress(Math.round((i / total) * 85));
            setEta(i, total, startedAt);
            log('[' + (i + 1) + '/' + total + '] blob ' + destPath);
            try {
                const fileData = await fileObj.async('base64');
                if (Math.floor(fileData.length * 0.75) > MAX_FILE_BYTES) throw new Error('файл больше 100 МБ');
                const created = await createBlob(owner, repo, token, fileData);
                treeItems.push({ path: destPath, mode: '100644', type: 'blob', sha: created.sha });
                successCount++;
                await adaptiveDelay(created.res, 200);
            } catch (err) {
                failed.push(fileName);
                log('ОШИБКА blob: ' + destPath + ' — ' + err.message, 'error');
            }
        }
        if (!treeItems.length) return { successCount: 0, failed: failed };
        if (aborted(myRun)) return { successCount: successCount, failed: failed };
        setPhase('Создание tree и commit…');
        setProgress(90);
        try {
            const treeSha = await createTree(owner, repo, token, treeItems, baseTreeSha);
            const commitSha = await createCommit(owner, repo, token, 'AI Builder: файлов ' + treeItems.length, treeSha, headSha);
            await updateRef(owner, repo, token, targetBranch, commitSha, isNewBranch);
            setProgress(100);
            log('Один коммит ' + commitSha.slice(0, 7) + ' · файлов: ' + treeItems.length, 'success');
        } catch (err) {
            log('Ошибка Git Tree API: ' + err.message + '. Снимите «Один коммит» или повторите.', 'error');
            return { successCount: 0, failed: names.slice() };
        }
        return { successCount: treeItems.length, failed: failed };
    }

    async function uploadFilesSequential(ctx, names, myRun) {
        const { zip, owner, repo, token, targetFolder, targetBranch } = ctx;
        const total = names.length;
        const failed = [];
        let successCount = 0;
        const startedAt = Date.now();
        setPhase('Пофайловая загрузка…');
        for (let i = 0; i < total; i++) {
            if (aborted(myRun)) {
                log('Операция отменена пользователем', 'warn');
                names.slice(i).forEach(n => failed.push(n));
                break;
            }
            const fileName = names[i];
            const fileObj = zip.file(fileName);
            if (!fileObj) continue;
            const safeName = sanitizePath(fileName);
            if (!safeName) continue;
            const destPath = targetFolder ? (targetFolder + '/' + safeName) : safeName;
            setProgress(Math.round((i / total) * 100));
            setEta(i, total, startedAt);
            log('[' + (i + 1) + '/' + total + '] ' + destPath);
            try {
                const fileData = await fileObj.async('base64');
                if (fileData.length > 133000000) throw new Error('файл больше 100 МБ');
                const sha = await getCurrentSha(owner, repo, token, destPath, targetBranch);
                await createOrUpdateFile(owner, repo, token, destPath, fileData, sha ? ('Обновлен ' + safeName) : ('Добавлен ' + safeName), sha, targetBranch);
                successCount++;
                await sleep(600);
            } catch (err) {
                failed.push(fileName);
                log('ОШИБКА: ' + destPath + ' — ' + err.message, 'error');
                if (failed.length >= 10 && failed.length % 10 === 0) {
                    log('Уже ' + failed.length + ' ошибок, продолжаем с паузой…', 'warn');
                    await sleep(3000);
                }
            }
        }
        return { successCount: successCount, failed: failed };
    }

    function finishUpload(ctx, result, total, myRun) {
        ctx.failed = result.failed;
        if (myRun !== runId) return;
        if (isRunning) setProgress(100);
        showStats(result.successCount, result.failed.length, total);
        exportLogBtn.classList.remove('hidden');
        if (result.failed.length === 0) {
            log('Успешно! Распаковано ' + result.successCount + ' из ' + total + ' файлов', 'success');
            if (lastRepoUrl) openRepoBtn.classList.remove('hidden');
        } else {
            log('Успешно: ' + result.successCount + ', Ошибок: ' + result.failed.length + ' из ' + total, result.successCount > 0 ? 'warn' : 'error');
            retryBtn.classList.remove('hidden');
            if (lastRepoUrl && result.successCount > 0) openRepoBtn.classList.remove('hidden');
        }
        setPhase('');
        if (window.AndroidInterface) {
            window.AndroidInterface.showToast((isRunning ? 'Распаковка завершена' : 'Операция отменена') + ': ' + result.successCount + '/' + total);
        }
    }

    async function processZipBlob(blob, owner, repo, token, targetFolder, branch, myRun, dryRun, singleCommit) {
        if (typeof JSZip === 'undefined') throw new Error('Библиотека JSZip не загружена');
        setPhase('Чтение ZIP…');
        setProgress(5);
        let zip;
        try { zip = await JSZip.loadAsync(blob); }
        catch (e) { throw new Error('Не удалось прочитать ZIP-архив: ' + e.message); }
        const allFiles = Object.keys(zip.files);
        const files = allFiles.filter(name => {
            if (zip.files[name].dir) return false;
            if (name.startsWith('__MACOSX/') || name.endsWith('.DS_Store')) return false;
            return !!sanitizePath(name);
        });
        const total = files.length;
        if (total === 0) throw new Error('В архиве не найдено файлов');
        log('Найдено файлов: ' + total + ' (всего записей: ' + allFiles.length + ')');
        if (blob.size > WARN_ZIP_MB * 1024 * 1024) log('Внимание: архив ' + (blob.size / 1024 / 1024).toFixed(1) + ' МБ', 'warn');
        if (total > WARN_FILE_COUNT) log('Внимание: ' + total + ' файлов — возможен rate limit', 'warn');

        if (dryRun) {
            setPhase('Dry-run');
            log('— Dry-run (запись не выполняется) —', 'warn');
            files.forEach((name, i) => {
                const dest = targetFolder ? (targetFolder + '/' + sanitizePath(name)) : sanitizePath(name);
                log('[' + (i + 1) + '/' + total + '] → ' + dest);
            });
            setProgress(100);
            showStats(total, 0, total);
            log('Dry-run завершён: ' + total + ' файлов', 'success');
            exportLogBtn.classList.remove('hidden');
            return;
        }

        setPhase('Проверка репозитория…');
        setProgress(10);
        const info = await getRepoInfo(owner, repo, token);
        if (aborted(myRun)) return;
        if (info.permissions && info.permissions.push === false) {
            throw new Error('Нет прав на запись (нужен токен с правом repo / Contents: Write)');
        }
        const targetBranch = branch || info.default_branch || 'main';
        if (info.size === 0) {
            log('Репозиторий пуст — первый коммит создаст ветку «' + targetBranch + '»', 'warn');
            if (branch && branch !== (info.default_branch || 'main')) {
                log('Не-default ветка для пустого репо будет создана при коммите', 'warn');
            }
        } else if (branch) {
            await checkBranch(owner, repo, token, branch);
            if (aborted(myRun)) return;
        }
        log('Целевая ветка: ' + targetBranch);
        lastRepoUrl = 'https://github.com/' + owner + '/' + repo + '/tree/' + encodeURIComponent(targetBranch);
        saveHistoryEntry(owner, repo);
        const ctx = { zip: zip, owner: owner, repo: repo, token: token, targetFolder: targetFolder, targetBranch: targetBranch, failed: [], total: total };
        lastRun = ctx;
        let result;
        if (singleCommit) {
            try {
                result = await uploadViaTreeApi(ctx, files, myRun);
                if (result.successCount === 0 && result.failed.length === total) {
                    log('Переход на пофайловую загрузку…', 'warn');
                    result = await uploadFilesSequential(ctx, files, myRun);
                }
            } catch (e) {
                log('Tree API: ' + e.message + ' — пофайловый режим', 'warn');
                result = await uploadFilesSequential(ctx, files, myRun);
            }
        } else {
            result = await uploadFilesSequential(ctx, files, myRun);
        }
        finishUpload(ctx, result, total, myRun);
    }

    retryBtn.addEventListener('click', async () => {
        if (isRunning || !lastRun || !lastRun.failed || !lastRun.failed.length) return;
        if (window.AndroidInterface && typeof window.AndroidInterface.isOnline === 'function' && !window.AndroidInterface.isOnline()) {
            alert('Нет подключения к интернету');
            return;
        }
        const ctx = lastRun;
        const names = ctx.failed.slice();
        retryBtn.classList.add('hidden');
        statsEl.classList.add('hidden');
        hideProgress();
        abortController = new AbortController();
        keepAwake(true);
        isRunning = true;
        const myRun = ++runId;
        unzipBtn.textContent = 'Отменить';
        unzipBtn.style.backgroundColor = '#93000A';
        unzipBtn.style.color = '#FFDAD6';
        log('Повтор: ' + names.length + ' файлов');
        try {
            const result = await uploadFilesSequential(ctx, names, myRun);
            finishUpload(ctx, result, names.length, myRun);
        } catch (err) {
            log('Критическая ошибка: ' + err.message, 'error');
            notifyError(err.message);
        } finally {
            if (myRun === runId) {
                keepAwake(false);
                isRunning = false;
                abortController = null;
                unzipBtn.textContent = 'Распаковать в GitHub';
                unzipBtn.style.backgroundColor = '';
                unzipBtn.style.color = '';
            }
        }
    });

    openRepoBtn.addEventListener('click', () => { if (lastRepoUrl) openExternal(lastRepoUrl); });
    exportLogBtn.addEventListener('click', () => {
        const text = logLines.join('\n');
        try {
            if (window.AndroidInterface && typeof window.AndroidInterface.shareText === 'function') {
                window.AndroidInterface.shareText(text, 'AI Builder log');
                return;
            }
        } catch (e) {}
        const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'unzipgit-log.txt';
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
        log('Лог экспортирован', 'success');
    });
    const pickRepoBtn = document.getElementById('pickRepoBtn');
    if (pickRepoBtn) pickRepoBtn.addEventListener('click', () => { window.location.href = 'repos.html'; });
    const manageTokensBtn = document.getElementById('manageTokensBtn');
    if (manageTokensBtn) manageTokensBtn.addEventListener('click', () => { window.location.href = 'tokens.html'; });
    forgetTokenBtn.addEventListener('click', async () => {
        const activeToken = U.token();
        const secureList = U.secretJson('unzipgit_tokens', null);
        const oldList = Array.isArray(secureList) ? secureList : U.lsJson('unzipgit_tokens', null);
        const nextList = Array.isArray(oldList) ? oldList.filter(x => x && x.value !== activeToken) : oldList;
        if (Array.isArray(oldList)) {
            const savedList = U.saveSecretJson('unzipgit_tokens', nextList);
            const listOk = savedList && typeof savedList.then === 'function' ? await savedList : savedList === true;
            if (!listOk) { alert('Не удалось удалить сохранённую копию токена из защищённого хранилища.'); return; }
        }
        const deleted = U.ls('unzipgit_token', null);
        const deleteOk = deleted && typeof deleted.then === 'function' ? await deleted : deleted === true;
        if (!deleteOk) {
            if (Array.isArray(oldList)) {
                const rollback = U.saveSecretJson('unzipgit_tokens', oldList);
                if (rollback && typeof rollback.then === 'function') await rollback;
            }
            alert('Не удалось удалить токен из защищённого хранилища.');
            return;
        }
        tokenInput.value = '';
        forgetTokenBtn.classList.add('hidden');
        log('Активный токен и его сохранённая копия удалены с устройства. Токен GitHub остаётся действительным.', 'warn');
    });
    if (filePickBtn) filePickBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
        const file = fileInput.files[0];
        if (file) {
            fileInfo.classList.remove('hidden');
            fileInfo.textContent = 'Выбран: ' + file.name + ' (' + (file.size / 1024).toFixed(1) + ' КБ)';
            if (fileNameLabel) { fileNameLabel.textContent = file.name; fileNameLabel.classList.add('has-file'); }
            clearBtn.classList.remove('hidden');
        } else {
            fileInfo.classList.add('hidden');
            if (fileNameLabel) { fileNameLabel.textContent = 'Файл не выбран'; fileNameLabel.classList.remove('has-file'); }
            clearBtn.classList.add('hidden');
        }
    });
    clearBtn.addEventListener('click', () => {
        fileInput.value = '';
        fileInfo.classList.add('hidden');
        clearBtn.classList.add('hidden');
        if (fileNameLabel) { fileNameLabel.textContent = 'Файл не выбран'; fileNameLabel.classList.remove('has-file'); }
        archivePathInput.value = '';
        lastRun = null;
        retryBtn.classList.add('hidden');
        openRepoBtn.classList.add('hidden');
        exportLogBtn.classList.add('hidden');
        clearLog();
        hideProgress();
        statsEl.classList.add('hidden');
    });

    unzipBtn.addEventListener('click', async () => {
        if (isRunning) {
            isRunning = false;
            if (abortController) try { abortController.abort(); } catch (e) {}
            keepAwake(false);
            unzipBtn.textContent = 'Распаковать в GitHub';
            unzipBtn.style.backgroundColor = '';
                unzipBtn.style.color = '';
            log('Отмена операции...', 'warn');
            return;
        }
        let username = usernameInput.value.trim();
        let repoRaw = repoInput.value.trim();
        const token = tokenInput.value.trim();
        let branch = branchInput.value.trim();
        let archivePath = archivePathInput.value.trim();
        const file = fileInput.files[0];
        const dryRun = dryRunCheck.checked;
        const singleCommit = singleCommitCheck.checked;

        const urlFromArchive = parseGitHubUrl(archivePath);
        const urlFromBranch = parseGitHubUrl(branch);
        const urlFromRepo = parseGitHubUrl(repoRaw);
        let recognizedMsg = '';
        if (urlFromArchive) {
            if (urlFromArchive.owner) username = urlFromArchive.owner;
            if (urlFromArchive.repo) repoRaw = urlFromArchive.repo;
            if (urlFromArchive.branch) branch = urlFromArchive.branch;
            if (urlFromArchive.path) archivePath = urlFromArchive.path;
            recognizedMsg = 'Распознан GitHub URL в пути → ' + archivePath;
        } else if (urlFromBranch) {
            if (urlFromBranch.owner) username = urlFromBranch.owner;
            if (urlFromBranch.repo) repoRaw = urlFromBranch.repo;
            if (urlFromBranch.branch) branch = urlFromBranch.branch;
            recognizedMsg = 'Распознан GitHub URL в ветке';
        } else if (urlFromRepo) {
            if (urlFromRepo.owner) username = urlFromRepo.owner;
            if (urlFromRepo.repo) repoRaw = urlFromRepo.repo;
            recognizedMsg = 'Распознан GitHub URL в репозитории';
        }
        if (username.includes('/') && !repoRaw) {
            const parts = username.split('/');
            username = parts[0];
            repoRaw = parts.slice(1).join('/');
        }
        branch = normalizeBranch(branch);
        archivePath = normalizeArchivePath(archivePath);
        usernameInput.value = username;
        repoInput.value = repoRaw;
        branchInput.value = branch;
        archivePathInput.value = archivePath;

        const validationError = validateInputs();
        if (validationError) { alert(validationError); return; }
        const parts = repoRaw.split('/');
        const repoName = parts[0];
        const targetFolder = sanitizePath(parts.slice(1).join('/'));
        if (!file && !archivePath) {
            alert('Выберите файл или укажите путь к архиву в репозитории');
            return;
        }
        if (file && archivePath) log('Локальный файл и путь в репо — будет использован файл с устройства', 'warn');
        if (window.AndroidInterface && typeof window.AndroidInterface.isOnline === 'function' && !window.AndroidInterface.isOnline()) {
            alert('Нет подключения к интернету');
            return;
        }

        lastRun = null;
        lastRepoUrl = null;
        retryBtn.classList.add('hidden');
        openRepoBtn.classList.add('hidden');
        exportLogBtn.classList.add('hidden');
        if (!await saveInputs()) { alert('Не удалось сохранить токен в защищённом хранилище. Проверьте настройки устройства и повторите попытку.'); return; }
        forgetTokenBtn.classList.remove('hidden');
        abortController = new AbortController();
        keepAwake(true);
        isRunning = true;
        const myRun = ++runId;
        unzipBtn.textContent = 'Отменить';
        unzipBtn.style.backgroundColor = '#93000A';
        unzipBtn.style.color = '#FFDAD6';
        statsEl.classList.add('hidden');
        hideProgress();
        clearLog();
        log(dryRun ? 'Начинаю dry-run…' : 'Начинаю распаковку...');
        if (recognizedMsg) log(recognizedMsg);
        if (branch) log('Ветка: ' + branch);
        if (archivePath && !file) {
            log('Путь к архиву: ' + archivePath);
            if (!/\.zip$/i.test(archivePath)) log('Внимание: путь не заканчивается на .zip', 'warn');
        }

        try {
            setPhase('Проверка токена…');
            setProgress(2);
            const tokenInfo = await validateToken(token);
            if (aborted(myRun)) return;
            log('Токен OK · ' + tokenInfo.login + (tokenInfo.scopes ? ' · scopes: ' + tokenInfo.scopes : ''));
            let blob;
            if (file) {
                if (!/\.zip$/i.test(file.name)) throw new Error('Файл должен иметь расширение .zip');
                blob = file;
                log('Локальный файл: ' + file.name + ' (' + (file.size / 1024).toFixed(1) + ' КБ)');
            } else if (archivePath) {
                setPhase('Загрузка архива…');
                log('Загружаю архив из репозитория...');
                blob = await getFileContent(username, repoName, token, archivePath, branch);
                log('Архив загружен (' + (blob.size / 1024).toFixed(1) + ' КБ)');
            }
            if (aborted(myRun)) return;
            await processZipBlob(blob, username, repoName, token, targetFolder, branch, myRun, dryRun, singleCommit);
        } catch (err) {
            log('Критическая ошибка: ' + err.message, 'error');
            notifyError(err.message);
            console.error(err);
            exportLogBtn.classList.remove('hidden');
        } finally {
            if (myRun === runId) {
                keepAwake(false);
                isRunning = false;
                abortController = null;
                unzipBtn.textContent = 'Распаковать в GitHub';
                unzipBtn.style.backgroundColor = '';
                unzipBtn.style.color = '';
                setPhase('');
            }
        }
    });

    log('Готово к работе. Введите данные и нажмите кнопку.');
});
