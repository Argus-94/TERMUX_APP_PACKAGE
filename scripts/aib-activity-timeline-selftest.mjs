#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { typescript } from "./test-helpers/load-typescript.mjs";

const root = process.cwd();
const require = createRequire(import.meta.url);
const out = fs.mkdtempSync(path.join(os.tmpdir(), "aib-timeline-"));
try {
  for (const rel of ["core/enhancements/timeline/EventStore.ts", "core/enhancements/timeline/ActivityTimeline.ts"]) {
    const dest = path.join(out, rel.replace(/\.ts$/, ".js"));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, typescript.transpile(fs.readFileSync(path.join(root, rel), "utf8"), { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2022 }));
  }
  const { EventStore, EventStoreError } = require(path.join(out, "core/enhancements/timeline/EventStore.js"));
  const { ActivityTimeline } = require(path.join(out, "core/enhancements/timeline/ActivityTimeline.js"));
  assert.throws(() => new EventStore(undefined, 0), (error) => error instanceof EventStoreError && error.code === "EVENT_INVALID");

  let raw = null;
  let now = 100;
  let fail = false;
  const storage = { read: async () => raw, write: async (value) => { if (fail) throw new Error("write failed"); raw = value; } };
  const store = new EventStore(storage, 2, () => now++);
  const timeline = new ActivityTimeline(store);
  const first = await timeline.append({ type: "task.start", actor: "agent", projectId: "p1", taskId: "t1", payload: { model: "m1", OPENROUTER_API_KEY: "sk-super-secret-test-value", nested: { authorization: "Bearer private-value" } } });
  assert.equal(first.payload.OPENROUTER_API_KEY, "[REDACTED]");
  assert.equal(first.payload.nested.authorization, "[REDACTED]");
  assert.equal(raw.includes("sk-super-secret-test-value"), false);
  assert.equal(raw.includes("private-value"), false);

  const freeText = await timeline.append({ type: "agent.error", actor: "agent", payload: { message: "Request failed; credential value ordinary-secret-123" } });
  assert.equal(freeText.payload.message, "[REDACTED_TEXT]");
  assert.equal(raw.includes("ordinary-secret-123"), false, "unlabeled free-form text is never persisted");
  await timeline.append({ type: "checkpoint.created", actor: "runtime", projectId: "p1", taskId: "t1", payload: { sha: "abc" } });
  await timeline.append({ type: "task.finish", actor: "agent", projectId: "p2", taskId: "t2" });
  assert.equal((await timeline.getTimeline("p1")).length, 2);
  assert.equal((await timeline.list("p1", first.ts, 1)).length, 1);
  assert.equal(timeline.recent(1)[0].type, "task.finish");
  assert.equal(store.recent(2).length, 2);
  assert.equal(raw.split("\n").filter(Boolean).length, 4);

  raw += `${JSON.stringify({ id: "legacy-event-1", ts: 1, type: "agent.error", actor: "agent", payload: { message: "legacy-unlabeled-secret-456" }, level: "error" })}\n`;
  const legacy = (await timeline.list()).find((event) => event.id === "legacy-event-1");
  assert.equal(legacy.payload.message, "[REDACTED_TEXT]");
  assert.equal(raw.includes("legacy-unlabeled-secret-456"), false, "legacy persisted prose is scrubbed and rewritten before it is returned");
  assert.equal(raw.split("\n").filter(Boolean).length, 5);

  raw += `${JSON.stringify({ id: "legacy-unknown-type", ts: 2, type: "secret.payload", actor: "system", payload: { status: "legacy-secret-value-789" } })}\n`;
  assert.equal((await timeline.list()).some((event) => event.id === "legacy-unknown-type"), false, "legacy event types outside the closed runtime set are discarded");
  assert.equal(raw.includes("legacy-secret-value-789"), false);
  assert.equal(raw.split("\n").filter(Boolean).length, 5);

  const opaque = "qJ4ZpLmN8VxR2cTa6wYh3bMk5dF9sG1p";
  const category = await timeline.append({ type: "backend.policy", actor: "runtime", payload: { status: opaque } });
  assert.equal(category.payload.status, "[REDACTED_TEXT]", "credential-like opaque values in categorical fields are not persisted");
  assert.equal(raw.includes(opaque), false);
  const defaults = await timeline.append({ type: "bootstrap.smart-defaults", actor: "runtime", payload: { backend: "termux-native", mode: "Balanced", preset: "minimal", performanceModeApplied: true } });
  assert.equal(defaults.payload.backend, "termux-native");
  assert.equal(defaults.payload.mode, "Balanced");
  assert.equal(defaults.payload.preset, "minimal");
  await assert.rejects(() => store.append({ type: "credentials.leak", actor: "agent" }), (error) => error.code === "EVENT_INVALID");

  const capStorage = { value: null, async read() { return this.value; }, async write(value) { this.value = value; } };
  const bounded = new EventStore(capStorage, 4, () => now++, 2, 20_000);
  for (let index = 0; index < 5; index++) await bounded.append({ type: "task.start", actor: "system", payload: { status: "ok", message: `detail-${index}` } });
  assert.equal(capStorage.value.split("\n").filter(Boolean).length, 2, "durable event retention has a hard event-count bound");
  assert.equal((await bounded.list()).length, 2);
  assert.doesNotMatch(capStorage.value, /detail-[0-4]/, "free-form details are not retained");

  fail = true;
  await assert.rejects(() => timeline.append({ type: "agent.error", actor: "agent" }), (error) => error.code === "EVENT_STORAGE_FAILED");
  fail = false;
  assert.equal((await timeline.list()).length, 7);
  console.log("AIB_ACTIVITY_TIMELINE_SELFTEST_OK runtime_types=closed opaque_credentials=redacted free_text=redacted legacy_rows=scrubbed durable_retention=bounded");
} finally {
  fs.rmSync(out, { recursive: true, force: true });
}
