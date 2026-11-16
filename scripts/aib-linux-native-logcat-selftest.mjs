import fs from "node:fs";
import path from "node:path";
const root = process.cwd();
const plugin = fs.readFileSync(path.join(root, "plugins/withTermuxBridge.js"), "utf8");
function ok(value, message) { if (!value) throw new Error(message); }

const loggerMatch = plugin.match(/private fun nativeLog\([\s\S]*?\n    \}/);
ok(loggerMatch, "NATIVE_STRUCTURED_LOGGER_MISSING");
const logger = loggerMatch[0];
ok(plugin.includes('private fun nativeLogTag(): String = "AIB-TermuxBridge"'), "NATIVE_LOG_TAG_MUST_BE_STATIC");
ok(logger.includes("phase=\\$safePhase"), "NATIVE_PHASE_MARKER_MISSING");
ok(logger.includes("code=\\$safeCode"), "NATIVE_CODE_MARKER_MISSING");
ok(logger.includes("durationMs=\\$elapsedMs"), "NATIVE_DURATION_MARKER_MISSING");
ok(logger.includes("stdoutBytes=\\$stdoutBytes") && logger.includes("stderrBytes=\\$stderrBytes"), "NATIVE_BYTE_COUNT_MARKERS_MISSING");
ok(logger.includes('it in setOf("LIFECYCLE_EMIT", "OUTPUT_EMIT", "TERMUX_CALLBACK_ERROR", "TERMUX_TIMEOUT", "TERMUX_RUN_COMMAND_FAILED")'), "NATIVE_CODE_ALLOWLIST_MISSING");
ok(!/message:\s*String|substring\(|\bcommand\b|\bchunk\b|e\.message|toString\(\)/i.test(logger), "NATIVE_LOGGER_ACCEPTS_RAW_CONTENT");

const logSinks = plugin.split("\n").filter((line) => line.includes("android.util.Log."));
ok(logSinks.length === 4 && logSinks.every((line) => /android\.util\.Log\.[idwe]\(tag, text\)/.test(line)), "NATIVE_LOG_SINKS_MUST_WRITE_STRUCTURED_TEXT_ONLY");
const emitOutput = plugin.match(/private fun emitOutput\([\s\S]*?\n    \}/)?.[0] || "";
ok(emitOutput.includes('params.putString("chunk", chunk)'), "JS_LIVE_OUTPUT_FORWARDING_MISSING");
ok(!/nativeLog\([\s\S]*?chunk/.test(emitOutput), "RAW_OUTPUT_CHUNK_STILL_REACHES_LOGCAT");
ok(!plugin.includes("commandBackendLabels") && !plugin.includes("command="), "USER_COMMAND_OR_BACKEND_LABEL_REMAINS_IN_LOGCAT");
ok(plugin.includes('nativeLog(id, "info", "dispatch", timeoutMs = timeoutMs.toLong())'), "SAFE_DISPATCH_MARKER_MISSING");
ok(plugin.includes('code = if (callbackError) "TERMUX_CALLBACK_ERROR"'), "SAFE_RESULT_ERROR_CODE_MISSING");
ok(plugin.includes('stdoutBytes = result.stdout.toByteArray(Charsets.UTF_8).size.toLong()'), "STDOUT_UTF8_BYTE_COUNT_MISSING");
ok(plugin.includes('stderrBytes = finalStderr.toByteArray(Charsets.UTF_8).size.toLong()'), "STDERR_UTF8_BYTE_COUNT_MISSING");
ok(plugin.includes('nativeLog(id, "error", "exception", code = "TERMUX_RUN_COMMAND_FAILED")'), "SAFE_EXCEPTION_CODE_MISSING");
ok(!plugin.includes('nativeLog(id, "error", "exception \\${e.message'), "RAW_EXCEPTION_TEXT_STILL_REACHES_LOGCAT");
console.log("AIB_LINUX_NATIVE_LOGCAT_SELFTEST_OK structured_only=1 raw_command_output_exception=0");
