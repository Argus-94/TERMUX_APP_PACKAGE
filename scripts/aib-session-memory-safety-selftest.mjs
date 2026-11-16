#!/usr/bin/env node
import assert from "node:assert/strict";
import { sanitizeMemoryText, sanitizeProjectMemoryMap } from "../lib/session-memory-safety.ts";

const syntheticCredential = "glpat-" + "z".repeat(24);
assert.equal(sanitizeMemoryText(`provider=${syntheticCredential}`, 100).includes(syntheticCredential), false);
const safe = sanitizeProjectMemoryMap({
  "/project/demo": {
    digest: `token=${syntheticCredential}`,
    updatedAt: 7,
    items: [
      { id: "valid", kind: "fact", text: `Bearer ${syntheticCredential}`, updatedAt: 6 },
      { id: "bad-kind", kind: "unknown", text: "discard", updatedAt: 5 },
      { id: "bad-time", kind: "lesson", text: "discard", updatedAt: "later" },
      null,
    ],
  },
  "/project/corrupt": { digest: "ok", updatedAt: 3, items: "not-an-array" },
  constructor: { digest: "ignored", updatedAt: 2, items: [] },
});
assert.equal(safe["/project/demo"].items?.length, 1);
assert.equal(safe["/project/demo"].items?.[0].text.includes(syntheticCredential), false);
assert.equal(JSON.stringify(safe).includes(syntheticCredential), false);
assert.match(safe["/project/demo"].digest, /REDACTED/);
assert.deepEqual(safe["/project/corrupt"].items, [], "valid JSON with malformed nested items becomes a safe empty list");
assert.equal(Object.hasOwn(safe, "constructor"), false, "prototype-sensitive keys are discarded");
console.log("AIB_SESSION_MEMORY_SAFETY_SELFTEST_OK schema=validated credentials=redacted");
