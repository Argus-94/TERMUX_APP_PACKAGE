#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import { redactPersistentLogPayload } from "../lib/log-redaction.ts";

const useLlm = fs.readFileSync("hooks/useLLM.ts", "utf8");
const agent = fs.readFileSync("lib/termux-agent.ts", "utf8");
const logger = fs.readFileSync("lib/persistent-logger.ts", "utf8");
const orchestrator = fs.readFileSync("lib/agent-orchestrator.ts", "utf8");
assert.match(useLlm, /Отправка запроса mode=\$\{mode\}[\s\S]*?chars=\$\{message\.length\}/);
assert.doesNotMatch(useLlm, /Отправка \([^\n]*\) chars=\$\{message\.length\}:\\n\$\{message\}/, "raw chat body must not enter persistent logger call");
assert.match(agent, /Ответ модели: chars=\$\{reply\.length\}/);
assert.doesNotMatch(agent, /Ответ модели \(\$\{reply\.length\} симв\.\):\\n\$\{reply\}/, "raw model reply must not enter persistent logger call");
const privateChat = ["private", "chat", "body", "fixture-8301"].join("_");
const privateTask = ["private", "agent", "task", "fixture-8302"].join("_");
const privateAdvisorReply = ["private", "advisor", "response", "fixture-8303"].join("_");
assert.equal(redactPersistentLogPayload("Chat", `legacy request: ${privateChat}`).includes(privateChat), false);
assert.equal(redactPersistentLogPayload("Termux", `Новая задача: ${privateTask}`).includes(privateTask), false);
assert.equal(redactPersistentLogPayload("Advisor", privateAdvisorReply).includes(privateAdvisorReply), false);
assert.match(redactPersistentLogPayload("Chat", "Отправка запроса mode=online chars=42"), /chars=42$/);
assert.match(logger, /redactPersistentLogPayload\(tag, e\.message\)/, "legacy persisted messages are sanitized on hydration");
assert.match(logger, /redactPersistentLogPayload\(safeTag, \(message \?\? ""\) \+ metaSuffix\)/, "new persistent entries and structured meta are sanitized before storage");
assert.match(orchestrator, /MODEL_RESPONSE_OMITTED chars=\$\{a\.length\}/, "advisor response body must not be logged");
console.log("AIB_CHAT_LOG_PRIVACY_SELFTEST_OK legacy_and_new_content=omitted diagnostics=metadata_only");
