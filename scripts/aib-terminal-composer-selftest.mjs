#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const source = fs.readFileSync(path.join(root, "app/terminal.tsx"), "utf8");

assert.match(source, /const projectRoot = typeof project\?\.path === "string" \? project\.path : undefined/, "terminal uses the selected project's stored path, not an ID-derived root");
assert.match(source, /restoreSession\(saved\.id, projectRoot\)/, "legacy saved sessions receive the current project path when restored");
assert.match(source, /restoreSession\(row\.id, projectRoot\)/, "manually selected saved sessions receive the current project path");
assert.match(source, /openProjectSession\(projectId, projectRoot\)/, "new sessions receive the exact stored project path");
assert.match(source, /item\.projectRoot === projectRoot/, "live sessions are reused only for the selected project's exact stored root");
assert.match(source, /const rootMatches = !projectRoot \|\| row\.projectRoot === projectRoot/, "stale attached-session selection checks project-root identity");
assert.match(source, /isAttached && rootMatches \? row : isAttached\s*\?\s*await facade\.terminalUx\.openProjectSession\(projectId, projectRoot\)/, "a still-live legacy session is not killed or reused; the current root gets a new session");
assert.match(source, /editable=\{!busy\}/, "composer stays editable while session creation is pending or unavailable");
assert.doesNotMatch(source, /editable=\{!busy && Boolean\(session\)\}/, "keyboard focus must not depend on an active session");
assert.match(source, /<TouchableOpacity onPress=\{\(\) => void runCommand\(\)\} disabled=\{busy \|\| !command\.trim\(\)\}/, "send button depends on a non-empty command, not an existing session");

const start = source.indexOf("const runCommand = useCallback(async () => {");
const end = source.indexOf("\n  }, [activateSession, busy, command", start);
assert.ok(start >= 0 && end > start, "runCommand callback exists");
const runCommand = source.slice(start, end);
const openAt = runCommand.indexOf("openProjectSession(projectId, projectRoot)");
const activateAt = runCommand.indexOf("activateSession(created)");
const sendAt = runCommand.indexOf("terminalUx.send(id,");
assert.ok(openAt >= 0 && activateAt > openAt && sendAt > activateAt, "first send opens and activates a project session before dispatch");
assert.match(runCommand, /if \(!id\)\s*\{[\s\S]*?openProjectSession\(projectId, projectRoot\)/, "missing active session is recovered on explicit send with its exact project root");
assert.ok(runCommand.indexOf("commitCommandInput(createTerminalCommandInputState())") > openAt, "draft is not cleared before session creation succeeds");
console.log("AIB_TERMINAL_COMPOSER_SELFTEST_OK editable_without_session=true auto_open_on_send=true exact_project_root=true legacy_restore_override=true stale_live_root_not_reused=true");
