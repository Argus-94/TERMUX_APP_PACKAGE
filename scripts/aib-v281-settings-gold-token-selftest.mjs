#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadRuntimeTs } from "./test-helpers/load-runtime-ts.mjs";

// AIB_SOURCE_ROOT lets this regression be replayed against an earlier archive.
const root = path.resolve(process.env.AIB_SOURCE_ROOT || fileURLToPath(new URL("..", import.meta.url)));
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const expected = { GOLD: "#C9A227", GOLD_DEEP: "#8B6914", GOLD_LIGHT: "#E7D28A" };
const tokenNames = Object.keys(expected);
const canonicalPath = path.resolve(root, "theme/colors.ts");
const colorsSource = read("theme/colors.ts");
const colorsModule = loadRuntimeTs(canonicalPath);
const hasIdentifier = (source, identifier) => new RegExp(`\\b${identifier}\\b`).test(source);

// The three public tokens are declared and exported once, from the canonical theme only.
for (const [token, value] of Object.entries(expected)) {
  const declaration = `export const ${token} = "${value}";`;
  assert.equal(colorsSource.split("\n").filter((line) => line.trim() === declaration).length, 1, `${token} has exactly one canonical exported declaration with its v280 value`);
  assert.equal(Object.hasOwn(colorsModule, token), true, `${token} is a runtime export from theme/colors.ts`);
  assert.equal(colorsModule[token], value, `${token} runtime export retains the shared Gold palette value`);
}

