#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

fail() { printf 'ERROR:%s\n' "$*" >&2; exit 2; }
[[ $# -eq 1 ]] || fail 'USAGE:create-ephemeral-feed-signing-key.sh <config-root>'
CONFIG_ROOT="$(mkdir -p -- "$1" && realpath -e -- "$1")"
KEYS_DIR="${CONFIG_ROOT}/keys"
GNUPGHOME="${CONFIG_ROOT}/gnupg"
mkdir -p -- "$KEYS_DIR" "$GNUPGHOME"
chmod 700 "$GNUPGHOME"
export GNUPGHOME

PARAMS="${CONFIG_ROOT}/ephemeral-key.params"
cat > "$PARAMS" <<'EOF'
Key-Type: RSA
Key-Length: 2048
Key-Usage: sign
Name-Real: AI Builder Ephemeral Feed CI Test
Name-Email: ephemeral-feed-ci@example.invalid
Expire-Date: 1d
%no-protection
%commit
EOF
chmod 600 "$PARAMS"
gpg --batch --generate-key "$PARAMS" >/dev/null 2>"${CONFIG_ROOT}/gpg-generate.log" || fail 'EPHEMERAL_KEY_GENERATION_FAILED'
rm -f -- "$PARAMS"
FINGERPRINT="$(gpg --batch --with-colons --list-secret-keys 2>/dev/null | awk -F: '$1 == "fpr" {print $10; exit}')"
[[ "$FINGERPRINT" =~ ^[A-F0-9]{40}$ ]] || fail 'EPHEMERAL_KEY_FINGERPRINT_INVALID'
KEYRING="${KEYS_DIR}/aibuilder-termux-feed-keyring.gpg"
gpg --batch --export "$FINGERPRINT" > "$KEYRING"
chmod 644 "$KEYRING"
KEYRING_SHA256="$(sha256sum "$KEYRING" | awk '{print $1}')"
python3 - "$KEYS_DIR/feed-signing.json" "$FINGERPRINT" "$KEYRING_SHA256" <<'PY'
import json, pathlib, sys
path=pathlib.Path(sys.argv[1])
manifest={
    "schemaVersion": 1,
    "fingerprint": sys.argv[2],
    "publicKeyring": "keys/aibuilder-termux-feed-keyring.gpg",
    "publicKeyringSha256": sys.argv[3],
    "algorithm": "RSA2048 ephemeral CI test key",
    "status": "ephemeral-only; no production feed publication",
}
path.write_text(json.dumps(manifest, indent=2)+"\n", encoding="utf-8")
PY
chmod 644 "$KEYS_DIR/feed-signing.json"
chmod 755 "$CONFIG_ROOT" "$KEYS_DIR"
printf 'EPHEMERAL_FEED_SIGNING_KEY_READY fingerprint=%s\n' "$FINGERPRINT"
