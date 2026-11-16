#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "aib-github-kotlin-escape-prebuild-"));
const project = path.join(temp, "project");
const excludedRoots = new Set([".git", ".expo", "node_modules", "android", "dist", "coverage", "web-build"]);

try {
  fs.cpSync(root, project, {
    recursive: true,
    filter(source) {
      const relative = path.relative(root, source);
      if (!relative || relative === ".") return true;
      return !excludedRoots.has(relative.split(path.sep)[0]);
    },
  });
  const modules = path.join(root, "node_modules");
  assert.ok(fs.existsSync(modules), "install dependencies before running clean-prebuild regression");
  fs.symlinkSync(modules, path.join(project, "node_modules"), "dir");

  const prebuild = spawnSync("pnpm", ["exec", "expo", "prebuild", "--platform", "android", "--clean", "--no-install"], {
    cwd: project,
    encoding: "utf8",
    timeout: 180_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (prebuild.error) throw prebuild.error;
  assert.equal(prebuild.status, 0,
    `clean Expo prebuild must succeed (this is not a Gradle/Kotlin compile)\n${prebuild.stdout}\n${prebuild.stderr}`);

  const generatedPath = path.join(project, "android/app/src/main/java/com/karat/aibuilder/GithubToolNative.kt");
  assert.ok(fs.existsSync(generatedPath), "prebuild must generate GithubToolNative.kt in the canonical application package");
  const generated = fs.readFileSync(generatedPath, "utf8");
  const expected = String.raw`return Regex("^/android_asset/github-tool/[A-Za-z0-9_.-]+\\.html$").matches(p)`;
  const lines = generated.split(/\r?\n/);
  const matchingLines = lines.filter((line) => line.trim() === expected);
  assert.equal(matchingLines.length, 1,
    `generated Kotlin must contain exactly one literal-dot regex with the Kotlin source escape \\\\.html; found ${matchingLines.length}`);
  const sourceLine = matchingLines[0].trim();
  assert.equal((sourceLine.match(/\\/g) || []).length, 2,
    "the generated Kotlin string must contain exactly two source backslashes before .html");

  let kotlinCompile = "SKIP(kotlinc unavailable)";
  const compiler = spawnSync("kotlinc", ["-version"], { encoding: "utf8", timeout: 10_000 });
  if (!compiler.error && compiler.status === 0) {
    const snippet = path.join(temp, "GithubRegexEscape.kt");
    fs.writeFileSync(snippet, `${sourceLine.replace(/^return /, "fun generatedRegexCheck(p: String): Boolean = ")}\n`, "utf8");
    const compile = spawnSync("kotlinc", [snippet, "-d", path.join(temp, "github-regex-check.jar")], {
      cwd: project,
      encoding: "utf8",
      timeout: 60_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    assert.equal(compile.status, 0, `standalone Kotlin regex snippet must compile\n${compile.stdout}\n${compile.stderr}`);
    kotlinCompile = "PASS(standalone-snippet)";
  }

  const lineNumber = lines.indexOf(matchingLines[0]) + 1;
  console.log(`AIB_GITHUB_KOTLIN_ESCAPE_PREBUILD_OK generated=${path.relative(project, generatedPath)}:${lineNumber} escape=\\\\.html kotlin=${kotlinCompile} gradle_compile=NOT_RUN`);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
