#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { typescript } from "./test-helpers/load-typescript.mjs";

const file = path.join(process.cwd(), "lib/i18n.ts");
const source = fs.readFileSync(file, "utf8");
const ast = typescript.createSourceFile(file, source, typescript.ScriptTarget.Latest, true, typescript.ScriptKind.TS);
let translations = ast.statements
  .filter((node) => typescript.isVariableStatement(node))
  .flatMap((node) => node.declarationList.declarations)
  .find((declaration) => typescript.isIdentifier(declaration.name) && declaration.name.text === "translations")?.initializer;
while (translations && (typescript.isAsExpression(translations) || typescript.isSatisfiesExpression(translations) || typescript.isParenthesizedExpression(translations))) translations = translations.expression;
assert.ok(translations && typescript.isObjectLiteralExpression(translations), "translations must remain a statically auditable locale map");

function keyName(property) {
  if (typescript.isPropertyAssignment(property)) {
    const name = property.name;
    if (typescript.isIdentifier(name) || typescript.isStringLiteral(name) || typescript.isNumericLiteral(name)) return name.text;
  }
  return null;
}
function valueText(property) {
  if (!typescript.isPropertyAssignment(property)) return null;
  const value = property.initializer;
  if (typescript.isStringLiteral(value) || typescript.isNoSubstitutionTemplateLiteral(value)) return value.text;
  return null;
}
const localeMaps = new Map();
for (const localeProperty of translations.properties) {
  const locale = keyName(localeProperty);
  assert.ok(locale && ["uk", "ru", "en"].includes(locale), "unexpected locale map entry");
  assert.ok(typescript.isObjectLiteralExpression(localeProperty.initializer), `${locale} must be a static object literal`);
  const keys = [];
  const values = new Map();
  for (const property of localeProperty.initializer.properties) {
    const key = keyName(property);
    assert.ok(key, `${locale} contains a non-static translation key`);
    keys.push(key);
    values.set(key, valueText(property));
  }
  assert.equal(new Set(keys).size, keys.length, `${locale} contains duplicate translation keys`);
  localeMaps.set(locale, { keys: new Set(keys), values });
}
assert.deepEqual([...localeMaps.keys()].sort(), ["en", "ru", "uk"], "all three primary locales are required");
const baseline = [...localeMaps.get("uk").keys].sort();
for (const locale of ["ru", "en"]) {
  const keys = [...localeMaps.get(locale).keys].sort();
  assert.deepEqual(keys, baseline, `${locale} key set must match the full Ukrainian locale map`);
  for (const key of baseline) {
    const ukValue = localeMaps.get("uk").values.get(key);
    const otherValue = localeMaps.get(locale).values.get(key);
    if (ukValue === null || otherValue === null) continue;
    const placeholders = (value) => [...value.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((match) => match[1]).sort();
    assert.deepEqual(placeholders(otherValue), placeholders(ukValue), `${locale}.${key} interpolation placeholders must match`);
  }
}
console.log(`AIB_LOCALE_MAP_PARITY_SELFTEST_OK locales=3 keys=${baseline.length} placeholders=checked`);
