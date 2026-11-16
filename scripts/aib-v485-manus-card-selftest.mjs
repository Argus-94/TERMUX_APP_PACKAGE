import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import Module from "node:module";
import { typescript as ts } from "./test-helpers/load-typescript.mjs";
const jsx = (type, props) => ({ type, props });
const native = Object.fromEntries(["ActivityIndicator", "Text", "TextInput", "TouchableOpacity", "View"].map(x => [x, x]));
native.StyleSheet = { create: x => x };
function compile(file, mocks) {
  const filename = path.resolve(file), mod = new Module(filename); mod.filename = filename;
  mod.require = name => { if (Object.hasOwn(mocks, name)) return mocks[name]; throw new Error("Unexpected test dependency " + name); };
  mod._compile(ts.transpileModule(fs.readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText, filename);
  return mod.exports;
}
function nodes(tree, type) {
  const result = [];
  function visit(node) { if (!node || typeof node !== "object") return; if (Array.isArray(node)) return node.forEach(visit); if (node.type === type) result.push(node); visit(node.props?.children); }
  visit(tree); return result;
}
const text = tree => nodes(tree, "Text").map(node => node.props.children).flat().join(" ");
const tick = () => new Promise(resolve => setImmediate(resolve));
const colors = { surface: "black", surfaceRaised: "black", ink: "white", inkBright: "white", muted: "gray", accent: "blue", accentDim: "navy", line: "gray", warning: "yellow" };
function cardFixture() {
  const slots = []; let cursor = 0, effects = [], blur, probeCalls = 0, gates = [], finish;
  const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const react = {
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = initial; return [slots[i], next => { slots[i] = typeof next === "function" ? next(slots[i]) : next; }]; },
    useRef(initial) { const i = cursor++; if (!(i in slots)) slots[i] = { current: initial }; return slots[i]; },
    useCallback(fn, deps) { const i = cursor++; if (!slots[i] || !same(slots[i].deps, deps)) slots[i] = { fn, deps }; return slots[i].fn; },
    useEffect(fn, deps) { const i = cursor++; if (!slots[i] || !same(slots[i].deps, deps)) { slots[i] = { deps }; effects.push(fn); } },
  };
  const api = { validateManusAccount: async (draft, signal) => { probeCalls++; await new Promise(resolve => { finish = resolve; }); if (signal.aborted) throw new Error("cancelled"); } };
  const Card = compile("components/ManusProviderCard.tsx", {
    react, "react/jsx-runtime": { jsx, jsxs: jsx }, "react-native": native,
    "expo-router": { useFocusEffect: callback => { blur = callback(); } }, "../lib/manus-api": api,
    "../hooks/useManusCredits": { useManusCredits: enabled => { gates.push(enabled); return { loading: false, error: "", refresh: async () => {} }; } },
    "./ManusCreditsPanel": { ManusCreditsPanel: "BalancePanel" },
    "./Checkbox": { Checkbox: "Checkbox" },
  }).ManusProviderCard;
  const modeChanges = [];
  const props = { language: "ru", mode: "online", colors, setMode: value => modeChanges.push(value), settings: { manus: { loaded: true, hasApiKey: true, binding: "a", profile: "standard" }, saveManusKey: async () => true, setManusProfile: async () => true, removeManusKey: async () => { props.settings.manus.hasApiKey = false; return true; } } };
  const render = () => { cursor = 0; const tree = Card(props); effects.splice(0).forEach(fn => fn()); return tree; };
  render();
  const button = label => nodes(render(), "TouchableOpacity").find(node => node.props.accessibilityLabel === label).props.onPress();
  const edit = value => nodes(render(), "TextInput")[0].props.onChangeText(value);
  return { props, render, button, edit, finish: () => finish(), blur: () => blur(), modeChanges, get probes() { return probeCalls; }, get enabled() { return gates.at(-1); } };
}
let f = cardFixture();
assert.equal(nodes(f.render(), "BalancePanel").length, 0); assert.equal(f.enabled, false); assert.equal(f.probes, 0);
f.button("Проверить аккаунт"); assert.equal(f.probes, 1); f.finish(); await tick();
assert.equal(nodes(f.render(), "BalancePanel").length, 1); assert.equal(f.enabled, true);
f.edit("synthetic-draft"); assert.equal(nodes(f.render(), "BalancePanel").length, 0); assert.equal(f.enabled, false);
f.button("Проверить аккаунт"); f.finish(); await tick(); assert.equal(nodes(f.render(), "BalancePanel").length, 0, "draft verification never enables saved-key balance");
f.button("Сохранить ключ"); await tick(); assert.equal(nodes(f.render(), "BalancePanel").length, 0, "save never inherits draft verification");
f.button("Проверить аккаунт"); f.finish(); await tick(); assert.equal(nodes(f.render(), "BalancePanel").length, 1);
f.props.settings.manus.binding = "b"; assert.equal(nodes(f.render(), "BalancePanel").length, 0, "key rotation hides old balance immediately");
f.render(); f.button("Проверить аккаунт"); f.finish(); await tick(); assert.equal(nodes(f.render(), "BalancePanel").length, 1);
f.blur(); assert.equal(nodes(f.render(), "BalancePanel").length, 0, "blur clears verification");
f.button("Проверить аккаунт"); f.edit("changed-during-check"); f.finish(); await tick(); assert.equal(nodes(f.render(), "BalancePanel").length, 0, "late probe cannot verify edited credentials");
f = cardFixture(); f.button("Проверить аккаунт"); f.finish(); await tick(); f.render();
f.button("Удалить ключ"); await tick(); assert.equal(nodes(f.render(), "BalancePanel").length, 0);
assert.equal(f.enabled, false);