const productionRoots = ["app", "components", "core", "lib", "theme"];
function collectProductionFiles(directory) {
  const absolute = path.join(root, directory);
  if (!fs.existsSync(absolute)) return [];
  return fs.readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(absolute, entry.name);
    if (entry.isDirectory()) return collectProductionFiles(path.relative(root, full));
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

// Audit every production token import/alias/re-export edge. Current consumers intentionally
// import canonical uppercase names directly; semantic EXPANDED_GOLD aliases are checked below.
for (const file of productionRoots.flatMap(collectProductionFiles)) {
  const source = fs.readFileSync(file, "utf8");
  if (path.resolve(file) === canonicalPath) continue;
  const relative = path.relative(root, file);
  const importLines = source.split("\n").filter((line) => line.trimStart().startsWith("import ") && line.includes("theme/colors"));
  const imported = new Set();
  for (const line of importLines) {
    for (const token of tokenNames) {
      if (!hasIdentifier(line, token)) continue;
      assert.equal(line.includes(" as "), false, `${relative} must not case-alias canonical token ${token}`);
      imported.add(token);
    }
  }
  const reexports = source.split("\n").filter((line) => line.trimStart().startsWith("export {") && tokenNames.some((token) => hasIdentifier(line, token)));
  assert.equal(reexports.length, 0, `${relative} must not create a competing Gold token re-export`);
  for (const token of tokenNames) {
    if (hasIdentifier(source, token)) {
      assert.equal(imported.has(token), true, `${relative} uses ${token} but does not import it directly from theme/colors.ts`);
    }
  }
}

const highlightSource = read("lib/ui-expanded-highlight.ts");
const canonicalImport = highlightSource.split("\n").find((line) => line.trimStart().startsWith("import {") && line.includes("../theme/colors"));
assert.ok(canonicalImport, "expanded-highlight imports the canonical theme module");
const importedTokens = tokenNames.filter((token) => hasIdentifier(canonicalImport, token));
assert.deepEqual([...importedTokens].sort(), [...tokenNames].sort(), "expanded-highlight binds every canonical token it uses without casing aliases");
assert.equal(canonicalImport.includes(" as "), false, "expanded-highlight uses canonical uppercase token names");
assert.equal(highlightSource.includes("goldLight"), false, "expanded-highlight has no lower-camel GOLD_LIGHT variant");

const helper = loadRuntimeTs(path.resolve(root, "lib/ui-expanded-highlight.ts"));
assert.equal(helper.EXPANDED_GOLD, expected.GOLD, "expanded Gold alias resolves to the canonical token");
assert.equal(helper.EXPANDED_GOLD_DEEP, expected.GOLD_DEEP, "deep expanded Gold alias resolves to the canonical token");

const settingsSource = read("app/settings.tsx");
const settingsGroupStart = settingsSource.indexOf("function SettingsGroup(");
const settingsScreenStart = settingsSource.indexOf("export default function SettingsScreen()");
assert.ok(settingsGroupStart >= 0 && settingsScreenStart > settingsGroupStart, "production SettingsGroup exists before SettingsScreen");
const settingsGroup = settingsSource.slice(settingsGroupStart, settingsScreenStart);
for (const selector of [
  "expandedHeaderStyle(expanded, colors)",
  "expandedIconColors(expanded, colors)",
  "expandedBodyStyle(expanded)",
  "expandedContentPaddingLeft(expanded, 12)",
  "expandedIconChipStyle(expanded, colors, 36)",
  "expandedIconChipInnerStyle(colors, 36)",
  "expandedTitleColor(expanded, colors.inkBright)",
]) assert.ok(settingsGroup.includes(selector), `SettingsGroup runs production selector ${selector}`);
assert.ok(settingsGroup.includes("accessibilityState={{ expanded }}"), "accordion exposes the same expanded state to accessibility");
assert.ok(settingsGroup.includes("{expanded ? ("), "accordion body is conditionally mounted only while expanded");
assert.ok(settingsGroup.includes(") : null}"), "accordion body is omitted while collapsed");

const groupTags = [...settingsSource.matchAll(/<SettingsGroup\b([\s\S]*?)\n\s*>/g)];
const groupCloses = settingsSource.split("</SettingsGroup>").length - 1;
assert.ok(groupTags.length > 0, "Settings contains production accordion instances");
assert.equal(groupTags.length, groupCloses, "every SettingsGroup JSX instance has a matching close tag");
const stateStart = settingsSource.indexOf("const [openSections, setOpenSections]");
const stateEnd = settingsSource.indexOf("});", stateStart);
assert.ok(stateStart >= 0 && stateEnd > stateStart, "Settings accordion state has an explicit initial value");
const initialState = settingsSource.slice(stateStart, stateEnd);
for (const [index, tag] of groupTags.entries()) {
  const props = tag[1];
  const expandedMarker = "expanded={!!openSections.";
  const expandedStart = props.indexOf(expandedMarker);
  assert.ok(expandedStart >= 0, `Settings accordion ${index + 1} derives expanded from openSections`);
  const section = props.slice(expandedStart + expandedMarker.length).split("}")[0];
  const toggleMarker = 'onToggle={() => toggleSection("';
  const toggleStart = props.indexOf(toggleMarker);
  assert.ok(toggleStart >= 0, `Settings accordion ${index + 1} toggles its openSections key`);
  const toggledSection = props.slice(toggleStart + toggleMarker.length).split('"')[0];
  assert.equal(toggledSection, section, `Settings accordion ${index + 1} opens/closes the same section key`);
  assert.ok(initialState.includes(`${section}: false`), `${section} starts collapsed on initial Settings render`);
}
assert.ok(settingsSource.includes("setOpenSections((prev) => ({ ...prev, [key]: !prev[key] }))"), "accordion open/close uses the production state toggle");

const paletteForDarkTheme = {
  inkBright: "#F0F1F3", muted: "#9AA3AC", line: "#3A4148", surface: "#181C20",
  accent: "#9FCBFF", accentDim: "rgba(159, 203, 255, 0.14)",
};
const paletteForLightTheme = {
  inkBright: "#101418", muted: "#5C6770", line: "#D0D5DA", surface: "#FFFFFF",
  accent: "#194A72", accentDim: "rgba(25, 74, 114, 0.10)",
};
function exerciseSettingsGroup(expanded, palette) {
  return {
    header: helper.expandedHeaderStyle(expanded, palette),
    title: helper.expandedTitleColor(expanded, palette.inkBright),
    icons: helper.expandedIconColors(expanded, palette),
    body: helper.expandedBodyStyle(expanded),
    padding: helper.expandedContentPaddingLeft(expanded, 12),
    chip: helper.expandedIconChipStyle(expanded, palette, 36),
    inner: helper.expandedIconChipInnerStyle(palette, 36),
  };
}

// Exercise exactly the selectors called by production SettingsGroup for every accordion's
// initial collapsed render, open and close transitions in both application theme modes.
for (const palette of [paletteForDarkTheme, paletteForLightTheme]) {
  for (const tag of groupTags) {
    const props = tag[1];
    const expandedMarker = "expanded={!!openSections.";
    const expandedStart = props.indexOf(expandedMarker);
    const section = props.slice(expandedStart + expandedMarker.length).split("}")[0];
    let expanded = false;
    let output;
    assert.doesNotThrow(() => { output = exerciseSettingsGroup(expanded, palette); }, `${section}: closed initial render`);
    assert.equal(output.title, palette.inkBright, `${section}: closed title stays theme foreground`);
    for (const nextExpanded of [true, false]) {
      expanded = nextExpanded;
      assert.doesNotThrow(() => { output = exerciseSettingsGroup(expanded, palette); }, `${section}: ${expanded ? "open" : "close"} transition`);
      if (expanded) {
        assert.equal(output.title, palette === paletteForDarkTheme ? expected.GOLD_LIGHT : expected.GOLD_DEEP, `${section}: expanded title selects the correct shared Gold token`);
        assert.equal(output.header.borderColor, expected.GOLD, `${section}: expanded header uses canonical Gold`);
        assert.equal(output.header.borderLeftColor, expected.GOLD_DEEP, `${section}: expanded accent bar uses canonical deep Gold`);
        assert.notEqual(output.body, null, `${section}: expanded body is rendered`);
      } else {
        assert.equal(output.title, palette.inkBright, `${section}: closed title returns to the theme foreground`);
        assert.equal(output.body, null, `${section}: closed body is not rendered`);
      }
    }
  }
}

console.log(`OK: canonical GOLD/GOLD_DEEP/GOLD_LIGHT declarations/imports/aliases, ${groupTags.length} production Settings accordions, and both-theme initial/open/close selector paths`);
