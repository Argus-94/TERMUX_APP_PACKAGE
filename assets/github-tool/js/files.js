// UnzipGit — экран «Файлы репозитория»: двухпанельный менеджер, редактор, поиск.
// Все изменения автоматически превращаются в коммиты через GitHub API.
(function () {
    'use strict';

    // ======================================================================
    // Утилиты
    // ======================================================================
    var $ = function (id) { return document.getElementById(id); };
    // Убирает невидимые символы, кавычки и префикс Bearer/token из вставленного токена.
    function cleanTokenInput(raw) {
        return String(raw == null ? '' : raw)
            .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF\u00AD]/g, '')
            .replace(/^\s+|\s+$/g, '')
            .replace(/^authorization\s*:\s*/i, '').replace(/^(?:bearer|token)\s+/i, '')
            .replace(/^["'`«»“”‘’]+|["'`«»“”‘’]+$/g, '')
            .replace(/\s+/g, '');
    }
    var enc = encodeURIComponent;
    // Token keys must match common.js (Android secret storage).
    function secretGet(k) {
        try {
            if (window.AndroidInterface && typeof window.AndroidInterface.secretGet === 'function')
                return window.AndroidInterface.secretGet(k) || '';
        } catch (e) {}
        return '';
    }
    var pendingLegacyMemory = Object.create(null), migrationDeclined = Object.create(null), migrationInFlight = Object.create(null);
    function pendingSecret(k) { return pendingLegacyMemory[k] || ''; }
    function clearPendingSecret(k) {
        delete pendingLegacyMemory[k];
        delete migrationDeclined[k];
    }
    function clearLegacySecret(k) {
        try { localStorage.removeItem(k); localStorage.removeItem('aib_sec_' + k); } catch (e) {}
        try { sessionStorage.removeItem(k); sessionStorage.removeItem('aib_sec_' + k); } catch (e) {}
    }
    function signalSecretsReady() { try { window.dispatchEvent(new Event('aib-secrets-ready')); } catch (e) {} }
    function secretSet(k, v, migration) {
        try {
            if (window.AndroidInterface && typeof window.AndroidInterface.secretSet === 'function') {
                var result = window.AndroidInterface.secretSet(k, String(v == null ? '' : v), migration === true);
                if (result && typeof result.then === 'function') return result.then(function (ok) { if (ok) clearPendingSecret(k); return ok; });
                if (result === true) clearPendingSecret(k);
                return result;
            }
        } catch (e) {}
        return false;
    }
    function secretDelete(k) {
        try {
            if (window.AndroidInterface && typeof window.AndroidInterface.secretDelete === 'function') {
                var result = window.AndroidInterface.secretDelete(k);
                if (result && typeof result.then === 'function') return result.then(function (ok) { if (ok) clearPendingSecret(k); return ok; });
                if (result === true) clearPendingSecret(k);
                return result;
            }
        } catch (e) {}
        return false;
    }
    function migrateLegacySecret(k, legacy) {
        if (!legacy || migrationInFlight[k] || migrationDeclined[k]) return;
        pendingLegacyMemory[k] = legacy;
        migrationInFlight[k] = true;
        var result = secretSet(k, legacy, true);
        function finish(ok) {
            delete migrationInFlight[k];
            if (ok) { clearLegacySecret(k); clearPendingSecret(k); signalSecretsReady(); }
            else {
                clearLegacySecret(k);
                migrationDeclined[k] = true;
                try { if (window.AndroidInterface && window.AndroidInterface.showToast) window.AndroidInterface.showToast('Старый токен убран из постоянного хранилища, но не активирован. Введите его снова или повторите подключение; незаписанная копия доступна только до закрытия текущего сеанса.'); } catch (e) {}
            }
        }
        if (result && typeof result.then === 'function') result.then(finish, function () { finish(false); });
        else finish(result === true);
    }
    function whenSecretsReady(callback) {
        if (typeof callback !== 'function') return;
        window.addEventListener('aib-secrets-ready', callback);
        if (window.__aibSecretsReady) setTimeout(callback, 0);
    }
    function isTokenKey(k) {
        return k === 'unzipgit_token' || k === 'unzipgit_tokens' || k === 'unzipgit_apikeys';
    }
    function ls(k, v) {
        if (isTokenKey(k)) {
            if (v === undefined) {
                var sec = secretGet(k);
                if (sec) { clearLegacySecret(k); clearPendingSecret(k); return sec; }
                var pending = pendingSecret(k);
                if (pending) {
                    if (!migrationDeclined[k]) migrateLegacySecret(k, pending);
                    return '';
                }
                try {
                    var legacy = localStorage.getItem(k) || localStorage.getItem('aib_sec_' + k) || sessionStorage.getItem(k) || sessionStorage.getItem('aib_sec_' + k) || '';
                    if (legacy) migrateLegacySecret(k, legacy);
                    return '';
                } catch (e) { return ''; }
            }
            if (v === null || v === '') {
                var deleted = secretDelete(k);
                if (deleted && typeof deleted.then === 'function') deleted.then(function (ok) {
                    if (ok) clearLegacySecret(k);
                });
                else if (deleted === true) clearLegacySecret(k);
                return deleted;
            }
            var saved = secretSet(k, v);
            if (saved && typeof saved.then === 'function') {
                saved.then(function (ok) {
                    if (ok) clearLegacySecret(k);
                });
                return saved;
            }
            if (saved === true) {
                clearLegacySecret(k);
                return true;
            }
            try { if (window.AndroidInterface && window.AndroidInterface.showError) window.AndroidInterface.showError('Не удалось сохранить токен в защищённом хранилище.'); } catch (e9) {}
            return false;
        }
        try {
            if (v === undefined) return localStorage.getItem(k) || '';
            if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v);
        } catch (e) { /* ignore */ }
        return '';
    }
    function encPath(p) { return p.split('/').map(enc).join('/'); }
    function parentOf(p) { var i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i); }
    function baseOf(p) { return p.slice(p.lastIndexOf('/') + 1); }
    function join(a, b) { return a ? (b ? a + '/' + b : a) : b; }
    function cleanPath(p) {
        return String(p || '').replace(/\\/g, '/').split('/').map(function (s) { return s.trim(); })
            .filter(function (s) { return s && s !== '.' && s !== '..'; }).join('/');
    }
    function extOf(n) {
        var b = baseOf(n).toLowerCase(), i = b.lastIndexOf('.');
        return i <= 0 ? '' : b.slice(i + 1);
    }
    function fmtSize(n) {
        if (n < 1024) return n + ' Б';
        if (n < 1048576) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' КБ';
        return (n / 1048576).toFixed(1) + ' МБ';
    }
    function shortNames(paths) {
        var names = paths.map(baseOf);
        return names.length <= 3 ? names.join(', ') : names.slice(0, 3).join(', ') + ' и ещё ' + (names.length - 3);
    }
    function el(tag, cls, text) {
        var e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text != null) e.textContent = text;
        return e;
    }
    function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
    function tick() { return new Promise(function (r) { setTimeout(r, 0); }); }
    function natCmp(a, b) { return a.localeCompare(b, 'ru', { numeric: true, sensitivity: 'base' }); }

    var toastT = null;
    window.__aibToast = function (msg) { toast(msg); };
    function toast(msg, ms) {
        var t = $('toast');
        t.textContent = msg;
        t.classList.remove('hidden');
        clearTimeout(toastT);
        toastT = setTimeout(function () { t.classList.add('hidden'); }, ms || 2200);
    }
    function openExternal(url) {
        try {
            if (window.AndroidInterface && typeof window.AndroidInterface.openUrl === 'function') {
                window.AndroidInterface.openUrl(url);
                return;
            }
        } catch (e) { /* ignore */ }
        window.open(url, '_blank');
    }
    function copyText(t) {
        function legacy() {
            var a = document.createElement('textarea');
            a.value = t;
            a.style.cssText = 'position:fixed;opacity:0;left:0;top:0';
            document.body.appendChild(a);
            a.select();
            try { document.execCommand('copy'); toast('Скопировано'); } catch (e) { toast('Не удалось скопировать'); }
            a.remove();
        }
        try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(t).then(function () { toast('Скопировано'); }, legacy);
                return;
            }
        } catch (e) { /* ignore */ }
        legacy();
    }

    // base64 <-> текст/байты
    function b64ToBytes(b64) {
        var bin = atob(String(b64).replace(/\s/g, ''));
        var u = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
        return u;
    }
    function bytesToText(u) {
        var n = Math.min(u.length, 8000);
        for (var i = 0; i < n; i++) if (u[i] === 0) return null;
        try { return new TextDecoder('utf-8', { fatal: true }).decode(u); } catch (e) { return null; }
    }
    function textToB64(t) {
        var u = new TextEncoder().encode(t), s = '', CH = 0x8000;
        for (var i = 0; i < u.length; i += CH) s += String.fromCharCode.apply(null, u.subarray(i, i + CH));
        return btoa(s);
    }
    function readFileB64(file) {
        return new Promise(function (res, rej) {
            var r = new FileReader();
            r.onload = function () { res(String(r.result).split(',')[1] || ''); };
            r.onerror = function () { rej(new Error('Не удалось прочитать файл ' + file.name)); };
            r.readAsDataURL(file);
        });
    }

    // ======================================================================
    // Состояние
    // ======================================================================
    var cfg = { owner: '', repo: '', token: '', branch: '', root: '' };
    var setupSubmitting = false;
    var S = {
        entries: new Map(),      // path -> {path,type,sha,size,mode}
        children: new Map(),     // dir path -> [entry]
        branch: '', defaultBranch: 'main', branches: [],
        empty: false, truncated: false, connected: false,
        panes: [{ path: '', sel: new Set(), hist: [''], histIdx: 0 }, { path: '', sel: new Set(), hist: [''], histIdx: 0 }],
        active: 0,
        sort: ls('unzipgit_fm_sort') || 'name',
        textCache: new Map(),
        fetchBroken: false,
        swallow: false
    };
    var MAX_EDIT = 3 * 1024 * 1024;
    var MAX_HL = 200000;
    var BIN_EXT = set('png jpg jpeg gif webp bmp ico zip jar apk aab so dll exe pdf mp3 mp4 mov avi mkv wav ogg woff woff2 ttf otf eot keystore jks gz tgz tar 7z rar class dex bin dat db sqlite psd ai heic');
    var IMG = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', ico: 'image/x-icon' };
    function set(str) { var o = Object.create(null); str.split(/\s+/).forEach(function (w) { if (w) o[w] = 1; }); return o; }

    function repoBase() { return '/repos/' + enc(cfg.owner) + '/' + enc(cfg.repo); }
    function branchKey() { return 'unzipgit_fm_branch:' + cfg.owner + '/' + cfg.repo; }
    function readCfg() {
        cfg.owner = ls('unzipgit_username').trim();
        var raw = ls('unzipgit_repo').trim().replace(/^\/+|\/+$/g, '');
        var parts = raw.split('/');
        cfg.repo = parts[0] || '';
        cfg.root = cleanPath(parts.slice(1).join('/'));
        cfg.token = ls('unzipgit_token').trim();
        var b = ls('unzipgit_branch').trim();
        cfg.branch = /^[\w.\/-]+$/.test(b) ? b : '';
    }

    // ======================================================================
    // Сеть (нативный мост Android, как на главном экране)
    // ======================================================================
    function hasNative() {
        try {
            if (window.__aibHttp) return true;
            return !!(window.AndroidInterface && typeof window.AndroidInterface.httpRequest === 'function');
        } catch (e) { return false; }
    }
    async function nativeCall(url, opt) {
        var payload = JSON.stringify({
            url: url, method: opt.method || 'GET', headers: opt.headers || {},
            body: opt.body != null ? String(opt.body) : null, binary: !!opt.binary,
            timeoutMs: opt.timeoutMs || 15000
        });
        var raw, d;
        try {
            if (window.__aibHttp) raw = await window.__aibHttp(payload);
            else raw = window.AndroidInterface.httpRequest(payload);
        } catch (e) { throw new Error('Сетевой мост Android: ' + (e.message || e)); }
        try { d = JSON.parse(raw); } catch (e) { throw new Error('Некорректный ответ сетевого моста'); }
        if (d.error && !d.status) throw new Error('Сеть: ' + d.error);
        if (!d.status && !d.ok) throw new Error('Нет сети или сервер недоступен');
        var hm = d.headers || {};
        return {
            ok: !!d.ok, status: d.status || 0,
            headers: { get: function (n) {
                var k = Object.keys(hm).find(function (x) { return x.toLowerCase() === String(n).toLowerCase(); });
                return k ? hm[k] : null;
            } },
            text: function () { return Promise.resolve(d.body || ''); }
        };
    }
    async function rawHttp(url, opt, parallel) {
        async function viaFetch() {
            var timeoutMs = opt.timeoutMs || 15000;
            var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
            var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, timeoutMs) : null;
            try {
                var r = await fetch(url, { method: opt.method, headers: opt.headers, body: opt.body, signal: ctrl ? ctrl.signal : undefined });
                var bodyText = await r.text();
                return { ok: r.ok, status: r.status, headers: r.headers, text: function () { return Promise.resolve(bodyText); } };
            } catch (e) {
                if (ctrl && ctrl.signal.aborted) throw new Error('Превышено время ожидания ответа GitHub.');
                throw e;
            } finally { if (timer) clearTimeout(timer); }
        }
        if (parallel && !S.fetchBroken) {
            try { return await viaFetch(); }
            catch (e) { if (hasNative()) S.fetchBroken = true; else throw new Error('Нет сети или запрос заблокирован'); }
        }
        if (hasNative()) {
            var r = await nativeCall(url, opt);
            await tick();
            return r;
        }
        try { return await viaFetch(); } catch (e) { throw new Error('Нет сети или запрос заблокирован'); }
    }
    function rateWait(res, data) {
        var ra = res.headers.get('Retry-After');
        if (ra) return Math.min(60000, Math.max(1000, parseInt(ra, 10) * 1000));
        var rem = res.headers.get('X-RateLimit-Remaining'), rs = res.headers.get('X-RateLimit-Reset');
        if (rem === '0' && rs) return Math.min(60000, Math.max(1000, parseInt(rs, 10) * 1000 - Date.now()));
        if (res.status === 429 || /rate limit|abuse|secondary/i.test((data && data.message) || '')) return 20000;
        return 0;
    }
    async function gh(method, path, body, opt) {
        opt = opt || {};
        var url = path.indexOf('http') === 0 ? path : 'https://api.github.com' + path;
        var headers = {
            'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28'
        };
        if (/^https:\/\/api\.github\.com(?::443)?(?:[/?#]|$)/i.test(url)) headers.Authorization = 'token ' + (opt.token || cfg.token);
        if (body !== undefined) headers['Content-Type'] = 'application/json';
        for (var i = 0; ; i++) {
            var res = await rawHttp(url, { method: method, headers: headers, body: body !== undefined ? JSON.stringify(body) : undefined, timeoutMs: opt.timeoutMs }, opt.parallel);
            var txt = '', data = null;
            try { txt = await res.text(); } catch (e) { /* ignore */ }
            if (txt) { try { data = JSON.parse(txt); } catch (e) { data = null; } }
            if (!opt.noRetry && (res.status === 403 || res.status === 429) && i < 1) {
                var w = rateWait(res, data);
                if (w > 0 && w <= 5000) { toast('Лимит API, повтор через ' + Math.ceil(w / 1000) + ' с', w); await sleep(w); continue; }
            }
            if (!opt.noRetry && (res.status === 502 || res.status === 503 || res.status === 504) && i < 1) { await sleep(800); continue; }
            return { ok: res.ok, status: res.status, data: data, res: res };
        }
    }
    function errMsg(r) {
        if (r.status === 401) return 'Неверный токен или нет доступа (401)';
        var m = (r.data && r.data.message) || ('HTTP ' + r.status);
        if (r.data && r.data.errors && r.data.errors.length) {
            m += ' · ' + r.data.errors.map(function (e) { return e.message || JSON.stringify(e); }).join('; ');
        }
        if (r.status === 403 || r.status === 404) m += '\n(Проверьте права токена: Contents — Read and Write, и доступ к репозиторию.)';
        return m;
    }
    async function ghOk(method, path, body, opt) {
        var r = await gh(method, path, body, opt);
        if (!r.ok) throw new Error(errMsg(r));
        return r.data;
    }

    // Candidate verification and secure persistence are one ordered operation;
    // callers must not mutate account/repository settings before this succeeds.
    async function verifyThenSaveSetupToken(candidate, shouldSave) {
        var r = await gh('GET', '/user', undefined, { token: candidate, noRetry: true, timeoutMs: 15000 });
        if (!r.ok) {
            if (r.status === 401) throw new Error('Неверный или истёкший токен GitHub (401).');
            if (r.status === 403 || r.status === 429) throw new Error('GitHub ограничил проверку токена (HTTP ' + r.status + '). Повторите позже.');
            throw new Error('GitHub не подтвердил токен (HTTP ' + r.status + ').');
        }
        if (!r.data || typeof r.data.login !== 'string' || !r.data.login.trim()) throw new Error('GitHub вернул пустой или некорректный ответ аккаунта.');
        if (shouldSave && await Promise.resolve(ls('unzipgit_token', candidate)) !== true) {
            throw new Error('Не удалось сохранить токен в защищённом хранилище.');
        }
        return r.data;
    }

    // ======================================================================
    // Диалоги, панели ожидания
    // ======================================================================
    var modalResolve = null, sheetResolve = null, busyDepth = 0;

    function modal(o) {
        return new Promise(function (res) {
            var w = $('modalWrap');
            w.textContent = '';
            var c = el('div', 'mcard');
            c.appendChild(el('h3', '', o.title || ''));
            if (o.text) c.appendChild(el('p', '', o.text));
            var inp = null;
            if (o.input) {
                inp = el('input');
                inp.type = 'text';
                inp.value = o.value || '';
                inp.placeholder = o.placeholder || '';
                inp.setAttribute('autocapitalize', 'off');
                inp.setAttribute('autocorrect', 'off');
                inp.spellcheck = false;
                c.appendChild(inp);
            }
            var bar = el('div', 'mbtns');
            function done(val) {
                w.classList.add('hidden');
                w.textContent = '';
                modalResolve = null;
                res({ val: val, text: inp ? inp.value : '' });
            }
            (o.buttons || []).forEach(function (b) {
                var bt = el('button', 'mb ' + (b.kind || ''), b.label);
                bt.onclick = function () { done(b.val); };
                bar.appendChild(bt);
            });
            c.appendChild(bar);
            w.appendChild(c);
            w.classList.remove('hidden');
            modalResolve = function () { done(null); };
            w.onclick = function (e) { if (e.target === w) done(null); };
            if (inp) {
                setTimeout(function () { inp.focus(); inp.select(); }, 60);
                inp.onkeydown = function (e) {
                    if (e.key === 'Enter') {
                        var pb = (o.buttons || []).find(function (b) { return b.kind === 'primary' || b.kind === 'danger'; });
                        done(pb ? pb.val : 'ok');
                    }
                };
            }
        });
    }
    function modalCancel() { if (modalResolve) modalResolve(); }
    async function askText(title, value, placeholder, okLabel, text) {
        var r = await modal({
            title: title, text: text, input: true, value: value, placeholder: placeholder,
            buttons: [{ label: 'Отмена', val: null, kind: 'ghost' }, { label: okLabel || 'OK', val: 'ok', kind: 'primary' }]
        });
        return r && r.val === 'ok' ? r.text : null;
    }
    async function confirmBox(title, text, okLabel, danger) {
        var r = await modal({
            title: title, text: text,
            buttons: [{ label: 'Отмена', val: null, kind: 'ghost' }, { label: okLabel || 'OK', val: 'ok', kind: danger ? 'danger' : 'primary' }]
        });
        return !!(r && r.val === 'ok');
    }
    function showError(msg) {
        return modal({ title: 'Ошибка', text: msg, buttons: [{ label: 'OK', val: 'ok', kind: 'primary' }] });
    }
    function sheet(title, items) {
        return new Promise(function (res) {
            var w = $('sheetWrap');
            w.textContent = '';
            var s = el('div', 'sheet');
            if (title) s.appendChild(el('div', 'sh-t', title));
            items.forEach(function (it) {
                var b = el('button', it.danger ? 'danger' : '');
                var si = el('span', 'si');
                if (window.MI_HAS && window.MI_HAS(it.icon)) si.innerHTML = window.MI(it.icon, 22); else si.textContent = it.icon || '';
                b.appendChild(si);
                b.appendChild(document.createTextNode(it.label));
                b.onclick = function () { sheetResolve = null; hideSheet(); res(it.id); };
                s.appendChild(b);
            });
            w.appendChild(s);
            w.classList.remove('hidden');
            sheetResolve = res;
            w.onclick = function (e) { if (e.target === w) closeSheet(); };
        });
    }
    function hideSheet() { var w = $('sheetWrap'); w.classList.add('hidden'); w.textContent = ''; }
    function closeSheet() { var r = sheetResolve; sheetResolve = null; hideSheet(); if (r) r(null); }
    function setBusy(msg) {
        busyDepth++;
        $('busyTxt').textContent = msg || 'Подождите…';
        $('busy').classList.remove('hidden');
    }
    function clearBusy() {
        busyDepth = Math.max(0, busyDepth - 1);
        if (!busyDepth) $('busy').classList.add('hidden');
    }
    // Выполняет операцию под индикатором; ожидание ошибки/диалога не удерживает busy.
    function safeRequestError(value) {
        return String(value || 'Неизвестная ошибка')
            .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, '[скрыто]')
            .replace(/(authorization\s*[:=]\s*(?:token|bearer)\s+)\S+/ig, '$1[скрыто]')
            .slice(0, 500);
    }
    async function run(msg, fn, timeoutMs, options) {
        setBusy(msg);
        var timer = null, value, failure = null;
        try {
            var work = Promise.resolve().then(fn);
            if (Number(timeoutMs) > 0) {
                var limit = Math.max(1000, Math.min(Number(timeoutMs), 30000));
                var timeout = new Promise(function (_, reject) {
                    timer = setTimeout(function () { reject(new Error('Запрос занял слишком много времени. Проверьте интернет и попробуйте ещё раз.')); }, limit);
                });
                value = await Promise.race([work, timeout]);
            } else value = await work;
        } catch (e) { failure = safeRequestError((e && e.message) || e); }
        finally { if (timer) clearTimeout(timer); clearBusy(); }
        if (failure) {
            // Never await a dialog: the user may dismiss/unmount this WebView.
            if (!(options && options.silent)) {
                try { Promise.resolve(showError(failure)).catch(function () { toast(failure, 4500); }); }
                catch (e) { toast(failure, 4500); }
            }
            return { ok: false, error: failure };
        }
        return { ok: true, v: value };
    }

    // ======================================================================
    // Репозиторий: загрузка дерева
    // ======================================================================
    function buildIndex(list) {
        S.entries = new Map();
        S.children = new Map();
        S.children.set('', []);
        list.forEach(function (e) {
            if (e.type !== 'blob' && e.type !== 'tree') return;
            var ent = { path: e.path, type: e.type, sha: e.sha, size: e.size || 0, mode: e.mode || '100644' };
            S.entries.set(e.path, ent);
            var p = parentOf(e.path);
            if (!S.children.has(p)) S.children.set(p, []);
            S.children.get(p).push(ent);
            if (e.type === 'tree' && !S.children.has(e.path)) S.children.set(e.path, []);
        });
    }
    async function reloadTree(treeSha) {
        var t = await ghOk('GET', repoBase() + '/git/trees/' + treeSha + '?recursive=1');
        S.truncated = !!t.truncated;
        buildIndex(t.tree || []);
        S.empty = false;
    }
    async function loadTree() {
        var r = await gh('GET', repoBase() + '/branches/' + encPath(S.branch));
        if (r.status === 404) {
            if (S.branch !== S.defaultBranch) {
                S.branch = S.defaultBranch;
                ls(branchKey(), null);
                return loadTree();
            }
            // ветки нет — пустой репозиторий
            buildIndex([]);
            S.empty = true;
            return;
        }
        if (!r.ok) throw new Error(errMsg(r));
        await reloadTree(r.data.commit.commit.tree.sha);
    }
    async function loadRepo() {
        var info = await ghOk('GET', repoBase());
        S.defaultBranch = info.default_branch || 'main';
        S.branch = ls(branchKey()) || cfg.branch || S.defaultBranch;
        try {
            var bl = await gh('GET', repoBase() + '/branches?per_page=100');
            S.branches = bl.ok && Array.isArray(bl.data) ? bl.data.map(function (b) { return b.name; }) : [];
        } catch (e) { S.branches = []; }
        await loadTree();
        if (S.branches.indexOf(S.branch) < 0) S.branches.unshift(S.branch);
    }
    async function getBlob(sha) {
        var d = await ghOk('GET', repoBase() + '/git/blobs/' + sha);
        if (!d || d.content == null) throw new Error('Пустой ответ blob');
        return String(d.content).replace(/\s/g, '');
    }

    // ======================================================================
    // Список файлов
    // ======================================================================
    function listDir(path) {
        var arr = (S.children.get(path) || []).slice();
        var mode = S.sort;
        arr.sort(function (a, b) {
            if (a.type !== b.type) return a.type === 'tree' ? -1 : 1;
            var an = baseOf(a.path), bn = baseOf(b.path);
            if (a.type === 'blob') {
                if (mode === 'size' && a.size !== b.size) return b.size - a.size;
                if (mode === 'ext') {
                    var c = natCmp(extOf(an), extOf(bn));
                    if (c) return c;
                }
            }
            return natCmp(an, bn);
        });
        return arr;
    }
    function nearestDir(p) {
        while (p && !S.children.has(p)) p = parentOf(p);
        return p;
    }
    function iconFor(ent) {
        if (ent.type === 'tree') return 'folder';
        var e = extOf(ent.path);
        if (IMG[e] || e === 'svg') return 'image';
        if (e === 'zip' || e === 'jar' || e === 'apk' || e === 'aab' || e === 'gz' || e === 'tar' || e === '7z' || e === 'rar') return 'archive';
        if (e === 'md' || e === 'txt') return 'text';
        if (BIN_EXT[e]) return 'file';
        return 'code';
    }
    function icoEl(name) { var d = el('div', 'ico'); d.innerHTML = window.MI(name, 22); return d; }
    function renderCrumbs(i) {
        var p = S.panes[i], cr = $('crumbs' + i);
        cr.textContent = '';
        function mk(label, path) { var b = el('button', 'crumb', label); b.dataset.path = path; return b; }
        cr.appendChild(mk('⌂ ' + cfg.repo, ''));
        var acc = '';
        p.path.split('/').filter(Boolean).forEach(function (seg) {
            acc = join(acc, seg);
            cr.appendChild(el('span', 'crumb-sep', '›'));
            cr.appendChild(mk(seg, acc));
        });
        cr.scrollLeft = cr.scrollWidth;
    }
    function renderPane(i, keepScroll) {
        var p = S.panes[i];
        if (!S.children.has(p.path)) {
            var fixed = nearestDir(p.path);
            if (fixed !== p.path) {
                p.path = fixed;
                // keep history entry in sync so back/forward matches visible folder
                if (Array.isArray(p.hist) && typeof p.histIdx === 'number' && p.histIdx >= 0 && p.histIdx < p.hist.length) {
                    p.hist[p.histIdx] = fixed;
                }
            }
        }
        var list = $('plist' + i), st = list.scrollTop;
        list.textContent = '';
        renderCrumbs(i);
        updateNavBtns(i);
        var frag = document.createDocumentFragment();
        if (p.path) {
            var up = el('div', 'row dir');
            up.dataset.up = '1';
            up.appendChild(icoEl('up'));
            var um = el('div', 'rmeta');
            um.appendChild(el('div', 'nm', '..'));
            um.appendChild(el('div', 'sub', 'На уровень выше'));
            up.appendChild(um);
            frag.appendChild(up);
        }
        var items = listDir(p.path);
        items.forEach(function (ent) {
            var sel = p.sel.has(ent.path);
            var row = el('div', 'row ' + (ent.type === 'tree' ? 'dir' : 'file') + (sel ? ' sel' : ''));
            row.dataset.path = ent.path;
            row.appendChild(icoEl(sel ? 'check' : iconFor(ent)));
            var m = el('div', 'rmeta');
            m.appendChild(el('div', 'nm', baseOf(ent.path)));
            var sub = ent.type === 'tree'
                ? ((S.children.get(ent.path) || []).length + ' элем.')
                : fmtSize(ent.size);
            m.appendChild(el('div', 'sub', sub));
            row.appendChild(m);
            frag.appendChild(row);
        });
        if (!items.length) {
            frag.appendChild(el('div', 'empty', S.empty && !p.path ? 'Репозиторий пуст. Загрузите файлы или создайте новый.' : 'Папка пуста'));
        }
        list.appendChild(frag);
        list.scrollTop = keepScroll ? st : 0;
    }
    function renderAll(keep) {
        S.panes.forEach(function (p, i) {
            // убираем из выделения то, чего больше нет
            Array.from(p.sel).forEach(function (x) { if (!S.entries.has(x)) p.sel.delete(x); });
            renderPane(i, keep);
        });
        updateStatus();
    }
    function updateStatus() {
        var p = S.panes[S.active];
        var items = S.children.get(p.path) || [];
        var dirs = items.filter(function (x) { return x.type === 'tree'; }).length;
        var txt = '⎇ ' + S.branch + ' · папок: ' + dirs + ' · файлов: ' + (items.length - dirs);
        if (p.sel.size) txt += ' · выбрано: ' + p.sel.size;
        if (S.truncated) txt += ' · ⚠ дерево урезано GitHub';
        $('status').textContent = txt;
    }
    function setActive(i) {
        S.active = i;
        $('pane0').classList.toggle('active', i === 0);
        $('pane1').classList.toggle('active', i === 1);
        updateStatus();
    }
    function toggleSel(i, path) {
        var p = S.panes[i];
        if (p.sel.has(path)) p.sel.delete(path); else p.sel.add(path);
        renderPane(i, true);
        updateStatus();
    }
    function updateNavBtns(i) {
        var p = S.panes[i];
        if (!p) return;
        if (!Array.isArray(p.hist)) { p.hist = [p.path || '']; p.histIdx = 0; }
        if (typeof p.histIdx !== 'number' || p.histIdx < 0) p.histIdx = 0;
        if (p.histIdx >= p.hist.length) p.histIdx = p.hist.length - 1;
        var b = document.getElementById('navBack' + i);
        var f = document.getElementById('navFwd' + i);
        if (b) b.disabled = !(p.histIdx > 0);
        if (f) f.disabled = !(p.histIdx < (p.hist.length - 1));
    }
    function goTo(i, path, fromHist) {
        var p = S.panes[i];
        path = path == null ? '' : String(path);
        if (!Array.isArray(p.hist) || !p.hist.length) { p.hist = [path]; p.histIdx = 0; }
        if (!fromHist) {
            if (p.hist[p.histIdx] !== path) {
                p.hist = p.hist.slice(0, p.histIdx + 1);
                p.hist.push(path);
                while (p.hist.length > 80) {
                    p.hist.shift();
                    if (p.histIdx > 0) p.histIdx--;
                }
                p.histIdx = p.hist.length - 1;
            }
        } else if (p.histIdx < 0 || p.histIdx >= p.hist.length) {
            p.histIdx = Math.max(0, Math.min(p.histIdx, p.hist.length - 1));
        }
        p.path = path;
        p.sel.clear();
        renderPane(i, false);
        updateStatus();
        updateNavBtns(i);
    }
    function navBack(i) {
        var p = S.panes[i];
        if (p.histIdx <= 0) return;
        p.histIdx--;
        goTo(i, p.hist[p.histIdx], true);
    }
    function navFwd(i) {
        var p = S.panes[i];
        if (p.histIdx >= p.hist.length - 1) return;
        p.histIdx++;
        goTo(i, p.hist[p.histIdx], true);
    }
    function openEntry(i, path) {
        var ent = S.entries.get(path);
        if (!ent) return;
        if (ent.type === 'tree') goTo(i, path); else openFile(path);
    }
    function wirePane(i) {
        var list = $('plist' + i), crumbs = $('crumbs' + i), timer = null, sx = 0, sy = 0;
        function pathOfRow(t) { var r = t.closest('.row'); return r ? r : null; }
        list.addEventListener('touchstart', function (e) {
            S.swallow = false;
            var row = pathOfRow(e.target);
            if (!row || row.dataset.up || !e.touches.length) return;
            sx = e.touches[0].clientX; sy = e.touches[0].clientY;
            clearTimeout(timer);
            timer = setTimeout(function () {
                timer = null;
                S.swallow = true;
                try { if (navigator.vibrate) navigator.vibrate(15); } catch (x) { /* ignore */ }
                setActive(i);
                toggleSel(i, row.dataset.path);
            }, 450);
        }, { passive: true });
        list.addEventListener('touchmove', function (e) {
            if (!timer || !e.touches.length) return;
            if (Math.abs(e.touches[0].clientX - sx) > 10 || Math.abs(e.touches[0].clientY - sy) > 10) { clearTimeout(timer); timer = null; }
        }, { passive: true });
        list.addEventListener('touchend', function () { clearTimeout(timer); timer = null; }, { passive: true });
        list.addEventListener('touchcancel', function () { clearTimeout(timer); timer = null; }, { passive: true });
        list.addEventListener('contextmenu', function (e) { e.preventDefault(); });
        list.addEventListener('click', function (e) {
            if (S.swallow) { S.swallow = false; return; }
            setActive(i);
            var row = pathOfRow(e.target);
            if (!row) return;
            var p = S.panes[i];
            if (row.dataset.up) { goTo(i, parentOf(p.path)); return; }
            var path = row.dataset.path;
            if (e.target.closest('.ico') || p.sel.size) { toggleSel(i, path); return; }
            openEntry(i, path);
        });
        crumbs.addEventListener('click', function (e) {
            var b = e.target.closest('.crumb');
            if (!b) return;
            setActive(i);
            goTo(i, b.dataset.path);
        });
        $('pane' + i).addEventListener('touchstart', function () { if (S.active !== i) setActive(i); }, { passive: true });
    }

    // ======================================================================
    // Коммиты (автоматически, без участия пользователя)
    // ======================================================================
    function commitMsg(text) { return 'UnzipGit: ' + text; }

    async function putContents(path, b64, message, sha) {
        var body = { message: message, content: b64, branch: S.branch };
        if (sha) body.sha = sha;
        return gh('PUT', repoBase() + '/contents/' + encPath(path), body);
    }
    async function currentSha(path) {
        var r = await gh('GET', repoBase() + '/contents/' + encPath(path) + '?ref=' + enc(S.branch));
        if (r.status === 404) return null;
        if (!r.ok) throw new Error(errMsg(r));
        if (Array.isArray(r.data)) throw new Error(path + ' — это папка');
        return r.data.sha || null;
    }

    // changes: {path, del:true} | {path, b64:'…'} | {path, sha:'…', mode:'100644'}
    // Все изменения попадают в ОДИН коммит.
    async function commit(changes, message) {
        if (!changes.length) return '';
        var msg = commitMsg(message);
        if (S.empty) {
            // Empty repository: create every blob/tree/root commit first, then
            // create the branch once. Contents API would split a multi-upload
            // into several commits and leave a partially uploaded repository.
            var rootItems = [];
            for (var k = 0; k < changes.length; k++) {
                var c = changes[k];
                if (c.del || c.b64 == null) throw new Error('Репозиторий пуст: доступны только новые файлы');
                var blob = await ghOk('POST', repoBase() + '/git/blobs', { content: c.b64, encoding: 'base64' });
                rootItems.push({ path: c.path, mode: c.mode || '100644', type: 'blob', sha: blob.sha });
            }
            var rootTree = await ghOk('POST', repoBase() + '/git/trees', { tree: rootItems });
            var rootCommit = await ghOk('POST', repoBase() + '/git/commits', { message: msg, tree: rootTree.sha, parents: [] });
            await ghOk('POST', repoBase() + '/git/refs', { ref: 'refs/heads/' + S.branch, sha: rootCommit.sha });
            S.empty = false;
            await reloadTree(rootTree.sha);
            return rootCommit.sha;
        }
        var ref = await ghOk('GET', repoBase() + '/git/ref/heads/' + encPath(S.branch));
        var headSha = ref.object.sha;
        var headCommit = await ghOk('GET', repoBase() + '/git/commits/' + headSha);
        var items = [];
        for (var i = 0; i < changes.length; i++) {
            var ch = changes[i];
            if (ch.del) {
                items.push({ path: ch.path, mode: '100644', type: 'blob', sha: null });
            } else if (ch.b64 != null) {
                var bl = await ghOk('POST', repoBase() + '/git/blobs', { content: ch.b64, encoding: 'base64' });
                items.push({ path: ch.path, mode: ch.mode || '100644', type: 'blob', sha: bl.sha });
            } else {
                items.push({ path: ch.path, mode: ch.mode || '100644', type: 'blob', sha: ch.sha });
            }
        }
        var tree = await ghOk('POST', repoBase() + '/git/trees', { base_tree: headCommit.tree.sha, tree: items });
        var cm = await ghOk('POST', repoBase() + '/git/commits', { message: msg, tree: tree.sha, parents: [headSha] });
        await ghOk('PATCH', repoBase() + '/git/refs/heads/' + encPath(S.branch), { sha: cm.sha, force: false });
        await reloadTree(tree.sha);
        return cm.sha;
    }
    async function doCommit(busyMsg, changes, message) {
        var r = await run(busyMsg, function () { return commit(changes, message); });
        if (!r.ok) {
            // после ошибки состояние могло измениться — освежим дерево тихо
            return false;
        }
        toast('Готово · коммит ' + String(r.v || '').slice(0, 7));
        renderAll(true);
        return true;
    }

    // ======================================================================
    // Действия менеджера
    // ======================================================================
    function selectedPaths() { return Array.from(S.panes[S.active].sel); }
    function hint() { toast('Отметьте файлы: нажмите на значок слева от имени или удерживайте строку', 3200); }
    function blobsUnder(path) {
        var ent = S.entries.get(path), out = [];
        if (!ent) return out;
        if (ent.type === 'blob') return [ent];
        var pre = path + '/';
        S.entries.forEach(function (e) { if (e.type === 'blob' && e.path.indexOf(pre) === 0) out.push(e); });
        return out;
    }

    async function actDelete() {
        var paths = selectedPaths();
        if (!paths.length) return hint();
        var total = 0, changes = [];
        paths.forEach(function (p) { blobsUnder(p).forEach(function (b) { changes.push({ path: b.path, del: true }); total++; }); });
        if (!total) { toast('Нечего удалять'); return; }
        var ok = await confirmBox('Удалить?', shortNames(paths) + '\nФайлов: ' + total +
            '\n\nБудет создан коммит. Удалённое можно восстановить из истории Git.', 'Удалить', true);
        if (!ok) return;
        if (await doCommit('Удаление…', changes, 'удалено ' + shortNames(paths))) S.panes[S.active].sel.clear();
        renderAll(true);
    }

    async function actTransfer(move) {
        var src = S.active, dst = 1 - src;
        var paths = selectedPaths();
        if (!paths.length) return hint();
        var srcDir = S.panes[src].path, destDir = S.panes[dst].path;
        if (srcDir === destDir) { toast('Откройте в другой панели папку назначения', 3000); return; }
        var changes = [], conflicts = 0, i, j;
        for (i = 0; i < paths.length; i++) {
            var p = paths[i], ent = S.entries.get(p);
            if (!ent) continue;
            if (ent.type === 'tree' && (destDir === p || destDir.indexOf(p + '/') === 0)) {
                toast('Нельзя поместить папку «' + baseOf(p) + '» внутрь неё самой', 3200);
                return;
            }
            var top = join(destDir, baseOf(p)), ex = S.entries.get(top);
            if (ex && ex.type !== ent.type) { toast('«' + baseOf(p) + '»: в папке назначения уже есть элемент другого типа', 3500); return; }
            var bl = blobsUnder(p);
            for (j = 0; j < bl.length; j++) {
                var np = top + bl[j].path.slice(p.length);
                if (S.entries.has(np)) conflicts++;
                changes.push({ path: np, sha: bl[j].sha, mode: bl[j].mode });
                if (move) changes.push({ path: bl[j].path, del: true });
            }
        }
        if (!changes.length) return;
        var where = destDir ? '/' + destDir : 'корень репозитория';
        var ok = await confirmBox(move ? 'Переместить?' : 'Копировать?',
            shortNames(paths) + '\n→ ' + where + (conflicts ? '\n\n⚠ Существующих файлов будет заменено: ' + conflicts : '') +
            '\n\nБудет создан один коммит.', move ? 'Переместить' : 'Копировать', false);
        if (!ok) return;
        var done = await doCommit(move ? 'Перемещение…' : 'Копирование…', changes,
            (move ? 'перемещено ' : 'скопировано ') + shortNames(paths) + ' → ' + (destDir || '/'));
        if (done) S.panes[src].sel.clear();
        renderAll(true);
    }

    async function actRename() {
        var paths = selectedPaths();
        if (paths.length !== 1) { toast('Для переименования выберите один элемент'); return; }
        var p = paths[0], ent = S.entries.get(p);
        if (!ent) return;
        var nv = await askText('Переименовать', baseOf(p), 'Новое имя (можно с путём: a/b.txt)', 'Готово');
        if (nv == null) return;
        nv = cleanPath(nv);
        if (!nv) return;
        var np = join(parentOf(p), nv);
        if (np === p) return;
        if (S.entries.has(np)) { toast('Элемент с таким именем уже существует', 3000); return; }
        if (np.indexOf(p + '/') === 0) { toast('Нельзя переместить элемент внутрь самого себя', 3000); return; }
        var changes = [];
        blobsUnder(p).forEach(function (b) {
            changes.push({ path: np + b.path.slice(p.length), sha: b.sha, mode: b.mode });
            changes.push({ path: b.path, del: true });
        });
        if (await doCommit('Переименование…', changes, 'переименовано ' + baseOf(p) + ' → ' + np)) S.panes[S.active].sel.clear();
        renderAll(true);
    }

    async function actUpload(files) {
        var dir = S.panes[S.active].path, changes = [], names = [], overwrite = 0, big = 0;
        var tooBig = [];
        files.forEach(function (f) { if (f.size > 50 * 1048576) tooBig.push(f.name); });
        if (tooBig.length) { await showError('Слишком большие файлы (больше 50 МБ):\n' + tooBig.join('\n')); files = files.filter(function (f) { return f.size <= 50 * 1048576; }); }
        if (!files.length) return;
        files.forEach(function (f) {
            var nm = baseOf(cleanPath(f.name)) || f.name;
            var path = join(dir, nm);
            if (S.entries.has(path)) overwrite++;
            if (f.size > 20 * 1048576) big++;
            names.push(nm);
        });
        if (overwrite || big) {
            var ok = await confirmBox('Загрузить в ' + (dir ? '/' + dir : 'корень') + '?',
                names.length + ' файл(ов): ' + shortNames(names) +
                (overwrite ? '\n⚠ Будет заменено существующих: ' + overwrite : '') +
                (big ? '\nЕсть крупные файлы — загрузка может занять время.' : ''), 'Загрузить', false);
            if (!ok) return;
        }
        var r = await run('Чтение файлов…', async function () {
            for (var i = 0; i < files.length; i++) {
                var b64 = await readFileB64(files[i]);
                changes.push({ path: join(dir, names[i]), b64: b64 });
            }
        });
        if (!r.ok) return;
        await doCommit('Загрузка на GitHub…', changes, 'загрузка ' + shortNames(names));
    }

    async function actNewFile() {
        var dir = S.panes[S.active].path;
        var nm = await askText('Новый файл', '', 'имя.txt или папка/имя.txt', 'Создать', 'Папка: ' + (dir ? '/' + dir : 'корень'));
        if (nm == null) return;
        nm = cleanPath(nm);
        if (!nm) return;
        var path = join(dir, nm);
        if (S.entries.has(path)) { toast('Такой элемент уже существует', 3000); return; }
        openFile(path);
    }
    async function actNewFolder() {
        var dir = S.panes[S.active].path;
        var nm = await askText('Новая папка', '', 'имя папки', 'Создать', 'Git не хранит пустые папки — внутри будет создан файл .gitkeep');
        if (nm == null) return;
        nm = cleanPath(nm);
        if (!nm) return;
        var path = join(dir, nm);
        if (S.entries.has(path)) { toast('Такой элемент уже существует', 3000); return; }
        var r = await run('Создание папки…', async function () {
            try { return await commit([{ path: join(path, '.gitkeep'), b64: '' }], 'создана папка ' + nm); }
            catch (e) { return await commit([{ path: join(path, '.gitkeep'), b64: btoa('\n') }], 'создана папка ' + nm); }
        });
        if (r.ok) { toast('Папка создана'); renderAll(true); }
    }

    async function actNew() {
        var id = await sheet('Создать', [
            { id: 'file', icon: 'file', label: 'Новый файл' },
            { id: 'dir', icon: 'newfolder', label: 'Новая папка' },
            { id: 'up', icon: 'upload', label: 'Загрузить файлы с устройства' }
        ]);
        if (id === 'file') actNewFile();
        else if (id === 'dir') actNewFolder();
        else if (id === 'up') startUpload();
    }

    // ======================================================================
    // Скачивание на устройство
    // ======================================================================
    var MIME = { txt: 'text/plain', md: 'text/markdown', json: 'application/json', html: 'text/html', htm: 'text/html', css: 'text/css',
        js: 'text/javascript', xml: 'application/xml', csv: 'text/csv', svg: 'image/svg+xml', zip: 'application/zip', pdf: 'application/pdf',
        png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', apk: 'application/vnd.android.package-archive' };
    var MAX_DL = 60 * 1024 * 1024;
    function saveToDevice(name, b64, mime) {
        mime = mime || 'application/octet-stream';
        b64 = String(b64 || '').replace(/\s/g, '');
        if (!b64) { toast('Пустой файл'); return; }
        // RN WebView bridge (async share / MediaStore)
        if (typeof window.__aibSaveFile === 'function') {
            window.__aibSaveFile(name, mime, b64).then(function () {
                toast('Сохранено: ' + name);
            }).catch(function (err) {
                showError('Не удалось сохранить «' + name + '»: ' + ((err && err.message) || err));
            });
            return;
        }
        if (window.AndroidInterface && typeof window.AndroidInterface.saveFile === 'function') {
            window.AndroidInterface.saveFile(name, mime, b64);
            return;
        }
        try {
            var a = document.createElement('a');
            a.href = 'data:' + mime + ';base64,' + b64;
            a.download = name;
            document.body.appendChild(a);
            a.click();
            a.remove();
            toast('Файл скачан: ' + name);
        } catch (e) {
            showError('Скачивание недоступно: ' + ((e && e.message) || e));
        }
    }
    async function actZip() {
        var paths = selectedPaths();
        if (!paths.length) return hint();
        var blobs = [], total = 0;
        paths.forEach(function (p) { blobsUnder(p).forEach(function (b) { blobs.push({ ent: b, root: p }); total += b.size; }); });
        if (!blobs.length) { toast('Нечего упаковывать'); return; }
        if (total > MAX_DL) { await showError('Слишком много данных (' + fmtSize(total) + '). Максимум — ' + fmtSize(MAX_DL) + '.'); return; }
        if (typeof JSZip === 'undefined') { await showError('Не удалось загрузить модуль упаковки ZIP'); return; }
        var z = await run('Упаковка в ZIP…', async function () {
            var zip = new JSZip();
            for (var i = 0; i < blobs.length; i++) {
                $('busyTxt').textContent = 'Упаковка: ' + (i + 1) + ' из ' + blobs.length;
                var b64 = String(await getBlob(blobs[i].ent.sha)).replace(/\s/g, '');
                var par = parentOf(blobs[i].root);
                var rel = par ? blobs[i].ent.path.slice(par.length + 1) : blobs[i].ent.path;
                zip.file(rel, b64, { base64: true });
            }
            $('busyTxt').textContent = 'Создание архива…';
            return zip.generateAsync({ type: 'base64', compression: 'DEFLATE' });
        });
        if (!z.ok) return;
        var name = (paths.length === 1 ? baseOf(paths[0]) : cfg.repo) + '.zip';
        var archivePath = join(parentOf(paths[0]), name);
        var existing = S.entries.get(archivePath);
        if (existing && existing.type !== 'blob') {
            await showError('Нельзя создать архив: папка «' + name + '» уже существует рядом с выбранным элементом.');
            return;
        }
        if (existing) {
            var overwrite = await confirmBox('Заменить архив?', 'Файл «' + archivePath + '» уже существует в репозитории. Он будет заменён новым ZIP в отдельном коммите.', 'Заменить', false);
            if (!overwrite) return;
        }
        var written = await doCommit('Сохранение ZIP в GitHub…', [{ path: archivePath, b64: z.v }], 'создан ZIP ' + name);
        if (written) {
            S.panes[S.active].sel.clear();
            renderAll(true);
            toast('ZIP создан рядом: ' + archivePath);
        }
    }
    async function actDownload() {
        var paths = selectedPaths();
        if (!paths.length) return hint();
        var blobs = [], total = 0;
        paths.forEach(function (p) { blobsUnder(p).forEach(function (b) { blobs.push({ ent: b, root: p }); total += b.size; }); });
        if (!blobs.length) { toast('Нечего скачивать'); return; }
        if (total > MAX_DL) { await showError('Слишком много данных для скачивания (' + fmtSize(total) + '). Максимум за один раз — ' + fmtSize(MAX_DL) + '. Отметьте меньше файлов.'); return; }
        var first = S.entries.get(paths[0]);
        if (paths.length === 1 && first && first.type === 'blob') {
            var r = await run('Загрузка файла…', function () { return getBlob(first.sha); });
            if (!r.ok) return;
            try { saveToDevice(baseOf(first.path), String(r.v).replace(/\s/g, ''), MIME[extOf(first.path)]); }
            catch (e) { showError(String(e.message || e)); }
            return;
        }
        if (typeof JSZip === 'undefined') { await showError('Не удалось загрузить модуль упаковки ZIP'); return; }
        var z = await run('Упаковка в ZIP…', async function () {
            var zip = new JSZip();
            for (var i = 0; i < blobs.length; i++) {
                $('busyTxt').textContent = 'Упаковка: ' + (i + 1) + ' из ' + blobs.length;
                var b64 = String(await getBlob(blobs[i].ent.sha)).replace(/\s/g, '');
                var par = parentOf(blobs[i].root);
                var rel = par ? blobs[i].ent.path.slice(par.length + 1) : blobs[i].ent.path;
                zip.file(rel, b64, { base64: true });
            }
            $('busyTxt').textContent = 'Создание архива…';
            return zip.generateAsync({ type: 'base64', compression: 'DEFLATE' });
        });
        if (!z.ok) return;
        var name = (paths.length === 1 ? baseOf(paths[0]) : cfg.repo) + '.zip';
        try { saveToDevice(name, z.v, 'application/zip'); }
        catch (e) { showError(String(e.message || e)); }
    }
    async function actDownloadCurrent() {
        if (!ED.open) return;
        var ent = S.entries.get(ED.path);
        try {
            if (!ED.media) {
                var t = ta.value.replace(/\n/g, ED.eol === '\r\n' ? '\r\n' : '\n');
                saveToDevice(baseOf(ED.path), textToB64(t), MIME[extOf(ED.path)] || 'text/plain');
                return;
            }
            if (!ent) return;
            var r = await run('Загрузка файла…', function () { return getBlob(ent.sha); });
            if (r.ok) saveToDevice(baseOf(ED.path), String(r.v).replace(/\s/g, ''), MIME[extOf(ED.path)]);
        } catch (e) { showError(String(e.message || e)); }
    }
    // Можно ли покинуть экран (в редакторе нет несохранённых изменений)
    async function canLeave() {
        if (!(ED.open && isDirty())) return true;
        return confirmBox('Несохранённые изменения', 'Черновик останется на устройстве и предложит восстановиться при следующем открытии файла.', 'Уйти', false);
    }

    function startUpload() { var u = $('upInput'); u.value = ''; u.click(); }

    function ghUrl(path, isDir) {
        return 'https://github.com/' + enc(cfg.owner) + '/' + enc(cfg.repo) + '/' + (isDir ? 'tree' : 'blob') + '/' + encPath(S.branch) + (path ? '/' + encPath(path) : '');
    }
    async function actMore() {
        var p = S.panes[S.active], sel = Array.from(p.sel);
        var items = [];
        if (sel.length === 1) items.push({ id: 'rename', icon: 'edit', label: 'Переименовать' });
        if (sel.length) items.push({ id: 'zip', icon: 'archive', label: 'Упаковать в ZIP' });
        items.push({ id: 'all', icon: 'checkbox', label: 'Выбрать всё в папке' });
        if (sel.length) items.push({ id: 'none', icon: 'checkboxoff', label: 'Снять выбор' });
        items.push({ id: 'sort', icon: 'sort', label: 'Сортировка: ' + ({ name: 'по имени', size: 'по размеру', ext: 'по типу' }[S.sort]) });
        items.push({ id: 'gh', icon: 'open', label: 'Открыть на GitHub' });
        items.push({ id: 'path', icon: 'copy', label: 'Копировать путь' });
        items.push({ id: 'same', icon: 'swap', label: 'Открыть эту же папку во второй панели' });
        items.push({ id: 'repos', icon: 'home', label: 'К списку репозиториев' });
        var id = await sheet('Ещё', items);
        if (id === 'repos') { if (await canLeave()) window.location.href = 'repos.html'; }
        else if (id === 'rename') actRename();
        else if (id === 'zip') actZip();
        else if (id === 'all') { (S.children.get(p.path) || []).forEach(function (e) { p.sel.add(e.path); }); renderPane(S.active, true); updateStatus(); }
        else if (id === 'none') { p.sel.clear(); renderPane(S.active, true); updateStatus(); }
        else if (id === 'sort') {
            var s = await sheet('Сортировка', [
                { id: 'name', icon: 'sort', label: 'По имени' },
                { id: 'size', icon: 'sort', label: 'По размеру' },
                { id: 'ext', icon: 'sort', label: 'По типу (расширению)' }
            ]);
            if (s) { S.sort = s; ls('unzipgit_fm_sort', s); renderAll(true); }
        } else if (id === 'gh') {
            var t = sel.length === 1 ? S.entries.get(sel[0]) : null;
            if (t) openExternal(ghUrl(t.path, t.type === 'tree')); else openExternal(ghUrl(p.path, true));
        } else if (id === 'path') {
            copyText(sel.length === 1 ? sel[0] : (p.path || '/'));
        } else if (id === 'same') {
            var o = 1 - S.active;
            goTo(o, p.path);
        }
    }

    // ======================================================================
    // Редактор
    // ======================================================================
    var ta, hl, mk, gutInner, gutter;
    var ED = {
        open: false, path: '', sha: null, isNew: false, orig: '', eol: '\n', media: false,
        hist: [], hp: -1, ht: null, dt: null, rt: 0,
        fs: parseInt(ls('unzipgit_fm_fs'), 10) || 13, LH: 20, CW: 8,
        fCase: false, fRegex: false, matches: [], cur: -1, findOpen: false, ft: null, lines: 0, saving: false
    };

    function applyFont() {
        ED.fs = Math.max(9, Math.min(24, ED.fs));
        ED.LH = Math.round(ED.fs * 1.55);
        document.documentElement.style.setProperty('--fs', ED.fs + 'px');
        document.documentElement.style.setProperty('--lh', ED.LH + 'px');
        var s = document.createElement('span');
        s.className = 'code';
        s.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;left:-9999px;top:0';
        s.textContent = new Array(51).join('M');
        document.body.appendChild(s);
        var w = s.getBoundingClientRect().width / 50;
        s.remove();
        if (w > 2) ED.CW = w;
        ED.lines = -1;
        if (ED.open && !ED.media) renderNow();
    }
    function draftKey() { return 'unzipgit_draft:' + cfg.owner + '/' + cfg.repo + '@' + S.branch + ':' + ED.path; }
    function isDirty() { return ED.open && !ED.media && (ED.isNew ? (ta.value !== '' || ED.touched) : ta.value !== ED.orig); }
    function updateDirtyUI() {
        var d = isDirty();
        $('edDirty').classList.toggle('hidden', !d);
        $('edSave').disabled = ED.media || (!d && !ED.isNew);
    }
    function saveDraftSoon() {
        clearTimeout(ED.dt);
        ED.dt = setTimeout(function () {
            if (!ED.open || ED.media) return;
            if (isDirty() && ta.value.length < 400000) ls(draftKey(), JSON.stringify({ v: ta.value, base: ED.sha }));
            else ls(draftKey(), null);
        }, 800);
    }
    function renderGutter(t) {
        var n = 1, i = -1;
        while ((i = t.indexOf('\n', i + 1)) !== -1) n++;
        if (n === ED.lines) return;
        ED.lines = n;
        var a = new Array(Math.min(n, 200000));
        for (var k = 0; k < a.length; k++) a[k] = k + 1;
        gutInner.textContent = a.join('\n');
        gutter.style.width = (Math.max(3, String(n).length) * ED.CW + 14) + 'px';
    }
    function renderNow() {
        var t = ta.value;
        var useHl = t.length <= MAX_HL && Highlight.langOf(ED.path) !== 'plain';
        hl.innerHTML = (useHl ? Highlight.highlight(t, ED.path) : Highlight.esc(t)) + '\n ';
        renderGutter(t);
        if (ED.findOpen) renderMarks();
        updateStatus2();
        updateDirtyUI();
        syncScroll();
    }
    function scheduleRender() {
        if (ED.rt) return;
        ED.rt = requestAnimationFrame(function () { ED.rt = 0; renderNow(); });
    }
    function syncScroll() {
        var tr = 'translate(' + (-ta.scrollLeft) + 'px,' + (-ta.scrollTop) + 'px)';
        hl.style.transform = tr;
        mk.style.transform = tr;
        gutInner.style.transform = 'translateY(' + (-ta.scrollTop) + 'px)';
    }
    function updateStatus2() {
        if (ED.media) { $('edStatus').textContent = ED.path; return; }
        var pos = ta.selectionStart, v = ta.value;
        var before = v.slice(0, pos), ln = before.split('\n').length, col = pos - before.lastIndexOf('\n');
        var sel = ta.selectionEnd - ta.selectionStart;
        $('edStatus').textContent = 'Стр ' + ln + ', ст ' + col + (sel ? ' (выд. ' + sel + ')' : '') + ' · строк ' + Math.max(ED.lines, 1) +
            ' · ' + Highlight.title(ED.path) + ' · ' + (ED.eol === '\r\n' ? 'CRLF' : 'LF') + ' · ' + fmtSize(v.length);
    }

    // История (undo / redo)
    function histReset(t) { clearTimeout(ED.ht); ED.ht = null; ED.hist = [{ v: t, s: 0, e: 0 }]; ED.hp = 0; }
    function histPush() {
        clearTimeout(ED.ht);
        ED.ht = null;
        var v = ta.value, cur = ED.hist[ED.hp];
        if (cur && cur.v === v) { cur.s = ta.selectionStart; cur.e = ta.selectionEnd; return; }
        ED.hist = ED.hist.slice(0, ED.hp + 1);
        ED.hist.push({ v: v, s: ta.selectionStart, e: ta.selectionEnd });
        var max = v.length > 300000 ? 8 : 150;
        while (ED.hist.length > max) ED.hist.shift();
        ED.hp = ED.hist.length - 1;
    }
    function histSchedule() { clearTimeout(ED.ht); ED.ht = setTimeout(histPush, 600); }
    function applyHist() {
        var h = ED.hist[ED.hp];
        ta.value = h.v;
        try { ta.setSelectionRange(h.s, h.e); } catch (e) { /* ignore */ }
        renderNow();
        saveDraftSoon();
        if (ED.findOpen) findAll();
    }
    function undo() { if (ED.ht) histPush(); if (ED.hp > 0) { ED.hp--; applyHist(); } else toast('Больше нечего отменять', 1200); }
    function redo() { if (ED.hp < ED.hist.length - 1) { ED.hp++; applyHist(); } else toast('Больше нечего повторять', 1200); }

    // Программная правка текста
    function edit(start, end, text, selStart, selEnd) {
        histPush();
        ta.setRangeText(text, start, end, 'end');
        var s = selStart == null ? start + text.length : selStart;
        try { ta.setSelectionRange(s, selEnd == null ? s : selEnd); } catch (e) { /* ignore */ }
        ED.touched = true;
        histPush();
        renderNow();
        saveDraftSoon();
        if (ED.findOpen) scheduleFind();
    }
    function indentSel(out) {
        var v = ta.value, s = ta.selectionStart, e = ta.selectionEnd;
        var ls0 = v.lastIndexOf('\n', s - 1) + 1;
        var le = v.indexOf('\n', e);
        if (le < 0) le = v.length;
        if (e > s && v.charAt(e - 1) === '\n') le = e - 1;
        var lines = v.slice(ls0, le).split('\n');
        var nl = out ? lines.map(function (l) { return l.replace(/^(?:  |\t| )/, ''); })
                     : lines.map(function (l) { return '  ' + l; });
        var joined = nl.join('\n');
        edit(ls0, le, joined, ls0, ls0 + joined.length);
    }
    function pressTab() {
        var v = ta.value, s = ta.selectionStart, e = ta.selectionEnd;
        if (e > s && v.slice(s, e).indexOf('\n') >= 0) indentSel(false);
        else edit(s, e, '  ');
    }
    function onBeforeInput(e) {
        if ((e.inputType !== 'insertLineBreak' && e.inputType !== 'insertParagraph') || e.isComposing || !e.cancelable) return;
        e.preventDefault();
        var v = ta.value, s = ta.selectionStart, en = ta.selectionEnd;
        var lineStart = v.lastIndexOf('\n', s - 1) + 1;
        var ind = /^[ \t]*/.exec(v.slice(lineStart, s))[0];
        var prev = v.charAt(s - 1), next = v.charAt(en);
        var ext = extOf(ED.path);
        var more = /[{(\[]/.test(prev) || (prev === ':' && (ext === 'py' || ext === 'yml' || ext === 'yaml'));
        var ins = '\n' + ind + (more ? '  ' : '');
        if ((prev === '{' && next === '}') || (prev === '(' && next === ')') || (prev === '[' && next === ']')) {
            var caret = s + ins.length;
            edit(s, en, ins + '\n' + ind, caret, caret);
            return;
        }
        edit(s, en, ins);
    }
    function onInput() {
        ED.touched = true;
        scheduleRender();
        histSchedule();
        saveDraftSoon();
        if (ED.findOpen) scheduleFind();
    }

    // Поиск в файле
    function buildRe() {
        var q = $('fInput').value;
        if (!q) return null;
        var src = ED.fRegex ? q : q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        try { return new RegExp(src, 'g' + (ED.fCase ? '' : 'i') + 'm'); } catch (e) { return null; }
    }
    function scheduleFind() { clearTimeout(ED.ft); ED.ft = setTimeout(function () { findAll(); }, 250); }
    function findAll(pick) {
        var re = buildRe(), t = ta.value, m, n = 0;
        ED.matches = [];
        if (re) {
            while ((m = re.exec(t)) !== null && n < 5000) {
                if (m[0] === '') { re.lastIndex++; continue; }
                ED.matches.push([m.index, m.index + m[0].length]);
                n++;
            }
        }
        if (!ED.matches.length) ED.cur = -1;
        else if (pick === 'keep' && ED.cur >= 0 && ED.cur < ED.matches.length) { /* оставляем */ }
        else {
            var caret = ta.selectionStart, idx = 0;
            for (var i = 0; i < ED.matches.length; i++) { if (ED.matches[i][0] >= caret) { idx = i; break; } }
            ED.cur = idx;
        }
        renderMarks();
        updateCount();
    }
    function renderMarks() {
        if (!ED.findOpen || !ED.matches.length) { mk.innerHTML = ''; return; }
        var t = ta.value, out = '', last = 0;
        for (var i = 0; i < ED.matches.length; i++) {
            var a = ED.matches[i][0], b = ED.matches[i][1];
            out += Highlight.esc(t.slice(last, a)) + '<mark' + (i === ED.cur ? ' class="cur"' : '') + '>' + Highlight.esc(t.slice(a, b)) + '</mark>';
            last = b;
        }
        mk.innerHTML = out + Highlight.esc(t.slice(last)) + '\n ';
    }
    function updateCount() {
        $('fCount').textContent = ED.matches.length ? ((ED.cur + 1) + '/' + ED.matches.length) : '0/0';
    }
    function reveal(idx) {
        var t = ta.value, line = 0, i = t.indexOf('\n');
        while (i !== -1 && i < idx) { line++; i = t.indexOf('\n', i + 1); }
        var col = idx - (t.lastIndexOf('\n', idx - 1) + 1);
        ta.scrollTop = Math.max(0, line * ED.LH - ta.clientHeight / 3);
        var x = col * ED.CW;
        if (x < ta.scrollLeft || x > ta.scrollLeft + ta.clientWidth - 80) ta.scrollLeft = Math.max(0, x - ta.clientWidth / 3);
        syncScroll();
    }
    function gotoMatch(d) {
        if (!ED.matches.length) return;
        ED.cur = (ED.cur + d + ED.matches.length) % ED.matches.length;
        var m = ED.matches[ED.cur];
        try { ta.setSelectionRange(m[0], m[1]); } catch (e) { /* ignore */ }
        renderMarks();
        updateCount();
        reveal(m[0]);
    }
    function openFind(q) {
        ED.findOpen = true;
        $('findBar').classList.remove('hidden');
        if (q != null) $('fInput').value = q;
        findAll();
        if (q == null) $('fInput').focus();
    }
    function closeFind() {
        ED.findOpen = false;
        $('findBar').classList.add('hidden');
        mk.innerHTML = '';
    }
    function replaceOne() {
        if (ED.cur < 0) { toast('Совпадений нет', 1200); return; }
        var m = ED.matches[ED.cur], re = buildRe(), rep = $('rInput').value, out = rep;
        if (ED.fRegex && re) out = ta.value.slice(m[0], m[1]).replace(new RegExp(re.source, re.flags.replace('g', '')), rep);
        edit(m[0], m[1], out, m[0] + out.length);
        findAll();
        if (ED.matches.length) gotoMatch(0);
    }
    function replaceAll() {
        var re = buildRe();
        if (!re || !ED.matches.length) { toast('Совпадений нет', 1200); return; }
        var rep = $('rInput').value, n = ED.matches.length, t = ta.value;
        var nt = ED.fRegex ? t.replace(re, rep) : t.replace(re, function () { return rep; });
        edit(0, t.length, nt, 0, 0);
        findAll();
        toast('Заменено: ' + n);
    }

    // Открытие / закрытие / сохранение
    function setMode(mode) {
        var media = mode === 'media';
        $('edStack').classList.toggle('hidden', media);
        $('gutter').classList.toggle('hidden', media);
        $('keysRow').classList.toggle('hidden', media);
        $('edMedia').classList.toggle('hidden', !media);
        ['edUndo', 'edRedo', 'edFind'].forEach(function (id) { $(id).classList.toggle('hidden', media); });
        $('edSave').classList.toggle('hidden', media);
    }
    function showEditorShell(path) {
        ED.open = true;
        ED.path = path;
        $('edName').textContent = baseOf(path);
        $('edPath').textContent = path;
        $('editor').classList.remove('hidden');
    }
    async function openFile(path, opts) {
        opts = opts || {};
        if (ED.open) { var ok = await closeEditor(); if (!ok) return; }
        var ent = S.entries.get(path), ext = extOf(path), text = '', b64 = null;
        if (ent && ent.type === 'tree') return;
        if (ent && ent.size > MAX_EDIT) {
            var go = await confirmBox('Большой файл', 'Размер ' + fmtSize(ent.size) + ' — редактор рассчитан на файлы до ' + fmtSize(MAX_EDIT) + '. Открыть на GitHub?', 'Открыть', false);
            if (go) openExternal(ghUrl(path, false));
            return;
        }
        if (ent) {
            var r = await run('Загрузка файла…', function () { return getBlob(ent.sha); });
            if (!r.ok) return;
            b64 = r.v;
        }
        ED.isNew = !ent;
        ED.sha = ent ? ent.sha : null;
        ED.touched = false;
        ED.media = false;
        if (ent && IMG[ext]) {
            ED.media = true;
            showEditorShell(path);
            setMode('media');
            var box = $('edMedia');
            box.textContent = '';
            var img = document.createElement('img');
            img.src = 'data:' + IMG[ext] + ';base64,' + String(b64).replace(/\s/g, '');
            box.appendChild(img);
            box.appendChild(el('div', '', fmtSize(ent.size)));
            updateStatus2();
            return;
        }
        if (ent) {
            var t = bytesToText(b64ToBytes(b64));
            if (t === null) {
                ED.media = true;
                showEditorShell(path);
                setMode('media');
                $('edMedia').textContent = 'Бинарный файл (' + fmtSize(ent.size) + ') — редактирование недоступно.';
                updateStatus2();
                return;
            }
            text = t;
        }
        ED.eol = text.indexOf('\r\n') >= 0 ? '\r\n' : '\n';
        text = text.replace(/\r\n/g, '\n');
        ED.orig = text;
        // черновик
        var dr = null;
        try { dr = JSON.parse(ls(draftKeyFor(path)) || 'null'); } catch (e) { dr = null; }
        showEditorShell(path);
        setMode('text');
        ta.value = text;
        ED.lines = -1;
        histReset(text);
        ta.scrollTop = 0; ta.scrollLeft = 0;
        closeFind();
        renderNow();
        if (dr && typeof dr.v === 'string' && dr.v !== text && dr.base === ED.sha) {
            var restore = await confirmBox('Найден черновик', 'В прошлый раз в этом файле остались несохранённые изменения. Восстановить?', 'Восстановить', false);
            if (restore) { ta.value = dr.v; ED.touched = true; histPush(); renderNow(); }
            else ls(draftKeyFor(path), null);
        }
        if (opts.find) openFind(opts.find);
        if (opts.line) {
            var v = ta.value, pos = 0;
            for (var l = 1; l < opts.line; l++) { var nx = v.indexOf('\n', pos); if (nx < 0) break; pos = nx + 1; }
            var end = v.indexOf('\n', pos); if (end < 0) end = v.length;
            try { ta.setSelectionRange(pos, end); } catch (e) { /* ignore */ }
            reveal(pos);
            if (opts.find) { findAll(); }
        }
        updateStatus2();
    }
    function draftKeyFor(path) { return 'unzipgit_draft:' + cfg.owner + '/' + cfg.repo + '@' + S.branch + ':' + path; }

    function hideEditor() {
        ED.open = false;
        ED.media = false;
        closeFind();
        $('editor').classList.add('hidden');
        ta.value = '';
        hl.innerHTML = '';
        mk.innerHTML = '';
        $('edMedia').textContent = '';
        ED.hist = [];
    }
    // Возвращает true, если редактор закрыт
    async function closeEditor() {
        if (!ED.open) return true;
        if (isDirty()) {
            var a = await sheet('Есть несохранённые изменения', [
                { id: 'save', icon: 'check', label: 'Сохранить и закрыть' },
                { id: 'discard', icon: 'del', label: 'Закрыть без сохранения', danger: true }
            ]);
            if (a === 'save') { var ok = await saveFile(); if (!ok) return false; }
            else if (a === 'discard') { ls(draftKey(), null); }
            else return false;
        }
        hideEditor();
        renderAll(true);
        return true;
    }
    async function saveFile() {
        if (!ED.open || ED.media || ED.saving) return false;
        if (!isDirty() && !ED.isNew) { toast('Нет изменений', 1200); return true; }
        ED.saving = true;
        var text = ta.value, path = ED.path;
        var body = ED.eol === '\r\n' ? text.replace(/\n/g, '\r\n') : text;
        var msg = commitMsg((ED.isNew ? 'создан ' : 'изменён ') + path);
        var r = await run('Сохранение…', async function () {
            var b64 = textToB64(body);
            var res = await putContents(path, b64, msg, ED.isNew ? null : ED.sha);
            if (!res.ok && (res.status === 409 || res.status === 422)) {
                var cur = await currentSha(path);
                var q = ED.isNew
                    ? 'Файл «' + path + '» уже существует на GitHub. Заменить его?'
                    : 'Файл на GitHub был изменён с момента открытия. Перезаписать вашей версией?';
                if (cur === ED.sha && !ED.isNew) throw new Error(errMsg(res));
                if (!(await confirmBox('Конфликт версий', q, 'Перезаписать', true))) return null;
                res = await putContents(path, b64, msg, cur);
            }
            if (!res.ok) throw new Error(errMsg(res));
            return res.data;
        });
        ED.saving = false;
        if (!r.ok || !r.v) return false;
        var d = r.v, wasNew = ED.isNew;
        ED.sha = d.content && d.content.sha ? d.content.sha : ED.sha;
        ED.orig = text;
        ED.isNew = false;
        ED.touched = false;
        ls(draftKey(), null);
        var ent = S.entries.get(path);
        if (ent && !wasNew) { ent.sha = ED.sha; ent.size = new TextEncoder().encode(body).length; }
        else if (d.commit && d.commit.tree) { try { await reloadTree(d.commit.tree.sha); } catch (e) { /* обновится вручную */ } }
        updateDirtyUI();
        toast('Сохранено · коммит ' + (d.commit ? String(d.commit.sha).slice(0, 7) : ''));
        return true;
    }
    async function edMenu() {
        var id = await sheet(baseOf(ED.path), [
            { id: 'dl', icon: 'download', label: 'Скачать файл' },
            { id: 'goto', icon: 'code', label: 'Перейти к строке' },
            { id: 'fpl', icon: 'A+', label: 'Крупнее шрифт' },
            { id: 'fmi', icon: 'A−', label: 'Мельче шрифт' },
            { id: 'gh', icon: 'open', label: 'Открыть на GitHub' },
            { id: 'path', icon: 'copy', label: 'Копировать путь' }
        ]);
        if (id === 'dl') { actDownloadCurrent(); return; }
        if (id === 'goto') {
            var v = await askText('Перейти к строке', '', 'Номер строки (1–' + ED.lines + ')', 'Перейти');
            var n = parseInt(v, 10);
            if (n > 0) {
                var t = ta.value, pos = 0;
                for (var l = 1; l < n; l++) { var nx = t.indexOf('\n', pos); if (nx < 0) break; pos = nx + 1; }
                try { ta.setSelectionRange(pos, pos); } catch (e) { /* ignore */ }
                reveal(pos);
                updateStatus2();
            }
        } else if (id === 'fpl' || id === 'fmi') {
            ED.fs += id === 'fpl' ? 1 : -1;
            ls('unzipgit_fm_fs', String(ED.fs));
            applyFont();
        } else if (id === 'gh') openExternal(ghUrl(ED.path, false));
        else if (id === 'path') copyText(ED.path);
    }
    function wireEditor() {
        ta = $('edTa'); hl = $('layerHl'); mk = $('layerMarks'); gutInner = $('gutterInner'); gutter = $('gutter');
        ta.addEventListener('input', onInput);
        ta.addEventListener('scroll', syncScroll);
        ta.addEventListener('beforeinput', onBeforeInput);
        ta.addEventListener('keyup', updateStatus2);
        ta.addEventListener('click', updateStatus2);
        document.addEventListener('selectionchange', function () { if (ED.open && document.activeElement === ta) updateStatus2(); });
        $('edBack').onclick = function () { closeEditor(); };
        $('edSave').onclick = function () { saveFile(); };
        $('edUndo').onclick = undo;
        $('edRedo').onclick = redo;
        $('edMore').onclick = edMenu;
        $('edFind').onclick = function () { if (ED.findOpen) closeFind(); else openFind(); };
        $('fClose').onclick = closeFind;
        $('fNext').onclick = function () { gotoMatch(1); };
        $('fPrev').onclick = function () { gotoMatch(-1); };
        $('fRep').onclick = replaceOne;
        $('fRepAll').onclick = replaceAll;
        $('fCase').onclick = function () { ED.fCase = !ED.fCase; this.classList.toggle('on', ED.fCase); findAll(); };
        $('fRegex').onclick = function () { ED.fRegex = !ED.fRegex; this.classList.toggle('on', ED.fRegex); findAll(); };
        $('fInput').addEventListener('input', function () { findAll(); if (ED.matches.length) gotoMatch(0); });
        $('fInput').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); gotoMatch(e.shiftKey ? -1 : 1); } });
        var kr = $('keysRow');
        kr.addEventListener('mousedown', function (e) { e.preventDefault(); });
        kr.addEventListener('click', function (e) {
            var b = e.target.closest('button');
            if (!b || ED.media) return;
            if (b.dataset.k === 'tab') pressTab();
            else if (b.dataset.k === 'outdent') indentSel(true);
            else if (b.dataset.ins != null) edit(ta.selectionStart, ta.selectionEnd, b.dataset.ins);
        });
        applyFont();
    }

    // ======================================================================
    // Поиск по репозиторию
    // ======================================================================
    var SR = { open: false, mode: 'name', scope: 'all', token: 0, running: false };

    function openSearch() {
        SR.open = true;
        $('search').classList.remove('hidden');
        $('sInput').focus();
    }
    function closeSearch() {
        SR.open = false;
        SR.token++;
        $('search').classList.add('hidden');
    }
    function setChips() {
        $('sModeName').classList.toggle('on', SR.mode === 'name');
        $('sModeText').classList.toggle('on', SR.mode === 'text');
        $('sScopeAll').classList.toggle('on', SR.scope === 'all');
        $('sScopeDir').classList.toggle('on', SR.scope === 'dir');
        $('sInput').placeholder = SR.mode === 'name' ? 'Имя файла или папки' : 'Текст внутри файлов';
    }
    function scopePrefix() { return SR.scope === 'dir' ? S.panes[S.active].path : ''; }
    function inScope(path, pre) { return !pre || path === pre || path.indexOf(pre + '/') === 0; }
    function setBar(p) { $('sBar').firstElementChild.style.width = Math.round(p * 100) + '%'; }

    function runSearch() {
        var q = $('sInput').value.trim();
        SR.token++;
        $('sList').textContent = '';
        setBar(0);
        if (!q) { $('sInfo').textContent = 'Введите запрос'; return; }
        if (SR.mode === 'name') searchNames(q); else searchText(q);
    }
    function searchNames(q) {
        var pre = scopePrefix(), toks = q.toLowerCase().split(/\s+/).filter(Boolean), out = [];
        S.entries.forEach(function (e) {
            if (!inScope(e.path, pre)) return;
            var lp = e.path.toLowerCase(), ok = true;
            for (var i = 0; i < toks.length; i++) if (lp.indexOf(toks[i]) < 0) { ok = false; break; }
            if (ok) out.push(e);
        });
        var ql = toks[0] || '';
        out.sort(function (a, b) {
            var an = baseOf(a.path).toLowerCase().indexOf(ql) >= 0 ? 0 : 1;
            var bn = baseOf(b.path).toLowerCase().indexOf(ql) >= 0 ? 0 : 1;
            if (an !== bn) return an - bn;
            return natCmp(a.path, b.path);
        });
        var shown = out.slice(0, 300), list = $('sList');
        shown.forEach(function (e) {
            var r = el('div', 'res');
            var p = el('div', 'rp');
            var pi = el('span', 'rpi');
            pi.innerHTML = window.MI(iconFor(e), 16);
            p.appendChild(pi);
            p.appendChild(document.createTextNode(' ' + (parentOf(e.path) ? parentOf(e.path) + '/' : '')));
            p.appendChild(el('b', '', baseOf(e.path)));
            r.appendChild(p);
            r.onclick = function () { closeSearch(); revealEntry(e); };
            list.appendChild(r);
        });
        $('sInfo').textContent = out.length ? ('Найдено: ' + out.length + (out.length > 300 ? ' (показано 300)' : '')) : 'Ничего не найдено';
    }
    function revealEntry(e) {
        if (e.type === 'tree') { goTo(S.active, e.path); return; }
        goTo(S.active, parentOf(e.path));
        S.panes[S.active].sel.clear();
        openFile(e.path);
    }
    function isSearchable(e) {
        return e.type === 'blob' && e.size <= 400 * 1024 && !BIN_EXT[extOf(e.path)];
    }
    async function getText(ent) {
        if (S.textCache.has(ent.sha)) return S.textCache.get(ent.sha);
        var r = await gh('GET', repoBase() + '/git/blobs/' + ent.sha, undefined, { parallel: true });
        var t = null;
        if (r.ok && r.data && r.data.content) t = bytesToText(b64ToBytes(r.data.content));
        if (S.textCache.size > 800) S.textCache.clear();
        S.textCache.set(ent.sha, t);
        return t;
    }
    async function searchText(q) {
        var my = SR.token, pre = scopePrefix(), needle = q.toLowerCase();
        var cands = [];
        S.entries.forEach(function (e) { if (isSearchable(e) && inScope(e.path, pre)) cands.push(e); });
        cands.sort(function (a, b) { return natCmp(a.path, b.path); });
        var LIMIT = 600, skipped = Math.max(0, cands.length - LIMIT);
        cands = cands.slice(0, LIMIT);
        if (!cands.length) { $('sInfo').textContent = 'Нет текстовых файлов для поиска'; return; }
        var list = $('sList'), idx = 0, done = 0, found = 0, lineCount = 0;
        SR.running = true;
        $('sInfo').textContent = 'Проверено 0/' + cands.length;
        function addResult(ent, hits) {
            var r = el('div', 'res');
            var p = el('div', 'rp');
            p.appendChild(document.createTextNode((parentOf(ent.path) ? parentOf(ent.path) + '/' : '')));
            p.appendChild(el('b', '', baseOf(ent.path)));
            p.appendChild(document.createTextNode('  ·  ' + hits.total));
            r.appendChild(p);
            hits.lines.forEach(function (h) {
                var l = el('div', 'rl');
                l.appendChild(el('i', '', h.n + ': '));
                l.appendChild(document.createTextNode(h.t));
                l.onclick = function (ev) { ev.stopPropagation(); closeSearch(); goTo(S.active, parentOf(ent.path)); openFile(ent.path, { line: h.n, find: q }); };
                r.appendChild(l);
            });
            r.onclick = function () { closeSearch(); goTo(S.active, parentOf(ent.path)); openFile(ent.path, { line: hits.lines[0].n, find: q }); };
            list.appendChild(r);
        }
        async function worker() {
            while (my === SR.token) {
                var i = idx++;
                if (i >= cands.length) return;
                var ent = cands[i], text = null;
                try { text = await getText(ent); } catch (e) { text = null; }
                if (my !== SR.token) return;
                done++;
                if (text != null && text.toLowerCase().indexOf(needle) >= 0) {
                    var lines = text.split('\n'), hits = { total: 0, lines: [] };
                    for (var k = 0; k < lines.length; k++) {
                        if (lines[k].toLowerCase().indexOf(needle) >= 0) {
                            hits.total++;
                            if (hits.lines.length < 5) hits.lines.push({ n: k + 1, t: lines[k].trim().slice(0, 140) });
                        }
                    }
                    if (hits.total && lineCount < 400) { found++; lineCount += hits.lines.length; addResult(ent, hits); }
                }
                if (done % 5 === 0 || done === cands.length) {
                    setBar(done / cands.length);
                    $('sInfo').textContent = 'Проверено ' + done + '/' + cands.length + ' · найдено файлов: ' + found;
                }
            }
        }
        var ws = [];
        for (var w = 0; w < 4; w++) ws.push(worker());
        await Promise.all(ws);
        if (my !== SR.token) return;
        SR.running = false;
        setBar(1);
        $('sInfo').textContent = (found ? 'Готово · файлов с совпадениями: ' + found : 'Ничего не найдено') +
            (skipped ? ' · проверены первые ' + LIMIT + ' файлов, сузьте область поиска' : '');
    }
    function wireSearch() {
        $('btnSearch').onclick = openSearch;
        $('sBack').onclick = closeSearch;
        $('sGo').onclick = runSearch;
        $('sInput').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); runSearch(); $('sInput').blur(); } });
        var deb = null;
        $('sInput').addEventListener('input', function () {
            if (SR.mode !== 'name') return;
            clearTimeout(deb);
            deb = setTimeout(runSearch, 250);
        });
        $('sModeName').onclick = function () { SR.mode = 'name'; setChips(); runSearch(); };
        $('sModeText').onclick = function () { SR.mode = 'text'; setChips(); if ($('sInput').value.trim()) runSearch(); };
        $('sScopeAll').onclick = function () { SR.scope = 'all'; setChips(); if ($('sInput').value.trim()) runSearch(); };
        $('sScopeDir').onclick = function () { SR.scope = 'dir'; setChips(); if ($('sInput').value.trim()) runSearch(); };
        setChips();
    }

    // ======================================================================
    // Подключение / инициализация
    // ======================================================================
    function showSetup(err) {
        $('suUser').value = ls('unzipgit_username');
        $('suRepo').value = ls('unzipgit_repo');
        var hasTok = !!ls('unzipgit_token');
        $('suToken').value = '';
        $('suToken').placeholder = hasTok
            ? 'Токен уже сохранён — можно не вводить снова'
            : 'ghp_… или github_pat_…';
        var h = $('setupHist');
        h.textContent = '';
        try {
            var hist = JSON.parse(ls('unzipgit_repo_history') || '[]');
            (Array.isArray(hist) ? hist : []).forEach(function (item) {
                var b = el('button', 'chip', item);
                b.onclick = function () {
                    var parts = item.split('/');
                    $('suUser').value = parts[0] || '';
                    $('suRepo').value = parts.slice(1).join('/');
                };
                h.appendChild(b);
            });
        } catch (e) { /* ignore */ }
        var er = $('setupErr');
        er.textContent = err || '';
        er.classList.toggle('hidden', !err);
        $('suCancel').classList.toggle('hidden', !S.connected);
        $('setup').classList.remove('hidden');
    }
    function hideSetup() { $('setup').classList.add('hidden'); }
    function fillBranches() {
        var sel = $('branchSel');
        sel.textContent = '';
        S.branches.forEach(function (b) {
            var o = el('option', '', b);
            o.value = b;
            if (b === S.branch) o.selected = true;
            sel.appendChild(o);
        });
    }
    async function init(keepPanes) {
        readCfg();
        if (!cfg.owner || !cfg.repo || !cfg.token) { showSetup(); return; }
        hideSetup();
        $('repoLabel').textContent = cfg.owner + '/' + cfg.repo;
        var r = await run('Загрузка репозитория…', loadRepo);
        if (!r.ok) { S.connected = false; showSetup('Не удалось подключиться. Проверьте имя, репозиторий и токен.'); return; }
        S.connected = true;
        fillBranches();
        if (!keepPanes) {
            var start = cfg.root && S.children.has(cfg.root) ? cfg.root : '';
            [0, 1].forEach(function (i) {
                S.panes[i].path = start;
                S.panes[i].sel.clear();
                S.panes[i].hist = [start];
                S.panes[i].histIdx = 0;
            });
        }
        renderAll(false);
        updateNavBtns(0);
        updateNavBtns(1);
        if (S.truncated) toast('Репозиторий очень большой: GitHub вернул неполное дерево', 4000);
    }
    async function refresh() {
        if (!S.connected) return init();
        var r = await run('Обновление…', loadTree);
        if (r.ok) { renderAll(true); toast('Обновлено', 1200); }
    }

    function wireMain() {
        wirePane(0);
        wirePane(1);
        $('bbUpload').onclick = startUpload;
        $('bbDownload').onclick = actDownload;
        $('repoLabel').onclick = async function () { if (await canLeave()) window.location.href = 'repos.html'; };
        $('suRepos').onclick = function () { window.location.href = 'repos.html'; };
        $('bbNew').onclick = actNew;
        $('bbCopy').onclick = function () { actTransfer(false); };
        $('bbMove').onclick = function () { actTransfer(true); };
        $('bbDelete').onclick = actDelete;
        $('bbMore').onclick = actMore;
        $('btnRefresh').onclick = refresh;
        $('btnSettings').onclick = function () { showSetup(); };
        $('upInput').addEventListener('change', function () {
            var files = Array.from(this.files || []);
            if (files.length) actUpload(files);
        });
        $('branchSel').addEventListener('change', async function () {
            var b = this.value;
            var prev = S.branch;
            S.branch = b;
            ls(branchKey(), b);
            var r = await run('Переключение ветки…', loadTree);
            if (!r.ok) { S.branch = prev; ls(branchKey(), prev); fillBranches(); return; }
            S.panes.forEach(function (p) { p.sel.clear(); });
            renderAll(false);
        });
        $('suOk').onclick = async function () {
            if (setupSubmitting) return;
            setupSubmitting = true;
            var submit = $('suOk');
            if (submit) submit.disabled = true;
            var er = $('setupErr');
            try {
                var u = $('suUser').value.trim(), rp = $('suRepo').value.trim(), t = cleanTokenInput($('suToken').value);
                var savedTok = ls('unzipgit_token').trim();
                var msg = '';
                if (!u || !/^[A-Za-z0-9_.-]+$/.test(u)) msg = 'Введите имя пользователя GitHub';
                else if (!rp || !/^[A-Za-z0-9_.-]+(\/.*)?$/.test(rp)) msg = 'Введите название репозитория';
                else if (!t && !savedTok) msg = 'Введите токен доступа';
                if (msg) { er.textContent = msg; er.classList.remove('hidden'); return; }

                // Verify the candidate (or the already stored token) without
                // changing SecureStore or account/repository settings first.
                var candidate = t || savedTok;
                var checked = await run('Проверка токена…', async function () {
                    return verifyThenSaveSetupToken(candidate, !!t);
                }, 18000, { silent: true });
                if (!checked.ok) { er.textContent = checked.error || 'Не удалось проверить токен.'; er.classList.remove('hidden'); return; }
                ls('unzipgit_username', u);
                ls('unzipgit_repo', rp);
                S.connected = false;
                await init(false);
            } catch (e) {
                er.textContent = safeRequestError((e && e.message) || e);
                er.classList.remove('hidden');
            } finally {
                setupSubmitting = false;
                if (submit) submit.disabled = false;
            }
        };
        $('suCancel').onclick = hideSetup;
    }

    // Вызывается из Android (кнопка «Назад» и выход из экрана)
    window.__onBack = function () {
        if (!$('modalWrap').classList.contains('hidden')) { modalCancel(); return true; }
        if (!$('sheetWrap').classList.contains('hidden')) { closeSheet(); return true; }
        if (!$('busy').classList.contains('hidden')) return true;
        if (!$('setup').classList.contains('hidden')) { if (S.connected) { hideSetup(); return true; } return false; }
        if (ED.open) { if (ED.findOpen) { closeFind(); return true; } closeEditor(); return true; }
        if (SR.open) { closeSearch(); return true; }
        var p = S.panes[S.active];
        if (p.sel.size) { p.sel.clear(); renderPane(S.active, true); updateStatus(); return true; }
        if (p.histIdx > 0) { navBack(S.active); return true; }
        if (p.path) { goTo(S.active, parentOf(p.path)); return true; }
        return false;
    };
    window.__hasUnsaved = function () { return !!(ED.open && isDirty()); };

    document.addEventListener('DOMContentLoaded', function () {
        Array.prototype.forEach.call(document.querySelectorAll('[data-i]'), function (n) { n.innerHTML = window.MI(n.getAttribute('data-i'), 22); });
        // Back / forward icons for path history
        [0, 1].forEach(function (i) {
            var b = document.getElementById('navBack' + i), f = document.getElementById('navFwd' + i);
            if (b) { b.innerHTML = window.MI('back', 20); b.onclick = function () { navBack(i); }; }
            if (f) {
                // mirror of back for forward
                f.innerHTML = '<svg class="mi" width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M4,11h12.17l-5.59,-5.59L12,4l8,8 -8,8 -1.41,-1.41L16.17,13H4v-2z"/></svg>';
                f.onclick = function () { navFwd(i); };
            }
            updateNavBtns(i);
        });
        wireEditor();
        wireSearch();
        wireMain();
        init(false);
    });
    window.addEventListener('aib-secrets-ready', function () {
        var retry = function () { if (!S.connected) init(false); };
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', retry, { once: true });
        else retry();
    });
})();