// The shared selection control is the first card child, like other provider cards.
const cardSource = fs.readFileSync("components/ManusProviderCard.tsx", "utf8");
assert.match(cardSource, /return <View[^\n]*>\s*<Checkbox checked=\{mode === "manus"\}/);
assert.equal((cardSource.match(/<Checkbox checked=\{mode === "manus"\}/g) || []).length, 1);
// Manus uses the shared model-selection checkbox; toggling only selects local/Manus and requires a saved key.
f = cardFixture();
let selection = nodes(f.render(), "Checkbox")[0];
assert.equal(selection.props.checked, false);
assert.equal(selection.props.label, "Использовать этот облачный режим");
assert.equal(selection.props.disabled, false);
selection.props.onPress(); assert.deepEqual(f.modeChanges, ["manus"]);
f.props.mode = "manus"; selection = nodes(f.render(), "Checkbox")[0];
assert.equal(selection.props.checked, true);
selection.props.onPress(); assert.deepEqual(f.modeChanges, ["manus", "local"]);
f.props.settings.manus.hasApiKey = false; selection = nodes(f.render(), "Checkbox")[0];
assert.equal(selection.props.disabled, true);
selection.props.onPress(); assert.deepEqual(f.modeChanges, ["manus", "local"], "missing key cannot switch providers");

// Real panel TSX: seconds are converted to local date/time; no invented renewal.
const Panel = compile("components/ManusCreditsPanel.tsx", {
  react: { useEffect() {}, useState: value => [value, () => {}] }, "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "Fragment" }, "react-native": native,
}).ManusCreditsPanel;
const realNow = Date.now; Date.now = () => 1_800_000_000_000;
try {
  const props = { language: "ru", colors, loading: false, error: "", onRefresh() {}, updatedAt: Date.now(), credits: { total_credits: 0, periodic_credits: 2, pro_monthly_credits: 4000, max_refresh_credits: 300, next_refresh_time: Date.now() / 1000 + 86400, refresh_interval: "daily" } };
  let output = text(Panel(props));
  assert.match(output, /Доступно: 0 кредитов/); assert.match(output, /неположительный/); assert.match(output, /Месячная квота подписки/);
  assert.match(output, /через 1 дн 0 ч 0 мин/); assert.doesNotMatch(output, /1970/);
  const nextYear = new Date(props.credits.next_refresh_time * 1000).getFullYear(); assert.ok(output.includes(String(nextYear)));
  for (const cadence of ["daily", "weekly"]) { props.credits.refresh_interval = cadence; assert.match(text(Panel(props)), /через/); }
  props.error = "Ошибка API"; output = text(Panel(props)); assert.match(output, /Последние данные; не подтверждены/); assert.match(output, /Ошибка API/); assert.doesNotMatch(output, /через/);
  props.error = ""; props.loading = true; output = text(Panel(props)); assert.match(output, /не подтверждены/); assert.equal(nodes(Panel(props), "TouchableOpacity")[0].props.disabled, true);
  props.loading = false; props.credits = { total_credits: -5, next_refresh_time: Date.now() / 1000 - 1, refresh_interval: "daily" }; output = text(Panel(props)); assert.match(output, /Доступно: -5/); assert.match(output, /Дата обновления прошла/); assert.doesNotMatch(output, /через/);
  props.credits = { total_credits: 75, pro_monthly_credits: 4000, next_refresh_time: 0, current_period_end: Date.now() / 1000 + 30 * 86400 }; output = text(Panel(props)); assert.match(output, /не сообщает предстоящее пополнение/); assert.match(output, /не дата начисления/); assert.doesNotMatch(output, /через/);
  props.credits = { total_credits: 25 }; assert.match(text(Panel(props)), /не предоставил расписание/);
  props.credits = { total_credits: 25, next_refresh_time: Date.now() / 1000 + 86400 }; assert.match(text(Panel(props)), /не предоставил подтверждённое расписание/);
  for (const language of ["ru", "uk", "en"]) { props.language = language; assert.ok(nodes(Panel(props), "TouchableOpacity")[0].props.accessibilityLabel); }
} finally { Date.now = realNow; }
console.log("AIB_V485_MANUS_CARD_SELFTEST_OK runtime=mock-TSX selection=shared-checkbox toggle=manus/local missing-key=disabled paid-task=not-started saved+verified=required draft+rotation+blur=hidden time=Unix-seconds quota=not-balance stale=no-promise NO_DEVICE_PROOF");
