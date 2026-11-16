// Общие функции для экранов «Репозитории» и «Токены»: хранилище, сеть GitHub, диалоги.
(function () {
    'use strict';
    var $ = function (id) { return document.getElementById(id); };
    var enc = encodeURIComponent;
    // Журнал стадий для диагностики: хранится в памяти, дублируется в лог приложения (без токенов и заголовков).
    var TRACE = [], T0 = Date.now();
    function trace(s) {
        var line = ((Date.now() - T0) / 1000).toFixed(1) + 's ' + String(s).replace(/\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]+/g, '[скрыто]').slice(0, 160);
        TRACE.push(line);
        if (TRACE.length > 60) TRACE.shift();
        try { if (typeof window.__aibLog === 'function') window.__aibLog(line); } catch (e) { /* ignore */ }
    }
    function traceTail(n) { return TRACE.slice(-(n || 14)).join('\n'); }
    function shortPath(u) { return String(u || '').replace(/^https:\/\/[^/]+/, '').split('?')[0].slice(0, 60); }

    function secretGet(k) {
        try { if (window.AndroidInterface && typeof window.AndroidInterface.secretGet === 'function') return window.AndroidInterface.secretGet(k) || ''; } catch (e) {}
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
    function showMigrationFailure() {
        try {
            if (window.AndroidInterface && typeof window.AndroidInterface.showToast === 'function')
                window.AndroidInterface.showToast('Старый токен убран из постоянного хранилища, но не активирован. Введите его снова или повторите подключение; незаписанная копия доступна только до закрытия текущего сеанса.');
        } catch (e) {}
    }
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
    function clearLegacyAfter(k, result) {
        function clear(ok) { if (ok) { clearLegacySecret(k); clearPendingSecret(k); } }
        if (result && typeof result.then === 'function') result.then(clear);
        else if (result === true) clear(true);
    }
    function migrateLegacySecret(k, legacy) {
        if (!legacy || migrationInFlight[k] || migrationDeclined[k]) return;
        // Keep a RAM-only copy while native write is in flight; disk copies are removed only after
        // verified secure persistence or an explicit in-memory session-only acceptance.
        pendingLegacyMemory[k] = legacy;
        migrationInFlight[k] = true;
        var result = secretSet(k, legacy, true);
        function finish(ok) {
            delete migrationInFlight[k];
            if (ok) { clearLegacySecret(k); clearPendingSecret(k); signalSecretsReady(); }
            else {
                clearLegacySecret(k);
                migrationDeclined[k] = true;
                showMigrationFailure();
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
    function ls(k, v) {
        if (k === 'unzipgit_token' || k === 'unzipgit_tokens' || k === 'unzipgit_apikeys') {
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
                clearLegacyAfter(k, deleted);
                return deleted;
            }
            var saved = secretSet(k, v);
            clearLegacyAfter(k, saved);
            return saved;
        }
        try {
            if (v === undefined) return localStorage.getItem(k) || '';
            if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v);
        } catch (e) { /* ignore */ }
        return '';
    }
    function secretJson(k, def) {
        try { var v = secretGet(k); return v ? JSON.parse(v) : def; } catch (e) { return def; }
    }
    function saveSecretJson(k, value) { return secretSet(k, JSON.stringify(value)); }
    function lsJson(k, def) {
        try { var v = JSON.parse(ls(k) || 'null'); return v == null ? def : v; } catch (e) { return def; }
    }
    function el(tag, cls, text) {
        var e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text != null) e.textContent = text;
        return e;
    }
    function icon(name, size) { var s = document.createElement('span'); s.innerHTML = window.MI(name, size); return s.firstChild; }
    function iconBtn(name, cls, label, fn) {
        var b = el('button', 'ibtn ' + (cls || ''));
        b.setAttribute('aria-label', label || name);
        b.title = label || '';
        b.appendChild(icon(name, 22));
        if (fn) b.onclick = fn;
        return b;
    }
    function btn(cls, iconName, label, fn) {
        var b = el('button', 'btn ' + (cls || ''));
        if (iconName) b.appendChild(icon(iconName, 18));
        b.appendChild(document.createTextNode(label));
        if (fn) b.onclick = fn;
        return b;
    }

    var toastT = null;
    function toast(msg, ms) {
        var t = $('toast');
        t.textContent = msg;
        t.classList.remove('hidden');
        clearTimeout(toastT);
        toastT = setTimeout(function () { t.classList.add('hidden'); }, ms || 2200);
    }
    function openExternal(url) {
        try {
            if (window.AndroidInterface && typeof window.AndroidInterface.openUrl === 'function') { window.AndroidInterface.openUrl(url); return; }
        } catch (e) { /* ignore */ }
        window.open(url, '_blank');
    }
    function copyText(t) {
        function legacy() {
            var a = document.createElement('textarea');
            a.value = t; a.style.cssText = 'position:fixed;opacity:0;left:0;top:0';
            document.body.appendChild(a); a.select();
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
    function mask(t) {
        t = String(t || '');
        if (t.length <= 10) return '••••••••';
        return t.slice(0, 4) + '••••••••••' + t.slice(-4);
    }
    function ago(iso) {
        if (!iso) return '';
        var d = new Date(iso), s = Math.max(0, (Date.now() - d.getTime()) / 1000);
        if (isNaN(s)) return '';
        if (s < 60) return 'только что';
        if (s < 3600) return Math.floor(s / 60) + ' мин. назад';
        if (s < 86400) return Math.floor(s / 3600) + ' ч. назад';
        if (s < 86400 * 30) return Math.floor(s / 86400) + ' дн. назад';
        return d.toLocaleDateString('ru-RU');
    }
    function fmtDate(ts) {
        var d = new Date(ts);
        return isNaN(d.getTime()) ? '' : d.toLocaleDateString('ru-RU') + ' ' + d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    }

    // ---------------- диалоги ----------------
    var modalResolve = null, sheetResolve = null, busyDepth = 0;

    // o: {title, text, fields:[{id,label,type,value,placeholder,hint}], buttons:[{label,val,kind}], validate(values)->string|''}
    function modal(o) {
        return new Promise(function (res) {
            var w = $('modalWrap');
            w.textContent = '';
            var c = el('div', 'mcard');
            c.appendChild(el('h3', '', o.title || ''));
            if (o.text) c.appendChild(el('p', '', o.text));
            var inputs = {};
            (o.fields || []).forEach(function (f) {
                var box = el('div', 'fld' + (f.type === 'checkbox' ? ' chk' : ''));
                var inp, lab = el('label', '', f.label || '');
                if (f.type === 'textarea') { inp = el('textarea'); inp.value = f.value || ''; }
                else if (f.type === 'select') {
                    inp = el('select');
                    (f.options || []).forEach(function (op) { var oe = el('option', '', op.label); oe.value = op.value; if (op.value === f.value) oe.selected = true; inp.appendChild(oe); });
                } else {
                    inp = el('input'); inp.type = f.type === 'password' ? 'password' : (f.type === 'checkbox' ? 'checkbox' : 'text');
                    if (f.type === 'checkbox') inp.checked = !!f.value; else inp.value = f.value || '';
                }
                if (f.placeholder) inp.placeholder = f.placeholder;
                inp.setAttribute('autocapitalize', 'off'); inp.setAttribute('autocorrect', 'off'); inp.setAttribute('autocomplete', 'off'); inp.spellcheck = false;
                inp.id = 'mf_' + f.id;
                lab.setAttribute('for', inp.id);
                inputs[f.id] = { el: inp, type: f.type };
                if (f.type === 'checkbox') { box.appendChild(inp); var lw = el('div'); lw.appendChild(lab); if (f.hint) lw.appendChild(el('div', 'hint', f.hint)); box.appendChild(lw); }
                else { box.appendChild(lab); box.appendChild(inp); if (f.hint) box.appendChild(el('div', 'hint', f.hint)); }
                c.appendChild(box);
            });
            var err = el('p', '', ''); err.style.color = 'var(--danger)'; err.classList.add('hidden');
            c.appendChild(err);
            var bar = el('div', 'mbtns');
            function values() {
                var v = {};
                Object.keys(inputs).forEach(function (k) {
                    var i = inputs[k];
                    v[k] = i.type === 'checkbox' ? i.el.checked : i.el.value;
                });
                return v;
            }
            function done(val) {
                w.classList.add('hidden'); w.textContent = ''; modalResolve = null;
                res({ val: val, values: values() });
            }
            (o.buttons || []).forEach(function (b) {
                var bt = el('button', 'mb ' + (b.kind || ''), b.label);
                bt.onclick = function () {
                    if (b.val != null && o.validate) {
                        var m = o.validate(values());
                        if (m) { err.textContent = m; err.classList.remove('hidden'); return; }
                    }
                    done(b.val);
                };
                bar.appendChild(bt);
            });
            c.appendChild(bar);
            w.appendChild(c);
            w.classList.remove('hidden');
            modalResolve = function () { done(null); };
            w.onclick = function (e) { if (e.target === w) done(null); };
            var first = Object.keys(inputs)[0];
            if (first && inputs[first].type !== 'checkbox') setTimeout(function () { try { inputs[first].el.focus(); } catch (e) { /* ignore */ } }, 80);
        });
    }
    function modalCancel() { if (modalResolve) modalResolve(); }
    async function form(title, text, fields, okLabel, validate, danger) {
        var r = await modal({
            title: title, text: text, fields: fields, validate: validate,
            buttons: [{ label: 'Отмена', val: null, kind: 'ghost' }, { label: okLabel || 'OK', val: 'ok', kind: danger ? 'danger' : 'primary' }]
        });
        return r && r.val === 'ok' ? r.values : null;
    }
    async function confirmBox(title, text, okLabel, danger) {
        var r = await modal({ title: title, text: text, buttons: [{ label: 'Отмена', val: null, kind: 'ghost' }, { label: okLabel || 'OK', val: 'ok', kind: danger ? 'danger' : 'primary' }] });
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
                b.appendChild(icon(it.icon || 'file', 22));
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
    function setBusy(msg) { busyDepth++; $('busyTxt').textContent = msg || 'Подождите…'; $('busy').classList.remove('hidden'); }
    function clearBusy() { busyDepth = Math.max(0, busyDepth - 1); if (!busyDepth) $('busy').classList.add('hidden'); }
    function safeRequestError(value) {
        return String(value || 'Неизвестная ошибка')
            .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, '[скрыто]')
            .replace(/(authorization\s*[:=]\s*(?:token|bearer)\s+)\S+/ig, '$1[скрыто]')
            .slice(0, 500);
    }
    async function run(msg, fn, timeoutMs) {
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
        } catch (e) {
            failure = safeRequestError((e && e.message) || e);
        } finally {
            if (timer) clearTimeout(timer);
            clearBusy();
        }
        if (failure) {
            // Never keep the busy overlay alive while an error dialog is open.
            // Also do not await the dialog: a dismissed/unmounted WebView must
            // not leave the submit handler permanently pending.
            try { Promise.resolve(showError(failure)).catch(function () { toast(failure, 4500); }); }
            catch (e) { toast(failure, 4500); }
            return { ok: false, error: failure };
        }
        return { ok: true, v: value };
    }

    // ---------------- сеть GitHub ----------------
    function hasNative() {
        try {
            if (window.__aibHttp) return true;
            return !!(window.AndroidInterface && typeof window.AndroidInterface.httpRequest === 'function');
        } catch (e) { return false; }
    }
    async function nativeCall(url, method, headers, body, binary, timeoutMs) {
        var payload = JSON.stringify({
            url: url, method: method, headers: headers,
            body: body != null ? body : null, binary: !!binary,
            timeoutMs: timeoutMs || 15000
        });
        var raw;
        trace('мост → ' + method + ' ' + shortPath(url));
        try {
            if (window.__aibHttp) {
                raw = await window.__aibHttp(payload);
            } else {
                raw = window.AndroidInterface.httpRequest(payload);
            }
        } catch (e) { trace('мост ✗ ' + String((e && e.message) || e)); throw e; }
        var d;
        try { d = JSON.parse(raw); } catch (e) { trace('мост ✗ некорректный JSON'); throw new Error('Некорректный ответ сетевого моста'); }
        trace('мост ← status=' + (d.status || 0) + (d.error ? ' err=' + String(d.error).slice(0, 60) : ''));
        if (d.error && !d.status) {
            var transportError = String(d.error);
            var phaseLabels = { queued: 'очередь', parse: 'разбор запроса', dns: 'DNS', connect: 'соединение/TLS', 'request-body': 'отправка запроса', 'response-headers': 'заголовки ответа', 'response-body': 'тело ответа' };
            var phaseLabel = phaseLabels[String(d.phase || transportError.split(':')[1] || '')] || '';
            var phaseSuffix = phaseLabel ? ' (этап: ' + phaseLabel + ')' : '';
            if (/timeout|timed out/i.test(transportError)) {
                throw new Error('Истекло время ожидания ответа GitHub' + phaseSuffix + '. Токен не проверен; проверьте соединение и повторите попытку.');
            }
            if (/UnknownHost|Unable to resolve host|No address associated/i.test(transportError)) {
                throw new Error('Не удалось разрешить адрес api.github.com. Токен не проверен; проверьте DNS или сетевой маршрут.');
            }
            throw new Error('Сеть: ' + transportError);
        }
        if (!d.status && !d.ok) throw new Error(d.error || 'Нет сети или сервер недоступен');
        var hm = d.headers || {};
        return {
            ok: !!d.ok, status: d.status || 0, statusText: d.statusText || '',
            isBase64: !!d.isBase64,
            get: function (n) { var k = Object.keys(hm).find(function (x) { return x.toLowerCase() === String(n).toLowerCase(); }); return k ? hm[k] : null; },
            text: d.body || ''
        };
    }
    // Прямой запрос из WebView (GitHub API отдаёт CORS-заголовки, поэтому работает и со страницы file://).
    async function directFetch(method, url, headers, body, timeoutMs) {
        trace('fetch → ' + method + ' ' + shortPath(url));
        var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
        var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, timeoutMs) : null;
        try {
            var r = await fetch(url, { method: method, headers: headers, body: body, signal: ctrl ? ctrl.signal : undefined });
            var t = await r.text();
            trace('fetch ← status=' + r.status);
            return { ok: r.ok, status: r.status, get: function (n) { return r.headers.get(n); }, text: t };
        } catch (e) {
            trace('fetch ✗ ' + (ctrl && ctrl.signal.aborted ? 'таймаут' : String((e && e.name) || '') + ' ' + String((e && e.message) || '').slice(0, 80)));
            if (ctrl && ctrl.signal.aborted) throw new Error('Превышено время ожидания ответа GitHub. Проверьте интернет и попробуйте ещё раз.');
            throw new Error('Не удалось связаться с GitHub. Проверьте интернет и повторите попытку.');
        } finally { if (timer) clearTimeout(timer); }
    }
    // Идемпотентный GET: нативный мост и прямой fetch работают наперегонки. Прямой запрос стартует,
    // если мост ответил ошибкой или молчит дольше HEDGE_MS; побеждает первый настоящий HTTP-ответ.
    var HEDGE_MS = 4000;
    function hedgedGet(method, url, headers, body, timeoutMs) {
        return new Promise(function (resolve, reject) {
            var done = false, started = false, nativeFailed = false, directFailed = false, nativeErr = null, directErr = null, timer = null;
            function finish(fn, v) { if (done) return; done = true; if (timer) clearTimeout(timer); fn(v); }
            function startDirect() {
                if (started || done) return;
                started = true;
                trace('мост не ответил/ошибка → запускаю прямой fetch');
                directFetch(method, url, headers, body, timeoutMs).then(function (r) { finish(resolve, r); }, function (e) {
                    directFailed = true; directErr = e;
                    if (nativeFailed) finish(reject, nativeErr || e);
                });
            }
            timer = setTimeout(startDirect, HEDGE_MS);
            nativeCall(url, method, headers, body, false, timeoutMs).then(function (r) { finish(resolve, r); }, function (e) {
                nativeFailed = true; nativeErr = e;
                if (!started) startDirect();
                else if (directFailed) finish(reject, nativeErr || directErr);
            });
        });
    }
    async function http(method, url, headers, body, preferNative) {
        var timeoutMs = 15000;
        if (hasNative()) {
            if (preferNative && /^(GET|HEAD)$/i.test(method)) return hedgedGet(method, url, headers, body, timeoutMs);
            try { return await nativeCall(url, method, headers, body, false, timeoutMs); } catch (e) { if (preferNative) throw e; }
        }
        return directFetch(method, url, headers, body, timeoutMs);
    }
    function token() { return ls('unzipgit_token').trim(); }
    // gh(method, path, body, tokenOverride) -> {ok,status,data,scopes}
    async function gh(method, path, body, tk, preferNative) {
        var url = path.indexOf('http') === 0 ? path : 'https://api.github.com' + path;
        var headers = { 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
        if (/^https:\/\/api\.github\.com(?::443)?(?:[/?#]|$)/i.test(url)) headers.Authorization = 'token ' + (tk || token());
        if (body !== undefined) headers['Content-Type'] = 'application/json';
        var res = await http(method, url, headers, body !== undefined ? JSON.stringify(body) : undefined, true);
        var data = null;
        if (res.text) { try { data = JSON.parse(res.text); } catch (e) { throw new Error('GitHub вернул некорректный JSON-ответ (HTTP ' + res.status + ')'); } }
        if (res.ok && !res.text && !/^(DELETE)$/i.test(method)) throw new Error('GitHub вернул пустой ответ (HTTP ' + res.status + ')');
        return { ok: res.ok, status: res.status, data: data, scopes: res.get('X-OAuth-Scopes'), res: res };
    }
    function errMsg(r, hint) {
        if (r.status === 401) return 'Неверный токен или срок его действия истёк (401)';
        var serverMessage = (r.data && r.data.message) || '';
        if (r.status === 429 || ((r.status === 403) && /rate limit/i.test(serverMessage))) {
            var reset = r.res && (r.res.get('X-RateLimit-Reset') || r.res.get('Retry-After'));
            return 'Превышен лимит GitHub API. Повторите попытку позже' + (reset ? ' (сброс/Retry-After: ' + reset + ')' : '') + '.';
        }
        if (!r.status) return 'Не удалось связаться с GitHub. Проверьте интернет и попробуйте ещё раз.';
        var m = serverMessage || ('HTTP ' + r.status);
        if (r.data && r.data.errors && r.data.errors.length) {
            m += ' · ' + r.data.errors.map(function (e) { return e.message || e.code || JSON.stringify(e); }).join('; ');
        }
        if ((r.status === 403 || r.status === 404) && hint) m += '\n\n' + hint;
        return m;
    }
    async function ghAll(path, tk) {
        var out = [];
        for (var p = 1; p <= 10; p++) {
            var r = await gh('GET', path + (path.indexOf('?') < 0 ? '?' : '&') + 'per_page=100&page=' + p, undefined, tk);
            if (!r.ok) throw new Error(errMsg(r));
            var arr = Array.isArray(r.data) ? r.data : [];
            out = out.concat(arr);
            if (arr.length < 100) break;
        }
        return out;
    }

    // ---------------- прочее ----------------
    function goto(page) { window.location.href = page; }
    function rememberRepo(owner, repo, branch) {
        ls('unzipgit_username', owner);
        ls('unzipgit_repo', repo);
        ls('unzipgit_branch', branch || '');
        try {
            var key = owner + '/' + repo;
            var h = lsJson('unzipgit_repo_history', []);
            h = [key].concat((Array.isArray(h) ? h : []).filter(function (x) { return x !== key; })).slice(0, 5);
            ls('unzipgit_repo_history', JSON.stringify(h));
        } catch (e) { /* ignore */ }
    }
    // Токен из буфера обмена часто приходит с мусором: пробелы/переносы, невидимые символы
    // (U+200B, BOM, NBSP), кавычки, префикс «Bearer »/«token »/«Authorization: ». Любой такой символ
    // ломает заголовок Authorization, и GitHub отвечает 401 или запрос вообще не уходит.
    function normalizeToken(raw) {
        var s = String(raw == null ? '' : raw);
        s = s.replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF\u00AD]/g, '');
        s = s.replace(/^\s+|\s+$/g, '');
        s = s.replace(/^authorization\s*:\s*/i, '').replace(/^(?:bearer|token)\s+/i, '');
        s = s.replace(/^["'`«»“”‘’]+|["'`«»“”‘’]+$/g, '');
        s = s.replace(/\s+/g, '');
        return s;
    }
    // Возвращает текст ошибки или '' если токен пригоден для заголовка Authorization.
    function tokenFormatError(tok) {
        if (!tok) return 'Введите токен доступа';
        if (/[^\x21-\x7E]/.test(tok)) return 'В токене есть недопустимые символы (не латиница/цифры). Скопируйте токен с GitHub ещё раз.';
        if (/^(?:ssh-|ecdsa-|sk-)|PRIVATE KEY/.test(tok)) return 'Это SSH-ключ, а не токен доступа. Нужен токен вида ghp_… или github_pat_…';
        if (!/^[A-Za-z0-9_\-]+$/.test(tok)) return 'Токен содержит недопустимые символы. Допустимы латинские буквы, цифры, «_» и «-».';
        if (tok.length < 20) return 'Токен слишком короткий. Скопируйте его целиком (ghp_… или github_pat_…).';
        return '';
    }

    function randomId() {
        try { var a = new Uint8Array(6); crypto.getRandomValues(a); return Array.from(a).map(function (x) { return ('0' + x.toString(16)).slice(-2); }).join(''); }
        catch (e) { return String(Date.now()) + Math.floor(Math.random() * 1e6); }
    }

    try {
        trace('старт: __aibHttp=' + (typeof window.__aibHttp) + ' AndroidInterface=' + (typeof window.AndroidInterface) + ' RNWV=' + (!!(window.ReactNativeWebView && window.ReactNativeWebView.postMessage)) + ' online=' + (navigator.onLine !== false));
    } catch (e) { /* ignore */ }
    window.UG = {
        $: $, enc: enc, ls: ls, lsJson: lsJson, el: el, icon: icon, iconBtn: iconBtn, btn: btn,
        toast: toast, openExternal: openExternal, copyText: copyText, mask: mask, ago: ago, fmtDate: fmtDate,
        modal: modal, form: form, confirmBox: confirmBox, showError: showError, sheet: sheet, closeSheet: closeSheet, modalCancel: modalCancel, secretJson: secretJson, saveSecretJson: saveSecretJson,
        run: run, setBusy: setBusy, clearBusy: clearBusy,
        gh: gh, ghAll: ghAll, errMsg: errMsg, trace: trace, traceTail: traceTail, token: token, normalizeToken: normalizeToken, tokenFormatError: tokenFormatError, goto: goto, rememberRepo: rememberRepo, randomId: randomId,
        whenSecretsReady: whenSecretsReady, pendingSecret: pendingSecret,
        isModalOpen: function () { return !$('modalWrap').classList.contains('hidden'); },
        isSheetOpen: function () { return !$('sheetWrap').classList.contains('hidden'); },
        isBusy: function () { return !$('busy').classList.contains('hidden'); }
    };
})();


/* AI Builder chrome: top bar + bottom dock (UnzipGit parity, in-webview) */
(function () {
  function pageId() {
    try {
      var path = (location.pathname || location.href || "").split("?")[0];
      var name = path.split("/").pop() || "repos.html";
      name = name.toLowerCase();
      if (name === "index.html" || name === "") return "unzip";
      if (name.indexOf("file") >= 0) return "files";
      if (name.indexOf("release") >= 0) return "releases";
      if (name.indexOf("token") >= 0) return "tokens";
      return "repos";
    } catch (e) { return "repos"; }
  }
  function titles() {
    return {
      repos: "Репозитории",
      unzip: "Распаковка",
      files: "Файлы",
      releases: "Релизы",
      tokens: "Токены"
    };
  }
  function icon(name) {
    // Prefer Material-ish SVG from icons.js when available
    if (typeof window.MI === "function" && window.MI_HAS && window.MI_HAS(name)) {
      return window.MI(name, 22);
    }
    var paths = {
      folder: '<path d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z" fill="currentColor"/>',
      archive: '<path d="M20 6h-8l-2-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm-2 6h-3v3h-2v-3H8v-2h3V7h2v3h3v2z" fill="currentColor"/>',
      description: '<path d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z" fill="currentColor"/>',
      new_releases: '<path d="M23 12l-2.44-2.78.34-3.68-3.61-.82-1.89-3.18L12 2.96 8.6 1.54 6.71 4.72l-3.61.81.34 3.68L1 12l2.44 2.78-.34 3.69 3.61.82 1.89 3.18L12 21.04l3.4 1.42 1.89-3.18 3.61-.82-.34-3.68L23 12zm-10 5h-2v-2h2v2zm0-4h-2V7h2v6z" fill="currentColor"/>',
      vpn_key: '<path d="M12.65 10C11.83 7.67 9.61 6 7 6c-3.31 0-6 2.69-6 6s2.69 6 6 6c2.61 0 4.83-1.67 5.65-4H17v4h4v-4h2v-4H12.65zM7 14c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2z" fill="currentColor"/>',
      menu: '<path d="M3 18h18v-2H3v2zm0-5h18v-2H3v2zm0-7v2h18V6H3z" fill="currentColor"/>',
      home: '<path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z" fill="currentColor"/>',
      refresh: '<path d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z" fill="currentColor"/>'
    };
    var d = paths[name] || paths.folder;
    return '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">' + d + '</svg>';
  }
  function installShell() {
    if (document.getElementById("aib-dock")) return;
    document.body.classList.add("has-aib-shell");
    document.body.classList.add("aib-no-tool-topbar");
    var id = pageId();
    // No second top chrome (AI Builder Activity / system bar is the only header).
    // Remove leftover tool topbar if a previous build injected it.
    var oldTop = document.getElementById("aib-topbar");
    if (oldTop && oldTop.parentNode) oldTop.parentNode.removeChild(oldTop);
    if (document.getElementById("topbar")) {
      document.body.classList.add("has-native-topbar");
    }

    var dock = document.createElement("nav");
    dock.id = "aib-dock";
    dock.setAttribute("aria-label", "Навигация");
    var items = [
      { id: "repos", href: "repos.html", label: "Репозитории", ic: "folder" },
      { id: "unzip", href: "index.html", label: "Распаковка", ic: "archive" },
      { id: "files", href: "files.html", label: "Файлы", ic: "description" },
      { id: "releases", href: "releases.html", label: "Релизы", ic: "new_releases" },
      { id: "tokens", href: "tokens.html", label: "Токены", ic: "vpn_key" }
    ];
    dock.innerHTML = items.map(function (it) {
      var cls = (it.id === id) ? "on" : "";
      return '<a href="' + it.href + '" class="' + cls + '" data-nav="' + it.id + '">' +
        icon(it.ic) + "<span>" + it.label + "</span></a>";
    }).join("");
    document.body.appendChild(dock);
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", installShell);
  } else {
    installShell();
  }
  window.aibInstallShell = installShell;
})();
