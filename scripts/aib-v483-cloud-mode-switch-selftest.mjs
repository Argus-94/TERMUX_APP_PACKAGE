import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import Module from "node:module";
import { typescript as ts } from "./test-helpers/load-typescript.mjs";

// Production TSX executed with a small hook/element scheduler, not Android.
function compile(relative, deps = {}) {
  const filename = path.resolve(relative);
  const mod = new Module(filename);
  mod.filename = filename;
  mod.require = name => {
    if (Object.hasOwn(deps, name)) return deps[name];
    throw new Error("Unexpected test dependency: " + name);
  };
  const result = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
    reportDiagnostics: true,
  });
  assert.equal((result.diagnostics || []).filter(d => d.category === ts.DiagnosticCategory.Error).length, 0);
  mod._compile(result.outputText, filename);
  return mod.exports;
}
const native = Object.fromEntries(["ActivityIndicator", "Text", "TextInput", "TouchableOpacity", "View"].map(name => [name, name]));
native.StyleSheet = { create: styles => styles };
const jsx = (type, props) => ({ type, props });
function nodes(tree, type) {
  const found = [];
  const visit = node => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(visit);
    if (node.type === type) found.push(node);
    visit(node.props?.children);
  };
  visit(tree);
  return found;
}
function text(tree) { return nodes(tree, "Text").map(n => n.props.children).flat().join(" "); }
function fixture({ loaded = true, hasApiKey = true, mode = "online", language = "ru" } = {}) {
  const slots = []; let cursor = 0; const effects = [];
  const same = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
  const react = {
    useState: initial => {
      const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === "function" ? initial() : initial;
      return [slots[i], value => { slots[i] = typeof value === "function" ? value(slots[i]) : value; }];
    },
    useRef: initial => { const i = cursor++; if (!(i in slots)) slots[i] = { current: initial }; return slots[i]; },
    useCallback: (fn, deps) => { const i = cursor++; if (!slots[i] || !same(slots[i].deps, deps)) slots[i] = { fn, deps }; return slots[i].fn; },
    useEffect: (fn, deps) => { const i = cursor++; if (!slots[i] || !same(slots[i].deps, deps)) { slots[i] = { deps }; effects.push(fn); } },
  };
  let apiCalls = 0, resolveProbe;
  const api = { validateManusAccount: async () => { apiCalls++; await new Promise(resolve => { resolveProbe = resolve; }); } };
  const card = compile("components/ManusProviderCard.tsx", {
    react, "react/jsx-runtime": { jsx, jsxs: jsx }, "react-native": native,
    "expo-router": { useFocusEffect: () => {} }, "../lib/manus-api": api,
    "../hooks/useManusCredits": { useManusCredits: () => ({ loading: false, error: "", refresh: async () => {} }) },
    "./ManusCreditsPanel": { ManusCreditsPanel: "ManusCreditsPanel" },
    "./Checkbox": { Checkbox: "Checkbox" },
  }).ManusProviderCard;
  const selections = [];
  const props = {
    language, mode, colors: { accent: "blue", accentDim: "navy", muted: "gray", line: "black", surface: "white", surfaceRaised: "white", inkBright: "black", warning: "orange" },
    setMode: next => { selections.push(next); props.mode = next; },
    settings: { manus: { loaded, hasApiKey, profile: "standard", binding: "fixture" }, saveManusKey: async () => true, setManusProfile: async () => true, removeManusKey: async () => true },
  };
  const render = () => { cursor = 0; const tree = card(props); effects.splice(0).forEach(fn => fn()); return tree; };
  const getCheckbox = () => nodes(render(), "Checkbox")[0].props;
  render();
  return { props, render, getCheckbox, selections, get apiCalls() { return apiCalls; }, finishProbe: () => resolveProbe() };
}
for (const initial of ["local", "online", "custom", "opencode"]) {
  const f = fixture({ mode: initial });
  const control = f.getCheckbox(); assert.equal(control.disabled, false); assert.equal(control.checked, false);
  control.onPress();
  assert.deepEqual(f.selections, ["manus"]);
  assert.equal(f.getCheckbox().checked, true);
  assert.match(text(f.render()), /Облачный режим выбран для чата/);
  assert.equal(f.apiCalls, 0, "selection must not submit a task or check an account");
  f.getCheckbox().onPress();
  assert.deepEqual(f.selections, ["manus", "local"]);
  assert.equal(f.getCheckbox().checked, false);
}
for (const state of [{ loaded: false }, { hasApiKey: false }]) {
  const f = fixture(state); const control = f.getCheckbox();
  assert.equal(control.disabled, true); control.onPress(); assert.deepEqual(f.selections, []);
  assert.match(control.accessibilityHint, state.loaded === false ? /не загружены/ : /сохраните API-ключ/);
}
const verified = fixture();
const checking = nodes(verified.render(), "TouchableOpacity").find(n => n.props.accessibilityLabel === "Проверить аккаунт");
checking.props.onPress();
assert.equal(verified.getCheckbox().disabled, true);
verified.getCheckbox().onPress(); assert.deepEqual(verified.selections, []);
verified.finishProbe(); await new Promise(resolve => setImmediate(resolve));
assert.equal(verified.getCheckbox().disabled, false);
assert.match(text(verified.render()), /Сохранённый ключ: аккаунт проверен/);
verified.getCheckbox().onPress(); assert.equal(verified.getCheckbox().checked, true);
for (const language of ["ru", "uk", "en"]) {
  const f = fixture({ language }); assert.ok(f.getCheckbox().label); assert.ok(f.getCheckbox().accessibilityHint);
}
const normalize = compile("lib/model-mode.ts").normalizePersistedModelMode;
for (const mode of ["local", "online", "custom", "opencode", "manus"]) assert.equal(normalize(mode), mode);
assert.equal(normalize("unknown"), "local");
const settings = fs.readFileSync("app/settings.tsx", "utf8");
assert.match(settings, /<ScrollView[^>]*keyboardShouldPersistTaps="handled"/);
assert.match(settings, /<ManusProviderCard[^>]*mode=\{mode\} setMode=\{setMode\}/);
const config = fs.readFileSync("app.config.ts", "utf8");
assert.match(config, /package: "com\.karat\.aibuilder"/);
assert.match(config, /versionCode: 512/);
assert.equal(JSON.parse(fs.readFileSync("package.json", "utf8")).version, "1.10.112");
console.log("AIB_V483_CLOUD_MODE_SWITCH_SELFTEST_OK runtime=mock-hook+TSX on=all-providers off=local guards=loading+missing-key+checking verified-key=selectable api-on-selection=none normalization=all-modes NO_ANDROID_DEVICE_PROOF");

// The shared component retains role/state and the mode explanation for screen readers.
const actualCheckbox = compile("components/Checkbox.tsx", {
  "react/jsx-runtime": { jsx, jsxs: jsx }, "react-native": native,
  "@expo/vector-icons": { Ionicons: "Ionicons" },
  "./ThemeContext": { useTheme: () => ({ colors: {}, isDark: false }) },
}).Checkbox;
const checkboxTree = actualCheckbox({ checked: true, disabled: true, onPress() {}, label: "provider", accessibilityHint: "why disabled" });
assert.equal(checkboxTree.props.accessibilityRole, "checkbox");
assert.equal(checkboxTree.props.accessibilityLabel, "provider");
assert.equal(checkboxTree.props.accessibilityHint, "why disabled");
assert.deepEqual(checkboxTree.props.accessibilityState, { checked: true, disabled: true });
