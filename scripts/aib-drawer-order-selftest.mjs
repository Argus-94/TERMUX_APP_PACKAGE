#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const read = (name) => fs.readFileSync(path.join(root, name), "utf8");

const drawer = read("components/DrawerContent.tsx");
const layout = read("app/_layout.tsx");
const locales = read("lib/i18n.ts");
const githubRoute = read("app/github.tsx");
const logRoute = read("app/log-screen.tsx");

const menuMatch = drawer.match(/const menuItems = \[([\s\S]*?)\n  \];/);
assert.ok(menuMatch, "custom drawer menuItems declaration must remain present");
const menuNames = [...menuMatch[1].matchAll(/\bname:\s*"([^"]+)"/g)].map((match) => match[1]);
assert.equal(menuNames.filter((name) => name === "github").length, 1, "GitHub remains a single drawer item");
assert.equal(menuNames.filter((name) => name === "log-screen").length, 1, "Log remains a single drawer item");
assert.deepEqual(menuNames.slice(-3), ["terminal", "github", "log-screen"], "Console is visible immediately before GitHub; Log remains last");
assert.match(menuMatch[1], /name:\s*"terminal",\s*label:\s*language === "ru" \? "Консоль"/);
assert.match(menuMatch[1], /name:\s*"github",\s*label:\s*"GitHub",\s*icon:\s*"logo-github"/);
assert.match(menuMatch[1], /name:\s*"log-screen",\s*label:\s*t\("log"\)/);
assert.match(drawer, /props\.navigation\.navigate\(item\.name\)/, "drawer actions still navigate using the route names");

assert.match(layout, /<Drawer\.Screen\s+name="terminal"\s+options=\{\{\s*title:\s*"Console",\s*drawerLabel:\s*"Console"\s*\}\}/, "Console route is visible in the drawer");
assert.match(layout, /<Drawer\.Screen\s+name="github"\s+options=\{\{\s*title:\s*"GitHub",\s*drawerLabel:\s*"GitHub"/);
assert.match(layout, /<Drawer\.Screen\s+name="log-screen"\s+options=\{\{\s*title:\s*t\("log"\),\s*drawerLabel:\s*t\("log"\)/);
assert.match(githubRoute, /export default function GithubScreen\(/, "GitHub route screen remains wired");
assert.match(logRoute, /export default function LogScreen\(/, "Log route screen remains wired");

const languageNames = ["uk", "ru", "en"];
for (const language of languageNames) {
  const start = locales.indexOf(`\n  ${language}: {`);
  assert.notEqual(start, -1, `locale block ${language} remains present`);
  const nextStarts = languageNames
    .map((candidate) => locales.indexOf(`\n  ${candidate}: {`, start + 1))
    .filter((index) => index > start);
  const end = nextStarts.length ? Math.min(...nextStarts) : locales.length;
  const block = locales.slice(start, end);
  assert.match(block, /^\s*log:\s*"[^"\n]+"/m, `Log label remains translated for ${language}`);
}

console.log("AIB_DRAWER_ORDER_SELFTEST_OK order=terminal,github,log-screen routes=github,log-screen locales=uk,ru,en");
