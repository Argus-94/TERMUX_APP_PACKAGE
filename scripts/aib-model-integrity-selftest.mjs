import fs from 'node:fs';
import assert from 'node:assert/strict';
const src = fs.readFileSync('lib/local-model.ts','utf8');
assert.match(src,/llmSha256:\s*"[a-f0-9]{64}"/i);
// Vision/mmproj is intentionally disabled for Qwen2.5-3B (RAM/speed on mid-range devices).
assert.match(src,/mmprojSha256:\s*""/);
assert.match(src,/Qwen2\.5-3B-Instruct-Q4_K_M\.gguf/);
assert.match(src,/bartowski\/Qwen2\.5-3B-Instruct-GGUF/);
assert.match(src,/native\.sha256File/);
assert.match(src,/MODEL_SHA256_UNAVAILABLE/);
assert.match(src,/LLM_SHA256_MISMATCH/);
assert.match(src,/MMPROJ_SHA256_MISMATCH/);
console.log('AIB_MODEL_INTEGRITY_SELFTEST_OK pinned=1 sha256=1 mmproj=disabled');
