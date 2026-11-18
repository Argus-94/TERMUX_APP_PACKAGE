#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const androidRoot = path.join(root, "android");
const androidExistedBefore = fs.existsSync(androidRoot);

function parseKotlinStringLiteral(line) {
  const openingQuote = line.indexOf('"');
  assert.notEqual(openingQuote, -1, `generated Kotlin line must contain a string literal: ${line}`);
  let value = "";
  for (let index = openingQuote + 1; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      return { value, suffix: line.slice(index + 1).trim() };
    }
    if (character !== "\\") {
      value += character;
      continue;
    }

    const escaped = line[index + 1];
    assert.notEqual(escaped, undefined, "generated Kotlin string must not end with a backslash");
    index += 1;
    const escapeValues = {
      t: "\t",
      b: "\b",
      n: "\n",
      r: "\r",
      "'": "'",
      '"': '"',
      "\\": "\\",
      "$": "$",
    };
    if (Object.hasOwn(escapeValues, escaped)) {
      value += escapeValues[escaped];
    } else if (escaped === "u") {
      const digits = line.slice(index + 1, index + 5);
      assert.match(digits, /^[0-9A-Fa-f]{4}$/, "Kotlin unicode escape must contain four hexadecimal digits");
      value += String.fromCharCode(Number.parseInt(digits, 16));
      index += 4;
    } else {
      throw new Error(`invalid Kotlin string escape \\${escaped}`);
    }
  }
  throw new Error(`unterminated Kotlin string literal: ${line}`);
}

try {
  const prebuild = spawnSync(
    "pnpm",
    ["exec", "expo", "prebuild", "--platform", "android", "--clean", "--no-install"],
    {
      cwd: root,
      env: { ...process.env, CI: "1" },
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    }
  );
  if (prebuild.error || prebuild.status !== 0) {
    if (prebuild.stdout) process.stderr.write(prebuild.stdout);
    if (prebuild.stderr) process.stderr.write(prebuild.stderr);
    throw prebuild.error || new Error(`clean Expo prebuild failed with exit code ${prebuild.status}`);
  }

  const kotlinPath = path.join(androidRoot, "app/src/main/java/com/karat/aibuilder/TermuxBridgeModule.kt");
  assert.ok(fs.existsSync(kotlinPath), `clean Expo prebuild did not generate ${kotlinPath}`);
  const kotlin = fs.readFileSync(kotlinPath, "utf8");
  const lines = kotlin.split(/\r?\n/);
  const start = lines.findIndex((line) => /\bval awkScript\s*=/.test(line));
  assert.notEqual(start, -1, "generated TermuxBridgeModule.kt must contain the APT-plan awkScript expression");

  const fragments = [];
  let lineIndex = start;
  while (lineIndex < lines.length) {
    const parsed = parseKotlinStringLiteral(lines[lineIndex]);
    fragments.push(parsed.value);
    const moreFragmentsFollow = parsed.suffix === "+";
    assert.ok(moreFragmentsFollow || parsed.suffix === "", `unexpected Kotlin expression after string literal: ${lines[lineIndex]}`);
    lineIndex += 1;
    if (!moreFragmentsFollow) break;
  }
  assert.equal(fragments.length, 3, "AWK expression must be three valid adjacent Kotlin string literals");

  const awkScript = fragments.join("");
  assert.ok(awkScript.includes('tail=$0; sub(/^Inst /, "", tail)'), "AWK package name must preserve the empty-string argument");
  assert.ok(awkScript.includes('open=index($0, "(")'), "AWK version parsing must preserve its quoted parenthesis");
  assert.ok(awkScript.includes('sub(/\\)$/, "", version)'), "AWK closing-parenthesis regex must survive Kotlin decoding");
  assert.ok(awkScript.includes('print name "@" version; count++'), "AWK output delimiter must survive Kotlin decoding");
  assert.ok(awkScript.endsWith("\nEND { if (bad || count < 1) exit 1 }"), "AWK fail-closed footer must remain intact");

  console.log("AIB_V512_TERMUX_AWKSCRIPT_KOTLIN_PREBUILD_SELFTEST_OK clean_prebuild=1 kotlin_string_literals=3 lexical_parse=valid gradle_launched=false");
} finally {
  if (!androidExistedBefore) fs.rmSync(androidRoot, { recursive: true, force: true });
}
