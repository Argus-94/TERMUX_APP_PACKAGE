#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const hook = fs.readFileSync(path.join(root, "hooks/useAppSettings.ts"), "utf8");
const screen = fs.readFileSync(path.join(root, "app/settings.tsx"), "utf8");
assert.match(hook, /const \[onlineApiKeyLoaded, setOnlineApiKeyLoaded\] = useState\(false\)/);
assert.match(hook, /let onlineConfigured = await migrateProviderCredential\("openrouter", \[API_KEY_SECURE_STORAGE_KEY\], \[\]\);/);
assert.match(hook, /if \(cancelled\) return;\s*setOnlineHasApiKey\(onlineConfigured\);\s*setOnlineApiKeyLoaded\(true\);/);
assert.doesNotMatch(hook, /setOnlineApiKeyState\(/, "hydration publishes only configured state, not a plaintext secret");
assert.match(hook, /onlineApiKeyLoaded,/);
assert.doesNotMatch(screen, /onlineModel\.apiKey|setApiKeyDraft\(onlineModel\./, "UI draft is write-only and never hydrates a secret from ordinary settings state");
assert.match(screen, /setApiKeyDraftDirty\(true\)/);
assert.match(screen, /if \(!onlineApiKeyLoaded \|\| savingApiKey \|\| checkingApiKey\) return;/);
assert.match(screen, /disabled=\{!onlineApiKeyLoaded \|\| !apiKeyDraft\.trim\(\) \|\| savingApiKey \|\| checkingApiKey\}/);
console.log("AIB_API_KEY_HYDRATION_OK draft_sync=untouched save=waits_for_secure_store");
