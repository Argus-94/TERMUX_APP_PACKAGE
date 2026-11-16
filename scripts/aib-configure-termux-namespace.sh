#!/usr/bin/env bash
# Set both current and deprecated package-name variables in termux-packages.
set -Eeuo pipefail
APP_ID='com.karat.aibuilder'
PROPERTIES="${1:-}"
if [[ -z "$PROPERTIES" || ! -f "$PROPERTIES" ]]; then
  echo "Usage: $0 /path/to/termux-packages/scripts/properties.sh" >&2
  exit 2
fi
count=$(grep -Ec '^[[:space:]]*TERMUX_APP__PACKAGE_NAME[[:space:]]*=' "$PROPERTIES" || true)
alias_count=$(grep -Ec '^[[:space:]]*TERMUX_APP_PACKAGE[[:space:]]*=' "$PROPERTIES" || true)
if [[ "$count" != 1 || "$alias_count" != 1 ]]; then
  echo "Expected exactly one current package variable and one deprecated alias; found current=$count alias=$alias_count" >&2
  exit 2
fi
sed -i -E 's|^[[:space:]]*TERMUX_APP__PACKAGE_NAME[[:space:]]*=.*$|TERMUX_APP__PACKAGE_NAME="com.karat.aibuilder"|' "$PROPERTIES"
sed -i -E 's|^[[:space:]]*TERMUX_APP_PACKAGE[[:space:]]*=.*$|TERMUX_APP_PACKAGE="$TERMUX_APP__PACKAGE_NAME" # Deprecated alias|' "$PROPERTIES"
grep -Fq 'TERMUX_APP__PACKAGE_NAME="com.karat.aibuilder"' "$PROPERTIES"
grep -Fq 'TERMUX_APP_PACKAGE="$TERMUX_APP__PACKAGE_NAME" # Deprecated alias' "$PROPERTIES"
printf 'Configured Termux package namespace: %s\n' "$APP_ID"
