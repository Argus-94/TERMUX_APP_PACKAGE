#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const script = path.join(root, "scripts/aib-hashline.mjs");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "aib-hashline-fidelity-"));
const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
try {
  const crlfFile = path.join(temp, "crlf.txt");
  fs.writeFileSync(crlfFile, Buffer.from("alpha\r\nbravo\r\n", "utf8"));
  const read = run("read", crlfFile);
  assert.equal(read.status, 0);
  const row = read.stdout.split(/\r?\n/).find((line) => line.startsWith("2|"));
  const hash = row?.split("|")[1];
  assert.ok(hash);
  const replace = run("replace", crlfFile, "2", hash, "charlie");
  assert.equal(replace.status, 0, replace.stderr);
  assert.deepEqual(fs.readFileSync(crlfFile), Buffer.from("alpha\r\ncharlie\r\n", "utf8"), "untouched CRLF bytes and trailing newline remain unchanged");

  const invalidFile = path.join(temp, "invalid-utf8.txt");
  const invalidBytes = Buffer.from([0xff, 0x0d, 0x0a, 0x62, 0x72, 0x61, 0x76, 0x6f]);
  fs.writeFileSync(invalidFile, invalidBytes);
  const invalidRead = run("read", invalidFile);
  const invalidRow = invalidRead.stdout.split(/\r?\n/).find((line) => line.startsWith("2|"));
  const invalidHash = invalidRow?.split("|")[1];
  assert.ok(invalidHash);
  const rejected = run("replace", invalidFile, "2", invalidHash, "safe");
  assert.equal(rejected.status, 5);
  assert.match(rejected.stderr, /HASHLINE_INVALID_UTF8/);
  assert.deepEqual(fs.readFileSync(invalidFile), invalidBytes, "malformed bytes remain byte-for-byte intact after rejected edit");

  const mixedFile = path.join(temp, "mixed-eol.txt");
  fs.writeFileSync(mixedFile, Buffer.from("alpha\r\nbravo\n", "utf8"));
  const mixedRead = run("read", mixedFile);
  const mixedRow = mixedRead.stdout.split(/\r?\n/).find((line) => line.startsWith("2|"));
  const mixedHash = mixedRow?.split("|")[1];
  const mixedEdit = run("replace", mixedFile, "2", mixedHash, "charlie");
  assert.equal(mixedEdit.status, 5);
  assert.match(mixedEdit.stderr, /HASHLINE_MIXED_LINE_ENDINGS/);
  assert.deepEqual(fs.readFileSync(mixedFile), Buffer.from("alpha\r\nbravo\n", "utf8"));
  console.log("AIB_HASHLINE_FIDELITY_SELFTEST_OK eol=preserved invalid_utf8=rejected mixed_eol=rejected");
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
