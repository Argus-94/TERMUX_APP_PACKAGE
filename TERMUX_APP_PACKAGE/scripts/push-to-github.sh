#!/usr/bin/env bash
# Init git and push this tree to Argus-94/TERMUX_APP_PACKAGE
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
REMOTE="${1:-https://github.com/Argus-94/TERMUX_APP_PACKAGE.git}"

if [ ! -d .git ]; then
  git init
  git branch -M main
fi

git remote remove origin 2>/dev/null || true
git remote add origin "$REMOTE"

git add -A
git status
git commit -m "Add apt repository layout for com.karat.aibuilder" || {
  echo "Nothing to commit (already committed?)"
}

echo ""
echo "Push:"
echo "  git push -u origin main"
echo ""
echo "If remote already has commits and you intentionally replace them:"
echo "  git push -u origin main --force"
echo ""
echo "Then: GitHub → Settings → Pages → Source: GitHub Actions"
echo "Feed URL after deploy:"
echo "  https://argus-94.github.io/TERMUX_APP_PACKAGE/apt/termux-main"
