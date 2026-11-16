#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync("lib/build-loop.ts", "utf8");
assert.match(source, /if \[ \$ZA -ne 0 \]; then echo "ZIPALIGN_FAIL" >&2; exit 32; fi/);
assert.match(source, /\[ -s "\$ALIGNED" \] \|\| \{ echo "ZIPALIGN_OUTPUT_INVALID" >&2; exit 33; \}/);
assert.doesNotMatch(source, /SIGN_SOURCE=\$\{raw\}/, "alignment failure must not fall back to signing raw APK");
assert.match(source, /signed\.success && signed\.signedPath && isLexicallyWithin\(root, signed\.signedPath\)[\s\S]*?artifactPath: signed\.signedPath/);
assert.doesNotMatch(source, /projectSignedPath/, "verification path is not reconstructed from the raw APK name");
console.log("AIB_BUILD_SIGNING_ADAPTER_SELFTEST_OK alignment=fail_closed verified_path=actual_signed_artifact");
