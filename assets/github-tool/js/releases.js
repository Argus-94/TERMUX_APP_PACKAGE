// UnzipGit — экран «Релизы»: создание и управление релизами GitHub, загрузка любых файлов.
(function () {
    'use strict';
    var U = window.UG, $ = U.$, el = U.el;
    var N = window.AndroidInterface;
    var MAX_SIZE = 2 * 1024 * 1024 * 1024; // лимит GitHub: 2 ГиБ на файл
    var S = { owner: '', repo: '', info: null, releases: [], filter: 'all', q: '', loaded: false, open: {}, branches: null };
    var FILTERS = [['all', 'Все'], ['pub', 'Опубликованные'], ['draft', 'Черновики'], ['pre', 'Пре-релизы']];
    var HINT = 'Для управления релизами токену нужно право repo (классический токен) или Contents: Read and write (точечный), и вы должны иметь доступ на запись в репозиторий. Токен можно заменить на экране «Токены».';

    // ---------- утилиты ----------
    function fmtSize(n) {
        n = Number(n) || 0;
        if (n < 1024) return n + ' Б';
        if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' КБ';
        if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' МБ';
        return (n / 1024 / 1024 / 1024).toFixed(2) + ' ГБ';
    }
    function rpath() { return '/repos/' + U.enc(S.owner) + '/' + U.enc(S.repo); }
    function readRepo() {
        S.owner = U.ls('unzipgit_username').trim();
        S.repo = U.ls('unzipgit_repo').trim().replace(/^\/+|\/+$/g, '').split('/')[0] || '';
    }
    function fileIcon(name) {
        var e = (String(name).split('.').pop() || '').toLowerCase();
        if (/^(zip|rar|7z|tar|gz|tgz|bz2|xz|apk|aab|jar|ipa)$/.test(e)) return 'archive';
        if (/^(png|jpe?g|gif|webp|bmp|svg|ico)$/.test(e)) return 'image';
        if (/^(txt|md|json|xml|html|css|js|ts|kt|java|py|log|csv|yml|yaml|sh)$/.test(e)) return 'text';
        return 'file';
    }
    function titleOf(rel) { return rel.name || rel.tag_name || 'Без названия'; }
    function latestId() {
        var best = null;
        S.releases.forEach(function (r) {
            if (r.draft || r.prerelease) return;
            if (!best || new Date(r.created_at) > new Date(best.created_at)) best = r;
        });
        return best ? best.id : null;
    }
    function nextTag() {
        var t = '';
        for (var i = 0; i < S.releases.length; i++) { if (S.releases[i].tag_name) { t = S.releases[i].tag_name; break; } }
        if (!t) return 'v1.0.0';
        var m = t.match(/^(.*?)(\d+)(\D*)$/);
        if (!m) return 'v1.0.0';
        return m[1] + (parseInt(m[2], 10) + 1) + m[3];
    }
    function validTag(tag) {
        if (!tag) return 'Введите тег';
        if (/\s/.test(tag) || /[~^:?*\[\\]/.test(tag) || tag.indexOf('..') >= 0 || tag.indexOf('@{') >= 0) return 'Тег не должен содержать пробелы и символы ~ ^ : ? * [ \\';
        if (/^[\/.]|[\/.]$|\.lock$/.test(tag) || tag.indexOf('//') >= 0) return 'Недопустимый тег (не начинайте и не заканчивайте точкой или «/»)';
        return '';
    }
    function keepAwake(on) { try { if (N && typeof N.keepScreenOn === 'function') N.keepScreenOn(!!on); } catch (e) { /* ignore */ } }
    function hasFiles() { try { return !!(N && typeof N.pickFiles === 'function' && typeof N.uploadAsset === 'function'); } catch (e) { return false; } }

    // ---------- мост к нативной части (выбор файлов, загрузка, скачивание) ----------
    var cb = {};          // id передачи -> {progress, done}
    var pickResolve = null;
    window.__ugPicked = function (json) {
        var r = pickResolve; pickResolve = null;
        var a = [];
        try { a = JSON.parse(json) || []; } catch (e) { a = []; }
        if (r) r(a);
    };
    window.__ugProgress = function (id, sent, total) {
        var c = cb[id];
        if (c && c.progress) { try { c.progress(sent, total); } catch (e) { /* ignore */ } }
    };
    window.__ugDone = function (id, status, body) {
        var c = cb[id];
        if (c) { delete cb[id]; c.done({ status: status, body: body }); }
    };
    window.__ugDownloadDone = function (id, ok, msg) {
        var c = cb[id];
        if (c) { delete cb[id]; c.done({ ok: ok, msg: msg }); }
    };
    function pickFiles() {
        return new Promise(function (res) {
            if (!hasFiles()) { U.toast('Выбор файлов доступен только в приложении'); res([]); return; }
            pickResolve = res;
            try { N.pickFiles(); } catch (e) { pickResolve = null; res([]); }
        });
    }
    async function pickChecked() {
        var arr = await pickFiles();
        var out = [];
        var big = [];
        arr.forEach(function (f) {
            if (f.size > MAX_SIZE) big.push(f.name); else out.push(f);
        });
        if (big.length) await U.showError('Файл больше 2 ГБ — GitHub его не примет:\n' + big.join('\n'));
        return out;
    }

    // ---------- подключение / выбор репозитория ----------
    function showNoRepo(txt, btnLabel, page) {
        $('main').classList.add('hidden');
        $('fab').classList.add('hidden');
        $('noRepo').classList.remove('hidden');
        if (txt) $('noRepoTxt').textContent = txt;
        $('noRepoBtn').textContent = btnLabel || 'Открыть список репозиториев';
        $('noRepoBtn').onclick = function () { U.goto(page || 'repos.html'); };
    }

    // ---------- загрузка списка ----------
    async function load() {
        if (!U.token()) { showNoRepo('Сначала добавьте токен доступа GitHub.', 'Открыть «Токены»', 'tokens.html'); return; }
        readRepo();
        if (!S.owner || !S.repo) { showNoRepo(); return; }
        $('noRepo').classList.add('hidden');
        $('main').classList.remove('hidden');
        $('fab').classList.remove('hidden');
        $('repoLine').textContent = S.owner + '/' + S.repo;
        var r = await U.run('Загрузка релизов…', async function () {
            var info = await U.gh('GET', rpath());
            if (!info.ok) throw new Error(U.errMsg(info, HINT));
            var list = await U.ghAll(rpath() + '/releases');
            return { info: info.data, list: list };
        });
        if (!r.ok) {
            S.loaded = false;
            var l = $('list');
            l.textContent = '';
            var box = el('div', 'empty');
            box.appendChild(U.icon('warn', 40));
            box.appendChild(el('div', '', 'Не удалось загрузить релизы. Проверьте интернет, токен и доступ к репозиторию.'));
            var b = U.btn('primary', 'refresh', 'Повторить', load);
            b.style.marginTop = '14px';
            box.appendChild(b);
            l.appendChild(box);
            return;
        }
        S.info = r.v.info;
        S.releases = r.v.list;
        S.branches = null;
        S.loaded = true;
        render();
    }

    // ---------- отображение ----------
    function renderFilters() {
        var f = $('filters');
        f.textContent = '';
        FILTERS.forEach(function (x) {
            var c = el('button', 'chip' + (S.filter === x[0] ? ' on' : ''), x[1]);
            c.onclick = function () { S.filter = x[0]; render(); };
            f.appendChild(c);
        });
    }
    function visible() {
        var q = S.q.trim().toLowerCase();
        return S.releases.filter(function (r) {
            if (S.filter === 'pub' && (r.draft || r.prerelease)) return false;
            if (S.filter === 'draft' && !r.draft) return false;
            if (S.filter === 'pre' && !r.prerelease) return false;
            if (q && ((r.tag_name || '') + ' ' + (r.name || '')).toLowerCase().indexOf(q) < 0) return false;
            return true;
        });
    }
    function assetRow(rel, a) {
        var row = el('div', 'asset');
        var ic = el('div', 'ai');
        ic.appendChild(U.icon(fileIcon(a.name), 20));
        row.appendChild(ic);
        var m = el('div', 'am');
        m.appendChild(el('div', 'an', a.name));
        var meta = fmtSize(a.size) + ' · скачиваний: ' + (a.download_count || 0);
        var when = U.ago(a.updated_at || a.created_at);
        if (when) meta += ' · ' + when;
        m.appendChild(el('div', 'as', meta));
        row.appendChild(m);
        row.appendChild(U.iconBtn('download', 'sm acc', 'Скачать', function () { downloadAsset(a); }));
        row.appendChild(U.iconBtn('morevert', 'sm', 'Действия', function () { assetMenu(rel, a); }));
        return row;
    }
    function card(rel, latest) {
        var c = el('div', 'card' + (rel.id === latest ? ' active' : ''));
        var top = el('div', 'top');
        var av = el('div', 'avatar');
        av.appendChild(U.icon('tag', 22));
        top.appendChild(av);
        var m = el('div', 'meta');
        m.appendChild(el('div', 'nm', titleOf(rel)));
        var tg = el('div', 'rel-tag');
        tg.appendChild(U.icon('tag', 12));
        tg.appendChild(document.createTextNode(rel.tag_name || '—'));
        m.appendChild(tg);
        var info = el('div', 'info');
        if (rel.draft) info.appendChild(el('span', 'badge draft', 'Черновик'));
        if (rel.prerelease) info.appendChild(el('span', 'badge pre', 'Пре-релиз'));
        if (rel.id === latest) info.appendChild(el('span', 'badge latest', 'Последний'));
        var when = U.ago(rel.published_at || rel.created_at);
        if (when) info.appendChild(el('span', '', when));
        if (rel.author && rel.author.login) info.appendChild(el('span', '', rel.author.login));
        m.appendChild(info);
        top.appendChild(m);
        top.appendChild(U.iconBtn('morevert', 'sm', 'Действия', function () { relMenu(rel); }));
        c.appendChild(top);
        if (rel.body && rel.body.trim()) {
            var t = rel.body.trim();
            c.appendChild(el('div', 'rel-body', t.length > 160 ? t.slice(0, 160) + '…' : t));
        }
        var assets = rel.assets || [];
        var act = el('div', 'actions');
        act.appendChild(U.btn('primary', 'cloudup', 'Добавить файлы', function () { addFiles(rel); }));
        var opened = !!S.open[rel.id];
        act.appendChild(U.btn('', 'attach', 'Файлы: ' + assets.length, function () { S.open[rel.id] = !S.open[rel.id]; render(); }));
        c.appendChild(act);
        if (opened) {
            var box = el('div', 'assets');
            if (!assets.length) box.appendChild(el('div', 'assets-empty', 'Файлов пока нет. Нажмите «Добавить файлы».'));
            assets.forEach(function (a) { box.appendChild(assetRow(rel, a)); });
            c.appendChild(box);
        }
        return c;
    }
    function render() {
        renderFilters();
        $('repoLine').textContent = S.owner + '/' + S.repo + ' · релизов: ' + S.releases.length;
        var list = $('list');
        list.textContent = '';
        var items = visible();
        if (!items.length) {
            var box = el('div', 'empty');
            box.appendChild(U.icon('tag', 48));
            box.appendChild(el('div', '', S.releases.length ? 'Ничего не найдено' : 'В этом репозитории пока нет релизов'));
            if (!S.releases.length) {
                var b = U.btn('primary', 'add', 'Создать релиз', function () { openComposer(null); });
                b.style.marginTop = '14px';
                box.appendChild(b);
            }
            list.appendChild(box);
            return;
        }
        var latest = latestId();
        var frag = document.createDocumentFragment();
        items.forEach(function (r) { frag.appendChild(card(r, latest)); });
        list.appendChild(frag);
    }
    function replaceRelease(rel) {
        var i = S.releases.findIndex(function (x) { return x.id === rel.id; });
        if (i >= 0) S.releases[i] = rel; else S.releases.unshift(rel);
    }

    // ---------- действия над релизом ----------
    async function patchRelease(rel, body, doneMsg) {
        var r = await U.run('Сохранение…', async function () {
            var x = await U.gh('PATCH', rpath() + '/releases/' + rel.id, body);
            if (!x.ok) throw new Error(U.errMsg(x, HINT));
            return x.data;
        });
        if (!r.ok) return null;
        replaceRelease(r.v);
        render();
        if (doneMsg) U.toast(doneMsg);
        return r.v;
    }
    async function relMenu(rel) {
        var latest = latestId();
        var items = [
            { id: 'files', icon: 'cloudup', label: 'Добавить файлы' },
            { id: 'edit', icon: 'edit', label: 'Редактировать' }
        ];
        if (rel.draft) items.push({ id: 'publish', icon: 'check', label: 'Опубликовать' });
        else items.push({ id: 'unpub', icon: 'file', label: 'Сделать черновиком' });
        items.push({ id: 'pre', icon: 'tag', label: rel.prerelease ? 'Снять отметку «Пре-релиз»' : 'Отметить как пре-релиз' });
        if (!rel.draft && !rel.prerelease && rel.id !== latest) items.push({ id: 'latest', icon: 'up', label: 'Сделать последним' });
        items.push({ id: 'gh', icon: 'open', label: 'Открыть на GitHub' });
        items.push({ id: 'link', icon: 'copy', label: 'Копировать ссылку' });
        items.push({ id: 'tag', icon: 'copy', label: 'Копировать тег' });
        items.push({ id: 'del', icon: 'del', label: 'Удалить релиз', danger: true });
        var id = await U.sheet(titleOf(rel), items);
        if (id === 'files') addFiles(rel);
        else if (id === 'edit') openComposer(rel);
        else if (id === 'publish') patchRelease(rel, { draft: false }, 'Релиз опубликован');
        else if (id === 'unpub') patchRelease(rel, { draft: true }, 'Релиз стал черновиком');
        else if (id === 'pre') patchRelease(rel, { prerelease: !rel.prerelease }, rel.prerelease ? 'Отметка снята' : 'Отмечено как пре-релиз');
        else if (id === 'latest') patchRelease(rel, { make_latest: 'true' }, 'Релиз отмечен как последний');
        else if (id === 'gh') U.openExternal(rel.html_url);
        else if (id === 'link') U.copyText(rel.html_url);
        else if (id === 'tag') U.copyText(rel.tag_name);
        else if (id === 'del') deleteRelease(rel);
    }
    async function deleteRelease(rel) {
        var n = (rel.assets || []).length;
        var v = await U.form('Удалить релиз?',
            'Релиз «' + titleOf(rel) + '»' + (n ? ' и все его файлы (' + n + ')' : '') + ' будет удалён. Это действие нельзя отменить.',
            [{ id: 'tag', label: 'Удалить также тег «' + (rel.tag_name || '') + '»', type: 'checkbox', value: false, hint: 'Если не отметить, тег останется в репозитории' }],
            'Удалить', null, true);
        if (!v) return;
        var r = await U.run('Удаление…', async function () {
            var x = await U.gh('DELETE', rpath() + '/releases/' + rel.id);
            if (!x.ok && x.status !== 204) throw new Error(U.errMsg(x, HINT));
            var tagMsg = '';
            if (v.tag && rel.tag_name) {
                var t = await U.gh('DELETE', rpath() + '/git/refs/tags/' + rel.tag_name.split('/').map(U.enc).join('/'));
                if (!t.ok && t.status !== 204 && t.status !== 404 && t.status !== 422) tagMsg = 'Релиз удалён, но тег удалить не удалось: ' + U.errMsg(t);
            }
            return tagMsg;
        });
        if (!r.ok) return;
        S.releases = S.releases.filter(function (x) { return x.id !== rel.id; });
        render();
        if (r.v) U.showError(r.v); else U.toast('Релиз удалён');
    }

    // ---------- файлы релиза ----------
    async function refreshRelease(rel) {
        try {
            var x = await U.gh('GET', rpath() + '/releases/' + rel.id);
            if (x.ok && x.data) { replaceRelease(x.data); return x.data; }
        } catch (e) { /* ignore */ }
        return rel;
    }
    async function assetMenu(rel, a) {
        var id = await U.sheet(a.name, [
            { id: 'dl', icon: 'download', label: 'Скачать' },
            { id: 'ren', icon: 'edit', label: 'Переименовать' },
            { id: 'link', icon: 'copy', label: 'Копировать ссылку' },
            { id: 'open', icon: 'open', label: 'Открыть в браузере' },
            { id: 'del', icon: 'del', label: 'Удалить файл', danger: true }
        ]);
        if (id === 'dl') downloadAsset(a);
        else if (id === 'ren') renameAsset(rel, a);
        else if (id === 'link') U.copyText(a.browser_download_url);
        else if (id === 'open') U.openExternal(a.browser_download_url);
        else if (id === 'del') deleteAsset(rel, a);
    }
    async function renameAsset(rel, a) {
        var v = await U.form('Переименовать файл', null, [{ id: 'name', label: 'Новое имя', type: 'text', value: a.name }], 'Сохранить', function (x) {
            var n = x.name.trim();
            if (!n) return 'Введите имя';
            if (/[\/\\]/.test(n)) return 'Имя не должно содержать «/» и «\\»';
            return '';
        });
        if (!v || v.name.trim() === a.name) return;
        var r = await U.run('Переименование…', async function () {
            var x = await U.gh('PATCH', rpath() + '/releases/assets/' + a.id, { name: v.name.trim() });
            if (!x.ok) throw new Error(U.errMsg(x, HINT));
            return x.data;
        });
        if (!r.ok) return;
        rel.assets = (rel.assets || []).map(function (z) { return z.id === a.id ? r.v : z; });
        render();
        U.toast('Файл переименован');
    }
    async function deleteAsset(rel, a) {
        if (!(await U.confirmBox('Удалить файл?', '«' + a.name + '» будет удалён из релиза.', 'Удалить', true))) return;
        var r = await U.run('Удаление…', async function () {
            var x = await U.gh('DELETE', rpath() + '/releases/assets/' + a.id);
            if (!x.ok && x.status !== 204) throw new Error(U.errMsg(x, HINT));
        });
        if (!r.ok) return;
        rel.assets = (rel.assets || []).filter(function (z) { return z.id !== a.id; });
        render();
        U.toast('Файл удалён');
    }
    async function downloadAsset(a) {
        if (!N || typeof N.downloadAsset !== 'function') { U.openExternal(a.browser_download_url); return; }
        var id = 'd' + a.id + '_' + Date.now();
        U.setBusy('Скачивание…');
        keepAwake(true);
        var res = await new Promise(function (resolve) {
            cb[id] = {
                progress: function (s, t) { $('busyTxt').textContent = 'Скачивание… ' + (t > 0 ? Math.min(100, Math.floor(s * 100 / t)) + '%' : fmtSize(s)); },
                done: resolve
            };
            try { N.downloadAsset(id, a.url, U.token(), a.name); }
            catch (e) { delete cb[id]; resolve({ ok: false, msg: String((e && e.message) || e) }); }
        });
        keepAwake(false);
        U.clearBusy();
        if (res.ok) U.toast('Файл сохранён');
        else if (res.msg && res.msg !== 'cancel') U.showError('Не удалось скачать файл:\n' + res.msg);
    }

    function upError(r) {
        var st = r.status, msg = '';
        if (st === 0) return 'Сеть: ' + (r.body || 'нет соединения');
        try {
            var d = JSON.parse(r.body);
            msg = d.message || '';
            if (d.errors && d.errors.length) {
                if (d.errors.some(function (e) { return e.code === 'already_exists'; })) return 'Файл с таким именем уже есть в релизе';
                msg += ' · ' + d.errors.map(function (e) { return e.message || e.code || ''; }).join('; ');
            }
        } catch (e) { msg = String(r.body || '').slice(0, 200); }
        if (st === 401) return 'Неверный токен или срок его действия истёк (401)';
        if (st === 403 || st === 404) return 'Нет прав на загрузку (' + st + '). ' + (msg || '');
        return 'HTTP ' + st + (msg ? ': ' + msg : '');
    }
    function nativeUpload(f, url, onProg) {
        return new Promise(function (resolve) {
            cb[f.id] = { progress: onProg, done: resolve };
            try { N.uploadAsset(f.id, url, U.token(), f.name, f.mime || 'application/octet-stream'); }
            catch (e) { delete cb[f.id]; resolve({ status: 0, body: String((e && e.message) || e) }); }
        });
    }
    async function uploadOne(rel, f, onProg) {
        try {
            if (f.replace) {
                var d = await U.gh('DELETE', rpath() + '/releases/assets/' + f.replace.id);
                if (!d.ok && d.status !== 204 && d.status !== 404) return { ok: false, err: 'Не удалось заменить старый файл: ' + U.errMsg(d) };
                var oldId = f.replace.id;
                rel.assets = (rel.assets || []).filter(function (x) { return x.id !== oldId; });
                f.replace = null;
            }
            var base = String(rel.upload_url || '').replace(/\{.*$/, '');
            if (!base) return { ok: false, err: 'У релиза нет адреса загрузки' };
            var r = await nativeUpload(f, base + '?name=' + U.enc(f.name), onProg);
            if (r.status >= 200 && r.status < 300) {
                var a = null;
                try { a = JSON.parse(r.body); } catch (e) { a = null; }
                return { ok: true, asset: a };
            }
            if (r.status === -1) return { ok: false, err: 'Отменено', cancelled: true };
            return { ok: false, err: upError(r) };
        } catch (e) {
            return { ok: false, err: String((e && e.message) || e) };
        }
    }
    // Если файл с таким именем уже есть — спрашиваем, заменять ли
    async function resolveConflicts(rel, files) {
        var byName = {};
        (rel.assets || []).forEach(function (a) { byName[a.name] = a; });
        var dup = files.filter(function (f) { return byName[f.name]; });
        if (!dup.length) return files;
        var ok = await U.confirmBox('Такие файлы уже есть', 'Заменить существующие файлы новыми?\n\n' + dup.map(function (f) { return f.name; }).join('\n'), 'Заменить');
        if (!ok) return files.filter(function (f) { return !byName[f.name]; });
        dup.forEach(function (f) { f.replace = byName[f.name]; });
        return files;
    }
    // Загружает файлы по очереди, показывая прогресс. Возвращает {ok, fail:[{name, err}], cancelled}
    async function uploadBatch(rel, files) {
        var box = $('uplList');
        box.textContent = '';
        var rows = files.map(function (f) {
            var row = el('div', 'urow');
            row.appendChild(el('div', 'un', f.name + ' · ' + fmtSize(f.size)));
            var bar = el('div', 'ubar'), fill = el('div', 'ufill');
            bar.appendChild(fill);
            row.appendChild(bar);
            var st = el('div', 'ust', 'Ожидание');
            row.appendChild(st);
            box.appendChild(row);
            return { fill: fill, st: st };
        });
        var title = $('uplTitle');
        title.textContent = 'Загрузка файлов (0/' + files.length + ')';
        $('uplClose').classList.add('hidden');
        $('uplCancel').classList.remove('hidden');
        $('upl').classList.remove('hidden');
        var cancelled = false, current = null, ok = 0, fail = [];
        $('uplCancel').onclick = function () {
            cancelled = true;
            $('uplCancel').classList.add('hidden');
            try { if (N && typeof N.cancelTransfer === 'function' && current) N.cancelTransfer(current); } catch (e) { /* ignore */ }
        };
        keepAwake(true);
        try {
            for (var i = 0; i < files.length; i++) {
                var f = files[i], r = rows[i];
                if (cancelled) { r.st.textContent = 'Отменено'; fail.push({ name: f.name, err: 'Отменено' }); continue; }
                r.st.textContent = '0%';
                current = f.id;
                var res = await uploadOne(rel, f, (function (row) {
                    return function (s, t) {
                        var p = t > 0 ? Math.min(100, Math.floor(s * 100 / t)) : 0;
                        row.fill.style.width = p + '%';
                        row.st.textContent = p + '%';
                    };
                })(r));
                current = null;
                if (res.ok) {
                    ok++;
                    r.fill.style.width = '100%';
                    r.st.textContent = 'Готово';
                    r.st.className = 'ust good';
                    if (res.asset) { rel.assets = (rel.assets || []).concat([res.asset]); }
                } else {
                    fail.push({ name: f.name, err: res.err });
                    r.st.textContent = res.err;
                    r.st.className = 'ust bad';
                }
                title.textContent = 'Загрузка файлов (' + (i + 1) + '/' + files.length + ')';
            }
        } finally {
            keepAwake(false);
        }
        title.textContent = fail.length ? 'Загрузка завершена: ' + ok + ' из ' + files.length : 'Все файлы загружены';
        $('uplCancel').classList.add('hidden');
        $('uplClose').classList.remove('hidden');
        await new Promise(function (resolve) {
            $('uplClose').onclick = function () { $('upl').classList.add('hidden'); resolve(); };
        });
        return { ok: ok, fail: fail, cancelled: cancelled };
    }
    async function addFiles(rel) {
        var picked = await pickChecked();
        if (!picked.length) return;
        var files = await resolveConflicts(rel, picked);
        if (!files.length) return;
        var res = await uploadBatch(rel, files);
        var fresh = await refreshRelease(rel);
        S.open[fresh.id] = true;
        render();
        if (res.ok) U.toast('Загружено файлов: ' + res.ok);
    }

    // ---------- создание / редактирование ----------
    var C = null; // {rel, files:[], dirty}
    function renderCFiles() {
        var box = $('cFiles');
        box.textContent = '';
        C.files.forEach(function (f, i) {
            var row = el('div', 'cfile');
            var ic = el('div', 'ai');
            ic.appendChild(U.icon(fileIcon(f.name), 22));
            row.appendChild(ic);
            var m = el('div', 'am');
            m.appendChild(el('div', 'an', f.name));
            m.appendChild(el('div', 'as', f.size >= 0 ? fmtSize(f.size) : 'размер неизвестен'));
            row.appendChild(m);
            row.appendChild(U.iconBtn('close', 'sm', 'Убрать', function () { C.files.splice(i, 1); C.dirty = true; renderCFiles(); }));
            box.appendChild(row);
        });
        var pb = $('cPick');
        pb.textContent = '';
        pb.appendChild(U.icon('attach', 18));
        pb.appendChild(document.createTextNode(C.files.length ? 'Добавить ещё файлы' : 'Выбрать файлы'));
        updateSubmit();
    }
    function updateSubmit() {
        var edit = !!C.rel;
        var t;
        if (edit) t = 'Сохранить';
        else if ($('cDraft').checked) t = 'Сохранить черновик';
        else t = C.files.length ? 'Опубликовать с файлами (' + C.files.length + ')' : 'Опубликовать';
        $('cSubmit').textContent = t;
    }
    async function fillBranches(selected) {
        var sel = $('cTarget');
        var def = (S.info && S.info.default_branch) || 'main';
        var want = selected || def;
        sel.textContent = '';
        function put(list) {
            sel.textContent = '';
            list.forEach(function (b) { var o = el('option', '', b); o.value = b; if (b === want) o.selected = true; sel.appendChild(o); });
        }
        put([want]);
        if (!S.branches) {
            try {
                var all = await U.ghAll(rpath() + '/branches');
                S.branches = all.map(function (b) { return b.name; });
            } catch (e) { S.branches = null; }
        }
        if (S.branches && S.branches.length) {
            var list = S.branches.slice();
            if (list.indexOf(want) < 0) list.unshift(want);
            put(list);
        }
    }
    function openComposer(rel) {
        C = { rel: rel || null, files: [], dirty: false };
        var edit = !!rel;
        $('cmpTitle').textContent = edit ? 'Редактирование релиза' : 'Новый релиз';
        $('cTag').value = edit ? (rel.tag_name || '') : nextTag();
        $('cName').value = edit ? (rel.name || '') : '';
        $('cBody').value = edit ? (rel.body || '') : '';
        $('cPre').checked = edit ? !!rel.prerelease : false;
        $('cDraft').checked = edit ? !!rel.draft : false;
        $('cAuto').checked = false;
        $('cAutoBox').classList.toggle('hidden', edit);
        $('cTargetBox').classList.toggle('hidden', edit);
        $('cFilesBox').classList.toggle('hidden', edit);
        $('cTag').disabled = false;
        if (!edit) fillBranches();
        renderCFiles();
        $('composer').classList.remove('hidden');
        $('cBody').scrollTop = 0;
    }
    async function closeComposer(force) {
        if ($('composer').classList.contains('hidden')) return;
        if (!force && C && (C.dirty || C.files.length)) {
            if (!(await U.confirmBox('Закрыть без сохранения?', 'Введённые данные и выбранные файлы будут потеряны.', 'Закрыть', true))) return;
        }
        $('composer').classList.add('hidden');
        C = null;
    }
    async function pickForComposer() {
        var arr = await pickChecked();
        if (!arr.length) return;
        arr.forEach(function (f) {
            var exists = C.files.some(function (x) { return x.name === f.name; });
            if (!exists) C.files.push(f);
        });
        C.dirty = true;
        renderCFiles();
    }
    async function submitComposer() {
        if (!C) return;
        var edit = !!C.rel;
        var tag = $('cTag').value.trim();
        var bad = validTag(tag);
        if (bad) { U.toast(bad, 3500); $('cTag').focus(); return; }
        var name = $('cName').value.trim();
        var body = $('cBody').value;
        var pre = $('cPre').checked, draft = $('cDraft').checked;
        if (edit) {
            var saved = await patchRelease(C.rel, { tag_name: tag, name: name, body: body, prerelease: pre, draft: draft }, 'Изменения сохранены');
            if (saved) { $('composer').classList.add('hidden'); C = null; }
            return;
        }
        if (S.releases.some(function (r) { return r.tag_name === tag; })) {
            if (!(await U.confirmBox('Такой тег уже есть', 'Релиз с тегом «' + tag + '» уже существует. GitHub не позволит создать второй. Всё равно попробовать?', 'Попробовать'))) return;
        }
        var files = C.files.slice();
        // С файлами: сначала черновик, потом загрузка, и только потом публикация — релиз не появится «пустым»
        var publishAfter = files.length > 0 && !draft;
        var payload = { tag_name: tag, draft: publishAfter ? true : draft, prerelease: pre };
        if (name) payload.name = name;
        if (body) payload.body = body;
        else if ($('cAuto').checked) payload.generate_release_notes = true;
        var target = $('cTarget').value;
        if (target) payload.target_commitish = target;
        var r = await U.run('Создание релиза…', async function () {
            var x = await U.gh('POST', rpath() + '/releases', payload);
            if (!x.ok) {
                var m = U.errMsg(x, HINT);
                if (x.data && x.data.errors && x.data.errors.some(function (e) { return e.code === 'already_exists'; })) m = 'Релиз с тегом «' + tag + '» уже существует. Выберите другой тег.';
                throw new Error(m);
            }
            return x.data;
        });
        if (!r.ok) return;
        var rel = r.v;
        replaceRelease(rel);
        $('composer').classList.add('hidden');
        C = null;
        S.open[rel.id] = files.length > 0;
        render();
        if (!files.length) { U.toast(draft ? 'Черновик сохранён' : 'Релиз опубликован'); return; }
        var res = await uploadBatch(rel, files);
        if (publishAfter) {
            if (!res.fail.length) {
                var pub = await patchRelease(rel, { draft: false });
                if (pub) rel = pub;
                U.toast('Релиз опубликован');
            } else {
                await U.showError('Загружено ' + res.ok + ' из ' + files.length + '. Не удалось:\n' +
                    res.fail.map(function (f) { return f.name + ' — ' + f.err; }).join('\n') +
                    '\n\nРелиз сохранён как черновик. Добавьте недостающие файлы и опубликуйте его из меню релиза.');
            }
        } else if (res.fail.length) {
            await U.showError('Не загружено:\n' + res.fail.map(function (f) { return f.name + ' — ' + f.err; }).join('\n'));
        } else {
            U.toast('Сохранено, файлов: ' + res.ok);
        }
        await refreshRelease(rel);
        render();
    }

    // ---------- запуск ----------
    document.addEventListener('DOMContentLoaded', function () {
        $('btnRefresh').appendChild(U.icon('refresh', 22));
        $('btnRefresh').onclick = function () { load(); };
        $('btnSwitch').appendChild(U.icon('swap', 22));
        $('btnSwitch').onclick = function () { U.goto('repos.html'); };
        $('searchIco').appendChild(U.icon('search', 20));
        var fab = $('fab');
        fab.appendChild(U.icon('add', 24));
        fab.appendChild(document.createTextNode('Новый релиз'));
        fab.onclick = function () { openComposer(null); };
        $('q').addEventListener('input', function () { S.q = this.value; render(); });
        $('cmpClose').appendChild(U.icon('close', 22));
        $('cmpClose').onclick = function () { closeComposer(false); };
        $('cCancel').onclick = function () { closeComposer(false); };
        $('cSubmit').onclick = submitComposer;
        $('cPick').onclick = pickForComposer;
        $('cDraft').addEventListener('change', function () { if (C) { C.dirty = true; updateSubmit(); } });
        ['cTag', 'cName', 'cBody', 'cPre', 'cAuto'].forEach(function (id) {
            $(id).addEventListener('input', function () { if (C) C.dirty = true; });
        });
        load();
        window.addEventListener('pageshow', function (e) { if (e.persisted && S.loaded) load(); });
    });
    window.addEventListener('aib-secrets-ready', function () {
        var retry = function () { if (!S.loaded) load(); };
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', retry, { once: true });
        else retry();
    });

    window.__onBack = function () {
        if (U.isModalOpen()) { U.modalCancel(); return true; }
        if (U.isSheetOpen()) { U.closeSheet(); return true; }
        if (!$('upl').classList.contains('hidden')) {
            if (!$('uplClose').classList.contains('hidden')) $('uplClose').click();
            return true;
        }
        if (U.isBusy()) return true;
        if (!$('composer').classList.contains('hidden')) { closeComposer(false); return true; }
        return false;
    };
})();
