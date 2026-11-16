#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

echo "=== AI Builder: автоматическая установка и сборка Android ==="
echo "Проект: $ROOT"

if ! command -v node >/dev/null 2>&1; then
  echo "[ERROR] Node.js не найден. Откройте Toolchain в AI Builder и установите Node.js, затем запустите этот скрипт снова." >&2
  exit 1
fi

if ! command -v pnpm >/dev/null 2>&1; then
  if command -v corepack >/dev/null 2>&1; then
    corepack enable 2>/dev/null || true
    corepack prepare pnpm@9.15.0 --activate 2>/dev/null || true
  fi
fi

if command -v pnpm >/dev/null 2>&1; then
  PM=pnpm
else
  echo "[ERROR] pnpm не найден. Откройте Toolchain в AI Builder и установите pnpm." >&2
  exit 1
fi

echo "[1/3] Устанавливаю зависимости…"
$PM install --frozen-lockfile
echo "[2/3] Генерирую native Android проект…"
$PM prebuild
echo "[3/3] Собираю и устанавливаю приложение…"
$PM android

echo "=== AI Builder готов ==="
