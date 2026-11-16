#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { typescript } from "./test-helpers/load-typescript.mjs";

const root = process.cwd();
const source = fs.readFileSync(path.join(root, "lib/github-url-policy.ts"), "utf8");
const compiled = typescript.transpile(source, {
  module: typescript.ModuleKind.CommonJS,
  target: typescript.ScriptTarget.ES2022,
});
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "aib-github-url-policy-"));
const modulePath = path.join(temp, "policy.cjs");
fs.writeFileSync(modulePath, compiled);
try {
  const { normalizeGithubApiPath, normalizeGithubFetchUrl } = createRequire(import.meta.url)(modulePath);
  assert.equal(
    normalizeGithubFetchUrl("https://raw.githubusercontent.com/owner/repo/main/README.md"),
    "https://raw.githubusercontent.com/owner/repo/main/README.md",
  );
  assert.equal(normalizeGithubFetchUrl("https://github.com/owner/repo"), "https://github.com/owner/repo");
  for (const value of [
    "http://github.com/owner/repo",
    "https://github.com.evil.example/owner/repo",
    "https://evil.github.com/owner/repo",
    "https://github.com@evil.example/owner/repo",
    "https://user:pass@github.com/owner/repo",
    "https://github.com:8443/owner/repo",
    "https://raw.githubusercontent.com/owner/repo/main/file#fragment",
    "not-a-url",
  ]) {
    assert.throws(() => normalizeGithubFetchUrl(value), undefined, `fetch URL must reject ${value}`);
  }

  assert.equal(
    normalizeGithubApiPath("repos/Argus-94/TERMUX_APP_PACKAGE/contents/apt?ref=main"),
    "/repos/Argus-94/TERMUX_APP_PACKAGE/contents/apt?ref=main",
  );
  assert.equal(normalizeGithubApiPath("search/issues?q=termux%20apt"), "/search/issues?q=termux%20apt");
  assert.equal(normalizeGithubApiPath("/orgs/example/repos?per_page=10"), "/orgs/example/repos?per_page=10");
  for (const value of [
    "https://evil.example/repos/o/r",
    "//evil.example/repos/o/r",
    "/admin/users",
    "repos/../users",
    "repos/%2e%2e/users",
    "repos/a%2fb/issues",
    "repos/a\\b/issues",
    "repos/a#fragment",
    "repos/%zz/issues",
  ]) {
    assert.throws(() => normalizeGithubApiPath(value), undefined, `API path must reject ${value}`);
  }
  console.log("AIB_GITHUB_URL_POLICY_SELFTEST_OK exact-fetch-hosts=1 api-origin-and-path=1 traversal-and-userinfo=blocked");
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
