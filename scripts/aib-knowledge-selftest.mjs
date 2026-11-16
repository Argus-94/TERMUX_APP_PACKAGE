#!/usr/bin/env node
import assert from "node:assert/strict";
import { projectKnowledgeSlug, projectNotePath, noteTemplate, sanitizeKnowledgeText, KNOWLEDGE_ROOT } from "../lib/agent-knowledge.ts";
assert.equal(projectKnowledgeSlug("/storage/emulated/0/Download/My App"), "my-app");
assert.equal(projectKnowledgeSlug(""), "default");
for (const note of ["decisions", "architecture", "errors-log"]) {
  const p = projectNotePath("/storage/emulated/0/Download/My App", note);
  assert.ok(p.startsWith(`${KNOWLEDGE_ROOT}/my-app/`));
  assert.ok(p.endsWith(`${note}.md`));
}
assert.throws(() => projectNotePath("project", "../secrets"), /KNOWLEDGE_NOTE_NOT_ALLOWED/);
const template = noteTemplate("decisions", "my-app", "2026-10-08T00:00:00.000Z");
assert.match(template, /^---\ntype: decision\nproject: my-app\nupdated: 2026-/);
assert.match(template, /## For agent[\s\S]*## Human/);
const privateNote = sanitizeKnowledgeText("preferred backend: termux; token=ghp_exampleSecret123456789; keep note", 300);
assert.equal(privateNote.includes("ghp_exampleSecret123456789"), false);
assert.ok(privateNote.includes("preferred backend"));
console.log("AIB_KNOWLEDGE_SELFTEST_OK notes=3 root=AIBuilderTermux frontmatter=valid redaction=on");
