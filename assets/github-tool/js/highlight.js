// Лёгкая подсветка синтаксиса для встроенного редактора (без внешних библиотек)
(function () {
    'use strict';

    function esc(s) {
        return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
    function set(str) {
        var o = Object.create(null);
        str.split(/\s+/).forEach(function (w) { if (w) o[w] = 1; });
        return o;
    }
    var LIT = set('true false null undefined NaN Infinity None True False nil TRUE FALSE NULL');
    var END = '(?:$(?![\\s\\S]))'; // конец текста

    var KW = {
        js: set('break case catch class const continue debugger default delete do else export extends finally for from function if import in instanceof let new of return static super switch this throw try typeof var void while with yield async await get set as enum implements interface package private protected public type namespace declare readonly abstract module keyof infer is satisfies require'),
        jvm: set('abstract as break by catch class companion const constructor continue data default do else enum extends final finally for fun get if implements import in init inline instanceof interface internal is lateinit new object open operator out override package private protected public return sealed set static super suspend switch synchronized this throw throws try typealias val var vararg when while void int long double float boolean byte char short def task apply plugins dependencies repositories android buildscript'),
        py: set('and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield self cls print'),
        c: set('auto bool break case catch char class const continue default delete do double else enum explicit extern final float for friend goto if inline int long namespace new nullptr operator override private protected public register return short signed sizeof static struct switch template this throw try typedef typename union unsigned using virtual void volatile while string var readonly foreach in is as base params ref out abstract sealed lock get set async await'),
        go: set('break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var string int int64 int32 uint bool byte rune error float64 float32'),
        rs: set('as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait type unsafe use where while i32 i64 u8 u32 u64 usize f32 f64 bool str String Vec Option Result'),
        swift: set('as associatedtype break case catch class continue default defer do else enum extension fallthrough fileprivate for func guard if import in init inout internal is let nil open operator private protocol public repeat rethrows return self Self static struct subscript super switch throw throws try typealias var where while async await'),
        dart: set('abstract as assert async await break case catch class const continue covariant default deferred do dynamic else enum export extends extension external factory final finally for get if implements import in interface is late library mixin new on operator part required rethrow return set static super switch sync this throw try typedef var void while with yield int double String bool List Map'),
        php: set('abstract and array as break callable case catch class clone const continue declare default do echo else elseif empty enddeclare endfor endforeach endif endswitch endwhile extends final finally fn for foreach function global goto if implements include include_once instanceof insteadof interface isset list match namespace new or print private protected public readonly require require_once return static switch throw trait try unset use var while xor yield'),
        sh: set('if then else elif fi case esac for while until do done in function select time return exit break continue export local readonly declare unset shift source alias echo cd ls cat grep sed awk set trap eval exec test FROM RUN CMD COPY ADD ENV WORKDIR EXPOSE ENTRYPOINT ARG VOLUME USER LABEL'),
        sql: set('select from where and or not in is null like between join inner outer left right full cross on group by order having limit offset insert into values update set delete create alter drop table index view database primary key foreign references unique default constraint as distinct union all case when then else end exists asc desc count sum avg min max begin commit rollback'),
        rb: set('alias and begin break case class def defined do else elsif end ensure for if in module next not or redo rescue retry return self super then undef unless until when while yield require include extend attr_accessor attr_reader attr_writer puts'),
        lua: set('and break do else elseif end for function goto if in local not or repeat return then until while'),
        none: Object.create(null)
    };

    // Описание языков
    var LANGS = {
        js:    { kw: KW.js,    lc: '\\/\\/[^\\n]*', bc: true, q: '"\'`', at: true },
        jvm:   { kw: KW.jvm,   lc: '\\/\\/[^\\n]*', bc: true, q: '"\'', tq: true, at: true },
        py:    { kw: KW.py,    lc: '#[^\\n]*',       q: '"\'', tq: true, at: true },
        c:     { kw: KW.c,     lc: '\\/\\/[^\\n]*', bc: true, q: '"\'', pre: true },
        go:    { kw: KW.go,    lc: '\\/\\/[^\\n]*', bc: true, q: '"\'`' },
        rs:    { kw: KW.rs,    lc: '\\/\\/[^\\n]*', bc: true, q: '"\'' },
        swift: { kw: KW.swift, lc: '\\/\\/[^\\n]*', bc: true, q: '"\'', at: true },
        dart:  { kw: KW.dart,  lc: '\\/\\/[^\\n]*', bc: true, q: '"\'', at: true },
        php:   { kw: KW.php,   lc: '(?:\\/\\/|#)[^\\n]*', bc: true, q: '"\'', vars: 'php' },
        sh:    { kw: KW.sh,    lc: '#[^\\n]*',       q: '"\'`', vars: 'sh' },
        sql:   { kw: KW.sql,   lc: '--[^\\n]*',      bc: true, q: '"\'', ci: true },
        rb:    { kw: KW.rb,    lc: '#[^\\n]*',       q: '"\'', vars: 'rb' },
        lua:   { kw: KW.lua,   lc: '--[^\\n]*',      q: '"\'' },
        yaml:  { kw: KW.none,  lc: '#[^\\n]*',       q: '"\'', key: true },
        ini:   { kw: KW.none,  lc: '[#;][^\\n]*',    q: '"\'', key: true, sect: true },
        plain: null
    };

    var EXT = {
        js: 'js', mjs: 'js', cjs: 'js', jsx: 'js', ts: 'js', tsx: 'js',
        java: 'jvm', kt: 'jvm', kts: 'jvm', gradle: 'jvm', groovy: 'jvm', scala: 'jvm',
        py: 'py', pyw: 'py', pyi: 'py',
        c: 'c', h: 'c', cpp: 'c', cc: 'c', cxx: 'c', hpp: 'c', cs: 'c', m: 'c', mm: 'c',
        go: 'go', rs: 'rs', swift: 'swift', dart: 'dart', php: 'php',
        sh: 'sh', bash: 'sh', zsh: 'sh', command: 'sh',
        sql: 'sql', rb: 'rb', lua: 'lua',
        json: 'json', jsonc: 'json', json5: 'json', map: 'json', webmanifest: 'json',
        html: 'markup', htm: 'markup', xml: 'markup', svg: 'markup', xhtml: 'markup', vue: 'markup', plist: 'markup', xsl: 'markup', rss: 'markup',
        css: 'css', scss: 'css', less: 'css',
        md: 'md', markdown: 'md',
        yml: 'yaml', yaml: 'yaml',
        toml: 'ini', ini: 'ini', cfg: 'ini', conf: 'ini', properties: 'ini', env: 'ini', gitignore: 'ini', editorconfig: 'ini'
    };
    var NAMES = {
        'dockerfile': 'sh', 'makefile': 'sh', 'gradlew': 'sh', '.gitignore': 'ini', '.env': 'ini',
        '.gitattributes': 'ini', 'proguard-rules.pro': 'ini', 'gradle.properties': 'ini', 'local.properties': 'ini'
    };
    var LANG_TITLE = {
        js: 'JavaScript/TS', jvm: 'Kotlin/Java', py: 'Python', c: 'C/C++/C#', go: 'Go', rs: 'Rust', swift: 'Swift',
        dart: 'Dart', php: 'PHP', sh: 'Shell', sql: 'SQL', rb: 'Ruby', lua: 'Lua', json: 'JSON', markup: 'XML/HTML',
        css: 'CSS', md: 'Markdown', yaml: 'YAML', ini: 'INI/Props', plain: 'Текст'
    };

    function langOf(filename) {
        var base = String(filename || '').split('/').pop().toLowerCase();
        if (NAMES[base]) return NAMES[base];
        var i = base.lastIndexOf('.');
        var ext = i >= 0 ? base.slice(i + 1) : '';
        return EXT[ext] || 'plain';
    }

    // Проходит по тексту регулярным выражением, экранируя «промежутки»
    function scan(text, re, fn) {
        var out = '', last = 0, m;
        re.lastIndex = 0;
        while ((m = re.exec(text)) !== null) {
            if (m[0] === '') { re.lastIndex++; continue; }
            if (m.index > last) out += esc(text.slice(last, m.index));
            out += fn(m, re);
            last = re.lastIndex;
        }
        if (last < text.length) out += esc(text.slice(last));
        return out;
    }
    function span(cls, s) { return '<span class="hl-' + cls + '">' + esc(s) + '</span>'; }

    var compiled = {};
    function compile(name) {
        if (compiled[name]) return compiled[name];
        var d = LANGS[name], parts = [], kinds = [];
        function add(kind, src) { parts.push('(' + src + ')'); kinds.push(kind); }
        if (d.bc) add('c', '\\/\\*[\\s\\S]*?(?:\\*\\/|' + END + ')');
        if (d.lc) add('c', d.lc);
        if (d.sect) add('h', '(?<![^\\n])[ \\t]*\\[[^\\]\\n]*\\]');
        if (d.tq) add('s', '"""[\\s\\S]*?(?:"""|' + END + ')|\'\'\'[\\s\\S]*?(?:\'\'\'|' + END + ')');
        if (d.q.indexOf('"') >= 0) add('s', '"(?:\\\\[\\s\\S]|[^"\\\\\\n])*"?');
        if (d.q.indexOf("'") >= 0) add('s', "'(?:\\\\[\\s\\S]|[^'\\\\\\n])*'?");
        if (d.q.indexOf('`') >= 0) add('s', '`(?:\\\\[\\s\\S]|[^`\\\\])*`?');
        if (d.key) add('p', '(?<=(?:^|\\n)[ \\t]*(?:-[ \\t]+)?)[\\w.\\-\\/]+(?=[ \\t]*[:=])');
        if (d.pre) add('a', '(?<![^\\n])[ \\t]*#[ \\t]*[a-z]+');
        if (d.at) add('a', '@[A-Za-z_][\\w.]*');
        if (d.vars === 'sh') add('a', '\\$\\{?[A-Za-z_@#?*$!0-9][\\w]*\\}?');
        if (d.vars === 'php') add('a', '\\$[A-Za-z_][\\w]*');
        if (d.vars === 'rb') add('a', '@{1,2}[A-Za-z_][\\w]*|:[A-Za-z_][\\w]*');
        add('n', '\\b0[xX][\\da-fA-F]+\\b|\\b\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?\\b');
        add('w', '[A-Za-z_$][\\w$]*');
        var res = { re: new RegExp(parts.join('|'), 'g'), kinds: kinds, d: d };
        compiled[name] = res;
        return res;
    }

    function highlightGeneric(text, name) {
        var c = compile(name), d = c.d, kinds = c.kinds;
        return scan(text, c.re, function (m, re) {
            var g = 1;
            while (g < m.length && m[g] === undefined) g++;
            var kind = kinds[g - 1], s = m[0];
            if (kind !== 'w') return span(kind, s);
            var key = d.ci ? s.toLowerCase() : s;
            if (d.kw[key]) return span('k', s);
            if (LIT[s]) return span('n', s);
            if (text.charAt(re.lastIndex) === '(') return span('f', s);
            if (s.length > 1 && /^[A-Z]/.test(s) && /[a-z]/.test(s)) return span('t', s);
            return esc(s);
        });
    }

    function highlightJson(text) {
        var re = /"(?:\\[\s\S]|[^"\\\n])*"?|-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b|\b(?:true|false|null)\b|\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$(?![\s\S]))/g;
        return scan(text, re, function (m, r) {
            var s = m[0], c = s.charAt(0);
            if (c === '"') {
                var rest = text.slice(r.lastIndex, r.lastIndex + 40);
                return /^\s*:/.test(rest) ? span('p', s) : span('s', s);
            }
            if (c === '/') return span('c', s);
            if (c === 't' || c === 'f' || c === 'n') return span('n', s);
            return span('n', s);
        });
    }

    function highlightTag(t) {
        var m = /^(<\/?)([A-Za-z][\w:.-]*)([\s\S]*?)(\/?>?)$/.exec(t);
        if (!m) return esc(t);
        var attrRe = /([^\s"'<>\/=]+)(\s*=\s*)?("[^"]*"|'[^']*'|[^\s"'>\/][^\s"'>]*)?/g;
        var attrs = scan(m[3], attrRe, function (a) {
            var out = span('a', a[1]);
            if (a[2]) out += esc(a[2]);
            if (a[3]) out += span('s', a[3]);
            return out;
        });
        return esc(m[1]) + span('g', m[2]) + attrs + esc(m[4]);
    }
    function highlightMarkup(text) {
        var re = /<!--[\s\S]*?(?:-->|$(?![\s\S]))|<![A-Za-z][^>]*>?|<\?[\s\S]*?(?:\?>|$(?![\s\S]))|<\/?[A-Za-z][\w:.-]*(?:"[^"]*"|'[^']*'|[^'">])*>?/g;
        return scan(text, re, function (m) {
            var s = m[0];
            if (s.indexOf('<!--') === 0 || s.indexOf('<?') === 0 || s.indexOf('<!') === 0) return span('c', s);
            return highlightTag(s);
        });
    }

    function highlightCss(text) {
        var re = /\/\*[\s\S]*?(?:\*\/|$(?![\s\S]))|"(?:\\[\s\S]|[^"\\\n])*"?|'(?:\\[\s\S]|[^'\\\n])*'?|@[\w-]+|#[0-9a-fA-F]{3,8}\b|-?\b\d+(?:\.\d+)?[a-zA-Z%]*|[A-Za-z-]+(?=\s*:[^;{}\n]*(?:;|\}|\n))|\.[A-Za-z_-][\w-]*|\/\/[^\n]*/g;
        return scan(text, re, function (m) {
            var s = m[0], c = s.charAt(0);
            if (c === '/') return span('c', s);
            if (c === '"' || c === "'") return span('s', s);
            if (c === '@') return span('k', s);
            if (c === '#' || c === '-' || (c >= '0' && c <= '9')) return span('n', s);
            if (c === '.') return span('t', s);
            return span('p', s);
        });
    }

    function highlightMd(text) {
        var re = /(?<![^\n])```[\s\S]*?(?:(?<![^\n])```|$(?![\s\S]))|(?<![^\n])#{1,6}[ \t][^\n]*|(?<![^\n])>[^\n]*|`[^`\n]+`|\*\*[^*\n]+\*\*|!?\[[^\]\n]*\]\([^)\n]*\)|(?<![^\n])[ \t]*(?:[-*+]|\d+\.)[ \t]/g;
        return scan(text, re, function (m) {
            var s = m[0], c = s.charAt(0);
            if (c === '#') return span('h', s);
            if (c === '>') return span('c', s);
            if (c === '`') return span('s', s);
            if (c === '*') return span('k', s);
            if (c === '[' || c === '!') return span('f', s);
            return span('a', s);
        });
    }

    function highlight(text, filename) {
        var lang = langOf(filename);
        try {
            switch (lang) {
                case 'plain': return esc(text);
                case 'json': return highlightJson(text);
                case 'markup': return highlightMarkup(text);
                case 'css': return highlightCss(text);
                case 'md': return highlightMd(text);
                default: return highlightGeneric(text, lang);
            }
        } catch (e) {
            return esc(text);
        }
    }

    window.Highlight = {
        highlight: highlight,
        langOf: langOf,
        title: function (filename) { return LANG_TITLE[langOf(filename)] || 'Текст'; },
        esc: esc
    };
})();
