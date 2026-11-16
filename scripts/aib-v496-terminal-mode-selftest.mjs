import assert from 'node:assert/strict';
import fs from 'node:fs';
import Module from 'node:module';
import path from 'node:path';
import { typescript as ts } from './test-helpers/load-typescript.mjs';
const filename = path.resolve(new URL('../app/terminal.tsx', import.meta.url).pathname);
const source = fs.readFileSync(filename, 'utf8');
const jsx = (type, props, key) => ({ type, props, key });
function nodes(tree, type) {
  const out = [];
  function visit(n) {
    if (Array.isArray(n)) return n.forEach(visit);
    if (!n || typeof n !== 'object') return;
    if (n.type === type) out.push(n);
    visit(n.props?.children);
  }
  visit(tree); return out;
}
function text(n) {
  if (Array.isArray(n)) return n.map(text).join('');
  if (n == null || typeof n === 'boolean') return '';
  return typeof n === 'object' ? text(n.props?.children) : String(n);
}
function fixture(language = 'ru') {
  const slots = [], calls = []; let cursor = 0, hasBack = true, settleProbe;
  const react = {
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial;
      return [slots[i], value => { slots[i] = typeof value === 'function' ? value(slots[i]) : value; }]; },
    useRef(initial) { const i = cursor++; if (!(i in slots)) slots[i] = { current: initial }; return slots[i]; },
    useMemo(fn) { cursor++; return fn(); },
    useCallback(fn) { cursor++; return fn; },
    useEffect() { cursor++; },
  };
  const session = { id: 'session-test', projectId: 'demo', cwd: '/storage/emulated/0/AIBuilderTermux/projects/demo', state: 'attached', scrollback: '' };
  const facade = { terminalUx: {
    list: async () => [session], openProjectSession: async () => session,
    send: async (...args) => { calls.push(['send', ...args]); },
    appendScrollback: async () => {},
  } };
  const deps = {
    react,
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' },
    'react-native': Object.fromEntries(['KeyboardAvoidingView', 'ScrollView', 'Text', 'TextInput', 'TouchableOpacity', 'View'].map(x => [x, x])),
    '@react-native-async-storage/async-storage': { getItem: async () => null },
    'react-native-safe-area-context': { useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) },
    'expo-router': { useRouter: () => ({ canGoBack: () => hasBack, back: () => calls.push(['back']), replace: p => calls.push(['replace', p]) }) },
    '@expo/vector-icons': { Ionicons: 'Ionicons' }, 'expo-clipboard': {},
    '../components/LanguageContext': { useLanguage: () => ({ language }) },
    '../components/ThemeContext': { useTheme: () => ({ colors: {} }) },
    '../components/ProjectContext': { useProjectContext: () => ({ project: null }) },
    '../lib/runtime-facade': { getRuntimeFacade: () => facade },
    '../lib/termux-executor': {},
    '../lib/persistent-logger': { persistentLogger: { add: (...args) => calls.push(['log', ...args]) } },
    '../lib/private-runtime-provider': { privateRuntimeProvider: { execute: () => new Promise(resolve => { settleProbe = resolve; }) } },
    '../lib/termux-command-wait-status': { getTermuxCommandWaitState: () => 'running' },
    '../core/terminal/TerminalOutputBus': {},
    '../core/enhancements/terminal/TerminalQuickActions': { TerminalQuickActions: class { all() { return []; } list() { return []; } } },
    '../core/enhancements/terminal/TerminalCommandInputActions': { createTerminalCommandInputState: () => ({ value: '', selection: { start: 0, end: 0 } }) },
    '../core/enhancements/terminal/AnsiParser': { parseAnsiText: t => [{ text: t, style: {} }] },
    '../components/RuntimeEnhancementPanels': { TerminalPreferencesPanel: 'TerminalPreferencesPanel' },
    '../components/EmbeddedTermuxTerminalView': { EmbeddedTermuxTerminalView: 'EmbeddedTermuxTerminalView' },
  };
  deps['react-native'].Platform = { OS: 'android' };
  const m = new Module(filename); m.filename = filename;
  m.require = id => { assert.ok(Object.hasOwn(deps, id), `unexpected dependency ${id}`); return deps[id]; };
  m._compile(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText, filename);
  const render = () => { cursor = 0; return m.exports.default(); };
  const mode = () => nodes(render(), 'TouchableOpacity').find(n => ['PTY', 'Termux'].includes(text(n)));
  return { render, mode, calls, setBack: v => { hasBack = v; }, finishProbe: () => settleProbe({ stdout: 'AIB_PRIVATE_EXEC_OK', stderr: '', exitCode: 0 }) };
}
for (const language of ['ru', 'uk', 'en']) {
  const f = fixture(language);
  assert.equal(text(f.mode()), 'PTY');
  assert.equal(nodes(f.render(), 'EmbeddedTermuxTerminalView').length, 1);
  assert.equal(nodes(f.render(), 'TextInput').length, 0);
  assert.ok(f.mode().props.accessibilityLabel);
  f.mode().props.onPress();
  assert.equal(text(f.mode()), 'Termux');
  assert.equal(nodes(f.render(), 'EmbeddedTermuxTerminalView').length, 0);
  assert.equal(nodes(f.render(), 'TextInput').length, 1);
  f.mode().props.onPress();
  assert.equal(text(f.mode()), 'PTY');
  assert.deepEqual(f.calls.filter(x => x[0] !== 'log'), [], 'switching does not dispatch commands or change backend');
  assert.equal(f.calls.filter(x => x[0] === 'log').length, 2, 'both mode changes are observable');
  assert.ok(f.calls.filter(x => x[0] === 'log').every(x => !x.join('|').includes('/storage/')), 'mode logs contain no project paths');
  const back = () => nodes(f.render(), 'TouchableOpacity')[0];
  back().props.onPress(); assert.deepEqual(f.calls.pop(), ['back']);
  f.setBack(false); back().props.onPress(); assert.deepEqual(f.calls.pop(), ['replace', '/runtime']);
}
const f = fixture();
const probe = nodes(f.render(), 'TouchableOpacity').find(n => text(n).includes('Проверить запуск'));
probe.props.onPress();
assert.equal(f.mode().props.disabled, true);
f.mode().props.onPress(); assert.equal(text(f.mode()), 'PTY', 'guard holds even if disabled handler called');
assert.ok(nodes(f.render(), 'TouchableOpacity').some(n => n.props.accessibilityLabel === 'Отменить проверку private runtime'));
f.finishProbe(); await new Promise(resolve => setImmediate(resolve));
assert.equal(f.mode().props.disabled, false);
f.mode().props.onPress(); assert.equal(text(f.mode()), 'Termux');
const input = nodes(f.render(), 'TextInput')[0]; input.props.onChangeText('echo test');
const pending = nodes(f.render(), 'TextInput')[0].props.onSubmitEditing();
assert.equal(f.mode().props.disabled, true);
f.mode().props.onPress(); assert.equal(text(f.mode()), 'Termux');
await pending; await new Promise(resolve => setImmediate(resolve));
assert.deepEqual(f.calls.filter(x => x[0] === 'send'), [['send', 'session-test', 'echo test\n', '\n$ echo test\n']]);
assert.equal(f.mode().props.disabled, false);
assert.match(source, /if \(busy \|\| probeAbortControllerRef\.current\) \{/);
assert.doesNotMatch(source, /com\.termux|openExternal|Linking\.openURL/);
console.log('PASS v496: actual transpiled TSX; PTY/Termux roundtrip in ru/uk/en; view/input separation; no command dispatch on switch; probe and command busy guards; cancellation visible; one-shot send; back/history and Runtime fallback. Host hook harness, not mounted React or Android.');
