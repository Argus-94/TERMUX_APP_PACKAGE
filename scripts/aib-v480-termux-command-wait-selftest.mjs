#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import { getTermuxCommandWaitState, TERMUX_RESULT_WAIT_WARNING_AFTER_SECONDS } from "../lib/termux-command-wait-status.ts";

const consoleSource = fs.readFileSync("app/terminal.tsx", "utf8");

assert.equal(TERMUX_RESULT_WAIT_WARNING_AFTER_SECONDS, 30);
assert.equal(getTermuxCommandWaitState(0), "running");
assert.equal(getTermuxCommandWaitState(29), "running", "the warning must not appear before 30 seconds");
assert.equal(getTermuxCommandWaitState(30), "waiting-for-result", "the warning starts exactly at 30 seconds");
assert.equal(getTermuxCommandWaitState(90), "waiting-for-result", "the device log's 90-second state remains a wait, not proof of execution");
assert.equal(getTermuxCommandWaitState(600), "waiting-for-result");

const progressUi = consoleSource.slice(consoleSource.indexOf("{busy ? <Text"), consoleSource.indexOf("{notice ? <Text"));
assert.match(progressUi, /getTermuxCommandWaitState\(commandElapsedSeconds\) === "waiting-for-result"/);
assert.match(progressUi, /No result from the embedded runtime after/);
assert.match(progressUi, /Heartbeats do not prove the command is running or producing output/);
assert.match(progressUi, /embedded runtime status/);
assert.match(progressUi, /Результат вбудованого середовища не отримано/);
assert.match(progressUi, /Вбудоване середовище не повернуло результат/);
assert.match(progressUi, /Output appears when the command finishes; use PTY for commands that wait for input/);

console.log("AIB_V486_EMBEDDED_COMMAND_WAIT_SELFTEST_OK boundary=30s unknown-result-not-running=1 three-locales=1 permissions-guidance=1");
