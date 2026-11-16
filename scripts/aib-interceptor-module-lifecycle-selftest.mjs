#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync("native/aib-interceptor/AibInterceptorProxyModule.kt", "utf8");
const invalidation = source.match(/override fun invalidate\(\)\s*\{[\s\S]*?\n  \}/)?.[0] ?? "";
assert.match(invalidation, /stopResources\(\)\s*io\.shutdownNow\(\)\s*super\.invalidate\(\)/);
assert.match(source, /private fun stopResources\(\)\s*\{\s*releasePending\(\)\s*synchronized\(lock\)\s*\{\s*server\?\.stop\(\); server = null\s*\}\s*\}/);
assert.doesNotMatch(invalidation, /certificateStore\.(?:remove|delete|clear)/, "module teardown must not delete persisted user certificate material");
console.log("AIB_INTERCEPTOR_MODULE_LIFECYCLE_SELFTEST_OK invalidation=server+pending+executor certificate=preserved");
