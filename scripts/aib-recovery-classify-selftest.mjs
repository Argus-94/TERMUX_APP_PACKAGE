#!/usr/bin/env node
/** Mirrors classifyRecoveryFailure categories for OOM / Expo copy / empty zip. */
function classify(log) {
  const l = String(log || "").toLowerCase();
  if (/broken pipe|out of memory|outofmemory|java\.lang\.outofmemoryerror|\bood\b|\boom\b|cannot allocate memory|enomem|low memory|memory pressure|daemon disappeared|process .* killed|signal 9|sigkill|gc overhead limit/i.test(l))
    return "memory-pressure-or-process-killed";
  if (/skip_offline_no_platform|online_sdk_platform_missing|sdkmanager_missing|no android platform/i.test(l)) return "android-platform-missing";
  if (/expo_copy_to_home_failed|expo_copy_failed/i.test(l)) return "expo-source-copy-failed";
  if (/\bno_node\b|node=missing/i.test(l)) return "nodejs-missing";
  if (/unzip_failed|unzip_empty|no_zip|src_not_found|unsafe project zip/i.test(l)) return "source-archive-invalid";
  if (/disk_full|no space left|enospc/i.test(l)) return "disk-space-exhausted";
  return "unknown";
}
const cases = [
  ["java.lang.OutOfMemoryError: Java heap space", "memory-pressure-or-process-killed"],
  ["Process killed signal 9", "memory-pressure-or-process-killed"],
  ["SKIP_OFFLINE_NO_PLATFORM sdk=", "android-platform-missing"],
  ["EXPO_COPY_TO_HOME_FAILED", "expo-source-copy-failed"],
  ["NO_NODE", "nodejs-missing"],
  ["UNZIP_EMPTY src=/x.zip", "source-archive-invalid"],
  ["No space left on device", "disk-space-exhausted"],
];
let f = 0;
for (const [log, want] of cases) {
  const got = classify(log);
  if (got !== want) { console.error("MISMATCH", log, got, want); f++; }
}
if (f) process.exit(1);
console.log("AIB_RECOVERY_CLASSIFY_SELFTEST_OK cases=" + cases.length);
