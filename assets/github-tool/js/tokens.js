// UnzipGit — экран «Токены и ключи»: сохранённые токены GitHub, SSH-ключи аккаунта, генератор ключей API.
(function () {
    'use strict';
    var U = window.UG, $ = U.$, el = U.el;
    var TOKENS_KEY = 'unzipgit_tokens', APIKEYS_KEY = 'unzipgit_apikeys';
    var T = { tab: 'tokens', shown: {}, ssh: null, sshErr: '', loading: false, verifying: false };
    var TABS = [['tokens', 'Токены GitHub'], ['ssh', 'SSH-ключи'], ['api', 'Ключи API']];
    var NOTES = {
        tokens: '<b>Как это работает.</b> GitHub не разрешает приложениям создавать токены и не отдаёт список уже созданных, поэтому токен создаётся на сайте GitHub (кнопка «Добавить»), а здесь хранится на вашем устройстве. Активный токен используется во всех разделах приложения.',
        ssh: '<b>SSH-ключи вашего аккаунта GitHub.</b> Показывает и добавляет открытые ключи. Нужен активный токен с правом read:public_key (просмотр) и admin:public_key (добавление и удаление).',
        api: '<b>Ключи API для ваших сервисов.</b> Случайные секретные ключи создаются на устройстве и хранятся только здесь. Ключи доступа к GitHub — это токены на первой вкладке.'
    };

    function clearLegacySecret(k) { try { localStorage.removeItem(k); localStorage.removeItem('aib_sec_' + k); sessionStorage.removeItem(k); sessionStorage.removeItem('aib_sec_' + k); } catch (e) {} }
    function migrateLegacyList(k, list) {
        var saved = U.saveSecretJson(k, list);
        if (saved && typeof saved.then === 'function') saved.then(function (ok) { if (ok) clearLegacySecret(k); });
        else if (saved === true) clearLegacySecret(k);
    }
    async function requireSecureSave(result) {
        var ok = result && typeof result.then === 'function' ? await result : result === true;
        if (!ok) U.toast('Не удалось сохранить данные в защищённом хранилище. Изменение не сохранено.', 4500);
        return !!ok;
    }
    function tokens() {
        var list = U.secretJson(TOKENS_KEY, null);
        if (!Array.isArray(list)) { list = U.lsJson(TOKENS_KEY, []); if (Array.isArray(list) && list.length) migrateLegacyList(TOKENS_KEY, list); }
        var cur = U.token();
        if (cur && !list.some(function (t) { return t.value === cur; })) {
            list.unshift({ id: U.randomId(), name: 'Текущий токен', value: cur, kind: 'github', login: U.ls('unzipgit_username'), created: Date.now() });
            saveTokens(list).then(function (ok) { if (!ok) U.toast('Не удалось сохранить список токенов в защищённом хранилище.', 4500); });
        }
        return list;
    }
    function saveTokens(l) { return requireSecureSave(U.saveSecretJson(TOKENS_KEY, l)); }
    function apikeys() { var l = U.secretJson(APIKEYS_KEY, null); if (!Array.isArray(l)) { l = U.lsJson(APIKEYS_KEY, []); if (Array.isArray(l) && l.length) migrateLegacyList(APIKEYS_KEY, l); } return Array.isArray(l) ? l : []; }
    function saveApikeys(l) { return requireSecureSave(U.saveSecretJson(APIKEYS_KEY, l)); }

    // ---------- общие элементы ----------
    function secretRow(value, id) {
        var s = el('div', 'secret mono', T.shown[id] ? value : U.mask(value));
        return s;
    }
    function empty(iconName, text) {
        var b = el('div', 'empty');
        b.appendChild(U.icon(iconName, 48));
        b.appendChild(el('div', '', text));
        return b;
    }

    // ---------- вкладка «Токены» ----------
    function renderTokens(box) {
        var list = tokens(), cur = U.token();
        if (!list.length) { box.appendChild(empty('key', 'Токенов пока нет. Нажмите «Добавить».')); return; }
        list.forEach(function (t) {
            var active = t.value === cur;
            var c = el('div', 'card' + (active ? ' active' : ''));
            var top = el('div', 'top');
            var av = el('div', 'avatar'); av.appendChild(U.icon('key', 22)); top.appendChild(av);
            var m = el('div', 'meta');
            m.appendChild(el('div', 'nm', t.name || 'Токен'));
            var info = el('div', 'info');
            if (active) info.appendChild(el('span', 'badge on', 'Активный'));
            if (t.login) info.appendChild(el('span', '', '@' + t.login));
            if (t.created) info.appendChild(el('span', '', U.fmtDate(t.created)));
            m.appendChild(info);
            m.appendChild(secretRow(t.value, t.id));
            top.appendChild(m);
            top.appendChild(U.iconBtn(T.shown[t.id] ? 'eyeoff' : 'eye', 'sm', 'Показать или скрыть', function () { T.shown[t.id] = !T.shown[t.id]; render(); }));
            c.appendChild(top);
            var a = el('div', 'actions');
            if (!active) a.appendChild(U.btn('primary', 'check', 'Сделать активным', function () { activate(t); }));
            a.appendChild(U.btn('', 'copy', 'Копировать', function () { U.copyText(t.value); }));
            a.appendChild(U.btn('', 'shield', 'Проверить', function () { check(t); }));
            a.appendChild(U.iconBtn('morevert', 'sm', 'Ещё', function () { tokenMenu(t); }));
            c.appendChild(a);
            box.appendChild(c);
        });
    }
    async function activate(t) {
        var prevUser = U.ls('unzipgit_username');
        if (!await requireSecureSave(U.ls('unzipgit_token', t.value))) return;
        var changed = t.login && prevUser && prevUser.toLowerCase() !== t.login.toLowerCase();
        if (t.login) U.ls('unzipgit_username', t.login);
        if (changed) { U.ls('unzipgit_repo', null); U.ls('unzipgit_branch', null); }
        T.ssh = null;
        U.toast(changed ? 'Токен активен. Аккаунт сменился — выберите репозиторий заново' : 'Токен «' + (t.name || 'Токен') + '» теперь активный', changed ? 4000 : 2200);
        render();
    }
    async function check(t) {
        if (T.verifying) return;
        T.verifying = true;
        try {
            var r = await U.run('Проверка токена…', async function () {
                var x = await U.gh('GET', '/user', undefined, t.value, true);
                if (!x.ok) throw new Error(U.errMsg(x));
                if (!x.data || typeof x.data.login !== 'string' || !x.data.login.trim()) throw new Error('GitHub вернул пустую или некорректную информацию об аккаунте.');
                return x;
            }, 20000);
            if (!r.ok) return;
            var d = r.v.data, res = r.v.res;
            var lines = ['Аккаунт: ' + d.login + (d.name ? ' (' + d.name + ')' : '')];
            var sc = r.v.scopes;
            lines.push('Права: ' + (sc ? sc : (sc === '' ? 'нет расширенных прав' : 'не указаны (у точечных токенов права видны в настройках GitHub)')));
            var lim = res.get('X-RateLimit-Limit'), rem = res.get('X-RateLimit-Remaining');
            if (lim) lines.push('Лимит запросов: осталось ' + rem + ' из ' + lim);
            var exp = res.get('github-authentication-token-expiration');
            if (exp) lines.push('Действует до: ' + exp);
            var list = tokens();
            list.forEach(function (x) { if (x.id === t.id) x.login = d.login; });
            if (!await saveTokens(list)) return;
            await U.modal({ title: 'Токен работает', text: lines.join('\n'), buttons: [{ label: 'OK', val: 'ok', kind: 'primary' }] });
            render();
        } catch (e) {
            U.toast('Не удалось проверить токен: ' + String((e && e.message) || e).slice(0, 240), 4500);
        } finally { T.verifying = false; }
    }
    async function tokenMenu(t) {
        var id = await U.sheet(t.name || 'Токен', [
            { id: 'rename', icon: 'edit', label: 'Переименовать' },
            { id: 'del', icon: 'del', label: 'Удалить', danger: true }
        ]);
        if (id === 'rename') {
            var v = await U.form('Название токена', null, [{ id: 'name', label: 'Название', type: 'text', value: t.name || '' }], 'Сохранить',
                function (x) { return x.name.trim() ? '' : 'Введите название'; });
            if (!v) return;
            var l = tokens(); l.forEach(function (x) { if (x.id === t.id) x.name = v.name.trim(); }); if (!await saveTokens(l)) return; render();
        } else if (id === 'del') {
            var active = t.value === U.token();
            var ok = await U.confirmBox('Удалить токен?',
                'Токен «' + (t.name || 'Токен') + '» будет удалён с этого устройства.' + (active ? '\nОн сейчас активный — приложение потеряет доступ к GitHub, пока вы не выберете другой.' : '') +
                '\n\nНа самом GitHub токен останется действующим — отозвать его можно в настройках GitHub.', 'Удалить', true);
            if (!ok) return;
            if (!await saveTokens(tokens().filter(function (x) { return x.id !== t.id; }))) return;
            if (active && !await requireSecureSave(U.ls('unzipgit_token', null))) return;
            render();
        }
    }
    async function addToken() {
        var id = await U.sheet('Добавить токен', [
            { id: 'paste', icon: 'add', label: 'Вставить готовый токен' },
            { id: 'classic', icon: 'open', label: 'Создать токен на GitHub (классический)' },
            { id: 'fine', icon: 'open', label: 'Создать точечный токен на GitHub' }
        ]);
        if (id === 'classic') {
            U.openExternal('https://github.com/settings/tokens/new?description=UnzipGit&scopes=repo,delete_repo,read:public_key,admin:public_key');
            U.toast('Создайте токен на GitHub, скопируйте его и вернитесь сюда', 4500);
        } else if (id === 'fine') {
            U.openExternal('https://github.com/settings/personal-access-tokens/new');
            U.toast('Создайте токен на GitHub, скопируйте его и вернитесь сюда', 4500);
        } else if (id === 'paste') {
            var v = await U.form('Новый токен', 'Токен будет проверен и сохранён на этом устройстве.', [
                { id: 'name', label: 'Название', type: 'text', placeholder: 'Например: Основной' },
                { id: 'value', label: 'Токен', type: 'password', placeholder: 'ghp_… или github_pat_…' },
                { id: 'act', label: 'Сделать активным', type: 'checkbox', value: true }
            ], 'Проверить и сохранить', function (x) { return x.value.trim() ? (U.tokenFormatError ? U.tokenFormatError(U.normalizeToken(x.value)) : '') : 'Вставьте токен'; });
            if (!v) return;
            var val = U.normalizeToken ? U.normalizeToken(v.value) : v.value.trim();
            if (tokens().some(function (t) { return t.value === val; })) { U.toast('Такой токен уже сохранён'); return; }
            if (T.verifying) return;
            T.verifying = true;
            try {
                var r = await U.run('Проверка токена…', async function () {
                    var x = await U.gh('GET', '/user', undefined, val, true);
                    if (!x.ok) throw new Error(U.errMsg(x));
                    if (!x.data || typeof x.data.login !== 'string' || !x.data.login.trim()) throw new Error('GitHub вернул пустую или некорректную информацию об аккаунте.');
                    return x.data;
                }, 20000);
                if (!r.ok) return;
                var t = { id: U.randomId(), name: v.name.trim() || ('Токен ' + r.v.login), value: val, kind: 'github', login: r.v.login, created: Date.now() };
                var l = tokens(); l.push(t); if (!await saveTokens(l)) return;
                if (v.act) await activate(t); else { render(); U.toast('Токен сохранён'); }
            } catch (e) {
                U.toast('Не удалось добавить токен: ' + String((e && e.message) || e).slice(0, 240), 4500);
            } finally { T.verifying = false; }
        }
    }

    // ---------- вкладка «SSH-ключи» ----------
    async function loadSsh() {
        if (T.loading) return;
        T.loading = true;
        if (!U.token()) { T.ssh = []; T.sshErr = 'Нет активного токена. Добавьте его на вкладке «Токены GitHub».'; T.loading = false; render(); return; }
        var r = await U.run('Загрузка ключей…', async function () {
            var x = await U.gh('GET', '/user/keys?per_page=100');
            if (!x.ok) throw new Error(U.errMsg(x, 'Для просмотра ключей токену нужно право read:public_key (классический) или «Git SSH keys: Read» (точечный).'));
            return x.data;
        });
        if (r.ok) { T.ssh = Array.isArray(r.v) ? r.v : []; T.sshErr = ''; }
        else { T.ssh = []; T.sshErr = 'Не удалось загрузить список ключей. Проверьте права токена.'; }
        T.loading = false;
        render();
    }
    function renderSsh(box) {
        if (T.ssh === null) { loadSsh(); return; }
        if (T.sshErr) { box.appendChild(empty('warn', T.sshErr)); }
        else if (!T.ssh.length) { box.appendChild(empty('key', 'SSH-ключей в аккаунте пока нет.')); }
        T.ssh.forEach(function (k) {
            var c = el('div', 'card');
            var top = el('div', 'top');
            var av = el('div', 'avatar'); av.appendChild(U.icon('key', 22)); top.appendChild(av);
            var m = el('div', 'meta');
            m.appendChild(el('div', 'nm', k.title || 'Без названия'));
            var info = el('div', 'info');
            var kt = String(k.key || '').split(' ')[0];
            if (kt) info.appendChild(el('span', 'badge', kt));
            if (k.created_at) info.appendChild(el('span', '', U.fmtDate(k.created_at)));
            m.appendChild(info);
            var kk = String(k.key || '');
            m.appendChild(el('div', 'secret mono', kk.length > 60 ? kk.slice(0, 28) + ' … ' + kk.slice(-16) : kk));
            top.appendChild(m);
            c.appendChild(top);
            var a = el('div', 'actions');
            a.appendChild(U.btn('', 'copy', 'Копировать', function () { U.copyText(k.key); }));
            a.appendChild(U.btn('danger', 'del', 'Удалить', function () { deleteSsh(k); }));
            c.appendChild(a);
            box.appendChild(c);
        });
    }
    async function addSsh() {
        if (!U.token()) { U.toast('Сначала добавьте токен'); return; }
        var v = await U.form('Добавить SSH-ключ', 'Вставьте открытый ключ (файл .pub). Закрытый ключ никогда никому не отправляйте.', [
            { id: 'title', label: 'Название', type: 'text', placeholder: 'Например: Телефон' },
            { id: 'key', label: 'Открытый ключ', type: 'textarea', placeholder: 'ssh-ed25519 AAAA…' }
        ], 'Добавить', function (x) {
            if (!x.title.trim()) return 'Введите название';
            if (!/^(ssh-|ecdsa-|sk-)/.test(x.key.trim())) return 'Ключ должен начинаться с ssh-ed25519, ssh-rsa и т. п.';
            if (/PRIVATE KEY/.test(x.key)) return 'Это закрытый ключ! Нужен открытый (.pub)';
            return '';
        });
        if (!v) return;
        var r = await U.run('Добавление ключа…', async function () {
            var x = await U.gh('POST', '/user/keys', { title: v.title.trim(), key: v.key.trim() });
            if (!x.ok) throw new Error(U.errMsg(x, 'Для добавления ключей токену нужно право admin:public_key (классический) или «Git SSH keys: Read and write» (точечный).'));
        });
        if (r.ok) { U.toast('Ключ добавлен'); T.ssh = null; render(); }
    }
    async function deleteSsh(k) {
        var ok = await U.confirmBox('Удалить SSH-ключ?', '«' + (k.title || 'Без названия') + '» перестанет работать для доступа к GitHub.', 'Удалить', true);
        if (!ok) return;
        var r = await U.run('Удаление…', async function () {
            var x = await U.gh('DELETE', '/user/keys/' + k.id);
            if (!x.ok && x.status !== 204) throw new Error(U.errMsg(x, 'Для удаления ключей токену нужно право admin:public_key.'));
        });
        if (r.ok) { T.ssh = T.ssh.filter(function (x) { return x.id !== k.id; }); U.toast('Ключ удалён'); render(); }
    }

    // ---------- вкладка «Ключи API» ----------
    function genKey(bytes, fmt, prefix) {
        var a = new Uint8Array(bytes);
        crypto.getRandomValues(a);
        var s;
        if (fmt === 'hex') s = Array.from(a).map(function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
        else s = btoa(String.fromCharCode.apply(null, a)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        return (prefix || '') + s;
    }
    function renderApi(box) {
        var list = apikeys();
        if (!list.length) { box.appendChild(empty('gen', 'Ключей пока нет. Нажмите «Создать ключ».')); return; }
        list.forEach(function (k) {
            var c = el('div', 'card');
            var top = el('div', 'top');
            var av = el('div', 'avatar'); av.appendChild(U.icon('gen', 22)); top.appendChild(av);
            var m = el('div', 'meta');
            m.appendChild(el('div', 'nm', k.name || 'Ключ'));
            var info = el('div', 'info');
            info.appendChild(el('span', '', U.fmtDate(k.created)));
            info.appendChild(el('span', '', 'длина: ' + k.value.length));
            m.appendChild(info);
            m.appendChild(secretRow(k.value, k.id));
            top.appendChild(m);
            top.appendChild(U.iconBtn(T.shown[k.id] ? 'eyeoff' : 'eye', 'sm', 'Показать или скрыть', function () { T.shown[k.id] = !T.shown[k.id]; render(); }));
            c.appendChild(top);
            var a = el('div', 'actions');
            a.appendChild(U.btn('primary', 'copy', 'Копировать', function () { U.copyText(k.value); }));
            a.appendChild(U.btn('danger', 'del', 'Удалить', async function () {
                var ok = await U.confirmBox('Удалить ключ?', '«' + (k.name || 'Ключ') + '» будет удалён с устройства без возможности восстановления.', 'Удалить', true);
                if (!ok) return;
                if (!await saveApikeys(apikeys().filter(function (x) { return x.id !== k.id; }))) return;
                render();
            }));
            c.appendChild(a);
            box.appendChild(c);
        });
    }
    async function addApi() {
        var v = await U.form('Новый ключ API', null, [
            { id: 'name', label: 'Название', type: 'text', placeholder: 'Например: Мой сервер' },
            { id: 'prefix', label: 'Префикс (необязательно)', type: 'text', placeholder: 'sk_live_' },
            { id: 'size', label: 'Длина', type: 'select', value: '32', options: [
                { value: '16', label: 'Короткий (16 байт)' }, { value: '32', label: 'Стандартный (32 байта)' }, { value: '48', label: 'Длинный (48 байт)' }] },
            { id: 'fmt', label: 'Формат', type: 'select', value: 'hex', options: [
                { value: 'hex', label: 'Шестнадцатеричный (0-9, a-f)' }, { value: 'b64', label: 'Base64 (буквы, цифры, - и _)' }] }
        ], 'Создать', function (x) {
            if (!x.name.trim()) return 'Введите название';
            if (x.prefix && !/^[A-Za-z0-9_.-]*$/.test(x.prefix)) return 'Префикс: латинские буквы, цифры, «_», «-», «.»';
            return '';
        });
        if (!v) return;
        var value;
        try { value = genKey(parseInt(v.size, 10), v.fmt, v.prefix.trim()); }
        catch (e) { U.showError('Не удалось создать ключ: в этом устройстве недоступен генератор случайных чисел'); return; }
        var k = { id: U.randomId(), name: v.name.trim(), value: value, created: Date.now() };
        var l = apikeys(); l.unshift(k); if (!await saveApikeys(l)) return;
        T.shown[k.id] = true;
        render();
        U.copyText(value);
    }

    // ---------- каркас ----------
    function render() {
        var tabs = $('tabs');
        tabs.textContent = '';
        TABS.forEach(function (x) {
            var b = el('button', 'tab' + (T.tab === x[0] ? ' on' : ''), x[1]);
            b.onclick = function () { T.tab = x[0]; render(); };
            tabs.appendChild(b);
        });
        $('note').innerHTML = NOTES[T.tab];
        var fab = $('fab');
        fab.textContent = '';
        fab.appendChild(U.icon('add', 24));
        fab.appendChild(document.createTextNode(T.tab === 'tokens' ? 'Добавить' : (T.tab === 'ssh' ? 'Добавить ключ' : 'Создать ключ')));
        var box = $('list');
        box.textContent = '';
        var cur = U.token();
        $('sub').textContent = cur ? 'Активный токен: ' + U.mask(cur) : 'Токен не выбран';
        if (T.tab === 'tokens') renderTokens(box);
        else if (T.tab === 'ssh') renderSsh(box);
        else renderApi(box);
    }

    document.addEventListener('DOMContentLoaded', function () {
        $('btnRefresh').appendChild(U.icon('refresh', 22));
        $('btnRefresh').onclick = function () {
            if (T.tab === 'ssh') { T.ssh = null; }
            render();
        };
        $('fab').onclick = function () {
            if (T.tab === 'tokens') addToken();
            else if (T.tab === 'ssh') addSsh();
            else addApi();
        };
        render();
    });
    window.addEventListener('aib-secrets-ready', function () {
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', render, { once: true });
        else render();
    });

    window.__onBack = function () {
        if (U.isModalOpen()) { U.modalCancel(); return true; }
        if (U.isSheetOpen()) { U.closeSheet(); return true; }
        if (U.isBusy()) return true;
        return false;
    };
})();
